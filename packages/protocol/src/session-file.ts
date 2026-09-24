// 会话文件条目投影（对账输入面：恢复视图=磁盘直读；TECH §5.5/§5.6）
// 本包只定义对账所需投影字段，不承载完整 pi 会话格式（完整格式=宿主 SDK 面）。

/** 条目角色（对账面只需四类投影+坏行标记）。 */
export type EntryRole = "user" | "assistant" | "toolCall" | "toolResult" | "system" | "corrupt";

/** assistant 终答判据字段：stopReason∈{stop,length}（四联⓪/①）。aborted/中间行≠终答。 */
export type StopReason = "stop" | "length" | "aborted" | "toolUse" | null;

export interface SessionEntry {
  readonly entryId: string;
  readonly role: EntryRole;
  /** 文本身份（user 匹配键组件=规范化 hash；对账用）。 */
  readonly textHash: string; // 派生字段：宿主文本按 identity.normalizeText+textHash 预计算
  readonly attachmentIdentity: string; // 派生字段：附件多重集身份
  readonly stopReason?: StopReason; // 仅 assistant
  readonly toolCallId?: string; // 仅 toolCall/toolResult
  readonly corrupt?: boolean; // 坏行=截断行记最近前轮 unknown，不污染后续轮归属
}

/** 目标分支投影内该条目序（原始文件序列，禁候选内重编——十一审①）。 */
export interface IndexedEntry {
  readonly entry: SessionEntry;
  /** 原始序=同（hash+附件）组内按文件出现序的 0 基序号。 */
  readonly ordinal: number;
}

/** 四联终检 ⓪ 的文件尾形态输入=目标分支投影最后一条 entry。 */
export function fileTailSatisfiesClauseZero(last: SessionEntry): boolean {
  return last.role === "assistant" && (last.stopReason === "stop" || last.stopReason === "length");
}

/** ①意图级区间闭合：意图区间（[锚,边界) 半开右排他——下一意图锚或文件尾）内存在终答 assistant。
 * 区间限定：不得借用下一意图的终答（八审场景：A 区间内只有 ua，B 的 ab 不得为 A 作证）。 */
export function intervalClosedByFinalAnswer(entries: readonly SessionEntry[], userEntryId: string, intervalEndId: string): boolean {
  const idx = entries.findIndex((e) => e.entryId === userEntryId);
  const end = entries.findIndex((e) => e.entryId === intervalEndId);
  if (idx < 0 || end < idx) return false;
  return entries.slice(idx + 1, end + 1).some((e) => e.role === "assistant" && (e.stopReason === "stop" || e.stopReason === "length"));
}

/** ②区间全配对：区间内全部 toolCall 按 toolCallId 与 toolResult 一一配对。 */
export function intervalToolCallsPaired(entries: readonly SessionEntry[], userEntryId: string, intervalEndId: string): boolean {
  const start = entries.findIndex((e) => e.entryId === userEntryId);
  const end = entries.findIndex((e) => e.entryId === intervalEndId);
  if (start < 0 || end < start) return false;
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const e of entries.slice(start, end + 1)) {
    if (e.toolCallId === undefined) continue;
    if (e.role === "toolCall") calls.add(e.toolCallId);
    if (e.role === "toolResult") results.add(e.toolCallId);
  }
  if (calls.size === 0) return true; // 无工具轮=空配对成立
  return calls.size === results.size && [...calls].every((id) => results.has(id));
}
