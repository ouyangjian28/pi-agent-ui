// WS 网关（切片③ 3a 受控接线；契约 §5）
// 职责：连接生命周期（hello 认证+hello 前窗口）/入站管线（拒二进制→字节门→t 识别→冻结写类→字段校验）/
// 请求级在途门（≤4+requestId 去重）/订阅接线（≤8 且每 file 唯一；三分支互斥；替换退旧）/列表与恢复走全服务计算闸/
// 心跳（30s ping/90s 无帧→4432+close 1000）/令牌热轮换撤销既有连接/24h 连接上限/所有出帧唯一走 ConnectionQueue。
// 3a=受控端口注入（无真网络）；3b 换 ws 库适配同一端口面（真网络分片）。
// 传输级说明：本层只处理**应用帧**；传输级 ping/pong/close 由端口透传（onPong→心跳记账）。
import { createHash } from "node:crypto";
import type {
  EventCursor, SanitizedText, ServerFrame, SessionStatus,
} from "@pi-agent-ui/protocol";
import { SubscriptionEngine } from "@pi-agent-ui/protocol";
import { ReadIndexRegistry, FileOverBudgetError } from "@pi-agent-ui/protocol";
import { buildRecoveryFrame, buildSessionsFrame } from "@pi-agent-ui/protocol";
import { utf8Bytes, ConnectionQueue } from "./connection-queue.ts";
import type { TokenAuthority } from "./token-auth.ts";
import { ComputeSemaphore } from "./compute-semaphore.ts";
import { scanSessions } from "./session-scan.ts";
import type { ScannedSession } from "./session-scan.ts";
import { resolveWithinRoots } from "./safe-open.ts";
import { recoverFromSnapshot } from "../runtime/recover.ts";
import type { RecoveryEvidenceSnapshot, RecoverReport } from "../runtime/recover.ts";

export interface GatewayConnPort {
  // gateway→传输（经 ConnectionQueue 间接持有；此处仅生命周期用）
  close(code?: number, reason?: string): void;
  terminate(): void;
}

export interface GatewayConnHooks {
  /** 传输层收到应用消息（已是文本；isBinary=true 时 gateway 直接按协议违规处理）。 */
  onMessage(cb: (data: string, isBinary: boolean) => void): void;
  onClose(cb: (code: number) => void): void;
  onPong?(cb: () => void): void;
  ping?(): void;
}

export interface ConnMeta {
  readonly origin?: string; // 缺失=默认拒（非浏览器入口也须带）
  readonly loopback: boolean;
  readonly tls: boolean;
}

export interface WsGatewayOpts {
  readonly tokens: TokenAuthority;
  /** 授权双根（会话 file 域；resolveWithinRoots 同源口径）。 */
  readonly roots: readonly string[];
  /** list-sessions 扫描目录（宿主配置；应与 roots 同域）。 */
  readonly scanDir: string;
  /** 精确 Origin 白名单（全等匹配，禁子串）。 */
  readonly allowedOrigins: readonly string[];
  /** 非 loopback 强制 TLS（契约 §5.5）。 */
  readonly requireTlsOffLoopback?: boolean;
  /** 全服务计算闸（跨连接共享；list/recovery）。 */
  readonly semaphore?: ComputeSemaphore;
  /** 恢复证据快照提供者（file→快照|null；null→unavailable(no-evidence-snapshot)——B03：禁裸读盘面）。 */
  readonly recoveryEvidence?: (file: string) => RecoveryEvidenceSnapshot | null | Promise<RecoveryEvidenceSnapshot | null>;
  /** 每会话状态源（订阅帧冻结用；缺省=unknown 状态）。 */
  readonly statusFor?: (file: string) => SessionStatus;
  readonly audit?: (line: string) => void;
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly timers?: {
    setTimeout?: (cb: () => void, ms: number) => unknown;
    clearTimeout?: (t: unknown) => void;
  };
  readonly heartbeat?: { pingMs?: number; idleMs?: number }; // 默认 30s/90s；0=禁用（受控测试）
  readonly maxLifetimeMs?: number; // 默认 24h
  readonly helloWindowMs?: number; // 默认 10s
  readonly helloMaxFrames?: number; // 默认 3
}

const WRITE_FROZEN = new Set(["prompt", "send", "stop", "resume", "takeover", "write", "execute", "spawn", "kill"]);
const KNOWN_T = new Set(["hello", "list-sessions", "subscribe", "unsubscribe", "get-recovery", "ping"]);
const FILE_RE = /^[\w.-]{1,114}\.jsonl$/;
const REQUEST_ID_RE = /^[\w-]{1,64}$/;
const FRAME_MAX = 262_144;

interface SubEntry {
  readonly engine: SubscriptionEngine;
}

interface ConnState {
  readonly id: string;
  readonly queue: ConnectionQueue;
  readonly meta: ConnMeta;
  tokenDigest: string | null;
  authed: boolean;
  preAuthFrames: number;
  helloDeadline: number;
  lastFrameAt: number;
  connectedAt: number;
  err4404Count: number;
  closed: boolean;
  readonly subs: Map<string, SubEntry>; // file → 订阅（每 file 唯一；≤8）
  readonly inflight: Set<string>; // requestId 在途（≤4）
}

export interface ConnHandle {
  readonly id: string;
  /** 传输消息入口（3a：测试替身调用；3b：ws message 事件适配）。 */
  inbound(data: string, isBinary: boolean): void;
  /** 传输已关闭（清理+停心跳）。 */
  transportClosed(): void;
  close(code?: number, reason?: string): void;
}

export class WsGateway {
  private readonly conns = new Map<string, ConnState>();
  private readonly registry: ReadIndexRegistry;
  private readonly sem: ComputeSemaphore;
  private readonly auditFn: (line: string) => void;
  private readonly now: () => number;
  private readonly newIdFn: () => string;
  private readonly tmr: (cb: () => void, ms: number) => unknown;
  private readonly clr: (t: unknown) => void;
  private readonly pingMs: number;
  private readonly idleMs: number;
  private readonly maxLifetimeMs: number;
  private readonly heartbeatTimers = new Map<string, { ping: unknown; idle: unknown; life: unknown; pong: boolean }>();
  private seq = 0;
  private listVersion = 0;
  private disposed = false;

  constructor(private readonly opts: WsGatewayOpts) {
    this.registry = new ReadIndexRegistry();
    this.sem = opts.semaphore ?? new ComputeSemaphore();
    this.auditFn = opts.audit ?? (() => {});
    this.now = opts.now ?? (() => Date.now());
    this.newIdFn = opts.newId ?? (() => `id-${++this.seq}`);
    this.tmr = opts.timers?.setTimeout ?? ((cb, ms) => setTimeout(cb, ms));
    this.clr = opts.timers?.clearTimeout ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
    this.pingMs = opts.heartbeat?.pingMs ?? 30_000;
    this.idleMs = opts.heartbeat?.idleMs ?? 90_000;
    this.maxLifetimeMs = opts.maxLifetimeMs ?? 86_400_000;
  }

  /** 令牌热轮换撤销：reload 结果 revoked=摘要集合；关闭持有被撤摘要的既有连接（4401）。 */
  async applyTokenReload(): Promise<void> {
    const r = await this.opts.tokens.reload();
    if (!r.changed || r.revoked.length === 0) return;
    for (const c of this.conns.values()) {
      if (c.authed && c.tokenDigest !== null && r.revoked.includes(c.tokenDigest)) {
        this.enqueue(c, { t: "error", code: 4401, message: "令牌已撤销", retryable: false, requestId: "" });
        this.closeConn(c, 4401, "token-revoked");
      }
    }
  }

  /** 受控连接接入（3a 测试/3b 适配器调用）。 */
  attach(
    portLike: { send(data: string, cb?: (err?: Error | null) => void): void; close(code?: number, reason?: string): void; terminate(): void; readonly readyState: number; readonly bufferedAmount: number },
    hooks: GatewayConnHooks,
    meta: ConnMeta,
  ): ConnHandle {
    const id = this.newIdFn();
    const queue = new ConnectionQueue({
      port: portLike,
      audit: (l) => this.auditFn(`conn=${id} ${l}`),
      now: this.now,
      setTimeout: this.tmr as (cb: () => void, ms: number) => unknown,
      clearTimeout: this.clr,
    });
    const st: ConnState = {
      id, queue, meta,
      tokenDigest: null, authed: false, preAuthFrames: 0,
      helloDeadline: this.now() + (this.opts.helloWindowMs ?? 10_000),
      lastFrameAt: this.now(), connectedAt: this.now(),
      err4404Count: 0, closed: false,
      subs: new Map(), inflight: new Set(),
    };
    this.conns.set(id, st);
    hooks.onMessage((data, isBinary) => this.inbound(st, data, isBinary));
    hooks.onClose(() => this.transportClosedInternal(st));
    if (hooks.onPong) hooks.onPong(() => { st.lastFrameAt = this.now(); });
    this.scheduleHeartbeat(st, hooks);
    this.auditFn(`conn-open id=${id} origin=${meta.origin ?? "<missing>"} loopback=${meta.loopback} tls=${meta.tls}`);
    return {
      id,
      inbound: (data, isBinary) => this.inbound(st, data, isBinary),
      transportClosed: () => this.transportClosedInternal(st),
      close: (code, reason) => this.closeConn(st, code ?? 1000, reason ?? ""),
    };
  }

  // ---- 入站管线（契约 §5.6 四级：包络→版本→写类→业务）----
  private inbound(st: ConnState, data: string, isBinary: boolean): void {
    if (st.closed || this.disposed) return;
    st.lastFrameAt = this.now();
    if (isBinary) {
      this.protocolErr(st, 4404, "二进制帧拒绝（JSON 文本帧）", "");
      return;
    }
    if (utf8Bytes(data) > FRAME_MAX) {
      this.protocolErr(st, 4404, "帧超字节上限", "");
      return;
    }
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      this.protocolErr(st, 4404, "非 JSON", "");
      return;
    }
    if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
      this.protocolErr(st, 4404, "帧非对象", "");
      return;
    }
    const m = msg as Record<string, unknown>;
    const t = m.t;
    if (typeof t !== "string") { this.protocolErr(st, 4404, "t 缺失/非字符串", ""); return; }
    if (WRITE_FROZEN.has(t)) { this.protocolErr(st, 4405, "写类帧冻结（只读服务）", ""); return; }
    if (!KNOWN_T.has(t)) { this.protocolErr(st, 4404, `未知 t=${t}`, ""); return; }
    if (!st.authed && t !== "hello") { this.rejectAuth(st); return; }
    if (t === "hello") { this.handleHello(st, m); return; }
    // 认证后帧：requestId 门（hello 外全部请求级）
    const requestId = m.requestId;
    if (typeof requestId !== "string" || !REQUEST_ID_RE.test(requestId)) {
      this.protocolErr(st, 4404, "requestId 缺失/非法", typeof requestId === "string" && requestId.length <= 64 ? requestId : "");
      return;
    }
    if (st.inflight.has(requestId)) { this.protocolErr(st, 4404, "requestId 在途重复", requestId); return; }
    if (st.inflight.size >= 4) {
      this.enqueue(st, { t: "error", code: 4429, message: "在途请求超限（4）", retryable: true, requestId });
      return;
    }
    st.inflight.add(requestId); // 同步占位（原子受理边界）
    try {
      switch (t) {
        case "ping": {
          const nonce = m.nonce;
          this.enqueue(st, { t: "pong", nonce: typeof nonce === "string" ? nonce.slice(0, 64) : "" });
          st.inflight.delete(requestId);
          return;
        }
        case "unsubscribe": this.handleUnsubscribe(st, requestId, m); return;
        case "subscribe": this.handleSubscribe(st, requestId, m); return;
        case "list-sessions": void this.handleList(st, requestId, m); return;
        case "get-recovery": void this.handleRecovery(st, requestId, m); return;
      }
    } finally {
      // sync 分支自行 delete；async 分支在完成回调 delete（见各 handler）
    }
  }

  private handleHello(st: ConnState, m: Record<string, unknown>): void {
    if (st.authed) { this.protocolErr(st, 4404, "重复 hello", ""); return; }
    st.preAuthFrames++;
    if (st.preAuthFrames > (this.opts.helloMaxFrames ?? 3)) { this.rejectAuth(st); return; }
    if (this.now() > st.helloDeadline) { this.rejectAuth(st); return; }
    // Origin 门：精确集合（缺失默认拒；全等匹配）
    const origin = st.meta.origin;
    if (origin === undefined || !this.opts.allowedOrigins.includes(origin)) {
      this.auditFn(`hello-origin-rejected conn=${st.id}`);
      this.rejectAuth(st);
      return;
    }
    if ((this.opts.requireTlsOffLoopback ?? true) && !st.meta.loopback && !st.meta.tls) {
      this.rejectAuth(st);
      return;
    }
    const pv = m.protocolVersion;
    if (typeof pv === "number" && Number.isInteger(pv) && pv !== 1) {
      this.enqueue(st, { t: "error", code: 4403, message: "协议版本不支持", retryable: false, requestId: "" });
      this.closeConn(st, 4403, "protocol-version");
      return;
    }
    if (m.protocolVersion !== 1 || typeof m.token !== "string" || m.token.length === 0 || m.token.length > 512) {
      this.protocolErr(st, 4404, "hello 字段非法", "");
      return;
    }
    if (!this.opts.tokens.check(m.token)) {
      this.auditFn(`hello-token-rejected conn=${st.id}`);
      this.rejectAuth(st);
      return;
    }
    st.tokenDigest = sha256Hex(m.token);
    st.authed = true;
    this.enqueue(st, { t: "welcome", serverBootId: BOOT_ID, protocolVersion: 1 });
  }

  private rejectAuth(st: ConnState): void {
    this.enqueue(st, { t: "error", code: 4401, message: "未认证或令牌无效", retryable: false, requestId: "" });
    this.closeConn(st, 4401, "auth");
  }

  private protocolErr(st: ConnState, code: 4404 | 4405, message: string, requestId: string): void {
    this.enqueue(st, { t: "error", code, message, retryable: false, requestId });
    if (code === 4404) {
      st.err4404Count++;
      if (st.err4404Count >= 3) this.closeConn(st, 1002, "too-many-4404");
    }
  }

  // ---- 订阅（§3.6 三分支互斥；同连接同 file 唯一；≤8）----
  private handleSubscribe(st: ConnState, requestId: string, m: Record<string, unknown>): void {
    const file = m.file;
    if (typeof file !== "string" || !FILE_RE.test(file)) {
      this.protocolErr(st, 4404, "file 非法", requestId);
      st.inflight.delete(requestId);
      return;
    }
    if (resolveWithinRoots(file, this.opts.roots) === null) {
      this.protocolErr(st, 4404, "file 越界", requestId);
      st.inflight.delete(requestId);
      return;
    }
    const existing = st.subs.get(file);
    const cursor = m.cursor;
    const snapshotId = m.snapshotId;
    const historyNext = m.historyNext;
    const branch = cursor !== undefined ? "resync" : snapshotId !== undefined || historyNext !== undefined ? "page" : "init";
    // 互斥：多余字段→4404（三分支字段集互斥）
    const allowed = branch === "init" ? ["t", "requestId", "file"] : branch === "resync" ? ["t", "requestId", "file", "cursor"] : ["t", "requestId", "file", "snapshotId", "historyNext"];
    for (const k of Object.keys(m)) if (!allowed.includes(k)) { this.protocolErr(st, 4404, `subscribe 多余字段 ${k}`, requestId); st.inflight.delete(requestId); return; }
    try {
      if (branch === "page") {
        // 续页：须有现存引擎；路由 engine.handle
        if (existing === undefined || typeof snapshotId !== "string" || !isCursor(historyNext)) {
          this.enqueue(st, { t: "error", code: 4404, message: "续页请求与订阅状态不符", retryable: false, requestId });
          st.inflight.delete(requestId);
          return;
        }
        this.emitFrames(st, existing.engine.handle({ kind: "page", requestId, snapshotId, historyNext }));
        st.inflight.delete(requestId);
        return;
      }
      // init/resync：同 file 先退旧（4409 stream-replaced 通知——非 error 帧；status 关闭语义）
      if (existing !== undefined) {
        // 同 file 退旧（契约 §3.6：4409 stream-replaced 通知由网关发；引擎静默关闭）
        this.enqueue(st, { t: "error", code: 4409, message: "stream-replaced（同文件新订阅）", retryable: true, requestId });
        existing.engine.close(4431, "stream-replaced", false);
        st.subs.delete(file);
      }
      if (st.subs.size >= 8) {
        this.enqueue(st, { t: "error", code: 4429, message: "订阅数超限（8）", retryable: true, requestId });
        st.inflight.delete(requestId);
        return;
      }
      const engine = this.makeEngine(file);
      const frames = branch === "init"
        ? engine.startSnapshot(requestId)
        : isCursor(cursor)
          ? engine.startResync(requestId, cursor)
          : [{ t: "error", code: 4404, message: "cursor 非法", retryable: false, requestId } as ServerFrame];
      st.subs.set(file, { engine });
      this.emitFrames(st, frames);
      st.inflight.delete(requestId);
    } catch (e) {
      if (e instanceof FileOverBudgetError) {
        this.enqueue(st, { t: "error", code: 4402, message: "会话索引超预算不可读", retryable: false, requestId });
      } else {
        this.auditFn(`subscribe-failed conn=${st.id} file=${file}`);
        this.enqueue(st, { t: "error", code: 4402, message: "会话不可读", retryable: false, requestId });
      }
      st.inflight.delete(requestId);
    }
  }

  private makeEngine(file: string): SubscriptionEngine {
    const index = this.registry.get(file);
    return new SubscriptionEngine({
      index,
      status: () => this.opts.statusFor?.(file) ?? unknownStatus(file),
      now: this.now,
      newId: this.newIdFn,
    });
  }

  private handleUnsubscribe(st: ConnState, requestId: string, m: Record<string, unknown>): void {
    const sid = m.subscriptionId;
    if (typeof sid !== "string" || sid.length === 0 || sid.length > 64) {
      this.protocolErr(st, 4404, "subscriptionId 非法", requestId);
      st.inflight.delete(requestId);
      return;
    }
    for (const [file, sub] of st.subs) {
      if (sub.engine.subscriptionId === sid) {
        sub.engine.close(4431, "", false); // 静默关闭（无 error 帧）
        st.subs.delete(file);
        this.auditFn(`unsubscribe conn=${st.id} file=${file}`);
        break;
      }
    }
    st.inflight.delete(requestId);
  }

  // ---- list-sessions（计算闸+扫描+装帧）----
  private async handleList(st: ConnState, requestId: string, m: Record<string, unknown>): Promise<void> {
    const rawOffset = m.offset;
    const rawLimit = m.limit;
    const offset: number = rawOffset === undefined ? 0 : rawOffset as number;
    const limit: number = rawLimit === undefined ? 50 : rawLimit as number;
    if ((rawOffset !== undefined && !(typeof rawOffset === "number" && Number.isSafeInteger(rawOffset) && rawOffset >= 0))
      || (rawLimit !== undefined && !(typeof rawLimit === "number" && Number.isSafeInteger(rawLimit) && rawLimit >= 1 && rawLimit <= 200))) {
      this.protocolErr(st, 4404, "list 参数非法", requestId);
      st.inflight.delete(requestId);
      return;
    }
    const acq = this.sem.acquire();
    const done = (): void => { st.inflight.delete(requestId); };
    const finish = (r: { ok: boolean; kind?: string; release(): void }): void => {
      if (r.ok) r.release();
      done();
    };
    try {
      const r = await acq.promise;
      if (!r.ok) {
        this.enqueue(st, r.kind === "timeout"
          ? { t: "error", code: 4409, message: "计算排队超时", retryable: true, requestId }
          : { t: "error", code: 4409, message: "请求已取消", retryable: true, requestId });
        done();
        return;
      }
      try {
        const scan = await scanSessions(this.opts.scanDir);
        const v = ++this.listVersion;
        const items = scan.sessions.map(toDto);
        const frame = buildSessionsFrame(requestId, items, offset, v, scan.dirReliability, limit);
        if (frame === null) this.enqueue(st, { t: "error", code: 4431, message: "列表帧超预算", retryable: false, requestId });
        else this.enqueue(st, frame);
      } finally {
        r.release();
        done();
      }
    } catch {
      this.enqueue(st, { t: "error", code: 4402, message: "列表扫描失败", retryable: false, requestId });
      finish({ ok: false, release: () => {} });
    }
  }

  // ---- get-recovery（计算闸+权威证据快照链；B03 禁裸读盘面）----
  private async handleRecovery(st: ConnState, requestId: string, m: Record<string, unknown>): Promise<void> {
    const file = m.file;
    const rawOffset = m.offset;
    if (typeof file !== "string" || !FILE_RE.test(file) || resolveWithinRoots(file, this.opts.roots) === null) {
      this.protocolErr(st, 4404, "file 非法/越界", requestId);
      st.inflight.delete(requestId);
      return;
    }
    if (rawOffset !== undefined && !(typeof rawOffset === "number" && Number.isSafeInteger(rawOffset) && rawOffset >= 0)) {
      this.protocolErr(st, 4404, "offset 非法", requestId);
      st.inflight.delete(requestId);
      return;
    }
    const acq = this.sem.acquire();
    const done = (): void => { st.inflight.delete(requestId); };
    try {
      const r = await acq.promise;
      if (!r.ok) {
        this.enqueue(st, r.kind === "timeout"
          ? { t: "error", code: 4409, message: "计算排队超时", retryable: true, requestId }
          : { t: "error", code: 4409, message: "请求已取消", retryable: true, requestId });
        done();
        return;
      }
      try {
        const provider = this.opts.recoveryEvidence;
        const snap = provider === undefined ? null : await provider(file);
        if (snap === null) {
          this.enqueue(st, { t: "recovery", requestId, file, availability: "unavailable", reason: "no-evidence-snapshot" });
          return;
        }
        const report: RecoverReport = recoverFromSnapshot(snap);
        const frame = buildRecoveryFrame(requestId, file, report as unknown as Parameters<typeof buildRecoveryFrame>[2], rawOffset === undefined ? 0 : (rawOffset as number));
        if (frame === null) this.enqueue(st, { t: "error", code: 4431, message: "恢复帧超预算", retryable: false, requestId });
        else this.enqueue(st, frame);
      } finally {
        r.release();
        done();
      }
    } catch {
      this.enqueue(st, { t: "error", code: 4402, message: "恢复读取失败", retryable: false, requestId });
      done();
    }
  }

  // ---- 出帧（唯一路径=ConnectionQueue）----
  private enqueue(st: ConnState, frame: ServerFrame): void {
    const r = st.queue.enqueue(frame);
    if (r !== "queued") this.auditFn(`conn=${st.id} enqueue-${r}`);
    if (r !== "queued") this.closeConn(st, 4431, "connection-queue-overflow");
  }

  private emitFrames(st: ConnState, frames: readonly ServerFrame[]): void {
    for (const f of frames) this.enqueue(st, f);
  }

  // ---- 心跳/寿命/关闭 ----
  private scheduleHeartbeat(st: ConnState, hooks: GatewayConnHooks): void {
    if (this.pingMs <= 0 && this.idleMs <= 0) return;
    const entry: { ping: unknown; idle: unknown; life: unknown; pong: boolean } = { ping: null, idle: null, life: null, pong: true };
    this.heartbeatTimers.set(st.id, entry);
    const tick = (): void => {
      const c = this.conns.get(st.id);
      if (c === undefined || c.closed) return;
      const now = this.now();
      if (this.idleMs > 0 && now - c.lastFrameAt >= this.idleMs) {
        this.enqueue(st, { t: "error", code: 4432, message: "心跳超时", retryable: true, requestId: "" });
        this.closeConn(c, 1000, "heartbeat-timeout");
        return;
      }
      if (this.maxLifetimeMs > 0 && now - c.connectedAt >= this.maxLifetimeMs) {
        this.closeConn(c, 1000, "lifetime-cap");
        return;
      }
      if (this.pingMs > 0 && hooks.ping) {
        hooks.ping();
        entry.pong = false;
      }
      entry.ping = this.tmr(tick, this.pingMs > 0 ? this.pingMs : this.idleMs);
    };
    entry.ping = this.tmr(tick, this.pingMs > 0 ? this.pingMs : this.idleMs);
  }

  private closeConn(st: ConnState, code: number, reason: string): void {
    if (st.closed) return;
    st.closed = true;
    for (const [, sub] of st.subs) sub.engine.close(4431, "", false);
    st.subs.clear();
    st.queue.close(code === 1000 ? 1000 : code, reason); // 队列尽力排空（正常）或直接关闭
    this.clearHeartbeat(st.id);
    this.conns.delete(st.id);
    this.auditFn(`conn-close id=${st.id} code=${code} reason=${reason}`);
  }

  private clearHeartbeat(id: string): void {
    const hb = this.heartbeatTimers.get(id);
    if (hb) {
      if (hb.ping !== null) this.clr(hb.ping);
      if (hb.idle !== null) this.clr(hb.idle);
      if (hb.life !== null) this.clr(hb.life);
      this.heartbeatTimers.delete(id);
    }
  }

  private transportClosedInternal(st: ConnState): void {
    if (st.closed) return;
    st.closed = true;
    for (const [, sub] of st.subs) sub.engine.close(4431, "", false);
    st.subs.clear();
    st.queue.onTransportClosed();
    const hb = this.heartbeatTimers.get(st.id);
    if (hb) {
      if (hb.ping !== null) this.clr(hb.ping);
      this.heartbeatTimers.delete(st.id);
    }
    this.conns.delete(st.id);
    this.auditFn(`conn-transport-closed id=${st.id}`);
  }

  get connectionCount(): number {
    return this.conns.size;
  }

  dispose(): void {
    this.disposed = true;
    for (const c of [...this.conns.values()]) this.closeConn(c, 1000, "server-shutdown");
  }
}

// ---- 帮手 ----
function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function isCursor(v: unknown): v is EventCursor {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    && typeof (v as { streamId?: unknown }).streamId === "string"
    && Number.isSafeInteger((v as { seq?: unknown }).seq);
}

function toDto(s: ScannedSession): {
  sessionId: string | null; file: string; title: SanitizedText; lastActiveMs: number | null;
  entryCount: number; sizeBytes: number; hasRecoveryNotice: boolean; listReliability: "full" | "partial";
} {
  return {
    sessionId: s.sessionId, file: s.file, title: s.title, lastActiveMs: s.lastActiveMs,
    entryCount: s.entryCount, sizeBytes: s.sizeBytes, hasRecoveryNotice: false, listReliability: s.listReliability,
  };
}

function unknownStatus(_file: string): SessionStatus {
  // 占位状态（statusFor 未注入时；字段按契约类型给未知形态）
  return {
    session: { file: _file, sessionId: null },
    process: { phase: "idle" },
    turn: { phase: "idle" },
    backgroundTasks: { availability: "unknown", activeCount: null },
    reap: { eligible: false, idleElapsedMs: null, idleRemainingMs: null, idleMs: 0 },
    recovery: { availability: "unavailable", resumeBlocked: null, diskBlocked: null, unknownEffectCount: null, unattributableFragments: null, intentsCount: null, settledCount: null, evidenceHash: null },
    statusVersion: 0,
    serverTimeMs: 0,
  } as unknown as SessionStatus;
}

// 权威链（gateway 内部同源使用）：captureRecoveryEvidence 由宿主/provider 负责

const BOOT_ID = `boot-${Math.random().toString(36).slice(2, 10)}`;
