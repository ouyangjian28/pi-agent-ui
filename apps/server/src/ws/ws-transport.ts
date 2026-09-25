// 3b-1 真 WS 传输适配层（GPT 3b-0 对齐裁定 §IV.A/B 冻结签名）——
// 监听（WsTransportPort）与连接（WsConnectionPort）分立；网关面向端口编程，ws 库类型不进网关。
// - send(text, done)：done 绑定 ws.send 完成回调（禁止 send 返回即兑现）；未抛出时回调至多一次；连接故障走终止清理。
// - bufferedAmount/readyState：透传 ws 实时值，不缓存不伪造。
// - close(code,reason)：控制帧走 ws.close；reason 固定短文本（≤123 字节，UTF-8 字节界安全截断）；close 握手有截止（超时 terminate）。
// - transport ping/pong：连接活性控制帧（与应用 ping 请求应答分层，§IV.D：无新增独立杀手 timer——活性判定归网关 lastFrameAt）。
// - upgrade 前拒绝=HTTP 403（Origin 白名单/安全元数据不合格在 handleUpgrade 前；GPT §IV.B）——不是 WebSocket close，无应用帧。
// - 接收硬门：maxPayload 固定=LIMITS.transportMaxPayloadBytes（1MiB 重组兜底，超限 ws close 1009；契约例外条款=docs §5.1/§5.3）。
//   R03（GPT 3b-1）：公开构造不可放宽/收窄接收门——上限属冻结契约常量，非部署参数。
// - permessage-deflate 禁用（压缩面另审）。
// - 资源释放恰一次：主动 close/远端 close/RST/error/send 回调失败/dispose 可竞争；dispose 停新 upgrade+存量 1001 有界收口。
// - R01（GPT 3b-1）：全部向宿主回调的出口（message/pong/error/close/send-done/onConnection）异常隔离——
//   宿主回调抛错不得退进程，只产生审计行；连接终局与注册表回收不受影响。
// - R02（GPT 3b-1）：dispose 整体有界——自建 server 管 request（404 Connection:close）+全部 socket（含未升级），收口截止后强制销毁；
//   listen() 终态后拒绝（不得复活监听）；ws closeTimeout 与 closeHandshakeMs 统一（接收器自启关闭同截止）。
// - 外部注入 HTTP server 的关闭所有权归调用方（dispose 只摘 upgrade 监听）；自建 server（port 模式）由 dispose 关闭。
// - trustProxy 默认 false：不采信 X-Forwarded-*；启用须给可信代理精确来源，仅当 socket 对端在列时按头派生有效 clientIp/tls（§IV.B）。
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Socket } from "node:net";
import { TLSSocket } from "node:tls";
import { createServer, type Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { LIMITS } from "@pi-agent-ui/protocol";
import type { ConnMeta } from "./ws-gateway.ts";

export type Off = () => void;
export type SendDone = (err?: Error | null) => void;

/** 传输连接端口（§IV.A 冻结）：网关/队列面向此接口，不 import ws 类型。 */
export interface WsConnectionPort {
  readonly readyState: 0 | 1 | 2 | 3;
  readonly bufferedAmount: number; // 实时 ws 值（bytes）
  send(text: string, done: SendDone): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(): void;
  onMessage(cb: (text: string, isBinary: boolean) => void): Off;
  onPong(cb: () => void): Off;
  onClose(cb: (code: number) => void): Off;
  onError(cb: (err: Error) => void): Off;
}

/** 监听端口（§IV.A 冻结）：连接级端口由此派发，元数据由真请求派生（不得用随意布尔代表网络事实）。 */
export interface WsTransportPort {
  onConnection(cb: (conn: WsConnectionPort, meta: TransportConnMeta) => void): Off;
  dispose(): Promise<void>;
}

/** 安全元数据（真请求派生）：origin 精确白名单输入；loopback=有效客户端地址判定；tls=有效协议判定（可信代理下按转发头）。 */
export interface TransportConnMeta {
  readonly origin: string | null; // null=缺失/多值/非法（upgrade 前即拒）
  readonly loopback: boolean;
  readonly tls: boolean;
  readonly clientIp: string; // 有效客户端地址（trustProxy 时=左 XFF，否则=socket 对端）
  readonly remoteAddress: string; // socket 对端（代理审计分立）
  readonly proxied: boolean;
}

export interface WsServerAdapterOpts {
  /** 精确 Origin 白名单（全等匹配；不含子串）。 */
  readonly allowedOrigins: readonly string[];
  /** 非 loopback 须 TLS（默认 true；宿主策略，非客户端可关）。 */
  readonly requireTlsOffLoopback?: boolean;
  /** 外部 HTTP(S) server（所有权=调用方；dispose 只摘监听不关 server）。与 port 二选一。 */
  readonly server?: HttpServer;
  /** 自建监听（所有权=本适配器；dispose 关闭）。默认 127.0.0.1:0。与 server 二选一。 */
  readonly port?: number;
  readonly host?: string;
  /** 可信代理精确来源（IP 列表）；非空才采信 X-Forwarded-For/Proto（默认 []=不采信任何转发头）。 */
  readonly trustedProxies?: readonly string[];
  readonly closeHandshakeMs?: number; // close 握手截止（默认 5000；超时 terminate；同时作为 ws closeTimeout）
  readonly disposeWaitMs?: number; // dispose 存量收口等待（默认 5000）
  readonly audit?: (line: string) => void;
}

const DEFAULT_CLOSE_HANDSHAKE_MS = 5_000;
const DEFAULT_DISPOSE_WAIT_MS = 5_000;

function isLoopbackIp(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function headerSingle(v: string | string[] | undefined): string | null {
  if (v === undefined) return null;
  if (Array.isArray(v)) return null; // 多值/重复=歧义，默认拒
  const t = v.trim();
  return t.length === 0 ? null : t;
}

/** UTF-8 字节界安全截断（🟡GPT 3b-1：slice(0,123) 是 UTF-16 代码单元，多字节字符会劈开抛错/替换符）。 */
function byteTruncate(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return text;
  let end = maxBytes;
  // 回退到合法 UTF-8 序列边界（10xxxxxx 前缀字节不得作起点）
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString("utf8");
}

/** 从真实请求派生安全元数据（§IV.B：Origin/远端地址/TLS 都来自请求事实；代理头仅在可信来源时生效）。 */
export function deriveConnMeta(req: IncomingMessage, socket: Duplex, trustedProxies: readonly string[] = []): TransportConnMeta {
  const rawOrigin = headerSingle(req.headers.origin);
  const origin = rawOrigin !== null && rawOrigin.toLowerCase() !== "null" ? rawOrigin : null;
  const remote = (socket as Socket).remoteAddress ?? "unknown";
  const sockTls = socket instanceof TLSSocket && socket.encrypted === true;
  const trusted = trustedProxies.length > 0 && trustedProxies.includes(remote);
  if (!trusted) {
    return { origin, loopback: isLoopbackIp(remote), tls: sockTls, clientIp: remote, remoteAddress: remote, proxied: false };
  }
  // 可信代理：XFF 左端=有效客户端；XFP 决定有效协议（回程 TLS 与外部协议分立：proxied=true 时 tls=XFP 事实，头缺失保守 false 不回退 socket TLS）
  // 部署约束（契约 §5.5 代理头信任边界）：可信代理必须在转发时覆盖/清洗 XFF/XFP（用户可控追加链不得当身份）；多级代理逐跳配置信任边界
  const xff = headerSingle(req.headers["x-forwarded-for"]);
  const clientIp = xff !== null ? (xff.split(",")[0] ?? "").trim() : remote;
  const effectiveIp = clientIp.length > 0 ? clientIp : remote;
  const xfp = headerSingle(req.headers["x-forwarded-proto"]);
  return { origin, loopback: isLoopbackIp(effectiveIp), tls: xfp?.toLowerCase() === "https", clientIp: effectiveIp, remoteAddress: remote, proxied: true };
}

/** 3b-2：传输元数据→网关连接元数据（clientIp 真接线——R6 per-IP 限流键不退 "unknown"）。
 * 供组装层（3b-3）在 onConnection 里调用；这是传输层与网关层之间的唯一映射点。 */
export function gatewayMetaFrom(meta: TransportConnMeta): ConnMeta {
  return meta.origin !== null
    ? { origin: meta.origin, loopback: meta.loopback, tls: meta.tls, clientIp: meta.clientIp }
    : { loopback: meta.loopback, tls: meta.tls, clientIp: meta.clientIp };
}

/** 单连接适配：ws.WebSocket → WsConnectionPort（生命周期错误吸收；释放恰一次）。 */
class WsConnectionAdapter implements WsConnectionPort {
  private disposed = false;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly closeCallbacks: Array<(code: number) => void> = [];
  private closedFired = false;
  private lastCloseCode = 1006;

  constructor(private readonly ws: WebSocket, private readonly meta: TransportConnMeta, private readonly connId: string, private readonly audit: (l: string) => void, private readonly closeHandshakeMs: number) {
    this.ws.on("close", (code: number) => {
      if (this.closedFired) return;
      this.closedFired = true;
      this.lastCloseCode = code;
      this.clearCloseTimer();
      const cbs = [...this.closeCallbacks];
      this.closeCallbacks.length = 0; // 终态清理（🟡5：触发后清空；晚到注册=立即回放）
      for (const cb of cbs) {
        try { cb(code); } catch (err) { this.audit(`ws-transport conn-close-cb-error conn=${this.connId} err=${String(err)}`); }
      }
    });
    this.ws.on("error", (err: Error) => {
      // 连接级错误吸收：socket 故障随后必到 close（ws 保证）；此处仅审计，不向上抛
      this.audit(`ws-transport conn-error conn=${this.connId} name=${err.name}`);
    });
  }

  get readyState(): 0 | 1 | 2 | 3 { return this.ws.readyState as 0 | 1 | 2 | 3; }
  get bufferedAmount(): number { return this.ws.bufferedAmount; }

  send(text: string, done: SendDone): void {
    if (this.closedFired || this.ws.readyState !== 1) {
      try { done(new Error("连接已关闭，拒绝发送")); } catch (err) { this.audit(`ws-transport send-done-cb-error conn=${this.connId} err=${String(err)}`); }
      return;
    }
    try {
      this.ws.send(text, { fin: true }, (err) => {
        // ws 完成回调（错误=未交付/连接故障）；至多一次
        try { done(err ?? null); } catch (cbErr) { this.audit(`ws-transport send-done-cb-error conn=${this.connId} err=${String(cbErr)}`); }
      });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      try { done(e); } catch (cbErr) { this.audit(`ws-transport send-done-cb-error conn=${this.connId} err=${String(cbErr)}`); }
    }
  }

  close(code?: number, reason?: string): void {
    if (this.disposed || this.closedFired) return;
    this.disposed = true;
    try { this.ws.close(code, reason !== undefined ? byteTruncate(reason, 123) : undefined); } catch { this.ws.terminate(); }
    this.armCloseDeadline(code ?? 1000);
  }

  terminate(): void {
    if (this.closedFired) return;
    this.disposed = true;
    this.clearCloseTimer();
    this.ws.terminate();
  }

  ping(): void {
    if (this.ws.readyState === 1) {
      try { this.ws.ping(); } catch { /* 已关连接的 ping=无操作 */ }
    }
  }

  onMessage(cb: (text: string, isBinary: boolean) => void): Off {
    const h = (data: unknown, isBinary: boolean): void => {
      try {
        if (isBinary) { cb("", true); return; } // binary 不解码文本（网关按协议违规拒）
        const text = typeof data === "string" ? data : Buffer.from(data as ArrayBufferLike).toString("utf8");
        cb(text, false);
      } catch (err) {
        // R01：宿主消息回调异常隔离——不退进程；连接由宿主语义（网关计数/心跳）自行处置
        this.audit(`ws-transport message-cb-error conn=${this.connId} err=${String(err)}`);
      }
    };
    this.ws.on("message", h);
    return () => { this.ws.off("message", h); };
  }

  onPong(cb: () => void): Off {
    const h = (): void => {
      try { cb(); } catch (err) { this.audit(`ws-transport pong-cb-error conn=${this.connId} err=${String(err)}`); }
    };
    this.ws.on("pong", h);
    return () => { this.ws.off("pong", h); };
  }

  onClose(cb: (code: number) => void): Off {
    if (this.closedFired) {
      try { cb(this.lastCloseCode); } catch (err) { this.audit(`ws-transport conn-close-cb-error conn=${this.connId} err=${String(err)}`); }
      return () => { /* 终态后注册=立即回放一次，无挂载 */ };
    }
    this.closeCallbacks.push(cb);
    return () => {
      const i = this.closeCallbacks.indexOf(cb);
      if (i >= 0) this.closeCallbacks.splice(i, 1);
    };
  }

  onError(cb: (err: Error) => void): Off {
    const h = (err: Error): void => {
      try { cb(err); } catch (cbErr) { this.audit(`ws-transport error-cb-error conn=${this.connId} err=${String(cbErr)}`); }
    };
    this.ws.on("error", h);
    return () => { this.ws.off("error", h); };
  }

  get isOpen(): boolean { return !this.closedFired; }

  private armCloseDeadline(code: number): void {
    if (this.closeTimer !== null) return;
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null;
      if (!this.closedFired) {
        this.audit(`ws-transport close-handshake-deadline conn=${this.connId} code=${code} → terminate`);
        this.ws.terminate();
      }
    }, this.closeHandshakeMs);
    this.closeTimer.unref?.();
  }

  private clearCloseTimer(): void {
    if (this.closeTimer !== null) { clearTimeout(this.closeTimer); this.closeTimer = null; }
  }
}

/** 真监听适配：ws 库（noServer+手动 upgrade）→ WsTransportPort。 */
export class WsServerAdapter implements WsTransportPort {
  private readonly conns = new Map<string, WsConnectionAdapter>();
  private connSeq = 0;
  private disposed = false;
  private readonly wss: WebSocketServer;
  private readonly ownServer: HttpServer | null;
  /** 自建模式：本适配器管理的全部 socket（含未升级 HTTP 连接）——dispose 整体有界的依据（R02）。 */
  private readonly ownedSockets = new Set<Socket>();
  private readonly upgradeHandler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  private readonly listeners = new Set<(conn: WsConnectionPort, meta: TransportConnMeta) => void>();
  private readonly audit: (l: string) => void;
  private readonly trustedProxies: readonly string[];
  private readonly requireTlsOffLoopback: boolean;
  private readonly closeHandshakeMs: number;
  private disposePromise: Promise<void> | null = null;
  /** B3（3b1b）：启动中的 listen 结算钩子——dispose 同轮交错时显式拒绝，防悬空启动 Promise。 */
  private pendingListen: { settle: () => void } | null = null;
  /** C1（3b1c）：自建 server 是否已进入监听态（重复 listen 拒绝依据；dispose 后随 disposed 一并失效） */
  private listening = false;
  /** 测试/受控注入：server 实际监听地址（port 模式 listen 后可读）。 */
  readonly address: () => { port: number; host: string } | null;

  constructor(private readonly opts: WsServerAdapterOpts) {
    this.audit = (l) => { try { opts.audit?.(l); } catch { /* 审计异常不阻断 */ } };
    this.trustedProxies = opts.trustedProxies ?? [];
    this.requireTlsOffLoopback = opts.requireTlsOffLoopback ?? true;
    this.closeHandshakeMs = opts.closeHandshakeMs ?? DEFAULT_CLOSE_HANDSHAKE_MS;
    this.wss = new WebSocketServer({
      noServer: true,
      // R03：接收硬门=冻结契约常量，公开构造无放宽/收窄入口
      maxPayload: LIMITS.transportMaxPayloadBytes,
      perMessageDeflate: false,
      // R02：接收器自启关闭（超限/畸形后 ws 主动 close）与主动 close 同截止，替代 ws 默认 30s
      //（ws≥8.18 运行时支持 closeTimeout；@types/ws 8.18.1 尚未收录——运行时验证见集成测试）
      closeTimeout: this.closeHandshakeMs,
    } as ConstructorParameters<typeof WebSocketServer>[0]);
    this.wss.on("error", (err: Error) => this.audit(`ws-transport server-error name=${err.name}`));
    this.upgradeHandler = (req, socket, head) => { void this.handleUpgrade(req, socket, head); };
    if (opts.server !== undefined) {
      this.ownServer = null;
      opts.server.on("upgrade", this.upgradeHandler);
      this.address = () => {
        const a = opts.server?.address();
        return typeof a === "object" && a !== null ? { port: a.port, host: a.address ?? "" } : null;
      };
    } else {
      this.ownServer = createServer();
      // R02：自建 server 必须应答普通 HTTP 请求（否则裸 GET 挂住 dispose——server.close 等全部连接结束）
      this.ownServer.on("request", (req, res) => {
        try {
          res.writeHead(404, { "Content-Type": "text/plain", "Content-Length": "0", Connection: "close" });
          res.end();
        } catch { /* 已销毁 */ }
        this.audit(`ws-transport http-rejected path=${req.url ?? "?"}`);
      });
      this.ownServer.on("connection", (socket: Socket) => {
        this.ownedSockets.add(socket);
        socket.on("close", () => { this.ownedSockets.delete(socket); });
      });
      this.ownServer.on("upgrade", this.upgradeHandler);
      this.ownServer.on("clientError", (err: Error, socket: Socket) => {
        // 非 upgrade 的 HTTP 客户端错误：吸收并关 socket（自建模式下防句柄悬挂）
        try { socket.destroy(); } catch { /* 已销毁 */ }
        this.audit(`ws-transport client-error name=${err.name}`);
      });
      this.address = () => {
        const a = this.ownServer?.address() ?? null;
        return typeof a === "object" && a !== null ? { port: a.port, host: a.address ?? "" } : null;
      };
    }
  }

  /** 自建模式：显式启动监听（默认 host=127.0.0.1，port=0 随机）。终态后拒绝（R02：dispose 后不得复活监听）。
   *  C1（3b1c）：重复调用规则——启动中/已监听均显式拒绝（单槽所有权：不得覆盖他次启动的结算钩子）；
   *  成功/异步 error/同步 throw/dispose 取消四路均恰一次结算并清理临时监听器（listening 由显式监听器接管，可被取消路径摘除）。 */
  listen(port: number = 0, host: string = "127.0.0.1"): Promise<{ port: number; host: string }> {
    if (this.ownServer === null) throw new Error("外部 server 模式无 listen 所有权");
    if (this.disposed) return Promise.reject(new Error("适配器已 dispose，拒绝重新监听"));
    if (this.pendingListen !== null) return Promise.reject(new Error("适配器监听启动中，拒绝重复 listen"));
    if (this.listening) return Promise.reject(new Error("适配器已在监听，拒绝重复 listen"));
    const server = this.ownServer;
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        server.off("error", onErr);
        server.off("listening", onListening);
      };
      const finishReject = (err: Error): void => {
        if (settled) return; settled = true;
        cleanup();
        if (this.pendingListen === op) this.pendingListen = null; // 所有权：只清自己的槽
        reject(err);
      };
      const onErr = (err: Error): void => { finishReject(err); };
      const onListening = (): void => {
        if (settled) return; settled = true;
        cleanup();
        this.pendingListen = null; // 成功路径：槽必属本 op（若已被 dispose 结算则 settled 先行，此路不达）
        this.listening = true;
        const a = server.address();
        resolve(typeof a === "object" && a !== null ? { port: a.port, host: a.address } : { port, host });
      };
      const op = {
        settle: (): void => {
          // dispose 取消：bind 可能已完成（listening 稍后才发）——close 使 server 终态化，防残留监听句柄
          if (settled) return; settled = true;
          cleanup();
          if (this.pendingListen === op) this.pendingListen = null;
          try { server.close(); } catch { /* 已关闭 */ }
          reject(new Error("适配器已 dispose，监听启动中止"));
        },
      };
      this.pendingListen = op;
      server.once("error", onErr);
      server.once("listening", onListening);
      try {
        server.listen(port, host); // 不传回调：listening 事件由显式监听器接管（可被取消路径摘除）
      } catch (err) {
        finishReject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  onConnection(cb: (conn: WsConnectionPort, meta: TransportConnMeta) => void): Off {
    if (this.disposed) {
      this.audit("ws-transport on-connection-ignored rule=disposed");
      return () => { /* 终态后注册=无操作 */ };
    }
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  private async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    // 🟡2：socket 一到手即挂 error 吸收器（拒绝路径/handleUpgrade 前的早期 RST 无监听会退进程）
    const socketRef = socket as Socket;
    socketRef.on("error", (err: Error) => {
      this.audit(`ws-transport upgrade-socket-error name=${err.name} remote=${socketRef.remoteAddress ?? "unknown"}`);
    });
    if (this.disposed) { this.rejectHttp(socket, 503, "shutting-down"); return; }
    const meta = deriveConnMeta(req, socket, this.trustedProxies);
    // upgrade 前安全门（§IV.B）：拒绝=HTTP 403，无 WS close 无应用帧
    if (meta.origin === null || !this.opts.allowedOrigins.includes(meta.origin)) {
      this.audit(`upgrade-rejected origin=${meta.origin ?? "<missing>"} remote=${meta.remoteAddress} clientIp=${meta.clientIp} rule=origin`);
      this.rejectHttp(socket, 403, "origin-not-allowed");
      return;
    }
    if (this.requireTlsOffLoopback && !meta.loopback && !meta.tls) {
      this.audit(`upgrade-rejected origin=${meta.origin} remote=${meta.remoteAddress} rule=tls-required`);
      this.rejectHttp(socket, 403, "tls-required");
      return;
    }
    const closeGuard = (): void => { this.audit("upgrade-rejected rule=socket-early-close"); };
    socket.once("close", closeGuard);
    this.wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      socket.off("close", closeGuard);
      const id = `t-${++this.connSeq}`;
      const adapter = new WsConnectionAdapter(ws, meta, id, this.audit, this.closeHandshakeMs);
      this.conns.set(id, adapter);
      ws.on("close", () => { this.conns.delete(id); });
      this.audit(`upgrade-accepted conn=${id} origin=${meta.origin} clientIp=${meta.clientIp} remote=${meta.remoteAddress} proxied=${meta.proxied} tls=${meta.tls}`);
      for (const cb of [...this.listeners]) {
        try { cb(adapter, meta); } catch (err) { this.audit(`ws-transport on-connection-cb-error conn=${id} err=${String(err)}`); }
      }
    });
  }

  /** HTTP 级拒绝（🟡3：end() 等写出 flush 再 FIN；1s 截截止防慢消费者拖住 socket——destroy 后内核清缓冲）。 */
  private rejectHttp(socket: Duplex, code: number, reason: string): void {
    try {
      const payload = `HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`;
      const s = socket as Socket;
      const kill = (): void => { try { s.destroy(); } catch { /* 已销毁 */ } };
      const t = setTimeout(kill, 1_000);
      t.unref?.();
      socket.once("error", () => { clearTimeout(t); kill(); });
      socket.once("close", () => { clearTimeout(t); });
      socket.end(payload, () => { clearTimeout(t); try { s.destroy(); } catch { /* 已销毁 */ } });
    } catch { /* 已销毁 */ }
  }

  async dispose(): Promise<void> {
    if (this.disposePromise !== null) return this.disposePromise;
    this.disposePromise = this.doDispose();
    return this.disposePromise;
  }

  private async doDispose(): Promise<void> {
    this.disposed = true;
    this.listening = false;
    // B3（3b1b）：同轮交错的启动中 listen 显式结算（否则 Node bind 前 close 不触发任何回调，调用方永远 pending）
    this.pendingListen?.settle();
    const waitMs = this.opts.disposeWaitMs ?? DEFAULT_DISPOSE_WAIT_MS;
    // 存量 WS 连接：1001 优雅关闭+closeHandshakeMs 截止 terminate；轮询 timer 全部 unref（🟡5）
    const open = [...this.conns.values()].filter((c) => c.isOpen);
    for (const c of open) c.close(1001, "server-shutdown");
    const deadline = Date.now() + waitMs;
    while (this.conns.size > 0 && Date.now() < deadline) {
      await new Promise((r) => { const t = setTimeout(r, 25); t.unref?.(); });
    }
    for (const c of [...this.conns.values()]) c.terminate();
    // 自建 server：整体有界关闭（R02）——close() 等全部连接结束，但未升级 HTTP/慢消费者由 socket 强制销毁兜底
    if (this.ownServer !== null) {
      const server = this.ownServer;
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = (): void => { if (!done) { done = true; resolve(); } };
        const guard = setTimeout(() => {
          // 截止后强制销毁本适配器管理的全部 socket（含未升级 HTTP/升级后连接——同源 TCP 连接集）
          for (const s of [...this.ownedSockets]) { try { s.destroy(); } catch { /* 已销毁 */ } }
          finish();
        }, waitMs);
        guard.unref?.();
        server.close(() => { clearTimeout(guard); finish(); });
      });
    } else if (this.opts.server !== undefined) {
      this.opts.server.off("upgrade", this.upgradeHandler);
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => resolve(), waitMs);
      t.unref?.();
      this.wss.close(() => { clearTimeout(t); resolve(); });
    });
    this.listeners.clear(); // 终态清理（🟡5）：dispose 后不再派发新连接
    this.audit(`ws-transport disposed remaining=${this.conns.size}`);
  }
}
