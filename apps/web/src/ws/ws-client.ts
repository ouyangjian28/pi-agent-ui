// A1a 只读面 WS 客户端：hello 握手（带 token）→welcome 后才发 list-sessions→维护会话列表快照。
// 帧类型唯一权威=@pi-agent-ui/protocol（仅 type 导入，运行时不依赖协议包，前端不重定义帧形状）。
// 红线：①只发 hello/list-sessions——OutgoingFrame 类型层封闭，写类帧（WRITE_FRAME_TYPES）无从构造；
// ②实际消费的帧（welcome/sessions/error 及 SessionSummaryDTO）先过文件内运行时形状校验，校验失败
//   连同未知帧类型（含写类 ack）一律按未知帧安全忽略（零副作用：不改快照/不通知/不清在途/不发后续帧）；
// ③close()=不可逆停止屏障（任何状态可关、迟到回调零副作用、幂等）；closed=终态，无自动重连；
// ④错误文案受控（按 code 映射）——远端 error.message 可能回显敏感输入，永不进入快照与 DOM；
// ⑤五态状态机，状态变更经 subscribe 回调可订阅。

// 直接从自包含的 contracts 模块引类型（绕开 barrel：index.ts 会拉入 NodeNext 风格 .ts 扩展 import，
// 与 apps/web Bundler 解析不兼容；contracts.ts 零 import 无副作用）。
import type { ClientFrame, ErrorCode, ServerFrame, SessionSummaryDTO } from "@pi-agent-ui/protocol/src/contracts";

/** 本客户端允许发送的帧（§5.1 六客户端帧的只读子集；写类 t 在类型层即不可达）。 */
type OutgoingFrame = Extract<ClientFrame, { readonly t: "hello" } | { readonly t: "list-sessions" }>;

/** 五态状态机：connecting→authenticating→ready；任一前置态可落 closed/error。 */
export type WsClientState = "connecting" | "authenticating" | "ready" | "closed" | "error";

/**
 * error 态成因：auth-failed=认证失败（4401 / 握手期 1008 关闭）；list-failed=列表请求被拒；
 * handshake-failed=握手期非认证失败（C1：4403 协议版本不匹配等，服务端随后 1003/1000 关闭不丢原因）；
 * transport=连接创建失败。
 */
export type WsClientErrorKind = "auth-failed" | "list-failed" | "handshake-failed" | "transport";

/**
 * 会话列表快照（不可变；每次变更整体替换——满足 useSyncExternalStore getSnapshot 缓存语义，
 * 对象未变即引用相等，订阅者不会收到伪变更）。
 * errorMessage 只承载本文件 controlledErrorText 的受控文案，不含任何远端自由文本。
 */
export interface SessionsSnapshot {
  readonly state: WsClientState;
  readonly errorKind: WsClientErrorKind | null;
  readonly errorMessage: string | null;
  /** null=尚未收到 sessions 帧（与「收到空列表」语义分立：前者 loading，后者 empty）。 */
  readonly sessions: readonly SessionSummaryDTO[] | null;
  readonly total: number;
  readonly listVersion: number | null;
}

/** 可注入的 WebSocket 最小面（测试用 FakeWebSocket 顶替浏览器原生实现，不依赖真 ws 库）。 */
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

/** list-sessions 请求 ID（§5.7 requestIdPattern=/^[\w-]{1,64}$/）。 */
const LIST_REQUEST_ID = "list-sessions-1";

const INITIAL: SessionsSnapshot = {
  state: "connecting",
  errorKind: null,
  errorMessage: null,
  sessions: null,
  total: 0,
  listVersion: null,
};

// ---------------------------------------------------------------------------
// R1：消费帧运行时形状校验（纯函数、文件内私有、零依赖）。
// 只校验本面实际消费的 welcome/sessions/error 及 SessionSummaryDTO（权威=contracts.ts 组4/组5）；
// 校验失败→调用方按未知帧处理（零副作用）。字段域按权威 DTO：文本必须 string、计数必须有限非负数、
// 允许的 null（sessionId/lastActiveMs）放行；welcome.protocolVersion 契约冻结为字面量 1。
// ---------------------------------------------------------------------------

/** §5.3 错误码全集（ErrorCode 的运行时镜像；新码未登记=按未知帧保守拒绝，宁可少展示不盲信）。 */
const ERROR_CODES: ReadonlySet<number> = new Set([4401, 4402, 4403, 4404, 4405, 4409, 4413, 4414, 4429, 4431, 4432]);

function isErrorCode(v: unknown): v is ErrorCode {
  return typeof v === "number" && ERROR_CODES.has(v);
}

type WelcomeFrame = Extract<ServerFrame, { readonly t: "welcome" }>;
type SessionsFrame = Extract<ServerFrame, { readonly t: "sessions" }>;
type ErrorFrame = Extract<ServerFrame, { readonly t: "error" }>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isString(v: unknown): v is string {
  return typeof v === "string";
}
function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}
/** 计数/时间戳域：有限非负数（JSON.parse 不会产生 NaN/Infinity，此处仍显式设防）。 */
function isNonNegativeNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

function isSanitizedText(v: unknown): boolean {
  return isPlainObject(v) && isString(v.text) && isBoolean(v.truncated);
}

function isSessionSummary(v: unknown): v is SessionSummaryDTO {
  return (
    isPlainObject(v) &&
    (v.sessionId === null || isString(v.sessionId)) &&
    isString(v.file) &&
    isSanitizedText(v.title) &&
    (v.lastActiveMs === null || isNonNegativeNumber(v.lastActiveMs)) &&
    isNonNegativeNumber(v.entryCount) &&
    isNonNegativeNumber(v.sizeBytes) &&
    isBoolean(v.hasRecoveryNotice) &&
    (v.listReliability === "full" || v.listReliability === "partial")
  );
}

/** welcome：serverBootId/serverBuildId 必须 string，protocolVersion 必须是字面量 1（缺字段/版本 2 均拒绝）。 */
function asWelcomeFrame(v: Record<string, unknown>): WelcomeFrame | null {
  if (!isString(v.serverBootId) || !isString(v.serverBuildId) || v.protocolVersion !== 1) return null;
  return { t: "welcome", serverBootId: v.serverBootId, serverBuildId: v.serverBuildId, protocolVersion: 1 };
}

/** sessions：整帧形状+逐条目 SessionSummaryDTO；任一条目畸形（含 null）整帧拒绝。 */
function asSessionsFrame(v: Record<string, unknown>): SessionsFrame | null {
  if (!isString(v.requestId)) return null;
  if (!isNonNegativeNumber(v.total) || !isNonNegativeNumber(v.offset) || !isNonNegativeNumber(v.listVersion)) return null;
  if (!isBoolean(v.hasMore)) return null;
  if (v.listReliability !== "full" && v.listReliability !== "partial") return null;
  if (!Array.isArray(v.sessions)) return null;
  const sessions: SessionSummaryDTO[] = [];
  for (const item of v.sessions) {
    if (!isSessionSummary(item)) return null;
    sessions.push(item);
  }
  return {
    t: "sessions",
    requestId: v.requestId,
    sessions,
    total: v.total,
    offset: v.offset,
    hasMore: v.hasMore,
    listVersion: v.listVersion,
    listReliability: v.listReliability,
  };
}

/** error：code∈§5.3 锚定码表、message 必须 string（即使不展示也验形）、retryable 必须 boolean。 */
function asErrorFrame(v: Record<string, unknown>): ErrorFrame | null {
  if (!isErrorCode(v.code)) return null;
  if (!isString(v.message) || !isBoolean(v.retryable)) return null;
  if (v.requestId !== undefined && !isString(v.requestId)) return null;
  return {
    t: "error",
    code: v.code,
    message: v.message,
    retryable: v.retryable,
    ...(v.requestId === undefined ? {} : { requestId: v.requestId }),
  };
}

// ---------------------------------------------------------------------------
// R2：错误文案受控映射——远端 error.message 一律不进快照/DOM（可能回显 token 等敏感输入）。
// code 来自校验后的封闭枚举，可安全内嵌于受控文案；message 仅用于服务端审计，前端不留存。
// ---------------------------------------------------------------------------

/** §5.3 错误码→受控文案（code 域封闭=内嵌安全）。 */
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

export class WsClient {
  private socket: WebSocketLike | null = null;
  private snapshot: SessionsSnapshot = INITIAL;
  private readonly listeners = new Set<() => void>();
  private listRequestPending = false;
  /** R3 不可逆停止位：close() 置位后一切回调零副作用、connect() 永久拒绝、重复 close 幂等。 */
  private stopped = false;

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
      // C1：构造失败给受控反馈（不重试）——真实环境无 WebSocket 构造器/非法 URL 等场景；
      // 置停止位：后续 connect 永久拒绝，不重复抛出/重复通知。
      this.stopped = true;
      this.fail("transport", "连接创建失败：无法建立 WebSocket 连接");
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.stopped || this.snapshot.state !== "connecting") return; // 迟到/重复 open 不复活状态、不重发 hello
      this.sendFrame({ t: "hello", protocolVersion: 1, token: this.token });
      this.transition({ state: "authenticating" });
    };
    socket.onmessage = (event) => this.onMessage(event.data);
    socket.onerror = () => {
      if (this.stopped) return; // ws 语义：error 事件后必跟 close；状态迁移归 onClose 统一出口，避免双跳。
    };
    socket.onclose = (event) => this.onClose(event.code);
  }

  /**
   * 主动关闭：立即置不可逆停止位并物理释放 socket（未 connect/connecting/error 均可关）。
   * 展示态与物理释放分离——error 态保留具体错误文案（不降级为 closed），但连接一律释放；
   * 停止位置位后清在途请求、迟到回调零副作用、重复 close 幂等、后续 connect 拒绝。
   */
  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.listRequestPending = false;
    if (this.snapshot.state !== "closed" && this.snapshot.state !== "error") {
      this.transition({ state: "closed" });
    }
    this.socket?.close();
  }

  /** 订阅快照变更（含状态迁移）；返回退订函数。签名与 useSyncExternalStore 直接对齐。 */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): SessionsSnapshot => this.snapshot;

  private sendFrame(frame: OutgoingFrame): void {
    if (this.stopped) return;
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) return;
    socket.send(JSON.stringify(frame));
  }

  private onMessage(data: unknown): void {
    const state = this.snapshot.state;
    if (this.stopped || state === "closed" || state === "error") return; // 停止屏障/终态后不再消费任何帧
    if (typeof data !== "string") return; // 二进制帧非本面（§5.1 拒二进制=服务端职责）
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return; // 畸形 JSON 安全忽略
    }
    if (!isPlainObject(parsed)) return;
    switch (parsed.t) {
      case "welcome": {
        if (state !== "authenticating") return; // 重复 welcome 幂等忽略
        if (asWelcomeFrame(parsed) === null) return; // R1：缺字段/版本不符=未知帧，不得算握手成功
        this.transition({ state: "ready" });
        // 握手成功才发 list-sessions（§5.1 帧协议；welcome 前发任何非 hello 帧会被 4401）
        this.listRequestPending = true;
        this.sendFrame({ t: "list-sessions", requestId: LIST_REQUEST_ID });
        return;
      }
      case "sessions": {
        if (!this.listRequestPending) return;
        const frame = asSessionsFrame(parsed);
        // R1：形状/条目校验失败=未知帧零副作用——不消耗唯一在途请求；requestId 不符同忽略。
        if (frame === null || frame.requestId !== LIST_REQUEST_ID) return;
        this.listRequestPending = false;
        this.transition({ sessions: frame.sessions, total: frame.total, listVersion: frame.listVersion });
        return;
      }
      case "error": {
        const frame = asErrorFrame(parsed);
        if (frame === null) return; // R1：畸形 error 帧（如 message 非字符串）整帧忽略
        if (frame.code === 4401) {
          this.fail("auth-failed", controlledErrorText(4401));
          return;
        }
        if (state === "connecting" || state === "authenticating") {
          // C1：握手期非认证失败（4403 协议版本等）→受控握手错误；随后服务端 1003/1000 关闭不降级、不丢原因。
          this.fail("handshake-failed", controlledErrorText(frame.code));
          return;
        }
        if (this.listRequestPending && frame.requestId === LIST_REQUEST_ID) {
          this.fail("list-failed", controlledErrorText(frame.code));
        }
        return; // 无关联请求的 error 帧安全忽略
      }
      default:
        // 未知/暂未消费的帧（snapshot/events/status/recovery/resync-required/pong/
        // write-ack/write-stop-ack 及任何陌生 t）一律安全忽略——只读面不判错不抛错。
        return;
    }
  }

  private onClose(code: number): void {
    if (this.stopped) return; // 停止屏障：close() 后迟到关闭事件零副作用（状态已由 close() 定格）
    const s = this.snapshot;
    if (s.state === "closed" || s.state === "error") return; // auth-failed/handshake-failed 不降级为 closed
    if (code === 1008 && (s.state === "connecting" || s.state === "authenticating")) {
      // §5.3：4401 走 close 1008——服务端可先发 error 帧也可直接关，两种形态都判认证失败
      this.fail("auth-failed", "认证失败（连接被 1008 关闭）");
      return;
    }
    this.transition({ state: "closed" }); // 终态；无自动重连（后续迭代）
  }

  /** 统一错误出口：清在途请求（迟到回包不再变更 error 快照）+受控文案进快照。 */
  private fail(errorKind: WsClientErrorKind, errorMessage: string): void {
    this.listRequestPending = false;
    this.transition({ state: "error", errorKind, errorMessage });
  }

  private transition(patch: Partial<SessionsSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}
