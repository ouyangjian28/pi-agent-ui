// RpcSession：组装面（切片4）。把纯逻辑层（TurnGate+DispatchCoordinator+ProcessSupervisor）
// 接到真进程宿主（PiProcessHost）与真耐久（FileDurability）上，并承担 RPC 协议面四件事：
//  ① demux：stdout 行分派——type:"response"（含 readiness 探针回执）→协调器 onRpcResponse；
//     agent_settled→onSettledEvent（无 id 事件=单在途归因，协调器自校验）；其余→onPiEvent。
//  ② readiness：spawn 成功即写 get_state 探针（TECH §40：pi RPC 无 banner，readiness=ping 往返）。
//     写入/响应/超时纳入同一有界启动操作（S4-03）：writeP 与 respP 经 Promise.all 聚合，超时能结束
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
import { IdleReaper, MapRegistry } from "./idle-reaper.js";

export interface RpcSessionOpts {
  /**
   * pi 参数。默认=绑定 opts.sessionFile 的持久会话（["--mode","rpc","--session",sessionFile]）。
   * S5-R3：闲置回收生命周期要求跨回收重启接同一会话文件——sessionFile 与 piArgs 必须显式给一个；
   * 两者都缺=构造拒绝（不默认 --no-session：无会话文件即无原上下文恢复，回收后冷启动只当新会话跑）。
   * 显式传 piArgs=测试/临时模式（含 --no-session 时无持久身份，由调用方自担，不得作生产默认）。
   */
  readonly piArgs?: readonly string[];
  /** 持久会话文件路径（默认 piArgs 的绑定源；跨回收/重启两代 spawn 必须同一文件）。 */
  readonly sessionFile?: string;
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
  /** 闲置期限（默认 30 分钟；双条件=agent_settled+登记表空才开始计时）。 */
  readonly idleMs?: number;
  /** 后台任务登记表（闲置回收双条件之一；默认空 MapRegistry，扩展任务接入后替换）。 */
  readonly idleRegistry?: import("./idle-reaper.js").BackgroundTaskRegistry;
  /** EOF 宽限（闲置回收优雅链首选 EOF；超时升级 SIGTERM）。 */
  readonly eofGraceMs?: number;
  /** 显式禁用闲置回收器（测试/特殊宿主）。 */
  readonly disableIdleReaper?: boolean;
  readonly audit?: (line: string) => void;
  readonly now?: () => string;
  /** 交付面：run-open 期事件直交（含 buffered/dropped 处置，供 UI）。异常被隔离。 */
  readonly onPiEvent?: (ev: unknown, generation: number, disposition: string) => void;
  /** 缓冲排空面（settled 后补交付）。 */
  readonly onBufferDrain?: (events: readonly unknown[]) => void;
  readonly onStderr?: (text: string, generation: number) => void;
  /** 轮次完全收口（settled 结算耐久确认后；恰好一次/轮）。 */
  readonly onSettled?: (generation: number) => void;
  /** 观测面：spawn 成功（探针之后）回调，携带进程句柄（4c：E2E 注入真实退出/诊断用）。异常被隔离。 */
  readonly onSpawned?: (handle: ProcessHandle, generation: number) => void;
}

export type SessionStartResult =
  | { readonly kind: "ready"; readonly generation: number }
  | { readonly kind: "superseded"; readonly generation: number } // 启动等待期内该代已被退出/退役取代：本结果不附带任何动作
  | ({ readonly kind: "readiness-timeout"; readonly generation: number; readonly retire: RetireOutcome }
    | { readonly kind: "spawn-failed"; readonly error: unknown }
    | { readonly kind: "rejected"; readonly reason: "not-idle" }
    | { readonly kind: "spawn-exited"; readonly generation: number; exit: Readonly<{ code: number | null; signal: string | null }> });

export type SessionSendResult = LaunchOutcome | { readonly kind: "no-process" } | { readonly kind: "invalidated"; readonly stage: "first-byte" } | { readonly kind: "not-ready"; readonly cause?: string };

/**
 * 包装登记表（S5-R1）：register/complete 转发后同步通知回收器活动——
 * 采样间完成的短登记不得沿用旧闲置起点。宿主应使用 session.idleRegistry（包装版）
 * 而非自有原始引用，否则活动通知语义失效。
 */
function wrapRegistry(raw: import("./idle-reaper.js").BackgroundTaskRegistry, note: () => void): import("./idle-reaper.js").BackgroundTaskRegistry {
  return {
    register: (id: string, label?: string) => {
      raw.register(id, label);
      note();
    },
    complete: (id: string) => {
      raw.complete(id);
      note();
    },
    activeCount: () => raw.activeCount(),
  };
}

interface ReadinessWaiter {
  /** 响应已到→标记布尔（S4-B1：只标记；不清 timer 不删入口——总截止约束写+响应整体） */
  resolve(ok: boolean): void;
}

/** 完成通知去重集容量（Y3/s4b）：长会话有界；超额淘汏最旧 intentId。 */
const SETTLED_NOTIFIED_CAP = 1024;

/** 启动操作的取消口（S4-B1/B2）：独立于响应 waiter——响应已到仍可取消（stop/换代）。 */
type ReadinessCancel = (reason: Error) => void;

export class RpcSession {
  private readonly gate: TurnGate;
  private readonly coordinator: DispatchCoordinator;
  private readonly supervisor: ProcessSupervisor;
  /** S5-R3：两代 spawn 共用的 pi 参数（构造时解析：显式 piArgs 或绑定 sessionFile）。 */
  private readonly piArgs: readonly string[];
  /** 宿主登记面（S5-R1 包装版：register/complete 同步通知回收器活动；勿绕过它用原始引用）。 */
  readonly idleRegistry: import("./idle-reaper.js").BackgroundTaskRegistry;
  private reaper: IdleReaper | null = null; // dispose 置 null
  private readonly readiness = new Map<string, ReadinessWaiter>();
  private readonly readinessCancels = new Map<number, ReadinessCancel>();
  private readyGeneration: number | null = null;
  private readonly ordinals = new Map<string, number>();
  private readonly readyPromise = new Map<number, Promise<void>>();
  private readonly settledNotified = new Set<string>(); // intentId → 已发完成通知（恰好一次/轮）
  private cmdSeq = 0;
  private intentSeq = 0;
  private pollTimer: NodeJS.Timeout | null; // dispose 置 null
  private disposeP: Promise<void> | null = null; // 并发 dispose 共享同一关闭操作与完成结果（s4e Y-C2：不能让第二次调用提前返回——那时 close 可能仍挂起）；s4f F3：先发布后运行——同步重入（close 回调里再 dispose）也共享同一收尾，恰一次 close；注：async 签名下两次调用返回的外层 Promise 引用不保证 ===，仅共享操作与结果（s4g 契约措辞）

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
        this.reaper?.noteActivity(); // S5-R1：换代即活动（旧代退出+新 spawn 都在两 tick 间时旧起点不得沿用）
        // spawn 成功即发探针；成败都汇入 readyPromise（start 汇合后按所有权处置）
        const p = this.probeReadiness(handle, generation)
          .catch((e: unknown) => {
            safeAudit(`rpc-session readiness-failed generation=${generation} ${String(e instanceof Error ? e.message : e)}`);
          })
          .finally(() => {
            this.readyPromise.delete(generation); // Y5：完成的启动操作不留 Map（防随重启次数增长）
          });
        this.readyPromise.set(generation, p);
        try {
          this.opts.onSpawned?.(handle, generation); // 观测面（4c：E2E/宿主拿句柄注入真实退出）
        } catch (e: unknown) {
          safeAudit(`rpc-session spawned-callback-error ${String(e instanceof Error ? e.message : e)}`);
        }
      },
      now,
      nowMs: () => performance.now(),
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      audit: (l: string) => safeAudit(`supervisor ${l}`),
    });
    // S5-R3：持久身份建模——sessionFile 与 piArgs 必须显式给一个（默认绑定同一 sessionFile）
    if (opts.piArgs === undefined && opts.sessionFile === undefined) {
      throw new Error("RpcSession：必须显式提供 sessionFile（生产持久会话）或 piArgs（测试/临时模式）——闲置回收生命周期要求跨回收重启绑定同一会话文件");
    }
    this.piArgs = opts.piArgs ?? ["--mode", "rpc", "--session", opts.sessionFile as string];
    const pollMs = opts.timeoutPollMs ?? 250;
    // 切片5①：闲置回收器（双条件同满足才开始连续计时；回收=EOF 优先优雅链）
    // S5-R1：登记表包装（register/complete 同步通知活动）；宿主用 this.idleRegistry 登记后回收器自动感知
    this.idleRegistry = wrapRegistry(opts.idleRegistry ?? new MapRegistry(), () => this.reaper?.noteActivity());
    this.reaper =
      opts.disableIdleReaper === true
        ? null
        : new IdleReaper({
            supervisor: this.supervisor,
            isSessionIdle: () => this.gate.getState().kind === "idle",
            registry: this.idleRegistry,
            now: () => performance.now(),
            audit: (l) => safeAudit(l),
            ...(opts.idleMs !== undefined ? { idleMs: opts.idleMs } : {}),
            ...(opts.eofGraceMs !== undefined ? { eofGraceMs: opts.eofGraceMs } : {}),
          });
    this.pollTimer = setInterval(() => {
      this.reaper?.tick();
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

  /** 释放本地资源（Y-C2/s4c：巡检定时器+耐久句柄）；进程退役另走 stop()。幂等。 */
  async dispose(): Promise<void> {
    if (this.disposeP !== null) return this.disposeP;
    // s5c B2：同步急停——公开 dispose 调用返回前 tick 通道立即失效（interval 清+回收器置废）。
    // 此前清停排在未来微任务（F3 先发布后运行），而到期 tick 的 audit 同步重入 dispose 后
    // 当前 tick 仍会继续执行并发起回收（对真进程发 EOF/SIGTERM）。
    // 契约范围（s5c 报告收窄）：只保证取消「尚未开始」的回收——不得新发起；已置 stopping 并
    // 已发 EOF 的在途退役不撤回（其完成审计仍可能出现）。
    // 幂等：runDispose 再清一次（pollTimer 已 null / reaper 已 null 均无害）。
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.reaper?.dispose();
    this.reaper = null;
    // F3：先发布再运行（微任务边界）：外部 durability.close 的同步回调里若重入 dispose()，
    // 此刻 disposeP 已发布（共享同一关闭操作与完成结果，同步重入 dispose 也走同一链）→不会二次 close。
    // 注：close 内不得 await 本 dispose Promise（自等待死锁）——同步契约注释见 DurabilityPort.close。
    const p = (async () => {
      await Promise.resolve();
      return this.runDispose();
    })();
    this.disposeP = p;
    return p;
  }

  private async runDispose(): Promise<void> {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.reaper?.dispose();
    this.reaper = null;
    await this.opts.durability
      .close?.()
      .catch((e: unknown) => this.safeAudit(`rpc-session durability-close-failed ${String(e)}`));
  }

  /** demux：supervisor 已按代次过滤的 stdout 事件行 → 协调器三入口。 */
  private demux(ev: unknown, generation: number): void {
    const o = ev as { type?: unknown; id?: unknown; success?: unknown };
    if (o !== null && typeof o === "object" && o.type === "response" && typeof o.id === "string") {
      const waiter = this.readiness.get(o.id);
      if (waiter !== undefined) {
        waiter.resolve(o.success === true); // B1：响应只标记收到；入口/timer/取消口保留到整体落定
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
      const ret = this.opts.onPiEvent?.(ev, generation, r.kind) as unknown;
      if (ret instanceof Promise) void ret.catch((e: unknown) => this.safeAudit(`rpc-session pi-event-async-error ${String(e instanceof Error ? e.message : e)}`));
    } catch (e: unknown) {
      this.safeAudit(`rpc-session pi-event-error ${String(e instanceof Error ? e.message : e)}`);
    }
  }

  /** 完成通知（S4-05）：绑定轮身份（TurnKey），按 intentId 恰好一次。
   *  Y3（s4b）：集合有界（插入序淘汏，容量 1024）——长会话不无限增长；超额淘汏最旧项
   *  （防御层：协调器已门控全部通知路径，淘汏旧 intentId 的碰撞风险=旧轮重放同 id，不可达）。 */
  private notifySettled(key: TurnKey): void {
    if (this.settledNotified.has(key.intentId)) {
      this.safeAudit(`rpc-session settled-notify-duplicate intentId=${key.intentId}（已通知，丢弃）`);
      return;
    }
    this.settledNotified.add(key.intentId);
    this.reaper?.noteActivity(); // S5-R1：settled 即活动——两 tick 间完成的短轮，闲置起点后移到结算时刻
    if (this.settledNotified.size > SETTLED_NOTIFIED_CAP) {
      const oldest = this.settledNotified.values().next().value; // 插入序首项
      if (oldest !== undefined) this.settledNotified.delete(oldest);
    }
    // Y4（s4b）：同步异常隔离 + 异步返回值（Promise）拒绝也入审计（不吞 unhandled）
    try {
      const ret = this.opts.onSettled?.(key.generation) as unknown;
      if (ret instanceof Promise) void ret.catch((e: unknown) => this.safeAudit(`rpc-session settled-callback-async-error ${String(e instanceof Error ? e.message : e)}`));
    } catch (e: unknown) {
      this.safeAudit(`rpc-session settled-callback-error ${String(e instanceof Error ? e.message : e)}`);
    }
  }

  /** readiness 探针（S4-03/04 + s4b B1/B2）：写入+响应+超时+取消=同一有界启动操作。
   *  - 总截止 timer 约束**写+响应整体**：响应先到不清除（B1），直到整体落定才清；
   *  - finish 幂等单结算：超时/取消/写失败/被拒/成功任一先到，其余路径不再改写结果；
   *  - 取消口独立于响应标记（readinessCancels）：响应已到仍可取消（B2：stop 失效启动操作）；
   *  - 成功侧复核当前代**与相态 running**（B2：stopping/已退出不得报 ready）；
   *  - 成功不置 readyGeneration 若已 finish（晚到续体不复活结果）。 */
  private probeReadiness(handle: ProcessHandle, generation: number): Promise<void> {
    const id = `ready-${generation}`;
    const timeoutMs = this.opts.readinessTimeoutMs ?? 15_000;
    return new Promise<void>((resolveOuter, rejectOuter) => {
      let done = false;
      const finish = (err?: Error): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.readiness.delete(id);
        this.readinessCancels.delete(generation);
        if (err === undefined) resolveOuter();
        else rejectOuter(err);
      };
      const timer = setTimeout(() => {
        finish(new Error(`readiness 启动超时（${timeoutMs}ms，写+响应整体）`)); // B1：写挂起也到点终止
      }, timeoutMs);
      this.readinessCancels.set(generation, (reason) => finish(reason));
      let respResolve!: (ok: boolean) => void;
      const respP = new Promise<boolean>((res) => {
        respResolve = res;
      });
      this.readiness.set(id, { resolve: respResolve });
      const writeP = this.opts.host.writeStdin(handle, `${JSON.stringify({ id, type: "get_state" })}\n`);
      Promise.all([writeP, respP])
        .then(([, ok]) => {
          if (done) return; // 晚到续体：整体已由超时/取消落定，不得置 ready
          if (!ok) {
            finish(new Error("readiness 探针被拒（get_state success=false）"));
            return;
          }
          // B2：ready 要求当前代匹配且相态 running（stopping/已退出=superseded）
          const st = this.supervisor.getState();
          if (st.generation !== generation || st.phase !== "running") {
            finish(new Error(`readiness-superseded（探针完成时 ${st.phase}/${st.generation ?? "无"}）`));
            return;
          }
          this.readyGeneration = generation;
          this.safeAudit(`rpc-session ready generation=${generation}`);
          finish();
        })
        .catch((e: unknown) => {
          finish(e instanceof Error ? e : new Error(String(e)));
        });
    });
  }

  /** 启动（或意外退出后重启）：gate 若因上代关闭先 reopen→spawn→readiness 往返。 */
  async start(): Promise<SessionStartResult> {
    if (this.gate.getState().kind === "closed") {
      const ok = this.gate.reopen();
      if (!ok) return { kind: "rejected", reason: "not-idle" }; // reopen 仅 closed→idle（B1-01）
    }
    const r = this.supervisor.spawnNext(this.piArgs);
    if (r.kind !== "spawned") {
      if (r.kind === "rejected") return { kind: "rejected", reason: r.reason };
      if (r.kind === "spawn-failed") return { kind: "spawn-failed", error: r.error };
      return { kind: "spawn-exited", generation: r.generation, exit: r.exit };
    }
    // onSpawned 在 spawnNext 内同步启动探针并登记 promise（spawned 分支必已存在）
    await this.readyPromise.get(r.generation);
    if (this.readyGeneration !== r.generation) {
      // 探针失败（超时/被拒/写失败/superseded）：先复核所有权，只退役自己这一代（S4-04）。
      // Y-C1（s4c 契约固化）：宿主已 stop/retire（phase=stopping）时本启动操作已作废→superseded；
      // 不再发 readiness-timeout+retire=stopping（退役已由宿主发起，结果分类不得依赖 exit 送达时序）。
      const cur = this.supervisor.getState();
      if (cur.generation !== r.generation || cur.phase !== "running") {
        this.safeAudit(
          `rpc-session readiness-failed-superseded generation=${r.generation} current=${cur.phase}/${cur.generation ?? "无"}（不动当前代）`,
        );
        return { kind: "superseded", generation: r.generation };
      }
      const retire = await this.supervisor.retireCurrent();
      return { kind: "readiness-timeout", generation: r.generation, retire };
    }
    // B2（P2 终窗）：返回 ready 前再复核现态——探针成功与 start 返回之间退出/退役不得报 ready
    const fin = this.supervisor.getState();
    if (fin.generation !== r.generation || fin.phase !== "running") {
      this.safeAudit(`rpc-session ready-superseded-at-return generation=${r.generation} current=${fin.phase}/${fin.generation ?? "无"}`);
      return { kind: "superseded", generation: r.generation };
    }
    return { kind: "ready", generation: r.generation };
  }

  /** 发一轮用户消息（三写硬序在纯逻辑层；本层只渲染帧+对账 id）。 */
  async send(message: string): Promise<SessionSendResult> {
    let st = this.supervisor.getState();
    // 切片5①：闲置回收后无进程——send=明确申请执行，冷启动拉起（查看不拉起；原会话文件+readiness）
    if (st.phase === "idle") {
      const sr = await this.start();
      // ②面准备：失败原因结构化透传（cause），UI 不得只显一律「未就绪」
      if (sr.kind !== "ready") return { kind: "not-ready", cause: sr.kind };
      st = this.supervisor.getState();
    }
    this.reaper?.noteActivity(); // S5-R1：受理即活动（采样间的受理→settled 短轮不得沿用旧起点）
    const gen = st.generation;
    // B2 面：ready 标志之外还须现态 running（stopping/已退出不开真实派发）
    if (gen === null || st.phase !== "running" || this.readyGeneration !== gen) return { kind: "not-ready", cause: "not-running" };
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
    // B1/B2：取消口独立于响应标记——响应已到（waiter 已兑现）仍能终结整体（stop 失效启动操作）
    const cancel = this.readinessCancels.get(generation);
    if (cancel === undefined) return;
    this.readinessCancels.delete(generation);
    cancel(new Error("readiness-canceled（退役/停止）"));
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
