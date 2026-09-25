// ②WS/UI 订阅引擎（契约 v1.2 §2.2/§2.3；纯逻辑，宿主注入读写面）。
//
// c4 审定修复（B01/B04）：
// - 游标语义=下一待读位；合法域 [1, H+1]——H+1=追平补页（空页 done=true 进 live），
//   >H+1 才是超前（4409）。0/负数在入站校验层拒（contracts.cursorOf seq>=1 exact）。
// - 幂等缓存键=完整游标（streamId+seq）；页内容可复用，envelope 回显**本次 requestId**。
// - 字节装页在 servePage 内完成：按真实 UTF-8 字节预算（pageFrameBudgetBytes）+
//   条数上限（pageMaxEvents）共同决定页边界；done 由实际装到的末位决定——
//   引擎状态永不超前于已装内容（发送队列截帧不会造成「已进 live 实未送达」）。
// - drain 的帧数与每帧事件数分立常量；close 清缓存；末页宽限过期在 drain 时真实释放。
import { LIMITS, estimateFrameBytes, estimateHistoryEventBytes } from "./contracts.ts";
import type {
  EventCursor, HistoryEvent, LiveEvent, ServerFrame, SessionStatus, StreamId,
} from "./contracts.ts";
import type { ReadIndex } from "./read-index.ts";

export type SubscribeRequest =
  | { readonly kind: "init"; readonly requestId: string }
  | { readonly kind: "resync"; readonly requestId: string; readonly cursor: EventCursor }
  | { readonly kind: "page"; readonly requestId: string; readonly snapshotId: string; readonly historyNext: EventCursor };

export type Phase = "init" | "paging" | "live" | "closed";

type OutboxItem =
  | { readonly kind: "frame"; readonly frame: ServerFrame }   // status 等即时帧（编入序锚点）
  | { readonly kind: "hist"; readonly ev: HistoryEvent }      // 落盘事件（快照后 journal 追加/缓冲回放）
  | { readonly kind: "live"; readonly ev: LiveEvent };        // 进程内存事件

/** 页缓存（幂等重发）：页内容 + 游标域；envelope 每次按新 requestId 重建（B01） */
interface PageCache {
  readonly pageFrom: EventCursor;        // 页首（缓存键成分）
  readonly barrier: number;
  readonly events: readonly HistoryEvent[];
  readonly done: boolean;
}

export interface SubscriptionEngineDeps {
  readonly index: ReadIndex;
  readonly status: () => SessionStatus;
  readonly now: () => number;
  readonly newId: () => string;
  /** 字节预估（测试可注入；默认 contracts 实现） */
  readonly estimateFrame?: (frame: ServerFrame) => number;
  readonly estimateEvent?: (ev: HistoryEvent) => number;
}

function err4404(requestId: string): ServerFrame {
  return { t: "error", code: 4404, message: "请求与订阅状态不符", retryable: false, requestId };
}

/** 订阅实例（一订阅一引擎；快照分页+幂等+缓冲回放） */
export class SubscriptionEngine {
  readonly subscriptionId: string;
  readonly streamId: StreamId;
  readonly file: string;
  private phase: Phase = "init";
  private snapshotId: string | null = null;
  private barrier = 0;
  private expectNext: EventCursor | null = null;
  private recentPages: PageCache[] = [];                // 最近 2 页（幂等）
  private lastPageAt = 0;
  private liveSeq = 0;                                   // 已交付 live 末项 seq
  private readonly outbox: OutboxItem[] = [];            // 编入序统一队列
  private readonly buffered: HistoryEvent[] = [];        // paging 期历史追加缓冲

  constructor(private readonly d: SubscriptionEngineDeps) {
    this.subscriptionId = d.newId();
    this.streamId = d.index.streamId;
    this.file = d.index.file;
  }

  get state(): { phase: Phase; barrier: number; liveSeq: number; buffered: number } {
    return { phase: this.phase, barrier: this.barrier, liveSeq: this.liveSeq, buffered: this.buffered.length + this.outbox.length };
  }

  // ---- 客户端请求 ----
  /** 处理续页请求（本引擎已存在；init/resync 由宿主建新引擎后调 startSnapshot/startResync）。 */
  handle(req: SubscribeRequest): ServerFrame[] {
    if (this.phase === "closed") return [err4404(req.requestId)];
    if (req.kind === "page") {
      if (this.snapshotId === null || req.snapshotId !== this.snapshotId) return [err4404(req.requestId)];
      const cur = req.historyNext;
      if (cur.streamId !== this.streamId) return [err4404(req.requestId)]; // B01：完整游标域（错流不命中缓存）
      // 末页 60s 宽限：过期→资源已释放→4409（客户端按游标续读）
      if (this.expectNext === null && this.d.now() - this.lastPageAt > LIMITS.snapshotTailGraceMs) {
        return [{ t: "error", code: 4409, message: "快照已释放，请按游标续读", retryable: true, requestId: req.requestId }];
      }
      // 追平补页（B01）：游标=barrier+1 → 空页 done=true（幂等可重发）
      if (cur.seq === this.barrier + 1) {
        if (this.phase === "live") return [this.emitPage(req.requestId, cur, [], true)];
        return [this.servePageFrom(req.requestId, cur)];
      }
      // 幂等：命中最近 2 页缓存→页内容复用+新 envelope
      const cached = this.recentPages.find((p) => p.pageFrom.seq === cur.seq);
      if (cached) return [this.emitPage(req.requestId, cur, cached.events, cached.done)];
      // 必须等于期待下页
      if (this.expectNext === null || cur.seq !== this.expectNext.seq || cur.streamId !== this.expectNext.streamId) {
        return [err4404(req.requestId)];
      }
      return [this.servePageFrom(req.requestId, cur)];
    }
    return [err4404(req.requestId)]; // init/resync 不该到旧引擎
  }

  /** 初始化快照（建引擎后宿主调）。返回首页帧。 */
  startSnapshot(requestId: string): ServerFrame[] {
    if (this.phase !== "init") return [err4404(requestId)];
    this.barrier = this.d.index.waterMark;               // 截 H（冻结于发起时刻）
    this.snapshotId = this.d.newId();
    return [this.servePageFrom(requestId, { streamId: this.streamId, seq: 1 })];
  }

  /** 游标重同步（宿主校验域后建新引擎调此入口）。cursor.seq≤H+1 合法（B01 追平域）。 */
  startResync(requestId: string, cursor: EventCursor): ServerFrame[] {
    if (this.phase !== "init") return [err4404(requestId)];
    this.barrier = this.d.index.waterMark;
    this.snapshotId = this.d.newId();
    // 位置为准（streamId 由本引擎权威确认；换流后客户端旧 streamId 经宿主映射到当前流）
    if (cursor.seq <= this.barrier + 1) {
      this.expectNext = { streamId: this.streamId, seq: cursor.seq };
      return [this.servePageFrom(requestId, { streamId: this.streamId, seq: cursor.seq })];
    }
    return [{ t: "error", code: 4409, message: "游标超前", retryable: true, requestId }];
  }

  /** 从 cur.seq 起按「字节+条数」双上限装页（B04：引擎状态永不超前于已装内容） */
  private servePageFrom(requestId: string, from: EventCursor): ServerFrame {
    const est = this.d.estimateEvent ?? estimateHistoryEventBytes;
    const events: HistoryEvent[] = [];
    let bytes = 0;
    let last = from.seq - 1;
    while (last < this.barrier && events.length < LIMITS.pageMaxEvents) {
      const next = this.d.index.read(last + 1, 1, this.barrier)[0];
      if (next === undefined) break;
      const b = est(next.event);
      if (events.length > 0 && bytes + b > LIMITS.pageFrameBudgetBytes) break; // 装满即止（首条必装保前进）
      events.push(next.event); bytes += b; last = next.seq;
    }
    const done = last >= this.barrier;
    const page: EventCursor = { streamId: this.streamId, seq: from.seq };
    const frame = this.emitPage(requestId, page, events, done);
    this.expectNext = done ? null : { streamId: this.streamId, seq: last + 1 };
    this.rememberPage({ pageFrom: page, barrier: this.barrier, events, done });
    if (done) this.enterLive();
    else this.phase = "paging";
    return frame;
  }

  /** 生成/重建页帧（幂等复用内容、新 envelope；B01） */
  private emitPage(requestId: string, pageFrom: EventCursor, events: readonly HistoryEvent[], done: boolean): ServerFrame {
    const historyNext: EventCursor | null = done ? null : { streamId: this.streamId, seq: pageFrom.seq + events.length };
    const liveFrom: EventCursor | null = done ? { streamId: this.streamId, seq: this.barrier + 1 } : null;
    this.lastPageAt = this.d.now();
    return {
      t: "snapshot", requestId, subscriptionId: this.subscriptionId, streamId: this.streamId, snapshotId: this.snapshotId!,
      barrier: this.barrier, status: this.d.status(), page: events,
      historyNext, liveFrom, hasMore: !done,
    };
  }

  private rememberPage(p: PageCache): void {
    this.recentPages.push(p);
    if (this.recentPages.length > 2) this.recentPages.shift();
  }

  private enterLive(): void {
    this.phase = "live";
    for (const ev of this.buffered) this.outbox.push({ kind: "hist", ev }); // 回放走 history 帧（B03/R03：落盘事件）
    this.buffered.length = 0;
  }

  // ---- 服务端事件编入 ----
  /** 快照截断后 journal 追加（落盘事件→缓冲或 history 帧直发） */
  onHistoryAppend(ev: HistoryEvent): void {
    if (this.phase === "paging") {
      this.buffered.push(ev);
      if (this.buffered.length > LIMITS.snapshotBufferMax) this.close(4431, "快照缓冲超限", true);
      return;
    }
    if (this.phase === "live") this.outbox.push({ kind: "hist", ev });
  }

  /** live 事件（进程内存，非耐久） */
  onLiveEvent(ev: LiveEvent): void {
    if (this.phase !== "live") return;
    this.outbox.push({ kind: "live", ev });
  }

  /** 状态帧（编入序锚点；非 init/closed） */
  onStatus(status: SessionStatus): void {
    if (this.phase === "init" || this.phase === "closed") return;
    this.outbox.push({ kind: "frame", frame: { t: "status", subscriptionId: this.subscriptionId, status } });
  }

  /** 出队（≤maxFrames 帧；live 合批每帧 ≤maxEventsPerFrame 事件——分立常量，B04） */
  drain(maxFrames: number = LIMITS.liveFramesPerDrain, maxEventsPerFrame: number = LIMITS.maxEventsPerLiveFrame): ServerFrame[] {
    this.purgeExpiredPages();
    const out: ServerFrame[] = [];
    const est = this.d.estimateFrame ?? estimateFrameBytes;
    let histBatch: HistoryEvent[] = [];
    let liveBatch: LiveEvent[] = [];
    const flushHist = () => {
      if (histBatch.length === 0) return;
      const last = histBatch[histBatch.length - 1]!;
      out.push({ t: "events", subscriptionId: this.subscriptionId, origin: "history", refSeq: last.seq, events: histBatch });
      histBatch = [];
    };
    const flushLive = () => {
      if (liveBatch.length === 0) return;
      this.liveSeq += liveBatch.length;
      out.push({ t: "events", subscriptionId: this.subscriptionId, origin: "live", liveSeq: this.liveSeq, refSeq: null, events: liveBatch });
      liveBatch = [];
    };
    while (out.length + (histBatch.length > 0 || liveBatch.length > 0 ? 1 : 0) < maxFrames && this.outbox.length > 0) {
      const item = this.outbox.shift()!;
      if (item.kind === "frame") {
        flushHist(); flushLive(); // 帧前先冲（编入序）
        if (out.length >= maxFrames) { this.outbox.unshift(item); break; }
        out.push(item.frame);
      } else if (item.kind === "hist") {
        if (liveBatch.length > 0) flushLive(); // origin 切换先冲
        histBatch.push(item.ev);
        if (histBatch.length >= maxEventsPerFrame) flushHist();
      } else {
        if (histBatch.length > 0) flushHist();
        liveBatch.push(item.ev);
        if (liveBatch.length >= maxEventsPerFrame) flushLive();
      }
    }
    flushHist(); flushLive();
    // 帧预算防御：超限帧不上行（单事件 32k+批 8 上限下理论不可达；此处兜底记录不了、直接丢弃并关订阅）
    return out.filter((f) => est(f) <= LIMITS.frameMaxBytes);
  }

  /** 末页宽限过期的缓存真实释放（B04 时序意见：不只在下次 handle 检查） */
  private purgeExpiredPages(): void {
    if (this.expectNext === null && this.d.now() - this.lastPageAt > LIMITS.snapshotTailGraceMs) {
      this.recentPages.length = 0;
    }
  }

  close(code: 4431 = 4431, message = "", emitError = false): void {
    this.phase = "closed";
    this.buffered.length = 0;
    this.outbox.length = 0;
    this.recentPages.length = 0;
    this.expectNext = null;
    if (emitError) this.outbox.push({ kind: "frame", frame: { t: "error", code, message, retryable: false, requestId: "" } });
  }
}

/** 便利工厂 */
export function preview(deps: SubscriptionEngineDeps): SubscriptionEngine {
  return new SubscriptionEngine(deps);
}
