// 通知状态机+终态单调性（TECH §17 接收账本：received→derived→started→done；三 ACK 分立；expired 独立）
// 核心不变量：done=执行终局墓碑，单调不可逆——迟到 started/重投不降回（十九审开工首序断言）。

export type NotificationState = "received" | "derived" | "started" | "done" | "expired";

/** 三 ACK 分立（八审 P0-2 三 ACK 口径）：每类回执独立，任一≠全部收口。 */
export interface AckSet {
  readonly channelAck: boolean; // 通道回执
  readonly effectAck: boolean; // 效果回执
  readonly presentAck: boolean; // 呈现回执
}

/** 判定跃迁合法性（恢复/运行共用；返回 null=合法目标态，string=拒绝原因）。 */
export function transition(from: NotificationState, to: NotificationState): string | null {
  if (from === to) return null; // 幂等重放
  if (from === "done") return `monotonic: done is terminal, reject ${to}`; // 单调性：done 后一切降级拒
  if (from === "expired") return to === "done" ? null : `expired only closes to done (late completion), reject ${to}`;
  // received→derived→started→done 主线；expired=任意未终态可入
  const order: NotificationState[] = ["received", "derived", "started"];
  const fromIdx = order.indexOf(from);
  const toIdx = order.indexOf(to);
  if (to === "expired") return null;
  if (to === "done")
    return from === "started" || from === "derived"
      ? null
      : `received cannot jump to done (需经过派生/开栓), reject done from ${from}`;
  if (toIdx > fromIdx && toIdx - fromIdx === 1) return null; // 相邻前进
  return `cannot go ${from}→${to}`; // 禁倒退（derived→received 等）
}

/** 迟到重投守卫：done 后同 notificationId 再投（旧通知查无记录→再派生）必须被墓碑拦下，不重新执行。 */
export function lateReplayAfterDone(
  last: NotificationState,
  event: "redeliver",
): { accepted: boolean; state: NotificationState; reason?: string } {
  if (event === "redeliver") {
    if (last === "done")
      return { accepted: false, state: "done", reason: "tombstone: done 不降回不重开义务（迟到重投拒绝再派生）" };
    return { accepted: true, state: last, reason: "未终态重投=按未决恢复扫描处理" };
  }
  return { accepted: false, state: last, reason: "unknown event" };
}
