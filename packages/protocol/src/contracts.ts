// ②WS/UI 只读面共享契约 v1.2 — 类型与运行时校验单源（c3 冻结门第 4 步）。
// 零 node 依赖（浏览器安全）。语义权威=docs/ws-ui-contracts-v1.md；语义变更=协议版本+1 双方审记。
// 注意：TS1024——interface 方法签名禁 readonly 前缀。

// ---------------------------------------------------------------------------
// 限额常量（§5.7 逐字段表；contracts.ts=冻结源）
// ---------------------------------------------------------------------------
export const LIMITS = {
  frameMaxBytes: 262_144,
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
  filePattern: /^[\w.-]{1,114}\.jsonl$/,
  requestIdPattern: /^[\w-]{1,64}$/,
  idPattern: /^[\w:.-]{1,128}$/,
  toolNamePattern: /^[\w:.-]{1,64}$/,
  titleLimit: 80,
  previewLimitTurn: 200,
  previewLimitMessage: 500,
  noteLimit: 120,
} as const;

export type ErrorCode = 4401 | 4402 | 4403 | 4404 | 4405 | 4409 | 4413 | 4429 | 4431 | 4432;

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
  | "message" | "corrupt-entry" | "unknown-line" | "journal-corrupt";

export type HistoryEvent = HistoryEventBase & (
  | { readonly kind: "turn-enqueued"; readonly preview: SanitizedText; readonly ordinal: number }
  | { readonly kind: "sending" } | { readonly kind: "turn-engaged" } | { readonly kind: "turn-consumed" }
  | { readonly kind: "turn-cancelled" } | { readonly kind: "verdict-delivered" } | { readonly kind: "verdict-settled" }
  | { readonly kind: "verdict-unknown" } | { readonly kind: "unknown-line" } | { readonly kind: "journal-corrupt" }
  | { readonly kind: "response-timeout"; readonly commandId: number }
  | { readonly kind: "clear"; readonly clearedCount: number }
  | { readonly kind: "corrupt-entry"; readonly entryId: string }
  | { readonly kind: "message";
      readonly entryId: string; readonly blockIndex?: number;
      readonly role: "user" | "assistant" | "toolCall" | "toolResult" | "system";
      readonly textPreview?: SanitizedText;
      readonly stopReason?: "stop" | "length" | "aborted" | "toolUse";
      readonly toolCallId?: string;
      readonly final: boolean }
);

export type PiEventType =
  | "agent_start" | "turn_start" | "message_start" | "message_update" | "message_end"
  | "turn_end" | "agent_end" | "agent_settled";

export type ProgressNote = "thinking" | "tool-start" | "tool-end" | "compacting" | "message-start" | "message-end";

export type LiveEvent =
  | { readonly kind: "pi-progress"; readonly piType: PiEventType; readonly note: ProgressNote }
  | { readonly kind: "turn-state"; readonly statusVersion: StatusVersion; readonly turn: TurnState }
  | { readonly kind: "process-note"; readonly phase: "running" | "stopping" };

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
  readonly reason: "read-failed" | "concurrent-modification" | "oversized";
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
  | { readonly t: "hello"; readonly protocolVersion: 1; readonly token: string }
  | { readonly t: "list-sessions"; readonly requestId: string; readonly offset?: number; readonly limit?: number }
  | SubscribeFrame
  | { readonly t: "unsubscribe"; readonly requestId: string; readonly subscriptionId: SubscriptionId }
  | { readonly t: "get-recovery"; readonly requestId: string; readonly file: string; readonly offset?: number; readonly evidenceHash?: string }
  | { readonly t: "ping"; readonly nonce: string };

export type ResyncReason = "server-side-gap" | "stream-replaced";

export type ServerFrame =
  | { readonly t: "welcome"; readonly serverBootId: string; readonly protocolVersion: 1 }
  | { readonly t: "sessions"; readonly requestId: string; readonly sessions: readonly SessionSummaryDTO[]; readonly total: number; readonly offset: number; readonly hasMore: boolean; readonly listVersion: number }
  | ({ readonly t: "snapshot" } & SnapshotFrame)
  | { readonly t: "events"; readonly subscriptionId: SubscriptionId; readonly origin: "history"; readonly refSeq: number; readonly events: readonly HistoryEvent[] }
  | { readonly t: "events"; readonly subscriptionId: SubscriptionId; readonly origin: "live"; readonly liveSeq: number; readonly refSeq: null; readonly events: readonly LiveEvent[] }
  | { readonly t: "status"; readonly subscriptionId: SubscriptionId; readonly status: SessionStatus }
  | ({ readonly t: "recovery"; readonly requestId: string; readonly file: string } & RecoveryInfo)
  | { readonly t: "resync-required"; readonly subscriptionId: SubscriptionId; readonly reason: ResyncReason }
  | { readonly t: "error"; readonly code: ErrorCode; readonly message: string; readonly retryable: boolean; readonly requestId?: string; readonly subscriptionId?: SubscriptionId }
  | { readonly t: "pong"; readonly nonce: string };

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
  switch (t) {
    case "hello": {
      const r0 = requireExact(obj, ["t", "protocolVersion", "token"]); if (r0) return r0;
      const v = obj["protocolVersion"];
      // 版本层：合法整数但 ≠1 → 4403（先于其余字段格式错？§5.3：格式层→版本层→写类层——hello 的 protocolVersion 类型错属格式层）
      if (typeof v !== "number" || !Number.isSafeInteger(v)) return bad(4404, "protocolVersion 必须是安全整数");
      if (v !== 1) return bad(4403, "协议版本不匹配");
      const token = obj["token"];
      if (typeof token !== "string" || token.length === 0 || token.length > 1024) return bad(4404, "token 非法");
      return ok({ t: "hello", protocolVersion: 1, token });
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
    case "ping": {
      const r0 = requireExact(obj, ["t", "nonce"]); if (r0) return r0;
      const nonce = obj["nonce"];
      if (typeof nonce !== "string" || nonce.length === 0 || nonce.length > 64) return bad(4404, "nonce 非法");
      return ok({ t: "ping", nonce });
    }
    default:
      return bad(4404, `未知帧类型 ${t.length > 16 ? t.slice(0, 16) + "…" : t}`);
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
  const sid = o["streamId"], seq = o["seq"];
  if (typeof sid !== "string" || sid.length === 0 || sid.length > 64) return { ok: false };
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) return { ok: false };
  return { ok: true, value: { streamId: sid, seq } };
}

// 判别联合穷尽检查（编译期；新增 kind 时此处编译失败——防手写漂移）
export function assertNeverHistory(_e: never): never { throw new Error("未穷尽 HistoryEvent"); }
export function assertNeverLive(_e: never): never { throw new Error("未穷尽 LiveEvent"); }
export function assertNeverServer(_e: never): never { throw new Error("未穷尽 ServerFrame"); }
