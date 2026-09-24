// 通知状态机+终态单调性（TECH §17 接收账本：received→derived→started→done；三 ACK 分立；expired 独立）
// 开工轮一审 A1 修正（2026-09-24）：
// - done≠「执行终局墓碑」——done=**通知义务收口**，成因恰两种：三 ACK 齐（通道送达/用户阅读/agent 受理）或 expired（到期证据驱动）。
// - transition()=形状+单调检查器；收口裁决入口=closeWithAcks()/expireWithEvidence()（不看 ACK/到期证据不得出 done）。
// - expired=独立终态（超时收口）：expired 后迟到 ACK 不升 done（超时收口即终局，禁「晚到完成」口径）。

export type NotificationState = "received" | "derived" | "started" | "done" | "expired";

/** 三 ACK 分立（八审 P0-2 三 ACK 口径）：每类回执独立，任一≠全部收口；执行终局（轮完成）不替代任何一类。 */
export interface AckSet {
  readonly channelAck: boolean; // 通道回执（设备送达）
  readonly presentAck: boolean; // 呈现回执（用户阅读）
  readonly effectAck: boolean; // 效果回执（agent 受理）
}

export interface CloseVerdict {
  readonly state: NotificationState;
  readonly closed: boolean;
  readonly reason: string;
}

/** done 成因（两域口径，二审 R2-06）：acks=三 ACK 齐收口；expired=到期收口映射账本域 done(reason=expired)。 */
export type DoneReason = "acks" | "expired";

/** 接收账本域终态（二审 R2-06 两域拆分：outbox 域 expired 回执→账本域记 done(reason=expired)；迟到 ACK 不改到期原因）。 */
export function accountDomainClose(
  state: NotificationState,
  doneReason: DoneReason,
  lateAck: AckSet | null,
): CloseVerdict {
  if (state === "done")
    return {
      state,
      closed: false,
      reason: `terminal: done(reason 已定)——迟到 ACK（channel=${lateAck?.channelAck} present=${lateAck?.presentAck} effect=${lateAck?.effectAck}）不改成因`,
    };
  if (doneReason !== "expired") return { state, closed: false, reason: "非到期回执不映射账本域" };
  if (state !== "expired") return { state, closed: false, reason: `无 expired 回执（现态 ${state}）不映射` };
  return { state: "done", closed: true, reason: "outbox expired 回执→账本域 done(reason=expired)" };
}

/** 三 ACK 收口裁决（二审 R2-06：derived 与 started 均可收口——三 ACK 齐即 done；received 未派生无收口面；执行终局不替代 ACK）。 */
export function closeWithAcks(state: NotificationState, acks: AckSet): CloseVerdict {
  if (state === "done" || state === "expired")
    return { state, closed: false, reason: `terminal: ${state} 已收口（单调，迟到 ACK 不改写）` };
  if (state === "received")
    return { state, closed: false, reason: "未派生（received）无收口面：done 需 derived/started 后三 ACK 齐" };
  const all = acks.channelAck && acks.presentAck && acks.effectAck;
  if (!all)
    return {
      state,
      closed: false,
      reason: `三 ACK 未齐（channel=${acks.channelAck} present=${acks.presentAck} effect=${acks.effectAck}）——任一缺失不收口`,
    };
  return { state: "done", closed: true, reason: "三 ACK 齐（通道送达+用户阅读+agent 受理）→通知义务收口 done" };
}

/** 到期收口裁决：deadline 到期证据驱动（独立终态 expired）；执行侧完成不触发 expired。 */
export function expireWithEvidence(state: NotificationState, deadlinePassed: boolean): CloseVerdict {
  if (state === "done" || state === "expired")
    return { state, closed: false, reason: `terminal: ${state} 已收口（单调）` };
  if (!deadlinePassed) return { state, closed: false, reason: "无到期证据（deadline 未过）——不收口" };
  return { state: "expired", closed: true, reason: "到期证据成立→超时收口 expired（义务关闭，不再等 ACK）" };
}

/** 判定跃迁合法性（恢复/运行共用；返回 null=合法目标态，string=拒绝原因）。 */
export function transition(from: NotificationState, to: NotificationState): string | null {
  if (from === to) return null; // 幂等重放
  if (from === "done") return `monotonic: done 已收口（三 ACK 或 expired 成因），拒 ${to}`; // done 后迟到 started/一切降级拒
  if (from === "expired") return `monotonic: expired 已收口（超时终局），拒 ${to}（迟到 ACK 不升 done）`;
  // received→derived→started 主线；expired=未终态可入（经 expireWithEvidence 裁决后落）
  const order: NotificationState[] = ["received", "derived", "started"];
  const fromIdx = order.indexOf(from);
  const toIdx = order.indexOf(to);
  if (to === "expired") return null;
  if (to === "done")
    return from === "started" || from === "derived"
      ? null // 正常收口路径（R2-06：derived/started 均可经 closeWithAcks 三 ACK 齐收口；expired 经 accountDomainClose 映射）
      : `${from} 不得直接 done：收口=derived/started 三 ACK 齐（closeWithAcks）或到期（expireWithEvidence+accountDomainClose）`;
  if (toIdx > fromIdx && toIdx - fromIdx === 1) return null; // 相邻前进
  return `cannot go ${from}→${to}`; // 禁倒退（derived→received 等）+禁跳跃（received→started）
}

/** 迟到重投守卫：done/expired 后同 notificationId 再投必须被终态拦下，不重新执行、不再派生。 */
export function lateReplayAfterDone(
  last: NotificationState,
  event: "redeliver",
): { accepted: boolean; state: NotificationState; reason?: string } {
  if (event === "redeliver") {
    if (last === "done")
      return { accepted: false, state: "done", reason: "tombstone: done 已收口（迟到重投拒绝再派生）" };
    if (last === "expired")
      return { accepted: false, state: "expired", reason: "tombstone: expired 已收口（迟到重投拒绝再派生）" };
    return { accepted: true, state: last, reason: "未终态重投=按未决恢复扫描处理" };
  }
  return { accepted: false, state: last, reason: "unknown event" };
}
