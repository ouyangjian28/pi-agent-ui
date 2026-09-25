// 恢复入口（切片4c）：journal 文件 → 行解析 → replayIntents 重放呈现。
// 职责边界：只读+呈现，不改写盘面（撕裂尾修复/换段授权归宿主流程：确认 bad 后按需
// truncate 修复或换新段，再对新/旧 FileDurability 实例 markRepaired/新建）。
// 效果未知判据（§169④ + journal.ts 重放语义）：
//   - sending 且无终态行（lastVerdict=null）→「写后中断，效果未知」（可能已写完整/部分帧）
//   - responseTimeoutRecorded 且无终态行 →「超时未结算，效果未知」
//   - lastVerdict==="unknown" → 上轮已判效果未知
//   - 非 sending 且无终态 →「已受理未发送」（同 matchKey 重发=幂等安全）
import { readFile } from "node:fs/promises";
import { replayIntents, type IntentId, type IntentRecord, type JournalLine, type SessionId } from "@pi-agent-ui/protocol";

/** 坏行/撕裂尾记录：raw=原始文本（撕裂尾可能是不完整 UTF-8→以 utf8 读入后含替换符，字节面由宿主另行核对）。 */
export interface BadJournalEntry {
  readonly raw: string;
  readonly error: string;
  /** 真=文件末段无换行（撕裂尾——写入中断的最常见形态）；false=完整行但不可解析。 */
  readonly partialTail: boolean;
}

export interface JournalReadResult {
  /** 完整且可解析的行（按盘面顺序）。 */
  readonly lines: JournalLine[];
  readonly bad: readonly BadJournalEntry[];
}

/** 读 journal 文件并逐行解析：末段无换行=撕裂尾；JSON 解析失败/非对象/无 t 字段=坏行。 */
export async function readJournalFile(path: string): Promise<JournalReadResult> {
  const raw = await readFile(path, "utf8");
  const lines: JournalLine[] = [];
  const bad: BadJournalEntry[] = [];
  const segments = raw.split("\n");
  const lastIdx = segments.length - 1;
  segments.forEach((seg, i) => {
    if (i === lastIdx) {
      if (seg !== "") bad.push({ raw: seg, error: "文件末段无换行（撕裂尾：写入中断，效果未知）", partialTail: true });
      return; // 末段空=文件以 \n 正常收尾
    }
    if (seg === "") return; // 空行（理论不该有）：跳过不判坏（保守呈现，不阻断恢复）
    try {
      const parsed: unknown = JSON.parse(seg);
      if (parsed === null || typeof parsed !== "object" || typeof (parsed as { t?: unknown }).t !== "string") {
        bad.push({ raw: seg, error: "行可解析但非 journal 行（无 t 字段）", partialTail: false });
        return;
      }
      lines.push(parsed as JournalLine);
    } catch (e) {
      bad.push({ raw: seg, error: `JSON 解析失败：${String(e)}`, partialTail: false });
    }
  });
  return { lines, bad };
}

/** 重放呈现报告（按 enqueue 顺序）。 */
export interface RecoverReport {
  readonly intents: readonly IntentRecord[];
  /** 效果未知（须保守呈现/人工裁决；含 sending 无终态、超时未结算、已判 unknown）。 */
  readonly unknownEffect: readonly IntentId[];
  /** 已受理未发送（同 matchKey 重发=幂等安全；cancelled 不在内——取消是终局，重发违背用户意图）。 */
  readonly resumable: readonly IntentId[];
  readonly settledCount: number;
}

/** 由重放记录判定效果未知（sending 无终态/超时未结算/已判 unknown）。 */
function isUnknownEffect(rec: IntentRecord): boolean {
  if (rec.lastVerdict === "unknown") return true;
  if (rec.lastVerdict !== null) return false; // settled/delivered=有终态
  return rec.sending || rec.responseTimeoutRecorded === true;
}

export function buildRecoverReport(lines: readonly JournalLine[], sessionId: SessionId): RecoverReport {
  const map = replayIntents(lines, sessionId);
  const intents = [...map.values()];
  return {
    intents,
    unknownEffect: intents.filter(isUnknownEffect).map((r) => r.intentId),
    resumable: intents
      .filter((r) => !r.sending && r.lastVerdict === null && !r.responseTimeoutRecorded && !r.cancelled)
      .map((r) => r.intentId),
    settledCount: intents.filter((r) => r.lastVerdict === "settled").length,
  };
}

/** 恢复全流程：读文件+解析+重放呈现（不改盘面；坏行/撕裂尾随报告交宿主裁决）。 */
export async function recoverFromJournal(path: string, sessionId: SessionId): Promise<JournalReadResult & RecoverReport> {
  const { lines, bad } = await readJournalFile(path);
  const report = buildRecoverReport(lines, sessionId);
  return { lines, bad, ...report };
}
