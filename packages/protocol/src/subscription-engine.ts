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
//
// c6 审定修复（C5-03/04/05）：
// - 整帧预算：装页起点=信封预留（ENVELOPE_OVERHEAD_BYTES），逐事件加分隔开销（+1）；
//   单条事件装不进（首条即超）→显式失败（4431 关订阅，不静默发大帧）。
// - 内部积压计量：paging 缓冲+live outbox 统一按条数与字节双门（subscriptionBacklogMax/
//   subscriptionBacklogBytes）超限即 4431 关订阅——慢客户端语义显式化，不静默积压；
//   paging 期 status 帧同样入缓冲（跨队列编入序：历史追加/状态/迟到按到达序回放）。
// - 状态门（B01 收紧）：追平补页（H+1 空页）仅限 live 幂等或 startResync 起点；
//   paging 期超前（含 H+1/H+2 与任何 ≠expectNext 且未命中缓存）→4409（可重试续读）。
// - 幂等域含 status：页缓存保存生成时的 SessionStatus 快照（statusVersion 随页冻结，
//   重试不重调 status()）；末页宽限=固定期限（自页生成时刻，重试不续命）。
import { LIMITS, estimateFrameBytes, estimateHistoryEventBytes } from "./contracts.ts";
import type {
  EventCursor, HistoryEvent, LiveEvent, ServerFrame, SessionStatus, StreamId,
} from "./contracts.ts";
import type { IndexedEvent, ReadIndex } from "./read-index.ts";

export type SubscribeRequest =
  | { readonly kind: "init"; readonly requestId: string }
  | { readonly kind: "resync"; readonly requestId: string; readonly cursor: EventCursor }
  | { readonly kind: "page"; readonly requestId: string; readonly snapshotId: string; readonly historyNext: EventCursor };

export type Phase = "init" | "paging" | "live" | "closed";

/** 最大合法 requestId 信封（c8 R1：装页按最坏重试信封预算——任何合法重试不得超页预算） */
const MAX_ENVELOPE_REQUEST_ID = "r".repeat(64); // requestIdPattern=/^[\w-]{1,64}$/

type OutboxItem =
  | { readonly kind: "frame"; readonly frame: ServerFrame; readonly est: number } // status 等即时帧（编入序锚点）
  | { readonly kind: "hist"; readonly ev: HistoryEvent; readonly est: number }    // 落盘事件（快照后 journal 追加/缓冲回放）
  | { readonly kind: "live"; readonly ev: LiveEvent; readonly est: number };      // 进程内存事件

/** 入队前形态（分布去 est；Omit 对联合不分发会丢判别字段） */
type WithoutEst<T> = T extends { est: number } ? Omit<T, "est"> : never;
type OutboxDraft = WithoutEst<OutboxItem>;
// est=入队时刻固化的字节估算（C6-04：积压计量=当前待发，出队即扣；搬移不重复计）

/** 页缓存（幂等重发）：页内容 + 游标域 + **status 快照**（C5-05：幂等域含 status，
 *  重试不重调 status()——statusVersion 随页冻结）；envelope 每次按新 requestId 重建（B01） */
interface PageCache {
  readonly pageFrom: EventCursor;        // 页首（缓存键成分）
  readonly barrier: number;
  readonly events: readonly HistoryEvent[];
  readonly done: boolean;
  readonly status: SessionStatus;
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
  private readonly outbox: OutboxItem[] = [];            // live 期编入序统一队列
  private readonly buffered: OutboxItem[] = [];          // paging 期编入序缓冲（历史追加+status 帧；C5-04）
  private backlogBytes = 0;                              // outbox+buffered 估算字节累计（C5-04 计量）

  constructor(private readonly d: SubscriptionEngineDeps) {
    this.subscriptionId = d.newId();
    this.streamId = d.index.streamId;
    this.file = d.index.file;
  }

  get state(): { phase: Phase; barrier: number; liveSeq: number; buffered: number } {
    return { phase: this.phase, barrier: this.barrier, liveSeq: this.liveSeq, buffered: this.buffered.length + this.outbox.length };
  }

  /** 3b3c：仅 outbox（可排水面）深度——宿主同步排水判据；paging 期 buffered（快照滞留积压）
   * 是慢客户端门的合法状态，不得触发同步排水（否则每事件一帧碎片化，见 RW1 实测 1025 帧超限）。 */
  get outboxDepth(): number {
    return this.outbox.length;
  }

  // ---- 客户端请求 ----
  /** 处理续页请求（本引擎已存在；init/resync 由宿主建新引擎后调 startSnapshot/startResync）。 */
  handle(req: SubscribeRequest): ServerFrame[] {
    if (this.phase === "closed") return [err4404(req.requestId)];
    if (req.kind === "page") {
      if (this.snapshotId === null || req.snapshotId !== this.snapshotId) return [err4404(req.requestId)];
      const cur = req.historyNext;
      if (cur.streamId !== this.streamId) return [err4404(req.requestId)]; // B01：完整游标域（错流不命中缓存）
      // 末页宽限=固定期限（自页生成时刻；重试不续命——C5-05）：过期→4409（按游标续读）
      if (this.expectNext === null && this.d.now() - this.lastPageAt > LIMITS.snapshotTailGraceMs) {
        return [{ t: "error", code: 4409, message: "快照已释放，请按游标续读", retryable: true, requestId: req.requestId }];
      }
      // 幂等优先（C6-05）：命中最近 2 页缓存→页内容+status 快照复用+新 envelope（不重调 status、不续命 TTL）
      const cached = this.recentPages.find((p) => p.pageFrom.seq === cur.seq);
      if (cached) {
        // R1：缓存重发同样整帧终判（防御层——装页已按最坏信封预留，此处不应触发；触发=显式失败）
        const f = this.emitPage(req.requestId, cur, cached.events, cached.done, cached.status);
        if ((this.d.estimateFrame ?? estimateFrameBytes)(f) > LIMITS.pageFrameBudgetBytes) {
          this.close(4431, "事件超预算", false);
          return [{ t: "error", code: 4431, message: "事件超预算", retryable: false, requestId: req.requestId }];
        }
        return [f];
      }
      // 追平补页（C5-05 收紧+C6-05 幂等）：仅 live 态（空页 done，生成入缓存——重试同 statusVersion）；paging 期 H+1 属超前（跳页）
      if (cur.seq === this.barrier + 1) {
        if (this.phase === "live") {
          const status = this.d.status(); // 首次生成冻结（C6-05）；重试走上方缓存分支
          const empty: PageCache = { pageFrom: { streamId: this.streamId, seq: cur.seq }, barrier: this.barrier, events: [], done: true, status };
          const f = this.emitPage(req.requestId, empty.pageFrom, empty.events, true, status);
          if ((this.d.estimateFrame ?? estimateFrameBytes)({ ...(f as { requestId: string }), requestId: MAX_ENVELOPE_REQUEST_ID } as ServerFrame) > LIMITS.pageFrameBudgetBytes) {
            this.close(4431, "事件超预算", false);
            return [{ t: "error", code: 4431, message: "事件超预算", retryable: false, requestId: req.requestId }];
          }
          this.rememberPage(empty);
          return [f];
        }
        return [{ t: "error", code: 4409, message: "游标超前于本快照进度（分页未完成）", retryable: true, requestId: req.requestId }];
      }
      // 状态门（C5-05 统一）：≠期待下页（未命中缓存）→4409 超前/乱序（可重试）
      if (this.expectNext === null || cur.seq !== this.expectNext.seq || cur.streamId !== this.expectNext.streamId) {
        return [{ t: "error", code: 4409, message: "游标与本快照进度不符", retryable: true, requestId: req.requestId }];
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
    // 位置为准（streamId 由本引擎权威确认；换流时由宿主退役旧引擎并按新流身份拒绝旧游标——不做跨流位置映射）
    if (cursor.seq <= this.barrier + 1) {
      this.expectNext = { streamId: this.streamId, seq: cursor.seq };
      return [this.servePageFrom(requestId, { streamId: this.streamId, seq: cursor.seq })];
    }
    return [{ t: "error", code: 4409, message: "游标超前", retryable: true, requestId }];
  }

  /** 从 cur.seq 起装页（C6-01：预算域=**最终帧序列化字节**——冻结 status 先取，贪心估算装页，
   *  整帧 estimateFrameBytes（=JSON.stringify UTF-8 实测）核验，超限收缩末条循环重测；
   *  引擎状态（expectNext/缓存/相态）在核验通过后才提交。条数上限照旧。 */
  private servePageFrom(requestId: string, from: EventCursor): ServerFrame {
    const est = this.d.estimateEvent ?? estimateHistoryEventBytes;
    const status = this.d.status(); // 冻结先取（C6-01：信封含真实 status，非事后取）
    const rows: IndexedEvent[] = [];
    let bytes = LIMITS.envelopeOverheadBytes; // 贪心粗估起点（仅用于快筛；终判=整帧实测）
    let last = from.seq - 1;
    while (last < this.barrier && rows.length < LIMITS.pageMaxEvents) {
      const next = this.d.index.read(last + 1, 1, this.barrier)[0];
      if (next === undefined) break;
      const b = est(next.event) + 1;
      if (rows.length > 0 && bytes + b > LIMITS.pageFrameBudgetBytes) break; // 粗估装满即止
      rows.push(next); bytes += b; last = next.seq;
    }
    const page: EventCursor = { streamId: this.streamId, seq: from.seq };
    const measure = this.d.estimateFrame ?? estimateFrameBytes;
    // 终判循环：整帧实测超页预算→退末条重测（首条不退=显式失败）
    let events = rows.map((r) => r.event);
    let done = last >= this.barrier;
    let frame: ServerFrame | null = null;
    while (true) {
      const f = this.emitPage(requestId, page, events, done, status);
      // R1：终判按最坏重试信封（64B requestId）测——缓存重发不因合法 requestId 变长击穿页预算
      const worst = { ...(f as { requestId: string }), requestId: MAX_ENVELOPE_REQUEST_ID } as ServerFrame; // 快照帧必有 requestId；上界克隆仅供测量
      if (measure(worst) <= LIMITS.pageFrameBudgetBytes) { frame = f; break; }
      if (events.length === 0) {
        // 首条即超整帧预算：无截断/占位规则→显式失败（4431 关订阅；retryable=false=订阅已亡，恢复=重新订阅）
        this.close(4431, "事件超预算", false);
        return { t: "error", code: 4431, message: "事件超预算", retryable: false, requestId };
      }
      const dropped = rows.pop()!;
      events = rows.map((r) => r.event);
      last = dropped.seq - 1;
      done = last >= this.barrier;
    }
    // 退空仍无成页数据可发（from≤barrier 说明确有待发事件）→首条即超：显式失败（C6-01）
    if (events.length === 0 && from.seq <= this.barrier) {
      this.close(4431, "事件超预算", false);
      return { t: "error", code: 4431, message: "事件超预算", retryable: false, requestId };
    }
    this.expectNext = done ? null : { streamId: this.streamId, seq: last + 1 };
    this.lastPageAt = this.d.now(); // 固定期限锚点=页生成时刻（C5-05：缓存重试不续命）
    this.rememberPage({ pageFrom: page, barrier: this.barrier, events, done, status });
    if (done) this.enterLive();
    else this.phase = "paging";
    return frame;
  }

  /** 生成/重建页帧（幂等复用内容+status 快照、新 envelope；B01+C5-05；不动时钟） */
  private emitPage(requestId: string, pageFrom: EventCursor, events: readonly HistoryEvent[], done: boolean, status: SessionStatus): ServerFrame {
    const historyNext: EventCursor | null = done ? null : { streamId: this.streamId, seq: pageFrom.seq + events.length };
    const liveFrom: EventCursor | null = done ? { streamId: this.streamId, seq: this.barrier + 1 } : null;
    return {
      t: "snapshot", requestId, subscriptionId: this.subscriptionId, streamId: this.streamId, snapshotId: this.snapshotId!,
      barrier: this.barrier, status, page: events,
      historyNext, liveFrom, hasMore: !done,
    };
  }

  private rememberPage(p: PageCache): void {
    this.recentPages.push(p);
    if (this.recentPages.length > 2) this.recentPages.shift();
  }

  private enterLive(): void {
    this.phase = "live";
    for (const item of this.buffered) this.outbox.push(item); // 按编入序整项回放（C5-04：含 status 帧——到达序）
    this.buffered.length = 0;
  }

  // ---- 服务端事件编入 ----
  /** 内部积压编入（C5-04：条数+字节双门；超限 4431 关订阅——慢客户端语义显式化） */
  private pushBacklog(queue: OutboxItem[], raw: OutboxDraft): void {
    const estEv = this.d.estimateEvent ?? estimateHistoryEventBytes;
    const estFr = this.d.estimateFrame ?? estimateFrameBytes;
    const b = raw.kind === "frame"
      ? estFr(raw.frame)
      : estEv(raw.ev as unknown as HistoryEvent) + 1;
    const item: OutboxItem = { ...raw, est: b } as OutboxItem; // 入队固化（C6-04：出队扣同一值）
    queue.push(item);
    this.backlogBytes += b;
    const count = this.buffered.length + this.outbox.length;
    if (count > LIMITS.subscriptionBacklogMax || this.backlogBytes > LIMITS.subscriptionBacklogBytes) {
      // 恰一份错误：close 清队列后压入唯一 4431 错误帧（drain 取出即客户端收到的唯一通知）
      this.close(4431, "订阅积压超限（慢客户端）", true);
    }
  }

  /** 快照截断后 journal 追加（落盘事件→缓冲或 history 帧直发；paging 期入缓冲保编入序） */
  onHistoryAppend(ev: HistoryEvent): void {
    if (this.phase === "paging") {
      this.pushBacklog(this.buffered, { kind: "hist", ev });
      return;
    }
    if (this.phase === "live") this.pushBacklog(this.outbox, { kind: "hist", ev });
  }

  /** live 事件（进程内存，非耐久） */
  onLiveEvent(ev: LiveEvent): void {
    if (this.phase !== "live") return;
    this.pushBacklog(this.outbox, { kind: "live", ev });
  }

  /** 状态帧（编入序锚点；paging 期同样入缓冲——跨队列到达序，C5-04） */
  onStatus(status: SessionStatus): void {
    if (this.phase === "init" || this.phase === "closed") return;
    this.pushBacklog(this.phase === "paging" ? this.buffered : this.outbox, { kind: "frame", frame: { t: "status", subscriptionId: this.subscriptionId, status } });
  }

  /** 出队（≤maxFrames 帧；live 合批每帧 ≤maxEventsPerFrame 事件——分立常量，B04）。
   *  C6-04：积压计量=**当前待发**（出队成功即扣 item.est；unshift 退回不扣；buffered→outbox 搬移不重复计）；
   *  合批帧构帧后先验字节再提交 liveSeq（未交付不推进序号）；错误出口恰一份（close 不再另排）。 */
  drain(maxFrames: number = LIMITS.liveFramesPerDrain, maxEventsPerFrame: number = LIMITS.maxEventsPerLiveFrame): ServerFrame[] {
    this.purgeExpiredPages();
    const out: ServerFrame[] = [];
    const est = this.d.estimateFrame ?? estimateFrameBytes;
    let histBatch: HistoryEvent[] = [];
    let liveEst = 0;   // 批内事件字节累计（出队扣减用）
    let liveBatch: LiveEvent[] = [];
    let failed = false;
    const overBudget = (): ServerFrame => {
      failed = true;
      this.close(4431, "帧超预算", false); // 单一错误出口（C6-04：close 不另排，本帧即返回的那份）
      return { t: "error", code: 4431, message: "帧超预算", retryable: false, requestId: "" };
    };
    const commit = (bytes: number): void => { this.backlogBytes = Math.max(0, this.backlogBytes - bytes); };
    const flushHist = (batchEst: number): void => {
      if (histBatch.length === 0) return;
      const last = histBatch[histBatch.length - 1]!;
      const f: ServerFrame = { t: "events", subscriptionId: this.subscriptionId, origin: "history", refSeq: last.seq, events: histBatch };
      if (est(f) > LIMITS.frameMaxBytes) { out.push(overBudget()); histBatch = []; return; }
      out.push(f); commit(batchEst);
      histBatch = [];
    };
    const flushLive = (): void => {
      if (liveBatch.length === 0) return;
      const f: ServerFrame = { t: "events", subscriptionId: this.subscriptionId, origin: "live", liveSeq: this.liveSeq + liveBatch.length, refSeq: null, events: liveBatch };
      if (est(f) > LIMITS.frameMaxBytes) { out.push(overBudget()); liveBatch = []; liveEst = 0; return; }
      this.liveSeq += liveBatch.length; // 先验后提交（C6-04：未交付不推进）
      out.push(f); commit(liveEst);
      liveBatch = []; liveEst = 0;
    };
    let histEst = 0;
    while (!failed && out.length + (histBatch.length > 0 || liveBatch.length > 0 ? 1 : 0) < maxFrames && this.outbox.length > 0) {
      const item = this.outbox.shift()!;
      if (item.kind === "frame") {
        flushHist(histEst); flushLive(); histEst = 0; // 帧前先冲（编入序）
        if (failed) break; // R2：冲批已失败→丢弃当前已取出项（close 已清队列；unshift 会让 closed 队列复活普通帧，下次 drain 误交付）
        if (out.length >= maxFrames) { this.outbox.unshift(item); break; }
        if (est(item.frame) > LIMITS.frameMaxBytes) { out.push(overBudget()); break; }
        out.push(item.frame); commit(item.est);
      } else if (item.kind === "hist") {
        if (liveBatch.length > 0) flushLive(); // origin 切换先冲
        histBatch.push(item.ev); histEst += item.est;
        if (histBatch.length >= maxEventsPerFrame) { flushHist(histEst); histEst = 0; }
      } else {
        if (histBatch.length > 0) { flushHist(histEst); histEst = 0; }
        liveBatch.push(item.ev); liveEst += item.est;
        if (liveBatch.length >= maxEventsPerFrame) flushLive();
      }
    }
    if (!failed) { flushHist(histEst); flushLive(); }
    if (failed) return out; // 唯一错误出口：已成功帧 + 单一 4431 错误帧（overBudget 内已 close，不再补发）
    return out;
  }

  /** 末页宽限过期的缓存真实释放（B04 时序意见：不只在下次 handle 检查） */
  /** B7（w1b）：公开清理口——宿主监督 tick 对安静连接主动释放过期页缓存（无事件时不等 drain）。 */
  purge(): void {
    this.purgeExpiredPages();
  }

  private purgeExpiredPages(): void {
    if (this.expectNext === null && this.d.now() - this.lastPageAt > LIMITS.snapshotTailGraceMs) {
      this.recentPages.length = 0;
    }
  }

  close(code: 4431 = 4431, message = "", emitError = false): void {
    this.phase = "closed";
    this.buffered.length = 0;
    this.outbox.length = 0;
    this.backlogBytes = 0;
    this.recentPages.length = 0;
    this.expectNext = null;
    if (emitError) {
      const frame: ServerFrame = { t: "error", code, message, retryable: false, requestId: "" };
      const est = (this.d.estimateFrame ?? estimateFrameBytes)(frame);
      this.outbox.push({ kind: "frame", frame, est });
      this.backlogBytes = est; // 清零后唯一待发帧（出队即扣回 0）
    }
  }
}

/** 便利工厂 */
export function preview(deps: SubscriptionEngineDeps): SubscriptionEngine {
  return new SubscriptionEngine(deps);
}
