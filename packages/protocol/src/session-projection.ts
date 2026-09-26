// 3b-2b①：session JSONL → 读侧扫描行投影（纯逻辑；契约 §3.5 C3-R04 修订）。
// 职责边界：只投影「耐久历史」——完整行（末尾 \n 界）才发布；撕裂尾（无换行残片）不判坏不发布
// （后续写入补全后经重扫 diff 自然编入，与 journal 投影同口径）。
// 行分类三分：`type:"message"` 且形状合法→消息事件（可多事件：toolCall 块分立）；JSON 不可解析/
// 非对象/缺 id/角色非法→corrupt-entry 占位（entryId=`corrupt-<byteOffset>`，不丢不静默）；
// 可解析但非 message 行（session header/model_change/thinking_level_change/custom…）→unknown-line。
// 坐标纪律（read-index B02）：locator=行首字节偏移（十进制字符串，稳定身份——插入行不漂移后续锚）；
// digest 由 scanDigest 对 raw 原文计算（投影不得抹平改写差异）。同一行可产多事件（消息本体+toolCall
// 块）——同 locator 多行确定性有序（本体先、块按序），重扫可精确复现。
// 归因两面：user=三元组匹配 journal enqueue（matchKeyOf 同构：textHash(normalizeText)+
// attachmentIdentity(非 text/thinking 块派生 AttachmentId 多重集)+文件内同键 0 基序号 ordinal，
// 按序消费第 n 条同键 user↔第 n 条同键 enqueue）；assistant/toolResult/system=attributeSessionEntries
// 区间（consumed 数组 journal 行序前置条件由宿主保证）。user 匹配未中时回退区间归因（锚在区间内
// ——「从锚向后含两端」语义覆盖 user 锚自身），此时 generation=null（consumed 行不声明 generation）。
// 孤儿 toolResult（无 toolCallId）→intentId:null（契约）。
// final 逐项映射=契约冻结表（stop/length/aborted→true；toolUse→false；user→true；toolCall→false）
// +实现方补全未列举角色（toolResult→false 等待续答；system→true 独立完整——PROJECT 冻结案标注待 GPT 确认）。
// 时间面（v1 披露，与 journal 投影一致）：ts=null（message.timestamp 展示级映射留后续）；
// seq=0 占位——ReadIndex.append 以分配值覆盖。lengthHash 派生=fnv1a64Hex(raw 行)
// （写侧 journal consumed intervalEnd 须同构——跨侧派生冻结点，待 GPT 确认）。
import { fnv1a64Hex, sanitizeText } from "./sanitizer.ts";
import { attributeSessionEntries, type ConsumedInterval } from "./session-attribution.ts";
import type { ScanRow } from "./read-index.ts";
import type { HistoryEvent, SanitizedText } from "./contracts.ts";
import { attachmentIdentity, normalizeText, textHash, type AttachmentMultiset, type IntentMatchKey } from "./identity.ts";
import { journalLineSchemaError, type UnknownRecord } from "./journal-schema.ts";
import { sha256Hex12 } from "./sha256.ts";

/** 消息预览截断上限（契约 §5.4：preview 200 代码单元——与 journal 面同一预算）。 */
export const SESSION_PREVIEW_LIMIT = 200;

/** journal enqueue 行投影引用（宿主从 journal 扫描行派生；journal 行序）。 */
export interface SessionEnqueueRef {
  readonly intentId: string;
  readonly generation: number | null;
  readonly matchKey: IntentMatchKey;
}

export interface SessionProjectionInput {
  readonly sessionText: string;
  /** journal enqueue 序列（journal 行序——宿主保证，不得反转）。 */
  readonly enqueues: readonly SessionEnqueueRef[];
  /** consumed 区间（journal 行序——宿主保证）。 */
  readonly consumed: readonly ConsumedInterval[];
}

/** 消息行形状校验后的最小投影（内部中间结构）。 */
interface MessageEntry {
  readonly entryId: string;
  readonly role: "user" | "assistant" | "toolResult" | "system";
  readonly content: readonly Block[];
  readonly stopReason: "stop" | "length" | "aborted" | "toolUse" | null;
  readonly toolCallId: string | null;
  readonly raw: string;
  readonly offset: number;
}

type Block =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "toolCall"; readonly toolCallId: string | null }
  | { readonly kind: "attachment"; readonly id: string };

const MESSAGE_ROLES = new Set(["user", "assistant", "toolResult", "system"]);
const STOP_REASONS = new Set(["stop", "length", "aborted", "toolUse"]);

/** 附件块 AttachmentId 派生（3b2b-R4：与写侧 canon 统一=identity.ts 三审冻结
 *  「每附件 SHA-256 前 12hex、多重集保重复」）：
 *  ①有 data 字符串（真实图片块 {type:'image',data:base64,mimeType}）→sha256(data) 前 12hex
 *    （写侧对同一 base64 数据同法派生——冻结点，不含 mimeType：同一数据不因字段杂音分身）；
 *  ②有 id 或 url 的具名块→sha256(type\nid\nurl) 前 12hex；
 *  ③无可证明身份的未知块→"u:"+fnv1a64(键序规范化 JSON)——确定性（同内容同 id，多重集语义成立），
 *    且恒不与写侧 12hex 面相交（不可匹配：含未知块的多重集永不会等于写侧身份）。 */
function attachmentIdOfBlock(type: string, block: Record<string, unknown>): string {
  const data = typeof block["data"] === "string" ? block["data"] : null;
  if (data !== null) return sha256Hex12(data);
  const id = typeof block["id"] === "string" ? block["id"] : null;
  const url = typeof block["url"] === "string" ? block["url"] : null;
  if (id !== null || url !== null) return sha256Hex12(`${type}\n${id ?? ""}\n${url ?? ""}`);
  return `u:${fnv1a64Hex(canonicalJson(block))}`;
}

/** 键序规范化 JSON（未知块确定性序列化：与宿主写入键序无关）。 */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    const keys = Object.keys(v as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** content 归一为块数组：字符串=单 text 块；数组=逐块投影（text→text；toolCall→toolCall；
 *  thinking 不投影；其余对象块→attachment（user 附图/未知媒体——附件身份源）；非对象元素忽略）。 */
function blocksOf(content: unknown): Block[] {
  if (typeof content === "string") return [{ kind: "text", text: content }];
  if (!Array.isArray(content)) return [];
  const out: Block[] = [];
  for (const c of content) {
    if (typeof c !== "object" || c === null) continue;
    const r = c as Record<string, unknown>;
    const t = typeof r["type"] === "string" ? r["type"] : "";
    if (t === "text") out.push({ kind: "text", text: typeof r["text"] === "string" ? r["text"] : "" });
    else if (t === "toolCall") out.push({ kind: "toolCall", toolCallId: typeof r["id"] === "string" ? r["id"] : null });
    else if (t === "thinking") continue;
    else out.push({ kind: "attachment", id: attachmentIdOfBlock(t, r) });
  }
  return out;
}

/** 单行解析：message 行→MessageEntry；非 message 行→"not-message"（占位分支归 unknown-line）；
 *  自称 message 但形状非法（缺 id/角色非法/缺 message 体）→"bad-shape"（归 corrupt-entry——
 *  契约口径：message 声明在而身份不可用=坏行，不是未知行）。 */
function parseMessageLine(raw: string, offset: number): MessageEntry | "not-message" | "bad-shape" {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "bad-shape"; // JSON 不可解析→corrupt
  }
  if (typeof parsed !== "object" || parsed === null) return "bad-shape";
  const line = parsed as Record<string, unknown>;
  if (line["type"] !== "message") return "not-message";
  const id = line["id"];
  if (typeof id !== "string" || id === "") return "bad-shape"; // 缺条目身份=形状非法
  const m = line["message"];
  if (typeof m !== "object" || m === null) return "bad-shape";
  const msg = m as Record<string, unknown>;
  const role = msg["role"];
  if (typeof role !== "string" || !MESSAGE_ROLES.has(role)) return "bad-shape";
  const srRaw = msg["stopReason"];
  const stopReason = typeof srRaw === "string" && STOP_REASONS.has(srRaw)
    ? (srRaw as "stop" | "length" | "aborted" | "toolUse")
    : null;
  const tcRaw = msg["toolCallId"];
  const toolCallId = typeof tcRaw === "string" && tcRaw !== "" ? tcRaw : null;
  return { entryId: id, role: role as MessageEntry["role"], content: blocksOf(msg["content"]), stopReason, toolCallId, raw, offset };
}

/** final 逐项映射（契约 §3.5 冻结表+两角色补全——见文件头）。 */
function finalOf(role: MessageEntry["role"], stopReason: MessageEntry["stopReason"]): boolean {
  if (stopReason === "stop" || stopReason === "length" || stopReason === "aborted") return true;
  if (stopReason === "toolUse") return false;
  switch (role) {
    case "user": return true;
    case "assistant": return false; // 无 stopReason 的 assistant=未完结（流中）
    case "toolResult": return false;
    case "system": return true;
  }
}

function textBlocksOf(blocks: readonly Block[]): string {
  return blocks.filter((b): b is Extract<Block, { kind: "text" }> => b.kind === "text").map((b) => b.text).join("\n");
}

/** user 三元组匹配（全量单趟）：文件内同（textHash+attachmentIdentity）组 0 基序号→与 enqueue
 *  matchKey 逐字段全等→按序消费（第 n 条同键 user↔第 n 条同键 enqueue——与 journal 侧 ordinal 同构）。
 *  返回 entryId→enqueue 引用（未匹配的 user 不入表）。 */
function matchUserIntents(
  entries: readonly MessageEntry[],
  enqueues: readonly SessionEnqueueRef[],
): Map<string, SessionEnqueueRef> {
  const out = new Map<string, SessionEnqueueRef>();
  const seen = new Map<string, number>(); // textHash+"\u0000"+attachmentIdentity → 组内已见条数
  for (const e of entries) {
    if (e.role !== "user") continue;
    const th = textHash(normalizeText(textBlocksOf(e.content)));
    const at: AttachmentMultiset = e.content
      .filter((b): b is Extract<Block, { kind: "attachment" }> => b.kind === "attachment")
      .map((b) => b.id);
    const ai = attachmentIdentity(at);
    const key = `${th}\u0000${ai}`;
    const ordinal = seen.get(key) ?? 0;
    seen.set(key, ordinal + 1);
    const hit = enqueues.find((q) => q.matchKey.textHash === th && q.matchKey.attachmentIdentity === ai && q.matchKey.ordinal === ordinal);
    if (hit !== undefined && !out.has(e.entryId)) out.set(e.entryId, hit); // 重复 id=宿主数据错，首见为准（与区间面一致）
  }
  return out;
}

/** journal 文本 → 归因输入（3b-2b②）：从完整 journal 行提取 enqueue 三元组与 consumed 区间，
 *  供 session 投影归因（DualHistorySource 在 session 扫描时从 journal 盘面现读派生——
 *  完整行前缀即耐久事实，撕裂尾不参与，与两源各自行边界纪律一致）。不可解析/非法行忽略
 *  （归因缺证→session 条目 intentId=null，不猜测）。 */
/** 3b2b-R3（GPT 3b-2b 审读）：归因采信与正式投影同一行 schema 纪律——enqueue/consumed 行
 *  先经 journalLineSchemaError 判合法才提取；判坏的行跳过并计数（不猜：缺字段/非法
 *  generation/坏嵌套的行在 events 投影里是 journal-corrupt，归因同样不得采信——两读侧
 *  不得一面判坏一面采信）。非 JSON 行/其他行型不属归因面，不计入 rejected。
 *  返回 rejected=被拒的 enqueue/consumed 行数（调用方审计；撕裂尾不计——本就不参与）。 */
export function journalAttributionOf(text: string): { enqueues: readonly SessionEnqueueRef[]; consumed: readonly ConsumedInterval[]; rejected: number } {
  const enqueues: SessionEnqueueRef[] = [];
  const consumed: ConsumedInterval[] = [];
  let rejected = 0;
  const segments = text.split("\n");
  const complete = text.length === 0 ? 0 : segments.length - 1; // 完整行界：末段无 \n=撕裂尾不参与（同 sessionToScanRows 口径）
  for (let i = 0; i < complete; i++) {
    const raw = segments[i] ?? "";
    if (raw === "") continue;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { continue; }
    if (typeof parsed !== "object" || parsed === null) continue;
    const r = parsed as UnknownRecord;
    if (r["t"] !== "enqueue" && r["t"] !== "consumed") continue;
    if (journalLineSchemaError(r) !== null) { rejected += 1; continue; } // 坏行不采信（同正式投影判坏口径）
    if (r["t"] === "enqueue") {
      const mk = r["matchKey"] as UnknownRecord;
      enqueues.push({
        intentId: r["intentId"] as string,
        generation: r["generation"] as number,
        matchKey: { textHash: mk["textHash"] as string, attachmentIdentity: mk["attachmentIdentity"] as string, ordinal: mk["ordinal"] as number },
      });
    } else {
      const end = r["intervalEnd"] as UnknownRecord;
      consumed.push({ intentId: r["intentId"] as string, anchorEntryId: r["anchorEntryId"] as string, intervalEnd: { entryId: end["entryId"] as string, lengthHash: end["lengthHash"] as string } });
    }
  }
  return { enqueues, consumed, rejected };
}

/** session 文本 → 扫描行。只发布完整行；撕裂尾不发布（与 journalToScanRows 同口径）。 */
export function sessionToScanRows(input: SessionProjectionInput): ScanRow[] {
  const text = input.sessionText;
  const lines = text.split("\n");
  // 行数口径：空文本=0 行；否则 split 尾元素恒弃（末尾带 \n 时为空artifact；不带时为撕裂尾不发布）。
  const complete = text.length === 0 ? 0 : lines.length - 1;

  // 1. 行走（字节偏移 locator；前缀偏移预计算）
  const messages: MessageEntry[] = [];
  const lineRaw: string[] = [];
  const lineOffsets: number[] = [];
  const msgByLine: (MessageEntry | "not-message" | "bad-shape" | undefined)[] = [];
  let offset = 0;
  for (let i = 0; i < complete; i++) {
    const raw = lines[i] ?? "";
    lineRaw.push(raw);
    lineOffsets.push(offset);
    const parsed = parseMessageLine(raw, offset);
    msgByLine.push(parsed);
    if (typeof parsed === "object") messages.push(parsed);
    offset += Buffer.byteLength(raw, "utf8") + 1; // +1=换行符
  }

  // 2. 归因：区间面（attributeSessionEntries）+user 三元组面（优先，未中回退区间=锚自身在区间内）
  const refs = messages.map((m) => ({ entryId: m.entryId, lengthHash: fnv1a64Hex(m.raw), kind: m.role }));
  const intervalAttr = new Map(attributeSessionEntries({ consumed: input.consumed, entries: refs }).map((a) => [a.entryId, a.intentId]));
  const userMatch = matchUserIntents(messages, input.enqueues);

  // 3. 事件投影（编入序=文件行序；message 本体先、toolCall 块按序分立；占位行按偏移归位）
  const rows: ScanRow[] = [];
  for (let i = 0; i < complete; i++) {
    const raw = lineRaw[i] ?? "";
    const locator = String(lineOffsets[i] ?? 0);
    const msg = msgByLine[i];
    if (typeof msg === "object" && msg !== undefined) {
      const um = userMatch.get(msg.entryId);
      const intentId = msg.role === "user"
        ? (um !== undefined ? um.intentId : intervalAttr.get(msg.entryId) ?? null)
        : msg.role === "toolResult" && msg.toolCallId === null ? null
        : intervalAttr.get(msg.entryId) ?? null;
      const generation = um !== undefined ? um.generation : null;
      const base = { seq: 0, ts: null as number | null, generation, intentId };
      const preview = textBlocksOf(msg.content);
      // 3b2b-R6：stopReason=length 的正文被模型截断——textPreview.truncated 合并真实
      //（即便预览未达限也置位；契约 §3.5「length 加 textPreview.truncated」）；
      // 无正文时仍发 {text:"",truncated:true} 占位以保留截断信号。非 length 不改写。
      let pv: SanitizedText | undefined = preview.length > 0 ? sanitizeText(preview, SESSION_PREVIEW_LIMIT) : undefined;
      if (msg.stopReason === "length") {
        pv = { text: pv !== undefined ? pv.text : "", truncated: true };
      }
      rows.push({
        source: "session" as const, locator, raw,
        event: { ...base, kind: "message" as const, entryId: msg.entryId, role: msg.role,
          ...(pv !== undefined ? { textPreview: pv } : {}),
          ...(msg.stopReason !== null ? { stopReason: msg.stopReason } : {}),
          ...(msg.toolCallId !== null ? { toolCallId: msg.toolCallId } : {}),
          final: finalOf(msg.role, msg.stopReason) } satisfies HistoryEvent,
      });
      let tcIndex = 0;
      for (const b of msg.content) {
        if (b.kind !== "toolCall") continue;
        rows.push({
          source: "session" as const, locator, raw,
          event: { ...base, kind: "message" as const, entryId: msg.entryId, blockIndex: tcIndex, role: "toolCall" as const,
            ...(b.toolCallId !== null ? { toolCallId: b.toolCallId } : {}), final: false } satisfies HistoryEvent,
        });
        tcIndex += 1;
      }
    } else {
      const unknown = msg === "not-message";
      rows.push({
        source: "session" as const, locator, raw,
        event: unknown
          ? { seq: 0, ts: null, generation: null, intentId: null, kind: "unknown-line" as const } satisfies HistoryEvent
          : { seq: 0, ts: null, generation: null, intentId: null, kind: "corrupt-entry" as const, entryId: `corrupt-${locator}` } satisfies HistoryEvent,
      });
    }
  }
  return rows;
}
