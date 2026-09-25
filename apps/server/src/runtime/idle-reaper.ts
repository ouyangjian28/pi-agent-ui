/**
 * 闲置回收（切片5①；TECH:26/§9.1 C1/ADR#4；GPT 对齐轮定案）。
 *
 * 双条件=agent_settled（gate idle 面）+宿主后台任务登记表空，同满足才开始连续闲置计时；
 * 任一断开（新轮受理/任务登记）立即清零；浏览/心跳不算执行活动。
 * 闲置期限（默认 30min 可调）与关停截止（supervisor 总预算）两计时分立；
 * 内存水位不进本切片（下一阶段定案口径）。
 *
 * 回收=EOF 优先优雅链（supervisor.retireCurrentGraceful）；触发在 tick 同步段完成全部复核
 * 并置 stopping——与 send 的竞争闭合为：send 先受理→isSessionIdle 断开→不触发；
 * 回收先成立→send 撞 stopping/idle 拒绝（not-ready），不暗排队、不自动重发。
 *
 * 回收≠销毁 RpcSession：本器不触碰 durability/订阅/会话元数据；
 * 重 spawn 仅明确申请执行时（send/start）由 RpcSession 冷启动路径拉起。
 *
 * 后台任务登记表不硬编码空：registry.activeCount()>0 即阻断；未知登记态的语义由
 * registry 实现方负责（v1 MapRegistry 只认显式 register/complete）。
 */

export interface IdleSupervisorPort {
  getState(): { generation: number | null; phase: "idle" | "running" | "stopping" };
  retireCurrentGraceful(eofGraceMs?: number): Promise<{ kind: string }>;
}

export interface BackgroundTaskRegistry {
  /** 登记一个活跃后台任务；同 id 重复登记=幂等（计数不翻倍）。 */
  register(id: string, label?: string): void;
  /** 完成一个登记；未知 id=no-op。 */
  complete(id: string): void;
  /** 当前活跃登记数（0=表空）。 */
  activeCount(): number;
}

/** v1 默认登记表：Map 计数（显式 register/complete；重复 register 幂等）。 */
export class MapRegistry implements BackgroundTaskRegistry {
  private readonly tasks = new Map<string, { label: string; startedAt: number }>();
  register(id: string, label = ""): void {
    if (this.tasks.has(id)) return; // 幂等：同 id 不翻倍
    this.tasks.set(id, { label, startedAt: Date.now() });
  }
  complete(id: string): void {
    this.tasks.delete(id);
  }
  activeCount(): number {
    return this.tasks.size;
  }
}

export interface IdleReaperDeps {
  supervisor: IdleSupervisorPort;
  /** agent_settled 面（gate idle）。 */
  isSessionIdle(): boolean;
  registry: { activeCount(): number };
  now(): number;
  audit?(line: string): void;
  /** 闲置期限，默认 30 分钟。 */
  idleMs?: number;
  /** EOF 宽限（传给 retireCurrentGraceful），默认由 supervisor 定。 */
  eofGraceMs?: number;
}

export class IdleReaper {
  private idleSince: number | null = null;
  private reaping = false;
  private disposed = false;
  private readonly idleMs: number;

  constructor(private readonly deps: IdleReaperDeps) {
    this.idleMs = deps.idleMs ?? 30 * 60_000;
  }

  private audit(line: string): void {
    try {
      this.deps.audit?.(line);
    } catch {
      // 审计钩子异常不阻断回收器（回调隔离契约）
    }
  }

  private eligible(): boolean {
    return (
      this.deps.supervisor.getState().phase === "running" &&
      this.deps.isSessionIdle() &&
      this.deps.registry.activeCount() === 0
    );
  }

  /** 由宿主巡检循环驱动（与超时巡检共用一个 interval）；同步段完成复核+触发置位。 */
  tick(): void {
    if (this.disposed || this.reaping) return;
    if (!this.eligible()) {
      this.idleSince = null;
      return;
    }
    const now = this.deps.now();
    if (!Number.isFinite(now)) return; // 时钟异常不推进计时（保守：不清零也不触发）
    if (this.idleSince === null) {
      this.idleSince = now;
      this.audit(`idle-timer-start generation=${this.deps.supervisor.getState().generation}`);
      return;
    }
    if (now - this.idleSince >= this.idleMs) {
      // 触发前同步复核：与 send 竞争闭合在本同步段（置 stopping 后 send 撞拒）
      if (!this.eligible()) {
        this.idleSince = null;
        return;
      }
      const gen = this.deps.supervisor.getState().generation;
      this.reaping = true;
      this.idleSince = null;
      this.audit(`idle-reap-start generation=${gen} idleMs=${this.idleMs}`);
      void this.deps.supervisor
        .retireCurrentGraceful(this.deps.eofGraceMs)
        .then((r) => {
          this.audit(`idle-reap-done kind=${r.kind}`);
        })
        .catch((err: unknown) => {
          this.audit(`idle-reap-failed err=${String(err)}`);
        })
        .finally(() => {
          this.reaping = false;
        });
    }
  }

  dispose(): void {
    this.disposed = true;
  }
}
