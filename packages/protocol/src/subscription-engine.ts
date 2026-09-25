// ②WS/UI 订阅引擎（契约 v1.2 §3.6/§3.7；纯逻辑状态机）。
// 状态机：init → paging → live → closed（任一态可 → closed）。
// 快照上下文：屏障 H + 期待下页游标 + 最近 2 页幂等缓存 + 末页 60s 宽限。
import type {
  EventCursor, HistoryEvent, LiveEvent, SanitizedText, ServerFrame, SessionStatus, StreamId, SubscriptionId,
} from "./contracts.ts";
import { LIMITS } from "./contracts.ts";
import type { ReadIndex } from "./read-index.ts";

export type SubscribeRequest =
  | { readonly kind: "init"; readonly requestId: string }
  | { readonly kind: "resync"; readonly requestId: string; readonly cursor: EventCursor }
  | { readonly kind: "page"; readonly requestId: string; readonly snapshotId: string; readonly historyNext: EventCursor };

type Phase = "init" | "paging" | "live" | "closed";

interface PageCache {
  readonly historyNext: EventCursor;   // 本页页首游标（请求参数）
  readonly frame: ServerFrame;         // 已序列化页帧（幂等重发对象）
}

export interface SubscriptionEngineDeps {
  readonly index: ReadIndex;
  readonly status: () => SessionStatus;
  readonly now: () => number;
  readonly newId: () => string;        // subscriptionId/snapshotId 生成器
}

const PAGE_MAX = LIMITS.pageMaxEvents;

/**
 * 单订阅实例（绑定一个 subscriptionId；init/resync 各建一个实例，旧实例作废）。
 * 出帧走 drain()（调用方串行 send）；本类不触网络。
 */
export class SubscriptionEngine {
  readonly subscriptionId: SubscriptionId;
  readonly streamId: StreamId;
  readonly file: string;
  private phase: Phase = "init";
  private snapshotId: string | null = null;
  private barrier = 0;
  private expectNext: EventCursor | null = null;        // 期待下页游标（paging 期）
  private recentPages: PageCache[] = [];                 // 最近 2 页（幂等）
  private lastPageAt = 0;                                // 末页发出时刻（60s 宽限）
  private liveSeq = 0;
  private readonly outbox: Array<{ kind: "frame"; frame: ServerFrame } | { kind: "live"; ev: LiveEvent }> = [];
  private readonly buffered: HistoryEvent[] = [];        // 快照期 H 后事件（回放后清）
  private readonly d: SubscriptionEngineDeps;

  constructor(d: SubscriptionEngineDeps) {
    this.d = d;
    this.subscriptionId = d.newId();
    this.streamId = d.index.streamId;
    this.file = d.index.file;
  }

  get state(): { phase: Phase; barrier: number; liveSeq: number; buffered: number } {
    return { phase: this.phase, barrier: this.barrier, liveSeq: this.liveSeq, buffered: this.buffered.length + this.outbox.length };
  }

  // ---- 客户端请求 ----
  /** 处理 subscribe 三分支（本引擎已存在=续页；init/resync 由宿主建新引擎后转发）。返回应答帧数组。 */
  handle(req: SubscribeRequest): ServerFrame[] {
    if (this.phase === "closed") return [err4404(req.requestId)];
    if (req.kind === "page") {
      if (this.snapshotId === null || req.snapshotId !== this.snapshotId) return [err4404(req.requestId)];
      // 末页 60s 宽限：过期→资源已释放→4409（客户端按末页 cursor 直接续读）
      if (this.expectNext === null && this.d.now() - this.lastPageAt > LIMITS.snapshotTailGraceMs) {
        return [{ t: "error", code: 4409, message: "快照已释放，请按游标续读", retryable: true, requestId: req.requestId }];
      }
      const cur = req.historyNext;
      // 幂等：命中最近 2 页缓存→重发
      const cached = this.recentPages.find((p) => p.historyNext.seq === cur.seq);
      if (cached) return [cached.frame];
      // 必须等于期待下页
      if (this.expectNext === null || cur.seq !== this.expectNext.seq || cur.streamId !== this.expectNext.streamId) {
        return [err4404(req.requestId)];
      }
      return this.servePage(req.requestId);
    }
    return [err4404(req.requestId)]; // init/resync 不该到旧引擎
  }

  /** 初始化快照（建引擎后宿主调）。返回首页帧。 */
  startSnapshot(requestId: string): ServerFrame[] {
    if (this.phase !== "init") return [err4404(requestId)];
    this.barrier = this.d.index.waterMark;               // 截 H（冻结于发起时刻）
    this.snapshotId = this.d.newId();
    // H 后事件缓冲（init 时不可能有；resync 后由宿主路由）
    return this.servePage(requestId);
  }

  /** 游标重同步（宿主校验域后建新引擎调此入口）。 */
  startResync(requestId: string, cursor: EventCursor): ServerFrame[] {
    if (this.phase !== "init") return [err4404(requestId)];
    this.barrier = this.d.index.waterMark;
    this.snapshotId = this.d.newId();
    if (cursor.seq <= this.barrier) {
      this.expectNext = { streamId: this.streamId, seq: cursor.seq };
      return this.servePage(requestId);
    }
    return [{ t: "error", code: 4409, message: "游标超前", retryable: true, requestId }];
  }

  private servePage(requestId: string): ServerFrame[] {
    const from = this.expectNext?.seq ?? 1;
    const to = Math.min(this.barrier, from + PAGE_MAX - 1);
    const events = this.d.index.read(from, PAGE_MAX, to).map((e) => e.event);
    const last = to;
    const done = last >= this.barrier;
    const historyNext: EventCursor | null = done ? null : { streamId: this.streamId, seq: last + 1 };
    const liveFrom: EventCursor | null = done ? { streamId: this.streamId, seq: this.barrier + 1 } : null;
    const frame: ServerFrame = {
      t: "snapshot", requestId, subscriptionId: this.subscriptionId, streamId: this.streamId, snapshotId: this.snapshotId!,
      barrier: this.barrier, status: this.d.status(), page: events,
      historyNext, liveFrom, hasMore: !done,
    };
    this.expectNext = historyNext;
    this.recentPages.push({ historyNext: { streamId: this.streamId, seq: from }, frame });
    if (this.recentPages.length > 2) this.recentPages.shift();
    this.lastPageAt = this.d.now();
    if (done) {
      this.phase = "live";
      // H 后缓冲回放：先于实时（编入序）
      for (const ev of this.buffered) this.outbox.push({ kind: "frame", frame: this.historyFrame(ev) });
      this.buffered.length = 0;
    } else {
      this.phase = "paging";
    }
    return [frame];
  }

  // ---- 服务端事件入口 ----
  /** 读索引新编入事件（seq>水位时刻由宿主保证>barrier 时才调本入口；快照期入缓冲）。 */
  onHistoryAppend(ev: HistoryEvent): void {
    if (this.phase === "closed") return;
    if (this.phase === "paging") {
      if (ev.seq <= this.barrier) return; // 编排保证不可能；防御
      this.buffered.push(ev);
      if (this.buffered.length > LIMITS.connQueueFrames) {
        this.outbox.push({ kind: "frame", frame: { t: "error", code: 4431, message: "快照期缓冲超限", retryable: true, subscriptionId: this.subscriptionId } });
        this.phase = "closed";
      }
      return;
    }
    if (this.phase === "live") this.outbox.push({ kind: "frame", frame: this.historyFrame(ev) });
  }

  onLiveEvent(ev: LiveEvent): void {
    if (this.phase !== "live") return;
    this.outbox.push({ kind: "live", ev });
  }

  /** 状态更新（status 帧与事件同序走 outbox）。 */
  onStatus(status: SessionStatus): void {
    if (this.phase === "closed" || this.phase === "init") return;
    this.outbox.push({ kind: "frame", frame: { t: "status", subscriptionId: this.subscriptionId, status } });
  }

  private historyFrame(ev: HistoryEvent): ServerFrame {
    return { t: "events", subscriptionId: this.subscriptionId, origin: "history", refSeq: ev.seq, events: [ev] };
  }

  /** 出帧（drain；每轮 ≤maxFrames 帧；连续 live 项合批为一帧，同帧事件数亦 ≤maxFrames，保编入序）。 */
  drain(maxFrames = 16): ServerFrame[] {
    const out: ServerFrame[] = [];
    let liveBatch: LiveEvent[] = [];
    const flushLive = () => {
      if (liveBatch.length > 0) {
        this.liveSeq += liveBatch.length;
        out.push({ t: "events", subscriptionId: this.subscriptionId, origin: "live", liveSeq: this.liveSeq, refSeq: null, events: liveBatch });
        liveBatch = [];
      }
    };
    while (this.outbox.length > 0 && out.length < maxFrames) {
      const item = this.outbox[0];
      if (item === undefined) break;
      if (item.kind === "frame") {
        if (liveBatch.length > 0 && out.length + 1 >= maxFrames) break;
        flushLive();
        out.push(item.frame);
      } else {
        liveBatch.push(item.ev);
        if (liveBatch.length >= maxFrames) flushLive();
      }
      this.outbox.shift();
    }
    flushLive();
    return out;
  }

  close(): void { this.phase = "closed"; this.outbox.length = 0; this.buffered.length = 0; }
}

function err4404(requestId: string): ServerFrame {
  return { t: "error", code: 4404, message: "快照参数失效", retryable: false, requestId };
}

// 便利：构造预览（宿主投影用；测试亦用）
export function preview(text: string, truncated: boolean): SanitizedText { return { text, truncated }; }
