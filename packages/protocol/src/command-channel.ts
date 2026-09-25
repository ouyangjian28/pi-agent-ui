// 通用命令通道（TECH §3 RPC 命令顺序化②：abort/clear/switch_session/steer 域；r8/r8c 风险序 1）
//
// 占位先行序（崩溃闭环契约，§3）：
//   ①dedup.admit（内存受理）→ ②占位行 fsync（OpLedgerPort）→ ③send()（真实 RPC 发送）→ ④结果行 fsync → ⑤dedup.settle
// - ②失败=不发送（副作用通道从未开栓）；盘上占位行写入结果未确认（可能已写完整/部分行，A1-02）→内存占位留置：
//   同 opId 重试=unknown-effect（不冒充可重发），新请求=新 opId（opId 由服务器生成，换号零成本）
// - ③send 抛错/返回 null（协议违规）=效果未知：占位留置（重试同 opId=unknown-effect，不重发）；新取消请求=新 opId
// - ④失败=结果已在手但结果行写入未确认：内存保持占位态（进程内继续 unknown-effect 口径）；重启后以实际重放裁决
//   （读到有效结果行=cached 非洗白，未读到=unknown-effect）
// - 同键同参=cached 不重发；同键不同参=拒+审计行钩子
//
// 本模块=纯逻辑编排：CommandDedup（内存表）+注入 OpLedgerPort（真 fsync 由 adapter 宿主接管，随 §17.2 同目录纪律）。

import type { CommandDedup, OpId, OpRecord } from "./command-dedup.ts";

/** op 表耐久端口（载体=§17.2 邻接目录；本接口只管语义时序）。 */
export interface OpLedgerPort {
  /** 占位行 fsync（result=null 的 OpRecord）；失败=reject。 */
  appendPlaceholder(rec: OpRecord): Promise<void>;
  /** 结果行 fsync（完整记录）；失败=reject。 */
  appendResult(rec: OpRecord): Promise<void>;
}

export type DispatchOutcome =
  | { readonly kind: "ok"; readonly result: unknown }
  | { readonly kind: "cached"; readonly result: unknown } // 同键同参：返回缓存不重发
  | { readonly kind: "rejected-different-args" } // 同键不同参：拒（审计行已触发钩子）
  | { readonly kind: "unknown-effect" } // 占位无结果（旧请求未知/发送失败留置）：不重发不受理
  | {
      /** 占位 fsync 失败：未发送（副作用通道未开栓）；盘上占位行写入结果未确认（可能已写）——内存占位留置，同 opId 重试=unknown-effect；新请求=新 opId。 */
      kind: "placeholder-durability-failed";
      readonly error: unknown;
    }
  | {
      /** send 抛错：效果未知（可能已发）——占位留置，不自动重发；重试同 opId=unknown-effect。 */
      kind: "send-failed";
      readonly error: unknown;
    }
  | {
      /** 结果已到手但结果行 fsync 失败：内存保持占位态；重启后以实际重放裁决（读到有效结果行=cached 非洗白）。 */
      kind: "result-durability-failed";
      readonly result: unknown;
      readonly error: unknown;
    };

export class CommandChannel {
  constructor(
    private readonly opts: {
      dedup: CommandDedup;
      ledger: OpLedgerPort;
      now(): string;
      /** 审计行钩子（同键不同参拒等；宿主落观测层）。 */
      onAudit?: (line: string) => void;
    },
  ) {}

  /** 占位先行派发。send 由调用方执行（拿到该回调时占位已耐久，可安全写 stdin）；
   *  返回值必须为非 null 应答对象（null=协议违规，按效果未知处理，A1-05）。 */
  async dispatch(opId: OpId, argsHash: string, send: () => Promise<object>): Promise<DispatchOutcome> {
    const placedAt = this.opts.now();
    const admit = this.opts.dedup.admit(opId, argsHash, placedAt);
    switch (admit.kind) {
      case "cached":
        return { kind: "cached", result: admit.result };
      case "rejected-different-args":
        this.opts.onAudit?.(`command-dedup: opId=${opId} 同键不同参拒绝`);
        return { kind: "rejected-different-args" };
      case "unknown-effect":
        return { kind: "unknown-effect" };
      case "admitted":
        break;
    }
    // ②占位先行耐久（发送前 fsync）
    try {
      await this.opts.ledger.appendPlaceholder({ opId, argsHash, placedAt, result: null });
    } catch (error) {
      // 未发送（send 从未调用）；但 reject 不证明盘上无占位行（write 可能已落后报错，A1-02）→内存留置保守口径，不回滚
      return { kind: "placeholder-durability-failed", error };
    }
    // ③发送（此刻起效果可能已发生）
    let result: object;
    try {
      result = await send();
    } catch (error) {
      return { kind: "send-failed", error }; // 占位留置：效果未知，不重发
    }
    if (result === null || result === undefined) {
      // A1-05：null 哨兵与 unknown-effect 冲突——send 返回 null=协议违规；效果未知，占位留置，不落盘洗白
      this.opts.onAudit?.(`command-channel: opId=${opId} send 返回 null/undefined（协议违规，按效果未知留置）`);
      return { kind: "send-failed", error: new Error("send returned null/undefined") };
    }
    // ④结果行 fsync → ⑤内存 settle（盘先行，内存跟随；崩溃闭环由盘上事实裁决）
    try {
      await this.opts.ledger.appendResult({ opId, argsHash, placedAt, result });
    } catch (error) {
      return { kind: "result-durability-failed", result, error };
    }
    this.opts.dedup.settle(opId, result);
    return { kind: "ok", result };
  }
}
