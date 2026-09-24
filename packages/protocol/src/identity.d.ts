/** 意图唯一 ID（UUIDv7，服务器生成）。 */
export type IntentId = string;
/** 会话身份（宿主 session 文件身份）。 */
export type SessionId = string;
/** 文件条目身份=id+长度哈希（水位三元组用，§5.5 水位身份绑定）。 */
export interface EntryIdentity {
    readonly entryId: string;
    readonly lengthHash: string;
}
/** 意图种类：入对账面（产生 user entry）vs 不入对账（效果=状态推导，§5.5 意图两类分治）。 */
export type IntentKind = "prompt" | "steer" | "followUp" | "abort" | "takeover" | "reclaim" | "switchSession" | "queueOp";
export declare function intentEntersReconciliation(kind: IntentKind): boolean;
/** 附件身份=sha256 前 12 hex；多重集合（保重复次数，三审定界冻结）。 */
export type AttachmentId = string;
export type AttachmentMultiset = readonly AttachmentId[];
export declare function attachmentIdentity(multiset: AttachmentMultiset): string;
/** 规范化（三审冻结）：UTF-8 字节级+CRLF→LF+首尾 Unicode trim，其余字符一律不动。 */
export declare function normalizeText(text: string): string;
/** 文本 hash（意图匹配键组件之一）。M1 参考实现=同步 FNV-1a 32bit 十六进制（部署可换 sha256 前 12hex——接口不变）。 */
export declare function textHash(text: string): string;
/** 意图匹配键=规范化文本 hash+附件多重集身份+同文本序号（§5.5 对账匹配法）。 */
export interface IntentMatchKey {
    readonly textHash: string;
    readonly attachmentIdentity: string;
    /** 同文本序号：该意图在其同（hash+附件）组内按 journal 序的第几条（0 基）。 */
    readonly ordinal: number;
}
export declare function matchKeyOf(text: string, attachments: AttachmentMultiset, ordinal: number): IntentMatchKey;
/** 水位三元组=(会话身份, 文件代次, 边界 entry 身份)——文件换代/截短/边界不匹配→旧水位作废（禁猜）。 */
export interface Watermark {
    readonly sessionId: SessionId;
    readonly fileGeneration: number;
    readonly boundary: EntryIdentity;
}
/** 写权身份（问题卡/提交校验六断言的输入面，TECH §10）。 */
export interface WriteAuthority {
    readonly sessionId: SessionId;
    readonly revision: number;
    readonly writerEpoch: number;
    readonly processGeneration: number;
}
/** 命令身份：提交断线查 commandId（问题卡专测六断言之一）。 */
export type CommandId = string;
/** 通知身份（§17 接收账本；opId 分域：通知派生命令域）。 */
export type NotificationId = string;
//# sourceMappingURL=identity.d.ts.map