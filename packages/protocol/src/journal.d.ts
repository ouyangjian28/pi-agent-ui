import type { AttachmentId, EntryIdentity, IntentId, IntentKind, IntentMatchKey, SessionId } from "./identity.ts";
/** 附件明细（enqueue 行携带原始 hash 前缀；匹配用多重集身份由 identity.ts 派生）。 */
export interface EnqueuePayload {
    readonly kind: IntentKind;
    readonly rawText: string;
    readonly attachments: readonly AttachmentId[];
    readonly sentAt: string;
}
/** 账本行类型判别（三标记制：written→sending→stdin 首字节；自动补发唯一判据=sending 标记不存在）。 */
export type JournalLine = {
    readonly t: "enqueue";
    readonly intentId: IntentId;
    readonly sessionId: SessionId;
    readonly generation: number;
    readonly leafId: string;
    readonly matchKey: IntentMatchKey;
    readonly payload: EnqueuePayload;
} | {
    readonly t: "sending";
    readonly intentId: IntentId;
} | {
    readonly t: "engaged";
    readonly intentId: IntentId;
} | {
    readonly t: "consumed";
    readonly intentId: IntentId;
    readonly anchorEntryId: string;
    readonly intervalEnd: EntryIdentity;
} | {
    readonly t: "clear";
    readonly sessionId: SessionId;
    readonly cleared: readonly IntentId[];
} | {
    readonly t: "cancelled";
    readonly intentId: IntentId;
} | {
    readonly t: "delivered";
    readonly intentId: IntentId;
} | {
    readonly t: "settled";
    readonly intentId: IntentId;
} | {
    readonly t: "unknown";
    readonly intentId: IntentId;
    readonly reason: string;
};
/** 意图恢复视图（对账算法输入：由 journal 行重放聚合）。 */
export interface IntentRecord {
    readonly intentId: IntentId;
    readonly sessionId: SessionId;
    readonly generation: number;
    readonly matchKey: IntentMatchKey;
    readonly payload: EnqueuePayload;
    readonly sending: boolean;
    readonly consumed: ConsumedEvidence | null;
    readonly cancelled: boolean;
}
/** 消费证据（重放重建）：锚 append-only 保留，区间终点按最新重算承载。 */
export interface ConsumedEvidence {
    readonly anchorEntryId: string;
    readonly intervalEnd: EntryIdentity;
}
/** 从 journal 行流重建意图视图（含跨历史日文件聚合：按会话身份+intentId 聚合，行序=文件序）。 */
export declare function replayIntents(lines: readonly JournalLine[], sessionId: SessionId): Map<IntentId, IntentRecord>;
//# sourceMappingURL=journal.d.ts.map