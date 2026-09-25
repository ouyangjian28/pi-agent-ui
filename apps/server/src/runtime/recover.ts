// 恢复入口（切片4c）：journal 文件 → 行解析 → replayIntents 重放呈现。
// 职责边界：只读+呈现，不改写盘面（撕裂尾修复/换段授权归宿主流程：确认 bad 后按需
// truncate 修复或换新段，再对新/旧 FileDurability 实例 markRepaired/新建）。
// 效果未知判据（§169④ + journal.ts 重放语义）：
//   - sending 且无终态行（lastVerdict=null）→「写后中断，效果未知」（可能已写完整/部分帧）
//   - responseTimeoutRecorded 且无终态行 →「超时未结算，效果未知」
//   - lastVerdict==="unknown" → 上轮已判效果未知
//   - 非 sending 且无终态 →「已受理未发送」（同 matchKey 重发=幂等安全；仅当无坏行时才输出——见 blocked）
// 损坏阻断（s4e R1）：存在未裁决坏行（含撕裂尾）时 blocked=true、resumable 恒空——
//   「识别了坏尾」不等于「已处理坏尾对判据的影响」：被剔除的残片可能已承载 sending，
//   证据不存在不能重新解释为「从未发送」。宿主先修复盘面（截尾/换段+重读）再获得恢复授权。
// 输入前提（s4e 第四节）：journal 文件与会话一一对应（RpcSession 每会话一 journalPath）；
//   非 enqueue 行不携会话身份，跨会话同 intentId 的终态行会越界结算——本前提由组装层保证。
// 范围口径（s4e 第五节）：本入口覆盖「子进程重启」面（同 RpcSession 重组装）；
//   完整服务重启（内存 intentSeq/ordinal 丢失+新对象续写旧 journal）会重复分配 i-1 身份，
//   需身份恢复或持久唯一 ID（后续切片，未支持）。
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

type UnknownRecord = Record<string, unknown>;

/** 行型必需字段 schema（s4e R2）：JSON 可解析≠有效 JournalLine；缺字段/错类型/未知行型一律拒收进 bad，不得进入 replayIntents。 */
function lineSchemaError(obj: UnknownRecord): string | null {
  const t = obj["t"];
  const str = (k: string): string | null => (typeof obj[k] === "string" ? null : `缺字段/错类型 ${k}`);
  const num = (k: string): string | null => (typeof obj[k] === "number" ? null : `缺字段/错类型 ${k}`);
  switch (t) {
    case "enqueue": {
      for (const k of ["intentId", "sessionId", "leafId"] as const) if (str(k)) return str(k);
      if (num("generation")) return num("generation");
      if (obj["matchKey"] === null || typeof obj["matchKey"] !== "object") return "缺字段/错类型 matchKey";
      const p = obj["payload"];
      if (p === null || typeof p !== "object") return "缺字段/错类型 payload";
      return null;
    }
    case "sending":
    case "engaged":
    case "cancelled":
    case "delivered":
    case "settled":
      return str("intentId");
    case "consumed":
      return str("intentId") ?? str("anchorEntryId") ?? (obj["intervalEnd"] !== null && typeof obj["intervalEnd"] === "object" ? null : "缺字段/错类型 intervalEnd");
    case "clear":
      return str("sessionId") ?? (Array.isArray(obj["cleared"]) ? null : "缺字段/错类型 cleared");
    case "unknown":
      return str("intentId") ?? str("reason");
    case "response-timeout":
      return str("intentId") ?? num("generation") ?? num("commandId");
    default:
      return `未知行型 ${String(t)}`;
  }
}

/** 读 journal 文件并逐行解析：末段无换行=撕裂尾；JSON 解析失败/非对象/schema 损坏=坏行。 */
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
      if (parsed === null || typeof parsed !== "object" || typeof (parsed as UnknownRecord)["t"] !== "string") {
        bad.push({ raw: seg, error: "行可解析但非 journal 行（无 t 字段）", partialTail: false });
        return;
      }
      const schemaErr = lineSchemaError(parsed as UnknownRecord);
      if (schemaErr !== null) {
        bad.push({ raw: seg, error: `schema 损坏：${schemaErr}`, partialTail: false });
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
  /** 效果未知（须保守呈现/人工裁决；含 sending 无终态、超时未结算、已判 unknown、取消前已发送）。 */
  readonly unknownEffect: readonly IntentId[];
  /** 已受理未发送（同 matchKey 重发=幂等安全；cancelled 不在内——取消是终局，重发违背用户意图）。**blocked=true 时恒空：先修复盘面再谈权限**。 */
  readonly resumable: readonly IntentId[];
  readonly settledCount: number;
  /** 存在未裁决坏行（撕裂尾/schema 损坏）：恢复授权阻断——宿主先修复（截尾/换段+重读）再获得可执行结论。 */
  readonly blocked: boolean;
}

/** 由重放记录判定效果未知（sending 无终态/超时未结算/已判 unknown；取消不改副作用未知呈现——cancelled 挡 resumable，sending 照旧触发 unknown）。 */
function isUnknownEffect(rec: IntentRecord): boolean {
  if (rec.lastVerdict === "unknown") return true;
  if (rec.lastVerdict !== null) return false; // settled/delivered=有终态
  return rec.sending || rec.responseTimeoutRecorded === true;
}

/** 从坏行残片保守提取 sending 证据：能可靠关联意图→并入 unknownEffect（R1：证据不存在≠从未发送）。 */
function sendingFragmentIds(bad: readonly BadJournalEntry[]): Set<IntentId> {
  const ids = new Set<IntentId>();
  for (const b of bad) {
    if (!/"t"\s*:\s*"sending"/.test(b.raw)) continue;
    const m = b.raw.match(/"intentId"\s*:\s*"([^"]+)"/);
    if (m !== null) ids.add(m[1] as IntentId);
  }
  return ids;
}

/** 修复后续读选项：fragments=修复前盘面的坏行/残片（保守证据保留——不能把「证据不存在」解释为「从未发送」）；blocked=当前盘面阻断态（默认=有 fragments 即阻断；修复后续读显式传 false）。 */
export interface RecoverOptions {
  readonly fragments?: readonly BadJournalEntry[];
  readonly blocked?: boolean;
}

export function buildRecoverReport(lines: readonly JournalLine[], sessionId: SessionId, opts: RecoverOptions = {}): RecoverReport {
  const fragments = opts.fragments ?? [];
  const blocked = opts.blocked ?? fragments.length > 0;
  const map = replayIntents(lines, sessionId);
  const intents = [...map.values()];
  const unknown = new Set(intents.filter(isUnknownEffect).map((r) => r.intentId));
  for (const id of sendingFragmentIds(fragments)) {
    if (map.has(id)) unknown.add(id); // 只并入已知意图（未知 id 无呈现面；blocked 已全局阻断）
  }
  return {
    intents,
    unknownEffect: intents.filter((r) => unknown.has(r.intentId)).map((r) => r.intentId),
    resumable: blocked
      ? [] // R1：有未裁决坏行→不给任何重发授权
      : intents
          .filter((r) => !unknown.has(r.intentId) && !r.sending && r.lastVerdict === null && !r.responseTimeoutRecorded && !r.cancelled)
          .map((r) => r.intentId), // 残片并入 unknown 的意图同样不可重发
    settledCount: intents.filter((r) => r.lastVerdict === "settled").length,
    blocked,
  };
}

/** 恢复全流程：读文件+解析+重放呈现（不改盘面；坏行/撕裂尾随报告交宿主裁决；当前盘面坏行→阻断）。 */
export async function recoverFromJournal(path: string, sessionId: SessionId): Promise<JournalReadResult & RecoverReport> {
  const { lines, bad } = await readJournalFile(path);
  const report = buildRecoverReport(lines, sessionId, { fragments: bad, blocked: bad.length > 0 });
  return { lines, bad, ...report };
}
