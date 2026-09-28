// A1b 只读面订阅客户端（归属整改重写：本文件由 Kimi 亲手重写，语义对照契约 docs/ws-ui-contracts-v1.md
// 与 K3/K4 审报逐项保真——重写非返工，已修复的阻断语义一律不回退）。
// 职责：hello 握手→welcome 后自动发出排队中的初始化订阅→snapshot 分页（自动续页）→events 续流，
// 维护单文件会话详情只读快照（SessionDetailSnapshot，不可变整体替换，供 useSyncExternalStore 消费）。
//
// 保真清单（重写锚点）：
// ①出帧类型层封闭：只发 hello/subscribe/unsubscribe/ui-answer（OutgoingFrame 联合型；ui-answer=D3 问答帧，
//   非写帧），写类帧无从构造；
// ②消费帧先过运行时形状门（parse* 系列，文件内私有纯函数）：welcome/snapshot/events/status/
//   resync-required/error 逐字段校验，坏帧=零副作用（不污染快照、不消费在途、后续合法帧照常受理）；
// ③错误文案受控：快照内 errorMessage/streamNote 只承载 errorTextFor 的本文件文案——远端 error.message
//   可能回显敏感输入，永不进快照与 DOM；
// ④无自动重连/自动重订阅：续读终局（4409）只置 resync-needed 并保留快照+cursor，resyncFromCursor()
//   仅由用户显式发起（快照分页的自动续页属订阅协议本体 §3.7 时序 1，非重连）；
// ⑤同 file 至多一个活动订阅：subscribeSession 显式退旧（退订帧+本地退役，旧流帧此后一律按
//   subscriptionId 忽略）；
// ⑥cursor 严格透传服务端值（页 historyNext/末页 liveFrom 原样回传续用，客户端不重算序号）；
// ⑦close()=不可逆停止屏障：任何状态可关、迟到回调零副作用、幂等；closed=终态；
// ⑧首页在途取消留痕（K3-B2）：被作废的初始化/重同步建订请求记入 cancelledBuilds——其迟到首页只用于
//   识别服务端已建立的订阅并补发 unsubscribe（绝不写当前快照、绝不清当前 file 订阅）；本地终局的
//   活动订阅补发退订帧；
// ⑨续页实例绑定与跨字段一致性（K3-C2）：续页帧的 subscriptionId/snapshotId/streamId/barrier 必须与
//   当前快照实例一致；hasMore⟺historyNext、页游标 streamId 必须绑本帧流——矛盾帧整帧拒绝；
// ⑩C5 连接级错误码口径：ready 后 requestId 为 undefined 或空串""（服务端 errFrame 对「不关联任何
//   请求」的统一惯例）的 4403/4405/4432 进连接级失败映射；4413/4429 契约定为请求级，无关联不升级；
// ⑪K3-B1/K4 终局帧结构化身份路由（§3.6「错误帧路由语义」修订+K4 发现1 drain 出口）：终局帧按结构化
//   字段路由——subscriptionId 指认所停流（4409 stream-replaced/observe-missed/磁盘换流、4431 订阅积压
//   含 drain 出口、4402 流终局容量出口；requestId 恒空串）——绝不冒充在途请求失败（K3 P1：旧信封误携
//   新 requestId 曾致合法新 snapshot 被丢）、绝不解析 message 文本里的 id；仅带 requestId=请求级失败；
//   无流身份且 requestId 空缺/空串的 4409/4431/4402=旧信封终局，按当前活动流兼容处理（本面单 file
//   至多一个活动订阅，归属无歧义；无活动流则零副作用忽略）。

// ⑫D3-F 扩展问答透传（契约 v1.2，docs/d3-ui-passthrough-design.md §3/§4）：ui-request/ui-closed=瞬态
//   帧（连接级直达，不进 events 快照/live 流，断线不重放）——形状门后仅当前订阅 file 且订阅活跃相位
//   （subscribing/paging/live）受理，入快照 uiRequests（key=requestId，同 id 重复广播幂等）；ui-closed/
//   本地作答即移除（不等 ack）；4404 对 ui-answer 静默（晚答/已答/跨订阅拒收，不弹错误不重试）；
//   ui-note=LiveEvent v1.2 新形，走既有 events(origin=live) 形状门入旁路面；连接/订阅终局即清空
//   uiRequests（瞬态语义，重连/重订阅无重放属正常）。

// 同仓惯例：绕开 barrel 直引自包含 contracts 模块（浏览器安全、零 Node 依赖；LIMITS 为值导入，
// filePattern 冻结源避免本地复制漂移）。
import { LIMITS } from "@pi-agent-ui/protocol/src/contracts";
import type {
  ClientFrame,
  ErrorCode,
  EventCursor,
  HistoryEvent,
  LiveEvent,
  ServerFrame,
  SessionStatus,
  StopResult,
  StartResult,
  SubscriptionId,
  TurnState,
  UiClosedFrame,
  UiRequestFrame,
  UiRequestMethod,
} from "@pi-agent-ui/protocol/src/contracts";

/** 本客户端允许发送的帧（§5.1 订阅生命周期子集 + D3 ui-answer——问答帧驾驶宿主侧 pi stdin，非写帧、
 * 不触 journal/writerEpoch；写类 t 在类型层仍不可达）。 */
type OutgoingFrame = Extract<
  ClientFrame,
  { readonly t: "hello" } | { readonly t: "subscribe" } | { readonly t: "unsubscribe" } | { readonly t: "ui-answer" }
>;

/** 连接级五态：connecting→authenticating→ready；任一前置态可落 closed/error（无自动重连）。 */
export type DetailConnState = "connecting" | "authenticating" | "ready" | "closed" | "error";

/** 订阅相位：§3.6 订阅状态机 init→paging→live→closed 的客户端镜像+续读终局态。 */
export type SubscriptionPhase =
  | "idle" // 无订阅（未发起/已退订）
  | "subscribing" // 初始化或重同步 subscribe 已发，等首页
  | "paging" // 已收页且 hasMore，续页在途
  | "live" // 历史读完（末页已收，liveFrom 已记），持续投递中
  | "resync-needed" // 续读终局（4409）：快照+cursor 保留，等待用户显式续读
  | "closed"; // 订阅终局（4431/请求级失败/被替换/退订后旧流不可再展示）

/** 错误成因：auth-failed/handshake-failed/transport=连接级；subscribe-failed=订阅请求被拒；stream-terminal=流终局（4431 等）。 */
export type DetailErrorKind = "auth-failed" | "handshake-failed" | "transport" | "subscribe-failed" | "stream-terminal";

/** D3 活跃提问（ui-request 入快照的存储形；file 已按当前订阅过滤，不冗余存储）。 */
export interface UiRequest {
  readonly requestId: string;
  readonly method: UiRequestMethod;
  readonly title?: string;
  readonly options?: readonly string[]; // select
  readonly message?: string; // confirm 题面
  readonly placeholder?: string; // input
  readonly prefill?: string; // editor
  readonly timeoutMs?: number; // 仅 UI 提示；前端不据此自动作答/撤框（撤框只听 ui-closed）
}

/** D3 答案负载（三形态恰其一，判别联合在类型层封闭）：select/input/editor→value；confirm→confirmed；
 * 任意方法用户放弃→cancelled:true。 */
export type UiAnswer = { readonly value: string } | { readonly confirmed: boolean } | { readonly cancelled: true };

/**
 * 会话详情快照（不可变；每次变更整体替换——getSnapshot 缓存语义，未变即引用相等）。
 * errorMessage/streamNote 只承载本文件受控文案，不含任何远端自由文本。
 */
export interface SessionDetailSnapshot {
  readonly connState: DetailConnState;
  readonly errorKind: DetailErrorKind | null;
  readonly errorMessage: string | null;
  readonly streamNote: string | null;
  readonly file: string | null;
  readonly phase: SubscriptionPhase;
  readonly subscriptionId: SubscriptionId | null;
  /** 历史事件累积（页+续流；按 seq 幂等去重，重同步续读不重建）。 */
  readonly events: readonly HistoryEvent[];
  /** 直播事件（瞬时进度面；重同步/新订阅即重置——live 进度不承诺恢复，终局以 history 补齐 §3.7 时序 12）。 */
  readonly liveEvents: readonly LiveEvent[];
  readonly status: SessionStatus | null;
  /** 续读游标：最近一次服务端页游标（historyNext；末页后=liveFrom）——严格服务端值，不重算。 */
  readonly cursor: EventCursor | null;
  /** D3 活跃扩展提问（瞬态；ui-request push、ui-closed/本地作答即移除；连接/订阅终局清空不重放）。 */
  readonly uiRequests: readonly UiRequest[];
}

/** 可注入的 WebSocket 最小面（测试用假 socket 顶替；实现方只需提供五回调+send/close/readyState）。 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number): void;
  onopen: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: ((event: { readonly code: number }) => void) | null;
  onerror: (() => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

const WS_OPEN = 1;

const defaultFactory: WebSocketFactory = (url) => {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (!Ctor) throw new Error("当前环境无 WebSocket；请注入 createSocket");
  return new Ctor(url);
};

const INITIAL: SessionDetailSnapshot = {
  connState: "connecting",
  errorKind: null,
  errorMessage: null,
  streamNote: null,
  file: null,
  phase: "idle",
  subscriptionId: null,
  events: [],
  liveEvents: [],
  status: null,
  cursor: null,
  uiRequests: [],
};

// ---------------------------------------------------------------------------
// 消费帧运行时形状门（保真②；纯函数、文件内私有、零依赖）
// 只校验本面实际消费的帧（权威=contracts.ts 组2/组3/§3.6/组5）。校验失败→按未知帧处理（零副作用）。
// 宽松口径：字段存在性+类型+枚举域；不拒未知多余键（服务端契约要求 exact，客户端只读不放大信任）。
// ---------------------------------------------------------------------------

/** §5.3 错误码全集（运行时镜像；未登记码=未知帧保守拒绝）。 */
const KNOWN_ERROR_CODES: ReadonlySet<number> = new Set([4401, 4402, 4403, 4404, 4405, 4409, 4413, 4429, 4431, 4432]);

type WelcomeFrame = Extract<ServerFrame, { readonly t: "welcome" }>;
type ErrorFrame = Extract<ServerFrame, { readonly t: "error" }>;
type ResyncRequiredFrame = Extract<ServerFrame, { readonly t: "resync-required" }>;
type StatusFrame = Extract<ServerFrame, { readonly t: "status" }>;
type HistoryEventsFrame = Extract<ServerFrame, { readonly t: "events"; readonly origin: "history" }>;
type LiveEventsFrame = Extract<ServerFrame, { readonly t: "events"; readonly origin: "live" }>;
type SnapshotServerFrame = Extract<ServerFrame, { readonly t: "snapshot" }>;

function rec(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown): v is string {
  return typeof v === "string";
}
function bool(v: unknown): v is boolean {
  return typeof v === "boolean";
}
/** 计数/时间戳/序号域：有限非负数（显式设防 NaN/Infinity）。 */
function nonNegNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}
/** 传输 ID 域：非空 ≤128。口径记录：本层上限=128（与 LIMITS.idPattern 同源）；契约文档对传输
 * stream/subscription 域为 64——形状门只防类型错认，不复制白名单语义，精确域由服务端 4404 把关。 */
function transportId(v: unknown): v is string {
  return str(v) && v.length >= 1 && v.length <= 128;
}
function sanitizedText(v: unknown): boolean {
  return rec(v) && str(v.text) && bool(v.truncated);
}

/** EventCursor（§3.6）：双字段；seq=下一待读位，合法域 ≥1（0 非法）。 */
function readEventCursor(v: unknown): EventCursor | null {
  if (!rec(v)) return null;
  if (!transportId(v.streamId)) return null;
  const seq = v.seq;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) return null;
  return { streamId: v.streamId, seq };
}

function turnStateOk(v: unknown): v is TurnState {
  if (!rec(v)) return false;
  switch (v.state) {
    case "idle":
      return true;
    case "dispatching":
    case "in-flight":
    case "settling":
      return str(v.intentId);
    case "closed":
      return (
        v.reason === "durability-failure" || v.reason === "turn-timeout" || v.reason === "buffer-overflow" ||
        v.reason === "manual" || v.reason === "generation-retired"
      );
    default:
      return false;
  }
}

function startResultOk(v: unknown): v is StartResult {
  if (!rec(v)) return false;
  switch (v.kind) {
    case "ready":
    case "superseded":
    case "readiness-timeout":
    case "spawn-exited":
      return nonNegNum(v.generation);
    case "spawn-failed":
      return v.generation === null;
    default:
      return false;
  }
}

function stopResultOk(v: unknown): v is StopResult {
  return rec(v) && (v.kind === "confirmed" || v.kind === "deadline-exceeded") && nonNegNum(v.atMs);
}

/** RecoverySummary（组2）：全部可空计数域显式校验。 */
function recoverySummaryOk(v: unknown): v is SessionStatus["recovery"] {
  if (!rec(v)) return false;
  if (v.availability !== "available" && v.availability !== "unavailable") return false;
  const nullableBool = (x: unknown) => x === null || bool(x);
  const nullableCount = (x: unknown) => x === null || nonNegNum(x);
  return (
    nullableBool(v.resumeBlocked) && nullableBool(v.diskBlocked) &&
    nullableCount(v.unknownEffectCount) && nullableCount(v.unattributableFragments) &&
    nullableCount(v.intentsCount) && nullableCount(v.settledCount) &&
    (v.evidenceHash === null || str(v.evidenceHash))
  );
}

/** SessionStatus（组2）全域逐字段（快照帧携带+status 帧复用同校验）。 */
function sessionStatusOk(v: unknown): v is SessionStatus {
  if (!rec(v)) return false;
  const session = v.session;
  if (!rec(session)) return false;
  if (!(session.sessionId === null || str(session.sessionId))) return false;
  if (!str(session.file)) return false;
  if (!(session.adapterSessionId === null || str(session.adapterSessionId))) return false;
  const process = v.process;
  if (!rec(process)) return false;
  if (process.phase !== "idle" && process.phase !== "running" && process.phase !== "stopping") return false;
  if (!(process.generation === null || nonNegNum(process.generation))) return false;
  if (!(process.lastStartResult === null || startResultOk(process.lastStartResult))) return false;
  if (!(process.lastStopResult === null || stopResultOk(process.lastStopResult))) return false;
  if (!bool(process.ready)) return false;
  if (!turnStateOk(v.turn)) return false;
  const tasks = v.backgroundTasks;
  if (!rec(tasks)) return false;
  if (tasks.availability !== "known" && tasks.availability !== "unknown") return false;
  if (!(tasks.activeCount === null || nonNegNum(tasks.activeCount))) return false;
  const reap = v.reap;
  if (!rec(reap)) return false;
  if (!bool(reap.eligible)) return false;
  if (!(reap.idleElapsedMs === null || nonNegNum(reap.idleElapsedMs))) return false;
  if (!(reap.idleRemainingMs === null || nonNegNum(reap.idleRemainingMs))) return false;
  if (!nonNegNum(reap.idleMs)) return false;
  if (!recoverySummaryOk(v.recovery)) return false;
  if (!nonNegNum(v.statusVersion)) return false;
  if (!nonNegNum(v.serverTimeMs)) return false;
  return true;
}

const MESSAGE_ROLES = ["user", "assistant", "toolCall", "toolResult", "system"] as const;
const STOP_REASONS = ["stop", "length", "aborted", "toolUse"] as const;

/** HistoryEvent（组3）判别联合全域：基础域+kind 特有域逐项。 */
function historyEventOk(v: unknown): v is HistoryEvent {
  if (!rec(v)) return false;
  if (typeof v.seq !== "number" || !Number.isSafeInteger(v.seq) || v.seq < 1) return false;
  if (!(v.ts === null || nonNegNum(v.ts))) return false;
  if (!(v.generation === null || nonNegNum(v.generation))) return false;
  if (!(v.intentId === null || transportId(v.intentId))) return false;
  switch (v.kind) {
    case "turn-enqueued":
      return sanitizedText(v.preview) && nonNegNum(v.ordinal);
    case "sending":
    case "turn-engaged":
    case "turn-consumed":
    case "turn-cancelled":
    case "verdict-delivered":
    case "verdict-settled":
    case "verdict-unknown":
    case "unknown-line":
    case "journal-corrupt":
      return true;
    case "response-timeout":
      return nonNegNum(v.commandId);
    case "clear":
      return nonNegNum(v.clearedCount);
    case "corrupt-entry":
      return transportId(v.entryId);
    case "message": {
      if (!transportId(v.entryId)) return false;
      if ("blockIndex" in v && !nonNegNum(v.blockIndex)) return false;
      if (!MESSAGE_ROLES.includes(v.role as (typeof MESSAGE_ROLES)[number])) return false;
      if ("textPreview" in v && !sanitizedText(v.textPreview)) return false;
      if ("stopReason" in v && !STOP_REASONS.includes(v.stopReason as (typeof STOP_REASONS)[number])) return false;
      if ("toolCallId" in v && !transportId(v.toolCallId)) return false;
      return bool(v.final);
    }
    default:
      return false;
  }
}

const PI_TYPES = ["agent_start", "turn_start", "message_start", "message_update", "message_end", "turn_end", "agent_end", "agent_settled"] as const;
const PROGRESS_NOTES = ["thinking", "tool-start", "tool-end", "compacting", "message-start", "message-end"] as const;

/** LiveEvent（组3）判别联合全域；v1.2 增 ui-note（D3 即显族 notify 透传，append-only 重放无害）。 */
function liveEventOk(v: unknown): v is LiveEvent {
  if (!rec(v)) return false;
  switch (v.kind) {
    case "pi-progress":
      return PI_TYPES.includes(v.piType as (typeof PI_TYPES)[number]) && PROGRESS_NOTES.includes(v.note as (typeof PROGRESS_NOTES)[number]);
    case "turn-state":
      return nonNegNum(v.statusVersion) && turnStateOk(v.turn);
    case "process-note":
      return v.phase === "running" || v.phase === "stopping";
    case "ui-note":
      return (v.notifyType === "info" || v.notifyType === "warning" || v.notifyType === "error") && str(v.message);
    default:
      return false;
  }
}

/** welcome：serverBootId/serverBuildId 必须 string，protocolVersion 字面量 1。 */
function parseWelcome(v: Record<string, unknown>): WelcomeFrame | null {
  if (!str(v.serverBootId) || !str(v.serverBuildId) || v.protocolVersion !== 1) return null;
  return { t: "welcome", serverBootId: v.serverBootId, serverBuildId: v.serverBuildId, protocolVersion: 1 };
}

/** error：code∈锚定码表、message 必须 string（即使不展示也验形）、retryable 必须 boolean；
 * requestId/subscriptionId 在场即验形（requestId 空串合法=C5 空串口径；subscriptionId 走传输 ID 域）。 */
function parseError(v: Record<string, unknown>): ErrorFrame | null {
  if (!(typeof v.code === "number" && KNOWN_ERROR_CODES.has(v.code))) return null;
  if (!str(v.message) || !bool(v.retryable)) return null;
  if (v.requestId !== undefined && !str(v.requestId)) return null;
  if (v.subscriptionId !== undefined && !transportId(v.subscriptionId)) return null;
  return {
    t: "error",
    code: v.code as ErrorCode,
    message: v.message,
    retryable: v.retryable,
    ...(v.requestId === undefined ? {} : { requestId: v.requestId }),
    ...(v.subscriptionId === undefined ? {} : { subscriptionId: v.subscriptionId }),
  };
}

/**
 * snapshot（§3.6）：整帧逐字段+page 逐事件+status 全域+末页不变量
 * （historyNext=null ⟺ 末页且必有 liveFrom；两 null 同现或同现非 null 均拒收）
 * +跨字段一致性（hasMore⟺historyNext 非空；页游标 streamId 必须绑本帧流）。
 */
function parseSnapshot(v: Record<string, unknown>): SnapshotServerFrame | null {
  if (!str(v.requestId)) return null;
  if (!transportId(v.subscriptionId)) return null;
  if (!transportId(v.streamId)) return null;
  if (!str(v.snapshotId) || v.snapshotId.length === 0 || v.snapshotId.length > 64) return null;
  if (typeof v.barrier !== "number" || !Number.isSafeInteger(v.barrier) || v.barrier < 0) return null;
  if (!sessionStatusOk(v.status)) return null;
  if (!bool(v.hasMore)) return null;
  if (!Array.isArray(v.page)) return null;
  const page: HistoryEvent[] = [];
  for (const item of v.page) {
    if (!historyEventOk(item)) return null; // 任一事件畸形（含 null）整帧拒绝
    page.push(item);
  }
  const historyNext = v.historyNext === null ? null : readEventCursor(v.historyNext);
  if (v.historyNext !== null && historyNext === null) return null;
  const liveFrom = v.liveFrom === null ? null : readEventCursor(v.liveFrom);
  if (v.liveFrom !== null && liveFrom === null) return null;
  // 末页不变量：historyNext 与 liveFrom 互斥同现（§3.6；空流 H=0 也有 liveFrom={s,1}）
  if (historyNext === null && liveFrom === null) return null;
  if (historyNext !== null && liveFrom !== null) return null;
  // 跨字段一致性：hasMore⟺historyNext 非空；页游标必须属于本帧流（跨流游标拒绝）
  if (v.hasMore !== (historyNext !== null)) return null;
  if (historyNext !== null && historyNext.streamId !== v.streamId) return null;
  if (liveFrom !== null && liveFrom.streamId !== v.streamId) return null;
  return {
    t: "snapshot",
    requestId: v.requestId,
    subscriptionId: v.subscriptionId,
    streamId: v.streamId,
    snapshotId: v.snapshotId,
    barrier: v.barrier,
    status: v.status,
    page,
    historyNext,
    liveFrom,
    hasMore: v.hasMore,
  };
}

/** events history 变体：refSeq 必须 number ≥0；events 逐事件校验。 */
function parseHistoryEvents(v: Record<string, unknown>): HistoryEventsFrame | null {
  if (!transportId(v.subscriptionId)) return null;
  if (typeof v.refSeq !== "number" || !Number.isSafeInteger(v.refSeq) || v.refSeq < 0) return null;
  if (!Array.isArray(v.events)) return null;
  const events: HistoryEvent[] = [];
  for (const item of v.events) {
    if (!historyEventOk(item)) return null;
    events.push(item);
  }
  return { t: "events", subscriptionId: v.subscriptionId, origin: "history", refSeq: v.refSeq, events };
}

/** events live 变体：refSeq 显式 null（缺字段=拒收）；liveSeq=批末序号 ≥1。 */
function parseLiveEvents(v: Record<string, unknown>): LiveEventsFrame | null {
  if (!transportId(v.subscriptionId)) return null;
  if (!("refSeq" in v) || v.refSeq !== null) return null;
  if (typeof v.liveSeq !== "number" || !Number.isSafeInteger(v.liveSeq) || v.liveSeq < 1) return null;
  if (!Array.isArray(v.events)) return null;
  const events: LiveEvent[] = [];
  for (const item of v.events) {
    if (!liveEventOk(item)) return null;
    events.push(item);
  }
  return { t: "events", subscriptionId: v.subscriptionId, origin: "live", liveSeq: v.liveSeq, refSeq: null, events };
}

/** status：subscriptionId+SessionStatus 全域。 */
function parseStatus(v: Record<string, unknown>): StatusFrame | null {
  if (!transportId(v.subscriptionId)) return null;
  if (!sessionStatusOk(v.status)) return null;
  return { t: "status", subscriptionId: v.subscriptionId, status: v.status };
}

/** resync-required：reason 枚举闭合。 */
function parseResyncRequired(v: Record<string, unknown>): ResyncRequiredFrame | null {
  if (!transportId(v.subscriptionId)) return null;
  if (v.reason !== "server-side-gap" && v.reason !== "stream-replaced") return null;
  return { t: "resync-required", subscriptionId: v.subscriptionId, reason: v.reason };
}

/** ui-request（契约 v1.2 §3.1）：requestId/file/method 必备，method 枚举闭合；select 必携 options:string[]；
 * 可选域在场即验形（title/message/placeholder/prefill=string；timeoutMs=非负有限数）。畸形整帧拒收。 */
function parseUiRequest(v: Record<string, unknown>): UiRequestFrame | null {
  if (!transportId(v.requestId)) return null;
  if (!str(v.file)) return null;
  const method = v.method;
  if (method !== "select" && method !== "confirm" && method !== "input" && method !== "editor") return null;
  if (v.title !== undefined && !str(v.title)) return null;
  if (v.message !== undefined && !str(v.message)) return null;
  if (v.placeholder !== undefined && !str(v.placeholder)) return null;
  if (v.prefill !== undefined && !str(v.prefill)) return null;
  if (v.timeoutMs !== undefined && !nonNegNum(v.timeoutMs)) return null;
  let options: readonly string[] | undefined;
  if (v.options !== undefined) {
    if (!Array.isArray(v.options) || !v.options.every(str)) return null;
    options = v.options;
  }
  if (method === "select" && options === undefined) return null; // select 无选项不可答，按畸形拒收
  return {
    t: "ui-request",
    requestId: v.requestId,
    file: v.file,
    method,
    ...(v.title === undefined ? {} : { title: v.title as string }),
    ...(options === undefined ? {} : { options }),
    ...(v.message === undefined ? {} : { message: v.message as string }),
    ...(v.placeholder === undefined ? {} : { placeholder: v.placeholder as string }),
    ...(v.prefill === undefined ? {} : { prefill: v.prefill as string }),
    ...(v.timeoutMs === undefined ? {} : { timeoutMs: v.timeoutMs as number }),
  };
}

/** ui-closed（契约 v1.2 §3.1）：requestId 必备，reason 枚举闭合。 */
function parseUiClosed(v: Record<string, unknown>): UiClosedFrame | null {
  if (!transportId(v.requestId)) return null;
  if (v.reason !== "process-retired" && v.reason !== "no-subscriber" && v.reason !== "overflow" && v.reason !== "answered") return null;
  return { t: "ui-closed", requestId: v.requestId, reason: v.reason };
}

// ---------------------------------------------------------------------------
// 受控错误文案（保真③：code 域封闭=内嵌安全；远端 message 仅服务端审计用，前端不留存）
// ---------------------------------------------------------------------------

function errorTextFor(code: number): string {
  switch (code) {
    case 4401: return "认证失败：令牌无效或未认证（4401）";
    case 4402: return "会话不存在或不可读（4402）";
    case 4403: return "协议版本不匹配（4403）";
    case 4404: return "帧格式非法（4404）";
    case 4405: return "只读协议拒绝该操作（4405）";
    case 4409: return "请求游标或状态已过期（4409）";
    case 4413: return "会话身份损坏（4413）";
    case 4429: return "订阅数量超限（4429）";
    case 4431: return "服务端出帧预算超限（4431）";
    case 4432: return "心跳超时（4432）";
    default: return `服务端错误（${code}）`;
  }
}

/** 在途请求上下文：kind 决定 4409 的处置（page/resync=可续读终局；init=请求级失败）。 */
interface PendingRequest {
  readonly requestId: string;
  readonly kind: "init" | "resync" | "page";
}

/** 当前快照实例绑定（首页落地时建立；退订/终局/换订即清）：续页帧一致性校验基准（保真⑨）。 */
interface SnapshotBinding {
  readonly snapshotId: string;
  readonly streamId: string;
  readonly barrier: number;
}

export class SubscribeClient {
  private socket: WebSocketLike | null = null;
  private snapshot: SessionDetailSnapshot = INITIAL;
  private readonly listeners = new Set<() => void>();
  /** 停止屏障（保真⑦）：close() 置位后一切回调零副作用、connect() 永久拒绝、重复 close 幂等。 */
  private stopped = false;
  private requestSeq = 0;
  /** 在途 subscribe 家族请求（unsubscribe 无回包帧，不入此列）。 */
  private pending: PendingRequest | null = null;
  /** welcome 前排队的初始化订阅目标（welcome 后自动发出）。 */
  private queuedFile: string | null = null;
  /** 活动订阅 id（帧路由：events/status/resync-required 仅活动订阅受理）。 */
  private activeSub: SubscriptionId | null = null;
  /** 已退役订阅（同 file 新订阅替换/退订/终局后）：其帧一律忽略——旧流不得再进快照。 */
  private readonly retiredSubs = new Set<SubscriptionId>();
  /** history 幂等去重（seq 域；重发页/重放帧吸收）。只去重、不做缺号检测——连续性依赖服务端
   * 每订阅有序队列（§3.6 出帧串行化），这是当前边界，不宣称已实现缺口检测。 */
  private readonly seenSeqs = new Set<number>();
  /** live 幂等去重：liveSeq=服务端按批内事件数推进的批末序号；≤last 视为重复/回退帧吸收。 */
  private lastLiveSeq: number | null = null;
  /** K3-B2 已取消建订请求（init/resync）留痕：其迟到首页只用于识别服务端已建立的订阅并补发
   * unsubscribe。上限 32 条 FIFO（防长期翻动 file 无界增长；续页不新建服务端订阅，不入此表）。 */
  private readonly cancelledBuilds = new Map<string, true>();
  /** 续页实例绑定（保真⑨）。 */
  private binding: SnapshotBinding | null = null;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly createSocket: WebSocketFactory = defaultFactory,
  ) {}

  /** 建立连接并发起握手；单连接面，重复调用幂等；close() 后永久拒绝（无重连）。 */
  connect(): void {
    if (this.stopped || this.socket) return;
    let socket: WebSocketLike;
    try {
      socket = this.createSocket(this.url);
    } catch {
      this.stopped = true;
      this.failConnection("transport", "连接创建失败：无法建立 WebSocket 连接");
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.stopped || this.snapshot.connState !== "connecting") return; // 迟到/重复 open 不复活状态、不重发 hello
      this.sendFrame({ t: "hello", protocolVersion: 1, token: this.token });
      this.transition({ connState: "authenticating" });
    };
    socket.onmessage = (event) => this.handleMessage(event.data);
    socket.onerror = () => {
      if (this.stopped) return; // ws 语义：error 后必跟 close；状态迁移归 onclose 统一出口
    };
    socket.onclose = (event) => this.handleClose(event.code);
  }

  /**
   * 初始化订阅（§3.6 三分支之一：subscribe{requestId,file}）。
   * welcome 前调用=排队（welcome 后自动发出）；ready 后调用=显式退旧再建新（同 file 至多一个活动订阅）。
   * 新订阅=新快照：events/liveEvents/status/cursor 全部重置（「不重建」语义只属于 resyncFromCursor 续读）。
   */
  subscribeSession(file: string): void {
    if (this.stopped) return;
    if (this.snapshot.connState === "closed" || this.snapshot.connState === "error") return;
    if (!LIMITS.filePattern.test(file)) {
      // 发送前本地拒绝（服务端同判 4404）：零帧成本，受控文案
      this.failSubscription("文件名非法，无法订阅");
      return;
    }
    // 显式退旧：活动订阅先发退订帧（§3.6 c5 B01：新 subscribe 先退旧）；本地退役使旧流帧此后一律忽略
    this.dropActiveSubscription(true);
    this.noteCancelledBuild(); // K3-B2：被作废的建订在途留痕——迟到首页用于识别并补发退订（不写当前快照）
    this.seenSeqs.clear();
    this.lastLiveSeq = null;
    this.queuedFile = file;
    this.transition({
      file,
      phase: "idle",
      subscriptionId: null,
      events: [],
      liveEvents: [],
      status: null,
      cursor: null,
      uiRequests: [], // 换订阅=瞬态问答面同清（不重放）
      errorKind: null,
      errorMessage: null,
      streamNote: null,
    });
    if (this.snapshot.connState === "ready") this.openSubscription(file);
  }

  /**
   * 重同步续读（§3.6 三分支之二：subscribe{requestId,file,cursor}）——仅用户显式发起。
   * 语义=按末页 cursor 续读不重建：events 与 seq 去重集保留（补齐增量由幂等吸收），liveEvents 重置（瞬时面）。
   * 服务端原子终止旧订阅（无需退订帧）；旧订阅 id 本地退役。
   */
  resyncFromCursor(): void {
    if (this.stopped) return;
    if (this.snapshot.connState !== "ready") return;
    if (this.snapshot.phase !== "resync-needed") return; // 唯一入口：4409 续读终局态；无自动触发
    const file = this.snapshot.file;
    const cursor = this.snapshot.cursor;
    if (file === null || cursor === null) return;
    this.dropActiveSubscription(false);
    this.noteCancelledBuild(); // 此处正常无在途（终局态已清），防御性留痕
    this.lastLiveSeq = null;
    const requestId = this.nextRequestId("sub");
    this.pending = { requestId, kind: "resync" };
    this.transition({ phase: "subscribing", liveEvents: [], streamNote: null });
    this.sendFrame({ t: "subscribe", requestId, file, cursor }); // cursor 严格透传服务端值
  }

  /** 主动退订：发 unsubscribe 帧并本地退役；快照数据保留（视图呈「未订阅」），相位回 idle。 */
  unsubscribeSession(): void {
    if (this.stopped) return;
    this.queuedFile = null;
    this.noteCancelledBuild(); // 首包前退订——建订在途留痕，迟到首页只补退订不落快照
    this.dropActiveSubscription(true);
    this.transition({ phase: "idle", cursor: null, streamNote: null, errorKind: null, errorMessage: null, uiRequests: [] });
  }

  /**
   * D3 问答：发 ui-answer 帧并本地移除该提问（不等 ack；首个合法答案胜出，其余连接/晚答被服务端 4404
   * 静默拒收——本地面不重试不弹错）。仅活跃列表中的 requestId 可答（防重复发送/过期 id）。
   */
  answerUi(requestId: string, answer: UiAnswer): void {
    if (this.stopped) return;
    if (this.snapshot.connState !== "ready") return;
    if (!this.snapshot.uiRequests.some((r) => r.requestId === requestId)) return;
    this.sendFrame({ t: "ui-answer", requestId, ...answer });
    this.transition({ uiRequests: this.snapshot.uiRequests.filter((r) => r.requestId !== requestId) });
  }

  /**
   * 主动关闭：立即置不可逆停止位并物理释放 socket（未 connect/connecting/error 均可关）。
   * error 态保留具体错误文案（不降级为 closed）；停止位置位后清在途/排队、迟到回调零副作用、重复 close 幂等。
   */
  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.pending = null;
    this.queuedFile = null;
    this.cancelledBuilds.clear(); // 终态：连接关闭即服务端释放订阅，无需留痕
    if (this.snapshot.connState !== "closed" && this.snapshot.connState !== "error") {
      this.transition({ connState: "closed" });
    }
    this.socket?.close();
  }

  /** 快照变更订阅（useSyncExternalStore 直接对齐）；返回退订函数。 */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): SessionDetailSnapshot => this.snapshot;

  // -------------------------------------------------------------------------
  // 内部：请求与帧发送
  // -------------------------------------------------------------------------

  private nextRequestId(prefix: string): string {
    this.requestSeq += 1;
    return `${prefix}-${this.requestSeq}`; // §5.7 requestIdPattern=/^[\w-]{1,64}$/
  }

  private sendFrame(frame: OutgoingFrame): void {
    if (this.stopped) return;
    const socket = this.socket;
    if (!socket || socket.readyState !== WS_OPEN) return;
    socket.send(JSON.stringify(frame));
  }

  /** 退役活动订阅（本地退役+可选退订帧）；resync 路径不发退订帧（服务端原子终止旧订阅）。 */
  private dropActiveSubscription(sendUnsubscribe: boolean): void {
    const sub = this.activeSub;
    if (sub === null) return;
    this.retiredSubs.add(sub);
    this.activeSub = null;
    this.binding = null; // 实例绑定随订阅退役作废
    if (sendUnsubscribe) {
      this.sendFrame({ t: "unsubscribe", requestId: this.nextRequestId("unsub"), subscriptionId: sub });
    }
  }

  /** K3-B2：作废在途建订请求并留痕（init/resync 迟到首页→识别服务端已建订阅并补发退订；page 类不留痕——
   *  续页不新建服务端订阅，清理由活动订阅退订路径负责）。表上限 32 条 FIFO 防无界增长。 */
  private noteCancelledBuild(): void {
    const pending = this.pending;
    this.pending = null;
    if (pending === null || pending.kind === "page") return;
    if (this.cancelledBuilds.size >= 32) {
      const oldest = this.cancelledBuilds.keys().next().value;
      if (oldest !== undefined) this.cancelledBuilds.delete(oldest);
    }
    this.cancelledBuilds.set(pending.requestId, true);
  }

  /** 发出初始化订阅（排队文件出队或 ready 后直发共用）。 */
  private openSubscription(file: string): void {
    const requestId = this.nextRequestId("sub");
    this.pending = { requestId, kind: "init" };
    this.transition({ phase: "subscribing" });
    this.sendFrame({ t: "subscribe", requestId, file });
  }

  /** 续页订阅（§3.6 三分支之三：subscribe{requestId,file,snapshotId,historyNext}）——快照协议本体自动驱动。 */
  private requestNextPage(snapshotId: string, historyNext: EventCursor): void {
    const file = this.snapshot.file;
    if (file === null) return;
    const requestId = this.nextRequestId("sub");
    this.pending = { requestId, kind: "page" };
    this.sendFrame({ t: "subscribe", requestId, file, snapshotId, historyNext }); // 游标/snapshotId 严格透传
  }

  // -------------------------------------------------------------------------
  // 内部：消费帧处理
  // -------------------------------------------------------------------------

  private handleMessage(data: unknown): void {
    const conn = this.snapshot.connState;
    if (this.stopped || conn === "closed" || conn === "error") return; // 停止屏障/连接终态后不再消费任何帧
    if (typeof data !== "string") return; // 二进制帧非本面
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return; // 畸形 JSON 安全忽略
    }
    if (!rec(parsed)) return;
    switch (parsed.t) {
      case "welcome": {
        if (conn !== "authenticating") return; // 重复 welcome 幂等忽略
        if (parseWelcome(parsed) === null) return; // 形状门：缺字段/版本不符=未知帧，不得算握手成功
        this.transition({ connState: "ready" });
        if (this.queuedFile !== null) this.openSubscription(this.queuedFile); // 排队订阅自动发出
        return;
      }
      case "snapshot":
        this.handleSnapshot(parsed);
        return;
      case "events":
        this.handleEvents(parsed);
        return;
      case "status": {
        const frame = parseStatus(parsed);
        if (frame === null) return; // 畸形整帧忽略
        if (this.activeSub === null || frame.subscriptionId !== this.activeSub) return;
        // 注：statusVersion 回退帧当前不拒绝（无版本门）——有序传输前提下的已知边界，不宣称已防乱序。
        this.transition({ status: frame.status });
        return;
      }
      case "resync-required":
        this.handleResyncRequired(parsed);
        return;
      case "ui-request": {
        const frame = parseUiRequest(parsed);
        if (frame === null) return; // 畸形整帧忽略
        // 只对当前订阅 file 生效（跨 file 广播/迟到帧忽略）；订阅活跃相位（subscribing/paging/live）才受理——
        // idle/closed/resync-needed 无活动流，答了也只会被 4404 拒，不收
        const phase = this.snapshot.phase;
        if (frame.file !== this.snapshot.file) return;
        if (phase !== "subscribing" && phase !== "paging" && phase !== "live") return;
        if (this.snapshot.uiRequests.some((r) => r.requestId === frame.requestId)) return; // 同 id 重复广播幂等
        const req: UiRequest = {
          requestId: frame.requestId,
          method: frame.method,
          ...(frame.title === undefined ? {} : { title: frame.title }),
          ...(frame.options === undefined ? {} : { options: frame.options }),
          ...(frame.message === undefined ? {} : { message: frame.message }),
          ...(frame.placeholder === undefined ? {} : { placeholder: frame.placeholder }),
          ...(frame.prefill === undefined ? {} : { prefill: frame.prefill }),
          ...(frame.timeoutMs === undefined ? {} : { timeoutMs: frame.timeoutMs }),
        };
        this.transition({ uiRequests: [...this.snapshot.uiRequests, req] });
        return;
      }
      case "ui-closed": {
        const frame = parseUiClosed(parsed);
        if (frame === null) return; // 畸形整帧忽略
        if (!this.snapshot.uiRequests.some((r) => r.requestId === frame.requestId)) return; // 未知/已清 id 零副作用
        this.transition({ uiRequests: this.snapshot.uiRequests.filter((r) => r.requestId !== frame.requestId) });
        return;
      }
      case "error":
        this.handleError(parsed);
        return;
      default:
        // 未知/暂不消费的帧（sessions/recovery/pong/write-ack 等及任何陌生 t）安全忽略
        return;
    }
  }

  private handleSnapshot(v: Record<string, unknown>): void {
    const frame = parseSnapshot(v);
    if (frame === null) return; // 形状门：坏帧零副作用——不污染快照、不消费在途请求，可续收合法帧
    if (this.cancelledBuilds.delete(frame.requestId)) {
      // K3-B2 已取消建订请求的迟到首页：服务端已建立该订阅——仅识别+补发退订；不写当前快照、
      // 不清当前在途/活动订阅/实例绑定（迟到页先过形状门：畸形迟到页仍按未知帧零副作用处理）。
      this.retiredSubs.add(frame.subscriptionId);
      this.sendFrame({ t: "unsubscribe", requestId: this.nextRequestId("unsub"), subscriptionId: frame.subscriptionId });
      return;
    }
    const pending = this.pending;
    if (pending === null || frame.requestId !== pending.requestId) return; // 迟到页/无关请求忽略
    if (pending.kind === "page") {
      // 续页实例绑定（保真⑨）：subscriptionId/snapshotId/streamId/barrier 必须与当前快照实例一致——
      // 不一致整帧拒绝（不消费在途；绑定一致的续页/重发仍可续读）。
      const binding = this.binding;
      if (
        binding === null || this.activeSub === null || frame.subscriptionId !== this.activeSub ||
        frame.snapshotId !== binding.snapshotId || frame.streamId !== binding.streamId || frame.barrier !== binding.barrier
      ) {
        return;
      }
    }
    this.pending = null;
    this.activeSub = frame.subscriptionId;
    if (pending.kind !== "page") {
      this.binding = { snapshotId: frame.snapshotId, streamId: frame.streamId, barrier: frame.barrier };
    }
    // 页追加（seq 幂等）：重发页/重放由 seenSeqs 吸收
    const events = [...this.snapshot.events];
    for (const ev of frame.page) {
      if (!this.seenSeqs.has(ev.seq)) {
        this.seenSeqs.add(ev.seq);
        events.push(ev);
      }
    }
    if (frame.historyNext !== null) {
      // 非末页：透传游标+自动续页（§3.7 时序 1：续页×N 直至末页）
      this.transition({
        events,
        status: frame.status,
        subscriptionId: frame.subscriptionId,
        cursor: frame.historyNext,
        phase: "paging",
      });
      this.requestNextPage(frame.snapshotId, frame.historyNext);
      return;
    }
    // 末页：历史读完→live（自动接持续投递，无需发帧；liveFrom=续读起点，严格服务端值）
    const liveFrom = frame.liveFrom; // parseSnapshot 保证非 null
    this.transition({
      events,
      status: frame.status,
      subscriptionId: frame.subscriptionId,
      cursor: liveFrom,
      phase: "live",
    });
  }

  private handleEvents(v: Record<string, unknown>): void {
    if (this.activeSub === null) return;
    if (v.origin === "history") {
      const frame = parseHistoryEvents(v);
      if (frame === null) return; // 畸形整帧忽略
      if (frame.subscriptionId !== this.activeSub) return; // 旧流/未知订阅不得进快照
      const events = [...this.snapshot.events];
      let added = false;
      for (const ev of frame.events) {
        if (this.seenSeqs.has(ev.seq)) continue; // seq 幂等：重复事件不重复入列
        this.seenSeqs.add(ev.seq);
        events.push(ev);
        added = true;
      }
      if (added) this.transition({ events });
      return;
    }
    if (v.origin === "live") {
      const frame = parseLiveEvents(v);
      if (frame === null) return;
      if (frame.subscriptionId !== this.activeSub) return;
      if (this.lastLiveSeq !== null && frame.liveSeq <= this.lastLiveSeq) return; // liveSeq 幂等（批末序≤last 即重复/回退帧；不做缺口检测）
      this.lastLiveSeq = frame.liveSeq;
      if (frame.events.length > 0) this.transition({ liveEvents: [...this.snapshot.liveEvents, ...frame.events] });
      return;
    }
    // 未知 origin 忽略
  }

  private handleResyncRequired(v: Record<string, unknown>): void {
    const frame = parseResyncRequired(v);
    if (frame === null) return;
    if (this.activeSub === null || frame.subscriptionId !== this.activeSub) return; // 已退役订阅的替换通知忽略
    if (frame.reason === "stream-replaced") {
      // 活动订阅被新订阅替换（本客户端发起的替换已先行退役——此为服务端迟到通知或外部替换）
      this.retiredSubs.add(frame.subscriptionId);
      this.activeSub = null;
      this.binding = null;
      this.pending = null;
      this.transition({ phase: "closed", subscriptionId: null, streamNote: "订阅已被新订阅替换，旧流已停止", uiRequests: [] });
      return;
    }
    // server-side-gap：服务端缺口——无自动重同步（用户显式续读）；快照与 cursor 保留
    this.pending = null;
    this.transition({ phase: "resync-needed", streamNote: "检测到服务端事件缺口，需要重新同步后继续", uiRequests: [] });
  }

  private handleError(v: Record<string, unknown>): void {
    const frame = parseError(v);
    if (frame === null) return; // 畸形 error 帧（未知码/message 缺失等）整帧忽略
    if (frame.code === 4401) {
      this.failConnection("auth-failed", errorTextFor(4401));
      return;
    }
    const conn = this.snapshot.connState;
    if (conn === "connecting" || conn === "authenticating") {
      this.failConnection("handshake-failed", errorTextFor(frame.code));
      return;
    }
    // K3-B1/K4 结构化身份路由（保真⑪）：带 subscriptionId=流终局通知——先于一切请求级匹配。
    // 终局是【流】的事件：requestId 恒空串，不冒充任何在途请求失败；也不解析 message 文本里的 id
    // （如 stream-replaced:sub-x）——只按结构化字段路由。
    if (frame.subscriptionId !== undefined) {
      this.handleStreamTerminal(frame.subscriptionId, frame.code);
      return;
    }
    // 旧信封兼容（df0e576 前网关形态：终局无 subscriptionId、requestId 空串/缺省）：空 requestId 的
    // 4409/4431/4402 按当前活动流终局处理——本面单 file 至多一个活动订阅，归属无歧义；无活动订阅
    // 则忽略（零副作用）。连接级发送队列超限的 4431 同形（connection-queue），但服务端随后必
    // close(4431)——connState 由 handleClose 覆盖为 closed，本分支的流终局相位不致误呈「连接可用」。
    if (
      (frame.code === 4409 || frame.code === 4431 || frame.code === 4402) &&
      (frame.requestId === undefined || frame.requestId === "")
    ) {
      if (this.activeSub !== null) this.handleStreamTerminal(this.activeSub, frame.code);
      return;
    }
    const pending = this.pending;
    if (pending !== null && frame.requestId === pending.requestId) {
      this.pending = null;
      if (frame.code === 4409 && (pending.kind === "page" || pending.kind === "resync") && this.snapshot.cursor !== null) {
        // 续页/重同步请求收 4409（契约场景之一=末页 60s 宽限失效后的尾页重试：快照资源已释放、streamId 仍有效）：
        // 置 resync-needed 保留 events+cursor，等待用户显式续读（无自动重发）。注：快照续页 60s 宽限的
        // 真实轨迹未在前端测试验证（客户端无尾页重试公共入口）；已验路径=重同步 cursor 请求收 4409 后可手动再试。
        this.transition({ phase: "resync-needed", streamNote: errorTextFor(4409) });
        return;
      }
      // 其余请求级失败（4402/4404 在途重复/4413/4429…）：订阅请求终局，受控文案；连接保持可再订阅
      this.failSubscription(errorTextFor(frame.code));
      return;
    }
    // C5（保真⑩）：ready 后无 requestId 关联的连接级错误码进连接级失败映射（受控文案按 code）。
    // 关联判定口径：undefined 或空串""——空串是服务端 errFrame 对「不关联任何请求」的统一惯例。
    // 边界：4413/4429 契约定为请求级，无关联时不升级为连接级；空 requestId 的 4409/4431/4402 已由上方
    // 终局分支（结构化/旧信封兼容，同样认 undefined|""）接走，此处不再重叠接 4431。
    if (
      (frame.requestId === undefined || frame.requestId === "") &&
      (frame.code === 4403 || frame.code === 4405 || frame.code === 4432)
    ) {
      this.failConnection("transport", errorTextFor(frame.code));
      return;
    }
    // 其余无关联请求/订阅的 error 帧安全忽略
  }

  /**
   * K3-B1 流终局路由（结构化身份，保真⑪）：sub=所停流；code 决定终局相位——4409=续读终局（快照+cursor
   * 保留，等用户显式续读）；4431 订阅积压（含 K4 发现1 drain 出口）/4402 流终局容量出口=订阅终局
   * closed（内容保留，视图呈终局横幅）。
   * 非活动流（未知/已退役——含本地先行退役的换流旧流）一律忽略：终局不得误伤同 file 新快照请求（K3 P1）。
   * 清理不触碰 cancelledBuilds（K3-B2：迟到首页补退订义务不因终局豁免）；也不发退订帧——终局即服务端
   * 已停该流，退订属冗余写。
   */
  private handleStreamTerminal(sub: SubscriptionId, code: ErrorCode): void {
    if (this.activeSub === null || sub !== this.activeSub) return;
    this.retiredSubs.add(sub);
    this.activeSub = null;
    this.binding = null;
    this.pending = null; // 该流在途请求不再期待回包——清理属流终局，不置请求失败文案（新信封不指认请求）
    if (code === 4409) {
      this.transition({ phase: "resync-needed", streamNote: errorTextFor(4409), uiRequests: [] }); // 无活动流，瞬态提问不再可答
      return;
    }
    this.transition({ phase: "closed", errorKind: "stream-terminal", errorMessage: errorTextFor(code), uiRequests: [] });
  }

  private handleClose(code: number): void {
    if (this.stopped) return; // 停止屏障：close() 后迟到关闭事件零副作用
    const conn = this.snapshot.connState;
    if (conn === "closed" || conn === "error") return; // auth-failed/handshake-failed 不降级
    if (code === 1008 && (conn === "connecting" || conn === "authenticating")) {
      this.failConnection("auth-failed", "认证失败（连接被 1008 关闭）");
      return;
    }
    this.pending = null; // 连接终态清在途/排队，迟到回包不再有归属
    this.queuedFile = null;
    this.transition({ connState: "closed", uiRequests: [] }); // 连接终态；无自动重连；瞬态提问不重放
  }

  /** 连接级错误出口：清在途/排队（迟到回包不再变更快照）+受控文案进快照。 */
  private failConnection(errorKind: DetailErrorKind, errorMessage: string): void {
    this.pending = null;
    this.queuedFile = null;
    this.transition({ connState: "error", errorKind, errorMessage, uiRequests: [] });
  }

  /** 订阅请求失败出口：不作废连接（连接与其余订阅面保持），订阅相位终局+受控文案。
   * K3-B2：被丢弃的建订在途留痕（迟到首页→补退订）；本地终局的活动订阅补发退订帧（服务端资源不残留）。 */
  private failSubscription(errorMessage: string): void {
    this.noteCancelledBuild();
    this.dropActiveSubscription(true);
    this.transition({ phase: "closed", errorKind: "subscribe-failed", errorMessage, streamNote: null, uiRequests: [] });
  }

  private transition(patch: Partial<SessionDetailSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}

/** 组件/hook 所需客户端面（subscribe/getSnapshot 对齐 useSyncExternalStore；其余为订阅生命周期动作+D3 问答）。 */
export type SubscribeClientSurface = Pick<
  SubscribeClient,
  "subscribe" | "getSnapshot" | "subscribeSession" | "unsubscribeSession" | "resyncFromCursor" | "answerUi"
>;
