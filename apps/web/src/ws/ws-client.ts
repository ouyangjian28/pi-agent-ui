// A1a 只读面 WS 客户端：hello 握手（带 token）→welcome 后才发 list-sessions→维护会话列表快照。
// 帧类型唯一权威=@pi-agent-ui/protocol（仅 type 导入，运行时不依赖协议包，前端不重定义帧形状）。
// 红线：①只发 hello/list-sessions——OutgoingFrame 类型层封闭，写类帧（WRITE_FRAME_TYPES）无从构造；
// ②收到未知帧类型（含写类 ack：write-ack/write-stop-ack）与畸形数据一律安全忽略，不抛错；
// ③closed=终态，无自动重连（重连=后续迭代）；④五态状态机，状态变更经 subscribe 回调可订阅。

// 直接从自包含的 contracts 模块引类型（绕开 barrel：index.ts 会拉入 NodeNext 风格 .ts 扩展 import，
// 与 apps/web Bundler 解析不兼容；contracts.ts 零 import 无副作用）。
import type { ClientFrame, ServerFrame, SessionSummaryDTO } from "@pi-agent-ui/protocol/src/contracts";

/** 本客户端允许发送的帧（§5.1 六客户端帧的只读子集；写类 t 在类型层即不可达）。 */
type OutgoingFrame = Extract<ClientFrame, { readonly t: "hello" } | { readonly t: "list-sessions" }>;

/** 五态状态机：connecting→authenticating→ready；任一前置态可落 closed/error。 */
export type WsClientState = "connecting" | "authenticating" | "ready" | "closed" | "error";

/** error 态成因：auth-failed=认证失败（4401 / 握手期 1008 关闭）；list-failed=列表请求被拒；transport=传输层异常保留位。 */
export type WsClientErrorKind = "auth-failed" | "list-failed" | "transport";

/**
 * 会话列表快照（不可变；每次变更整体替换——满足 useSyncExternalStore getSnapshot 缓存语义，
 * 对象未变即引用相等，订阅者不会收到伪变更）。
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

export class WsClient {
  private socket: WebSocketLike | null = null;
  private snapshot: SessionsSnapshot = INITIAL;
  private readonly listeners = new Set<() => void>();
  private listRequestPending = false;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly createSocket: WebSocketFactory = defaultFactory,
  ) {}

  /** 建立连接并发起握手；单连接面，重复调用幂等。 */
  connect(): void {
    if (this.socket) return;
    const socket = this.createSocket(this.url);
    this.socket = socket;
    socket.onopen = () => {
      this.sendFrame({ t: "hello", protocolVersion: 1, token: this.token });
      this.transition({ state: "authenticating" });
    };
    socket.onmessage = (event) => this.onMessage(event.data);
    socket.onerror = () => {
      // ws 语义：error 事件后必跟 close；状态迁移归 onClose 统一出口，避免双跳。
    };
    socket.onclose = (event) => this.onClose(event.code);
  }

  /** 主动关闭（终态）；已 closed/error 时幂等返回。 */
  close(): void {
    const socket = this.socket;
    if (!socket || this.snapshot.state === "closed" || this.snapshot.state === "error") return;
    socket.close();
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
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) return;
    socket.send(JSON.stringify(frame));
  }

  private onMessage(data: unknown): void {
    if (this.snapshot.state === "closed") return; // 终态后不再消费任何帧
    if (typeof data !== "string") return; // 二进制帧非本面（§5.1 拒二进制=服务端职责）
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return; // 畸形 JSON 安全忽略
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    const t = (parsed as { t?: unknown }).t;
    switch (t) {
      case "welcome": {
        if (this.snapshot.state !== "authenticating") return; // 重复 welcome 幂等忽略
        this.transition({ state: "ready" });
        // 握手成功才发 list-sessions（§5.1 帧协议；welcome 前发任何非 hello 帧会被 4401）
        this.listRequestPending = true;
        this.sendFrame({ t: "list-sessions", requestId: LIST_REQUEST_ID });
        return;
      }
      case "sessions": {
        const frame = parsed as Extract<ServerFrame, { readonly t: "sessions" }>;
        if (!this.listRequestPending || frame.requestId !== LIST_REQUEST_ID) return; // 非本请求关联帧不落地
        this.listRequestPending = false;
        this.transition({ sessions: frame.sessions, total: frame.total, listVersion: frame.listVersion });
        return;
      }
      case "error": {
        const frame = parsed as Extract<ServerFrame, { readonly t: "error" }>;
        if (frame.code === 4401) {
          this.transition({ state: "error", errorKind: "auth-failed", errorMessage: frame.message });
          return;
        }
        if (this.listRequestPending && frame.requestId === LIST_REQUEST_ID) {
          this.listRequestPending = false;
          this.transition({ state: "error", errorKind: "list-failed", errorMessage: frame.message });
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
    const s = this.snapshot;
    if (s.state === "closed" || s.state === "error") return; // auth-failed 不降级为 closed
    if (code === 1008 && (s.state === "connecting" || s.state === "authenticating")) {
      // §5.3：4401 走 close 1008——服务端可先发 error 帧也可直接关，两种形态都判认证失败
      this.transition({ state: "error", errorKind: "auth-failed", errorMessage: "认证失败（连接被 1008 关闭）" });
      return;
    }
    this.transition({ state: "closed" }); // 终态；无自动重连（后续迭代）
  }

  private transition(patch: Partial<SessionsSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}
