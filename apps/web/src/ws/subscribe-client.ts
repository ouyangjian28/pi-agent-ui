// A1b 只读面订阅客户端：hello 握手→welcome 后自动发出排队中的初始化订阅→snapshot 分页→events 续流，
// 维护单文件会话详情只读快照。基于 ws-client.ts 模式（K2 验收 bb522b8）扩展订阅生命周期。
// 红线（复刻 ws-client 两铁律+订阅终局语义）：
// ①只发 hello/subscribe/unsubscribe——OutgoingFrame 类型层封闭，写类帧（prompt/stop 等 WRITE_FRAME_TYPES）无从构造；
// ②实际消费的帧（welcome/snapshot/events/status/resync-required/error）先过文件内私有运行时形状校验
//   （asXxxFrame 系列；HistoryEvent/LiveEvent/SessionStatus 全域逐字段），坏帧=零副作用：
//   不污染快照/不消费在途请求/后续合法帧照常受理；
// ③错误文案受控（按 code 映射，controlledErrorText）——远端 error.message 可能回显敏感输入，永不进入快照与 DOM；
// ④无自动重连/自动重订阅：续读终局（4409）只置 resync-needed 态并保留快照，resyncFromCursor() 仅由用户显式发起
//   （快照分页的自动续页属订阅协议本体 §3.7 时序 1，非重连）；
// ⑤同 file 至多一个活动订阅：subscribeSession 显式退旧（退订帧+本地退役，旧流帧一律按 subscriptionId 忽略）；
// ⑥cursor 严格透传服务端值（页 historyNext/末页 liveFrom 原样回传续用，不重算序号）；
// ⑦close()=不可逆停止屏障（任何状态可关、迟到回调零副作用、幂等；closed=终态，无自动重连）；
// ⑧首页在途取消留痕（B2）：被取消/作废的初始化·重同步建订请求记入 canceledInits——其迟到首页只用于识别
//   服务端已建立的订阅并补发 unsubscribe（绝不写当前快照、绝不清当前 file 订阅）；本地终局的活动订阅补发退订帧；
// ⑨续页实例绑定与跨字段一致性（C2）：page 类续页帧的 subscriptionId/snapshotId/streamId/barrier 必须与当前
//   快照实例一致；hasMore⟺historyNext、页游标 streamId 必须绑本帧流——矛盾帧整帧拒绝（零消费，合法帧可恢复续读）；
// ⑩ready 后无 requestId 的连接级错误码（4403/4405/4432）进连接级失败映射（C5；受控文案按 code，
//   4432 心跳原因不丢）；4413/4429 契约定为请求级，无关联时不升级为连接级；
// ⑪K3-B1 错误帧身份路由（df0e576 §3.6「错误帧路由语义」修订）：带 subscriptionId=流终局通知（4409
//   stream-replaced/observe-missed/磁盘换流、4431 订阅积压、4402 流终局容量出口；requestId 恒空串）——
//   按 subscriptionId 路由清理该流，绝不冒充在途请求失败（旧信封 4409 误携新 requestId 曾致合法新
//   snapshot 被丢，K3 P1）、绝不解析 message 文本里的 id；仅带 requestId=请求级失败；无流身份且 requestId
//   空缺的 4409/4431/4402=旧信封终局，按当前活动流兼容处理（本面单 file 至多一个活动订阅，身份无歧义）。

// 同 ws-client：绕开 barrel 直引自包含 contracts 模块（浏览器安全、零 Node 依赖）。
// LIMITS 为值导入（filePattern/idPattern 冻结源，避免本地复制漂移；contracts.ts 无副作用可入浏览器包）。
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
} from "@pi-agent-ui/protocol/src/contracts";

/** 本客户端允许发送的帧（§5.1 六客户端帧的订阅生命周期子集；写类 t 在类型层即不可达）。 */
type OutgoingFrame = Extract<ClientFrame, { readonly t: "hello" } | { readonly t: "subscribe" } | { readonly t: "unsubscribe" }>;

/** 连接级五态（同 ws-client）：connecting→authenticating→ready；任一前置态可落 closed/error。 */
export type DetailConnState = "connecting" | "authenticating" | "ready" | "closed" | "error";

/** 订阅相位（§3.6 订阅状态机 init→paging→live→closed 的客户端镜像+续读终局态）。 */
export type SubscriptionPhase =
  | "idle" // 无订阅（未发起/已退订）
  | "subscribing" // 初始化或重同步 subscribe 已发，等 snapshot
  | "paging" // 已收页且 hasMore，续页在途
  | "live" // 历史读完（末页已收，liveFrom 已记），持续投递中
  | "resync-needed" // 续读终局（4409）：快照+cursor 保留，等待用户显式续读
  | "closed"; // 订阅终局（4431/请求级失败/被替换/退订后旧流不可再展示）

/** 错误成因：auth-failed/handshake-failed/transport=连接级；subscribe-failed=订阅请求被拒；stream-terminal=4431 订阅终局。 */
export type DetailErrorKind = "auth-failed" | "handshake-failed" | "transport" | "subscribe-failed" | "stream-terminal";

/**
 * 会话详情快照（不可变；每次变更整体替换——useSyncExternalStore getSnapshot 缓存语义，未变即引用相等）。
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
}

/** 可注入的 WebSocket 最小面（与 ws-client 同形；测试用 FakeWebSocket 顶替）。 */
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

const OPEN = 1;

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
};

// ---------------------------------------------------------------------------
// R1：消费帧运行时形状校验（纯函数、文件内私有、零依赖）。
// 只校验本面实际消费的帧（权威=contracts.ts 组2/组3/组3.6/组5）；校验失败→按未知帧处理（零副作用）。
// 宽松口径与 ws-client 一致：字段存在性+类型+枚举域（不拒未知多余键——服务端契约要求 exact，客户端只读不放大信任）。
// ---------------------------------------------------------------------------

/** §5.3 错误码全集（运行时镜像；未登记码=未知帧保守拒绝）。 */
const ERROR_CODES: ReadonlySet<number> = new Set([4401, 4402, 4403, 4404, 4405, 4409, 4413, 4429, 4431, 4432]);

function isErrorCode(v: unknown): v is ErrorCode {
  return typeof v === "number" && ERROR_CODES.has(v);
}

type WelcomeFrame = Extract<ServerFrame, { readonly t: "welcome" }>;
type ErrorFrame = Extract<ServerFrame, { readonly t: "error" }>;
type ResyncRequiredFrame = Extract<ServerFrame, { readonly t: "resync-required" }>;
type StatusFrame = Extract<ServerFrame, { readonly t: "status" }>;
type HistoryEventsFrame = Extract<ServerFrame, { readonly t: "events"; readonly origin: "history" }>;
type LiveEventsFrame = Extract<ServerFrame, { readonly t: "events"; readonly origin: "live" }>;
type SnapshotServerFrame = Extract<ServerFrame, { readonly t: "snapshot" }>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isString(v: unknown): v is string {
  return typeof v === "string";
}
function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}
/** 计数/时间戳/序号域：有限非负数（显式设防 NaN/Infinity）。 */
function isNonNegativeNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}
/** 传输 ID 域（idPattern 等价：非空≤128，字符不收紧——形状校验只防类型错认，不复制白名单语义）。
 * 口径记录（C2）：本层上限=128（与 LIMITS.idPattern 同源）；契约文档对传输 stream/subscription 域为 64。
 * 此处不做域长分立收紧（形状校验不复制白名单语义），精确域由服务端 4404 校验把关。 */
function isTransportId(v: unknown): v is string {
  return isString(v) && v.length > 0 && v.length <= 128;
}
function isSanitizedText(v: unknown): boolean {
  return isPlainObject(v) && isString(v.text) && isBoolean(v.truncated);
}

/** EventCursor（§3.6）：exact 双字段；seq=下一待读位，合法域 ≥1（0 非法）。 */
function asEventCursor(v: unknown): EventCursor | null {
  if (!isPlainObject(v)) return null;
  const sid = v["streamId"], seq = v["seq"];
  if (!isTransportId(sid)) return null;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) return null;
  return { streamId: sid, seq };
}

function isTurnState(v: unknown): v is TurnState {
  if (!isPlainObject(v)) return false;
  switch (v["state"]) {
    case "idle":
      return true;
    case "dispatching":
    case "in-flight":
    case "settling":
      return isString(v["intentId"]);
    case "closed":
      return (
        v["reason"] === "durability-failure" || v["reason"] === "turn-timeout" || v["reason"] === "buffer-overflow" ||
        v["reason"] === "manual" || v["reason"] === "generation-retired"
      );
    default:
      return false;
  }
}

function isStartResult(v: unknown): v is StartResult {
  if (!isPlainObject(v)) return false;
  switch (v["kind"]) {
    case "ready":
    case "superseded":
    case "readiness-timeout":
    case "spawn-exited":
      return isNonNegativeNumber(v["generation"]);
    case "spawn-failed":
      return v["generation"] === null;
    default:
      return false;
  }
}

function isStopResult(v: unknown): v is StopResult {
  return isPlainObject(v) && (v["kind"] === "confirmed" || v["kind"] === "deadline-exceeded") && isNonNegativeNumber(v["atMs"]);
}

/** RecoverySummary（组2）：全部可空计数域显式校验。 */
function isRecoverySummary(v: unknown): v is SessionStatus["recovery"] {
  if (!isPlainObject(v)) return false;
  if (v["availability"] !== "available" && v["availability"] !== "unavailable") return false;
  const nullableBool = (x: unknown) => x === null || isBoolean(x);
  const nullableCount = (x: unknown) => x === null || isNonNegativeNumber(x);
  return (
    nullableBool(v["resumeBlocked"]) && nullableBool(v["diskBlocked"]) &&
    nullableCount(v["unknownEffectCount"]) && nullableCount(v["unattributableFragments"]) &&
    nullableCount(v["intentsCount"]) && nullableCount(v["settledCount"]) &&
    (v["evidenceHash"] === null || isString(v["evidenceHash"]))
  );
}

/** SessionStatus（组2）全域逐字段（快照帧携带+status 帧复用同校验）。 */
function isSessionStatus(v: unknown): v is SessionStatus {
  if (!isPlainObject(v)) return false;
  const session = v["session"];
  if (!isPlainObject(session)) return false;
  if (!(session["sessionId"] === null || isString(session["sessionId"]))) return false;
  if (!isString(session["file"])) return false;
  if (!(session["adapterSessionId"] === null || isString(session["adapterSessionId"]))) return false;
  const process = v["process"];
  if (!isPlainObject(process)) return false;
  if (process["phase"] !== "idle" && process["phase"] !== "running" && process["phase"] !== "stopping") return false;
  if (!(process["generation"] === null || isNonNegativeNumber(process["generation"]))) return false;
  if (!(process["lastStartResult"] === null || isStartResult(process["lastStartResult"]))) return false;
  if (!(process["lastStopResult"] === null || isStopResult(process["lastStopResult"]))) return false;
  if (!isBoolean(process["ready"])) return false;
  if (!isTurnState(v["turn"])) return false;
  const tasks = v["backgroundTasks"];
  if (!isPlainObject(tasks)) return false;
  if (tasks["availability"] !== "known" && tasks["availability"] !== "unknown") return false;
  if (!(tasks["activeCount"] === null || isNonNegativeNumber(tasks["activeCount"]))) return false;
  const reap = v["reap"];
  if (!isPlainObject(reap)) return false;
  if (!isBoolean(reap["eligible"])) return false;
  if (!(reap["idleElapsedMs"] === null || isNonNegativeNumber(reap["idleElapsedMs"]))) return false;
  if (!(reap["idleRemainingMs"] === null || isNonNegativeNumber(reap["idleRemainingMs"]))) return false;
  if (!isNonNegativeNumber(reap["idleMs"])) return false;
  if (!isRecoverySummary(v["recovery"])) return false;
  if (!isNonNegativeNumber(v["statusVersion"])) return false;
  if (!isNonNegativeNumber(v["serverTimeMs"])) return false;
  return true;
}

const MESSAGE_ROLES = ["user", "assistant", "toolCall", "toolResult", "system"] as const;
const STOP_REASONS = ["stop", "length", "aborted", "toolUse"] as const;

/** HistoryEvent（组3）判别联合全域：基础域+kind 特有域逐项。 */
function isHistoryEvent(v: unknown): v is HistoryEvent {
  if (!isPlainObject(v)) return false;
  if (typeof v["seq"] !== "number" || !Number.isSafeInteger(v["seq"]) || v["seq"] < 1) return false;
  if (!(v["ts"] === null || isNonNegativeNumber(v["ts"]))) return false;
  if (!(v["generation"] === null || isNonNegativeNumber(v["generation"]))) return false;
  if (!(v["intentId"] === null || isTransportId(v["intentId"]))) return false;
  switch (v["kind"]) {
    case "turn-enqueued":
      return isSanitizedText(v["preview"]) && isNonNegativeNumber(v["ordinal"]);
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
      return isNonNegativeNumber(v["commandId"]);
    case "clear":
      return isNonNegativeNumber(v["clearedCount"]);
    case "corrupt-entry":
      return isTransportId(v["entryId"]);
    case "message": {
      if (!isTransportId(v["entryId"])) return false;
      if ("blockIndex" in v && !isNonNegativeNumber(v["blockIndex"])) return false;
      if (!MESSAGE_ROLES.includes(v["role"] as (typeof MESSAGE_ROLES)[number])) return false;
      if ("textPreview" in v && !isSanitizedText(v["textPreview"])) return false;
      if ("stopReason" in v && !STOP_REASONS.includes(v["stopReason"] as (typeof STOP_REASONS)[number])) return false;
      if ("toolCallId" in v && !isTransportId(v["toolCallId"])) return false;
      return isBoolean(v["final"]);
    }
    default:
      return false;
  }
}

const PI_TYPES = ["agent_start", "turn_start", "message_start", "message_update", "message_end", "turn_end", "agent_end", "agent_settled"] as const;
const PROGRESS_NOTES = ["thinking", "tool-start", "tool-end", "compacting", "message-start", "message-end"] as const;

/** LiveEvent（组3）判别联合全域。 */
function isLiveEvent(v: unknown): v is LiveEvent {
  if (!isPlainObject(v)) return false;
  switch (v["kind"]) {
    case "pi-progress":
      return PI_TYPES.includes(v["piType"] as (typeof PI_TYPES)[number]) && PROGRESS_NOTES.includes(v["note"] as (typeof PROGRESS_NOTES)[number]);
    case "turn-state":
      return isNonNegativeNumber(v["statusVersion"]) && isTurnState(v["turn"]);
    case "process-note":
      return v["phase"] === "running" || v["phase"] === "stopping";
    default:
      return false;
  }
}

/** welcome：同 ws-client（serverBootId/serverBuildId 必须 string，protocolVersion 字面量 1）。 */
function asWelcomeFrame(v: Record<string, unknown>): WelcomeFrame | null {
  if (!isString(v.serverBootId) || !isString(v.serverBuildId) || v.protocolVersion !== 1) return null;
  return { t: "welcome", serverBootId: v.serverBootId, serverBuildId: v.serverBuildId, protocolVersion: 1 };
}

/** error：code∈锚定码表、message 必须 string（即使不展示也验形）、retryable 必须 boolean。 */
function asErrorFrame(v: Record<string, unknown>): ErrorFrame | null {
  if (!isErrorCode(v.code)) return null;
  if (!isString(v.message) || !isBoolean(v.retryable)) return null;
  if (v.requestId !== undefined && !isString(v.requestId)) return null;
  if (v.subscriptionId !== undefined && !isTransportId(v.subscriptionId)) return null;
  return {
    t: "error",
    code: v.code,
    message: v.message,
    retryable: v.retryable,
    ...(v.requestId === undefined ? {} : { requestId: v.requestId }),
    ...(v.subscriptionId === undefined ? {} : { subscriptionId: v.subscriptionId }),
  };
}

/**
 * snapshot（§3.6）：整帧逐字段+page 逐事件+status 全域+末页不变量
 * （historyNext=null ⟺ 末页且必有 liveFrom；非末页 liveFrom=null——两 null 同现或同现非 null 均拒收）。
 */
function asSnapshotFrame(v: Record<string, unknown>): SnapshotServerFrame | null {
  if (!isString(v.requestId)) return null;
  if (!isTransportId(v.subscriptionId)) return null;
  if (!isTransportId(v.streamId)) return null;
  if (!isString(v.snapshotId) || v.snapshotId.length === 0 || v.snapshotId.length > 64) return null;
  if (typeof v.barrier !== "number" || !Number.isSafeInteger(v.barrier) || v.barrier < 0) return null;
  if (!isSessionStatus(v.status)) return null;
  if (!isBoolean(v.hasMore)) return null;
  if (!Array.isArray(v.page)) return null;
  const page: HistoryEvent[] = [];
  for (const item of v.page) {
    if (!isHistoryEvent(item)) return null; // 任一事件畸形（含 null）整帧拒绝
    page.push(item);
  }
  const historyNext = v.historyNext === null ? null : asEventCursor(v.historyNext);
  if (v.historyNext !== null && historyNext === null) return null;
  const liveFrom = v.liveFrom === null ? null : asEventCursor(v.liveFrom);
  if (v.liveFrom !== null && liveFrom === null) return null;
  // 末页不变量：historyNext 与 liveFrom 互斥同现（§3.6：historyNext=null ⟺ 末页；空流 H=0 也有 liveFrom={s,1}）
  if (historyNext === null && liveFrom === null) return null;
  if (historyNext !== null && liveFrom !== null) return null;
  // C2 跨字段一致性：hasMore ⟺ historyNext 非空（矛盾帧整帧拒绝）；页游标必须属于本帧流（跨流游标拒绝）。
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

/** events history 变体：refSeq 必须 number；events 逐事件校验。 */
function asHistoryEventsFrame(v: Record<string, unknown>): HistoryEventsFrame | null {
  if (!isTransportId(v.subscriptionId)) return null;
  if (typeof v.refSeq !== "number" || !Number.isSafeInteger(v.refSeq) || v.refSeq < 0) return null;
  if (!Array.isArray(v.events)) return null;
  const events: HistoryEvent[] = [];
  for (const item of v.events) {
    if (!isHistoryEvent(item)) return null;
    events.push(item);
  }
  return { t: "events", subscriptionId: v.subscriptionId, origin: "history", refSeq: v.refSeq, events };
}

/** events live 变体：refSeq 显式 null（缺字段=拒收）；liveSeq 帧号 ≥1。 */
function asLiveEventsFrame(v: Record<string, unknown>): LiveEventsFrame | null {
  if (!isTransportId(v.subscriptionId)) return null;
  if (!("refSeq" in v) || v.refSeq !== null) return null;
  if (typeof v.liveSeq !== "number" || !Number.isSafeInteger(v.liveSeq) || v.liveSeq < 1) return null;
  if (!Array.isArray(v.events)) return null;
  const events: LiveEvent[] = [];
  for (const item of v.events) {
    if (!isLiveEvent(item)) return null;
    events.push(item);
  }
  return { t: "events", subscriptionId: v.subscriptionId, origin: "live", liveSeq: v.liveSeq, refSeq: null, events };
}

/** status：subscriptionId+SessionStatus 全域。 */
function asStatusFrame(v: Record<string, unknown>): StatusFrame | null {
  if (!isTransportId(v.subscriptionId)) return null;
  if (!isSessionStatus(v.status)) return null;
  return { t: "status", subscriptionId: v.subscriptionId, status: v.status };
}

/** resync-required：reason 枚举闭合。 */
function asResyncRequiredFrame(v: Record<string, unknown>): ResyncRequiredFrame | null {
  if (!isTransportId(v.subscriptionId)) return null;
  if (v.reason !== "server-side-gap" && v.reason !== "stream-replaced") return null;
  return { t: "resync-required", subscriptionId: v.subscriptionId, reason: v.reason };
}

// ---------------------------------------------------------------------------
// R2：错误文案受控映射（同 ws-client；code 域封闭=内嵌安全，message 仅服务端审计用，前端不留存）。
// ---------------------------------------------------------------------------

function controlledErrorText(code: number): string {
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
interface InFlight {
  readonly requestId: string;
  readonly kind: "init" | "resync" | "page";
}

export class SubscribeClient {
  private socket: WebSocketLike | null = null;
  private snapshot: SessionDetailSnapshot = INITIAL;
  private readonly listeners = new Set<() => void>();
  /** R3 不可逆停止位：close() 置位后一切回调零副作用、connect() 永久拒绝、重复 close 幂等。 */
  private stopped = false;
  private reqCounter = 0;
  /** 在途 subscribe 家族请求（unsubscribe 无回包帧，不入此列）。 */
  private inflight: InFlight | null = null;
  /** welcome 前排队的初始化订阅目标（welcome 后自动发出——同 ws-client welcome→list-sessions 模式）。 */
  private queuedFile: string | null = null;
  /** 活动订阅 id（帧路由：events/status/resync-required 仅活动订阅受理）。 */
  private activeSub: SubscriptionId | null = null;
  /** 已退役订阅（同 file 新订阅替换/退订/终局后）：其帧一律忽略——旧流不得再进快照。 */
  private readonly retiredSubs = new Set<SubscriptionId>();
  /** history 幂等去重（seq 域；重发页/重放帧吸收）。只去重、不检测缺号——不校验 refSeq/seq 连续性；
   * 连续性依赖服务端每订阅有序队列（§3.6 出帧串行化），这是当前边界，不宣称已实现缺口检测。 */
  private readonly seenSeqs = new Set<number>();
  /** live 幂等去重：liveSeq=服务端按批内事件数推进的批末序号（liveBatch.length，非「帧号+1」）；
   * ≤last 视为重复/回退帧吸收——同样不据此做缺口检测。 */
  private lastLiveSeq: number | null = null;
  /** B2 已取消建订请求（init/resync）关联记录：其迟到首页只用于识别服务端已建立的订阅并补发 unsubscribe。
   * 上限 32 条 FIFO（防长期翻动 file 无界增长；续页请求不新建服务端订阅，不入此表）。 */
  private readonly canceledInits = new Map<string, true>();
  /** C2 当前快照实例绑定（首页落地时建立；退订/终局/换订即清）：续页帧四元组一致性校验基准。 */
  private pageBinding: { readonly snapshotId: string; readonly streamId: string; readonly barrier: number } | null = null;

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
      this.failConn("transport", "连接创建失败：无法建立 WebSocket 连接");
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.stopped || this.snapshot.connState !== "connecting") return; // 迟到/重复 open 不复活状态、不重发 hello
      this.sendFrame({ t: "hello", protocolVersion: 1, token: this.token });
      this.transition({ connState: "authenticating" });
    };
    socket.onmessage = (event) => this.onMessage(event.data);
    socket.onerror = () => {
      if (this.stopped) return; // ws 语义：error 后必跟 close；状态迁移归 onClose 统一出口
    };
    socket.onclose = (event) => this.onClose(event.code);
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
      this.failSubscribe("文件名非法，无法订阅");
      return;
    }
    // 显式退旧：活动订阅先发退订帧（§3.6 c5 B01：新 subscribe 先退旧）；本地退役使旧流帧此后一律忽略
    this.retireActiveSubscription(true);
    this.cancelInitRequest(); // B2：被作废的建订在途留痕——迟到首页用于识别并补发退订（不写当前快照）
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
      errorKind: null,
      errorMessage: null,
      streamNote: null,
    });
    if (this.snapshot.connState === "ready") this.beginSubscription(file);
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
    this.retireActiveSubscription(false);
    this.cancelInitRequest(); // B2：此处正常无在途（终局态已清），防御性留痕
    this.lastLiveSeq = null;
    const requestId = this.newRequestId("sub");
    this.inflight = { requestId, kind: "resync" };
    this.transition({ phase: "subscribing", liveEvents: [], streamNote: null });
    this.sendFrame({ t: "subscribe", requestId, file, cursor }); // cursor 严格透传服务端值
  }

  /** 主动退订：发 unsubscribe 帧并本地退役；快照数据保留（视图呈「已取消订阅」），相位回 idle。 */
  unsubscribeSession(): void {
    if (this.stopped) return;
    this.queuedFile = null;
    this.cancelInitRequest(); // B2：首包前退订——建订在途留痕，迟到首页只补退订不落快照
    this.retireActiveSubscription(true);
    this.transition({ phase: "idle", cursor: null, streamNote: null, errorKind: null, errorMessage: null });
  }

  /**
   * 主动关闭：立即置不可逆停止位并物理释放 socket（未 connect/connecting/error 均可关）。
   * error 态保留具体错误文案（不降级为 closed）；停止位置位后清在途/排队、迟到回调零副作用、重复 close 幂等。
   */
  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.inflight = null;
    this.queuedFile = null;
    this.canceledInits.clear(); // 终态：连接关闭即服务端释放订阅，无需留痕
    if (this.snapshot.connState !== "closed" && this.snapshot.connState !== "error") {
      this.transition({ connState: "closed" });
    }
    this.socket?.close();
  }

  /** 订阅快照变更（useSyncExternalStore 直接对齐）；返回退订函数。 */
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

  private newRequestId(prefix: string): string {
    this.reqCounter += 1;
    return `${prefix}-${this.reqCounter}`; // §5.7 requestIdPattern=/^[\w-]{1,64}$/
  }

  private sendFrame(frame: OutgoingFrame): void {
    if (this.stopped) return;
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) return;
    socket.send(JSON.stringify(frame));
  }

  /** 退役活动订阅（本地退役+可选退订帧）；resync 路径不发退订帧（服务端原子终止旧订阅）。 */
  private retireActiveSubscription(sendUnsubscribe: boolean): void {
    const sub = this.activeSub;
    if (sub === null) return;
    this.retiredSubs.add(sub);
    this.activeSub = null;
    this.pageBinding = null; // 实例绑定随订阅退役作废
    if (sendUnsubscribe) {
      this.sendFrame({ t: "unsubscribe", requestId: this.newRequestId("unsub"), subscriptionId: sub });
    }
  }

  /** B2：作废在途建订请求并留痕（init/resync 迟到首页→识别服务端已建订阅并补发 unsubscribe；page 类不留痕——
   *  续页不新建服务端订阅，清理由活动订阅退订路径负责）。表上限 32 条 FIFO 防无界增长。 */
  private cancelInitRequest(): void {
    const inflight = this.inflight;
    this.inflight = null;
    if (inflight === null || inflight.kind === "page") return;
    if (this.canceledInits.size >= 32) {
      const oldest = this.canceledInits.keys().next().value;
      if (oldest !== undefined) this.canceledInits.delete(oldest);
    }
    this.canceledInits.set(inflight.requestId, true);
  }

  /** 发出初始化订阅（排队文件出队或 ready 后直发共用）。 */
  private beginSubscription(file: string): void {
    const requestId = this.newRequestId("sub");
    this.inflight = { requestId, kind: "init" };
    this.transition({ phase: "subscribing" });
    this.sendFrame({ t: "subscribe", requestId, file });
  }

  /** 续页订阅（§3.6 三支之三：subscribe{requestId,file,snapshotId,historyNext}）——snapshot 协议本体自动驱动。 */
  private continuePage(snapshotId: string, historyNext: EventCursor): void {
    const file = this.snapshot.file;
    if (file === null) return;
    const requestId = this.newRequestId("sub");
    this.inflight = { requestId, kind: "page" };
    this.sendFrame({ t: "subscribe", requestId, file, snapshotId, historyNext }); // 游标/snapshotId 严格透传
  }

  // -------------------------------------------------------------------------
  // 内部：消费帧处理
  // -------------------------------------------------------------------------

  private onMessage(data: unknown): void {
    const conn = this.snapshot.connState;
    if (this.stopped || conn === "closed" || conn === "error") return; // 停止屏障/连接终态后不再消费任何帧
    if (typeof data !== "string") return; // 二进制帧非本面
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return; // 畸形 JSON 安全忽略
    }
    if (!isPlainObject(parsed)) return;
    switch (parsed.t) {
      case "welcome": {
        if (conn !== "authenticating") return; // 重复 welcome 幂等忽略
        if (asWelcomeFrame(parsed) === null) return; // R1：缺字段/版本不符=未知帧，不得算握手成功
        this.transition({ connState: "ready" });
        if (this.queuedFile !== null) this.beginSubscription(this.queuedFile); // 排队订阅自动发出
        return;
      }
      case "snapshot":
        this.onSnapshot(parsed);
        return;
      case "events":
        this.onEvents(parsed);
        return;
      case "status": {
        const frame = asStatusFrame(parsed);
        if (frame === null) return; // R1：畸形整帧忽略
        if (this.activeSub === null || frame.subscriptionId !== this.activeSub) return;
        // 注：statusVersion 回退帧当前不拒绝（无版本门）——有序传输前提下的已知边界，不宣称已防乱序。
        this.transition({ status: frame.status });
        return;
      }
      case "resync-required":
        this.onResyncRequired(parsed);
        return;
      case "error":
        this.onError(parsed);
        return;
      default:
        // 未知/暂不消费的帧（sessions/recovery/pong/write-ack/write-stop-ack 及任何陌生 t）安全忽略
        return;
    }
  }

  private onSnapshot(v: Record<string, unknown>): void {
    const frame = asSnapshotFrame(v);
    if (frame === null) return; // R1：坏帧零副作用——不污染快照、不消费在途请求，可续收合法帧
    if (this.canceledInits.delete(frame.requestId)) {
      // B2 已取消建订请求的迟到首页：服务端已建立该订阅——仅识别+补发退订；不写当前快照、
      // 不清当前在途/活动订阅/实例绑定（迟到页先过 R1 形状门：畸形迟到页仍按未知帧零副作用处理）。
      this.retiredSubs.add(frame.subscriptionId);
      this.sendFrame({ t: "unsubscribe", requestId: this.newRequestId("unsub"), subscriptionId: frame.subscriptionId });
      return;
    }
    const inflight = this.inflight;
    if (inflight === null || frame.requestId !== inflight.requestId) return; // 迟到页/无关请求忽略
    if (inflight.kind === "page") {
      // C2 续页实例绑定：subscriptionId/snapshotId/streamId/barrier 必须与当前快照实例一致——
      // 不一致整帧拒绝（不消费在途；绑定一致的续页/重发仍可续读）。
      const binding = this.pageBinding;
      if (
        binding === null || this.activeSub === null || frame.subscriptionId !== this.activeSub ||
        frame.snapshotId !== binding.snapshotId || frame.streamId !== binding.streamId || frame.barrier !== binding.barrier
      ) {
        return;
      }
    }
    this.inflight = null;
    this.activeSub = frame.subscriptionId;
    if (inflight.kind !== "page") {
      this.pageBinding = { snapshotId: frame.snapshotId, streamId: frame.streamId, barrier: frame.barrier };
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
      this.continuePage(frame.snapshotId, frame.historyNext);
      return;
    }
    // 末页：历史读完→live（自动接持续投递，无需发帧；liveFrom=续读起点，严格服务端值）
    const liveFrom = frame.liveFrom; // asSnapshotFrame 保证非 null
    this.transition({
      events,
      status: frame.status,
      subscriptionId: frame.subscriptionId,
      cursor: liveFrom,
      phase: "live",
    });
  }

  private onEvents(v: Record<string, unknown>): void {
    if (this.activeSub === null) return;
    if (v.origin === "history") {
      const frame = asHistoryEventsFrame(v);
      if (frame === null) return; // R1：畸形整帧忽略
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
      const frame = asLiveEventsFrame(v);
      if (frame === null) return;
      if (frame.subscriptionId !== this.activeSub) return;
      if (this.lastLiveSeq !== null && frame.liveSeq <= this.lastLiveSeq) return; // liveSeq 幂等（批末序≤last 即重复/回退帧；不做缺口检测）
      this.lastLiveSeq = frame.liveSeq;
      if (frame.events.length > 0) this.transition({ liveEvents: [...this.snapshot.liveEvents, ...frame.events] });
      return;
    }
    // 未知 origin 忽略
  }

  private onResyncRequired(v: Record<string, unknown>): void {
    const frame = asResyncRequiredFrame(v);
    if (frame === null) return;
    if (this.activeSub === null || frame.subscriptionId !== this.activeSub) return; // 已退役订阅的替换通知忽略
    if (frame.reason === "stream-replaced") {
      // 活动订阅被新订阅替换（本客户端发起的替换已先行退役——此为服务端迟到通知或外部替换）
      this.retiredSubs.add(frame.subscriptionId);
      this.activeSub = null;
      this.pageBinding = null;
      this.inflight = null;
      this.transition({ phase: "closed", subscriptionId: null, streamNote: "订阅已被新订阅替换，旧流已停止" });
      return;
    }
    // server-side-gap：服务端缺口——无自动重同步（用户显式续读）；快照与 cursor 保留
    this.inflight = null;
    this.transition({ phase: "resync-needed", streamNote: "检测到服务端事件缺口，需要重新同步后继续" });
  }

  private onError(v: Record<string, unknown>): void {
    const frame = asErrorFrame(v);
    if (frame === null) return; // R1：畸形 error 帧（未知码/message 缺失等）整帧忽略
    if (frame.code === 4401) {
      this.failConn("auth-failed", controlledErrorText(4401));
      return;
    }
    const conn = this.snapshot.connState;
    if (conn === "connecting" || conn === "authenticating") {
      this.failConn("handshake-failed", controlledErrorText(frame.code));
      return;
    }
    // K3-B1 身份优先路由（§3.6 修订）：带 subscriptionId=流终局通知——先于一切请求级匹配。
    // 终局是【流】的事件：requestId 恒空串（asErrorFrame 已验形），不冒充任何在途请求失败；
    // 也不解析 message 文本里的 id（如 stream-replaced:sub-x）——只按结构化字段路由。
    if (frame.subscriptionId !== undefined) {
      this.onStreamTerminal(frame.subscriptionId, frame.code);
      return;
    }
    // 向后兼容（df0e576 前旧信封：终局无 subscriptionId、requestId 空串/缺省）：空 requestId 的
    // 4409/4431/4402 按当前活动流终局处理——本面单 file 至多一个活动订阅，按 code+空 requestId 归属无歧义；
    // 无活动订阅则忽略（零副作用）。连接级发送队列超限的 4431 同形（connection-queue），但服务端随后必
    // close(4431)——connState 由 onClose 覆盖为 closed，本分支的流终局相位不致误呈「连接可用」。
    if (
      (frame.code === 4409 || frame.code === 4431 || frame.code === 4402) &&
      (frame.requestId === undefined || frame.requestId === "")
    ) {
      if (this.activeSub !== null) this.onStreamTerminal(this.activeSub, frame.code);
      return;
    }
    const inflight = this.inflight;
    if (inflight !== null && frame.requestId === inflight.requestId) {
      this.inflight = null;
      if (frame.code === 4409 && (inflight.kind === "page" || inflight.kind === "resync") && this.snapshot.cursor !== null) {
        // 续页/重同步请求收 4409（契约场景之一=末页 60s 宽限失效后的尾页重试：快照资源已释放、streamId 仍有效）：
        // 置 resync-needed 保留 events+cursor，等待用户显式续读（无自动重发）。注（C1 口径）：快照续页 60s 宽限的
        // 真实轨迹未在前端测试验证（客户端无尾页重试公共入口）；已验路径=重同步 cursor 请求收 4409 后可手动再试。
        this.transition({ phase: "resync-needed", streamNote: controlledErrorText(4409) });
        return;
      }
      // 其余请求级失败（4402/4404 在途重复/4413/4429…）：订阅请求终局，受控文案；连接保持可再订阅
      this.failSubscribe(controlledErrorText(frame.code));
      return;
    }
    // C5：ready 后无 requestId 关联的连接级错误码进连接级失败映射（受控文案按 code——4432 心跳原因不丢）。
    // 关联判定口径：undefined 或空串""——空串是服务端 errFrame 对「不关联任何请求」的统一惯例
    // （ws-gateway 对 4403/4405/4432 等连接级码一律发 requestId:""，非缺省）。
    // 边界：4413/4429 契约定为请求级，无关联时不升级为连接级；空 requestId 的 4409/4431/4402 已由上方
    // K3-B1 终局分支（结构化/旧信封兼容，同样认 undefined|""）接走，此处不再重叠接 4431。
    if (
      (frame.requestId === undefined || frame.requestId === "") &&
      (frame.code === 4403 || frame.code === 4405 || frame.code === 4432)
    ) {
      this.failConn("transport", controlledErrorText(frame.code));
      return;
    }
    // 其余无关联请求/订阅的 error 帧安全忽略
  }

  /**
   * K3-B1 流终局路由（结构化身份）：sub=所停流；code 决定终局相位——4409=续读终局（快照+cursor 保留，
   * 等用户显式续读）；4431 订阅积压/4402 流终局容量出口=订阅终局 closed（内容保留，视图呈 stopped 横幅）。
   * 非活动流（未知/已退役——含本地先行退役的换流旧流）一律忽略：终局不得误伤同 file 新快照请求（K3 P1）。
   * 清理不触碰 canceledInits（B2：迟到首页补退订义务不因终局豁免——服务端可能仍为已取消建订建了订阅）；
   * 也不发退订帧——终局即服务端已停该流，退订属冗余写。
   */
  private onStreamTerminal(sub: SubscriptionId, code: ErrorCode): void {
    if (this.activeSub === null || sub !== this.activeSub) return;
    this.retiredSubs.add(sub);
    this.activeSub = null;
    this.pageBinding = null;
    this.inflight = null; // 该流在途请求不再期待回包——清理属流终局，不置请求失败文案（新信封不指认请求）
    if (code === 4409) {
      this.transition({ phase: "resync-needed", streamNote: controlledErrorText(4409) });
      return;
    }
    this.transition({ phase: "closed", errorKind: "stream-terminal", errorMessage: controlledErrorText(code) });
  }

  private onClose(code: number): void {
    if (this.stopped) return; // 停止屏障：close() 后迟到关闭事件零副作用
    const conn = this.snapshot.connState;
    if (conn === "closed" || conn === "error") return; // auth-failed/handshake-failed 不降级
    if (code === 1008 && (conn === "connecting" || conn === "authenticating")) {
      this.failConn("auth-failed", "认证失败（连接被 1008 关闭）");
      return;
    }
    this.inflight = null; // C5：与 failConn 归一——连接终态清在途/排队，迟到回包不再有归属
    this.queuedFile = null;
    this.transition({ connState: "closed" }); // 连接终态；无自动重连
  }

  /** 连接级错误出口：清在途/排队（迟到回包不再变更快照）+受控文案进快照。 */
  private failConn(errorKind: DetailErrorKind, errorMessage: string): void {
    this.inflight = null;
    this.queuedFile = null;
    this.transition({ connState: "error", errorKind, errorMessage });
  }

  /** 订阅请求失败出口：不作废连接（连接与其余订阅面保持），订阅相位终局+受控文案。
   * B2：被丢弃的建订在途留痕（迟到首页→补退订）；本地终局的活动订阅补发退订帧（服务端资源不残留）。 */
  private failSubscribe(errorMessage: string): void {
    this.cancelInitRequest();
    this.retireActiveSubscription(true);
    this.transition({ phase: "closed", errorKind: "subscribe-failed", errorMessage, streamNote: null });
  }

  private transition(patch: Partial<SessionDetailSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}

/** 组件/hook 所需客户端面（subscribe/getSnapshot 对齐 useSyncExternalStore；其余为订阅生命周期动作）。 */
export type SubscribeClientSurface = Pick<
  SubscribeClient,
  "subscribe" | "getSnapshot" | "subscribeSession" | "unsubscribeSession" | "resyncFromCursor"
>;
