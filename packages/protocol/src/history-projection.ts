// 3b-2a：journal JSONL → 读侧扫描行投影（纯逻辑；契约组3 事件面）。
// 职责边界：只投影「耐久历史」——完整行（末尾 \n 界）才发布；撕裂尾（无换行的残片）不判坏不发布
// （后续写入补全后经重扫 diff 自然编入）；完整但不可解析的行→journal-corrupt 占位（不丢不静默）。
// 坐标纪律（read-index B02）：locator=journal 行号（1 基字符串）；digest 由 scanDigest 对 raw 原文计算
// （宿主不得用投影后事件算摘要——投影会抹平改写差异）。
// 时间面（v1 披露）：ts=null（journal 行无统一时间戳；enqueue.payload.sentAt 的展示级映射留后续）；
// seq=0 占位——ReadIndex.append 以分配值覆盖（坐标系归索引，宿主序号不进入）。
import { sanitizeText } from "./sanitizer.ts";
import { journalLineSchemaError, type UnknownRecord } from "./journal-schema.ts";
import type { JournalLine } from "./journal.ts";
import type { ScanRow } from "./read-index.ts";

/** 预览截断上限（契约 §5.4：preview 200 代码单元）。 */
export const HISTORY_PREVIEW_LIMIT = 200;

/** 事件基底（v1 披露：ts=null；seq=0 占位——ReadIndex.append 以分配值覆盖）。
 *  3b2c-B5：按行型只投影被验证的字段——generation 仅 enqueue/response-timeout 声明且经
 *  schema 校验；其余行型（sending/engaged/…）不读 generation，即使盘面带同名字段（未验证额外
 *  字段）也恒 null——额外字段可被恢复侧忽略，但不得回流进事件（GPT 3b2b B5/N7：
 *  sending+generation:{bad:1} 曾把对象漏进 event.generation）。intentId 除 clear 外均声明且校验。 */
function evBase(gen: number | null, intentId: string | null): { seq: number; ts: number | null; generation: number | null; intentId: string | null } {
  return { seq: 0, ts: null, generation: gen, intentId };
}

/** 单行投影：合法 JournalLine→对应事件；不可解析/schema 非法/未知形状→journal-corrupt（完整行不静默丢弃）。
 *  3b2a-R5：schema 判定走 protocol 共享校验器（journalLineSchemaError，与恢复侧同一权威）——
 *  投影器不得自造宽松解析（审读 P1/P1b：坏嵌套抛 TypeError/非法字段流入事件）。 */
function projectLine(raw: string, lineNo: number): ScanRow {
  const locator = String(lineNo);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { source: "journal", locator, raw, event: { ...evBase(null, null), kind: "journal-corrupt" } };
  }
  if (parsed === null || typeof parsed !== "object" || typeof (parsed as UnknownRecord)["t"] !== "string") {
    return { source: "journal", locator, raw, event: { ...evBase(null, null), kind: "journal-corrupt" } };
  }
  if (journalLineSchemaError(parsed as UnknownRecord) !== null) {
    return { source: "journal", locator, raw, event: { ...evBase(null, null), kind: "journal-corrupt" } };
  }
  const j = parsed as JournalLine;
  switch (j.t) {
    case "enqueue":
      return { source: "journal", locator, raw, event: { ...evBase(j.generation, j.intentId), kind: "turn-enqueued", preview: sanitizeText(j.payload?.rawText ?? "", HISTORY_PREVIEW_LIMIT), ordinal: j.matchKey?.ordinal ?? 0 } };
    case "sending":
      return { source: "journal", locator, raw, event: { ...evBase(null, j.intentId), kind: "sending" } };
    case "engaged":
      return { source: "journal", locator, raw, event: { ...evBase(null, j.intentId), kind: "turn-engaged" } };
    case "consumed":
      return { source: "journal", locator, raw, event: { ...evBase(null, j.intentId), kind: "turn-consumed" } };
    case "cancelled":
      return { source: "journal", locator, raw, event: { ...evBase(null, j.intentId), kind: "turn-cancelled" } };
    case "clear":
      return { source: "journal", locator, raw, event: { ...evBase(null, null), kind: "clear", clearedCount: Array.isArray(j.cleared) ? j.cleared.length : 0 } };
    case "delivered":
      return { source: "journal", locator, raw, event: { ...evBase(null, j.intentId), kind: "verdict-delivered" } };
    case "settled":
      return { source: "journal", locator, raw, event: { ...evBase(null, j.intentId), kind: "verdict-settled" } };
    case "unknown":
      return { source: "journal", locator, raw, event: { ...evBase(null, j.intentId), kind: "verdict-unknown" } };
    case "response-timeout":
      return { source: "journal", locator, raw, event: { ...evBase(j.generation, j.intentId), kind: "response-timeout", commandId: j.commandId } };
    default:
      // 结构合法但 t 未知（未来版本行）：保守 corrupt 占位（不猜语义）。
      return { source: "journal", locator, raw, event: { ...evBase(null, null), kind: "journal-corrupt" } };
  }
}

/** journal 文本 → 扫描行。只发布完整行（含末尾 \n）；撕裂尾不发布。 */
export function journalToScanRows(text: string): ScanRow[] {
  const rows: ScanRow[] = [];
  let lineStart = 0;
  let lineNo = 0;
  for (;;) {
    const nl = text.indexOf("\n", lineStart);
    if (nl === -1) break; // 残尾（无换行）：不判坏不发布——写入中/撕裂，等补全
    lineNo += 1;
    rows.push(projectLine(text.slice(lineStart, nl), lineNo));
    lineStart = nl + 1;
  }
  return rows;
}
