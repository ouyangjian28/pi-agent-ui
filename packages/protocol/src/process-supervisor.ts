// 进程代次监管器（adapter 切片 3：进程代次与交接隔离，TECH §136/§169④/§4）
// 纯逻辑层：进程/IO 全部走注入端口（ProcessHostPort），时钟/睡眠可注入（测试受控）。
//
// 职责与不变量：
// 1) 代次路由：每个进程句柄的事件回调绑定其 spawn 时的代次登记项（GenEntry）。
//    退役代次（retired）或非当前登记项的事件一律丢弃+审计；stopping 期仍路由——
//    SIGTERM 宽限内晚到的 settled 是旧轮最后事实，归协调器结算，不得静默丢。
// 2) 首字节身份复核（s2d 风险序3①）：协调器返回 launched 后、写 stdin 前，复核
//    当前代次仍拥有该轮：登记项仍是 current 且未退役、协调器登记仍在同一 key、
//    Gate 许可仍是本轮 in-flight。失效不写并返回 {kind:"invalidated", stage:"first-byte"}。
//    Gate 许可项可经排队微任务到达（协调器登记后、本复核前的窗口；s3 审读探针复现）。
// 3) 串行化交接（TECH §136）：retireCurrent = SIGTERM → 宽限 sleep →
//    SIGKILL → 退出确认截止（exitDeadlineMs 自 retire 起算的绝对截止，F1 预算口径：
//    宽限被钳到预算内；每段等待只睡剩余量，先醒/晚醒不重置预算）。
//    退出确认 → 退役（协调器清登记 + gate 三活相态 dispatching/in-flight/settling 之一则
//    close("generation-retired")，旧 submit/settled 续体经 epoch 失效：不 send 不登记/held 保留（DC 登记面已由 onGenerationRetired 清，held 仅指 gate 内旧轮呈现）→
//    idle → spawnNext 才可用；stopping 期 spawnNext 拒绝。
//    截止到期 = 本次接管失败：保持 stopping（不裁决进程死活），晚到 exit 自动
//    收口（同条退役手续）后回 idle，宿主可重试 spawn。
//    退役幂等：onExit 与 retireCurrent 续体双路径只生效一次，旧续体不得清掉新代次登记。
// 4) 意外退出：running 中 exit → 代次退役 + gate 关闭 + 回 idle；
//    屏障解除归宿主（reopen 后新轮可跑），监管器不自动 reopen。
// 5) 背压窗口：writeStdin 的 await 期间发生换代/退出 → 续体只及旧 handle。
//    写旧进程安全依据=handle 不重定向+退出确认前不开新写者（stopping 期旧进程可真实执行副作用，其事件仍按代次路由）；新轮写新 handle。写完成仅审计不动作。
//
// 失败语义：所有失败保守呈现（no-process / deadline-exceeded / spawn-failed），
// 不猜进程状态；退出确认是唯一「进程已死」证据（waitpid 口径，宿主实现保证）。

import type { LaunchOutcome, TrackedCommand, TurnKey } from "./dispatch-coordinator.ts";
import type { GateState, TurnIntentInput } from "./turn-gate.ts";

/** 进程句柄：宿主返回的不透明标识（监管器不解释，仅按绑定关系使用）。 */
export interface ProcessHandle {
  readonly id: string;
}

/** spawn 时挂到宿主上的回调（监管器闭包捕获对应代次登记项）。 */
export interface ProcessSpawnHandlers {
  onEvent(ev: unknown): void;
  onStderr(text: string): void;
  onExit(code: number | null, signal: string | null): void;
}

/** 进程宿主端口：spawn/writeStdin/stop。退出确认=宿主只在 waitpid/proc 消失口径下回调 onExit。 */
export interface ProcessHostPort {
  spawn(args: readonly string[], h: ProcessSpawnHandlers): ProcessHandle;
  /** 返回的 Promise resolve=字节已交给宿主（背压含）；reject 呈现给 submitTurn 调用方。 */
  writeStdin(h: ProcessHandle, text: string): Promise<void>;
  stop(h: ProcessHandle, signal: "SIGTERM" | "SIGKILL"): void;
}

/** 协调器端口（结构化：监管器用到面）。 */
export interface SupervisorCoordinatorPort {
  submitTurn(intent: TurnIntentInput, commandId: number): Promise<LaunchOutcome>;
  onGenerationRetired(generation: number): { clearedCommands: number; clearedEvents: number };
  getState(): { command: TrackedCommand | null };
  abandonHeld?(reason: string): unknown;
}

/** 网关端口（结构化：监管器用到面）。 */
export interface SupervisorGatePort {
  getState(): GateState;
  close(reason: "generation-retired"): void;
}

export interface SupervisorDeps {
  readonly host: ProcessHostPort;
  readonly coordinator: SupervisorCoordinatorPort;
  readonly gate: SupervisorGatePort;
  /** 进程事件路由（已按代次过滤）：接线层在此映射 RPC 回执/settled/pi 事件到协调器入口。 */
  onProcessEvent?(ev: unknown, generation: number): void;
  /** stderr 诊断（已按代次过滤，非当前/退役代次不转发）。 */
  onStderr?(text: string, generation: number): void;
  now(): string;
  sleep(ms: number): Promise<void>;
  /** 单调毫秒时钟（预算口径；缺省 performance.now()——非单调注入时 remainMs 钳位不放大但前跳仍过早耗尽，宿主应注入单调源）。 */
  nowMs?(): number;
  /** SIGTERM 宽限（默认 2s，被总预算钳位）。 */
  readonly graceMs?: number;
  /** 退出确认总预算（默认 10s，F1 口径，自 retire 起算的绝对截止）。 */
  readonly exitDeadlineMs?: number;
  audit?(line: string): void;
}

export type SupervisorPhase = "idle" | "running" | "stopping";

export type SpawnOutcome =
  | { readonly kind: "spawned"; readonly generation: number }
  | { readonly kind: "spawn-exited"; readonly generation: number; readonly exit: Readonly<{ code: number | null; signal: string | null }> }
  | { readonly kind: "rejected"; readonly reason: "not-idle" }
  | { readonly kind: "spawn-failed"; readonly error: unknown };

export type RetireOutcome =
  | { readonly kind: "confirmed"; readonly exit: Readonly<{ code: number | null; signal: string | null }> }
  | { readonly kind: "deadline-exceeded" }
  | { readonly kind: "no-process" }
  | { readonly kind: "stopping" };

export type SupervisorSubmitOutcome =
  | LaunchOutcome
  | { readonly kind: "no-process" }
  | { readonly kind: "invalidated"; readonly stage: "first-byte" };

interface GenEntry {
  readonly generation: number;
  handle: ProcessHandle | null; // spawn 返回前为 null（此窗口内不会写 stdin）
  retired: boolean;
  retireInFlight: boolean; // 本代次 retire 续体在飞（S3B-02：槽位所属代次，旧续体 finally 不清新代次的槽）
  exit: Readonly<{ code: number | null; signal: string | null }> | null;
  exitWaiters: Array<() => void>;
}

function keyEqual(a: TurnKey, b: TurnKey): boolean {
  return a.intentId === b.intentId && a.commandId === b.commandId && a.generation === b.generation;
}

export class ProcessSupervisor {
  private phase: SupervisorPhase = "idle";
  private current: GenEntry | null = null;
  private nextGeneration = 0;

  constructor(private readonly opts: SupervisorDeps) {}

  getState(): { phase: SupervisorPhase; generation: number | null; retired: boolean } {
    return {
      phase: this.phase,
      generation: this.current?.generation ?? null,
      retired: this.current?.retired ?? false,
    };
  }

  /**
   * 拉起下一进程代次。仅 idle 可用（串行化交接：旧写者退出确认前不 spawn 新写者）。
   * spawn 抛错=无进程产生，回滚到 idle 可重试。
   */
  spawnNext(args: readonly string[]): SpawnOutcome {
    if (this.phase !== "idle") {
      this.audit(`process-spawn-rejected phase=${this.phase}`);
      return { kind: "rejected", reason: "not-idle" };
    }
    this.nextGeneration += 1;
    const entry: GenEntry = {
      generation: this.nextGeneration,
      handle: null,
      retired: false,
      retireInFlight: false,
      exit: null,
      exitWaiters: [],
    };
    // 先挂 current 再 spawn：spawn 期内同步冒出的 exit/事件也能按本代次路由。
    this.current = entry;
    this.phase = "running";
    let handle: ProcessHandle;
    try {
      handle = this.opts.host.spawn(args, {
        onEvent: (ev) => this.routeEvent(entry, ev),
        onStderr: (t) => {
          if (entry.retired || entry !== this.current) {
            this.audit(`process-stderr-dropped generation=${entry.generation}`);
            return;
          }
          this.opts.onStderr?.(t, entry.generation);
        },
        onExit: (code, signal) => this.onExit(entry, code, signal),
      });
    } catch (error) {
      entry.retired = true; // 该代次无进程产生，直接视为已退役
      this.current = null;
      this.phase = "idle";
      this.audit(`process-spawn-failed generation=${entry.generation}`);
      return { kind: "spawn-failed", error };
    }
    entry.handle = handle;
    if (entry.exit !== null) {
      // spawn 内同步退出：onExit 已按意外退出收口（退役+回 idle）；创建事实成立但当前不可用，宿主可重试
      this.audit(`process-spawn-exited-sync generation=${entry.generation}`);
      return { kind: "spawn-exited", generation: entry.generation, exit: entry.exit };
    }
    this.audit(`process-spawned generation=${entry.generation}`);
    return { kind: "spawned", generation: entry.generation };
  }

  /**
   * 串行化交接（TECH §136）：SIGTERM→宽限→SIGKILL→退出确认截止。
   * 退出确认=协调器清登记+gate 关（若在飞）→idle。截止到期保持 stopping，
   * 晚到 exit 自动收口。宽限内晚到事件仍按旧代次路由（最后事实）。
   */
  async retireCurrent(): Promise<RetireOutcome> {
    if (this.phase === "idle" || this.current === null) return { kind: "no-process" };
    const entry = this.current;
    if (this.phase === "stopping" || entry.retireInFlight) return { kind: "stopping" };
    this.phase = "stopping";
    entry.retireInFlight = true;
    const graceMs = this.opts.graceMs ?? 2_000;
    // 总预算=自 retire 起算的绝对截止：宽限被钳到预算内；每段等待只睡剩余量，
    // 先醒/晚醒不重置预算（remainMs 已过期只探查 1ms）
    const deadlineMs = Math.max(this.opts.exitDeadlineMs ?? 10_000, 1);
    const rawStart = this.nowMs();
    const startMs = Number.isFinite(rawStart) ? rawStart : 0; // S3B-01：非有限时钟按 0 对待（预算不产生 NaN/Infinity）
    const graceEnd = startMs + Math.min(graceMs, deadlineMs); // 宽限被总预算钳位
    const deadlineEnd = startMs + deadlineMs;
    try {
      this.stopSignal(entry, "SIGTERM");
      let exit = await this.raceExit(entry, this.remainMs(graceEnd, startMs));
      if (exit === null) {
        this.stopSignal(entry, "SIGKILL");
        exit = await this.raceExit(entry, this.remainMs(deadlineEnd, startMs));
        // sleep 先醒不等于进程未死：最后一刻的 exit 仍算确认
        if (exit === null && entry.exit !== null) exit = entry.exit;
      }
      if (exit === null) {
        this.audit(`process-retire-deadline-exceeded generation=${entry.generation}`);
        return { kind: "deadline-exceeded" };
      }
      // 退役幂等：onExit 可能已先收口（含已允许新 spawn）——旧续体不覆盖新代次
      this.finalizeRetire(entry, "handover");
      this.toIdle(entry);
      return { kind: "confirmed", exit };
    } finally {
      entry.retireInFlight = false;
    }
  }

  /**
   * 发起一轮用户消息：协调器受理（含耐久化）→ launched 后首字节身份复核 → 写 stdin。
   * 任一环失效不写：no-process（无进程）/协调器结果原样透传/first-byte invalidated。
   * 写完成后的复核只审计不动作（安全依据=handle 不重定向+退出确认前不开新写者；旧进程 stopping 期仍可执行副作用）。
   */
  async submitTurn(
    intent: Omit<TurnIntentInput, "generation">,
    commandId: number,
    stdinText: string,
  ): Promise<SupervisorSubmitOutcome> {
    if (this.phase !== "running" || this.current === null) return { kind: "no-process" };
    const entry = this.current;
    const launched = await this.opts.coordinator.submitTurn(
      { ...intent, generation: entry.generation },
      commandId,
    );
    if (launched.kind !== "launched") return launched;
    // 首字节身份复核：launched→stdin 首字节之间的窗口。
    // Gate 许可项=协调器登记后、本复核前可达（排队微任务窗口，审读探针复现）。
    const reg = this.opts.coordinator.getState().command;
    const gs = this.opts.gate.getState();
    if (
      this.phase !== "running" ||
      this.current !== entry ||
      entry.retired ||
      entry.handle === null ||
      reg === null ||
      !keyEqual(reg.key, launched.key) ||
      gs.kind !== "in-flight" ||
      gs.intentId !== launched.key.intentId
    ) {
      this.audit(
        `stdin-send-invalidated intentId=${launched.key.intentId} commandId=${launched.key.commandId} generation=${launched.key.generation} gate=${gs.kind}`,
      );
      return { kind: "invalidated", stage: "first-byte" };
    }
    await this.opts.host.writeStdin(entry.handle, stdinText);
    // 写完成复核：仅审计。背压期间换代→写只及旧 handle（零串扰），登记收口归退役手续。
    if (this.current !== entry || entry.retired) {
      this.audit(
        `stdin-written-stale intentId=${launched.key.intentId} commandId=${launched.key.commandId} generation=${launched.key.generation}`,
      );
    } else {
      this.audit(
        `stdin-written intentId=${launched.key.intentId} commandId=${launched.key.commandId} generation=${launched.key.generation}`,
      );
    }
    return launched;
  }

  /** 弃置 held 呈现（宿主关闭流程）：委托协调器，监管器不改变代次状态。 */
  abandonHeld(reason: string): void {
    this.opts.coordinator.abandonHeld?.(reason);
  }

  private stopSignal(entry: GenEntry, signal: "SIGTERM" | "SIGKILL"): void {
    if (entry.handle === null || entry.exit !== null) return;
    this.opts.host.stop(entry.handle, signal);
    this.audit(`process-stop signal=${signal} generation=${entry.generation}`);
  }

  private raceExit(entry: GenEntry, ms: number): Promise<Readonly<{ code: number | null; signal: string | null }> | null> {
    const exit = entry.exit;
    if (exit !== null) return Promise.resolve(exit);
    return Promise.race([
      new Promise<null>((resolve) => {
        entry.exitWaiters.push(() => resolve(null)); // resolve(null) 占位，真正值下面再读
        // 已有 exit 时立即兑现（onExit 同步路径已 resolve 所有 waiter，这里再兜一层）
        if (entry.exit !== null) resolve(null);
      }).then(() => entry.exit),
      this.opts.sleep(ms).then(() => entry.exit),
    ]);
  }

  private routeEvent(entry: GenEntry, ev: unknown): void {
    if (entry.retired || entry !== this.current) {
      this.audit(`process-event-dropped generation=${entry.generation}`);
      return;
    }
    // stopping 期仍路由：宽限内晚到 settled=旧轮最后事实
    this.opts.onProcessEvent?.(ev, entry.generation);
  }

  private onExit(entry: GenEntry, code: number | null, signal: string | null): void {
    if (entry.exit !== null) {
      this.audit(`process-exit-duplicate generation=${entry.generation}`);
      return;
    }
    entry.exit = { code, signal };
    for (const w of entry.exitWaiters.splice(0)) w();
    if (entry !== this.current) {
      this.audit(`process-exit-stale generation=${entry.generation}`);
      return;
    }
    if (this.phase === "stopping") {
      // 交接中退出：按同一退役手续收口（含 deadline-exceeded 后的晚到收口）
      const late = !entry.retireInFlight;
      this.finalizeRetire(entry, late ? "handover-late" : "handover");
      this.toIdle(entry);
      this.audit(`process-retired${late ? "-late" : ""} generation=${entry.generation}`);
      return;
    }
    // 意外退出：代次退役+屏障关闭；解除归宿主 reopen
    this.finalizeRetire(entry, "unexpected-exit");
    this.toIdle(entry);
    this.audit(`process-retired generation=${entry.generation}`);
  }

  /** 幂等退役：双路径（onExit/retireCurrent 续体）只生效一次；返回是否本次生效。 */
  private finalizeRetire(entry: GenEntry, reason: string): boolean {
    if (entry.retired) return false;
    entry.retired = true;
    const cleared = this.opts.coordinator.onGenerationRetired(entry.generation);
    const gs = this.opts.gate.getState();
    // 三活相态都关：dispatching（旧 submit 续体→invalidated：不 send 不登记）、
    // in-flight、settling（旧 settled 续体→invalidated：held 保留不写 idle）
    const gateClosed = gs.kind === "dispatching" || gs.kind === "in-flight" || gs.kind === "settling";
    if (gateClosed) this.opts.gate.close("generation-retired");
    this.audit(
      `generation-retired reason=${reason} generation=${entry.generation} clearedCommands=${cleared.clearedCommands} clearedEvents=${cleared.clearedEvents} gateClosed=${gateClosed}`,
    );
    return true;
  }

  /** 条件回 idle：仅当登记项仍是 current（旧续体不得清掉新代次）。 */
  private toIdle(entry: GenEntry): void {
    if (this.current !== entry) return;
    this.current = null;
    this.phase = "idle";
  }

  private nowMs(): number {
    // S3B-01：默认单调时钟（performance.now）。墙钟回拨会扩大预算，前跳会过早耗尽；
    // remainMs 对回拨/非有限值已钳位，但宿主仍应注入单调源。
    if (this.opts.nowMs) return this.opts.nowMs();
    return typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  }

  /** 剩余预算（绝对截止→剩余毫秒）；时钟回拨/非有限值被钳到 startMs（不扩大预算），已过期只探查 1ms。 */
  private remainMs(endAbsMs: number, startMs: number): number {
    let now = this.nowMs();
    if (!Number.isFinite(now)) now = startMs;
    if (now < startMs) now = startMs;
    return Math.max(endAbsMs - now, 1);
  }

  private audit(line: string): void {
    try {
      this.opts.audit?.(`${this.opts.now()} process-supervisor ${line}`);
    } catch {
      // 审计钩子异常不改变机制行为（与 command-channel 同口径）
    }
  }
}
