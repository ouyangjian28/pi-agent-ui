// 写权管理器（TECH §6 单写者+接管语义；W1/W1a/W1b 测试行）
// 纯逻辑状态机——进程 IO 走 ProcessOps 注入（测试/fake；真 pi 子进程在 apps/server 集成壳）
import type { SessionId } from "./identity.ts";
//
// 语义（TECH §6 终审修订）：
// - 查看≠接管：列表点击=查看态（只读 watch）；输入首字符/点接管按钮才申请写权
// - 默认接管=转接现有会话进程（唯一 RPC 写者复用：新页面绑定同一进程客户端面，代次+1 拒旧页面提交，进程不动）
// - 僵死换进程=串行化交接（有界）：旧写者先停（SIGTERM→宽限→SIGKILL+退出确认）→退出确认后才 spawn 新写者
// - 退出确认截止（默认 10s 可配）：到期=本次接管请求失败——会话保持冻结+暂定态，后台核验转正，不开新写者
// - 代次管页面控制权，不约束 pi 进程内已在飞的轮（接管≠spawn 新写者）
// - 让位事件=服务器写权管理器广播（代次变更时向相关连接发 yield/refresh；TUI 不参与协议）

export type ConnId = string;

/** 交接阶段（W1a/W1b）。 */
export type HandoffPhase =
  | "idle" // 无交接
  | "terminating" // SIGTERM 已发，宽限窗口内
  | "killed" // SIGKILL 已发，等退出确认
  | "frozen" // 确认截止到期：接管失败冻结（后台核验中；不开新写者）
  | "complete"; // 退出确认到达：可 spawn 新写者（调用方接手）

/** 单会话写权状态。 */
export interface WriterState {
  readonly sessionId: SessionId;
  /** 当前写权代次（0=从未持有；每次接管 +1）。 */
  readonly epoch: number;
  /** 当前持有连接（null=无持有者/查看态）。 */
  readonly holder: ConnId | null;
  /** 交接阶段（idle=正常）。 */
  readonly phase: HandoffPhase;
  /** 冻结/交接中不受理新接管。 */
  readonly busy: boolean;
}

/** 代次变更时向订阅者广播的事件（yield/refresh）。 */
export interface YieldEvent {
  readonly type: "yield" | "refresh";
  readonly sessionId: SessionId;
  readonly fromEpoch: number;
  readonly toEpoch: number;
  /** 旧持有者（yield 目标；refresh 广播全体）。 */
  readonly holder: ConnId | null;
}

/** 进程操作注入（测试 fake / 真实 pi 子进程管理）。 */
export interface ProcessOps {
  /** 对旧写者进程发信号（"SIGTERM" | "SIGKILL"）。 */
  signal(sessionId: SessionId, sig: "SIGTERM" | "SIGKILL"): void;
  /** 旧写者是否已退出（退出确认；waitpid/进程消失口径）。 */
  exited(sessionId: SessionId): boolean;
  /** 推进时间（测试注入；真实=定时器到点回调 deadlineReached）。 */
}

export interface RequestWriterResult {
  readonly kind: "attached" | "handoff-started" | "rejected";
  readonly reason?: string;
  readonly state: WriterState;
}

export type SubmitResult =
  | { readonly kind: "ok"; readonly epoch: number }
  | { readonly kind: "rejected"; readonly reason: "stale-epoch" | "not-holder" | "frozen"; readonly currentEpoch: number };

/** 写权管理器（多会话）。 */
export class WriterAuthority {
  private readonly states = new Map<SessionId, WriterState>();
  private readonly yieldLog: YieldEvent[] = [];
  private readonly listeners: ((e: YieldEvent) => void)[] = [];

  constructor(
    private readonly ops: ProcessOps,
    private readonly graceMs: number = 3000, // SIGTERM 宽限（TECH §4 收割口径）
    private readonly deadlineMs: number = 10_000, // 退出确认截止（七审 P1-1：默认 10s 可配，复用 F1 关停预算口径）
  ) {}

  private get(sessionId: SessionId): WriterState {
    let s = this.states.get(sessionId);
    if (!s) {
      s = { sessionId, epoch: 0, holder: null, phase: "idle", busy: false };
      this.states.set(sessionId, s);
    }
    return s;
  }

  /** 申请写权（输入首字符/点接管按钮；W1a 默认=转接现有进程）。 */
  requestWriter(sessionId: SessionId, connId: ConnId, oldWriterAlive: boolean): RequestWriterResult {
    const s = this.get(sessionId);
    if (s.busy || s.phase === "frozen") {
      return { kind: "rejected", reason: s.phase === "frozen" ? "frozen（核验中）" : "交接进行中", state: s };
    }
    if (!oldWriterAlive) {
      // 无存活写者进程：直接持有（代次+1）
      const ns: WriterState = { ...s, epoch: s.epoch + 1, holder: connId, phase: "idle", busy: false };
      this.states.set(sessionId, ns);
      this.emit({ type: "yield", sessionId, fromEpoch: s.epoch, toEpoch: ns.epoch, holder: s.holder });
      return { kind: "attached", state: ns };
    }
    // 写者进程存活：默认接管=转接（进程不动，代次+1 拒旧页面提交）——W1a「无双写者」：不 spawn
    const ns: WriterState = { ...s, epoch: s.epoch + 1, holder: connId, phase: "idle", busy: false };
    this.states.set(sessionId, ns);
    this.emit({ type: "yield", sessionId, fromEpoch: s.epoch, toEpoch: ns.epoch, holder: s.holder });
    this.emit({ type: "refresh", sessionId, fromEpoch: s.epoch, toEpoch: ns.epoch, holder: null });
    return { kind: "attached", state: ns };
  }

  /** 僵死换进程：发起串行化交接（SIGTERM→宽限→SIGKILL→退出确认；W1b 截止）。 */
  startHandoff(sessionId: SessionId): RequestWriterResult {
    const s = this.get(sessionId);
    if (s.busy) return { kind: "rejected", reason: "交接进行中", state: s };
    const ns: WriterState = { ...s, phase: "terminating", busy: true };
    this.states.set(sessionId, ns);
    this.ops.signal(sessionId, "SIGTERM"); // 宽限窗口（graceMs）由调用方计时后调 killOldWriter()
    return { kind: "handoff-started", state: ns };
  }

  /** 宽限到点仍存活 → SIGKILL（W1b 场景入口）。 */
  killOldWriter(sessionId: SessionId): WriterState {
    const s = this.get(sessionId);
    const ns: WriterState = { ...s, phase: "killed" };
    this.states.set(sessionId, ns);
    this.ops.signal(sessionId, "SIGKILL");
    return ns;
  }

  /** 退出确认到达（waitpid/进程消失）→ 交接完成，可 spawn 新写者（调用方接手）。 */
  confirmExit(sessionId: SessionId): WriterState {
    const s = this.get(sessionId);
    const ns: WriterState = { ...s, phase: "complete", busy: false };
    this.states.set(sessionId, ns);
    return ns;
  }

  /** 确认截止到期（deadlineMs）→ 接管失败冻结（不开新写者；后台核验中）——W1b。 */
  deadlineReached(sessionId: SessionId): WriterState {
    const s = this.get(sessionId);
    const ns: WriterState = { ...s, phase: "frozen", busy: true };
    this.states.set(sessionId, ns);
    return ns;
  }

  /** 后台核验通过（旧进程消失确认）→ 冻结转可接管。 */
  verifyRecovered(sessionId: SessionId): WriterState {
    const s = this.get(sessionId);
    const ns: WriterState = { ...s, phase: "complete", busy: false };
    this.states.set(sessionId, ns);
    return ns;
  }

  /** 持有者主动释放（断连/关闭）。 */
  release(sessionId: SessionId, connId: ConnId): WriterState {
    const s = this.get(sessionId);
    if (s.holder !== connId) return s; // 非持有者释放=无操作
    const ns: WriterState = { ...s, holder: null };
    this.states.set(sessionId, ns);
    return ns;
  }

  /** 命令门：提交校验（epoch 过期→拒；W1 让位后旧页面提交）。 */
  submit(sessionId: SessionId, connId: ConnId, epoch: number): SubmitResult {
    const s = this.get(sessionId);
    if (s.phase === "frozen") return { kind: "rejected", reason: "frozen", currentEpoch: s.epoch };
    // epoch 先验（W1：代次+1 拒旧页面提交——旧代次证据优先呈现；被夺权的旧页面典型=stale-epoch）
    if (epoch !== s.epoch) return { kind: "rejected", reason: "stale-epoch", currentEpoch: s.epoch };
    if (s.holder !== connId) return { kind: "rejected", reason: "not-holder", currentEpoch: s.epoch };
    return { kind: "ok", epoch: s.epoch };
  }

  /** 代次变更广播（W1 让位事件；测试断言用）。 */
  onYield(fn: (e: YieldEvent) => void): void {
    this.listeners.push(fn);
  }

  yieldEvents(): readonly YieldEvent[] {
    return this.yieldLog;
  }

  private emit(e: YieldEvent): void {
    this.yieldLog.push(e);
    for (const fn of this.listeners) fn(e);
  }
}
