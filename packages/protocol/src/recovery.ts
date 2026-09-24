// 两遍式恢复对账（TECH §5.5 匹配器伪代码 + §5.6 恢复伪代码的可执行参考实现）
// 语义权威=TECH；实现必须可由伪代码逐行翻译，反例=验收用例。
// 第一遍（身份判定+消费记录，逐意图串行）→第二遍（统一四联终检）——单遍串行会让 A 落 consumed
// 后终检时 B 尚无 consumed→无人回头重检 A（十八审②）。

import type { EntryIdentity, IntentId, IntentMatchKey } from "./identity.ts";
import type { IntentRecord, JournalLine } from "./journal.ts";
import {
  fileTailSatisfiesClauseZero,
  intervalClosedByFinalAnswer,
  intervalToolCallsPaired,
  type SessionEntry,
} from "./session-file.ts";

export interface RecoveryInput {
  /** E：目标分支投影（自水位边界起，原始文件序）。 */
  readonly entries: readonly SessionEntry[];
  /** J：未决意图（水位后，按 journal 序）。 */
  readonly intents: readonly IntentRecord[];
  /** P：永久排除集（GC 转储的已消费区间 entryId）。 */
  readonly permanentExclusions: ReadonlySet<string>;
  /** 进程活着（true=运行中对账：sending=在飞等；false=恢复对账：可出终裁）。 */
  readonly alive: boolean;
}

export type VerdictState = "delivered" | "unknown" | "inflight" | "cancelled" | "pendingGate";

export interface IntentVerdict {
  readonly intentId: IntentId;
  readonly state: VerdictState;
  readonly reason?: string;
}

export interface RecoveryOutput {
  readonly verdicts: readonly IntentVerdict[];
  /** 需随账本 fsync 的新 consumed 行（第一遍产出；十八审①：歧义禁落耐久锚）。 */
  readonly newConsumed: readonly JournalLine[];
  /** 直接后继终态时的水位推进目标（逐意图推进禁跳跃；cancelled 跳过）。 */
  readonly watermarkAdvanceTo: EntryIdentity | null;
}

interface GroupInfo {
  readonly key: IntentMatchKey;
  /** 组内按文件出现序的同 hash 条目（原始序=数组下标，禁候选内重编——十一审①）。 */
  readonly groupEntries: readonly SessionEntry[];
}

function buildGroups(entries: readonly SessionEntry[], intents: readonly IntentRecord[]): Map<string, GroupInfo> {
  const groups = new Map<string, SessionEntry[]>();
  for (const e of entries) {
    if (e.corrupt) continue; // 坏行不参与匹配也不污染归属
    const k = `${e.textHash}|${e.attachmentIdentity}`;
    const arr = groups.get(k) ?? [];
    arr.push(e);
    groups.set(k, arr);
  }
  const out = new Map<string, GroupInfo>();
  for (const j of intents) {
    const k = `${j.matchKey.textHash}|${j.matchKey.attachmentIdentity}`;
    if (!out.has(k)) out.set(k, { key: j.matchKey, groupEntries: groups.get(k) ?? [] });
  }
  return out;
}

/** 组内歧义判定（十八审①全口径：唯一关联检查——数量相等亦查）。
 * 歧义成立 ⟺ 组内存在 sending 未收口意图 且（条目数<意图数 或 唯一关联不成立）。
 * 唯一关联成立 ⟺ 组内意图全部有唯一 consumed 锚（锚互不冲突），或组内仅单意图。 */
function groupAmbiguous(group: GroupInfo, members: readonly IntentRecord[], alive: boolean): boolean {
  if (members.length < 2) return false; // 单意图组：无归属指认问题，序号自明（k=0）
  // 歧义源=sending 后未收口意图。运行态（alive）sending=在飞，非歧义（五审：不进入情形①）；
  // 恢复态（崩溃后）sending 未收口=中断/未证实=歧义源。
  const hasSource = members.some((m) => !alive && m.sending && !m.cancelled && !m.consumed);
  if (!hasSource) {
    // 无歧义源：序号↔出现序一一对应可执行（十一审①取法场景）
    return group.groupEntries.length < members.filter((m) => !m.cancelled).length;
  }
  const countShort = group.groupEntries.length < members.length;
  if (countShort) return true;
  // 数量相等：查唯一关联——consumed 锚缺失/冲突=唯一关联不成立（D10 队列消费身份；十八审①：数量相等亦查）
  const anchors = members.filter((m) => m.consumed).map((m) => m.consumed!.anchorEntryId);
  const allAnchored = anchors.length === members.length;
  const unique = new Set(anchors).size === anchors.length;
  return !allAnchored || !unique;
}

/** 消费区间占用集（减法排他：候选=水位后至文件尾 − ⋃C − P，仅「记入区间」不够——九审R3）。 */
function occupiedEntryIds(intents: readonly IntentRecord[], extraAnchors: ReadonlyMap<IntentId, string>): Set<string> {
  const occ = new Set<string>();
  for (const j of intents) {
    const anchor = extraAnchors.get(j.intentId) ?? j.consumed?.anchorEntryId;
    if (anchor) occ.add(anchor);
  }
  return occ;
}

export function runRecovery(input: RecoveryInput): RecoveryOutput {
  const { entries, intents, permanentExclusions, alive } = input;
  const verdicts: IntentVerdict[] = [];
  const newConsumed: JournalLine[] = [];
  const extraAnchors = new Map<IntentId, string>(); // 第一遍新增锚（第二遍③用）
  const pendingFinalCheck: IntentRecord[] = []; // 第二遍待检集合（十八审②：命中/自有证据同入，第一遍不终检）

  const groups = buildGroups(entries, intents);
  const membersByGroup = new Map<string, IntentRecord[]>();
  for (const j of intents) {
    const k = `${j.matchKey.textHash}|${j.matchKey.attachmentIdentity}`;
    const arr = membersByGroup.get(k) ?? [];
    arr.push(j);
    membersByGroup.set(k, arr);
  }

  // ⓪ clear 前置分派（四分支：执行侧。通知侧独立按三 ACK/expired 判——§17.2，不在此面）
  for (const j of intents) {
    if (j.cancelled)
      verdicts.push({
        intentId: j.intentId,
        state: "cancelled",
        reason: "clear 行重放：身份确定+执行未终局→cancelled",
      });
  }

  // 第一遍（身份与消费，逐意图串行）
  for (const j of intents) {
    if (j.cancelled) continue; // 已由⓪分派
    const groupKey = `${j.matchKey.textHash}|${j.matchKey.attachmentIdentity}`;
    const group = groups.get(groupKey)!;
    const members = membersByGroup.get(groupKey)!;

    if (j.consumed) {
      // 第一步·自有证据检查（C[j] 是 j 的证据不是排除对象——十审④）
      const anchorIdx = entries.findIndex((e) => e.entryId === j.consumed!.anchorEntryId);
      const endIdx = entries.findIndex((e) => e.entryId === j.consumed!.intervalEnd.entryId);
      if (anchorIdx < 0 || endIdx < anchorIdx) {
        verdicts.push({
          intentId: j.intentId,
          state: "unknown",
          reason: "锚不在当前投影（水位/分支不一致）——降级待重估",
        });
        continue;
      }
      const hasFinalAnswer = entries
        .slice(anchorIdx, endIdx + 1)
        .some((e) => e.role === "assistant" && (e.stopReason === "stop" || e.stopReason === "length"));
      if (!hasFinalAnswer) {
        // 部分轮：锚点回退上一完整轮边界，残缺轮不作起点；每次恢复扫描按最新 E 重算重估（十二审①）
        verdicts.push({
          intentId: j.intentId,
          state: "unknown",
          reason: "部分轮：尾含 user 无终答，锚点回退，按新尾部重估",
        });
        continue;
      }
      // 尾含终答 → 先过身份门（十三审③：所有 delivered 出口统一）
      if (groupAmbiguous(group, members, alive)) {
        verdicts.push({
          intentId: j.intentId,
          state: "unknown",
          reason: "组内歧义：同 hash 组无法唯一锚定归属（占用证据≠身份证明）",
        });
        continue;
      }
      pendingFinalCheck.push(j); // 十九轮：登记第二遍待检集合，不立即终检
      continue;
    }

    // 第二步·候选匹配（仅无自有证据；减法排他）
    if (groupAmbiguous(group, members, alive)) {
      verdicts.push({
        intentId: j.intentId,
        state: "unknown",
        reason: "组内歧义（数量相等亦查唯一关联）：不落耐久记录，候选不占用不排他",
      });
      continue;
    }
    const occupied = occupiedEntryIds(intents, extraAnchors);
    const candidates = group.groupEntries.filter(
      (e) => !occupied.has(e.entryId) && !permanentExclusions.has(e.entryId),
    );
    // 序号语义（十一审①）：k=原始文件序列序号（恒定），「原始序列第 k 个 entry，且该 entry 仍在候选集中」——禁候选内重编
    const k = j.matchKey.ordinal;
    const rawIdxK = group.groupEntries[k];
    if (rawIdxK === undefined) {
      verdicts.push({
        intentId: j.intentId,
        state: alive ? "inflight" : "unknown",
        reason: "原始序号超界（组内条目不足）",
      });
      continue;
    }
    if (!candidates.includes(rawIdxK)) {
      verdicts.push({
        intentId: j.intentId,
        state: alive ? "inflight" : "unknown",
        reason: "原始序号条目已被消费/排除，本轮不匹配",
      });
      continue;
    }
    // 命中：身份门已在上方过（歧义不落记录）→ 立即占用：写 C[j]+双字段 consumed 同 fsync（十七审②；首次仅匹配 user 也落，D8）
    extraAnchors.set(j.intentId, rawIdxK.entryId);
    newConsumed.push({
      t: "consumed",
      intentId: j.intentId,
      anchorEntryId: rawIdxK.entryId,
      intervalEnd: { entryId: rawIdxK.entryId, lengthHash: "" }, // 首锚=user entry 自身；区间扩展=新行承载
    });
    pendingFinalCheck.push(j); // 十八审②：命中意图只记录不终检
  }

  // 第二遍（统一四联终检——第一遍全部完成后执行，B 落 consumed 后 A 的③不再被误拦）
  const clauseZeroOk =
    entries.length > 0 &&
    fileTailSatisfiesClauseZero(entries[entries.length - 1]!) &&
    !entries[entries.length - 1]!.corrupt;
  const queueQuiesced = intents.every((j) => j.cancelled || extraAnchors.has(j.intentId) || j.consumed !== null);
  // 区间终点重算（十二审①：每次恢复扫描按最新 E 重算；规格：意图区间=[锚,边界)半开右排他=下一意图锚前一条或文件尾）
  const allAnchorIds = intents
    .map((j) => extraAnchors.get(j.intentId) ?? j.consumed?.anchorEntryId ?? null)
    .filter((x): x is string => x !== null);
  const anchorPositions = new Map(allAnchorIds.map((id) => [id, entries.findIndex((e) => e.entryId === id)]));
  function recalcIntervalEnd(anchorId: string): string {
    const myPos = anchorPositions.get(anchorId) ?? -1;
    let nextAnchorPos = entries.length; // 默认=文件尾
    for (const pos of anchorPositions.values()) if (pos > myPos && pos < nextAnchorPos) nextAnchorPos = pos;
    return entries[Math.max(0, nextAnchorPos - 1)]!.entryId; // 半开：下一锚前一条
  }
  for (const j of pendingFinalCheck) {
    const anchorId = extraAnchors.get(j.intentId) ?? j.consumed!.anchorEntryId;
    const endId = recalcIntervalEnd(anchorId); // 不用 journal 旧终点：按最新 E 重算
    if (!clauseZeroOk) {
      verdicts.push({
        intentId: j.intentId,
        state: "unknown",
        reason: "⓪不满足：文件尾非终答边界（续跑中/截断）→整个归组 unknown（反例Ⓔ）",
      });
      continue;
    }
    const c1 = intervalClosedByFinalAnswer(entries, anchorId, endId);
    if (!c1) {
      verdicts.push({ intentId: j.intentId, state: "unknown", reason: "①不满足：意图区间未闭合（user 后无终答）" });
      continue;
    }
    const c2 = intervalToolCallsPaired(entries, anchorId, endId);
    if (!c2) {
      verdicts.push({ intentId: j.intentId, state: "unknown", reason: "②不满足：区间内 toolCall/toolResult 未配对" });
      continue;
    }
    if (!queueQuiesced) {
      verdicts.push({
        intentId: j.intentId,
        state: "unknown",
        reason: "③不满足：范围内存在未消费未取消 enqueue（反例Ⓒ）",
      });
      continue;
    }
    verdicts.push({ intentId: j.intentId, state: "delivered", reason: "四联⓪①②③全过" });
  }

  // 水位推进：仅当直接后继意图终态才推进；cancelled 跳过；遇未决必须停（禁跨越/禁跳跃）
  let advanceTo: EntryIdentity | null = null;
  for (const j of intents) {
    const v = verdicts.find((x) => x.intentId === j.intentId);
    if (!v) break; // 未判决=未决→停
    if (v.state === "cancelled") continue; // 无消费终点=跳过
    if (v.state !== "delivered") break; // 规格口径：水位推进=终态（delivered/settled/unknown 终裁）才推进；inflight/未判=停
    const anchorId = extraAnchors.get(j.intentId);
    advanceTo = j.consumed
      ? j.consumed.intervalEnd
      : anchorId !== undefined
        ? { entryId: anchorId, lengthHash: "" }
        : advanceTo;
  }

  return { verdicts, newConsumed, watermarkAdvanceTo: advanceTo };
}
