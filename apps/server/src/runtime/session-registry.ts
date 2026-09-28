// 3c-3：composition 级会话注册表——journal 文件 → RpcSession 实例的唯一构造点+统一销毁面。
// 职责边界（第19d轮 GO 放行范围）：
// - 真实 RpcSession 工厂：同 file 恰建一次（本表是实例权威源；RpcWriteHost 的 single-flight
//   是「工厂调用恰一次」的二道防线，两层缓存指向同一实例，不发散）。
// - 构造零 IO：RpcSession 构造不 spawn（send 冷启动），本表 sessionFor 同步/幂等/不失败——
//   失败面只剩映射校验（sessionFor 映射非绝对路径=配置错误，抛描述性 Error→上层 4402+审计）。
// - statusFor 真源（进程/轮次/后台任务/回收=真值；recovery=不在此面——读侧 recovery 走独立
//   recoveryEvidence 异步面，同步 statusFor 不重复声称；statusVersion 恒 0=无版本化源，诚实披露）。
// - 统一销毁：dispose=全量 stop（退役进程：SIGTERM→宽限→SIGKILL→退出确认）+dispose（本地
//   句柄：巡检 timer/耐久/回收器），串行执行保审计确定性；幂等；dispose 后 sessionFor 拒绝。
import { FileDurability } from "./file-durability.ts";
import { RpcSession } from "./rpc-session.ts";
import type { UiAsk, UiNoteEvent } from "./rpc-session.ts";
import { sha256Hex12 } from "@pi-agent-ui/protocol";
import type { DurabilityPort, ProcessHandle, ProcessHostPort, SessionStatus, UiClosedReason } from "@pi-agent-ui/protocol";
import { isAbsolute } from "node:path";

export interface SessionRegistryOpts {
  /** 进程宿主（生产=PiProcessHost；测试=受控替身）。 */
  readonly host: ProcessHostPort;
  /** journal 绝对路径 → 会话文件绝对路径（必填；相对/空=配置错误抛错）。 */
  readonly sessionFor: (file: string) => string;
  /** 耐久工厂（默认=FileDurability(file)；测试注入替身）。 */
  readonly durabilityFor?: (file: string) => DurabilityPort;
  /** pi 参数透传（RpcSessionOpts 同名项）。 */
  readonly responseTimeoutMs?: number;
  readonly turnTimeoutMs?: number;
  readonly readinessTimeoutMs?: number;
  readonly timeoutPollMs?: number;
  readonly idleMs?: number;
  readonly eofGraceMs?: number;
  /** 观测面（20b B2）：pi 进程 spawn 时回调（file+handle+generation）——E2E/宿主在 spawn 时即记录
   * 句柄身份，不靠事后审计反推；纯观测不参与生命周期（RpcSessionOpts.onSpawned 同源）。 */
  readonly onSpawned?: (file: string, handle: ProcessHandle, generation: number) => void;
  /** 额外 pi 参数（透传 RpcSessionOpts.extraPiArgs；spawn 尾部追加）。 */
  readonly extraPiArgs?: readonly string[];
  /** D3：对话族提问（file 绑定后上抛；docs/d3-ui-passthrough-design.md）。 */
  readonly onUiRequest?: (file: string, ask: UiAsk) => void;
  /** D3：即显 notify→ui-note。 */
  readonly onUiNote?: (file: string, note: UiNoteEvent) => void;
  /** D3：提问作废（process-retired/overflow）。 */
  readonly onUiClosed?: (file: string, requestId: string, reason: UiClosedReason) => void;
  /** D1 直播面：pi 进程事件回调（file+事件+代次+分派结果）。disposition 门=白名单制
   *  shouldBroadcastLive（delivered/buffered 放行——buffered 的记账行已在 enqueue 硬序①落；
   *  其余拒）由调用方（composition 聚合器前）把关；纯观测不参与生命周期。 */
  readonly onPiEvent?: (file: string, ev: unknown, generation: number, disposition: string) => void;
  readonly audit?: (line: string) => void;
  readonly now?: () => string;
}

export interface SessionRegistry {
  /** 同步/幂等/缓存：同 file 同实例；dispose 后抛错。 */
  sessionFor(file: string): RpcSession;
  /** 观测：已构造的 journal 文件（排序快照）。 */
  files(): readonly string[];
  /** statusFor 真源（见文件头注；未构造=进程 idle 真值+其余 unknown 语义）。 */
  statusFor(file: string): SessionStatus;
  /** 统一销毁（全量 stop+dispose，串行，幂等）。 */
  dispose(): Promise<void>;
}

const UNKNOWN_RECOVERY: SessionStatus["recovery"] = {
  availability: "unavailable", resumeBlocked: null, diskBlocked: null, unknownEffectCount: null,
  unattributableFragments: null, intentsCount: null, settledCount: null, evidenceHash: null,
};

export function createSessionRegistry(opts: SessionRegistryOpts): SessionRegistry {
  const sessions = new Map<string, RpcSession>();
  const idleMs = opts.idleMs ?? 30 * 60_000;
  let disposed = false;
  let disposeP: Promise<void> | null = null;
  const safeAudit = (line: string): void => {
    try { opts.audit?.(line); } catch { /* 审计异常不阻断 */ }
  };
  const mapped = (file: string): string => {
    let s: string;
    try { s = opts.sessionFor(file); } catch (e: unknown) {
      throw new Error(`session-registry: sessionFor 映射抛错（file=${file}）：${e instanceof Error ? e.message : String(e)}`);
    }
    if (typeof s !== "string" || s.length === 0 || !isAbsolute(s)) {
      throw new Error(`session-registry: sessionFor 映射非法（须非空绝对路径，实值 ${JSON.stringify(s)}；file=${file}）`);
    }
    return s;
  };
  const sessionIdOf = (file: string): string => `sess-${sha256Hex12(file)}`;

  const baseStatus = (file: string): SessionStatus => ({
    session: { sessionId: sessionIdOf(file), file, adapterSessionId: null },
    process: { phase: "idle", generation: null, lastStartResult: null, lastStopResult: null, ready: false },
    turn: { state: "idle" },
    backgroundTasks: { availability: "unknown", activeCount: null },
    reap: { eligible: false, idleElapsedMs: null, idleRemainingMs: null, idleMs },
    recovery: UNKNOWN_RECOVERY,
    statusVersion: 0,
    serverTimeMs: Date.now(),
  });

  /** GateState→TurnState（穷尽映射）。 */
  const turnOf = (g: unknown): SessionStatus["turn"] => {
    const gs = g as { kind: string; intentId?: string; reason?: string };
    switch (gs.kind) {
      case "idle": return { state: "idle" };
      case "dispatching": return { state: "dispatching", intentId: gs.intentId ?? "" };
      case "in-flight": return { state: "in-flight", intentId: gs.intentId ?? "" };
      case "settling": return { state: "settling", intentId: gs.intentId ?? "" };
      case "closed": {
        const r = gs.reason;
        const ok = r === "durability-failure" || r === "turn-timeout" || r === "buffer-overflow" || r === "manual" || r === "generation-retired";
        return ok ? { state: "closed", reason: r } : { state: "idle" };
      }
      default: return { state: "idle" };
    }
  };

  return {
    sessionFor(file: string): RpcSession {
      if (disposed) throw new Error("session-registry: 已销毁，拒绝构造会话");
      const cached = sessions.get(file);
      if (cached !== undefined) return cached;
      const sessionFile = mapped(file);
      const s = new RpcSession({
        journalPath: file,
        sessionFile,
        sessionId: sessionIdOf(file),
        host: opts.host,
        durability: opts.durabilityFor?.(file) ?? new FileDurability(file),
        ...(opts.responseTimeoutMs !== undefined ? { responseTimeoutMs: opts.responseTimeoutMs } : {}),
        ...(opts.turnTimeoutMs !== undefined ? { turnTimeoutMs: opts.turnTimeoutMs } : {}),
        ...(opts.readinessTimeoutMs !== undefined ? { readinessTimeoutMs: opts.readinessTimeoutMs } : {}),
        ...(opts.timeoutPollMs !== undefined ? { timeoutPollMs: opts.timeoutPollMs } : {}),
        ...(opts.idleMs !== undefined ? { idleMs: opts.idleMs } : {}),
        ...(opts.eofGraceMs !== undefined ? { eofGraceMs: opts.eofGraceMs } : {}),
        ...(opts.extraPiArgs !== undefined ? { extraPiArgs: opts.extraPiArgs } : {}),
        ...(opts.onSpawned !== undefined ? { onSpawned: (handle: ProcessHandle, generation: number) => opts.onSpawned!(file, handle, generation) } : {}),
        ...(opts.onUiRequest !== undefined ? { onUiRequest: (ask: UiAsk) => opts.onUiRequest!(file, ask) } : {}),
        ...(opts.onUiNote !== undefined ? { onUiNote: (note: UiNoteEvent) => opts.onUiNote!(file, note) } : {}),
        ...(opts.onUiClosed !== undefined ? { onUiClosed: (requestId: string, reason: UiClosedReason) => opts.onUiClosed!(file, requestId, reason) } : {}),
        ...(opts.onPiEvent !== undefined ? { onPiEvent: (ev: unknown, generation: number, disposition: string) => opts.onPiEvent!(file, ev, generation, disposition) } : {}),
        ...(opts.now !== undefined ? { now: opts.now } : {}),
        audit: (l: string) => safeAudit(`rpc-session ${sessionIdOf(file)} ${l}`),
      });
      sessions.set(file, s);
      safeAudit(`session-registry created file=${file} session=${sessionFile}`);
      return s;
    },
    files(): readonly string[] {
      return [...sessions.keys()].sort();
    },
    statusFor(file: string): SessionStatus {
      const s = sessions.get(file);
      if (s === undefined) return baseStatus(file);
      const st = s.getState();
      const sup = st.supervisor as { phase: "idle" | "running" | "stopping"; generation: number | null };
      const reap = st.reap;
      return {
        session: { sessionId: sessionIdOf(file), file, adapterSessionId: null },
        process: {
          phase: sup.phase,
          generation: sup.generation,
          lastStartResult: null,
          lastStopResult: null,
          ready: st.readyGeneration !== null && st.readyGeneration === sup.generation,
        },
        turn: turnOf(st.gate),
        backgroundTasks: { availability: "known", activeCount: s.idleRegistry.activeCount() },
        reap: reap ?? { eligible: false, idleElapsedMs: null, idleRemainingMs: null, idleMs },
        recovery: UNKNOWN_RECOVERY,
        statusVersion: 0,
        serverTimeMs: Date.now(),
      };
    },
    dispose(): Promise<void> {
      if (disposeP !== null) return disposeP; // 20轮F3：共享收尾 Promise——并发第二等待者不得提前完成
      disposed = true; // 同步置位：销毁后拒建立即生效（发布 Promise 先于可能重入的外部回调）
      const all = [...sessions.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      sessions.clear();
      // 20b B1：先发布后执行——收尾体压入微任务，保证 host.stop/audit 等外部回调里的同步重入
      // 看到的 disposeP 已非 null（直接共享，不走空表捷径）；rpc-session.ts dispose 同款先发布模式。
      disposeP = Promise.resolve().then(async () => {
        for (const [file, s] of all) {
          try {
            await s.stop();
          } catch (e: unknown) {
            safeAudit(`session-registry stop-error file=${file} ${e instanceof Error ? e.message : String(e)}`);
          }
          try {
            await s.dispose();
          } catch (e: unknown) {
            safeAudit(`session-registry dispose-error ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        safeAudit("session-registry disposed");
      });
      return disposeP;
    },
  };
}
