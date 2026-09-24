// 会话文件条目投影（对账输入面：恢复视图=磁盘直读；TECH §5.5/§5.6）
// 本包只定义对账所需投影字段，不承载完整 pi 会话格式（完整格式=宿主 SDK 面）。
/** 四联终检 ⓪ 的文件尾形态输入=目标分支投影最后一条 entry。 */
export function fileTailSatisfiesClauseZero(last) {
    return last.role === "assistant" && (last.stopReason === "stop" || last.stopReason === "length");
}
/** ①意图级区间闭合：user entry 之后同分支存在终答 assistant。 */
export function intervalClosedByFinalAnswer(entries, userEntryId) {
    const idx = entries.findIndex((e) => e.entryId === userEntryId);
    if (idx < 0)
        return false;
    return entries.slice(idx + 1).some((e) => e.role === "assistant" && (e.stopReason === "stop" || e.stopReason === "length"));
}
/** ②区间全配对：区间内全部 toolCall 按 toolCallId 与 toolResult 一一配对。 */
export function intervalToolCallsPaired(entries, userEntryId, intervalEndId) {
    const start = entries.findIndex((e) => e.entryId === userEntryId);
    const end = entries.findIndex((e) => e.entryId === intervalEndId);
    if (start < 0 || end < start)
        return false;
    const calls = new Set();
    const results = new Set();
    for (const e of entries.slice(start, end + 1)) {
        if (e.toolCallId === undefined)
            continue;
        if (e.role === "toolCall")
            calls.add(e.toolCallId);
        if (e.role === "toolResult")
            results.add(e.toolCallId);
    }
    if (calls.size === 0)
        return true; // 无工具轮=空配对成立
    return calls.size === results.size && [...calls].every((id) => results.has(id));
}
//# sourceMappingURL=session-file.js.map