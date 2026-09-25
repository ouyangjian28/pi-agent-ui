// WS 网关（切片③ 3a 受控接线；契约 §5）—— w1 修复轮重写
// W1-01：协议单入口=冻结校验器 validateClientFrame（网关不再手写字段门）+错误矩阵（4403→close 1003、
//   4405→close 1008、4404 累计 3→close 1002、4401→close 1008、4432→close 1000；4402/4409 retryable=true、
//   订阅数 4429 retryable=false、在途第 5 个=4404〔契约 §369〕）；错误消息固定不回显输入。
// W1-02：认证截止独立 timer（hello 窗口到期未认证→4401+close 1008，pong 不续命）+服务准入配额
//   （connectionsPerServer=16 + 60s 握手 10 次滑窗）+默认单调时钟（performance.now 回落 Date.now）。
// W1-03（queue 侧）：帧门=待发+在途双计数；本网关统一出帧仍唯一走 ConnectionQueue。
// W1-04：订阅数据入口=可注入 HistorySourcePort（load+observe；缺省/不可读→4402 fail-closed）；
//   索引装载（前缀判定/换流 replace）+文件级共享观察器+排空泵（drain 后仍有积压则续泵）。
// W1-05：init/resync 原子切换——先建新引擎试启（startSnapshot/startResync），失败（4409/4404 错误帧）
//   只发错误不退旧；成功才退旧（4409 通知关联旧 subscriptionId+cancelBySubscription 撤未发旧帧）。
// W1-06：恢复帧走 typed adapter（evidenceHash=snapshotEvidenceHash+blockedReasons 映射）；
//   请求带 evidenceHash 且≠当前证据哈希→4409 evidence-changed（无服务端分页缓存：每次现算，跨页一致性由哈希门保证）。
// W1-07：计算任务按连接登记所有者——断开即取消排队任务（semaphore.cancel）、grant 后执行前复核连接存活。
// W1-08：审计回调安全隔离（safeAudit）+inflight/任务槽 finally 归还（异常不泄漏在途位）。
// W1-11：listVersion 绑目录内容指纹（同指纹跨页/跨连接版本不变；内容真变才递增）。
// 3a=受控端口注入（无真网络）；3b 换 ws 库适配同一端口面（真网络分片）。
// 传输级说明：本层只处理**应用帧**；传输级 ping/pong/close 由端口透传（onPong→心跳记账）。
import { createHash } from "node:crypto";
import type {
  ClientFrame, LiveEvent, RecoveryBlockReason, SanitizedText, ServerFrame, SessionStatus,
} from "@pi-agent-ui/protocol";
import { LIMITS, SubscriptionEngine, validateClientFrame } from "@pi-agent-ui/protocol";
import type { ScanRow } from "@pi-agent-ui/protocol";
import { ReadIndexRegistry, FileOverBudgetError } from "@pi-agent-ui/protocol";
import { buildRecoveryFrame, buildSessionsFrame } from "@pi-agent-ui/protocol";
import { utf8Bytes, ConnectionQueue } from "./connection-queue.ts";
import type { TokenAuthority } from "./token-auth.ts";
import { ComputeSemaphore } from "./compute-semaphore.ts";
import { scanSessions } from "./session-scan.ts";
import type { ScannedSession } from "./session-scan.ts";
import { resolveWithinRoots } from "./safe-open.ts";
import { recoverFromSnapshot, snapshotEvidenceHash } from "../runtime/recover.ts";
import type { RecoveryEvidenceSnapshot } from "../runtime/recover.ts";

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

/** 订阅数据入口（W1-04）：宿主提供安全读+观察。load=null→4402；observe 可选（无观察=只读快照）。 */
export interface HistorySourcePort {
  load(file: string): Promise<readonly ScanRow[] | null>;
  observe?(file: string, sinks: HistorySinks): () => void; // 返回停止观察
}
export interface HistorySinks {
  /** 落盘追加（journal 行；宿主已安全读取） */
  onAppend(row: ScanRow): void;
  /** 进程内存事件（非耐久） */
  onLive(ev: LiveEvent): void;
  /** 状态变化 */
  onStatus(status: SessionStatus): void;
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
  /** 订阅数据入口（W1-04；缺省=订阅一律 4402 fail-closed，接线归宿主/3b）。 */
  readonly historySource?: HistorySourcePort;
  /** 每会话状态源（订阅帧冻结用；缺省=unknown 状态）。 */
  readonly statusFor?: (file: string) => SessionStatus;
  readonly audit?: (line: string) => void;
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly timers?: {
    setTimeout?: (cb: () => void, ms: number) => unknown;
    clearTimeout?: (t: unknown) => void;
  };
  /** B4（w1b）：读索引预算注入（受控测试可小阈；生产默认 20000/流）。 */
  readonly indexLimits?: { maxEventsPerStream: number };
  readonly heartbeat?: { pingMs?: number; idleMs?: number }; // 默认 30s/90s；0=禁用（受控测试）
  readonly maxLifetimeMs?: number; // 默认 24h
  readonly helloWindowMs?: number; // 默认 10s
  readonly helloMaxFrames?: number; // 默认 3
  /** 服务准入（W1-02）：连接上限默认 LIMITS.connectionsPerServer；60s 握手滑窗默认 10。 */
  readonly maxConnections?: number;
  readonly handshakePerMinute?: number;
}

interface SubEntry {
  readonly engine: SubscriptionEngine;
}

interface ComputeTask {
  acq: { promise: Promise<{ ok: boolean; kind?: string; release(): void }>; cancel(): void };
  phase: "queued" | "running";
}

interface ConnState {
  readonly id: string;
  readonly queue: ConnectionQueue;
  readonly meta: ConnMeta;
  tokenDigest: string | null;
  authed: boolean;
  preAuthFrames: number;
  err4404Count: number;
  closed: boolean;
  lastFrameAt: number; // 任意入站帧/pong 刷新（心跳空闲判据；认证截止不依赖它——独立 timer）
  connectedAt: number;
  readonly subs: Map<string, SubEntry>; // file → 订阅（每 file 唯一；≤8）
  readonly inflight: Set<string>; // requestId 在途（≤4；第 5 个=4404）
  readonly tasks: Map<string, ComputeTask>; // 计算任务所有者（断开取消；W1-07）
  readonly recoveryPages: Map<string, { hash: string; adapted: ReturnType<typeof recoverFromSnapshot> & { evidenceHash: string; blockedReasons: RecoveryBlockReason[] } }>; // B8：恢复内容页冻结缓存（≤RECOVERY_PAGE_CACHE_MAX，FIFO 驱逐）
}

export interface ConnHandle {
  readonly id: string;
  /** 传输消息入口（3a：测试替身调用；3b：ws message 事件适配）。 */
  inbound(data: string, isBinary: boolean): void;
  /** 传输已关闭（清理+停心跳+取消任务）。 */
  transportClosed(): void;
  close(code?: number, reason?: string): void;
}

const HANDSHAKE_WINDOW_MS = 60_000;
const RECOVERY_PAGE_CACHE_MAX = 8; // B8：每连接恢复页缓存上界（FIFO 驱逐；连接关闭全清）

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
  private readonly maxConnections: number;
  private readonly handshakePerMinute: number;
  /** 连接级监督定时器（auth 截止+心跳+寿命统一挂账；W1-02/W1-08） */
  private readonly connTimers = new Map<string, { auth: unknown; tick: unknown }>();
  /** 文件级共享观察器（多连接同文件共享一份 observe+一个泵；W1-04） */
  private readonly watchers = new Map<string, { refs: Set<ConnState>; unobserve: (() => void) | null }>();
  private readonly pendingPumps = new Set<string>();
  private readonly handshakeTimes: number[] = []; // 单调时钟滑窗（W1-02）
  private seq = 0;
  private listVersion = 0;
  private listFingerprint = ""; // 目录内容指纹（W1-11）
  private disposed = false;

  constructor(private readonly opts: WsGatewayOpts) {
    this.sem = opts.semaphore ?? new ComputeSemaphore();
    this.auditFn = opts.audit ?? (() => {});
    // W1-02：默认单调时钟（performance.now 单调；缺失环境回落 Date.now——墙钟回拨仅影响相对间隔的下界）
    this.now = opts.now ?? (typeof performance !== "undefined" && typeof performance.now === "function" ? () => performance.now() : () => Date.now());
    this.newIdFn = opts.newId ?? (() => `id-${++this.seq}`);
    this.registry = new ReadIndexRegistry(this.newIdFn, undefined, this.opts.indexLimits); // B4：预算可注入（受控测试可小阈）
    this.tmr = opts.timers?.setTimeout ?? ((cb, ms) => setTimeout(cb, ms));
    this.clr = opts.timers?.clearTimeout ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
    this.pingMs = opts.heartbeat?.pingMs ?? LIMITS.heartbeatSuggestMs;
    this.idleMs = opts.heartbeat?.idleMs ?? LIMITS.heartbeatTimeoutMs;
    this.maxLifetimeMs = opts.maxLifetimeMs ?? LIMITS.connectionLifetimeMs;
    this.maxConnections = opts.maxConnections ?? LIMITS.connectionsPerServer;
    this.handshakePerMinute = opts.handshakePerMinute ?? 10;
  }

  /** 审计隔离（W1-08）：回调异常不得阻断状态机。 */
  private audit(line: string): void {
    try { this.auditFn(line); } catch { /* 隔离 */ }
  }

  /** 令牌热轮换撤销：reload 结果 revoked=摘要集合；关闭持有被撤摘要的既有连接（4401→close 1008）。 */
  async applyTokenReload(): Promise<void> {
    const r = await this.opts.tokens.reload();
    if (!r.changed || r.revoked.length === 0) return;
    for (const c of [...this.conns.values()]) {
      if (c.authed && c.tokenDigest !== null && r.revoked.includes(c.tokenDigest)) {
        this.enqueue(c, { t: "error", code: 4401, message: "令牌已撤销", retryable: false, requestId: "" });
        this.closeConn(c, 1008, "token-revoked");
      }
    }
  }

  /** 受控连接接入（3a 测试/3b 适配器调用）。W1-02：服务准入配额（连接数+握手滑窗）。 */
  attach(
    portLike: { send(data: string, cb?: (err?: Error | null) => void): void; close(code?: number, reason?: string): void; terminate(): void; readonly readyState: number; readonly bufferedAmount: number },
    hooks: GatewayConnHooks,
    meta: ConnMeta,
  ): ConnHandle {
    const id = this.newIdFn();
    const queue = new ConnectionQueue({
      port: portLike,
      audit: (l) => this.audit(`conn=${id} ${l}`),
      now: this.now,
      setTimeout: this.tmr as (cb: () => void, ms: number) => unknown,
      clearTimeout: this.clr,
    });
    const st: ConnState = {
      id, queue, meta,
      tokenDigest: null, authed: false, preAuthFrames: 0,
      err4404Count: 0, closed: false,
      lastFrameAt: this.now(), connectedAt: this.now(),
      subs: new Map(), inflight: new Set(), tasks: new Map(),
      recoveryPages: new Map(),
    };
    // W1-02：握手滑窗（单调时钟；先记后判——被拒的接入也计入滑窗）
    // B6（w1b）：有界记账——饱和期拒接不再存时间戳（窗内已有 ≥limit 个样本即足以判拒；
    // 拒接不存储不损滑窗语义：饱和状态由已存样本维持，样本老化退出后自然恢复接收）
    const t0 = this.now();
    while (this.handshakeTimes.length > 0 && t0 - (this.handshakeTimes[0] ?? 0) > HANDSHAKE_WINDOW_MS) this.handshakeTimes.shift();
    const saturated = this.handshakeTimes.length >= this.handshakePerMinute;
    if (!saturated) this.handshakeTimes.push(t0);
    if (this.disposed || this.conns.size >= this.maxConnections) {
      st.closed = true;
      queue.close(1013, this.disposed ? "server-shutdown" : "server-full");
      this.audit(`conn-refused id=${id} reason=${this.disposed ? "disposed" : "server-full"} conns=${this.conns.size}`);
      return { id, inbound: () => {}, transportClosed: () => {}, close: () => {} };
    }
    if (saturated) {
      st.closed = true;
      queue.close(1013, "handshake-rate");
      this.audit(`conn-refused id=${id} reason=handshake-rate window=${this.handshakeTimes.length}`);
      return { id, inbound: () => {}, transportClosed: () => {}, close: () => {} };
    }
    this.conns.set(id, st);
    hooks.onMessage((data, isBinary) => this.inbound(st, data, isBinary));
    hooks.onClose(() => this.transportClosedInternal(st));
    if (hooks.onPong) hooks.onPong(() => { st.lastFrameAt = this.now(); });
    this.scheduleSupervision(st, hooks);
    this.audit(`conn-open id=${id} origin=${meta.origin ?? "<missing>"} loopback=${meta.loopback} tls=${meta.tls} conns=${this.conns.size}`);
    return {
      id,
      inbound: (data, isBinary) => this.inbound(st, data, isBinary),
      transportClosed: () => this.transportClosedInternal(st),
      close: (code, reason) => this.closeConn(st, code ?? 1000, reason ?? ""),
    };
  }

  // ---- 入站管线（契约 §5.6：包络→〔未认证且非 hello→4401〕→冻结校验器→业务）----
  private inbound(st: ConnState, data: string, isBinary: boolean): void {
    if (st.closed || this.disposed) return;
    st.lastFrameAt = this.now();
    if (isBinary) { this.errFrame(st, 4404, "二进制帧拒绝（JSON 文本帧）", ""); return; }
    if (utf8Bytes(data) > LIMITS.frameMaxBytes) { this.errFrame(st, 4404, "帧超字节上限", ""); return; }
    let msg: unknown;
    try { msg = JSON.parse(data); } catch { this.errFrame(st, 4404, "非 JSON", ""); return; }
    // 优先级①：未认证且非 hello→4401（hello 自身格式错→4404 由校验器判；t 不可识别先过格式层）
    const t = typeof msg === "object" && msg !== null && !Array.isArray(msg) ? (msg as Record<string, unknown>).t : undefined;
    if (typeof t !== "string") { this.errFrame(st, 4404, "帧必须是 JSON 对象", ""); return; }
    if (!st.authed && t !== "hello") { this.rejectAuth(st, "未认证"); return; }
    // W1-01：协议单入口=冻结校验器（格式层→版本层→写类层；固定消息不回显）
    const check = validateClientFrame(msg);
    if (!check.ok) {
      // 拒绝帧回显 requestId 仅限已验形状（有界合法形才回显——未验输入不反射；W1-01⑤）
      const rid = typeof msg === "object" && msg !== null && "requestId" in msg
        && typeof (msg as { requestId?: unknown }).requestId === "string"
        && /^[-\w]{1,64}$/.test((msg as { requestId: string }).requestId)
        ? (msg as { requestId: string }).requestId : "";
      this.errFrame(st, check.code as 4403 | 4404 | 4405, check.message, rid);
      return;
    }
    const frame = check.frame;
    if (frame.t === "hello") { this.handleHello(st, frame); return; }
    if (frame.t === "ping") { // ping 无 requestId（W1-01：不占在途槽）
      this.enqueue(st, { t: "pong", nonce: frame.nonce });
      return;
    }
    // 请求级帧：requestId 在途门（重复→4404；第 5 个并发→4404〔契约 §369〕）
    const requestId = frame.requestId;
    if (st.inflight.has(requestId)) { this.errFrame(st, 4404, "requestId 在途重复", requestId); return; }
    if (st.inflight.size >= LIMITS.inFlightRequestsPerConn) { this.errFrame(st, 4404, "在途请求超限", requestId); return; }
    st.inflight.add(requestId); // 同步占位（原子受理边界；各 handler finally 归还）
    switch (frame.t) {
      case "subscribe": void this.handleSubscribe(st, frame); return;
      case "unsubscribe": this.handleUnsubscribe(st, frame); return;
      case "list-sessions": void this.handleList(st, frame); return;
      case "get-recovery": void this.handleRecovery(st, frame); return;
    }
  }

  private handleHello(st: ConnState, frame: Extract<ClientFrame, { t: "hello" }>): void {
    if (st.authed) { this.errFrame(st, 4404, "重复 hello", ""); return; }
    st.preAuthFrames++;
    if (st.preAuthFrames > (this.opts.helloMaxFrames ?? 3)) { this.rejectAuth(st, "认证窗口帧数超限"); return; }
    // Origin 门：精确集合（缺失默认拒；全等匹配）
    const origin = st.meta.origin;
    if (origin === undefined || !this.opts.allowedOrigins.includes(origin)) {
      this.audit(`hello-origin-rejected conn=${st.id}`);
      this.rejectAuth(st, "Origin 不在白名单");
      return;
    }
    if ((this.opts.requireTlsOffLoopback ?? true) && !st.meta.loopback && !st.meta.tls) {
      this.rejectAuth(st, "非 loopback 须 TLS");
      return;
    }
    if (!this.opts.tokens.check(frame.token)) {
      this.audit(`hello-token-rejected conn=${st.id}`);
      this.rejectAuth(st, "令牌无效");
      return;
    }
    st.tokenDigest = sha256Hex(frame.token);
    st.authed = true;
    const tm = this.connTimers.get(st.id);
    if (tm && tm.auth !== null) { this.clr(tm.auth); tm.auth = null; } // 认证达成即撤截止 timer
    this.enqueue(st, { t: "welcome", serverBootId: BOOT_ID, protocolVersion: 1 });
  }

  private rejectAuth(st: ConnState, reason: string): void {
    this.enqueue(st, { t: "error", code: 4401, message: `未认证或令牌无效（${reason}）`, retryable: false, requestId: "" });
    this.closeConn(st, 1008, "auth");
  }

  /** 协议错误帧统一出口（W1-01 错误矩阵：4403→close 1003、4405→close 1008、4404 计数 3→close 1002）。 */
  private errFrame(st: ConnState, code: 4401 | 4403 | 4404 | 4405, message: string, requestId: string): void {
    this.enqueue(st, { t: "error", code, message, retryable: false, requestId });
    if (code === 4403) { this.closeConn(st, 1003, "protocol-version"); return; }
    if (code === 4405) { this.closeConn(st, 1008, "write-frozen"); return; }
    if (code === 4404) {
      st.err4404Count++;
      if (st.err4404Count >= 3) this.closeConn(st, 1002, "too-many-4404");
    }
  }

  // ---- 订阅（§3.6 三分支互斥；同连接同 file 唯一；≤8；W1-04 数据入口+W1-05 原子切换）----
  private async handleSubscribe(st: ConnState, frame: Extract<ClientFrame, { t: "subscribe" }>): Promise<void> {
    const requestId = frame.requestId;
    const file = frame.file;
    try {
      if (resolveWithinRoots(file, this.opts.roots) === null) {
        this.errFrame(st, 4404, "file 越界", requestId);
        return;
      }
      const existing = st.subs.get(file);
      if ("snapshotId" in frame) {
        // 续页：须有现存引擎；错误帧同样入 4404 计数（W1-01④）
        if (existing === undefined) { this.errFrame(st, 4404, "请求与订阅状态不符", requestId); return; }
        this.emitFrames(st, existing.engine.handle({ kind: "page", requestId, snapshotId: frame.snapshotId, historyNext: frame.historyNext }));
        this.schedulePump(file); // 追平可能把 buffered 搬入 outbox——需排空（页完成不触发 watchFile 分发）
        return;
      }
      // init/resync：配额先行（替换同 file 不占新位）
      if (existing === undefined && st.subs.size >= LIMITS.subscriptionsPerConn) {
        this.enqueue(st, { t: "error", code: 4429, message: "订阅数超限", retryable: false, requestId });
        return;
      }
      // B1（w1b）：错流门先行——resync 游标必须指向当前流（冻结契约 §1.3：streamId≠当前→4404）。
      // 无已知流（waterMark=0）同拒；盘面改写后的换流判定在 syncIndex 后二验。
      if ("cursor" in frame) {
        const curStream = this.currentStreamId(file);
        if (curStream === null || curStream !== frame.cursor.streamId) {
          this.errFrame(st, 4404, "请求与订阅状态不符", requestId);
          this.audit(`resync-wrong-stream conn=${st.id} file=${file} cursor=${frame.cursor.streamId} current=${curStream ?? "<none>"}`);
          return;
        }
      }
      const source = this.opts.historySource;
      if (source === undefined) {
        this.enqueue(st, { t: "error", code: 4402, message: "会话不可读", retryable: true, requestId });
        return;
      }
      let rows: readonly ScanRow[] | null;
      try {
        rows = await source.load(file);
      } catch {
        rows = null;
      }
      if (st.closed) return; // 等待期间断开（W1-07 同型复核）
      if (rows === null) {
        this.enqueue(st, { t: "error", code: 4402, message: "会话不可读", retryable: true, requestId });
        return;
      }
      // W1-04：索引装载（前缀判定/换流 replace；registry/get 超预算→4402）
      let engine: SubscriptionEngine;
      let frames: readonly ServerFrame[];
      try {
        const index = this.syncIndex(file, rows);
        // B1 二验：syncIndex 换流后（盘面改写）当前流身份已变——旧游标不再有效（统一 4404，不静默跳过错流门）
        if ("cursor" in frame && index.streamId !== frame.cursor.streamId) {
          this.errFrame(st, 4404, "请求与订阅状态不符", requestId);
          this.audit(`resync-stream-replaced-disk conn=${st.id} file=${file} cursor=${frame.cursor.streamId} current=${index.streamId}`);
          return;
        }
        engine = new SubscriptionEngine({
          index,
          status: () => this.opts.statusFor?.(file) ?? unknownStatus(file),
          now: this.now,
          newId: this.newIdFn,
        });
        frames = "cursor" in frame
          ? engine.startResync(requestId, frame.cursor)
          : engine.startSnapshot(requestId);
      } catch (e) {
        if (e instanceof FileOverBudgetError) {
          this.enqueue(st, { t: "error", code: 4402, message: "会话索引超预算不可读", retryable: true, requestId });
        } else {
          this.audit(`subscribe-failed conn=${st.id} file=${file}`);
          this.enqueue(st, { t: "error", code: 4402, message: "会话不可读", retryable: true, requestId });
        }
        return;
      }
      // W1-05：原子切换——先试启新引擎；失败只发错误（旧订阅原样保留）
      const first = frames[0];
      if (frames.length === 1 && first !== undefined && first.t === "error") {
        if ((first as { code?: number }).code === 4404) {
          this.errFrame(st, 4404, "请求与订阅状态不符", requestId);
        } else {
          this.emitFrames(st, frames); // 4409 游标超前（可重试；不动旧订阅）
        }
        return;
      }
      // B3（w1b）：提交点重验——await 载入窗口内状态可能已变；旧快照 existing 不得作为唯一依据
      const current = st.subs.get(file);
      if (current === undefined && st.subs.size >= LIMITS.subscriptionsPerConn) {
        engine.close(4431, "quota-lost-race", false);
        this.enqueue(st, { t: "error", code: 4429, message: "订阅数超限", retryable: false, requestId });
        return;
      }
      // 成功：退旧（通知关联旧 subscriptionId+撤未发旧帧）再装新（退的是【当前】旧订阅，非 await 前快照）
      if (current !== undefined) {
        const oldId = current.engine.subscriptionId;
        this.enqueue(st, { t: "error", code: 4409, message: `stream-replaced:${oldId}`, retryable: true, requestId });
        current.engine.close(4431, "stream-replaced", false);
        st.queue.cancelBySubscription(oldId);
        st.subs.delete(file);
      }
      st.subs.set(file, { engine });
      this.watchFile(st, file);
      this.emitFrames(st, frames);
      this.schedulePump(file); // 单页即追平（hasMore=false）时 buffered 已入 outbox——需排空
    } finally {
      st.inflight.delete(requestId);
    }
  }

  /** B1（w1b）：当前流身份（无已知流→null；预算尽/异常→null 由调用方按 4404 拒）。 */
  private currentStreamId(file: string): string | null {
    try {
      const index = this.registry.get(file);
      return index.waterMark > 0 ? index.streamId : null;
    } catch {
      return null;
    }
  }

  /** W1-04：索引装载与增量同步（前缀→追加；非前缀=盘面改写→换流重建）。 */
  private syncIndex(file: string, rows: readonly ScanRow[]) {
    let index = this.registry.get(file);
    if (index.waterMark === 0) {
      for (const row of rows) index.append(row.source, row.locator, row.raw, row.event);
      return index;
    }
    if (index.isPrefixOf(rows)) {
      for (let i = index.waterMark; i < rows.length; i++) {
        const row = rows[i];
        if (row !== undefined) index.append(row.source, row.locator, row.raw, row.event);
      }
      return index;
    }
    // 非前缀=改写：换流（registry.replace 后新 streamId；观察器重挂由 watchFile 处理）
    this.registry.replace(file);
    index = this.registry.get(file);
    for (const row of rows) index.append(row.source, row.locator, row.raw, row.event);
    return index;
  }

  /** W1-04：文件级共享观察器+排空泵（多连接同文件一份 observe；引用归零即停观察）。 */
  private watchFile(st: ConnState, file: string): void {
    let w = this.watchers.get(file);
    if (w === undefined) {
      w = { refs: new Set(), unobserve: null };
      this.watchers.set(file, w);
    }
    w.refs.add(st);
    if (w.unobserve === null && this.opts.historySource?.observe !== undefined) {
      this.registry.get(file); // touch LRU（观察活跃=索引保活）
      w.unobserve = this.opts.historySource.observe(file, {
        onAppend: (row) => {
          // B2（w1b）：事件时取【当前】索引（换流 replace 后旧闭包索引不得再接收追加）
          const index = this.registry.get(file);
          const seq = index.append(row.source, row.locator, row.raw, row.event);
          // B2：分发用索引规范化后的统一坐标（丢弃外部 seq，引擎/索引恒一致）
          const indexed = index.read(seq, 1)[0];
          if (indexed === undefined) { this.audit(`history-append-lost file=${file} seq=${seq}`); return; }
          this.forEachEngine(file, (e) => e.onHistoryAppend(indexed.event));
          // B4（w1b）：observe 通路容量出口——触顶即关流（4402 通知+清理），不靠慢客户端门掩盖索引无限增长
          if (index.overBudget) {
            this.audit(`index-over-budget file=${file} waterMark=${index.waterMark}`);
            this.closeSubscriptionsFor(file, "index-over-budget");
          }
          this.schedulePump(file);
        },
        onLive: (ev) => {
          this.forEachEngine(file, (e) => e.onLiveEvent(ev));
          this.schedulePump(file);
        },
        onStatus: (status) => {
          this.forEachEngine(file, (e) => e.onStatus(status));
          this.schedulePump(file);
        },
      });
    }
  }

  /** B4：文件触顶——对该 file 所有活跃订阅发 4402+静默关引擎+退观察引用（下次重订阅走换流）。 */
  private closeSubscriptionsFor(file: string, reason: string): void {
    const w = this.watchers.get(file);
    if (w === undefined) return;
    for (const c of [...w.refs]) {
      const sub = c.subs.get(file);
      if (sub === undefined) continue;
      this.enqueueIfOpen(c, { t: "error", code: 4402, message: "会话索引超预算，请重新订阅", retryable: true, requestId: "" });
      sub.engine.close(4431, reason, false);
      c.queue.cancelBySubscription(sub.engine.subscriptionId);
      c.subs.delete(file);
      this.releaseWatcher(c, file);
    }
  }

  private forEachEngine(file: string, fn: (e: SubscriptionEngine) => void): void {
    const w = this.watchers.get(file);
    if (w === undefined) return;
    for (const c of w.refs) {
      const sub = c.subs.get(file);
      if (sub !== undefined) fn(sub.engine);
    }
  }

  private schedulePump(file: string): void {
    if (this.pendingPumps.has(file)) return;
    this.pendingPumps.add(file);
    this.tmr(() => {
      this.pendingPumps.delete(file);
      const w = this.watchers.get(file);
      if (w === undefined) return;
      for (const c of w.refs) {
        const sub = c.subs.get(file);
        if (sub === undefined || c.closed) continue;
        const frames = sub.engine.drain();
        if (frames.length > 0) this.emitFrames(c, frames);
        if (frames.length >= LIMITS.liveFramesPerDrain) this.schedulePump(file); // 仍有积压→续泵
      }
    }, 0);
  }

  private releaseWatcher(st: ConnState, file: string): void {
    const w = this.watchers.get(file);
    if (w === undefined) return;
    w.refs.delete(st);
    if (w.refs.size === 0) {
      try { w.unobserve?.(); } catch { /* 宿主清理异常不阻断 */ }
      this.watchers.delete(file);
      this.pendingPumps.delete(file);
    }
  }

  private handleUnsubscribe(st: ConnState, frame: Extract<ClientFrame, { t: "unsubscribe" }>): void {
    try {
      for (const [file, sub] of st.subs) {
        if (sub.engine.subscriptionId === frame.subscriptionId) {
          sub.engine.close(4431, "", false); // 静默关闭（无 error 帧）
          this.releaseWatcher(st, file);
          st.subs.delete(file);
          st.queue.cancelBySubscription(frame.subscriptionId); // 撤未发帧（退订后不残留）
          this.audit(`unsubscribe conn=${st.id} file=${file}`);
          break;
        }
      }
    } finally {
      st.inflight.delete(frame.requestId);
    }
  }

  // ---- list-sessions（计算闸+扫描+装帧；W1-07 断开取消+W1-11 内容指纹版本）----
  private async handleList(st: ConnState, frame: Extract<ClientFrame, { t: "list-sessions" }>): Promise<void> {
    const requestId = frame.requestId;
    const offset = frame.offset ?? 0;
    const limit = frame.limit ?? LIMITS.listPageSizeDefault;
    const task = this.registerTask(st, requestId);
    try {
      const r = await task.acq.promise;
      if (!r.ok) {
        this.enqueueIfOpen(st, r.kind === "timeout"
          ? { t: "error", code: 4409, message: "计算排队超时", retryable: true, requestId }
          : { t: "error", code: 4409, message: "请求已取消", retryable: true, requestId });
        return;
      }
      task.phase = "running";
      if (st.closed) { r.release(); return; } // W1-07：grant 后执行前复核存活
      try {
        const scan = await scanSessions(this.opts.scanDir);
        if (st.closed) return;
        const items = scan.sessions.map(toDto);
        // W1-11+B5（w1b）：版本=实际可见列表态指纹（含 title/sessionId/可靠性等全部 DTO 可见字段+目录可靠性——同长改题也推进；静态跨页/跨连接稳定）
        const fp = listFingerprint(items, scan.dirReliability);
        if (fp !== this.listFingerprint) { this.listFingerprint = fp; this.listVersion++; }
        const out = buildSessionsFrame(requestId, items, offset, this.listVersion, scan.dirReliability, limit);
        if (out === null) this.enqueueIfOpen(st, { t: "error", code: 4431, message: "列表帧超预算", retryable: false, requestId });
        else this.enqueueIfOpen(st, out);
      } finally {
        r.release();
      }
    } catch {
      this.enqueueIfOpen(st, { t: "error", code: 4402, message: "列表扫描失败", retryable: true, requestId });
    } finally {
      st.tasks.delete(requestId);
      st.inflight.delete(requestId);
    }
  }

  // ---- get-recovery（计算闸+权威证据快照链；B03 禁裸读盘面；W1-06 哈希门+typed adapter）----
  private async handleRecovery(st: ConnState, frame: Extract<ClientFrame, { t: "get-recovery" }>): Promise<void> {
    const requestId = frame.requestId;
    const file = frame.file;
    try {
      if (resolveWithinRoots(file, this.opts.roots) === null) {
        this.errFrame(st, 4404, "file 越界", requestId);
        return;
      }
      // B8（w1b）：恢复内容页缓存（契约 §4：首响应冻结+内容页缓存）——续页直接从冻结投影出帧，
      // 不重调 provider、不占计算槽；缓存有界（每连接 ≤8，FIFO 驱逐）+连接关闭即清。
      const cacheKey = `${requestId}|${file}`;
      const cached = st.recoveryPages.get(cacheKey);
      if (cached !== undefined) {
        if (frame.evidenceHash !== undefined && frame.evidenceHash !== cached.hash) {
          this.enqueueIfOpen(st, { t: "error", code: 4409, message: "evidence-changed", retryable: true, requestId });
          return;
        }
        const cont = buildRecoveryFrame(requestId, file, cached.adapted, frame.offset ?? 0);
        if (cont === null) this.enqueueIfOpen(st, { t: "error", code: 4431, message: "恢复帧超预算", retryable: false, requestId });
        else this.enqueueIfOpen(st, cont);
        st.recoveryPages.delete(cacheKey); // LRU 触碰（重插入尾部）
        st.recoveryPages.set(cacheKey, cached);
        return;
      }
      const task = this.registerTask(st, requestId);
      const r = await task.acq.promise;
      if (!r.ok) {
        this.enqueueIfOpen(st, r.kind === "timeout"
          ? { t: "error", code: 4409, message: "计算排队超时", retryable: true, requestId }
          : { t: "error", code: 4409, message: "请求已取消", retryable: true, requestId });
        return;
      }
      task.phase = "running";
      if (st.closed) { r.release(); return; }
      try {
        const provider = this.opts.recoveryEvidence;
        const snap = provider === undefined ? null : await provider(file);
        if (st.closed) return;
        if (snap === null) {
          this.enqueueIfOpen(st, { t: "recovery", requestId, file, availability: "unavailable", reason: "no-evidence-snapshot" });
          return;
        }
        const hash = snapshotEvidenceHash(snap);
        // W1-06：证据哈希门（客户端带旧 hash=续页；证据已变→4409 重取，不得拼跨版本页）
        if (frame.evidenceHash !== undefined && frame.evidenceHash !== hash) {
          this.enqueueIfOpen(st, { t: "error", code: 4409, message: "evidence-changed", retryable: true, requestId });
          return;
        }
        const report = recoverFromSnapshot(snap);
        const adapted = { ...report, evidenceHash: hash, blockedReasons: mapBlockedReasons(snap, report) };
        // B8：首响应冻结——缓存投影（同 hash 续页确定性拼回；≥501 意图跨页不依赖盘面不变）
        st.recoveryPages.set(cacheKey, { hash, adapted });
        while (st.recoveryPages.size > RECOVERY_PAGE_CACHE_MAX) {
          const oldest = st.recoveryPages.keys().next().value;
          if (oldest === undefined) break;
          st.recoveryPages.delete(oldest);
        }
        const out = buildRecoveryFrame(requestId, file, adapted, frame.offset ?? 0);
        if (out === null) this.enqueueIfOpen(st, { t: "error", code: 4431, message: "恢复帧超预算", retryable: false, requestId });
        else this.enqueueIfOpen(st, out);
      } finally {
        r.release();
      }
    } catch {
      this.enqueueIfOpen(st, { t: "error", code: 4402, message: "恢复读取失败", retryable: true, requestId });
    } finally {
      st.tasks.delete(requestId);
      st.inflight.delete(requestId);
    }
  }

  /** 计算任务所有者登记（W1-07：断开→排队中即取消）。 */
  private registerTask(st: ConnState, requestId: string): ComputeTask {
    const acq = this.sem.acquire();
    const task: ComputeTask = { acq, phase: "queued" };
    st.tasks.set(requestId, task);
    return task;
  }

  private enqueueIfOpen(st: ConnState, frame: ServerFrame): void {
    if (st.closed) return;
    this.enqueue(st, frame);
  }

  // ---- 出帧（唯一路径=ConnectionQueue）----
  private enqueue(st: ConnState, frame: ServerFrame): void {
    const r = st.queue.enqueue(frame);
    if (r !== "queued") {
      this.audit(`conn=${st.id} enqueue-${r}`);
      this.closeConn(st, 4431, "connection-queue-overflow");
    }
  }

  private emitFrames(st: ConnState, frames: readonly ServerFrame[]): void {
    for (const f of frames) {
      this.enqueueIfOpen(st, f);
      // 引擎产出的 4404 错误帧同样计入累计器（W1-01④：续页错流/过期等不得绕过 3 次关闭门）
      if (f.t === "error" && (f as { code?: number }).code === 4404 && !st.closed) {
        st.err4404Count++;
        if (st.err4404Count >= 3) this.closeConn(st, 1002, "too-many-4404");
      }
    }
  }

  // ---- 监督（W1-02：认证截止独立 timer+心跳/寿命统一 tick——ping/idle 全禁用时寿命仍被检查）----
  private scheduleSupervision(st: ConnState, hooks: GatewayConnHooks): void {
    const entry: { auth: unknown; tick: unknown; lastPing: number } = { auth: null, tick: null, lastPing: this.now() };
    this.connTimers.set(st.id, entry);
    const helloMs = this.opts.helloWindowMs ?? 10_000;
    if (helloMs > 0) {
      entry.auth = this.tmr(() => {
        const c = this.conns.get(st.id);
        if (c === undefined || c.closed) return;
        if (!c.authed) {
          this.enqueue(c, { t: "error", code: 4401, message: "未认证或令牌无效（认证窗口超时）", retryable: false, requestId: "" });
          this.closeConn(c, 1008, "auth-deadline");
        }
      }, helloMs);
    }
    // tick 周期=ping/idle/寿命的最小正周期（全禁用时用 5s 慢速巡检寿命）
    const cands = [this.pingMs, this.idleMs, this.maxLifetimeMs].filter((v) => v > 0);
    const tickMs = Math.min(...(cands.length > 0 ? cands : [5_000]), 5_000);
    const tick = (): void => {
      const c = this.conns.get(st.id);
      if (c === undefined || c.closed) return;
      const now = this.now();
      const { lastFrameAt, connectedAt } = c;
      if (this.idleMs > 0 && now - lastFrameAt >= this.idleMs) {
        this.enqueue(c, { t: "error", code: 4432, message: "心跳超时", retryable: true, requestId: "" });
        this.closeConn(c, 1000, "heartbeat-timeout");
        return;
      }
      if (this.maxLifetimeMs > 0 && now - connectedAt >= this.maxLifetimeMs) {
        this.closeConn(c, 1000, "lifetime-cap");
        return;
      }
      if (this.pingMs > 0 && hooks.ping && now - entry.lastPing >= this.pingMs) {
        hooks.ping();
        entry.lastPing = now;
      }
      // B7（w1b）：安静连接资源主动释放——末页宽限过期无需等 drain/下一请求
      for (const [, sub] of c.subs) sub.engine.purge();
      entry.tick = this.tmr(tick, tickMs);
    };
    if (tickMs > 0) entry.tick = this.tmr(tick, tickMs);
  }

  private closeConn(st: ConnState, code: number, reason: string): void {
    if (st.closed) return;
    st.closed = true;
    // W1-07：取消排队中计算任务（运行中的自然结束；grant 后有存活复核）
    for (const [, task] of st.tasks) {
      if (task.phase === "queued") {
        try { task.acq.cancel(); } catch { /* 取消异常不阻断清理 */ }
      }
    }
    st.tasks.clear();
    st.recoveryPages.clear(); // B8：恢复页缓存随连接终结
    for (const [file] of st.subs) {
      const sub = st.subs.get(file);
      sub?.engine.close(4431, "", false);
      this.releaseWatcher(st, file);
    }
    st.subs.clear();
    const tm = this.connTimers.get(st.id);
    if (tm) {
      if (tm.auth !== null) this.clr(tm.auth);
      if (tm.tick !== null) this.clr(tm.tick);
      this.connTimers.delete(st.id);
    }
    st.queue.close(code, reason); // 队列尽力排空（1000）或按错误码收敛
    this.conns.delete(st.id);
    this.audit(`conn-close id=${st.id} code=${code} reason=${reason}`);
  }

  private transportClosedInternal(st: ConnState): void {
    if (st.closed) return;
    st.closed = true;
    for (const [, task] of st.tasks) {
      if (task.phase === "queued") {
        try { task.acq.cancel(); } catch { /* 同上 */ }
      }
    }
    st.tasks.clear();
    st.recoveryPages.clear(); // B8：恢复页缓存随连接终结
    for (const [file] of st.subs) {
      const sub = st.subs.get(file);
      sub?.engine.close(4431, "", false);
      this.releaseWatcher(st, file);
    }
    st.subs.clear();
    const tm = this.connTimers.get(st.id);
    if (tm) {
      if (tm.auth !== null) this.clr(tm.auth);
      if (tm.tick !== null) this.clr(tm.tick);
      this.connTimers.delete(st.id);
    }
    st.queue.onTransportClosed();
    this.conns.delete(st.id);
    this.audit(`conn-transport-closed id=${st.id}`);
  }

  get connectionCount(): number {
    return this.conns.size;
  }

  dispose(): void {
    this.disposed = true;
    for (const c of [...this.conns.values()]) this.closeConn(c, 1000, "server-shutdown");
    for (const [file, w] of [...this.watchers.entries()]) {
      try { w.unobserve?.(); } catch { /* 同上 */ }
      this.watchers.delete(file);
    }
  }
}

// ---- 帮手 ----
function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** 目录内容指纹（W1-11）：file|size|entries|lastActive 的稳定序列哈希（内容态代理；同指纹→版本不变）。 */
function listFingerprint(items: readonly ReturnType<typeof toDto>[], dirReliability: string): string {
  // B5：覆盖全部 DTO 可见字段（file/sessionId/title/lastActiveMs/entryCount/sizeBytes/hasRecoveryNotice/listReliability）+目录可靠性
  const parts = items.map((s) => `${s.file}|${s.sessionId ?? "x"}|${s.title.text}|${s.lastActiveMs ?? "x"}|${s.entryCount}|${s.sizeBytes}|${s.hasRecoveryNotice}|${s.listReliability}`);
  return sha256Hex(`${dirReliability}\n${parts.join("\n")}`);
}

/** W1-06：证据快照→阻断理由映射（torn-tail/bad-line/unattributable-fragment；来源=快照证据，确定性映射）。 */
function mapBlockedReasons(snap: RecoveryEvidenceSnapshot, report: ReturnType<typeof recoverFromSnapshot>): RecoveryBlockReason[] {
  const reasons: RecoveryBlockReason[] = [];
  const bad = snap.bad;
  let badLineCount = 0;
  let tornTail = false;
  for (const b of bad) {
    if (b.partialTail) tornTail = true;
    else badLineCount++;
  }
  if (tornTail) reasons.push({ kind: "torn-tail" });
  if (badLineCount > 0) reasons.push({ kind: "bad-line", count: badLineCount });
  const unattr = report.unattributableFragments.length;
  if (unattr > 0) reasons.push({ kind: "unattributable-fragment", count: unattr });
  return reasons;
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

const BOOT_ID = `boot-${Math.random().toString(36).slice(2, 10)}`;
