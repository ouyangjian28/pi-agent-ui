// 恢复入口（切片4c）：journal 文件 → 行解析 → replayIntents 重放呈现。
// 职责边界：只读+呈现，不改写盘面（撕裂尾修复/换段授权归宿主流程：确认 bad 后按需
// truncate 修复或换新段，再对新/旧 FileDurability 实例 markRepaired/新建）。
// 效果未知判据（§169④ + journal.ts 重放语义）：
//   - sending 且无终态行（lastVerdict=null）→「写后中断，效果未知」（可能已写完整/部分帧）
//   - responseTimeoutRecorded 且无终态行 →「超时未结算，效果未知」
//   - lastVerdict==="unknown" → 上轮已判效果未知
//   - 非 sending 且无终态 →「已受理未发送」（同 matchKey 重发=幂等安全；仅当无坏行时才输出——见 resumeBlocked）
// 损坏阻断（s4e R1+s4f F1）：存在未裁决坏行（含撕裂尾）时 diskBlocked=true、resumable 恒空——
//   「识别了坏尾」不等于「已处理坏尾对判据的影响」：被剔除的残片可能已承载 sending，
//   证据不存在不能重新解释为「从未发送」。宿主先修复盘面（截尾/换段+重读）再获得恢复授权。
//   修复后续读（RecoverOptions.blocked:false→diskBlocked=false）时：可关联残片（受限结构扫描证得顶层唯一身份）→并入 unknownEffect；
//   **不可关联 sending 残片→恢复范围级阻断（resumable 仍恒空）+unattributableFragments 呈现**——
//   盘面修复（截尾解锁）只证明「可续写」，不构成「旧意图允许重发」的裁决事实（s4f F1：两证分离）。
//   宿主确有额外裁决依据（字节偏移/时间线人工调查）→ attributedFragments 显式归因，
//   不用 blocked:false 兼任两种证明；归因失败/残片不在场→忽略，阻断保留。
// 输入前提（s4e 第四节）：journal 文件与会话一一对应（RpcSession 每会话一 journalPath）；
//   非 enqueue 行不携会话身份，跨会话同 intentId 的终态行会越界结算——本前提由组装层保证。
// 范围口径（s4e 第五节）：本入口覆盖「子进程重启」面（同 RpcSession 重组装）；
//   完整服务重启（内存 intentSeq/ordinal 丢失+新对象续写旧 journal）会重复分配 i-1 身份，
//   需身份恢复或持久唯一 ID（后续切片，未支持）。
// 证据快照（c5 B03）：盘面修复后重读会丢失残片证据——「证据不存在」≠「从未发送」。
//   恢复结论的唯一合法入口=recoverFromSnapshot（对快照负责）；裸读当前盘面出结论只允许
//   在「从未修复过」的首次读取（captureRecoveryEvidence）。冷启动/LRU 重建无快照→
//   宿主必须呈现 unavailable(no-evidence-snapshot)，不得以 resumable 假安全替代。
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { journalLineSchemaError, replayIntents, type IntentId, type IntentRecord, type JournalLine, type RecoverySummary, type SessionId } from "@pi-agent-ui/protocol";

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

// 行 schema 校验唯一权威已抽出至 protocol（journal-schema.ts，s4e R2+s4f F2→3b2a-R5）：JSON 可解析≠有效 JournalLine；
// 缺字段/错类型/未知行型/嵌套结构非法一律拒收进 bad——恢复侧与读侧投影共用同一判定。

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
      const schemaErr = journalLineSchemaError(parsed as UnknownRecord);
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
  /** 已受理未发送（同 matchKey 重发=幂等安全；cancelled 不在内——取消是终局，重发违背用户意图）。**resumeBlocked=true（含盘面 blocked）时恒空：先修复盘面、裁决残片证据，再谈权限**。 */
  readonly resumable: readonly IntentId[];
  readonly settledCount: number;
  /** 存在未裁决坏行（撕裂尾/schema 损坏）：恢复授权阻断——宿主先修复（截尾/换段+重读）再获得可执行结论。 */
  readonly diskBlocked: boolean;
  /** 恢复授权阻断（s4g 黄项：盘面阻断与授权阻断分立呈现）：diskBlocked 或存在未裁决/不可关联残片→true。WS/UI 判按钮可用性必须用本字段，不得用 diskBlocked。 */
  readonly resumeBlocked: boolean;
  /** 不可关联/未裁决坏行证据（修复后续读仍存在）：恢复范围级阻断 resumable，呈现交宿主人工裁决（attributedFragments 精确归因后移除）。 */
  readonly unattributableFragments: readonly BadJournalEntry[];
  /** 每意图穷尽行（B03：not-evaluated 与 unknown 重叠消除——优先级 unknown>cancelled>settled/delivered>not-evaluated）。 */
  readonly perIntent: readonly PerIntentRow[];
  /** 本报告实际消耗的残片归因修订（快照证据域成分；evidenceHash 输入）。 */
  readonly attributedFragments: readonly FragmentAttribution[];
}

/** perIntent 行（contracts.RecoveryIntentRow 同构）：verdict 按优先级取值；
 *  provisional=true 仅当 unknown 由残片归因/人工裁决派生（非耐久终态事实）。 */
export interface PerIntentRow {
  readonly intentId: IntentId;
  readonly verdict: "settled" | "delivered" | "unknown" | "cancelled" | "not-evaluated";
  readonly provisional: boolean;
}

/** 由重放记录判定效果未知（sending 无终态/超时未结算/已判 unknown；取消不改副作用未知呈现——cancelled 挡 resumable，sending 照旧触发 unknown）。 */
function isUnknownEffect(rec: IntentRecord): boolean {
  if (rec.lastVerdict === "unknown") return true;
  if (rec.lastVerdict !== null) return false; // settled/delivered=有终态
  return rec.sending || rec.responseTimeoutRecorded === true;
}

/** 残片顶层身份扫描结果：none=无顶层 intentId；conflict=存在不可完全解释的结构/身份形态
 *  ——保守阻断；unique=唯一完整可解码且无其它候选。 */
type TopLevelIdScan = { kind: "none" } | { kind: "conflict" } | { kind: "unique"; id: IntentId };

/** s4h H1+s4i I1+s4j J1/Y1：受限结构扫描——**栈状态机**（对象/数组上下文+期待态转移），
 *  只接受「唯一对象根、顶层（栈长 1）恰一个 intentId 键且其值为完整可解码非空字符串，且全 raw
 *  无其它任何身份形态/非法转移」的残片。
 *  期待态：obj=[key-or-end→colon→value→member-end→（逗号后）key-required]，arr=[value-or-end→
 *  element-end→（逗号后）value-required]——初始可空与逗号后必有成员/元素分立（尾逗号闭合拒绝）。
 *  容器开符号（{/[）只允许出现在：栈空开唯一对象根（数组根=非生产形态拒绝），或父 obj value/
 *  arr value-or-end 期待态（member-end/key 等位置开容器=非法转移 J1）；根对象闭合后再出现任何
 *  容器=多根（J1）；pop 时校验类型匹配与期待态合法。
 *  撕裂前缀可以停在任意期待态（截断在字段边界内=合法前缀），**例外：身份键闭引号后冒号未现
 *  （含 EOF）=未完成键拒绝（I1）；身份值未写/截断拒绝**。「结构前缀语法可成立」不等于「可用于
 *  安全归因」——归因另须完整身份证明。**任何非法转移**（上述各条、字符串出现在 colon/member-end/
 *  element-end 位置、非字符串 intentId 值、括号错配、栈空裸字符、标量词法越界）→conflict。
 *  标量词法（Y1）：只接受 JSON 标量前缀语言——数字字符集 [-+.0-9eE] 词（截断在数字段无法判完整，
 *  宽容；非语义完整数字验证）或 true/false/null 的字母前缀（"nonsense" 等拒绝）；任意垃圾不可
 *  充当标量。非身份字符串值/数组元素须通过转义校验（完整字面量内 \ 后仅限 "\/bfnrt 或 \u+4hex，
 *  非法转义如 \q 拒绝——键名经 JSON.parse 归一天然校验）。
 *  生产 journal 行是「顶层对象」的 JSON 前缀（截断只发生在尾部），故栈空出现任何字符=非生产形态。
 *  身份键识别：键名 JSON.parse 归一（"intent\\u0049d" 转义变体解码后**同等识别**再检查层级/重复，
 *  不是一律拒绝）；嵌套（栈长≥2）或顶层外出现 intentId 键→conflict；第二次顶层键→conflict。 */
function scanTopLevelIntentId(raw: string): TopLevelIdScan {
  type ObjExpect = "key-or-end" | "key-required" | "colon" | "value" | "member-end";
  type ArrExpect = "value-or-end" | "value-required" | "element-end";
  type Ctx = { type: "obj"; expect: ObjExpect } | { type: "arr"; expect: ArrExpect };
  const stack: Ctx[] = [];
  let rootClosed = false; // J1：唯一对象根生命周期——闭合后再开容器=多根
  let sawTopKey = false;
  let topValue: IntentId | null = null;
  let i = 0;
  const N = raw.length;
  const isWs = (c: string): boolean => c === " " || c === "\t" || c === "\r" || c === "\n";
  const HEX = "0123456789abcdefABCDEF";
  /** 字面量转义校验（Y1）：\ 后仅限 JSON 合法转义（"\/bfnrt 或 \u+4hex）；返回 false=非法转义。 */
  const validEscapes = (literal: string): boolean => {
    // K-Y2：裸控制字符（U+0000-U+001F 原始字符非转义形态）拒绝；合法转义（\t/\n 等）照过。键名经 JSON.parse 归一（天然拒绝裸控制字符）。
    for (let p = 0; p < literal.length; p++) {
      const cc = literal.charCodeAt(p);
      if (cc < 0x20) return false;
    }
    for (let j = 1; j < literal.length; j += 1) {
      if (literal[j] !== "\\") continue;
      const nxt = literal[j + 1];
      if (nxt === undefined) return false; // 字面量以 \ 结尾=未闭合（readLiteral 已拦，双保险）
      if (nxt === "u") {
        if (j + 5 >= literal.length) return false;
        for (let h = j + 2; h <= j + 5; h += 1) if (!HEX.includes(literal[h] as string)) return false;
        j += 4;
      } else if (!'"\\/bfnrt'.includes(nxt)) {
        return false; // \q 等非法转义
      }
      j += 1;
    }
    return true;
  };
  /** 标量词法（Y1）：数字字符集词或 true/false/null 字母前缀；任意垃圾不可充当标量。 */
  const isScalarWord = (word: string): boolean => {
    if (/^[-+.0-9eE]+$/.test(word)) return true; // 数字态宽容前缀（截断在数字段无法判完整）
    const kw = ["t", "tr", "tru", "true", "f", "fa", "fal", "fals", "false", "n", "nu", "nul", "null"];
    return kw.includes(word);
  };
  /** 从 i（开引号处）读一个完整字符串字面量；返回 [闭引号后一位置, 字面量] 或 null=未闭合。 */
  const readLiteral = (start: number): readonly [number, string] | null => {
    let j = start + 1;
    while (j < N) {
      if (raw[j] === "\\") { j += 2; continue; }
      if (raw[j] === '"') return [j + 1, raw.slice(start, j + 1)];
      j += 1;
    }
    return null; // 截断在字符串内（含转义中间）→未解析候选
  };
  while (i < N) {
    const ch = raw[i] as string;
    if (isWs(ch)) { i += 1; continue; }
    if (ch === "{" || ch === "[") {
      // J1：容器开符号须通过父期待态与根生命周期检查——栈空只允许开唯一对象根（rootClosed/数组根拒绝）；
      // 容器内只允许出现在 value/value-or-end 期待态（member-end/key/colon 等位置开容器=非法转移）。
      if (stack.length === 0) {
        if (rootClosed) return { kind: "conflict" }; // 多根：根已闭合再开容器
        if (ch === "[") return { kind: "conflict" }; // 数组根=非生产形态（生产行是顶层对象前缀）
      } else {
        const top = stack[stack.length - 1] as Ctx;
        if (top.type === "obj") {
          if (top.expect !== "value") return { kind: "conflict" }; // key/colon/member-end 位置开容器
        } else if (top.expect !== "value-or-end" && top.expect !== "value-required") {
          return { kind: "conflict" }; // element-end 位置开容器；K-Y1：value-required（逗号后第二及后续元素）允许容器
        }
      }
      stack.push(ch === "{" ? { type: "obj", expect: "key-or-end" } : { type: "arr", expect: "value-or-end" });
      i += 1; continue;
    }
    if (ch === "}" || ch === "]") {
      const top = stack.pop();
      if (top === undefined || (ch === "}" ? top.type !== "obj" : top.type !== "arr")) return { kind: "conflict" }; // 非法配对/栈空
      // J1：初始可空（key-or-end/value-or-end）与完成后（member-end/element-end）可闭合；逗号后必有成员/元素（key-required/value-required）拒绝=尾逗号闭合拒绝
      const ok = ch === "}" ? top.expect === "key-or-end" || top.expect === "member-end" : top.expect === "value-or-end" || top.expect === "element-end";
      if (!ok) return { kind: "conflict" };
      if (stack.length === 0) rootClosed = true; // 根闭合
      const parent = stack[stack.length - 1];
      if (parent !== undefined) parent.expect = parent.type === "obj" ? "member-end" : "element-end";
      i += 1; continue;
    }
    if (ch === ",") {
      const top = stack[stack.length - 1];
      if (top === undefined) return { kind: "conflict" };
      if (top.type === "obj") {
        if (top.expect !== "member-end") return { kind: "conflict" };
        top.expect = "key-required"; // 逗号后必须有键（`{,}`/尾逗号 `,"}` 均非法）
      } else {
        if (top.expect !== "element-end") return { kind: "conflict" };
        top.expect = "value-required"; // 逗号后必须有元素（`[1,]` 非法）
      }
      i += 1; continue;
    }
    if (ch === ":") {
      const top = stack[stack.length - 1];
      if (top?.type !== "obj" || top.expect !== "colon") return { kind: "conflict" };
      top.expect = "value";
      i += 1; continue;
    }
    if (ch === '"') {
      const lit = readLiteral(i);
      if (lit === null) return { kind: "conflict" }; // 未闭合字符串：无法证明不是身份候选
      const [after, literal] = lit;
      const top = stack[stack.length - 1];
      if (top === undefined) return { kind: "conflict" }; // 栈空裸字符串：生产行是顶层对象前缀，此形态非生产
      let k = after;
      while (k < N && isWs(raw[k] as string)) k += 1;
      if (top.type === "obj") {
        if (top.expect === "key-or-end" || top.expect === "key-required") {
          // I1：键已闭合，冒号必须紧随（下一个非空白字符）——EOF/其它字符=等待冒号的未完成键/非法转移
          if (k >= N || raw[k] !== ":") return { kind: "conflict" };
          let keyName: string;
          try {
            keyName = JSON.parse(literal) as string; // 键名转义变体（"intent\\u0049d"）解码后同等识别（非法转义 throw→conflict）
          } catch {
            return { kind: "conflict" }; // 键转义中断/非法
          }
          top.expect = "colon";
          if (keyName === "intentId") {
            if (stack.length !== 1 || sawTopKey) return { kind: "conflict" }; // 嵌套键/第二次顶层键
            sawTopKey = true;
            let m = k + 1;
            while (m < N && isWs(raw[m] as string)) m += 1;
            if (m >= N || raw[m] !== '"') return { kind: "conflict" }; // 值未写/非字符串/截断
            const val = readLiteral(m);
            if (val === null) return { kind: "conflict" }; // 值截断
            try {
              const decoded: unknown = JSON.parse(val[1]);
              if (typeof decoded !== "string" || decoded.length === 0) return { kind: "conflict" };
              topValue = decoded;
            } catch {
              return { kind: "conflict" }; // 值转义中断/非法
            }
            top.expect = "member-end";
            i = val[0];
            continue;
          }
          i = after; // 普通键：冒号由主循环消费
          continue;
        }
        if (top.expect === "value") {
          if (!validEscapes(literal)) return { kind: "conflict" }; // Y1：值字符串非法转义（\q 等）
          i = after;
          top.expect = "member-end";
          continue; // 值位置字符串（含转义内嵌文本如 payload.rawText）
        }
        return { kind: "conflict" }; // colon（已由键分支确认）/member-end 位置出现字符串=非法转移
      }
      if (top.expect === "value-or-end" || top.expect === "value-required") {
        if (!validEscapes(literal)) return { kind: "conflict" }; // Y1：数组元素字符串非法转义
        i = after;
        top.expect = "element-end";
        continue; // 数组元素字符串（如 payload.attachments）
      }
      return { kind: "conflict" }; // element-end 位置字符串=非法转移
    }
    // 标量（数字/true/false/null）：词法受限前缀（Y1）；只在 value/value-or-end/value-required 位置合法。
    const top = stack[stack.length - 1];
    if (top === undefined) return { kind: "conflict" };
    if (top.type === "obj") {
      if (top.expect !== "value") return { kind: "conflict" }; // key/colon/member-end 位置标量=非法前缀
      top.expect = "member-end";
    } else {
      if (top.expect !== "value-or-end" && top.expect !== "value-required") return { kind: "conflict" };
      top.expect = "element-end";
    }
    let j = i;
    while (j < N && !",}]\"".includes(raw[j] as string) && !isWs(raw[j] as string)) j += 1; // 词=连续非结构非空白字符
    if (!isScalarWord(raw.slice(i, j))) return { kind: "conflict" }; // 词法越界（nonsense 等）
    i = j; continue;
  }
  if (!sawTopKey || topValue === null) return sawTopKey ? { kind: "conflict" } : { kind: "none" };
  return { kind: "unique", id: topValue };
}

/** 从坏行提取 sending 证据（R1/F1+s4g G1+s4h H1）：**所有坏行都是未裁决证据，默认阻断**——
 *  受限结构扫描（scanTopLevelIntentId）证得顶层唯一身份且在当前重放范围内→可关联（并入 unknown）；
 *  无身份/结构冲突（嵌套键/解码后重复键/截断值/二次键）/越出重放范围→不可关联（恢复范围级阻断，不因盘面修复解锁）。
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
  const consumedVerdictIds = new Set<IntentId>(); // 人工裁决有效消耗→其 unknown 为派生（provisional）
  for (const [raw, targets] of targetsByRaw) {
    if (targets.size > 1) continue; // H2：冲突裁决集→该证据不消耗，保留阻断（与顺序无关）
    const matches = fragments.filter((b) => b.raw === raw);
    if (matches.length !== 1) continue; // 不在场（0）或歧义（>1 同文本残片）→不信任，保留阻断
    const hit = unattributed.find((b) => b === matches[0]);
    if (hit === undefined) continue; // 已被先前裁决消耗→幂等 no-op
    const target = [...targets][0] as IntentId;
    unknown.add(target);
    consumedVerdictIds.add(target);
    unattributed = unattributed.filter((b) => b !== hit);
  }
  const resumeBlocked = diskBlocked || unattributed.length > 0; // 盘面阻断或仍有未裁决证据→授权阻断（两证分离）
  // 派生 unknown（provisional）：残片可靠关联或人工裁决消耗——非耐久终态事实
  const provisionals = new Set<IntentId>(attributed.map((a) => a.id)); // 可靠关联（结构证得）
  for (const id of consumedVerdictIds) provisionals.add(id); // 有效人工裁决
  // perIntent 穷尽表（优先级：unknown>cancelled>settled/delivered>not-evaluated）
  const perIntent: PerIntentRow[] = intents.map((r) => {
    let verdict: PerIntentRow["verdict"];
    if (unknown.has(r.intentId)) verdict = "unknown";
    else if (r.cancelled) verdict = "cancelled";
    else if (r.lastVerdict === "settled") verdict = "settled";
    else if (r.lastVerdict === "delivered") verdict = "delivered";
    else verdict = "not-evaluated";
    return { intentId: r.intentId, verdict, provisional: verdict === "unknown" && provisionals.has(r.intentId) };
  });
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
    perIntent,
    attributedFragments: opts.attributedFragments ?? [],
  };
}

/** 恢复全流程：读文件+解析+重放呈现（不改盘面；坏行/撕裂尾随报告交宿主裁决；当前盘面坏行→阻断）。
 *  仅限首次读取（未修复过）；修复后的结论必须走 recoverFromSnapshot（B03 防洗白）。 */
export async function recoverFromJournal(path: string, sessionId: SessionId): Promise<JournalReadResult & RecoverReport> {
  const { lines, bad } = await readJournalFile(path);
  const report = buildRecoverReport(lines, sessionId, { fragments: bad, blocked: bad.length > 0 });
  return { lines, bad, ...report };
}

// ---------------------------------------------------------------------------
// 证据快照（c5 B03）：恢复结论只对快照负责
// ---------------------------------------------------------------------------

/** 只读权威证据快照：盘面行+坏行残片+归因修订+边界/版本。宿主在**任何修复动作之前**捕获；
 *  修复后重读当前文件不能替代快照（残片丢失=证据灭失）。 */
export interface RecoveryEvidenceSnapshot {
  readonly version: 1;
  readonly file: string;
  readonly sessionId: SessionId;
  /** 快照时可解析行（顺序=盘面序）。 */
  readonly lines: readonly JournalLine[];
  /** 快照时坏行/撕裂残片（修复后仍以此为准）。 */
  readonly bad: readonly BadJournalEntry[];
  /** 宿主已批准的人工归因修订（追加只增不减；重放消耗见 buildRecoverReport）。 */
  readonly attributedFragments: readonly FragmentAttribution[];
  /** true=快照后盘面已修复（修复事实入证据链）。 */
  readonly repaired: boolean;
  readonly createdAt: number;
}

/** 捕获快照（宿主入口：修复前调用；幂等只读）。 */
export async function captureRecoveryEvidence(path: string, sessionId: SessionId, now: () => number = Date.now): Promise<RecoveryEvidenceSnapshot> {
  const { lines, bad } = await readJournalFile(path);
  return { version: 1, file: path, sessionId, lines, bad, attributedFragments: [], repaired: false, createdAt: now() };
}

/** 快照证据哈希（身份摘要；c6 C5-07 冻结编码：attributedFragments 排序后参与，
 *  对象按其序列化字节做身份摘要——不承诺与构造顺序无关的规范化）。 */
export function snapshotEvidenceHash(snap: RecoveryEvidenceSnapshot): string {
  const attributed = [...snap.attributedFragments].sort((a, b) =>
    a.raw < b.raw ? -1 : a.raw > b.raw ? 1 : a.intentId < b.intentId ? -1 : a.intentId > b.intentId ? 1 : 0);
  const canonical = JSON.stringify([
    snap.version, snap.file, snap.sessionId, snap.lines, snap.bad, attributed, snap.repaired,
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** 可执行恢复可用性选择器（c6 C5-01）：快照缺位（冷启动/未捕获/LRU 卸载重建）→
 *  unavailable(no-evidence-snapshot)——不得以裸读盘面出恢复结论（防洗白）；
 *  有快照→available+摘要（完整裁决走 recoverFromSnapshot）。
 *  宿主（含未来 get-recovery 投影器）必须经此门，不得绕过。 */
export function recoveryAvailability(snap: RecoveryEvidenceSnapshot | null | undefined): RecoverySummary {
  if (!snap) {
    return {
      availability: "unavailable",
      resumeBlocked: null, diskBlocked: null,
      unknownEffectCount: null, unattributableFragments: null,
      intentsCount: null, settledCount: null, evidenceHash: null,
    };
  }
  const r = recoverFromSnapshot(snap);
  return {
    availability: "available",
    resumeBlocked: r.resumeBlocked, diskBlocked: r.diskBlocked,
    unknownEffectCount: r.unknownEffect.length, unattributableFragments: r.unattributableFragments.length,
    intentsCount: r.intents.length, settledCount: r.settledCount,
    evidenceHash: snapshotEvidenceHash(snap),
  };
}

/** 宿主修复盘面后标记快照（返回 repaired=true 的新快照；原快照不可变）。
 *  修复前快照=盘面阻断证据（diskBlocked）；修复标记后=残片裁决证据。 */
export function withRepair(snap: RecoveryEvidenceSnapshot): RecoveryEvidenceSnapshot {
  return { ...snap, repaired: true };
}

/** 由快照出恢复结论（B03 唯一合法入口）。
 *  c6 C5-01：盘面阻断按快照事实分派——未修复快照（repaired=false 且有坏行）恒 diskBlocked=true
 *  （禁一切重发授权，含 resumable 恒空）；修复后（withRepair 标记）才进入残片证据裁决。
 *  残片保留与盘面阻断是两个独立维度：修复不灭失残片，未修复不得解锁。 */
export function recoverFromSnapshot(snap: RecoveryEvidenceSnapshot): RecoverReport {
  const diskBlocked = !snap.repaired && snap.bad.length > 0;
  const report = buildRecoverReport(snap.lines, snap.sessionId, {
    fragments: snap.bad,
    blocked: diskBlocked,
    attributedFragments: snap.attributedFragments,
  });
  return report;
}
