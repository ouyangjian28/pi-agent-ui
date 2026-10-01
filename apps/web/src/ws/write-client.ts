// A1c 写面 WebSocket 客户端（归属整改重写：本文件由 Kimi 亲手重写，语义对照契约
// docs/ws-ui-contracts-v1.md 写侧段与 K5 修复批（da23cce）逐项保真——重写非返工，
// 已修复的阻断语义一律不回退）。
// 职责：独立第三连接（每面一连接：列表/详情/写三面各持一 socket，服务端网关同连接混受理读写帧——
// 本面不侵入订阅面 socket）。hello 握手→welcome 后受理 prompt/stop 发送，按 requestId 关联
// write-ack/write-stop-ack/error 帧并把每次请求 promise 化（resolve=outcome DTO / reject=WriteSendError）。
//
// 保真清单（重写锚点，对应派单六条）：
// ①出帧类型层封闭：OutgoingFrame 联合型只含 hello/prompt/stop——未开放的写类 t 在类型层即无从构造
//   （服务端侧一律 4405）；
// ②requestId 关联定账：ack/stop-ack/error 只结算 requestId 匹配的在途请求；ack 另做 kind×file 回显
//   交叉验证（回显不符=畸形关联，零消费）；错配帧（无关联/迟到/已结算）一律零副作用——在途请求只由
//   合法 ack、匹配 error、连接终局三途结算，宁可等待也不被畸形帧强制定局；
// ③消费帧先过运行时形状门（parse* 系列，文件内私有纯函数）：welcome/write-ack/write-stop-ack/error
//   及 outcome DTO 全域校验；坏帧=零副作用（不消费在途、不改快照），后续合法帧照常受理；
// ④本地预校验零帧成本：file 过 LIMITS.filePattern、text 非空、UTF-8 字节数 ≤ WRITE_TEXT_MAX_BYTES
//   （64KiB；TextEncoder 真实编码口径——孤立代理项按 U+FFFD 落 3 字节，与线上发送字节数一致）；
//   同 file 同 kind 在途重复=本地拒（不等服务端 4404 在途门）；prompt 与 stop 同 file 可并行
//   （「发送后立即停止」合法流，服务端按 requestId 分账）；
// ⑤错误文案受控：writeFaceErrorText 按 code 映射本文件文案——远端 error.message 可能回显敏感输入，
//   永不进 promise 拒绝值与 DOM；4402 retryable=true 只是服务端可重试性声明，不授权自动重发
//   （19d 裁决）；连接断开/终局（onclose、close()、连接级 error）在途 promise 统一 reject（受控文案）；
// ⑥close()=不可逆停止屏障：任何状态可关、在途全拒（closed 文案）、迟到回调零副作用、重复调用幂等、
//   此后 connect() 永久拒绝；closed=终态，无自动重连。
// 另：socket.send 同步抛错（K5-C2 传输层损坏面）→受控结算：在途表与快照两份账同步清理
//   （同 file 后续发送不被在途重复门卡死），promise 以受控 transport 错误拒绝。

// 同仓惯例：绕开 barrel 直引自包含 contracts 模块（浏览器安全、零 Node 依赖）。
// LIMITS/WRITE_TEXT_MAX_BYTES 为值导入（filePattern/字节上限冻结源，避免本地复制漂移）。
import { LIMITS, WRITE_TEXT_MAX_BYTES } from "@pi-agent-ui/protocol/src/contracts";
import type {
  ClientFrame,
  ErrorCode,
  ServerFrame,
  WriteClientFrame,
  WriteResumeOutcomeDTO,
  WriteSendOutcomeDTO,
  WriteStopOutcomeDTO,
} from "@pi-agent-ui/protocol/src/contracts";

/** 本客户端允许发送的帧（握手 hello+写面三帧 prompt/stop/resume；其余客户端帧类型层不可达）。 */
type OutgoingFrame = Extract<ClientFrame, { readonly t: "hello" }> | WriteClientFrame;

/** 写动作三 kind（在途分账单位：file×kind 唯一；prompt×stop×resume 同 file 可并行）。 */
type WriteOpKind = "prompt" | "stop" | "resume";

/** 连接级五态（同 ws-client 惯例）：connecting→authenticating→ready；任一前置态可落 closed/error。 */
export type WriteConnState = "connecting" | "authenticating" | "ready" | "closed" | "error";

/**
 * 受控失败成因（promise 拒绝值的结构化身份；message 恒为受控文案，不含远端自由文本）：
 * not-ready=连接未就绪即发送；local-invalid=本地预校验拒绝（file/text 域）；in-flight=同 file 同 kind
 * 在途重复；server=error 帧按 requestId 匹配（code 携带服务端码）；transport=连接断开/连接级错误；
 * closed=本端 close()。
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

/** 在途请求（快照视图面）：（file×kind）唯一性由在途表保证。 */
export interface WriteInflightEntry {
  readonly file: string;
  readonly kind: "prompt" | "stop";
}

/** 最近一次已终结请求（快照视图面）：ack 成功携 outcome；失败携受控文案（code 内嵌于文案）。 */
export type WriteLastResult =
  | { readonly ok: true; readonly kind: "prompt"; readonly file: string; readonly outcome: WriteSendOutcomeDTO }
  | { readonly ok: true; readonly kind: "stop"; readonly file: string; readonly outcome: WriteStopOutcomeDTO }
  | { readonly ok: false; readonly kind: "prompt" | "stop"; readonly file: string; readonly message: string };

/** 最近一次已终结恢复重发（快照视图面；独立账不混入 lastResult——resume 面状态自含）。 */
export type WriteResumeResult =
  | { readonly ok: true; readonly file: string; readonly outcome: WriteResumeOutcomeDTO }
  | { readonly ok: false; readonly file: string; readonly message: string };

/** resume 在途态（快照视图面）：idle=无在途（共享常量保引用稳定）；resuming=在途 file 集合
 * （跨 file 可并行，与 file×kind 分账同哲学；空集合即归 idle）。 */
export type WriteResumeState = { readonly phase: "idle" } | { readonly phase: "resuming"; readonly files: readonly string[] };

/**
 * 写面快照（不可变；每次变更整体替换——useSyncExternalStore getSnapshot 缓存语义，未变即引用相等）。
 * inflight/lastResult 驱动 hook 态机与结果展示；errorMessage 只承载受控文案。
 */
export interface WriteSnapshot {
  readonly connState: WriteConnState;
  readonly errorKind: "auth-failed" | "transport" | null;
  readonly errorMessage: string | null;
  /** 在途（file×kind）视图集合；组件卸载不清（服务端状态由用户显式 stop/close 收口）。 */
  readonly inflight: readonly WriteInflightEntry[];
  /** 最近一次已终结请求（null=尚无）。 */
  readonly lastResult: WriteLastResult | null;
  /** resume 在途态（v1.1 恢复重发面；独立账，不混入 inflight——prompt/stop 视图语义不变）。 */
  readonly resumeState: WriteResumeState;
  /** 最近一次已终结恢复重发（null=尚无；含 4409 排队超时等受控失败结果）。 */
  readonly lastResumeResult: WriteResumeResult | null;
}

/** 可注入的 WebSocket 最小面（与 ws-client/subscribe-client 同形；测试用假 socket 顶替）。 */
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

const RESUME_IDLE: WriteResumeState = { phase: "idle" };

const INITIAL_SNAPSHOT: WriteSnapshot = {
  connState: "connecting",
  errorKind: null,
  errorMessage: null,
  inflight: [],
  lastResult: null,
  resumeState: RESUME_IDLE,
  lastResumeResult: null,
};

// ---------------------------------------------------------------------------
// 消费帧运行时形状门（纯函数、文件内私有、零依赖；权威=contracts.ts 写侧段/组5）。
// 畸形=返回 null，调用方整帧忽略（锚点③）。
// ---------------------------------------------------------------------------

/** §5.3 错误码全集（运行时镜像；未登记码=未知帧保守拒绝）。 */
const ERROR_CODES: ReadonlySet<number> = new Set([4401, 4402, 4403, 4404, 4405, 4409, 4413, 4414, 4429, 4431, 4432]);

type WelcomeFrame = Extract<ServerFrame, { readonly t: "welcome" }>;
type ErrorFrame = Extract<ServerFrame, { readonly t: "error" }>;
type WriteAckFrame = Extract<ServerFrame, { readonly t: "write-ack" }>;
type WriteStopAckFrame = Extract<ServerFrame, { readonly t: "write-stop-ack" }>;
type WriteResumeAckFrame = Extract<ServerFrame, { readonly t: "write-resume-ack" }>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isString(v: unknown): v is string {
  return typeof v === "string";
}
function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}
function isNonNegativeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}
function isErrorCode(v: unknown): v is ErrorCode {
  return typeof v === "number" && ERROR_CODES.has(v);
}

/** WriteSendOutcomeDTO（3c-2 收窄版）全域判别校验。 */
function isSendOutcome(v: unknown): v is WriteSendOutcomeDTO {
  if (!isPlainObject(v)) return false;
  switch (v["kind"]) {
    case "launched":
      return isString(v["intentId"]) && isNonNegativeInt(v["commandId"]);
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
      // v1.4（M-OPS）：detail 同源必过门（DS 审 P2-1——cause 有门而 detail 无门的不对称；
      // 畸形 detail 走 React 会「Objects are not valid as a React child」崩渲染）。
      return (v["cause"] === undefined || isString(v["cause"])) && (v["detail"] === undefined || isString(v["detail"]));
    case "identity-rejected": // v1.1：prompt 携代次断言的身份拒（cause 空间仅两枝，勿与 resume 面四枝并集）
      return v["cause"] === "no-recovery-data" || v["cause"] === "generation-mismatch";
    default:
      return false;
  }
}

/** WriteResumeOutcomeDTO 全域判别校验（v1.1 r3b 终形：两失败枝+执行七枝；
 * 执行七枝与 send 面同构——委托 isSendOutcome 复核，两失败枝本地判）。 */
function isResumeOutcome(v: unknown): v is WriteResumeOutcomeDTO {
  if (!isPlainObject(v)) return false;
  switch (v["kind"]) {
    case "identity-rejected":
      return (
        v["cause"] === "no-recovery-data" ||
        v["cause"] === "resume-blocked" ||
        v["cause"] === "resume-not-authorized" ||
        v["cause"] === "generation-mismatch"
      );
    case "execution-failed":
      return v["cause"] === "payload-unavailable";
    default: // 执行七枝：launched/busy/gate-rejected/gate-failed/invalidated/no-process/not-ready
      return isSendOutcome(v);
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
      return (exit["code"] === null || isNonNegativeInt(exit["code"])) && (exit["signal"] === null || isString(exit["signal"]));
    }
    default:
      return false;
  }
}

/** welcome 形状门（同 ws-client）：serverBootId/serverBuildId 必须 string，protocolVersion 字面量 1。 */
function parseWelcome(v: Record<string, unknown>): WelcomeFrame | null {
  if (!isString(v.serverBootId) || !isString(v.serverBuildId) || v.protocolVersion !== 1) return null;
  return { t: "welcome", serverBootId: v.serverBootId, serverBuildId: v.serverBuildId, protocolVersion: 1 };
}

/** error 形状门：code∈锚定码表、message 必须 string（即使不展示也验形）、retryable 必须 boolean。 */
function parseError(v: Record<string, unknown>): ErrorFrame | null {
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

/** write-ack 形状门：requestId/file 必须 string，outcome 全域校验。 */
function parseWriteAck(v: Record<string, unknown>): WriteAckFrame | null {
  if (!isString(v.requestId) || !isString(v.file)) return null;
  if (!isSendOutcome(v.outcome)) return null;
  return { t: "write-ack", requestId: v.requestId, file: v.file, outcome: v.outcome };
}

/** write-stop-ack 形状门：同 write-ack（outcome 换 stop 判别联合）。 */
function parseWriteStopAck(v: Record<string, unknown>): WriteStopAckFrame | null {
  if (!isString(v.requestId) || !isString(v.file)) return null;
  if (!isStopOutcome(v.outcome)) return null;
  return { t: "write-stop-ack", requestId: v.requestId, file: v.file, outcome: v.outcome };
}

/** write-resume-ack 形状门：同 write-ack（outcome 换 resume 判别联合）。 */
function parseWriteResumeAck(v: Record<string, unknown>): WriteResumeAckFrame | null {
  if (!isString(v.requestId) || !isString(v.file)) return null;
  if (!isResumeOutcome(v.outcome)) return null;
  return { t: "write-resume-ack", requestId: v.requestId, file: v.file, outcome: v.outcome };
}

// ---------------------------------------------------------------------------
// 错误文案受控映射（锚点⑤）：code 域封闭=内嵌安全；远端 message 仅服务端审计用，前端不留存。
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
interface PendingWrite {
  readonly file: string;
  readonly kind: WriteOpKind;
  readonly resolve: (outcome: never) => void; // 泛型在 Map 存储处擦除；结算入口按 kind 分派强类型
  readonly reject: (error: WriteSendError) => void;
}

export class WriteClient {
  private socket: WebSocketLike | null = null;
  private snapshot: WriteSnapshot = INITIAL_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  /** 不可逆停止位（锚点⑥）：close() 置位后一切回调零副作用、connect() 永久拒绝、重复 close 幂等。 */
  private stopped = false;
  private reqSeq = 0;
  private readonly pending = new Map<string, PendingWrite>();

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
      this.emit({ t: "hello", protocolVersion: 1, token: this.token });
      this.publish({ connState: "authenticating" });
    };
    socket.onmessage = (event) => this.handleMessage(event.data);
    socket.onerror = () => {
      if (this.stopped) return; // ws 语义：error 事件后必跟 close；状态迁移归 onclose 统一出口
    };
    socket.onclose = (event) => this.handleClose(event.code);
  }

  /**
   * 发送 prompt（§B16：prompt{requestId,file,text}→write-ack{outcome}；v1.4 M-OPS 可选 model 域；
   * v1.5 批A 可选 cwd 域）。
   * 本地预校验（不满足即本地拒、零帧成本）：连接 ready；file 过 filePattern（服务端同判 4404）；
   * text 非空且 UTF-8 ≤ WRITE_TEXT_MAX_BYTES（服务端同判 4404）；同 file 无在途 prompt；
   * model（提供时）过 LIMITS.modelPattern（^[\w./:-]{1,128}$ 精确 id 非 glob，服务端同判 4404）——
   *   undefined=不改会话模型（帧不携 model 键，v1 帧形兼容）。
   * cwd（v1.5，提供时）须为非空绝对路径（/ 开头；服务端同判 roots 域内+目录存在，越界 4404）——
   *   仅会话首次 prompt 采纳（会话寿命内 cwd 固定，后续携带被服务端忽略）；undefined=帧不携 cwd 键。
   * 不排队：未就绪/预校验失败即受控拒绝，由用户显式重发（无自动重发）。
   */
  sendPrompt(file: string, text: string, model?: string, cwd?: string, options?: import("@pi-agent-ui/protocol/src/composer-input").ComposerPromptOptions): Promise<WriteSendOutcomeDTO> {
    return this.launch("prompt", file, text, model, cwd, options) as Promise<WriteSendOutcomeDTO>;
  }

  /** 发送 stop（§B16：stop{requestId,file}→write-stop-ack{outcome}）。与同 file 在途 prompt 可并行。 */
  sendStop(file: string): Promise<WriteStopOutcomeDTO> {
    return this.launch("stop", file) as Promise<WriteStopOutcomeDTO>;
  }

  /**
   * 恢复重发（v1.1 §10.1：resume{requestId,file,intentId,generation}→write-resume-ack{outcome}）。
   * 本地预校验（不满足即本地拒、零帧成本）：连接 ready；file 过 filePattern；intentId 过
   * LIMITS.intentIdPattern（^\w-]{1,64}$，服务端同判 4404）；generation 为正整数（UI 默认 1）；
   * 同 file 无在途 resume。不排队不自动重发：4409 排队超时等失败由用户显式重试。
   * 快照口径：在途记 resumeState=resuming{file}（独立账）；结算记 lastResumeResult
   * （成功=outcome DTO；失败=受控文案）。
   */
  resume(file: string, intentId: string, generation: number): Promise<WriteResumeOutcomeDTO> {
    if (this.stopped) {
      return Promise.reject(new WriteSendError("closed", "写连接已关闭，请求未完成"));
    }
    if (this.snapshot.connState !== "ready") {
      return Promise.reject(new WriteSendError("not-ready", "写连接未就绪，暂不能发送"));
    }
    if (!LIMITS.filePattern.test(file)) {
      return Promise.reject(new WriteSendError("local-invalid", "文件名非法，无法发送"));
    }
    if (!LIMITS.intentIdPattern.test(intentId)) {
      return Promise.reject(new WriteSendError("local-invalid", "意图标识非法，无法恢复重发"));
    }
    if (!Number.isSafeInteger(generation) || generation < 1) {
      return Promise.reject(new WriteSendError("local-invalid", "进程代次非法（须为正整数），无法恢复重发"));
    }
    if (this.snapshot.resumeState.phase === "resuming" && this.snapshot.resumeState.files.includes(file)) {
      return Promise.reject(new WriteSendError("in-flight", "恢复重发已在途，请等待结果"));
    }
    const requestId = this.nextRequestId("resume");
    return new Promise<WriteResumeOutcomeDTO>((resolve, reject) => {
      // 占位先于发帧（同 launch 口径：同步占位防同刻重入）
      this.pending.set(requestId, { file, kind: "resume", resolve: resolve as (outcome: never) => void, reject });
      const cur = this.snapshot.resumeState;
      this.publish({ resumeState: { phase: "resuming", files: cur.phase === "resuming" ? [...cur.files, file] : [file] } });
      try {
        this.emit({ t: "resume", requestId, file, intentId, generation });
      } catch {
        // K5-C2 同口径：socket.send 同步抛错→受控结算：出表+resumeState/lastResumeResult 同步清理
        this.pending.delete(requestId);
        const error = new WriteSendError("transport", "发送失败：连接传输异常");
        this.publish({ resumeState: this.resumeStateWithout(file), lastResumeResult: { ok: false, file, message: error.message } });
        reject(error);
      }
    });
  }

  /** resume 在途集合减 file（空即归 idle 共享常量）；调用方把结果并入同一次 publish。 */
  private resumeStateWithout(file: string): WriteResumeState {
    const cur = this.snapshot.resumeState;
    if (cur.phase !== "resuming") return cur;
    const files = cur.files.filter((f) => f !== file);
    return files.length === 0 ? RESUME_IDLE : { phase: "resuming", files };
  }

  /**
   * 主动关闭（锚点⑥）：立即置不可逆停止位并物理释放 socket（未 connect/connecting/error 均可关）。
   * 在途请求统一以 closed 受控文案拒绝（服务端连接同断，无迟到结算窗口）；error 态保留错误文案。
   */
  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.rejectAllPending(new WriteSendError("closed", "写连接已关闭，请求未完成"));
    if (this.snapshot.connState !== "closed" && this.snapshot.connState !== "error") {
      this.publish({ connState: "closed" });
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
  // 内部：派发与在途记账
  // -------------------------------------------------------------------------

  private nextRequestId(kind: WriteOpKind): string {
    this.reqSeq += 1;
    const prefix = ({ prompt: "p", stop: "s", resume: "r" } as const)[kind];
    return `wr-${prefix}-${this.reqSeq}`; // §5.7 requestIdPattern=/^[\w-]{1,64}$/
  }

  /** 出帧（停止屏障后/无连接/非 OPEN 一律静默不发——调帧处已先行本地拒绝，此处为迟到防御）。 */
  private emit(frame: OutgoingFrame): void {
    if (this.stopped) return;
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) return;
    socket.send(JSON.stringify(frame));
  }

  /** prompt/stop 共用派发：本地预校验（锚点④）→占位→发帧；resolve/reject 经在途表按 requestId 结算。 */
  private launch(kind: "prompt" | "stop", file: string, text?: string, model?: string, cwd?: string, options?: import("@pi-agent-ui/protocol/src/composer-input").ComposerPromptOptions): Promise<unknown> {
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
      if (options?.thinkingLevel !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(options.thinkingLevel)) {
        return Promise.reject(new WriteSendError("local-invalid", "思考级别非法，未发送"));
      }
      // Attachment wiring is separate: never quietly turn an image request into text-only.
      if (options?.attachments?.length) {
        return Promise.reject(new WriteSendError("local-invalid", "附件发送通道尚未接通，未发送"));
      }
      // v1.4（M-OPS）：可选 model 域本地预校验（LIMITS.modelPattern 精确 id；服务端同判 4404）。
      // undefined=不改会话模型；空串/越字符集/超长一律本地拒（零帧成本）。
      if (model !== undefined && !LIMITS.modelPattern.test(model)) {
        return Promise.reject(new WriteSendError("local-invalid", "模型标识非法，未发送"));
      }
      // v1.5（批A）：可选 cwd 域本地预校验（非空绝对路径；roots 域内+目录存在由服务端 4404 把关）。
      if (cwd !== undefined && (cwd.length === 0 || !cwd.startsWith("/"))) {
        return Promise.reject(new WriteSendError("local-invalid", "项目目录非法（须为绝对路径），未发送"));
      }
    }
    const duplicate = this.snapshot.inflight.some((e) => e.file === file && e.kind === kind);
    if (duplicate) {
      const message = kind === "prompt" ? "该会话已有发送中的消息，请等待结果" : "停止请求已在途，请等待结果";
      return Promise.reject(new WriteSendError("in-flight", message));
    }
    const requestId = this.nextRequestId(kind);
    return new Promise<unknown>((resolve, reject) => {
      // 占位先于发帧（同步占位防同刻重入漏判在途重复）；快照 inflight 视图随 publish 通知
      this.pending.set(requestId, { file, kind, resolve: resolve as (outcome: never) => void, reject });
      this.publish({ inflight: [...this.snapshot.inflight, { file, kind }] });
      try {
        if (kind === "prompt") {
          // v1.4（M-OPS）：model 仅提供时携键；v1.5（批A）：cwd 同口径（undefined 不出帧——
          // v1 四字段严格形兼容缺省面；会话寿命内 cwd 固定，仅首建采纳）
          this.emit({
            t: "prompt",
            requestId,
            file,
            text: text as string,
            ...(model === undefined ? {} : { model }),
            ...(cwd === undefined ? {} : { cwd }),
            ...(options?.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
          });
        } else {
          this.emit({ t: "stop", requestId, file });
        }
      } catch {
        // K5-C2：socket.send 同步抛错（传输层损坏/注入面异常）→受控结算：出表+快照 inflight/lastResult
        // 同步清理（两份账一致，同 file 后续发送不被在途重复门卡死），promise 以受控 transport 错误拒绝
        //（不让 Promise executor 的裸异常成为未受控拒绝值）。
        this.pending.delete(requestId);
        const error = new WriteSendError("transport", "发送失败：连接传输异常");
        this.publish({
          inflight: this.snapshot.inflight.filter((e) => !(e.file === file && e.kind === kind)),
          lastResult: { ok: false, kind, file, message: error.message },
        });
        reject(error);
      }
    });
  }

  /** 定位并出表匹配的在途请求（锚点②：requestId 唯一定账+kind/file 三重交叉验证）；不匹配=零副作用
   * 返回 null（在途表与快照均不动——畸形关联帧不消费在途，等合法 ack/匹配 error/连接终局结算）。
   * 不做快照变更：调用方把 inflightView 并入同一次 publish（一次结算=一次通知）。 */
  private takePending(requestId: string, kind: WriteOpKind, file: string): { entry: PendingWrite; inflightView: readonly WriteInflightEntry[] } | null {
    const entry = this.pending.get(requestId);
    if (entry === undefined) return null;
    if (entry.kind !== kind || entry.file !== file) return null; // ② kind/file 回显不一致=畸形关联，零消费
    this.pending.delete(requestId);
    const inflightView = this.snapshot.inflight.filter((e) => !(e.file === file && e.kind === kind));
    return { entry, inflightView };
  }

  /** 全量结算（连接终局，锚点⑤）：出表+快照先行，回调最后（拒绝回调内不重入读写面状态）；
   * 结算顺序=Map 插入序。 */
  private rejectAllPending(error: WriteSendError): void {
    if (this.pending.size === 0) return;
    const entries = [...this.pending.values()];
    this.pending.clear();
    let lastResult: WriteLastResult | null = this.snapshot.lastResult;
    let lastResumeResult: WriteResumeResult | null = this.snapshot.lastResumeResult;
    let hadResume = false;
    for (const entry of entries) {
      if (entry.kind === "resume") {
        hadResume = true;
        lastResumeResult = { ok: false, file: entry.file, message: error.message };
      } else {
        lastResult = { ok: false, kind: entry.kind, file: entry.file, message: error.message };
      }
    }
    this.publish({
      inflight: [],
      lastResult,
      lastResumeResult,
      resumeState: hadResume ? RESUME_IDLE : this.snapshot.resumeState,
    });
    for (const entry of entries) entry.reject(error);
  }

  // -------------------------------------------------------------------------
  // 内部：消费帧处理（锚点②③⑤）
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
    if (!isPlainObject(parsed)) return;
    switch (parsed.t) {
      case "welcome": {
        if (conn !== "authenticating") return; // 重复 welcome 幂等忽略
        if (parseWelcome(parsed) === null) return; // ③ 缺字段/版本不符=未知帧，不得算握手成功
        this.publish({ connState: "ready" });
        return;
      }
      case "write-ack": {
        const frame = parseWriteAck(parsed);
        if (frame === null) return; // ③ 畸形整帧忽略（不消费在途；合法帧可恢复结算）
        const taken = this.takePending(frame.requestId, "prompt", frame.file);
        if (taken === null) return; // ② 无关联/迟到/回显不符：零消费（在途保留）
        this.publish({ inflight: taken.inflightView, lastResult: { ok: true, kind: "prompt", file: frame.file, outcome: frame.outcome } });
        (taken.entry.resolve as (outcome: WriteSendOutcomeDTO) => void)(frame.outcome);
        return;
      }
      case "write-stop-ack": {
        const frame = parseWriteStopAck(parsed);
        if (frame === null) return;
        const taken = this.takePending(frame.requestId, "stop", frame.file);
        if (taken === null) return;
        this.publish({ inflight: taken.inflightView, lastResult: { ok: true, kind: "stop", file: frame.file, outcome: frame.outcome } });
        (taken.entry.resolve as (outcome: WriteStopOutcomeDTO) => void)(frame.outcome);
        return;
      }
      case "write-resume-ack": {
        const frame = parseWriteResumeAck(parsed);
        if (frame === null) return; // ③ 畸形整帧忽略（不消费在途；合法帧可恢复结算）
        const taken = this.takePending(frame.requestId, "resume", frame.file);
        if (taken === null) return; // ② 无关联/迟到/回显不符：零消费（在途保留）
        this.publish({
          resumeState: this.resumeStateWithout(frame.file),
          lastResumeResult: { ok: true, file: frame.file, outcome: frame.outcome },
        });
        (taken.entry.resolve as (outcome: WriteResumeOutcomeDTO) => void)(frame.outcome);
        return;
      }
      case "error":
        this.handleError(parsed);
        return;
      default:
        // 未知/暂不消费的帧（sessions/snapshot/events/status/recovery/resync-required/pong 及任何陌生 t）安全忽略
        return;
    }
  }

  private handleError(v: Record<string, unknown>): void {
    const frame = parseError(v);
    if (frame === null) return; // ③ 畸形 error 帧（未知码/message 缺失等）整帧忽略
    if (frame.code === 4401) {
      // 连接级认证失败：整面终局（在途全部受控拒绝；随后 close 1008 由 handleClose 收尾不降级）
      this.failConnection("auth-failed", writeFaceErrorText(4401));
      return;
    }
    const conn = this.snapshot.connState;
    if (conn === "connecting" || conn === "authenticating") {
      this.failConnection("transport", writeFaceErrorText(frame.code));
      return;
    }
    // 请求级路由（锚点②）：requestId 匹配在途写请求→仅结算该请求（连接保持，其余请求/后续发送不受影响）。
    // 关联判定口径（对齐 K4 subscribe-client 已修语义）：undefined 或空串""均视为「不关联任何请求」——
    // 现役网关对连接级码（4403/4405/4432 心跳终局等）统一发 requestId:""（ws-gateway 心跳出口）；
    // 非空陌生 requestId（迟到/已结算/无关）仍不升格连接错误，落入末尾安全忽略。
    const connEnvelope = frame.requestId === undefined || frame.requestId === "";
    if (!connEnvelope) {
      const entry = this.pending.get(frame.requestId);
      if (entry !== undefined) {
        // §10.1：resume 读链 ComputeSemaphore 排队超时以 error 4409 retryable 到（非 write-resume-ack）——
        // 闸忙非硬错：记「计算排队超时，可重试」受控结果，用户可显式重试（不自动重发）。
        const message =
          entry.kind === "resume" && frame.code === 4409 ? "计算排队超时，可重试（4409）" : writeFaceErrorText(frame.code);
        this.pending.delete(frame.requestId);
        if (entry.kind === "resume") {
          this.publish({ resumeState: this.resumeStateWithout(entry.file), lastResumeResult: { ok: false, file: entry.file, message } });
        } else {
          this.publish({
            inflight: this.snapshot.inflight.filter((e) => !(e.file === entry.file && e.kind === entry.kind)),
            lastResult: { ok: false, kind: entry.kind, file: entry.file, message },
          });
        }
        entry.reject(new WriteSendError("server", message, frame.code));
        return;
      }
      // requestId 无关联（迟到/已结算/陌生）→落入下方连接级判定或忽略
    }
    // C5 同口径：ready 后无 requestId 关联的连接级码（4403/4405/4432）→连接级失败（受控文案按 code）。
    // 注：写面 4405（未开放写 t）服务端随后 close 1008——在途已由本分支或下一分支拒绝，handleClose 只收尾连接态。
    if (connEnvelope && (frame.code === 4403 || frame.code === 4405 || frame.code === 4432)) {
      this.failConnection("transport", writeFaceErrorText(frame.code));
      return;
    }
    // 其余无关联请求的 error 帧安全忽略
  }

  private handleClose(code: number): void {
    if (this.stopped) return; // 停止屏障：close() 后迟到关闭事件零副作用
    const conn = this.snapshot.connState;
    if (conn === "closed" || conn === "error") return; // auth-failed/transport 不降级
    if (code === 1008 && (conn === "connecting" || conn === "authenticating")) {
      this.failConnection("auth-failed", "认证失败（连接被 1008 关闭）");
      return;
    }
    // 连接终局（锚点⑤）：在途统一 transport 受控拒绝（服务端连接同断，无结算窗口）
    this.rejectAllPending(new WriteSendError("transport", "连接已断开，请求未完成"));
    this.publish({ connState: "closed" }); // 无自动重连
  }

  /** 连接级错误出口：在途统一受控拒绝（WriteSendError.kind 恒 transport=连接级成因；4401 细分仅逃入
   * 快照 errorKind，供视图区分认证失败与传输失败）+终态文案进快照。 */
  private failConnection(errorKind: "auth-failed" | "transport", errorMessage: string): void {
    this.rejectAllPending(new WriteSendError("transport", errorMessage));
    this.publish({ connState: "error", errorKind, errorMessage });
  }

  private publish(patch: Partial<WriteSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}

/** UTF-8 字节数（K5-B4：标准 TextEncoder 计数）。WHATWG 编码流会把孤立代理项按 U+FFFD 落 3 字节，
 * 与 TextEncoder.encode 的线上真实字节数一致；此前手写循环把一切高代理项当合法代理对计 4 字节并吞掉
 * 下一 code unit，超限文本可漏拒。与 contracts.ts byteLength 的旧快算法有意分歧：写面预校验以真实
 * 线上字节为准（协议侧同形算法不在本片回改范围）。 */
const utf8Encoder = new TextEncoder();
function utf8Bytes(s: string): number {
  return utf8Encoder.encode(s).length;
}

/** 组件/hook 所需客户端面（subscribe/getSnapshot 对齐 useSyncExternalStore；sendPrompt/sendStop/resume 为写动作）。 */
export type WriteClientSurface = Pick<WriteClient, "subscribe" | "getSnapshot" | "sendPrompt" | "sendStop" | "resume">;
