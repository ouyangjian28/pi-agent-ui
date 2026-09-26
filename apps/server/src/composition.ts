// 3b-3① 生产组合根：把 3b-1（真传输）与 3b-2（真源观察）组装成可运行服务。
// 职责边界（PROJECT 3b-3 冻结案）：
// - 唯一 clientIp 映射点=gatewayMetaFrom（ws-transport 导出；本层不自行派生网络事实）。
// - 授权根与历史根同源：roots 同时是网关 file 授权域与 DualHistorySource 的 journal 根
//   （resolveWithinRoots 同一口径——网关授权什么，源就最多能读什么，不允许源比网关授权面更宽）。
// - token fail-closed：tokenFile 缺失/非法/空集合→startServer 抛错拒绝启动（TokenAuthority.fromFile 语义）。
// - 热轮换：默认间隔轮询（mtime+size 指纹在 TokenAuthority 内；本层直接周期驱动 gateway.applyTokenReload
//   ——reload 幂等：文件未变=changed:false 无操作；变了→revoked 摘要→网关撤销既有连接 4401+1008）。
// - dispose 顺序（冻结）：摘 onConnection → 停轮询/SIGHUP → gateway.dispose()（存量连接 1000
//   "server-shutdown" 优雅关+文件观察器全解绑→DH 双源句柄归零）→ adapter.dispose()（传输层
//   兜底 1001+关自建 server）→ tokens.dispose()。gateway 先于 adapter：应用层告别帧先于传输层断链。
// - 不在本层：RpcSession 写侧接线（后续 UI 阶段）、recoveryEvidence（3b-4）、statusFor（缺省=unknown）。
import { WsServerAdapter, gatewayMetaFrom } from "./ws/ws-transport.ts";
import { TokenAuthority } from "./ws/token-auth.ts";
import { WsGateway } from "./ws/ws-gateway.ts";
import { ComputeSemaphore } from "./ws/compute-semaphore.ts";
import { DualHistorySource } from "./runtime/dual-history-source.ts";

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
  /** token 轮询间隔 ms（默认 5000；0=关闭轮询）。 */
  readonly tokenPollMs?: number;
  /** 注册 SIGHUP 热轮换钩子（默认 false=库模式不碰进程信号；生产入口置 true）。 */
  readonly registerSighup?: boolean;
  readonly audit?: (line: string) => void;
}

export interface PiAgentUiServer {
  readonly port: number;
  readonly host: string;
  /** 立即热轮换（等价 SIGHUP；幂等——文件未变无操作）。 */
  reloadTokens(): Promise<void>;
  dispose(): Promise<void>;
}

const DEFAULT_TOKEN_POLL_MS = 5_000;

/** 启动生产服务（fail-closed：任何配置/环境错误=抛错，不启动）。 */
export async function startServer(config: ServerConfig): Promise<PiAgentUiServer> {
  if (config.allowedOrigins.length === 0) throw new Error("allowedOrigins 为空：拒绝启动（空白名单=配置错误）");
  if (config.roots.length === 0) throw new Error("roots 为空：拒绝启动");
  const audit = (line: string): void => { try { config.audit?.(line); } catch { /* 审计异常不阻断 */ } };

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
  const gateway = new WsGateway({
    tokens,
    roots: config.roots,
    scanDir: config.scanDir,
    allowedOrigins: config.allowedOrigins,
    ...(config.requireTlsOffLoopback !== undefined ? { requireTlsOffLoopback: config.requireTlsOffLoopback } : {}),
    semaphore,
    historySource: history,
    audit,
  });

  const adapter = new WsServerAdapter({
    allowedOrigins: config.allowedOrigins,
    ...(config.requireTlsOffLoopback !== undefined ? { requireTlsOffLoopback: config.requireTlsOffLoopback } : {}),
    ...(config.trustedProxies !== undefined ? { trustedProxies: config.trustedProxies } : {}),
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

  const { port, host } = await adapter.listen(config.port ?? 0, config.host ?? "127.0.0.1");

  const pollMs = config.tokenPollMs ?? DEFAULT_TOKEN_POLL_MS;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  if (pollMs > 0) {
    pollTimer = setInterval(() => { void gateway.applyTokenReload(); }, pollMs);
    pollTimer.unref?.();
  }
  const onSighup = (): void => { void server.reloadTokens(); };
  if (config.registerSighup === true) process.on("SIGHUP", onSighup);

  let disposed = false;
  const server: PiAgentUiServer = {
    port,
    host,
    reloadTokens: async () => { await gateway.applyTokenReload(); },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      offConn(); // 停新连接接入
      if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
      if (config.registerSighup === true) process.off("SIGHUP", onSighup);
      gateway.dispose(); // 应用层告别（1000 server-shutdown）+观察器全解绑（DH 句柄归零）
      await adapter.dispose(); // 传输层兜底（1001+关自建 server）
      tokens.dispose();
      audit("composition disposed");
    },
  };
  audit(`composition listening host=${host} port=${port} origins=${config.allowedOrigins.length} roots=${config.roots.length}`);
  return server;
}
