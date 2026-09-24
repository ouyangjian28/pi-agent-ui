/** 条目角色（对账面只需四类投影+坏行标记）。 */
export type EntryRole = "user" | "assistant" | "toolCall" | "toolResult" | "system" | "corrupt";
/** assistant 终答判据字段：stopReason∈{stop,length}（四联⓪/①）。aborted/中间行≠终答。 */
export type StopReason = "stop" | "length" | "aborted" | "toolUse" | null;
export interface SessionEntry {
    readonly entryId: string;
    readonly role: EntryRole;
    /** 文本身份（user 匹配键组件=规范化 hash；对账用）。 */
    readonly textHash: string;
    readonly attachmentIdentity: string;
    readonly stopReason?: StopReason;
    readonly toolCallId?: string;
    readonly corrupt?: boolean;
}
/** 目标分支投影内该条目序（原始文件序列，禁候选内重编——十一审①）。 */
export interface IndexedEntry {
    readonly entry: SessionEntry;
    /** 原始序=同（hash+附件）组内按文件出现序的 0 基序号。 */
    readonly ordinal: number;
}
/** 四联终检 ⓪ 的文件尾形态输入=目标分支投影最后一条 entry。 */
export declare function fileTailSatisfiesClauseZero(last: SessionEntry): boolean;
/** ①意图级区间闭合：user entry 之后同分支存在终答 assistant。 */
export declare function intervalClosedByFinalAnswer(entries: readonly SessionEntry[], userEntryId: string): boolean;
/** ②区间全配对：区间内全部 toolCall 按 toolCallId 与 toolResult 一一配对。 */
export declare function intervalToolCallsPaired(entries: readonly SessionEntry[], userEntryId: string, intervalEndId: string): boolean;
//# sourceMappingURL=session-file.d.ts.map