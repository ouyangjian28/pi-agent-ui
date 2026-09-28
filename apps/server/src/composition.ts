// 3b-3① 生产组合根：把 3b-1（真传输）与 3b-2（真源观察）组装成可运行服务。
// 职责边界（PROJECT 3b-3 冻结案）：
// - 唯一 clientIp 映射点=gatewayMetaFrom（ws-transport 导出；本层不自行派生网络事实）。
// - 授权根与历史根同源：roots 同时是网关 file 授权域与 DualHistorySource 的 journal 根
//   （resolveWithinRoots 同一口径——网关授权什么，源就最多能读什么，不允许源比网关授权面更宽）。
// - token fail-closed：tokenFile 缺失/非法/空集合→startServer 抛错拒绝启动（TokenAuthority.fromFile 语义）。
// - 热轮换：默认间隔轮询（周期全量读 tokenFile 并重新校验——无 mtime/size 指纹短路；TokenAuthority.reload
//   成功读入即 install 并返回 changed:true（**无内容比对短路**，集合未变也是 true——3b3-fix2 勘正原假描述）；只有
//   读失败/乱序完成才 changed:false；对变更集合撤销 revoked→网关撤销既有连接 4401+1008）。
// - dispose 顺序（冻结）：摘 onConnection → 停轮询/SIGHUP → gateway.dispose()（存量连接 1000
//   "server-shutdown" 优雅关+文件观察器全解绑→DH 双源句柄归零）→ adapter.dispose()（传输层
//   兜底 1001+关自建 server）→ tokens.dispose()。gateway 先于 adapter：应用层告别帧先于传输层断链。
// - 不在本层：RpcSession 写侧接线的实例构造细节（3c-3 起由 write 选项自建——会话注册表+statusFor
//   真源+统一销毁；宿主仍可用 writeHost 注入自供实现）。recoveryEvidence 已于 3b-4 接入。
import { WsServerAdapter, gatewayMetaFrom } from "./ws/ws-transport.ts";
import { TokenAuthority } from "./ws/token-auth.ts";
import { WsGateway } from "./ws/ws-gateway.ts";
import { ComputeSemaphore, ComputeGateQueueTimeout, type AcquireResult } from "./ws/compute-semaphore.ts";
import { DualHistorySource } from "./runtime/dual-history-source.ts";
import { createRecoveryEvidenceProvider, isRecoverySnapshot, type RecoveryEvidenceResult } from "./runtime/recovery-evidence-source.ts";
import { recoverFromSnapshot } from "./runtime/recover.ts";
import { createSessionRegistry, type SessionRegistry } from "./runtime/session-registry.ts";
import { createGuardedJournalWriterFactory } from "./runtime/guarded-journal-writer.ts";
import { randomUUID } from "node:crypto";
import { PiProcessHost } from "./host/process-host.ts";
import { createRpcWriteHost, type ResumeAuthority } from "./ws/rpc-write-host.ts";
import { logicalNameWithinRoots, resolveWithinRoots } from "./ws/safe-open.ts";
import type { WriteHostPort } from "./ws/write-host.ts";
import { createStaticHandler } from "./ws/static-serve.ts";
import { createLoginRoute, newSessionSecret } from "./http/login-route.ts";
import { createServer, type Server as HttpServer } from "node:http";
import { isAbsolute, join } from "node:path";

export interface ServerConfig {
  /** token 文件（0600 {version:1,tokens:[...]}；缺失/非法/空→拒绝启动）。 */
  readonly tokenFile: string;
  /** 精确 Origin 白名单（≥1；空数组=拒绝启动——空白名单服务毫无意义且掩盖配置错误）。 */
  readonly allowedOrigins: readonly string[];
  /** 授权双根=网关 file 域+journal 历史根（同源口径）。 */
  readonly roots: readonly string[];
  /** session 文件允许的根（默认=roots）。 */
  readonly sessionRoots?: readonly string[];
  /** 逻辑 file→session 路径映射（宿主策略；未提供=journal-only 降级）。 */
  readonly sessionFor?: (file: string) => string;
  /** list-sessions 扫描目录。 */
  readonly scanDir: string;
  /** 监听（默认 127.0.0.1:0 随机端口——生产传显式值）。 */
  readonly host?: string;
  readonly port?: number;
  /** 可信代理精确来源（默认 []=不采信任何转发头）。 */
  readonly trustedProxies?: readonly string[];
  /** 非 loopback 强制 TLS（默认 true）。 */
  readonly requireTlsOffLoopback?: boolean;
  /** 单文件扫描预算（默认 8MiB，DEFAULT_MAX_SCAN_BYTES）。 */
  readonly maxScanBytes?: number;
  /** 恢复投影合计入口预算 journal+session（默认 8MiB，DEFAULT_RECOVERY_COMBINED_BYTES）。 */
  readonly maxRecoveryCombinedBytes?: number;
  /** 恢复首捕授权（B12-1）：默认 false=锚点缺失→no-evidence-snapshot（fail-closed）。宿主显式
   * 开启=声明「当前盘面首捕即权威」（迁移既有 journal/可信新建——修复发生在首捕前的风险由宿主背书）。 */
  readonly trustFirstRecoveryCapture?: boolean;
  /** 恢复证据链锚点目录（B11-2；须绝对路径；默认=scanDir/recovery-evidence）。 */
  readonly recoveryEvidenceDir?: string;
  /** token 轮询间隔 ms（默认 5000；0=关闭轮询）。 */
  readonly tokenPollMs?: number;
  /** 注册 SIGHUP 热轮换钩子（默认 false=库模式不碰进程信号；生产入口置 true）。 */
  readonly registerSighup?: boolean;
  /** 写侧宿主（3c-1）：缺省=只读部署（写类帧 4405）；接入后网关开放 prompt/stop。
   * 与 write（3c-3 自建接线）互斥——两者同供=配置歧义拒启。 */
  readonly writeHost?: WriteHostPort;
  /** 静态托管目录（⑤B/3c-5 自举）：同端口 HTTP 服务该目录（web 构建产物，如 apps/web/dist）。
   * 设置后走外部 http server 模式（WS 同源 upgrade）；须配固定 port+对应同源 origin
   * （origin 白名单在构造期冻结，随机端口无法预知同源 origin——main 入口负责校验与推导）。 */
  readonly staticDir?: string;
  /** 写侧自建接线（3c-3）：组合根组装真实写链（PiProcessHost+会话注册表+RpcWriteHost+statusFor
   * 真源）；server.dispose() 统一销毁（全量 stop+dispose）。sessionFor 必填（RpcSession 构造硬要求
   * 会话文件；无映射=写侧无从落地=配置错误）。 */
  readonly write?: WriteWiringOpts;
  readonly audit?: (line: string) => void;
}

/** 写侧接线选项（ServerConfig.write；进程/超时透传 RpcSessionOpts 同名项）。 */
export interface WriteWiringOpts {
  /** journal 绝对路径 → 会话文件绝对路径（必填；映射非法=运行时描述性错误→4402+审计）。 */
  readonly sessionFor: (file: string) => string;
  /** pi 可执行（默认 PATH 解析 "pi"）。 */
  readonly piBin?: string;
  readonly responseTimeoutMs?: number;
  readonly turnTimeoutMs?: number;
  readonly readinessTimeoutMs?: number;
  readonly timeoutPollMs?: number;
  /** 闲置回收期限（默认 30min）。 */
  readonly idleMs?: number;
  /** EOF 宽限（闲置回收优雅链）。 */
  readonly eofGraceMs?: number;
  /** 观测面（20b B2）：pi spawn 即回调（journal 绝对路径 file+handle+generation）——
   * E2E 拿句柄身份做销毁链断言，不靠审计事后反推；纯观测不参与生命周期。 */
  readonly onSpawned?: (file: string, handle: { id: string }, generation: number) => void;
}

export interface PiAgentUiServer {
  readonly port: number;
  readonly host: string;
  /** 立即热轮换（等价 SIGHUP；幂等——文件未变无操作）。 */
  reloadTokens(): Promise<void>;
  dispose(): Promise<void>;
}

const DEFAULT_TOKEN_POLL_MS = 5_000;

/** 数值配置门（R-04）：有限安全整数且 >0——NaN/±Infinity/负数/分数/超安全整数一律拒启，
 * 否则会绕过读取侧硬限（如 maxScanBytes=NaN 时 `total > maxBytes` 恒 false）。 */
function requireFinitePosInt(name: string, v: number, max: number): number {
  if (!Number.isSafeInteger(v) || v <= 0 || v > max) {
    throw new Error(`${name} 非法（须为 1..${max} 的安全整数，实值 ${String(v)}）：拒绝启动`);
  }
  return v;
}

/** 绝对路径校验（R-04）：roots/sessionRoots/scanDir 元素必须非空绝对路径——相对根会把授权域
 * 绑到进程 cwd，属配置错误面。 */
function requireAbsPaths(name: string, paths: readonly string[]): readonly string[] {
  for (const p of paths) {
    if (typeof p !== "string" || p.length === 0 || !isAbsolute(p)) {
      throw new Error(`${name} 含非法元素（须非空绝对路径，实值 ${JSON.stringify(p)}）：拒绝启动`);
    }
  }
  return paths;
}

/** 启动生产服务（fail-closed：任何配置/环境错误=抛错，不启动）。 */
/** resumeAuthority 真源工厂（P0-2 r3a P1 修复/K3 审，导出供装配层测试）。
* 键口径：reportFor 入参=网关传来的 journal 绝对路径→归一为逻辑名再喂 provider（与 get-recovery
* 同键；seen-store/锚点持久键单一宇宙，B13-2 一致性）；generationFor 入参=绝对路径直查 registry
* （write 面口径——sendPrompt/stop/sessionFor 链全是绝对路径键）。
* r3b 资源面（K3 审 P2-3）：per-file in-flight 合并（并发读共享同次 provider 调用；**完成即删不缓存**
* ——无失效钩子下缓存 resume #1 快照跨 send 不失效→同 matchKey 双发面，正确性否决缓存）；
* 断连取消=r3c 已实装（连接级 abortCtl 信号透传：排队中 abort→acq.cancel；读段=provider 步骤间
* 观察；信号不覆盖 send 执行本身——口径详设设计稿 §2b 四件表）；预算闸=evidence-source
* 合计 8MiB 入口门（同源）。
* r3b-fix（K3 审 P2-1）：跨文件并发闸=semaphore（与 get-recovery 同一 ComputeSemaphore 实例，composition
* 注入）；先查 in-flight（同文件合并不占两次槽）→miss 才进闸；排队超时抛 ComputeGateQueueTimeout
* （网关转 4409 retryable，与 get-recovery 超时同构）。 */
export function makeResumeAuthority(deps: {
  roots: readonly string[];
  provider: (file: string, signal: AbortSignal) => Promise<RecoveryEvidenceResult | null>;
  registry: { statusFor(file: string): { process: { generation: number | null } } };
  semaphore?: { acquire(): { promise: Promise<AcquireResult>; cancel(): void } }; // 结构类型（AcquireResult 宽松形；测试替身同形）
}): ResumeAuthority {
  const { roots, provider, registry, semaphore: gate } = deps;
  const inflight = new Map<string, Promise<RecoveryEvidenceResult | null>>();
  const readOnce = (logical: string, signal?: AbortSignal): Promise<RecoveryEvidenceResult | null> => {
    // r3c：连接级取消信号（断连→排队中取消+读中停读）。同 file 并发已合并不继承后来者信号
    //（先到者的读继续服务多连接：in-flight 合并优先于信号隔离；取消者走结果丢弃=幂等面）。
    const hit = inflight.get(logical);
    if (hit !== undefined) return hit; // 并发合并：同 file 并发 resume/reportFor 只做一次盘读
    const run = async (): Promise<RecoveryEvidenceResult | null> => {
      if (gate === undefined) return provider(logical, signal ?? new AbortController().signal);
      const acq = gate.acquire();
      const onAbort = (): void => { acq.cancel(); }; // 排队中取消（grant 后不再挂——读段信号由 provider 步骤间消费）
      let r: Awaited<typeof acq.promise>;
      try {
        if (signal !== undefined) {
          if (signal.aborted) acq.cancel();
          else signal.addEventListener("abort", onAbort, { once: true });
        }
        r = await acq.promise;
      } finally {
        if (signal !== undefined) signal.removeEventListener("abort", onAbort); // 幂等（触发后 once 已移除，再调无害）
      }
      if (!r.ok) throw new ComputeGateQueueTimeout(); // kind=timeout/canceled 皆=忙面（断连取消同面——连接已亡，4409 帧丢弃即零副作用）
      try { return await provider(logical, signal ?? new AbortController().signal); }
      finally { r.release(); }
    };
    const p = run()
      .finally(() => { if (inflight.get(logical) === p) inflight.delete(logical); }); // 完成即删（不缓存）
    inflight.set(logical, p);
    return p;
  };
  const reportOf = async (file: string, signal?: AbortSignal) => {
    const logical = logicalNameWithinRoots(file, roots) ?? file;
    const snap = await readOnce(logical, signal); // r3c：取消信号透传（无信号=进程内即答；provider 预算保护同源）
    if (snap === null || !isRecoverySnapshot(snap)) return null;
    const r = recoverFromSnapshot(snap);
    return { report: r, snapValid: true as const };
  };
  return {
    reportFor: async (file: string, signal?: AbortSignal) => {
      const got = await reportOf(file, signal);
      if (got === null) return null;
      return { resendAuthorized: [...got.report.resendAuthorized], resumeBlocked: got.report.resumeBlocked };
    },
    generationFor: (file: string) => registry.statusFor(file).process.generation,
    executeFor: async (file: string, intentId: string, signal?: AbortSignal) => {
      const got = await reportOf(file, signal);
      if (got === null) return null;
      const rec = got.report.intents.find((i) => i.intentId === intentId);
      // 授权在则 intents 必含该 id（resendKeys 从 intents 派生）；缺=证据不完整（防御 null，非身份错）
      return {
        report: { resendAuthorized: [...got.report.resendAuthorized], resumeBlocked: got.report.resumeBlocked },
        payload: rec === undefined ? null : { rawText: rec.payload.rawText },
      };
    },
  };
}

export async function startServer(config: ServerConfig): Promise<PiAgentUiServer> {
  if (config.allowedOrigins.length === 0) throw new Error("allowedOrigins 为空：拒绝启动（空白名单=配置错误）");
  for (const o of config.allowedOrigins) {
    // Origin=非空合法来源串（scheme://host[:port]）；空串/裸串属配置错误
    if (typeof o !== "string" || o.length === 0 || !/^[a-z][a-z0-9+.-]*:\/\/[^\s]+$/i.test(o)) {
      throw new Error(`allowedOrigins 含非法来源（须非空合法 Origin 串，实值 ${JSON.stringify(o)}）：拒绝启动`);
    }
  }
  if (config.roots.length === 0) throw new Error("roots 为空：拒绝启动");
  requireAbsPaths("roots", config.roots);
  if (config.sessionRoots !== undefined) requireAbsPaths("sessionRoots", config.sessionRoots);
  if (config.scanDir !== undefined && !isAbsolute(config.scanDir)) throw new Error("scanDir 非法（须绝对路径）：拒绝启动");
  if (config.maxScanBytes !== undefined) requireFinitePosInt("maxScanBytes", config.maxScanBytes, 1024 * 1024 * 1024); // 1GiB 上界
  if (config.tokenPollMs !== undefined && config.tokenPollMs !== 0) {
    // 0=禁用轮询；正值须为安全整数且 ≤ Node 定时器上限（2^31-1）
    requireFinitePosInt("tokenPollMs", config.tokenPollMs, 2_147_483_647);
  }
  // B11-4（GPT 3b4 复审 P08）：预算门独立于 tokenPollMs 分支——原嵌套导致 tokenPollMs 省略/0 时
  // 非法预算（如 Infinity）溜过启动门；provider 工厂自验（B11-4 纵深）之外在此拒启动。
  if (config.maxRecoveryCombinedBytes !== undefined) {
    requireFinitePosInt("maxRecoveryCombinedBytes", config.maxRecoveryCombinedBytes, 1024 * 1024 * 1024);
  }
  const audit = (line: string): void => { try { config.audit?.(line); } catch { /* 审计异常不阻断 */ } };

  // 写侧接线互斥门（3c-3）：writeHost（宿主自供）与 write（自建）同供=歧义拒启。
  if (config.writeHost !== undefined && config.write !== undefined) {
    throw new Error("writeHost 与 write 同供：写侧接线歧义，拒绝启动（二选一）");
  }
  // 3c-3 写侧自建链：PiProcessHost+会话注册表（真实 RpcSession 工厂+statusFor 真源+统一销毁面）。
  // P0-2 r1：守卫写者工厂（每 journal 懒装配锁→宣誓→守卫；bootId=本进程启动身份 P02-D2）。
  const writerBootId = randomUUID();
  const guardedWriters = createGuardedJournalWriterFactory({ bootId: writerBootId, audit: (l) => audit(l) });
  let registry: SessionRegistry | null = null;
  if (config.write !== undefined) {
    if (typeof config.write.sessionFor !== "function") {
      throw new Error("write.sessionFor 缺失或非函数：写侧无从落地会话文件，拒绝启动");
    }
    const host = new PiProcessHost({
      ...(config.write.piBin !== undefined ? { piBin: config.write.piBin } : {}),
      onAudit: (l) => audit(l),
    });
    registry = createSessionRegistry({
      host,
      sessionFor: config.write.sessionFor,
      durabilityFor: (file: string) => guardedWriters.writerFor(file), // P0-2 r1：守卫壳统一接管两写入口（FF-P02-2）
      ...(config.write.responseTimeoutMs !== undefined ? { responseTimeoutMs: config.write.responseTimeoutMs } : {}),
      ...(config.write.turnTimeoutMs !== undefined ? { turnTimeoutMs: config.write.turnTimeoutMs } : {}),
      ...(config.write.readinessTimeoutMs !== undefined ? { readinessTimeoutMs: config.write.readinessTimeoutMs } : {}),
      ...(config.write.timeoutPollMs !== undefined ? { timeoutPollMs: config.write.timeoutPollMs } : {}),
      ...(config.write.idleMs !== undefined ? { idleMs: config.write.idleMs } : {}),
      ...(config.write.eofGraceMs !== undefined ? { eofGraceMs: config.write.eofGraceMs } : {}),
      ...(config.write.onSpawned !== undefined ? { onSpawned: config.write.onSpawned } : {}),
      audit,
    });
  }

  // token fail-closed：缺失/不可读/非法/空集合→fromFile 抛错
  const tokens = await TokenAuthority.fromFile(config.tokenFile, {}, audit);

  const history = new DualHistorySource({
    roots: config.roots,
    ...(config.sessionRoots !== undefined ? { sessionRoots: config.sessionRoots } : {}),
    ...(config.sessionFor !== undefined ? { sessionFor: config.sessionFor } : {}),
    ...(config.maxScanBytes !== undefined ? { maxScanBytes: config.maxScanBytes } : {}),
    audit,
  });

  const semaphore = new ComputeSemaphore();
  // 3b-4：真读源 recoveryEvidence provider（typed 结果+合计 8MiB 入口预算+session 同源降级）。
  // B11-2：证据链锚点目录（默认 scanDir/recovery-evidence；已见证据只许纯追加扩展，改写→concurrent-modification）。
  const recoveryEvidenceDir = config.recoveryEvidenceDir ?? join(config.scanDir, "recovery-evidence");
  if (!isAbsolute(recoveryEvidenceDir)) throw new Error("recoveryEvidenceDir 非法（须绝对路径）：拒绝启动");
  const recoveryEvidence = createRecoveryEvidenceProvider({
    roots: config.roots,
    ...(config.sessionRoots !== undefined ? { sessionRoots: config.sessionRoots } : {}),
    ...(config.sessionFor !== undefined ? { sessionFor: config.sessionFor } : {}),
    evidenceDir: recoveryEvidenceDir,
    ...(config.maxRecoveryCombinedBytes !== undefined ? { maxCombinedBytes: config.maxRecoveryCombinedBytes } : {}),
    ...(config.trustFirstRecoveryCapture === true ? { trustFirstCapture: () => true } : {}),
    audit,
  });
  const gateway = new WsGateway({
    tokens,
    roots: config.roots,
    scanDir: config.scanDir,
    allowedOrigins: config.allowedOrigins,
    ...(config.requireTlsOffLoopback !== undefined ? { requireTlsOffLoopback: config.requireTlsOffLoopback } : {}),
    semaphore,
    historySource: history,
    recoveryEvidence,
    ...(registry !== null ? { statusFor: (file: string) => registry!.statusFor(resolveWithinRoots(file, config.roots) ?? file) } : {}),
    ...(config.writeHost !== undefined ? { writeHost: config.writeHost } : {}),
    // P0-2 r3a：帧身份权威源——报告=恢复证据链（与 get-recovery 同源同适配）；代次=registry 真源。
    ...(registry !== null ? {
      writeHost: createRpcWriteHost({
        sessionFor: (file: string) => registry!.sessionFor(file),
        audit,
        resumeAuthority: makeResumeAuthority({ roots: config.roots, provider: recoveryEvidence, registry: { statusFor: (f: string) => registry!.statusFor(f) }, semaphore }),
      }),
    } : {}),
    audit,
  });

  // ⑤B：staticDir 模式=外部 http server（静态服务+同源 upgrade）；否则=适配器自建 server。
  // 外部模式下 listen 所有权在 composition：适配器只挂 upgrade 钩子，关 server 归 dispose。
  // N4-v2：浏览器部署（staticDir）同端口叠加 /login+/logout（HttpOnly 会话 cookie）+升级面 sid 校验；
  // 非 staticDir（纯 WS 部署）无 HTTP 面=无登录面，令牌通道不变。
  const login = config.staticDir !== undefined
    ? createLoginRoute({
      authority: tokens,
      sessionSecret: newSessionSecret(),
      audit,
      allowedOrigins: config.allowedOrigins, // r1-B5：与 WS 升级面同表（HTTP 面来源门）
      ...(config.trustedProxies !== undefined ? { trustedProxies: config.trustedProxies } : {}), // r1-B1：同一可信代理派生
    })
    : null;
  const staticHandler = config.staticDir !== undefined ? createStaticHandler(config.staticDir, audit) : null;
  const httpServer: HttpServer | null = staticHandler !== null
    ? createServer((req, res) => {
      if (login !== null && login.handle(req, res)) return;
      staticHandler(req, res);
    })
    : null;
  const adapter = new WsServerAdapter({
    allowedOrigins: config.allowedOrigins,
    ...(config.requireTlsOffLoopback !== undefined ? { requireTlsOffLoopback: config.requireTlsOffLoopback } : {}),
    ...(config.trustedProxies !== undefined ? { trustedProxies: config.trustedProxies } : {}),
    ...(login !== null ? { sessionCookie: { name: "pi-agent-ui-session", validate: login.sessionIdentityOf } } : {}), // r1-B2：身份非布尔
    ...(httpServer !== null ? { server: httpServer } : {}),
    audit,
  });

  const offConn = adapter.onConnection((conn, tmeta) => {
    gateway.attach(conn, {
      onMessage: (cb) => conn.onMessage(cb),
      onClose: (cb) => conn.onClose(cb),
      onPong: (cb) => conn.onPong(cb),
      ping: () => conn.ping(),
    }, gatewayMetaFrom(tmeta));
  });

  let port: number;
  let host: string;
  if (httpServer !== null) {
    // 外部模式：同源静态+WS 共用监听；固定 port 由调用方保证（随机端口无法预知同源 origin）
    if ((config.port ?? 0) === 0) {
      throw new Error("staticDir 模式必须显式指定固定 port（同源 origin 白名单需预知端口）");
    }
    const bound = await new Promise<{ port: number; host: string }>((resolveListen, rejectListen) => {
      const onError = (err: Error): void => { rejectListen(err); };
      httpServer.once("error", onError);
      httpServer.listen(config.port, config.host ?? "127.0.0.1", () => {
        httpServer.off("error", onError);
        const a = httpServer.address();
        if (typeof a === "object" && a !== null) resolveListen({ port: a.port, host: a.address });
        else rejectListen(new Error("http server 监听后无法取得地址"));
      });
    });
    port = bound.port;
    host = bound.host;
  } else {
    ({ port, host } = await adapter.listen(config.port ?? 0, config.host ?? "127.0.0.1"));
  }

  const pollMs = config.tokenPollMs ?? DEFAULT_TOKEN_POLL_MS;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  if (pollMs > 0) {
    pollTimer = setInterval(() => { void gateway.applyTokenReload(); }, pollMs);
    pollTimer.unref?.();
  }
  const onSighup = (): void => { void server.reloadTokens(); };
  if (config.registerSighup === true) process.on("SIGHUP", onSighup);

  // Y-01（GPT 3b-3）：并发 dispose 共享同一收尾 Promise——布尔早退会让第二个调用方在首个
  // dispose 尚未完成时提前 resolve（观察到「半关」状态）；共享 Promise 保证所有等待方都在
  // 完整收尾（gateway 告别+adapter 断链+tokens 释放）之后才继续，且收尾体恰执行一次。
  let disposeP: Promise<void> | null = null;
  const server: PiAgentUiServer = {
    port,
    host,
    reloadTokens: async () => { await gateway.applyTokenReload(); },
    dispose: () => {
      if (disposeP !== null) return disposeP;
      disposeP = (async () => {
        offConn(); // 停新连接接入
        if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
        if (config.registerSighup === true) process.off("SIGHUP", onSighup);
        gateway.dispose(); // 应用层告别（1000 server-shutdown）+观察器全解绑（DH 句柄归零）
        await adapter.dispose(); // 传输层兜底（1001+关自建 server；外部模式=只摘 upgrade 钩子）
        if (httpServer !== null) {
          // ⑤B：外部 server 归 composition 所有权——有界关闭（closeAllConnections 截 keep-alive 残留）
          await new Promise<void>((resolveHttp) => {
            const guard = setTimeout(() => { resolveHttp(); }, 5_000);
            guard.unref?.();
            httpServer.close(() => { clearTimeout(guard); resolveHttp(); });
            httpServer.closeAllConnections();
          });
        }
        if (registry !== null) await registry.dispose(); // 3c-3：写侧统一销毁（全量 stop+dispose；网关先告别再杀进程）
        await guardedWriters.dispose(); // P0-2 r1：写面已静止后释放全部 writer 锁（FF-P02-3；释放失败=audit 残锁可接受）
        tokens.dispose();
        audit("composition disposed");
      })();
      return disposeP;
    },
  };
  audit(`composition listening host=${host} port=${port} origins=${config.allowedOrigins.length} roots=${config.roots.length}`);
  return server;
}
