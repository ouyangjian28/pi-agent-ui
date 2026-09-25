// 通用命令去重表（TECH §3 RPC 命令顺序化②：abort/clear/switch_session/steer 域）
// 通知派生命令（prompt/follow_up）不走此表——opId 落 §17.2 接收账本（notificationId 域）。
//
// 契约（十四轮 D11+十五轮+十六轮补全）：
// - 每条我方命令带 opId（=intentId+命令序号）；发送前耐久占位（opId 行先落盘再发送）
// - 同键同参=返回缓存结果不重发；同键不同参=拒绝+审计行（非幂等重放，禁盲执行）
// - 崩溃闭环：恢复见占位行+无结果缓存=「旧请求未知结果」——不重发（呈现 unknown 给用户）不当作新请求受理
// - 保存期限=所属会话活跃期+24h 滚动清除
// - 耐久载体=随 §17.2 同目录同 fsync 纪律（本模块=纯逻辑状态机；fsync 由 adapter 负责）

export type OpId = string;

export interface OpRecord {
  readonly opId: OpId;
  /** 参数指纹（规范化 JSON hash；同键不同参判定依据）。 */
  readonly argsHash: string;
  /** 占位时刻（滚动清除依据；ISO）。 */
  readonly placedAt: string;
  /** null=已发送未确认（结果未知态）；非 null=结果缓存。 */
  readonly result: unknown;
}

export type AdmitResult =
  | { readonly kind: "admitted" } // 受理+占位：调用方现在发送
  | { readonly kind: "cached"; readonly result: unknown } // 同键同参：返回缓存不重发
  | { readonly kind: "rejected-different-args" } // 同键不同参：拒绝（审计行由 adapter 落）
  | { readonly kind: "unknown-effect" }; // 占位无结果（旧请求未知）：不重发不受理

/** 滚动清除的生命周期判据（r8b：两个生命周期事实分开声明，不得用「最后消息时间」冒充「退出时刻」）。
 * - active:true=仍活跃→一律不删
 * - inactiveSince=退出活跃期的时刻（ISO）→退出满 24h 且占位过 24h 才删
 * - 缺省/解析失败=生命周期未知→保守不删（逼调用方显式表态）
 * 删除条件=占位过 24h 且会话已退出活跃期满 24h。 */
export interface SweepLifecycle {
  readonly active?: boolean;
  readonly inactiveSince?: string;
}

export class CommandDedup {
  private readonly records = new Map<OpId, OpRecord>();

  /** 受理入口：发送前先查表（崩溃闭环=占位先行耐久由 adapter 在返回 admitted 后 fsync 再发送）。 */
  admit(opId: OpId, argsHash: string, placedAt: string): AdmitResult {
    const prev = this.records.get(opId);
    if (!prev) {
      this.records.set(opId, { opId, argsHash, placedAt, result: null });
      return { kind: "admitted" };
    }
    if (prev.argsHash !== argsHash) return { kind: "rejected-different-args" };
    if (prev.result === null) return { kind: "unknown-effect" };
    return { kind: "cached", result: prev.result };
  }

  /** 应答回来落结果缓存（settle 前的行=占位；之后=完整记录）。 */
  settle(opId: OpId, result: unknown): void {
    const prev = this.records.get(opId);
    if (!prev) return; // 无占位的 settle=异常路径（adapter 审计）；不新建（占位必须先行）
    this.records.set(opId, { ...prev, result });
  }

  /** 滚动清除前的占位回滚：仅限「占位耐久失败且未发送」（副作用通道从未开栓）——对齐盘上事实源；已发送命令禁用（效果未知态必须留置）。 */
  rollback(opId: OpId): boolean {
    return this.records.delete(opId);
  }

  /** 重启重放重建（占位行+完整行都进表）。 */
  replay(records: readonly OpRecord[]): void {
    for (const r of records) this.records.set(r.opId, r);
  }

  /** 滚动清除（r8-02+r8b：生命周期判据见 SweepLifecycle；两个时间事实分开——placedAt 过窗 且 退出活跃期满 24h）。 */
  sweep(now: string, lifecycle: SweepLifecycle = {}): number {
    if (lifecycle.active === true) return 0; // 活跃期保护：仍活跃一律不删
    if (typeof lifecycle.inactiveSince !== "string") return 0; // 未知=不删（保守）
    const nowMs = Date.parse(now);
    const inactiveMs = Date.parse(lifecycle.inactiveSince);
    if (!Number.isFinite(nowMs) || !Number.isFinite(inactiveMs)) return 0; // 判据坏=未知=不删
    const cutoff = nowMs - 24 * 3600 * 1000;
    if (inactiveMs >= cutoff) return 0; // 退出不满 24h：保留窗未满不删（r8b 反例：最后消息 T0+退出 T24，T25 须保留）
    let removed = 0;
    for (const [opId, r] of this.records) {
      const t = Date.parse(r.placedAt);
      if (Number.isFinite(t) && t < cutoff) {
        this.records.delete(opId);
        removed += 1;
      }
    }
    return removed;
  }

  /** 查询（测试/审计）。 */
  get(opId: OpId): OpRecord | undefined {
    return this.records.get(opId);
  }

  size(): number {
    return this.records.size;
  }
}
