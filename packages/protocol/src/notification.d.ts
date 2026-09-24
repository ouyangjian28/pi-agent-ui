export type NotificationState = "received" | "derived" | "started" | "done" | "expired";
/** 三 ACK 分立（八审 P0-2 三 ACK 口径）：每类回执独立，任一≠全部收口。 */
export interface AckSet {
    readonly channelAck: boolean;
    readonly effectAck: boolean;
    readonly presentAck: boolean;
}
/** 判定跃迁合法性（恢复/运行共用；返回 null=合法目标态，string=拒绝原因）。 */
export declare function transition(from: NotificationState, to: NotificationState): string | null;
/** 迟到重投守卫：done 后同 notificationId 再投（旧通知查无记录→再派生）必须被墓碑拦下，不重新执行。 */
export declare function lateReplayAfterDone(last: NotificationState, event: "redeliver"): {
    accepted: boolean;
    state: NotificationState;
    reason?: string;
};
//# sourceMappingURL=notification.d.ts.map