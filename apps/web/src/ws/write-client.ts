// A1c 写面 WS 客户端：hello 握手→welcome 后受理 prompt/stop 发送，按 requestId 关联 write-ack/
// write-stop-ack 与 error 帧，promise 化返回 outcome DTO。连接面复刻 ws-client.ts 惯例（每面一连接：
// 会话列表/详情/写三面各持独立连接，服务端网关同连接混受理读写帧——本面不侵入订阅面 socket，订阅面行为零改动）。
// 红线（复刻 ws-client 两铁律+写面特化）：
// ①只发 hello/prompt/stop——OutgoingWriteFrame 类型层封闭（WriteClientFrame 仅 prompt/stop 两枝，
//   其余写类 t 无从构造；服务端未开放写 t 一律 4405）；
// ②实际消费的帧（welcome/write-ack/write-stop-ack/error 及 outcome DTO 全域）先过文件内私有运行时形状
//   校验（asXxxFrame 系列）；坏帧=零副作用：不消费在途请求、不改快照，后续合法帧照常受理（在途 promise
//   只由合法 ack/匹配 error/连接终局三途结算——宁可等待也不被畸形帧强制定局）；
// ③错误文案受控（writeFaceErrorText 按 code 映射）——远端 error.message 可能回显敏感输入，永不进入
//   promise 错误与 DOM；本地预校验（file 域/text 非空/text ≤ WRITE_TEXT_MAX_BYTES）零帧成本本地拒绝；
// ④在途跟踪按（file×kind）：同 file 同 kind 重复=本地拒（不等服务端 4404 在途门）；prompt 与 stop 可并行
//   （「发送后立即停止」合法流，服务端按 requestId 分账）；
// ⑤连接断开/终局（onclose、close()、连接级 error）时在途 promise 统一 reject（transport/closed 受控文案）；
// ⑥无自动重试/自动重发：4402 retryable=true 只是服务端的可重试性声明，不授权客户端重发（19d 裁决）；
// ⑦close()=不可逆停止屏障（任何状态可关、迟到回调零副作用、幂等）；closed=终态，无自动重连；
// ⑧write-ack 的 file 回显必须与在途请求一致（requestId 唯一定账，file 不符=畸形帧忽略）。

// 同 ws-client：绕开 barrel 直引自包含 contracts 模块（浏览器安全、零 Node 依赖）。
// LIMITS/WRITE_TEXT_MAX_BYTES 为值导入（filePattern/字节上限冻结源，避免本地复制漂移）。
import { LIMITS, WRITE_TEXT_MAX_BYTES } from "@pi-agent-ui/protocol/src/contracts";
import type {
  ClientFrame,
  ErrorCode,
  ServerFrame,
  WriteClientFrame,
  WriteSendOutcomeDTO,
  WriteStopOutcomeDTO,
} from "@pi-agent-ui/protocol/src/contracts";

/** 本客户端允许发送的帧（握手 hello+写面两帧；其余客户端帧类型层不可达）。 */
type OutgoingWriteFrame = Extract<ClientFrame, { readonly t: "hello" }> | WriteClientFrame;

/** 连接级五态（同 ws-client）：connecting→authenticating→ready；任一前置态可落 closed/error。 */
export type WriteConnState = "connecting" | "authenticating" | "ready" | "closed" | "error";

/**
 * 受控失败成因（promise reject 的结构化身份；message 恒为受控文案，不含远端自由文本）：
 * not-ready=连接未就绪即发送；local-invalid=本地预校验拒绝（file/text 域）；in-flight=同 file 同 kind 在途重复；
 * server=error 帧按 requestId 匹配（code 携带服务端码）；transport=连接断开/连接级错误；closed=本端 close()。
 */
export type WriteSendErrorKind = "not-ready" | "local-invalid" | "in-flight" | "server" | "transport" | "closed";

/** 写面统一拒绝值：结构化 kind+code（服务端码；本地拒绝为 null）+受控文案。 */
export class WriteSendError extends Error {
  readonly kind: WriteSendErrorKind;
  readonly code: ErrorCode | null;
  constructor(kind: WriteSendErrorKind, message: string, code: ErrorCode | null = null) {
    super(message);
    this.name = "WriteSendError";
    this.kind = kind;
    this.code = code;
  }
}

/** 在途请求（视图面）：file×kind 唯一性由 inFlightEntries 保证。 */
export interface WriteInflightEntry {
  readonly file: string;
  readonly kind: "prompt" | "stop";
}

/** 最近一次已终结请求（视图面）：ack 成功携 outcome；失败携受控文案（code 内嵌于文案）。 */
export type WriteLastResult =
  | { readonly ok: true; readonly kind: "prompt"; readonly file: string; readonly outcome: WriteSendOutcomeDTO }
  | { readonly ok: true; readonly kind: "stop"; readonly file: string; readonly outcome: WriteStopOutcomeDTO }
  | { readonly ok: false; readonly kind: "prompt" | "stop"; readonly file: string; readonly message: string };

/**
 * 写面快照（不可变；每次变更整体替换——useSyncExternalStore getSnapshot 缓存语义）。
 * inflight/lastResult 驱动 hook 状态机与结果展示；errorMessage 只承载受控文案。
 */
export interface WriteSnapshot {
  readonly connState: WriteConnState;
  readonly errorKind: "auth-failed" | "transport" | null;
  readonly errorMessage: string | null;
  /** 在途（file×kind）视图集合；卸载不清（服务端状态由用户显式 stop/close 收口）。 */
  readonly inflight: readonly WriteInflightEntry[];
  /** 最近一次已终结请求（null=尚无）。 */
  readonly lastResult: WriteLastResult | null;
}

/** 可注入的 WebSocket 最小面（与 ws-client/subscribe-client 同形；测试用 FakeWebSocket 顶替）。 */
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

const INITIAL: WriteSnapshot = {
  connState: "connecting",
  errorKind: null,
  errorMessage: null,
  inflight: [],
  lastResult: null,
};

// ---------------------------------------------------------------------------
// R1：消费帧运行时形状校验（纯函数、文件内私有、零依赖；权威=contracts.ts 写侧段/组5）。
// ---------------------------------------------------------------------------

/** §5.3 错误码全集（运行时镜像；未登记码=未知帧保守拒绝）。 */
const ERROR_CODES: ReadonlySet<number> = new Set([4401, 4402, 4403, 4404, 4405, 4409, 4413, 4429, 4431, 4432]);

function isErrorCode(v: unknown): v is ErrorCode {
  return typeof v === "number" && ERROR_CODES.has(v);
}

type WelcomeFrame = Extract<ServerFrame, { readonly t: "welcome" }>;
type ErrorFrame = Extract<ServerFrame, { readonly t: "error" }>;
type WriteAckFrame = Extract<ServerFrame, { readonly t: "write-ack" }>;
type WriteStopAckFrame = Extract<ServerFrame, { readonly t: "write-stop-ack" }>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isString(v: unknown): v is string {
  return typeof v === "string";
}
function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}
function isNonNegativeInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

/** WriteSendOutcomeDTO（3c-2 收窄版）全域判别校验。 */
function isSendOutcome(v: unknown): v is WriteSendOutcomeDTO {
  if (!isPlainObject(v)) return false;
  switch (v["kind"]) {
    case "launched":
      return isString(v["intentId"]) && isNonNegativeInteger(v["commandId"]);
    case "busy":
    case "no-process":
      return true;
    case "gate-rejected":
      return v["reason"] === "busy" || v["reason"] === "closed";
    case "gate-failed":
      return v["stage"] === "enqueue" || v["stage"] === "sending";
    case "invalidated":
      return v["stage"] === "enqueue" || v["stage"] === "sending" || v["stage"] === "post-send" || v["stage"] === "first-byte";
    case "not-ready":
      return v["cause"] === undefined || isString(v["cause"]);
    default:
      return false;
  }
}

/** WriteStopOutcomeDTO 全域判别校验。 */
function isStopOutcome(v: unknown): v is WriteStopOutcomeDTO {
  if (!isPlainObject(v)) return false;
  switch (v["kind"]) {
    case "deadline-exceeded":
    case "no-process":
    case "stopping":
      return true;
    case "confirmed": {
      const exit = v["exit"];
      if (!isPlainObject(exit)) return false;
      return (exit["code"] === null || isNonNegativeInteger(exit["code"])) && (exit["signal"] === null || isString(exit["signal"]));
    }
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
  return {
    t: "error",
    code: v.code,
    message: v.message,
    retryable: v.retryable,
    ...(v.requestId === undefined ? {} : { requestId: v.requestId }),
  };
}

/** write-ack：requestId/file 必须 string，outcome 全域校验（畸形→调用方按未知帧忽略）。 */
function asWriteAckFrame(v: Record<string, unknown>): WriteAckFrame | null {
  if (!isString(v.requestId) || !isString(v.file)) return null;
  if (!isSendOutcome(v.outcome)) return null;
  return { t: "write-ack", requestId: v.requestId, file: v.file, outcome: v.outcome };
}

/** write-stop-ack：同 write-ack（outcome 换 stop 判别联合）。 */
function asWriteStopAckFrame(v: Record<string, unknown>): WriteStopAckFrame | null {
  if (!isString(v.requestId) || !isString(v.file)) return null;
  if (!isStopOutcome(v.outcome)) return null;
  return { t: "write-stop-ack", requestId: v.requestId, file: v.file, outcome: v.outcome };
}

// ---------------------------------------------------------------------------
// R2：错误文案受控映射（写面口径；code 域封闭=内嵌安全，message 仅服务端审计用，前端不留存）。
// 与 ws-client/subscribe-client 同惯例，4402/4404 措辞按写面语义调整（写宿主/在途重复）。
// ---------------------------------------------------------------------------

function writeFaceErrorText(code: number): string {
  switch (code) {
    case 4401: return "认证失败：令牌无效或未认证（4401）";
    case 4402: return "写宿主不可用，请求未完成（4402）";
    case 4403: return "协议版本不匹配（4403）";
    case 4404: return "写请求非法或与在途状态冲突（4404）";
    case 4405: return "写操作被服务端拒绝（4405）";
    case 4409: return "请求游标或状态已过期（4409）";
    case 4413: return "会话身份损坏（4413）";
    case 4429: return "并发请求超限（4429）";
    case 4431: return "服务端出帧预算超限（4431）";
    case 4432: return "心跳超时（4432）";
    default: return `服务端错误（${code}）`;
  }
}

/** 在途记账（内部）：requestId→结算回调+file/kind。 */
interface InflightRecord {
  readonly file: string;
  readonly kind: "prompt" | "stop";
  readonly resolve: (outcome: never) => void; // 泛型在 Map 存储处擦除；结算入口按 kind 分派强类型
  readonly reject: (error: WriteSendError) => void;
}

export class WriteClient {
  private socket: WebSocketLike | null = null;
  private snapshot: WriteSnapshot = INITIAL;
  private readonly listeners = new Set<() => void>();
  /** R3 不可逆停止位：close() 置位后一切回调零副作用、connect() 永久拒绝、重复 close 幂等。 */
  private stopped = false;
  private reqCounter = 0;
  private readonly inflight = new Map<string, InflightRecord>();

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
      if (this.stopped) return; // ws 语义：error 事件后必跟 close；状态迁移归 onClose 统一出口
    };
    socket.onclose = (event) => this.onClose(event.code);
  }

  /**
   * 发送 prompt（§B16：prompt{requestId,file,text}→write-ack{outcome}）。
   * 本地预校验（不满足即本地拒、零帧成本）：连接 ready；file 过 filePattern（服务端同判 4404）；
   * text 非空且 UTF-8 ≤ WRITE_TEXT_MAX_BYTES（服务端同判 4404）；同 file 无在途 prompt。
   * 不排队：未就绪/预校验失败即受控拒绝，由用户显式重发（无自动重发）。
   */
  sendPrompt(file: string, text: string): Promise<WriteSendOutcomeDTO> {
    return this.dispatch("prompt", file, text) as Promise<WriteSendOutcomeDTO>;
  }

  /** 发送 stop（§B16：stop{requestId,file}→write-stop-ack{outcome}）。与同 file 在途 prompt 可并行。 */
  sendStop(file: string): Promise<WriteStopOutcomeDTO> {
    return this.dispatch("stop", file) as Promise<WriteStopOutcomeDTO>;
  }

  /**
   * 主动关闭：立即置不可逆停止位并物理释放 socket（未 connect/connecting/error 均可关）。
   * 在途请求统一以 closed 受控文案拒绝（服务端连接同断，无迟到结算窗口）；error 态保留错误文案。
   */
  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.settleAllInflight(new WriteSendError("closed", "写连接已关闭，请求未完成"));
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

  readonly getSnapshot = (): WriteSnapshot => this.snapshot;

  // -------------------------------------------------------------------------
  // 内部：发送与在途记账
  // -------------------------------------------------------------------------

  private newRequestId(kind: "prompt" | "stop"): string {
    this.reqCounter += 1;
    return `wr-${kind === "prompt" ? "p" : "s"}-${this.reqCounter}`; // §5.7 requestIdPattern=/^[\w-]{1,64}$/
  }

  private sendFrame(frame: OutgoingWriteFrame): void {
    if (this.stopped) return;
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) return;
    socket.send(JSON.stringify(frame));
  }

  /** prompt/stop 共用派发：本地预校验→占位→发帧；resolve/reject 经在途表按 requestId 结算。 */
  private dispatch(kind: "prompt" | "stop", file: string, text?: string): Promise<unknown> {
    if (this.stopped) {
      return Promise.reject(new WriteSendError("closed", "写连接已关闭，请求未完成"));
    }
    if (this.snapshot.connState !== "ready") {
      return Promise.reject(new WriteSendError("not-ready", "写连接未就绪，暂不能发送"));
    }
    if (!LIMITS.filePattern.test(file)) {
      return Promise.reject(new WriteSendError("local-invalid", "文件名非法，无法发送"));
    }
    if (kind === "prompt") {
      if (text === undefined || text.length === 0) {
        return Promise.reject(new WriteSendError("local-invalid", "消息内容为空，无法发送"));
      }
      if (utf8Bytes(text) > WRITE_TEXT_MAX_BYTES) {
        return Promise.reject(new WriteSendError("local-invalid", `消息超出 ${WRITE_TEXT_MAX_BYTES / 1024}KiB 字节上限，未发送`));
      }
    }
    const dup = this.snapshot.inflight.some((e) => e.file === file && e.kind === kind);
    if (dup) {
      const message = kind === "prompt" ? "该会话已有发送中的消息，请等待结果" : "停止请求已在途，请等待结果";
      return Promise.reject(new WriteSendError("in-flight", message));
    }
    const requestId = this.newRequestId(kind);
    return new Promise<unknown>((resolve, reject) => {
      // 占位先于发帧（同步占位防同刻重入漏判在途重复）；快照 inflight 视图随 transition 通知
      this.inflight.set(requestId, { file, kind, resolve: resolve as (outcome: never) => void, reject });
      this.transition({ inflight: [...this.snapshot.inflight, { file, kind }] });
      if (kind === "prompt") {
        this.sendFrame({ t: "prompt", requestId, file, text: text as string });
      } else {
        this.sendFrame({ t: "stop", requestId, file });
      }
    });
  }

  /** 定位并出表匹配的在途请求（requestId 唯一定账+kind/file 三重交叉验证）；不匹配=零副作用返回 null
   * （在途表与快照均不动——畸形关联帧不消费在途，等合法 ack/匹配 error/连接终局结算）。
   * 不做快照变更：调用方把 inflightView 并入同一次 transition（一次结算=一次通知）。 */
  private takeInflight(requestId: string, kind: "prompt" | "stop", file: string): { record: InflightRecord; inflightView: readonly WriteInflightEntry[] } | null {
    const record = this.inflight.get(requestId);
    if (record === undefined) return null;
    if (record.kind !== kind || record.file !== file) return null; // ⑧ file/kind 回显不一致=畸形关联，零消费
    this.inflight.delete(requestId);
    const inflightView = this.snapshot.inflight.filter((e) => !(e.file === file && e.kind === kind));
    return { record, inflightView };
  }

  /** 全量结算（连接终局）：出表+快照先行，回调最后（拒绝回调内不重入读写面状态）；结算顺序=Map 插入序。 */
  private settleAllInflight(error: WriteSendError): void {
    if (this.inflight.size === 0) return;
    const records = [...this.inflight.values()];
    this.inflight.clear();
    let lastResult: WriteLastResult | null = this.snapshot.lastResult;
    for (const record of records) {
      lastResult = { ok: false, kind: record.kind, file: record.file, message: error.message };
    }
    this.transition({ inflight: [], lastResult });
    for (const record of records) record.reject(error);
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
        return;
      }
      case "write-ack": {
        const frame = asWriteAckFrame(parsed);
        if (frame === null) return; // R1：畸形整帧忽略（不消费在途；合法帧可恢复结算）
        const taken = this.takeInflight(frame.requestId, "prompt", frame.file);
        if (taken === null) return; // 无关联/迟到/回显不符：零消费（在途保留）
        this.transition({ inflight: taken.inflightView, lastResult: { ok: true, kind: "prompt", file: frame.file, outcome: frame.outcome } });
        (taken.record.resolve as (outcome: WriteSendOutcomeDTO) => void)(frame.outcome);
        return;
      }
      case "write-stop-ack": {
        const frame = asWriteStopAckFrame(parsed);
        if (frame === null) return;
        const taken = this.takeInflight(frame.requestId, "stop", frame.file);
        if (taken === null) return;
        this.transition({ inflight: taken.inflightView, lastResult: { ok: true, kind: "stop", file: frame.file, outcome: frame.outcome } });
        (taken.record.resolve as (outcome: WriteStopOutcomeDTO) => void)(frame.outcome);
        return;
      }
      case "error":
        this.onError(parsed);
        return;
      default:
        // 未知/暂不消费的帧（sessions/snapshot/events/status/recovery/resync-required/pong 及任何陌生 t）安全忽略
        return;
    }
  }

  private onError(v: Record<string, unknown>): void {
    const frame = asErrorFrame(v);
    if (frame === null) return; // R1：畸形 error 帧（未知码/message 缺失等）整帧忽略
    if (frame.code === 4401) {
      // 连接级认证失败：整面终局（在途全部受控拒绝；随后 close 1008 由 onClose 收尾不降级）
      this.failConn("auth-failed", writeFaceErrorText(4401));
      return;
    }
    const conn = this.snapshot.connState;
    if (conn === "connecting" || conn === "authenticating") {
      this.failConn("transport", writeFaceErrorText(frame.code));
      return;
    }
    // 请求级路由：requestId 匹配在途写请求→仅结算该请求（连接保持，其余请求/后续发送不受影响）
    if (frame.requestId !== undefined) {
      const record = this.inflight.get(frame.requestId);
      if (record !== undefined) {
        const message = writeFaceErrorText(frame.code);
        this.inflight.delete(frame.requestId);
        this.transition({
          inflight: this.snapshot.inflight.filter((e) => !(e.file === record.file && e.kind === record.kind)),
          lastResult: { ok: false, kind: record.kind, file: record.file, message },
        });
        record.reject(new WriteSendError("server", message, frame.code));
        return;
      }
      // requestId 无关联（迟到/已结算/陌生）→落入下方连接级判定或忽略
    }
    // C5 同口径：ready 后无 requestId 关联的连接级码（4403/4405/4432）→连接级失败（受控文案按 code）。
    // 注：写面 4405（未开放写 t）服务端随后 close 1008——在途已由本分支或下一分支拒绝，onClose 只收尾连接态。
    if (frame.requestId === undefined && (frame.code === 4403 || frame.code === 4405 || frame.code === 4432)) {
      this.failConn("transport", writeFaceErrorText(frame.code));
      return;
    }
    // 其余无关联请求的 error 帧安全忽略
  }

  private onClose(code: number): void {
    if (this.stopped) return; // 停止屏障：close() 后迟到关闭事件零副作用
    const conn = this.snapshot.connState;
    if (conn === "closed" || conn === "error") return; // auth-failed/transport 不降级
    if (code === 1008 && (conn === "connecting" || conn === "authenticating")) {
      this.failConn("auth-failed", "认证失败（连接被 1008 关闭）");
      return;
    }
    // 连接终局：在途统一 transport 受控拒绝（服务端连接同断，无结算窗口）
    this.settleAllInflight(new WriteSendError("transport", "连接已断开，请求未完成"));
    this.transition({ connState: "closed" }); // 无自动重连
  }

  /** 连接级错误出口：在途统一受控拒绝（WriteSendError.kind 恒 transport=连接级成因；4401 细分仅逃入
   * 快照 errorKind，供视图区分认证失败与传输失败）+终态文案进快照。 */
  private failConn(errorKind: "auth-failed" | "transport", errorMessage: string): void {
    this.settleAllInflight(new WriteSendError("transport", errorMessage));
    this.transition({ connState: "error", errorKind, errorMessage });
  }

  private transition(patch: Partial<WriteSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}

/** UTF-8 字节数（与 contracts.ts byteLength 同算法：无需 Buffer，浏览器安全）。 */
function utf8Bytes(s: string): number {
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

/** 组件/hook 所需客户端面（subscribe/getSnapshot 对齐 useSyncExternalStore；sendPrompt/sendStop 为写动作）。 */
export type WriteClientSurface = Pick<WriteClient, "subscribe" | "getSnapshot" | "sendPrompt" | "sendStop">;
