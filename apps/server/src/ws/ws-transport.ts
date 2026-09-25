// 3b-1 真 WS 传输适配层（GPT 3b-0 对齐裁定 §IV.A/B 冻结签名）——
// 监听（WsTransportPort）与连接（WsConnectionPort）分立；网关面向端口编程，ws 库类型不进网关。
// - send(text, done)：done 绑定 ws.send 完成回调（禁止 send 返回即兑现）；未抛出时回调至多一次；连接故障走终止清理。
// - bufferedAmount/readyState：透传 ws 实时值，不缓存不伪造。
// - close(code,reason)：控制帧走 ws.close；reason 固定短文本（≤123B，不回显输入）；close 握手有截止（超时 terminate）。
// - transport ping/pong：连接活性控制帧（与应用 ping 请求应答分层，§IV.D：无新增独立杀手 timer——活性判定归网关 lastFrameAt）。
// - upgrade 前拒绝=HTTP 403（Origin 白名单/安全元数据不合格在 handleUpgrade 前；GPT §IV.B）——不是 WebSocket close，无应用帧。
// - 接收硬门：maxPayload=LIMITS.transportMaxPayloadBytes（1MiB 重组兜底，超限 ws close 1009；契约例外条款=docs §5.1/§5.3）。
// - permessage-deflate 禁用（压缩面另审）。
// - 资源释放恰一次：主动 close/远端 close/RST/error/send 回调失败/dispose 可竞争；dispose 停新 upgrade+存量 1001 有界收口。
// - 外部注入 HTTP server 的关闭所有权归调用方（dispose 只摘 upgrade 监听）；自建 server（port 模式）由 dispose 关闭。
// - trustProxy 默认 false：不采信 X-Forwarded-*；启用须给可信代理精确来源，仅当 socket 对端在列时按头派生有效 clientIp/tls（§IV.B）。
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Socket } from "node:net";
import { TLSSocket } from "node:tls";
import { createServer, type Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { LIMITS } from "@pi-agent-ui/protocol";

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
  readonly maxPayload?: number;
  readonly closeHandshakeMs?: number; // close 握手截止（默认 5000；超时 terminate）
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
  // 可信代理：XFF 左端=有效客户端；XFP=https 才抬升 tls（头缺失则保守 false）
  const xff = headerSingle(req.headers["x-forwarded-for"]);
  const clientIp = xff !== null ? (xff.split(",")[0] ?? "").trim() : remote;
  const effectiveIp = clientIp.length > 0 ? clientIp : remote;
  const xfp = headerSingle(req.headers["x-forwarded-proto"]);
  return { origin, loopback: isLoopbackIp(effectiveIp), tls: sockTls || xfp?.toLowerCase() === "https", clientIp: effectiveIp, remoteAddress: remote, proxied: true };
}

/** 单连接适配：ws.WebSocket → WsConnectionPort（生命周期错误吸收；释放恰一次）。 */
class WsConnectionAdapter implements WsConnectionPort {
  private disposed = false;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly closeCallbacks: Array<(code: number) => void> = [];
  private closedFired = false;

  constructor(private readonly ws: WebSocket, private readonly meta: TransportConnMeta, private readonly connId: string, private readonly audit: (l: string) => void, private readonly closeHandshakeMs: number) {
    this.ws.on("close", (code: number) => {
      if (this.closedFired) return;
      this.closedFired = true;
      this.clearCloseTimer();
      for (const cb of [...this.closeCallbacks]) {
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
      done(new Error("连接已关闭，拒绝发送"));
      return;
    }
    try {
      this.ws.send(text, { fin: true }, (err) => {
        // ws 完成回调（错误=未交付/连接故障）；至多一次
        try { done(err ?? null); } catch { /* 调用方回调异常不回流传输层 */ }
      });
    } catch (err) {
      done(err instanceof Error ? err : new Error(String(err)));
    }
  }

  close(code?: number, reason?: string): void {
    if (this.disposed || this.closedFired) return;
    this.disposed = true;
    try { this.ws.close(code, reason !== undefined ? reason.slice(0, 123) : undefined); } catch { this.ws.terminate(); }
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
      if (isBinary) { cb("", true); return; } // binary 不解码文本（网关按协议违规拒）
      const text = typeof data === "string" ? data : Buffer.from(data as ArrayBufferLike).toString("utf8");
      cb(text, false);
    };
    this.ws.on("message", h);
    return () => { this.ws.off("message", h); };
  }

  onPong(cb: () => void): Off {
    const h = (): void => { cb(); };
    this.ws.on("pong", h);
    return () => { this.ws.off("pong", h); };
  }

  onClose(cb: (code: number) => void): Off {
    this.closeCallbacks.push(cb);
    return () => {
      const i = this.closeCallbacks.indexOf(cb);
      if (i >= 0) this.closeCallbacks.splice(i, 1);
    };
  }

  onError(cb: (err: Error) => void): Off {
    const h = (err: Error): void => { cb(err); };
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
  private readonly upgradeHandler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  private readonly listeners = new Set<(conn: WsConnectionPort, meta: TransportConnMeta) => void>();
  private readonly audit: (l: string) => void;
  private readonly trustedProxies: readonly string[];
  private readonly requireTlsOffLoopback: boolean;
  private disposePromise: Promise<void> | null = null;
  /** 测试/受控注入：server 实际监听地址（port 模式 listen 后可读）。 */
  readonly address: () => { port: number; host: string } | null;

  constructor(private readonly opts: WsServerAdapterOpts) {
    this.audit = (l) => { try { opts.audit?.(l); } catch { /* 审计异常不阻断 */ } };
    this.trustedProxies = opts.trustedProxies ?? [];
    this.requireTlsOffLoopback = opts.requireTlsOffLoopback ?? true;
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: opts.maxPayload ?? LIMITS.transportMaxPayloadBytes,
      perMessageDeflate: false,
    });
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

  /** 自建模式：显式启动监听（默认 host=127.0.0.1，port=0 随机）。 */
  listen(port: number = 0, host: string = "127.0.0.1"): Promise<{ port: number; host: string }> {
    if (this.ownServer === null) throw new Error("外部 server 模式无 listen 所有权");
    return new Promise((resolve, reject) => {
      const onErr = (err: Error): void => reject(err);
      this.ownServer!.once("error", onErr);
      this.ownServer!.listen(port, host, () => {
        this.ownServer!.off("error", onErr);
        const a = this.ownServer!.address();
        resolve(typeof a === "object" && a !== null ? { port: a.port, host: a.address } : { port, host });
      });
    });
  }

  onConnection(cb: (conn: WsConnectionPort, meta: TransportConnMeta) => void): Off {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  private async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
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
      const adapter = new WsConnectionAdapter(ws, meta, id, this.audit, this.opts.closeHandshakeMs ?? DEFAULT_CLOSE_HANDSHAKE_MS);
      this.conns.set(id, adapter);
      ws.on("close", () => { this.conns.delete(id); });
      this.audit(`upgrade-accepted conn=${id} origin=${meta.origin} clientIp=${meta.clientIp} remote=${meta.remoteAddress} proxied=${meta.proxied} tls=${meta.tls}`);
      for (const cb of [...this.listeners]) {
        try { cb(adapter, meta); } catch (err) { this.audit(`ws-transport on-connection-cb-error conn=${id} err=${String(err)}`); }
      }
    });
  }

  private rejectHttp(socket: Duplex, code: number, reason: string): void {
    try {
      socket.write(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    } catch { /* 已销毁 */ }
  }

  async dispose(): Promise<void> {
    if (this.disposePromise !== null) return this.disposePromise;
    this.disposePromise = this.doDispose();
    return this.disposePromise;
  }

  private async doDispose(): Promise<void> {
    this.disposed = true;
    // 存量连接先收口：1001 优雅关闭+截止 terminate；有界等待（terminate 销毁 socket → server.close 才能返回）
    const waitMs = this.opts.disposeWaitMs ?? DEFAULT_DISPOSE_WAIT_MS;
    const open = [...this.conns.values()].filter((c) => c.isOpen);
    for (const c of open) c.close(1001, "server-shutdown");
    const deadline = Date.now() + waitMs;
    while (this.conns.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    for (const c of [...this.conns.values()]) c.terminate();
    // 再关监听：外部 server 摘监听（所有权归调用方不关 server）；自建 server 关闭（upgraded socket 已毁，close 可返回）
    if (this.ownServer !== null) {
      await new Promise<void>((resolve) => { this.ownServer!.close(() => resolve()); });
    } else if (this.opts.server !== undefined) {
      this.opts.server.off("upgrade", this.upgradeHandler);
    }
    await new Promise<void>((resolve) => { this.wss.close(() => resolve()); });
    this.audit(`ws-transport disposed remaining=${this.conns.size}`);
  }
}
