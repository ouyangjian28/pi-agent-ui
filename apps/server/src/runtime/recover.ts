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
  // s4g 裁量②收紧：generation/commandId=安全整数且≥1（生产端只写正整数序号，输入面同步收紧）；
  // ordinal=安全整数且≥0（0 基非负）。
  const finiteNum = (k: string): string | null =>
    typeof obj[k] === "number" && Number.isSafeInteger(obj[k]) && (obj[k] as number) >= 1
      ? null
      : `缺字段/错类型 ${k}`;
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
        !Number.isSafeInteger((mk as UnknownRecord)["ordinal"] as number) ||
        ((mk as UnknownRecord)["ordinal"] as number) < 0
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
  readonly diskBlocked: boolean;
  /** 恢复授权阻断（s4g 黄项：盘面阻断与授权阻断分立呈现）：diskBlocked 或存在未裁决/不可关联残片→true。WS/UI 判按钮可用性必须用本字段，不得用 diskBlocked。 */
  readonly resumeBlocked: boolean;
  /** 不可关联/未裁决坏行证据（修复后续读仍存在）：恢复范围级阻断 resumable，呈现交宿主人工裁决（attributedFragments 精确归因后移除）。 */
  readonly unattributableFragments: readonly BadJournalEntry[];
}

/** 由重放记录判定效果未知（sending 无终态/超时未结算/已判 unknown；取消不改副作用未知呈现——cancelled 挡 resumable，sending 照旧触发 unknown）。 */
function isUnknownEffect(rec: IntentRecord): boolean {
  if (rec.lastVerdict === "unknown") return true;
  if (rec.lastVerdict !== null) return false; // settled/delivered=有终态
  return rec.sending || rec.responseTimeoutRecorded === true;
}

/** 残片顶层身份扫描结果：none=无顶层 intentId；conflict=存在不可完全解释的身份形态
 *  （嵌套/转义键/截断字符串/二次键/非字符串值）——保守阻断；unique=唯一完整可解码且无其它候选。 */
type TopLevelIdScan = { kind: "none" } | { kind: "conflict" } | { kind: "unique"; id: IntentId };

/** s4h H1：受限结构扫描——手写状态机逐字符跟深度（{[ 层级）与字符串字面量（\\ 转义跨步），
 *  只接受「顶层（depth===1）恰一个 intentId 键且其值为完整可解码非空字符串，且全 raw 无其它
 *  任何 intentId 形态」的残片：嵌套 intentId 键（含 metadata 等）、键名转义变体、值截断、
 *  未闭合字符串（任何位置——无法证明它不是身份候选）、第二次顶层键、非字符串值→conflict。
 *  生产 journal 行只有顶层 intentId 一个身份字段，其余一切形态=结构不可完全解释→保守阻断交人工。 */
function scanTopLevelIntentId(raw: string): TopLevelIdScan {
  let depth = 0;
  let i = 0;
  let sawTopKey = false;
  let topValue: IntentId | null = null;
  const isWs = (c: string): boolean => c === " " || c === "\t" || c === "\r" || c === "\n";
  /** 从 i（开引号处）读一个完整字符串字面量；返回 [闭引号后一位置, 字面量] 或 null=未闭合。 */
  const readLiteral = (start: number): readonly [number, string] | null => {
    let j = start + 1;
    while (j < raw.length) {
      if (raw[j] === "\\") { j += 2; continue; }
      if (raw[j] === '"') return [j + 1, raw.slice(start, j + 1)];
      j += 1;
    }
    return null; // 截断在字符串内（含转义中间）→未解析候选
  };
  while (i < raw.length) {
    const ch = raw[i] as string;
    if (ch === '"') {
      const lit = readLiteral(i);
      if (lit === null) return { kind: "conflict" }; // 未闭合字符串：无法证明不是身份候选
      const [afterKey, keyLiteral] = lit;
      let k = afterKey;
      while (k < raw.length && isWs(raw[k] as string)) k += 1;
      if (raw[k] === ":") {
        let keyName: string;
        try {
          keyName = JSON.parse(keyLiteral) as string; // 键名转义变体（"intent\u0049d"）自然归一
        } catch {
          return { kind: "conflict" }; // 键转义中断
        }
        if (keyName === "intentId") {
          if (depth !== 1 || sawTopKey) return { kind: "conflict" }; // 嵌套键/第二次键
          sawTopKey = true;
          let m = k + 1;
          while (m < raw.length && isWs(raw[m] as string)) m += 1;
          if (raw[m] !== '"') return { kind: "conflict" }; // 值非字符串（数字/对象/截断）非生产形态
          const val = readLiteral(m);
          if (val === null) return { kind: "conflict" }; // 值截断
          try {
            const decoded: unknown = JSON.parse(val[1]);
            if (typeof decoded !== "string" || decoded.length === 0) return { kind: "conflict" };
            topValue = decoded;
            i = val[0];
            continue;
          } catch {
            return { kind: "conflict" }; // 值转义中断
          }
        }
        i = afterKey;
        continue;
      }
      i = afterKey; // 值位置字符串（非身份）：继续
      continue;
    }
    if (ch === "{" || ch === "[") { depth += 1; i += 1; continue; }
    if (ch === "}" || ch === "]") { depth -= 1; i += 1; continue; }
    i += 1;
  }
  if (!sawTopKey || topValue === null) return sawTopKey ? { kind: "conflict" } : { kind: "none" };
  return { kind: "unique", id: topValue };
}

/** 从坏行提取 sending 证据（R1/F1+s4g G1+s4h H1）：**所有坏行都是未裁决证据，默认阻断**——
 *  受限结构扫描（scanTopLevelIntentId）证得顶层唯一身份且在当前重放范围内→可关联（并入 unknown）；
 *  无身份/结构冲突（嵌套键/转义键/截断值/二次键）/越出重放范围→不可关联（恢复范围级阻断，不因盘面修复解锁）。
 *  G1 教训：不能把「未看见足够长的 sending 字样」解释成「可以忽略」；
 *  H1 教训：已匹配身份唯一不等于整条残片归属唯一——正则只收完整字面量会漏掉截断的第二身份/嵌套身份。 */
function sendingFragmentAttribution(
  bad: readonly BadJournalEntry[],
  knownIds: ReadonlySet<IntentId>,
): { attributed: Array<{ id: IntentId; entry: BadJournalEntry }>; unattributable: BadJournalEntry[] } {
  const attributed: Array<{ id: IntentId; entry: BadJournalEntry }> = [];
  const unattributable: BadJournalEntry[] = [];
  for (const b of bad) {
    const scan = scanTopLevelIntentId(b.raw);
    if (scan.kind === "unique" && knownIds.has(scan.id)) {
      attributed.push({ id: scan.id, entry: b }); // 顶层唯一身份且在重放范围内→可关联
    } else {
      unattributable.push(b); // none（无身份）/conflict（结构冲突）/越界→保守阻断
    }
  }
  return { attributed, unattributable };
}

/** 宿主人工裁决输入（s4f F1+s4g G2）：raw=坏行残片原文（**精确全等匹配**——前缀匹配无法证明唯一性已删）；
 *  intentId=人工调查确认的归因目标（必须在当前重放范围内）。
 *  裁决有效条件（全部满足才移除证据）：①raw 与恰一条残片全等（多条同文本=歧义拒绝）②目标在重放范围内。
 *  无效/歧义/重复裁决→忽略（阻断保留）；重复裁决幂等（同裁决再入→已无匹配→no-op）。 */
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
  const diskBlocked = opts.blocked ?? fragments.length > 0;
  const map = replayIntents(lines, sessionId);
  const intents = [...map.values()];
  const unknown = new Set(intents.filter(isUnknownEffect).map((r) => r.intentId));
  const { attributed, unattributable } = sendingFragmentAttribution(fragments, new Set(map.keys()));
  for (const { id } of attributed) unknown.add(id); // 唯一且在重放范围内的可靠关联→并入 unknown
  // G2 裁决（s4h H2 整批冲突校验）：同一 raw 的有效目标集>1=冲突裁决——两条都不是重复，整条证据
  // 保留阻断（消费前预检，两种顺序结果恒定）；相同目标重复合并（幂等）。裁决有效消耗条件：
  // ①raw 与恰一条残片全等（多条同文本=歧义拒绝）②目标在重放范围内③该 raw 无冲突裁决集。
  const verdicts = opts.attributedFragments ?? [];
  const targetsByRaw = new Map<string, Set<IntentId>>();
  for (const a of verdicts) {
    if (!map.has(a.intentId)) continue; // 目标不在重放范围→结构性无效（不参与冲突集）
    const set = targetsByRaw.get(a.raw) ?? new Set<IntentId>();
    set.add(a.intentId);
    targetsByRaw.set(a.raw, set);
  }
  let unattributed = unattributable;
  for (const [raw, targets] of targetsByRaw) {
    if (targets.size > 1) continue; // H2：冲突裁决集→该证据不消耗，保留阻断（与顺序无关）
    const matches = fragments.filter((b) => b.raw === raw);
    if (matches.length !== 1) continue; // 不在场（0）或歧义（>1 同文本残片）→不信任，保留阻断
    const hit = unattributed.find((b) => b === matches[0]);
    if (hit === undefined) continue; // 已被先前裁决消耗→幂等 no-op
    unknown.add([...targets][0] as IntentId);
    unattributed = unattributed.filter((b) => b !== hit);
  }
  const resumeBlocked = diskBlocked || unattributed.length > 0; // 盘面阻断或仍有未裁决证据→授权阻断（两证分离）
  return {
    intents,
    unknownEffect: intents.filter((r) => unknown.has(r.intentId)).map((r) => r.intentId),
    resumable: resumeBlocked
      ? [] // R1/F1：有未裁决坏行或不可关联残片→不给任何重发授权
      : intents
          .filter((r) => !unknown.has(r.intentId) && !r.sending && r.lastVerdict === null && !r.responseTimeoutRecorded && !r.cancelled)
          .map((r) => r.intentId), // 残片并入 unknown 的意图同样不可重发
    settledCount: intents.filter((r) => r.lastVerdict === "settled").length,
    diskBlocked,
    resumeBlocked,
    unattributableFragments: unattributed,
  };
}

/** 恢复全流程：读文件+解析+重放呈现（不改盘面；坏行/撕裂尾随报告交宿主裁决；当前盘面坏行→阻断）。 */
export async function recoverFromJournal(path: string, sessionId: SessionId): Promise<JournalReadResult & RecoverReport> {
  const { lines, bad } = await readJournalFile(path);
  const report = buildRecoverReport(lines, sessionId, { fragments: bad, blocked: bad.length > 0 });
  return { lines, bad, ...report };
}
