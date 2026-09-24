import type { EntryIdentity, IntentId } from "./identity.ts";
import type { IntentRecord, JournalLine } from "./journal.ts";
import { type SessionEntry } from "./session-file.ts";
export interface RecoveryInput {
    /** E：目标分支投影（自水位边界起，原始文件序）。 */
    readonly entries: readonly SessionEntry[];
    /** J：未决意图（水位后，按 journal 序）。 */
    readonly intents: readonly IntentRecord[];
    /** P：永久排除集（GC 转储的已消费区间 entryId）。 */
    readonly permanentExclusions: ReadonlySet<string>;
    /** 进程活着（true=运行中对账：sending=在飞等；false=恢复对账：可出终裁）。 */
    readonly alive: boolean;
}
export type VerdictState = "delivered" | "unknown" | "inflight" | "cancelled" | "pendingGate";
export interface IntentVerdict {
    readonly intentId: IntentId;
    readonly state: VerdictState;
    readonly reason?: string;
}
export interface RecoveryOutput {
    readonly verdicts: readonly IntentVerdict[];
    /** 需随账本 fsync 的新 consumed 行（第一遍产出；十八审①：歧义禁落耐久锚）。 */
    readonly newConsumed: readonly JournalLine[];
    /** 直接后继终态时的水位推进目标（逐意图推进禁跳跃；cancelled 跳过）。 */
    readonly watermarkAdvanceTo: EntryIdentity | null;
}
export declare function runRecovery(input: RecoveryInput): RecoveryOutput;
//# sourceMappingURL=recovery.d.ts.map