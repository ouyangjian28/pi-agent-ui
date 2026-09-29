// ②WS/UI 只读面共享契约 v1.2 — 类型与运行时校验单源（c3 冻结门第 4 步）。
// 零 node 依赖（浏览器安全）。语义权威=docs/ws-ui-contracts-v1.md；语义变更=协议版本+1 双方审记。
// 注意：TS1024——interface 方法签名禁 readonly 前缀。

// ---------------------------------------------------------------------------
// 限额常量（§5.7 逐字段表；contracts.ts=冻结源）
// ---------------------------------------------------------------------------
export const LIMITS = {
  /** 信封预留（快照/events 帧固定字段+JSON 结构开销；C5-03 整帧预算域） */
  envelopeOverheadBytes: 256,
  /** 订阅内部积压上限（paging 缓冲+live outbox 合计；C5-04 慢客户端门） */
  subscriptionBacklogMax: 1_024,
  subscriptionBacklogBytes: 262_144,
  frameMaxBytes: 262_144,
  /** 3b-1 传输接收硬门（GPT 3b-0 对齐裁定）：ws maxPayload=1MiB 重组兜底——超限由接收器 close 1009（可无应用 error 帧；契约例外条款见 docs/ws-ui-contracts-v1.md §5.1/§5.3）。262,145B..1MiB 的合法重组文本仍归网关 4404 门（应用上限不变）。 */
  transportMaxPayloadBytes: 1_048_576,
  pageMaxEvents: 200,
  pageFrameBudgetBytes: 200_000,
  singleEventBytes: 32_768,
  connQueueFrames: 1024,
  connQueueBytes: 1_048_576,
  socketBufferedBytes: 4_194_304,
  subscriptionsPerConn: 8,
  connectionsPerServer: 16,
  inFlightRequestsPerConn: 4,
  computeConcurrency: 2,
  computeQueueTimeoutMs: 5_000,
  listPageSizeMax: 200,
  listPageSizeDefault: 50,
  listDirScanMax: 1000,
  recoveryReadMaxBytes: 8_388_608,
  recoveryPageSize: 500,
  heartbeatSuggestMs: 30_000,
  heartbeatTimeoutMs: 90_000,
  connectionLifetimeMs: 86_400_000,
  streamLruStreams: 32,
  streamLruEvents: 20_000,
  snapshotTailGraceMs: 60_000,
  snapshotBufferMax: 1024,
  liveFramesPerDrain: 16,
  maxEventsPerLiveFrame: 7,   // 7×32k=229,376B + 信封预留 256B < 262,144B（C5-03：严格小于且留信封余量；旧值 8×32k=262,144 恰等上限不严格）
  filePattern: /^[\w.-]{1,114}\.jsonl$/,
  requestIdPattern: /^[\w-]{1,64}$/,
  /** resume.intentId 形态（r3a P2-2/K3 审）：真实形态=i-<十进制>（rpc-session intentSeq）；
   *  \w 集禁换行/引号/空格——审计行拼接面防注入，对齐 requestId 风格。 */
  intentIdPattern: /^[\w-]{1,64}$/,
  /** M-OPS（v1.4）：prompt.model 形态——只收精确模型 id（provider/id 及 thinking 后缀），
   *  非 glob pattern；K3 实测 39/39 现役 id 全过。 */
  modelPattern: /^[\w./:-]{1,128}$/,
  idPattern: /^[\w:.-]{1,128}$/,
  toolNamePattern: /^[\w:.-]{1,64}$/,
  titleLimit: 80,
  previewLimitTurn: 200,
  previewLimitMessage: 500,
  noteLimit: 120,
} as const;

export type ErrorCode = 4401 | 4402 | 4403 | 4404 | 4405 | 4409 | 4413 | 4414 | 4429 | 4431 | 4432;

/** 写类帧 t 集合（§5.3 第 4 级；冻结枚举） */
export const WRITE_FRAME_TYPES: readonly string[] = ["prompt", "send", "stop", "resume", "takeover", "write", "execute", "spawn", "kill"];

// ---------------------------------------------------------------------------
// 基础值对象
// ---------------------------------------------------------------------------
export interface SanitizedText { readonly text: string; readonly truncated: boolean; }

export type StreamId = string;       // base64url(16B)
export type SubscriptionId = string; // 连接内唯一
export type StatusVersion = number;

export interface EventCursor { readonly streamId: StreamId; readonly seq: number; }

export interface SessionRef {
  readonly sessionId: string | null;
  readonly file: string;
  readonly adapterSessionId: string | null;
}

// ---------------------------------------------------------------------------
// 组2 状态语义
// ---------------------------------------------------------------------------
export type TurnState =
  | { readonly state: "idle" }
  | { readonly state: "dispatching"; readonly intentId: string }
  | { readonly state: "in-flight"; readonly intentId: string }
  | { readonly state: "settling"; readonly intentId: string }
  | { readonly state: "closed"; readonly reason: "durability-failure" | "turn-timeout" | "buffer-overflow" | "manual" | "generation-retired" };

export type StartResult =
  | { readonly kind: "ready"; readonly generation: number }
  | { readonly kind: "superseded"; readonly generation: number }
  | { readonly kind: "readiness-timeout"; readonly generation: number }
  | { readonly kind: "spawn-failed"; readonly generation: null }
  | { readonly kind: "spawn-exited"; readonly generation: number };

export interface StopResult { readonly kind: "confirmed" | "deadline-exceeded"; readonly atMs: number; }

export interface ProcessState {
  readonly phase: "idle" | "running" | "stopping";
  readonly generation: number | null;
  readonly lastStartResult: StartResult | null;
  readonly lastStopResult: StopResult | null;
  readonly ready: boolean;
}

export interface BackgroundTasksState {
  readonly availability: "known" | "unknown";
  readonly activeCount: number | null;
}

export interface ReapState {
  readonly eligible: boolean;
  readonly idleElapsedMs: number | null;
  readonly idleRemainingMs: number | null;
  readonly idleMs: number;
}

export interface RecoverySummary {
  readonly availability: "available" | "unavailable";
  readonly resumeBlocked: boolean | null;
  readonly diskBlocked: boolean | null;
  readonly unknownEffectCount: number | null;
  readonly unattributableFragments: number | null;
  readonly intentsCount: number | null;
  readonly settledCount: number | null;
  readonly evidenceHash: string | null;
}

export interface SessionStatus {
  readonly session: SessionRef;
  readonly process: ProcessState;
  readonly turn: TurnState;
  readonly backgroundTasks: BackgroundTasksState;
  readonly reap: ReapState;
  readonly recovery: RecoverySummary;
  readonly statusVersion: StatusVersion;
  readonly serverTimeMs: number;
}

// ---------------------------------------------------------------------------
// 组3 事件
// ---------------------------------------------------------------------------
export interface HistoryEventBase {
  readonly seq: number;
  readonly ts: number | null;
  readonly generation: number | null;
  readonly intentId: string | null;
}

export type HistoryEventKind =
  | "turn-enqueued" | "sending" | "turn-engaged" | "turn-consumed" | "turn-cancelled"
  | "verdict-delivered" | "verdict-settled" | "verdict-unknown" | "response-timeout" | "clear"
  | "message" | "corrupt-entry" | "unknown-line" | "journal-corrupt" | "journal-repair";

export type HistoryEvent = HistoryEventBase & (
  | { readonly kind: "turn-enqueued"; readonly preview: SanitizedText; readonly ordinal: number }
  | { readonly kind: "sending" } | { readonly kind: "turn-engaged" } | { readonly kind: "turn-consumed" }
  | { readonly kind: "turn-cancelled" } | { readonly kind: "verdict-delivered" } | { readonly kind: "verdict-settled" }
  | { readonly kind: "verdict-unknown" } | { readonly kind: "unknown-line" } | { readonly kind: "journal-corrupt" }
  | { readonly kind: "response-timeout"; readonly commandId: number }
  | { readonly kind: "journal-repair"; readonly repairReason: "torn-tail"; readonly repairByteStart: number; readonly repairByteEnd: number }
  | { readonly kind: "clear"; readonly clearedCount: number }
  | { readonly kind: "corrupt-entry"; readonly entryId: string }
  | { readonly kind: "message";
      readonly entryId: string; readonly blockIndex?: number;
      readonly role: "user" | "assistant" | "toolCall" | "toolResult" | "system";
      readonly textPreview?: SanitizedText;
      readonly stopReason?: "stop" | "length" | "aborted" | "toolUse";
      readonly toolCallId?: string;
      /** D4（§4.1a/§4.4）：仅门开（thinkingVisible）且 thinkingCount>0 时携带（存在性不泄露——门关不置）。
       *  唯一产生位=扫描面 sessionToScanRows；事件面与展开面同源同值。 */
      readonly hasThinking?: true;
      /** D4：可见块数（text+toolCall+attachment，不含 thinking；toolCall 子事件与本体同值）。 */
      readonly blockCount?: number;
      readonly final: boolean }
);

export type PiEventType =
  | "agent_start" | "turn_start" | "message_start" | "message_update" | "message_end"
  | "turn_end" | "agent_end" | "agent_settled";

export type ProgressNote = "thinking" | "tool-start" | "tool-end" | "compacting" | "message-start" | "message-end";

export type LiveEvent =
  | { readonly kind: "pi-progress"; readonly piType: PiEventType; readonly note: ProgressNote }
  | { readonly kind: "turn-state"; readonly statusVersion: StatusVersion; readonly turn: TurnState }
  | { readonly kind: "process-note"; readonly phase: "running" | "stopping" }
  // D1 直播面（docs/d1-live-stream-design.md §2）：pi 回复增量透传。安全面：只透 assistant 正文
  // （user 已知/system 含系统提示不外泄）；thinking 缺省不透（opts 开关，见 live-aggregator）。
  | { readonly kind: "message-delta"; readonly part: "text" | "thinking";
      readonly contentIndex: number; readonly delta: string } // 节流窗内同段增量合并
  | { readonly kind: "message-part-end"; readonly part: "text" | "thinking";
      readonly contentIndex: number } // 段闭（text_end/thinking_end；即时 flush 锚）
  | { readonly kind: "message-final"; readonly role: "assistant";
      readonly text: string } // message_end 终局全文（漂移校准/断线补齐；只 assistant）
  // D3 扩展问答（docs/d3-ui-passthrough-design.md §3.2）：扩展 notify 即显通知进耐久流（重放无害）。
  | { readonly kind: "ui-note"; readonly notifyType: "info" | "warning" | "error"; readonly message: string };

// ---------------------------------------------------------------------------
// 组3.6 快照
// ---------------------------------------------------------------------------
export interface SnapshotFrame {
  readonly requestId: string;
  readonly subscriptionId: SubscriptionId;
  readonly streamId: StreamId;
  readonly snapshotId: string;
  readonly barrier: number;
  readonly status: SessionStatus;
  readonly page: readonly HistoryEvent[];
  readonly historyNext: EventCursor | null;
  readonly liveFrom: EventCursor | null;
  readonly hasMore: boolean;
}

// ---------------------------------------------------------------------------
// 组4 恢复
// ---------------------------------------------------------------------------
export interface PageOf<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly returned: number;
  readonly truncated: boolean;
  readonly next: { readonly offset: number } | null;
}

export type RecoveryBlockReason =
  | { readonly kind: "bad-line"; readonly count: number }
  | { readonly kind: "torn-tail" }
  | { readonly kind: "short-fragment"; readonly count: number }
  | { readonly kind: "unattributable-fragment"; readonly count: number };

export interface RecoveryIntentRow {
  readonly intentId: string;
  readonly verdict: "settled" | "delivered" | "unknown" | "cancelled" | "not-evaluated";
  readonly provisional: boolean;
}

export interface AvailableRecovery {
  readonly availability: "available";
  readonly evidenceHash: string;
  readonly resumeBlocked: boolean;
  readonly diskBlocked: boolean;
  readonly blockedReasons: readonly RecoveryBlockReason[];
  readonly unknownEffect: PageOf<string>;
  readonly resumable: PageOf<string>;
  readonly perIntent: PageOf<RecoveryIntentRow>;
}

export interface UnavailableRecovery {
  readonly availability: "unavailable";
  /** no-evidence-snapshot（B03）：盘面曾修复且无权威证据快照——不得以裸读盘面出恢复结论（防洗白）。 */
  readonly reason: "read-failed" | "concurrent-modification" | "oversized" | "no-evidence-snapshot";
}

export type RecoveryInfo = AvailableRecovery | UnavailableRecovery;

// ---------------------------------------------------------------------------
// 组5 帧
// ---------------------------------------------------------------------------
export type SubscribeFrame =
  | { readonly t: "subscribe"; readonly requestId: string; readonly file: string }
  | { readonly t: "subscribe"; readonly requestId: string; readonly file: string; readonly cursor: EventCursor }
  | { readonly t: "subscribe"; readonly requestId: string; readonly file: string; readonly snapshotId: string; readonly historyNext: EventCursor };

export type ClientFrame =
  | { readonly t: "hello"; readonly protocolVersion: 1; readonly token?: string }
  | { readonly t: "list-sessions"; readonly requestId: string; readonly offset?: number; readonly limit?: number }
  | SubscribeFrame
  | { readonly t: "unsubscribe"; readonly requestId: string; readonly subscriptionId: SubscriptionId }
  | { readonly t: "get-recovery"; readonly requestId: string; readonly file: string; readonly offset?: number; readonly evidenceHash?: string }
  | { readonly t: "ping"; readonly nonce: string }
  | { readonly t: "get-models"; readonly requestId: string } // v1.4（M-OPS）：模型清单请求（挂 list 连接）
  | UiAnswerFrame
  | EntryGetFrame;

export type ResyncReason = "server-side-gap" | "stream-replaced";

// ---------------------------------------------------------------------------
// D3 扩展问答帧（docs/d3-ui-passthrough-design.md §3，契约 v1.2）：pi 进程内扩展提问透传。
// 对话族=瞬态请求/响应（不进耐久事件流；ui-request 广播给当前订阅该 file 的活跃连接）；
// 即显族 notify 走 LiveEvent ui-note；setStatus 等四法 v1 不透传（审计 ui-unsupported）。
// ---------------------------------------------------------------------------
export type UiRequestMethod = "select" | "confirm" | "input" | "editor";

/** S→C：对话族提问（瞬态广播）。requestId=pi extension_ui_request.id 原样透传（绑定与校验键）。 */
export interface UiRequestFrame {
  readonly t: "ui-request";
  readonly requestId: string;
  readonly file: string;
  readonly method: UiRequestMethod;
  readonly title?: string;
  readonly options?: readonly string[]; // select
  readonly message?: string; // confirm 正文
  readonly placeholder?: string; // input
  readonly prefill?: string; // editor
  readonly timeoutMs?: number; // pi 声明 timeout(ms)；仅展示提示，宿主不据此作答（pi 侧自答后晚答照转、pi 忽略过期 id）
}

/** 作废因：进程换代=process-retired；派发时零订阅=no-subscriber；pending 超 8=overflow；任一订阅者已答=answered（其余订阅者撤框；答案胜出者不再另发确认帧）。 */
export type UiClosedReason = "process-retired" | "no-subscriber" | "overflow" | "answered";

/** S→C：提问作废通知（UI 撤对话框；UI 按 requestId 幂等撤框，reason 仅展示/诊断）。 */
export interface UiClosedFrame {
  readonly t: "ui-closed";
  readonly requestId: string;
  readonly reason: UiClosedReason;
}

/** C→S：答案。字段互斥且恰其一（零枝即 4404）；方法级校验在网关侧带上下文执行：select→value∈options，confirm→confirmed，input/editor→value；任一方法可 cancelled。 */
export interface UiAnswerFrame {
  readonly t: "ui-answer";
  readonly requestId: string;
  readonly value?: string;
  readonly confirmed?: boolean;
  readonly cancelled?: true;
}

// ---------------------------------------------------------------------------
// D4 全文读面帧（docs/d4-fulltext-design.md v5.1，契约冻结 2026-10-10）：历史条目按需取全文。
// ---------------------------------------------------------------------------
/** D4：C→S 全文请求（只读）。file=逻辑名（订阅口径）；entryId=session 源条目 id（journal 无展开面）。 */
export interface EntryGetFrame {
  readonly t: "entry-get";
  readonly requestId: string;
  readonly file: string;
  readonly entryId: string;
}

/** D4：全文块四形（entryBlocksOf 投影输出/entry 帧载荷）。truncatedAt=可见文本内代码单元切位
 *  （与 SESSION_PREVIEW_LIMIT 同口径）；argsPreview 已过 denylist 净化+512 编码后字节限。 */
export type EntryBlock =
  | { readonly kind: "text"; readonly text: string; readonly truncatedAt?: number }
  | { readonly kind: "thinking"; readonly text: string; readonly truncatedAt?: number }
  | { readonly kind: "toolCall"; readonly toolCallId: string | null; readonly toolName: string | null; readonly argsPreview: string; readonly argsTruncated?: true }
  | { readonly kind: "attachment"; readonly attachmentId: string };

/** D4：4414 reason 载体（六值）。retryable 档位：stale/in-flight=true，余 false。 */
export type EntryErrorReason = "stale" | "unknown-entry" | "oversized" | "index-evicted" | "not-subscribed" | "in-flight";

/** D4：S→C 全文响应。state 仅 ok/truncated（oversized 归 4414 错误面，成功帧永无 oversized 态）；
 *  rawBytes 仅 ok 态携带（truncated 帧 wire 级缺席——v5.1 P2-N1'）；totalBlockCount=可见块总口径。 */
export interface EntryFrame {
  readonly t: "entry";
  readonly requestId: string;
  readonly entryId: string;
  readonly source: "session";
  readonly digest: string;
  readonly state: "ok" | "truncated";
  readonly blocks: readonly EntryBlock[];
  readonly stopReason?: "stop" | "length" | "aborted" | "toolUse";
  readonly rawBytes?: number;
  readonly totalBlockCount?: number;
}

// ---------------------------------------------------------------------------
// M-OPS 模型清单帧（docs/m-ops-design.md §3，契约 v1.4）：数据源=pi --list-models（进程内缓存）。
// ---------------------------------------------------------------------------
/** v1.4：单个模型条目（provider/id 必具；context/thinking 为清单列可选透传）。 */
export interface ModelInfoDTO {
  readonly provider: string;
  readonly id: string;
  readonly context?: string;
  readonly thinking?: string;
}

/** v1.4：S→C 模型清单响应。失败→空表+cause（不新设错误码——K3 核实闭码面不涉）。 */
export interface ModelsListFrame {
  readonly t: "models-list";
  readonly requestId: string;
  readonly models: readonly ModelInfoDTO[];
  readonly cause?: string;
}

export type ServerFrame =
  | { readonly t: "welcome"; readonly serverBootId: string; readonly serverBuildId: string; readonly protocolVersion: 1 }
  | { readonly t: "sessions"; readonly requestId: string; readonly sessions: readonly SessionSummaryDTO[]; readonly total: number; readonly offset: number; readonly hasMore: boolean; readonly listVersion: number;
      /** 页级可靠性（c6 C5-07）：本页含任一条目 partial→partial；条目级仍见 SessionSummaryDTO.listReliability */
      readonly listReliability: "full" | "partial" }
  | ({ readonly t: "snapshot" } & SnapshotFrame)
  | { readonly t: "events"; readonly subscriptionId: SubscriptionId; readonly origin: "history"; readonly refSeq: number; readonly events: readonly HistoryEvent[] }
  | { readonly t: "events"; readonly subscriptionId: SubscriptionId; readonly origin: "live"; readonly liveSeq: number; readonly refSeq: null; readonly events: readonly LiveEvent[] }
  | { readonly t: "status"; readonly subscriptionId: SubscriptionId; readonly status: SessionStatus }
  | ({ readonly t: "recovery"; readonly requestId: string; readonly file: string } & RecoveryInfo)
  | { readonly t: "resync-required"; readonly subscriptionId: SubscriptionId; readonly reason: ResyncReason }
  | { readonly t: "error"; readonly code: ErrorCode; readonly message: string; readonly retryable: boolean; readonly requestId?: string; readonly subscriptionId?: SubscriptionId;
      /** D4：4414 专用 reason 载体（六值；其余码缺省）。 */
      readonly reason?: EntryErrorReason }
  | { readonly t: "pong"; readonly nonce: string }
  | { readonly t: "write-ack"; readonly requestId: string; readonly file: string; readonly outcome: WriteSendOutcomeDTO }
  | { readonly t: "write-stop-ack"; readonly requestId: string; readonly file: string; readonly outcome: WriteStopOutcomeDTO }
  | { readonly t: "write-resume-ack"; readonly requestId: string; readonly file: string; readonly outcome: WriteResumeOutcomeDTO } // v1.1（r3a）
  | UiRequestFrame // v1.2（D3）
  | UiClosedFrame
  | EntryFrame // v1.3（D4）
  | ModelsListFrame; // v1.4（M-OPS）

export interface SessionSummaryDTO {
  readonly sessionId: string | null;
  readonly file: string;
  readonly title: SanitizedText;
  readonly lastActiveMs: number | null;
  readonly entryCount: number;
  readonly sizeBytes: number;
  readonly hasRecoveryNotice: boolean;
  readonly listReliability: "full" | "partial";
}

// ---------------------------------------------------------------------------
// 帧字节预估（入队前；§5.6）
// ---------------------------------------------------------------------------
export function estimateFrameBytes(frame: ServerFrame): number {
  try { return byteLength(JSON.stringify(frame)); } catch { return LIMITS.frameMaxBytes + 1; }
}

/** 单事件字节预估（B04 字节装页用；UTF-8） */
export function estimateHistoryEventBytes(ev: HistoryEvent): number {
  try { return byteLength(JSON.stringify(ev)); } catch { return LIMITS.singleEventBytes + 1; }
}

function byteLength(s: string): number {
  // UTF-8 字节数（无需 Buffer；浏览器安全）
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; } // 代理对
    else n += 3;
  }
  return n;
}

// ---------------------------------------------------------------------------
// 运行时校验（strict；§5.3 判别优先级）
// ---------------------------------------------------------------------------
export type FrameCheck =
  | { readonly ok: true; readonly frame: ClientFrame }
  | { readonly ok: false; readonly code: ErrorCode; readonly message: string };

/** 客户端帧校验（判别优先级 §5.3：格式层→版本层→写类层；业务层归 server） */
export function validateClientFrame(raw: unknown): FrameCheck {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad(4404, "帧必须是 JSON 对象");
  const obj = raw as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return bad(4404, "缺少 t");
  const t = obj["t"];
  if (typeof t !== "string") return bad(4404, "t 必须是字符串");
  // 第 4 级（写类）在格式基本可判后立即短路：t 合法字符串+属写类集合→4405（不论其余字段）
  if (WRITE_FRAME_TYPES.includes(t)) return bad(4405, "只读协议拒绝写类帧");
  // 未知 t：固定消息（不回显输入——恶意超长值不得借错误帧透传；c5 B07）
  switch (t) {
    case "hello": {
      const r0 = requireExact(obj, ["t", "protocolVersion", ...extraKeys(obj, ["token"])]); if (r0) return r0;
      const v = obj["protocolVersion"];
      // 版本层：合法整数但 ≠1 → 4403（先于其余字段格式错？§5.3：格式层→版本层→写类层——hello 的 protocolVersion 类型错属格式层）
      if (typeof v !== "number" || !Number.isSafeInteger(v)) return bad(4404, "protocolVersion 必须是安全整数");
      if (v !== 1) return bad(4403, "协议版本不匹配");
      // N4-v2（v1.1）：token 可选——免令牌通道（连接升级面登录会话 cookie 已验）；呈令牌时仍须合法非空。
      let token: string | undefined;
      if (has(obj, "token")) {
        const tk = obj["token"];
        if (typeof tk !== "string" || tk.length === 0 || tk.length > 1024) return bad(4404, "token 非法");
        token = tk;
      }
      return ok({ t: "hello", protocolVersion: 1, ...(token !== undefined ? { token } : {}) });
    }
    case "list-sessions": {
      const r0 = requireExact(obj, ["t", "requestId", ...extraKeys(obj, ["offset", "limit"])]); if (r0) return r0;
      const requestId = reqId(obj); if (!isStr(requestId)) return requestId;
      let offset = 0, limit: number = LIMITS.listPageSizeDefault;
      if (has(obj, "offset")) { const o = obj["offset"]; if (typeof o !== "number" || !Number.isSafeInteger(o) || o < 0) return bad(4404, "offset 非法"); offset = o; }
      if (has(obj, "limit")) { const l = obj["limit"]; if (typeof l !== "number" || !Number.isSafeInteger(l) || l < 1 || l > LIMITS.listPageSizeMax) return bad(4404, "limit 非法"); limit = l; }
      return ok({ t: "list-sessions", requestId, ...(offset !== 0 ? { offset } : {}), ...(limit !== LIMITS.listPageSizeDefault ? { limit } : {}) });
    }
    case "subscribe": {
      const hasCursor = has(obj, "cursor"), hasSnapshot = has(obj, "snapshotId"), hasNext = has(obj, "historyNext");
      if (hasSnapshot !== hasNext) return bad(4404, "snapshotId 与 historyNext 必须同现");
      if (hasSnapshot && hasCursor) return bad(4404, "subscribe 分支参数互斥");
      const r0 = requireExact(obj, ["t", "requestId", "file", ...extraKeys(obj, ["cursor", "snapshotId", "historyNext"])]); if (r0) return r0;
      const requestId = reqId(obj); if (!isStr(requestId)) return requestId;
      const file = fileName(obj); if (!isStr(file)) return file;
      if (hasSnapshot) {
        const sid = obj["snapshotId"];
        if (typeof sid !== "string" || sid.length === 0 || sid.length > 64) return bad(4404, "snapshotId 非法");
        const cur = cursorOf(obj["historyNext"]);
        if (!cur.ok) return bad(4404, "historyNext 非法");
        return ok({ t: "subscribe", requestId, file, snapshotId: sid, historyNext: cur.value });
      }
      if (hasCursor) {
        const cur = cursorOf(obj["cursor"]);
        if (!cur.ok) return bad(4404, "cursor 非法");
        return ok({ t: "subscribe", requestId, file, cursor: cur.value });
      }
      return ok({ t: "subscribe", requestId, file });
    }
    case "unsubscribe": {
      const r0 = requireExact(obj, ["t", "requestId", "subscriptionId"]); if (r0) return r0;
      const requestId = reqId(obj); if (!isStr(requestId)) return requestId;
      const sid = obj["subscriptionId"];
      if (typeof sid !== "string" || sid.length === 0 || sid.length > 64) return bad(4404, "subscriptionId 非法");
      return ok({ t: "unsubscribe", requestId, subscriptionId: sid });
    }
    case "get-recovery": {
      const r0 = requireExact(obj, ["t", "requestId", "file", ...extraKeys(obj, ["offset", "evidenceHash"])]); if (r0) return r0;
      const requestId = reqId(obj); if (!isStr(requestId)) return requestId;
      const file = fileName(obj); if (!isStr(file)) return file;
      let offset: number | undefined;
      if (has(obj, "offset")) { const o = obj["offset"]; if (typeof o !== "number" || !Number.isSafeInteger(o) || o < 0) return bad(4404, "offset 非法"); offset = o; }
      let evidenceHash: string | undefined;
      if (has(obj, "evidenceHash")) { const h = obj["evidenceHash"]; if (typeof h !== "string" || !/^[0-9a-f]{64}$/.test(h)) return bad(4404, "evidenceHash 非法"); evidenceHash = h; }
      return ok({ t: "get-recovery", requestId, file, ...(offset !== undefined ? { offset } : {}), ...(evidenceHash !== undefined ? { evidenceHash } : {}) });
    }
    case "ui-answer": {
      // D3：形状级校验（互斥/恰其一/类型）；方法级（value∈options 等）在网关带 pending 上下文执行。
      const r0 = requireExact(obj, ["t", "requestId", ...extraKeys(obj, ["value", "confirmed", "cancelled"])]); if (r0) return r0;
      const requestId = reqId(obj); if (!isStr(requestId)) return requestId;
      const hasV = has(obj, "value"), hasC = has(obj, "confirmed"), hasX = has(obj, "cancelled");
      if ((hasV ? 1 : 0) + (hasC ? 1 : 0) + (hasX ? 1 : 0) !== 1) return bad(4404, "ui-answer 答案字段互斥且须恰其一");
      if (hasV && typeof obj["value"] !== "string") return bad(4404, "value 必须是字符串");
      if (hasC && typeof obj["confirmed"] !== "boolean") return bad(4404, "confirmed 必须是布尔");
      if (hasX && obj["cancelled"] !== true) return bad(4404, "cancelled 必须为 true");
      return ok({ t: "ui-answer", requestId, ...(hasV ? { value: obj["value"] as string } : {}), ...(hasC ? { confirmed: obj["confirmed"] as boolean } : {}), ...(hasX ? { cancelled: true } : {}) });
    }
    case "entry-get": {
      // D4：形状级校验（四字段恰具；file=订阅口径逻辑名；entryId 非空≤256）。业务层（订阅权/索引命中）归网关。
      const r0 = requireExact(obj, ["t", "requestId", "file", "entryId"]); if (r0) return r0;
      const requestId = reqId(obj); if (!isStr(requestId)) return requestId;
      const file = fileName(obj); if (!isStr(file)) return file;
      const eid = obj["entryId"];
      if (typeof eid !== "string" || eid.length === 0 || eid.length > 256) return bad(4404, "entryId 非法");
      return ok({ t: "entry-get", requestId, file, entryId: eid });
    }
    case "get-models": {
      // v1.4（M-OPS）：两字段恰具；清单拉取/缓存归网关（同步面七处之一，docs/m-ops-design.md §3）。
      const r0 = requireExact(obj, ["t", "requestId"]); if (r0) return r0;
      const requestId = reqId(obj); if (!isStr(requestId)) return requestId;
      return ok({ t: "get-models", requestId });
    }
    case "ping": {
      const r0 = requireExact(obj, ["t", "nonce"]); if (r0) return r0;
      const nonce = obj["nonce"];
      if (typeof nonce !== "string" || nonce.length === 0 || nonce.length > 64) return bad(4404, "nonce 非法");
      return ok({ t: "ping", nonce });
    }
    default:
      return bad(4404, "未知帧类型");
  }
}

// ---------------------------------------------------------------------------
// 内部校验帮手
// ---------------------------------------------------------------------------
function bad(code: ErrorCode, message: string): FrameCheck { return { ok: false, code, message }; }
function ok(frame: ClientFrame): FrameCheck { return { ok: true, frame }; }
function has(obj: Record<string, unknown>, k: string): boolean { return Object.prototype.hasOwnProperty.call(obj, k); }
function extraKeys(obj: Record<string, unknown>, optional: readonly string[]): string[] { return optional.filter((k) => has(obj, k)); }
function isStr(v: string | FrameCheck): v is string { return typeof v === "string"; }
function requireExact(obj: Record<string, unknown>, expected: readonly string[]): FrameCheck | null {
  const got = Object.keys(obj).sort().join(",");
  const want = [...expected].sort().join(",");
  if (got !== want) return bad(4404, `帧字段集合非法（期望 ${want}）`);
  return null;
}
function reqId(obj: Record<string, unknown>): string | FrameCheck {
  const v = obj["requestId"];
  if (typeof v !== "string" || !LIMITS.requestIdPattern.test(v)) return bad(4404, "requestId 非法");
  return v;
}
function fileName(obj: Record<string, unknown>): string | FrameCheck {
  const v = obj["file"];
  if (typeof v !== "string" || !LIMITS.filePattern.test(v)) return bad(4404, "file 非法");
  return v;
}
function cursorOf(raw: unknown): { ok: true; value: EventCursor } | { ok: false } {
  if (typeof raw !== "object" || raw === null) return { ok: false };
  const o = raw as Record<string, unknown>;
  // B01：游标对象必须 exact（多余属性拒绝，不静默丢弃）；seq=下一待读位，合法域 ≥1（0 非法）。
  const keys = Object.keys(o);
  if (keys.length !== 2 || !("streamId" in o) || !("seq" in o)) return { ok: false };
  const sid = o["streamId"], seq = o["seq"];
  if (typeof sid !== "string" || sid.length === 0 || sid.length > 64) return { ok: false };
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) return { ok: false };
  return { ok: true, value: { streamId: sid, seq } };
}

// ---------------------------------------------------------------------------
// 写侧帧（3c-1 扩展片）：仅 prompt/stop 开放；其余写类 t 维持 v1 冻结口径 4405。
// v1 只读部署（网关未接 writeHost）行为不变——写类帧仍一律 4405+close 1008。
// ---------------------------------------------------------------------------
/** 本片开放的写类帧 t（WRITE_FRAME_TYPES 的子集）。 */
export const WRITE_OPEN_FRAME_TYPES: readonly string[] = ["prompt", "stop", "resume"];
/** prompt.text 上限（UTF-8 字节；frameMaxBytes 包络之内的显式域限）。 */
export const WRITE_TEXT_MAX_BYTES = 65_536;

export type WriteClientFrame =
  | { readonly t: "prompt"; readonly requestId: string; readonly file: string; readonly text: string; readonly generation?: number; readonly model?: string } // v1.1 帧身份：可选进程代次（提供则宿主身份门校验活代匹配——v1 客户端缺省跳过）；v1.4（M-OPS）可选模型 id（spawn 尾追 --model 恒胜（禁集拒启：extraPiArgs 携 --model）+sidecar 持久化，优先级 prompt.model>sidecar>pi 默认，docs/m-ops-design.md §3）
  | { readonly t: "stop"; readonly requestId: string; readonly file: string }
  | { readonly t: "resume"; readonly requestId: string; readonly file: string; readonly intentId: string; readonly generation: number }; // v1.1：恢复意图重发（身份门四校验：恢复数据在场/未阻断/授权/代次）

export type WriteFrameCheck =
  | { readonly ok: true; readonly frame: WriteClientFrame }
  | { readonly ok: false; readonly code: ErrorCode; readonly message: string };

/** 写类帧校验（前置：t 已判属 WRITE_FRAME_TYPES 且网关已接写宿主）。
 *  未开放写类 t→4405（v1 冻结口径不变）；字段违反→4404（§5.3 第 2 级同口径：先识别 t 后字段）。 */
export function validateWriteFrame(raw: unknown): WriteFrameCheck {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return badWrite(4404, "帧必须是 JSON 对象");
  const obj = raw as Record<string, unknown>;
  const t = obj["t"];
  if (typeof t !== "string") return badWrite(4404, "t 必须是字符串");
  if (!WRITE_OPEN_FRAME_TYPES.includes(t)) return badWrite(4405, "写类帧未开放");
  if (t === "prompt") {
    // v1.1：generation 为可选域——先从探测副本剥除，再走四字段集合等值（v1 帧仍严格原形）。
    // v1.4（M-OPS）：model 同式可选域（精确 id 非 glob；非空校验走 LIMITS.modelPattern）。
    const probe: Record<string, unknown> = has(obj, "generation") || has(obj, "model") ? { ...obj } : obj;
    if (probe !== obj) { delete probe["generation"]; delete probe["model"]; }
    const r0 = exactWrite(probe, ["t", "requestId", "file", "text"]); if (r0) return r0;
    const rid = ridWrite(obj); if (typeof rid !== "string") return rid;
    const file = fileWrite(obj); if (typeof file !== "string") return file;
    const text = obj["text"];
    if (typeof text !== "string" || text.length === 0) return badWrite(4404, "text 非法");
    if (byteLength(text) > WRITE_TEXT_MAX_BYTES) return badWrite(4404, "text 超字节上限");
    let generation: number | undefined; // v1.1 可选：安全整数；提供则身份门校验
    if (has(obj, "generation")) {
      const g = obj["generation"];
      if (typeof g !== "number" || !Number.isSafeInteger(g) || g < 0) return badWrite(4404, "generation 非法");
      generation = g;
    }
    let model: string | undefined; // v1.4（M-OPS）可选：精确模型 id（LIMITS.modelPattern）
    if (has(obj, "model")) {
      const m = obj["model"];
      if (typeof m !== "string" || !LIMITS.modelPattern.test(m)) return badWrite(4404, "model 非法");
      model = m;
    }
    const extras: { generation?: number; model?: string } = {};
    if (generation !== undefined) extras.generation = generation;
    if (model !== undefined) extras.model = model;
    return okFrame(Object.keys(extras).length === 0 ? { t: "prompt", requestId: rid, file, text } : { t: "prompt", requestId: rid, file, text, ...extras });
  }
  if (t === "resume") {
    const r0 = exactWrite(obj, ["t", "requestId", "file", "intentId", "generation"]); if (r0) return r0;
    const rid = ridWrite(obj); if (typeof rid !== "string") return rid;
    const file = fileWrite(obj); if (typeof file !== "string") return file;
    const intentId = obj["intentId"];
    if (typeof intentId !== "string" || !LIMITS.intentIdPattern.test(intentId)) return badWrite(4404, "intentId 非法");
    const g = obj["generation"];
    if (typeof g !== "number" || !Number.isSafeInteger(g) || g < 0) return badWrite(4404, "generation 非法");
    return okFrame({ t: "resume", requestId: rid, file, intentId, generation: g });
  }
  const r0 = exactWrite(obj, ["t", "requestId", "file"]); if (r0) return r0;
  const rid = ridWrite(obj); if (typeof rid !== "string") return rid;
  const file = fileWrite(obj); if (typeof file !== "string") return file;
  return okFrame({ t: "stop", requestId: rid, file });
}

// 窄类型本地助手（不复用 validateClientFrame 的 FrameCheck 助手：返回联合不同型，避免侵入冻结校验器）
function badWrite(code: ErrorCode, message: string): WriteFrameCheck { return { ok: false, code, message }; }
function okFrame(frame: WriteClientFrame): WriteFrameCheck { return { ok: true, frame }; }
function exactWrite(obj: Record<string, unknown>, expected: readonly string[]): WriteFrameCheck | null {
  const got = Object.keys(obj).sort().join(",");
  const want = [...expected].sort().join(",");
  return got === want ? null : badWrite(4404, `帧字段集合非法（期望 ${want}）`);
}
function ridWrite(obj: Record<string, unknown>): string | WriteFrameCheck {
  const v = obj["requestId"];
  return typeof v === "string" && LIMITS.requestIdPattern.test(v) ? v : badWrite(4404, "requestId 非法");
}
function fileWrite(obj: Record<string, unknown>): string | WriteFrameCheck {
  const v = obj["file"];
  return typeof v === "string" && LIMITS.filePattern.test(v) ? v : badWrite(4404, "file 非法");
}

/** 写侧发送结果 DTO（write-ack.outcome）。可预期业务结果仅以 kind 表达；
 * 宿主内部意外异常不走 DTO——由适配器剥离重抛（固定 write-host-internal Error）→网关 4402。
 *  与 runtime SessionSendResult 的映射在网关适配（error 细节留在服务端审计）。 */
// 3c-2 收窄（第18轮 GPT 勘正）：not-ready.cause 保持可选（同源 SessionSendResult.cause?）；
// rejected 分支已删——send() 路径无此来源（启动失败一律 not-ready{cause:start失败kind}），
// 无源不设枝（YAGNI；真实来源出现时再加=防手写漂移的穷尽检查会强制覆盖）。
export type WriteSendOutcomeDTO =
  | { readonly kind: "launched"; readonly intentId: string; readonly commandId: number }
  | { readonly kind: "busy" }
  | { readonly kind: "gate-rejected"; readonly reason: "busy" | "closed" }
  | { readonly kind: "gate-failed"; readonly stage: "enqueue" | "sending" }
  | { readonly kind: "invalidated"; readonly stage: "enqueue" | "sending" | "post-send" | "first-byte" }
  | { readonly kind: "no-process" }
  | { readonly kind: "not-ready"; readonly cause?: string; readonly detail?: string } // v1.4（M-OPS）：detail=启动失败 stderr 尾行（≤500 字符+strip 控制字符；明文政策显式裁决=docs/m-ops-design.md §4，M-DEPLOY 多用户面前须再评）
  | { readonly kind: "identity-rejected"; readonly cause: "no-recovery-data" | "generation-mismatch" }; // v1.1：prompt 携代次断言→无权威源/旧代恒拒（零副作用；K3 审 P2-1 fail-closed）

/** v1.1 写侧身份拒细节（identity-rejected.cause）。 */
export type WriteIdentityRejectCause =
  | "no-recovery-data" // resume：该 file 无恢复面数据（恢复报告不存在）
  | "resume-blocked" // resume：盘面阻断/未裁决证据在场——授权恒空，先走修复面
  | "resume-not-authorized" // resume：intentId ∉ resendAuthorized（未获重发授权）
  | "generation-mismatch"; // prompt/resume：客户端所见代次≠当前活代（旧代冒充面）

/** v1.1 写侧恢复重发结果 DTO（write-resume-ack.outcome）。身份门=r3a；执行面=r3b——
 * execution-pending 占位已删除（r3b 真交付）：门序拒绝→identity-rejected（零副作用）；
 * 授权在但载荷读不回→execution-failed（证据不完整，非身份错）；执行结果枝与 prompt 面
 * WriteSendOutcomeDTO 同构声明（不嵌套复用：identity-rejected 的 cause 空间两帧面不同，
 * 嵌套会并集松化类型）。launched.intentId=重发新意图（原意图关联在宿主审计行，
 * journal 面=无享新 enqueue 行，重放语义不因 resume 改变）。 */
export type WriteResumeOutcomeDTO =
  | { readonly kind: "identity-rejected"; readonly cause: WriteIdentityRejectCause }
  | { readonly kind: "execution-failed"; readonly cause: "payload-unavailable" }
  | { readonly kind: "launched"; readonly intentId: string; readonly commandId: number }
  | { readonly kind: "busy" }
  | { readonly kind: "gate-rejected"; readonly reason: "busy" | "closed" }
  | { readonly kind: "gate-failed"; readonly stage: "enqueue" | "sending" }
  | { readonly kind: "invalidated"; readonly stage: "enqueue" | "sending" | "post-send" | "first-byte" }
  | { readonly kind: "no-process" }
  | { readonly kind: "not-ready"; readonly cause?: string };

/** 写侧停止结果 DTO（write-stop-ack.outcome）。 */
export type WriteStopOutcomeDTO =
  | { readonly kind: "confirmed"; readonly exit: { readonly code: number | null; readonly signal: string | null } }
  | { readonly kind: "deadline-exceeded" }
  | { readonly kind: "no-process" }
  | { readonly kind: "stopping" };

// 判别联合穷尽检查（编译期；新增 kind 时此处编译失败——防手写漂移）
export function assertNeverHistory(_e: never): never { throw new Error("未穷尽 HistoryEvent"); }
export function assertNeverLive(_e: never): never { throw new Error("未穷尽 LiveEvent"); }
export function assertNeverServer(_e: never): never { throw new Error("未穷尽 ServerFrame"); }
