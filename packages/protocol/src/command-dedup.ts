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

  /** 重启重放重建（占位行+完整行都进表）。 */
  replay(records: readonly OpRecord[]): void {
    for (const r of records) this.records.set(r.opId, r);
  }

  /** 滚动清除（r8-02：会话活跃期+24h 双条件）。sessionLastActiveAt=会话最后活跃时刻；缺省=视为此刻活跃（保守不删，逼调用方显式表态）。删除条件=占位过 24h 且会话已退出活跃期满 24h。 */
  sweep(now: string, opts: { sessionLastActiveAt?: string } = {}): number {
    const cutoff = Date.parse(now) - 24 * 3600 * 1000;
    if (opts.sessionLastActiveAt === undefined) return 0; // 会话活跃期保护：无判据不删（r8-02）
    const sessionIdle = Date.parse(opts.sessionLastActiveAt) < cutoff;
    if (!sessionIdle) return 0;
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
