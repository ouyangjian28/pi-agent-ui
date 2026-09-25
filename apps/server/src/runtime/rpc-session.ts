// RpcSession：组装面（切片4）。把纯逻辑层（TurnGate+DispatchCoordinator+ProcessSupervisor）
// 接到真进程宿主（PiProcessHost）与真耐久（FileDurability）上，并承担 RPC 协议面四件事：
//  ① demux：stdout 行分派——type:"response"（含 readiness 探针回执）→协调器 onRpcResponse；
//     agent_settled→onSettledEvent（无 id 事件=单在途归因，协调器自校验）；其余→onPiEvent。
//  ② readiness：spawn 成功即写 get_state 探针（TECH §40：pi RPC 无 banner，readiness=ping 往返）。
//     写入/响应/超时纳入同一有界启动操作（S4-03）：writeP 与 gateP 经 Promise.all 聚合，超时能结束
//     挂起 write 所在的启动等待；所有 Promise 创建即有消费者（无孤立 reject）。
//     成败续体均复核代次所有权（S4-04）：旧代失败不得退役新代；返回 ready 前确认仍是当前运行代。
//  ③ 发送帧渲染：commandId↔RPC id（c<commandId>）对账；stdinText 由本层生成（监管器只管首字节身份）。
//  ④ 完成通知（S4-05）：onSettled 只从协调器确认释放该轮的三条路径发出（settled/accepted-and-settled/
//     recorded-and-settled），绑定轮身份+按 intentId 恰好一次；耐久挂起/discard 不提前、不重复通知。
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
  type TurnKey,
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
  /** 交付面：run-open 期事件直交（含 buffered/dropped 处置，供 UI）。异常被隔离。 */
  readonly onPiEvent?: (ev: unknown, generation: number, disposition: string) => void;
  /** 缓冲排空面（settled 后补交付）。 */
  readonly onBufferDrain?: (events: readonly unknown[]) => void;
  readonly onStderr?: (text: string, generation: number) => void;
  /** 轮次完全收口（settled 结算耐久确认后；恰好一次/轮）。 */
  readonly onSettled?: (generation: number) => void;
}

export type SessionStartResult =
  | { readonly kind: "ready"; readonly generation: number }
  | { readonly kind: "superseded"; readonly generation: number } // 启动等待期内该代已被退出/退役取代：本结果不附带任何动作
  | ({ readonly kind: "readiness-timeout"; readonly generation: number; readonly retire: RetireOutcome }
    | { readonly kind: "spawn-failed"; readonly error: unknown }
    | { readonly kind: "rejected"; readonly reason: "not-idle" }
    | { readonly kind: "spawn-exited"; readonly generation: number; exit: Readonly<{ code: number | null; signal: string | null }> });

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
  private readonly settledNotified = new Set<string>(); // intentId → 已发完成通知（恰好一次/轮）
  private cmdSeq = 0;
  private intentSeq = 0;
  private readonly pollTimer: NodeJS.Timeout | null;

  constructor(private readonly opts: RpcSessionOpts) {
    const now = opts.now ?? (() => new Date().toISOString());
    // 审计隔离（S4-07）：诊断通道异常不得阻断组装面关键路径（含 fire-and-forget catch 内的审计）
    const safeAudit = (line: string): void => {
      try {
        opts.audit?.(line);
      } catch {
        // 静默：无更底层通道
      }
    };
    this.safeAudit = safeAudit;
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
      audit: (l: string) => safeAudit(`coordinator ${l}`),
      onBufferDrain: (events) => {
        try {
          opts.onBufferDrain?.(events);
        } catch (e: unknown) {
          safeAudit(`rpc-session buffer-drain-error ${String(e instanceof Error ? e.message : e)}`);
        }
      },
    });
    this.supervisor = new ProcessSupervisor({
      host: opts.host,
      coordinator: this.coordinator,
      gate: this.gate,
      onProcessEvent: (ev, generation) => this.demux(ev, generation),
      onStderr: (t, generation) => {
        try {
          opts.onStderr?.(t, generation);
        } catch (e: unknown) {
          safeAudit(`rpc-session stderr-error ${String(e instanceof Error ? e.message : e)}`);
        }
      },
      onSpawned: (handle, generation) => {
        // spawn 成功即发探针；成败都汇入 readyPromise（start 汇合后按所有权处置）
        const p = this.probeReadiness(handle, generation)
          .catch((e: unknown) => {
            safeAudit(`rpc-session readiness-failed generation=${generation} ${String(e instanceof Error ? e.message : e)}`);
          })
          .finally(() => {
            this.readyPromise.delete(generation); // Y5：完成的启动操作不留 Map（防随重启次数增长）
          });
        this.readyPromise.set(generation, p);
      },
      now,
      nowMs: () => performance.now(),
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      audit: (l: string) => safeAudit(`supervisor ${l}`),
    });
    const pollMs = opts.timeoutPollMs ?? 250;
    this.pollTimer = setInterval(() => {
      void this.coordinator
        .checkResponseTimeout()
        .then((r) => {
          if (r.kind === "recorded-and-settled") this.notifySettled(r.key); // S4-05：超时记录收口路径
        })
        .catch((e: unknown) => {
          safeAudit(`rpc-session response-timeout-check-error ${String(e instanceof Error ? e.message : e)}`);
        });
      try {
        this.coordinator.checkTurnTimeout();
      } catch (e: unknown) {
        safeAudit(`rpc-session turn-timeout-check-error ${String(e instanceof Error ? e.message : e)}`);
      }
    }, pollMs);
    this.pollTimer.unref?.();
  }

  private readonly safeAudit: (line: string) => void;

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
          void this.coordinator
            .onRpcResponse(cmd, generation, o.success === true)
            .then((r) => {
              if (r.kind === "accepted-and-settled") this.notifySettled(r.key); // S4-05：回绑即结算路径
            })
            .catch((e) => {
              this.safeAudit(`rpc-session rpc-response-error commandId=${cmd} ${String(e instanceof Error ? e.message : e)}`);
            });
        }
        return;
      }
      return; // 未知 id 的 response：丢弃（不进事件流）
    }
    if (o !== null && typeof o === "object" && o.type === "agent_settled") {
      void this.coordinator
        .onSettledEvent({ generation })
        .then((r) => {
          if (r.kind === "settled") this.notifySettled(r.key); // S4-05：直接结算路径（buffered/discard/耐久失败不通知）
          else if (r.kind === "settle-durability-failed") this.safeAudit(`rpc-session settle-held generation=${generation}（完成通知延后）`);
          else if (r.kind === "buffered") this.safeAudit(`rpc-session settle-buffered generation=${generation}（等待 response 回绑）`);
        })
        .catch((e) => {
          this.safeAudit(`rpc-session settled-error generation=${generation} ${String(e instanceof Error ? e.message : e)}`);
        });
      return;
    }
    const r = this.coordinator.onPiEvent(ev, generation);
    try {
      this.opts.onPiEvent?.(ev, generation, r.kind);
    } catch (e: unknown) {
      this.safeAudit(`rpc-session pi-event-error ${String(e instanceof Error ? e.message : e)}`);
    }
  }

  /** 完成通知（S4-05）：绑定轮身份（TurnKey），按 intentId 恰好一次。 */
  private notifySettled(key: TurnKey): void {
    if (this.settledNotified.has(key.intentId)) {
      this.safeAudit(`rpc-session settled-notify-duplicate intentId=${key.intentId}（已通知，丢弃）`);
      return;
    }
    this.settledNotified.add(key.intentId);
    try {
      this.opts.onSettled?.(key.generation);
    } catch (e: unknown) {
      this.safeAudit(`rpc-session settled-callback-error ${String(e instanceof Error ? e.message : e)}`);
    }
  }

  /** readiness 探针（S4-03/S4-04）：写入+响应+超时=同一有界启动操作。
   *  - writeP 与 gateP 从创建起都有消费者（Promise.all），无孤立 rejection；
   *  - 超时/写失败/被拒都能让 start 的等待结束并进入所有权复核；
   *  - 成功侧复核当前运行代（superseded→抛错，不置 readyGeneration）；
   *  - finally 清 waiter 与 timer（write 失败路径也要收 timer）。 */
  private probeReadiness(handle: ProcessHandle, generation: number): Promise<void> {
    const id = `ready-${generation}`;
    const timeoutMs = this.opts.readinessTimeoutMs ?? 15_000;
    let waiter!: ReadinessWaiter;
    const gateP = new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readiness.delete(id);
        reject(new Error(`readiness 探针超时（${timeoutMs}ms）`));
      }, timeoutMs);
      waiter = { resolve, reject, timer };
      this.readiness.set(id, waiter);
    });
    void gateP.catch(() => undefined); // 双保险：all 已消费 gateP，此行防御性标注（无操作成本）
    const writeP = this.opts.host.writeStdin(handle, `${JSON.stringify({ id, type: "get_state" })}\n`);
    return Promise.all([writeP, gateP])
      .then(([, ok]) => {
        if (!ok) throw new Error("readiness 探针被拒（get_state success=false）");
        // S4-04：返回 ready 前确认仍是当前运行代（探针等待期内换代/退出→superseded，不得报 ready）
        const cur = this.supervisor.getState().generation;
        if (cur !== generation) throw new Error(`readiness-superseded（探针完成时当前代=${cur}）`);
        this.readyGeneration = generation;
        this.safeAudit(`rpc-session ready generation=${generation}`);
      })
      .finally(() => {
        // 收尾：清 waiter 槽位与 timer（write 失败/超时/被拒路径同样执行）
        if (this.readiness.get(id) === waiter) {
          this.readiness.delete(id);
          clearTimeout(waiter.timer);
        }
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
      // 探针失败（超时/被拒/写失败/superseded）：先复核所有权，只退役自己这一代（S4-04）
      const cur = this.supervisor.getState().generation;
      if (cur !== r.generation) {
        this.safeAudit(`rpc-session readiness-failed-superseded generation=${r.generation} current=${cur}（不动当前代）`);
        return { kind: "superseded", generation: r.generation };
      }
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

  /** 退役（SIGTERM→宽限→SIGKILL→退出确认）。取消未决 readiness（S4-04：停止时清 waiter，
   *  挂起的启动等待立即结束而非等超时）；退役确认后清 readyGeneration。 */
  async stop(): Promise<RetireOutcome> {
    const gen = this.supervisor.getState().generation;
    if (gen !== null) this.cancelReadiness(gen);
    const r = await this.supervisor.retireCurrent();
    if (r.kind === "confirmed" && this.readyGeneration === gen) this.readyGeneration = null;
    return r;
  }

  private cancelReadiness(generation: number): void {
    const id = `ready-${generation}`;
    const waiter = this.readiness.get(id);
    if (waiter === undefined) return;
    this.readiness.delete(id);
    clearTimeout(waiter.timer);
    waiter.reject(new Error("readiness-canceled（退役/停止）"));
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
