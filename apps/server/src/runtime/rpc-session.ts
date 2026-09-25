// RpcSession：组装面（切片4）。把纯逻辑层（TurnGate+DispatchCoordinator+ProcessSupervisor）
// 接到真进程宿主（PiProcessHost）与真耐久（FileDurability）上，并承担 RPC 协议面三件事：
//  ① demux：stdout 行分派——type:"response"（含 readiness 探针回执）→协调器 onRpcResponse；
//     agent_settled→onSettledEvent（无 id 事件=单在途归因，协调器自校验）；其余→onPiEvent。
//  ② readiness：spawn 成功即写 get_state 探针（TECH §40：pi RPC 无 banner，readiness=ping 往返）；
//     超时=自动 retire+返回失败（不留活进程）。
//  ③ 发送帧渲染：commandId↔RPC id（c<commandId>）对账；stdinText 由本层生成（监管器只管首字节身份）。
// 三写硬序（§5.5）由纯逻辑层保证：意图 fsync→sending fsync→stdin 首字节（gate.submit 内完成）。
import {
  DispatchCoordinator,
  ProcessSupervisor,
  TurnGate,
  matchKeyOf,
  type DurabilityPort,
  type EnqueuePayload,
  type LaunchOutcome,
  type ProcessHandle,
  type ProcessHostPort,
  type RetireOutcome,
} from "@pi-agent-ui/protocol";

export interface RpcSessionOpts {
  /** pi 参数（默认 ["--mode","rpc","--no-session"]）。 */
  readonly piArgs?: readonly string[];
  /** journal 路径（意图/sending/超时记录行；append-only+逐行 fdatasync）。 */
  readonly journalPath: string;
  readonly sessionId: string;
  /** 进程宿主（生产=PiProcessHost；测试=受控替身）。 */
  readonly host: ProcessHostPort;
  /** 耐久端口（生产=FileDurability）。 */
  readonly durability: DurabilityPort;
  readonly responseTimeoutMs?: number;
  readonly turnTimeoutMs?: number;
  readonly readinessTimeoutMs?: number;
  /** 超时巡检周期（默认 250ms；驱动协调器 response/turn 双超时检查）。 */
  readonly timeoutPollMs?: number;
  readonly audit?: (line: string) => void;
  readonly now?: () => string;
  /** 交付面：run-open 期事件直交（含 buffered/dropped 处置，供 UI）。 */
  readonly onPiEvent?: (ev: unknown, generation: number, disposition: string) => void;
  /** 缓冲排空面（settled 后补交付）。 */
  readonly onBufferDrain?: (events: readonly unknown[]) => void;
  readonly onStderr?: (text: string, generation: number) => void;
  /** 轮次完全收口（settled 结算后）。 */
  readonly onSettled?: (generation: number) => void;
}

export type SessionStartResult =
  | { readonly kind: "ready"; readonly generation: number }
  | ({ readonly kind: "readiness-timeout"; readonly generation: number; readonly retire: RetireOutcome }
    | { readonly kind: "spawn-failed"; readonly error: unknown }
    | { readonly kind: "rejected"; readonly reason: "not-idle" }
    | { readonly kind: "spawn-exited"; readonly generation: number; readonly exit: Readonly<{ code: number | null; signal: string | null }> });

export type SessionSendResult = LaunchOutcome | { readonly kind: "no-process" } | { readonly kind: "invalidated"; readonly stage: "first-byte" } | { readonly kind: "not-ready" };

interface ReadinessWaiter {
  resolve(ok: boolean): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

export class RpcSession {
  private readonly gate: TurnGate;
  private readonly coordinator: DispatchCoordinator;
  private readonly supervisor: ProcessSupervisor;
  private readonly readiness = new Map<string, ReadinessWaiter>();
  private readyGeneration: number | null = null;
  private readonly ordinals = new Map<string, number>();
  private readonly readyPromise = new Map<number, Promise<void>>();
  private cmdSeq = 0;
  private intentSeq = 0;
  private readonly pollTimer: NodeJS.Timeout | null;

  constructor(private readonly opts: RpcSessionOpts) {
    const now = opts.now ?? (() => new Date().toISOString());
    const audit = (line: string): void => opts.audit?.(line);
    this.gate = new TurnGate({
      durability: opts.durability,
      now,
      ...(opts.turnTimeoutMs !== undefined ? { turnTimeoutMs: opts.turnTimeoutMs } : {}),
    });
    this.coordinator = new DispatchCoordinator({
      gate: this.gate,
      durability: opts.durability,
      now,
      ...(opts.responseTimeoutMs !== undefined ? { responseTimeoutMs: opts.responseTimeoutMs } : {}),
      audit: (l: string) => audit(`coordinator ${l}`),
      onBufferDrain: (events) => opts.onBufferDrain?.(events),
    });
    this.supervisor = new ProcessSupervisor({
      host: opts.host,
      coordinator: this.coordinator,
      gate: this.gate,
      onProcessEvent: (ev, generation) => this.demux(ev, generation),
      onStderr: (t, generation) => opts.onStderr?.(t, generation),
      onSpawned: (handle, generation) => {
        // spawn 成功即发探针；失败/超时也留在 promise 链上（start 汇合后退役收口）
        const p = this.probeReadiness(handle, generation).catch((e: unknown) => {
          this.opts.audit?.(`rpc-session readiness-failed generation=${generation} ${String(e instanceof Error ? e.message : e)}`);
        });
        this.readyPromise.set(generation, p);
      },
      now,
      nowMs: () => performance.now(),
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      audit: (l: string) => audit(`supervisor ${l}`),
    });
    const pollMs = opts.timeoutPollMs ?? 250;
    this.pollTimer = setInterval(() => {
      void this.coordinator.checkResponseTimeout().catch((e: unknown) => {
        audit(`rpc-session response-timeout-check-error ${String(e instanceof Error ? e.message : e)}`);
      });
      try {
        this.coordinator.checkTurnTimeout();
      } catch (e: unknown) {
        audit(`rpc-session turn-timeout-check-error ${String(e instanceof Error ? e.message : e)}`);
      }
    }, pollMs);
    this.pollTimer.unref?.();
  }

  /** 释放本地资源（巡检定时器）；进程退役另走 stop()。 */
  dispose(): void {
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
  }

  /** demux：supervisor 已按代次过滤的 stdout 事件行 → 协调器三入口。 */
  private demux(ev: unknown, generation: number): void {
    const o = ev as { type?: unknown; id?: unknown; success?: unknown };
    if (o !== null && typeof o === "object" && o.type === "response" && typeof o.id === "string") {
      const waiter = this.readiness.get(o.id);
      if (waiter !== undefined) {
        this.readiness.delete(o.id);
        clearTimeout(waiter.timer);
        waiter.resolve(o.success === true);
        return;
      }
      if (o.id.startsWith("c")) {
        const cmd = Number(o.id.slice(1));
        if (Number.isInteger(cmd)) {
          void this.coordinator.onRpcResponse(cmd, generation, o.success === true).catch((e) => {
            this.opts.audit?.(`rpc-session rpc-response-error commandId=${cmd} ${String(e instanceof Error ? e.message : e)}`);
          });
        }
        return;
      }
      return; // 未知 id 的 response：丢弃（不进事件流）
    }
    if (o !== null && typeof o === "object" && o.type === "agent_settled") {
      void this.coordinator.onSettledEvent({ generation }).catch((e) => {
        this.opts.audit?.(`rpc-session settled-error generation=${generation} ${String(e instanceof Error ? e.message : e)}`);
      });
      this.opts.onSettled?.(generation);
      return;
    }
    const r = this.coordinator.onPiEvent(ev, generation);
    this.opts.onPiEvent?.(ev, generation, r.kind);
  }

  private probeReadiness(handle: ProcessHandle, generation: number): Promise<void> {
    const id = `ready-${generation}`;
    const timeoutMs = this.opts.readinessTimeoutMs ?? 15_000;
    const gate = new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readiness.delete(id);
        reject(new Error(`readiness 探针超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.readiness.set(id, { resolve, reject, timer });
    });
    return this.opts.host
      .writeStdin(handle, `${JSON.stringify({ id, type: "get_state" })}\n`)
      .then(() => gate)
      .then((ok) => {
        if (!ok) throw new Error("readiness 探针被拒（get_state success=false）");
        this.readyGeneration = generation;
        this.opts.audit?.(`rpc-session ready generation=${generation}`);
      });
  }

  /** 启动（或意外退出后重启）：gate 若因上代关闭先 reopen→spawn→readiness 往返。 */
  async start(): Promise<SessionStartResult> {
    if (this.gate.getState().kind === "closed") {
      const ok = this.gate.reopen();
      if (!ok) return { kind: "rejected", reason: "not-idle" }; // reopen 仅 closed→idle（B1-01）
    }
    const r = this.supervisor.spawnNext(this.opts.piArgs ?? ["--mode", "rpc", "--no-session"]);
    if (r.kind !== "spawned") {
      if (r.kind === "rejected") return { kind: "rejected", reason: r.reason };
      if (r.kind === "spawn-failed") return { kind: "spawn-failed", error: r.error };
      return { kind: "spawn-exited", generation: r.generation, exit: r.exit };
    }
    // onSpawned 在 spawnNext 内同步启动探针并登记 promise（spawned 分支必已存在）
    await this.readyPromise.get(r.generation);
    if (this.readyGeneration !== r.generation) {
      // 探针失败（超时/被拒/写失败）：不留活进程，退役后返回
      const retire = await this.supervisor.retireCurrent();
      return { kind: "readiness-timeout", generation: r.generation, retire };
    }
    return { kind: "ready", generation: r.generation };
  }

  /** 发一轮用户消息（三写硬序在纯逻辑层；本层只渲染帧+对账 id）。 */
  async send(message: string): Promise<SessionSendResult> {
    const gen = this.supervisor.getState().generation;
    if (gen === null || this.readyGeneration !== gen) return { kind: "not-ready" };
    const commandId = (this.cmdSeq += 1);
    const intentId = `i-${(this.intentSeq += 1)}`;
    const mk = matchKeyOf(message, [], this.takeOrdinal(message));
    const payload: EnqueuePayload = { kind: "prompt", rawText: message, attachments: [], sentAt: new Date().toISOString() };
    const stdinText = `${JSON.stringify({ id: `c${commandId}`, type: "prompt", message })}\n`;
    return this.supervisor.submitTurn(
      { intentId, sessionId: this.opts.sessionId, leafId: `leaf-${commandId}`, matchKey: mk, payload },
      commandId,
      stdinText,
    );
  }

  private takeOrdinal(message: string): number {
    const key = matchKeyOf(message, [], 0); // 序号按（hash+附件）组：先算 0 号键取组身份
    const groupKey = `${key.textHash}|${key.attachmentIdentity}`;
    const n = this.ordinals.get(groupKey) ?? 0;
    this.ordinals.set(groupKey, n + 1);
    return n;
  }

  /** 退役（SIGTERM→宽限→SIGKILL→退出确认；v1 无 stdin EOF 优雅路径，pi 对 SIGTERM 即退）。 */
  stop(): Promise<RetireOutcome> {
    return this.supervisor.retireCurrent();
  }

  /** 观测面：gate/协调器/监管器状态（UI/诊断用）。 */
  getState(): { gate: unknown; command: unknown; supervisor: unknown } {
    return {
      gate: this.gate.getState(),
      command: this.coordinator.getState().command,
      supervisor: this.supervisor.getState(),
    };
  }
}
