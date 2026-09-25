// 恢复入口（切片4c）：journal 文件 → 行解析 → replayIntents 重放呈现。
// 职责边界：只读+呈现，不改写盘面（撕裂尾修复/换段授权归宿主流程：确认 bad 后按需
// truncate 修复或换新段，再对新/旧 FileDurability 实例 markRepaired/新建）。
// 效果未知判据（§169④ + journal.ts 重放语义）：
//   - sending 且无终态行（lastVerdict=null）→「写后中断，效果未知」（可能已写完整/部分帧）
//   - responseTimeoutRecorded 且无终态行 →「超时未结算，效果未知」
//   - lastVerdict==="unknown" → 上轮已判效果未知
//   - 非 sending 且无终态 →「已受理未发送」（同 matchKey 重发=幂等安全；仅当无坏行时才输出——见 blocked）
// 损坏阻断（s4e R1+s4f F1）：存在未裁决坏行（含撕裂尾）时 blocked=true、resumable 恒空——
//   「识别了坏尾」不等于「已处理坏尾对判据的影响」：被剔除的残片可能已承载 sending，
//   证据不存在不能重新解释为「从未发送」。宿主先修复盘面（截尾/换段+重读）再获得恢复授权。
//   修复后续读（blocked=false）时：可关联残片（可靠解析出 intentId）→并入 unknownEffect；
//   **不可关联 sending 残片→恢复范围级阻断（resumable 仍恒空）+unattributableFragments 呈现**——
//   盘面修复（截尾解锁）只证明「可续写」，不构成「旧意图允许重发」的裁决事实（s4f F1：两证分离）。
//   宿主确有额外裁决依据（字节偏移/时间线人工调查）→ attributedFragments 显式归因，
//   不用 blocked:false 兼任两种证明；归因失败/残片不在场→忽略，阻断保留。
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

/** 行型必需字段 schema（s4e R2+s4f F2）：JSON 可解析≠有效 JournalLine；缺字段/错类型/未知行型/嵌套结构非法一律拒收进 bad，不得进入 replayIntents（畸形意图不得进 resumable——UI/发送层拿到的必须是可执行完整意图）。 */
const INTENT_KINDS: readonly string[] = ["prompt", "steer", "followUp", "abort", "takeover", "reclaim", "switchSession", "queueOp"];

function lineSchemaError(obj: UnknownRecord): string | null {
  const t = obj["t"];
  const str = (k: string): string | null => (typeof obj[k] === "string" ? null : `缺字段/错类型 ${k}`);
  const finiteNum = (k: string): string | null =>
    typeof obj[k] === "number" && Number.isFinite(obj[k]) ? null : `缺字段/错类型 ${k}`;
  const nestedStr = (o: unknown, k: string, label: string): string | null => {
    if (o === null || typeof o !== "object" || Array.isArray(o)) return `嵌套非法 ${label}`;
    return typeof (o as UnknownRecord)[k] === "string" ? null : `嵌套非法 ${label}.${k}`;
  };
  switch (t) {
    case "enqueue": {
      for (const k of ["intentId", "sessionId", "leafId"] as const) if (str(k)) return str(k);
      if (finiteNum("generation")) return finiteNum("generation");
      const mk = obj["matchKey"];
      if (mk === null || typeof mk !== "object" || Array.isArray(mk)) return "嵌套非法 matchKey";
      if (nestedStr(mk, "textHash", "matchKey.textHash")) return nestedStr(mk, "textHash", "matchKey.textHash");
      if (nestedStr(mk, "attachmentIdentity", "matchKey.attachmentIdentity"))
        return nestedStr(mk, "attachmentIdentity", "matchKey.attachmentIdentity");
      if (
        typeof (mk as UnknownRecord)["ordinal"] !== "number" ||
        !Number.isInteger((mk as UnknownRecord)["ordinal"] as number)
      )
        return "嵌套非法 matchKey.ordinal";
      const p = obj["payload"];
      if (p === null || typeof p !== "object" || Array.isArray(p)) return "嵌套非法 payload";
      const pr = p as UnknownRecord;
      if (typeof pr["kind"] !== "string" || !INTENT_KINDS.includes(pr["kind"])) return "嵌套非法 payload.kind";
      if (typeof pr["rawText"] !== "string") return "嵌套非法 payload.rawText";
      if (!Array.isArray(pr["attachments"]) || !pr["attachments"].every((a) => typeof a === "string"))
        return "嵌套非法 payload.attachments";
      if (typeof pr["sentAt"] !== "string") return "嵌套非法 payload.sentAt";
      return null;
    }
    case "sending":
    case "engaged":
    case "cancelled":
    case "delivered":
    case "settled":
      return str("intentId");
    case "consumed": {
      const head = str("intentId") ?? str("anchorEntryId");
      if (head) return head;
      const ie = obj["intervalEnd"];
      if (ie === null || typeof ie !== "object" || Array.isArray(ie)) return "嵌套非法 intervalEnd";
      if (nestedStr(ie, "entryId", "intervalEnd.entryId")) return nestedStr(ie, "entryId", "intervalEnd.entryId");
      if (nestedStr(ie, "lengthHash", "intervalEnd.lengthHash")) return nestedStr(ie, "lengthHash", "intervalEnd.lengthHash");
      return null;
    }
    case "clear": {
      const head = str("sessionId");
      if (head) return head;
      const c = obj["cleared"];
      if (!Array.isArray(c)) return "缺字段/错类型 cleared"; // 缺失/非数组=外层字段错（R2 口径）
      if (!c.every((x) => typeof x === "string")) return "嵌套非法 cleared（元素须字符串）";
      return null;
    }
    case "unknown":
      return str("intentId") ?? str("reason");
    case "response-timeout":
      return str("intentId") ?? finiteNum("generation") ?? finiteNum("commandId");
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
  /** 不可关联 sending 残片（修复后续读仍存在）：恢复范围级阻断 resumable，呈现交宿主人工裁决（attributedFragments 归因后移除）。 */
  readonly unattributableFragments: readonly BadJournalEntry[];
}

/** 由重放记录判定效果未知（sending 无终态/超时未结算/已判 unknown；取消不改副作用未知呈现——cancelled 挡 resumable，sending 照旧触发 unknown）。 */
function isUnknownEffect(rec: IntentRecord): boolean {
  if (rec.lastVerdict === "unknown") return true;
  if (rec.lastVerdict !== null) return false; // settled/delivered=有终态
  return rec.sending || rec.responseTimeoutRecorded === true;
}

/** 从坏行残片保守提取 sending 证据（R1/F1）：可靠解析出 intentId（含 JSON 转义解码）→可关联；
 *  解析不出/解码失败→不可关联（恢复范围级阻断，不因盘面修复解锁）。 */
function sendingFragmentAttribution(
  bad: readonly BadJournalEntry[],
): { attributable: Set<IntentId>; unattributable: BadJournalEntry[] } {
  const attributable = new Set<IntentId>();
  const unattributable: BadJournalEntry[] = [];
  for (const b of bad) {
    if (!/"t"\s*:\s*"send/.test(b.raw)) continue; // 非 sending 痕迹（含前缀撕裂 "send）不涉开拴证据
    // 提取完整字符串字面量再 JSON 解码（"\u0069-1" 转义是合法 JSON 字符串身份——正则裸提取不解码会漏）
    const m = b.raw.match(/"intentId"\s*:\s*("(?:[^"\\]|\\.)*")/);
    let id: IntentId | null = null;
    if (m !== null) {
      try {
        const decoded: unknown = JSON.parse(m[1] as string);
        if (typeof decoded === "string" && decoded.length > 0) id = decoded;
      } catch {
        id = null; // 字面量非法（截断在转义中间等）→不可关联
      }
    }
    if (id !== null) attributable.add(id);
    else unattributable.push(b);
  }
  return { attributable, unattributable };
}

/** 宿主人工裁决输入（s4f F1：盘面修复与重发裁决分离）：raw=报告呈现的残片原文（或其足够长前缀），intentId=人工调查确认的归因目标。归因后该残片按 unknownEffect 呈现并从不可关联集移除；不在场/不匹配→忽略（阻断保留）。 */
export interface FragmentAttribution {
  readonly raw: string;
  readonly intentId: IntentId;
}

/** 修复后续读选项：fragments=修复前盘面的坏行/残片（保守证据保留——不能把「证据不存在」解释为「从未发送」）；blocked=当前盘面阻断态（默认=有 fragments 即阻断；修复后续读显式传 false）；attributedFragments=宿主对不可关联残片的显式人工归因。 */
export interface RecoverOptions {
  readonly fragments?: readonly BadJournalEntry[];
  readonly blocked?: boolean;
  readonly attributedFragments?: readonly FragmentAttribution[];
}

export function buildRecoverReport(lines: readonly JournalLine[], sessionId: SessionId, opts: RecoverOptions = {}): RecoverReport {
  const fragments = opts.fragments ?? [];
  const blocked = opts.blocked ?? fragments.length > 0;
  const map = replayIntents(lines, sessionId);
  const intents = [...map.values()];
  const unknown = new Set(intents.filter(isUnknownEffect).map((r) => r.intentId));
  const { attributable, unattributable } = sendingFragmentAttribution(fragments);
  for (const id of attributable) {
    if (map.has(id)) unknown.add(id); // 只并入已知意图（未知 id 无呈现面；blocked 已全局阻断）
  }
  // F1 裁决：宿主显式归因（raw 全等或足够长前缀匹配）→并入 unknownEffect+从不可关联集移除；不在场→忽略保留阻断
  let unattributed = unattributable;
  for (const a of opts.attributedFragments ?? []) {
    const hit = unattributed.find((b) => b.raw === a.raw || (a.raw.length >= 12 && b.raw.startsWith(a.raw)));
    if (hit === undefined) continue; // 归因不在场：不信任，保留阻断
    if (map.has(a.intentId)) unknown.add(a.intentId);
    unattributed = unattributed.filter((b) => b !== hit);
  }
  const resumeBlocked = blocked || unattributed.length > 0; // 修复后仍不可关联→恢复范围级阻断（两证分离）
  return {
    intents,
    unknownEffect: intents.filter((r) => unknown.has(r.intentId)).map((r) => r.intentId),
    resumable: resumeBlocked
      ? [] // R1/F1：有未裁决坏行或不可关联 sending 残片→不给任何重发授权
      : intents
          .filter((r) => !unknown.has(r.intentId) && !r.sending && r.lastVerdict === null && !r.responseTimeoutRecorded && !r.cancelled)
          .map((r) => r.intentId), // 残片并入 unknown 的意图同样不可重发
    settledCount: intents.filter((r) => r.lastVerdict === "settled").length,
    blocked,
    unattributableFragments: unattributed,
  };
}

/** 恢复全流程：读文件+解析+重放呈现（不改盘面；坏行/撕裂尾随报告交宿主裁决；当前盘面坏行→阻断）。 */
export async function recoverFromJournal(path: string, sessionId: SessionId): Promise<JournalReadResult & RecoverReport> {
  const { lines, bad } = await readJournalFile(path);
  const report = buildRecoverReport(lines, sessionId, { fragments: bad, blocked: bad.length > 0 });
  return { lines, bad, ...report };
}
