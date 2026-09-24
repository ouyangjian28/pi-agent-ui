// 身份类型（TECH §5.5 匹配法/§5.6 账本 schema）
// 规格语义权威=TECH.md；本包=可执行实现载体。
export function intentEntersReconciliation(kind) {
    return kind === "prompt" || kind === "steer" || kind === "followUp";
}
export function attachmentIdentity(multiset) {
    // 多重集合序列化身份：排序后拼接（保重复；集合相等=多重集合相等）
    return [...multiset].sort().join(",");
}
/** 规范化（三审冻结）：UTF-8 字节级+CRLF→LF+首尾 Unicode trim，其余字符一律不动。 */
export function normalizeText(text) {
    return text.replace(/\r\n/g, "\n").replace(/^[\s\uFEFF\xA0]+|[\s\uFEFF\xA0]+$/gu, "");
}
/** 文本 hash（意图匹配键组件之一）。M1 参考实现=同步 FNV-1a 32bit 十六进制（部署可换 sha256 前 12hex——接口不变）。 */
export function textHash(text) {
    let h = 0x811c9dc5;
    for (const b of Buffer.from(text, "utf8")) {
        h ^= b;
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
}
export function matchKeyOf(text, attachments, ordinal) {
    return { textHash: textHash(normalizeText(text)), attachmentIdentity: attachmentIdentity(attachments), ordinal };
}
//# sourceMappingURL=identity.js.map