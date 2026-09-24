// journal 账本行类型（TECH §5.5 交付语义分层 + §5.6 账本行 schema 扩展）
// journal=append-only+逐行 fsync，永不 rename。
/** 从 journal 行流重建意图视图（含跨历史日文件聚合：按会话身份+intentId 聚合，行序=文件序）。 */
export function replayIntents(lines, sessionId) {
    const byId = new Map();
    const enqueueOrder = [];
    for (const line of lines) {
        if (line.t === "enqueue") {
            if (line.sessionId !== sessionId)
                continue;
            byId.set(line.intentId, {
                intentId: line.intentId,
                sessionId: line.sessionId,
                generation: line.generation,
                matchKey: line.matchKey,
                payload: line.payload,
                sending: false,
                consumed: null,
                cancelled: false,
            });
            enqueueOrder.push(line.intentId);
            continue;
        }
        const rec = byId.get(line.intentId ?? "");
        if (!rec)
            continue;
        switch (line.t) {
            case "sending":
                byId.set(rec.intentId, { ...rec, sending: true });
                break;
            case "consumed":
                // 双字段：锚=历史事实保留（首行）；终点=最新行承载（扩展/重算）
                byId.set(rec.intentId, {
                    ...rec,
                    consumed: rec.consumed
                        ? { anchorEntryId: rec.consumed.anchorEntryId, intervalEnd: line.intervalEnd }
                        : { anchorEntryId: line.anchorEntryId, intervalEnd: line.intervalEnd },
                });
                break;
            case "cancelled":
                byId.set(rec.intentId, { ...rec, cancelled: true });
                break;
            default:
                break; // 终态行由对账重判，不在重放时固化
        }
    }
    return byId;
}
//# sourceMappingURL=journal.js.map