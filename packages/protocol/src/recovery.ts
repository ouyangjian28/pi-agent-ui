// 两遍式恢复对账（TECH §5.5 匹配器伪代码 + §5.6 恢复伪代码的可执行参考实现）
// 语义权威=TECH；实现必须可由伪代码逐行翻译，反例=验收用例。
// 第一遍（身份判定+消费记录，逐意图串行）→第二遍（统一四联终检）——单遍串行会让 A 落 consumed
// 后终检时 B 尚无 consumed→无人回头重检 A（十八审②）。
//
// 开工轮一审 B 面九修复（2026-09-24）：
// B1 自有证据不再按 journal 旧终点预检——锚直接交第二遍按最新 E 重算（部分轮补齐后可收敛）
// B2 newConsumed=匹配命中即落（D8 身份证据先行耐久）+当场重算终点；终检失败不撤锚；耐久顺序（先 fsync consumed 再发布终局）=adapter 责任
// B3 水位推进用重算终点（非 journal 旧终点）；恢复态终裁 unknown 亦可推进（暂定 unknown 不推）
// B4 排他=锚唯一+P+水位边界（⋃C 的区间级排他由投影起点+锚唯一+第二遍分界共同保证；匹配阶段不做尾长区间占用）
// B5 锚冲突检查无条件执行（无歧义源亦查——两意图共享锚=歧义）
// B6 匹配面仅 user role 入组（assistant 同 hash 不认锚）
// B7 ②多重集配对（session-file.ts 侧）
// B8 区间坏行=证据不完整（②内查 corrupt）
// B9 clear 前置分派延到第二遍后四分支（身份不确定保留 unknown；已终局不改写；通知侧独立）

import type { EntryIdentity, IntentId, IntentMatchKey } from "./identity.ts";
import type { IntentRecord, JournalLine } from "./journal.ts";
import {
  fileTailSatisfiesClauseZero,
  intervalClosedByFinalAnswer,
  intervalToolCallsPaired,
  type SessionEntry,
} from "./session-file.ts";

/** 恢复前置条件（二审 R2-07：显式输入边界——不得靠 alive=false 默契当终裁授权）。 */
export interface RecoveryPreconditions {
  /** 水位身份三元组验证过（会话身份+文件代次+边界 entry 身份匹配）。 */
  readonly watermarkValid: boolean;
  /** 文件代次与 journal 记录一致（换代/截短→旧水位作废）。 */
  readonly fileGenerationMatch: boolean;
  /** 写者静止（收割完成+静默窗口过；alive=true 时可 false=在飞）。 */
  readonly writerQuiesced: boolean;
  /** 外部写者闩（true=终裁永暂定——静默不解除）。 */
  readonly externalWriterLatched: boolean;
  /** 轮超时输入（true=在飞轮已超时，sending 可入歧义源判定）。 */
  readonly roundTimedOut: boolean;
}

// 三审④：前置条件必填（无缺省全过——调用方默契从接口上消除）；roundTimedOut 不在阻断列（超时=开终裁窗：在飞 sending 可入歧义源判定，非全体暂定）。

export interface RecoveryInput {
  /** E：目标分支投影（自水位边界起，原始文件序）。 */
  readonly entries: readonly SessionEntry[];
  /** J：未决意图（水位后，按 journal 序）。 */
  readonly intents: readonly IntentRecord[];
  /** P：永久排除集（GC 转储的已消费区间 entryId）。 */
  readonly permanentExclusions: ReadonlySet<string>;
  /** 进程活着（true=运行中对账：sending=在飞非歧义源；false=恢复对账：可出终裁）。 */
  readonly alive: boolean;
  /** 前置条件（三审④：必填——四项不满足任一=全部暂定终裁拒绝；roundTimedOut 非阻断仅开终裁窗）。 */
  readonly preconditions: RecoveryPreconditions;
}

export type VerdictState = "delivered" | "unknown" | "inflight" | "cancelled" | "pendingGate";

export interface IntentVerdict {
  readonly intentId: IntentId;
  readonly state: VerdictState;
  readonly reason?: string;
  /** unknown 的暂定/终裁分立（一审 B3）：true=暂定（四联未过，下次扫描可重估——不推水位）；false/缺省=终裁（恢复态可推）。 */
  readonly provisional?: boolean;
  /** 终裁但不可信（二审 R2-03：锚冲突/锚验证失败——身份证据破裂，禁推进水位禁作排他依据）。 */
  readonly untrusted?: boolean;
}

export interface RecoveryOutput {
  readonly verdicts: readonly IntentVerdict[];
  /** 需随账本 fsync 的新 consumed 行（第二遍后产出：锚+重算区间终点同 fsync；十八审①：歧义禁落耐久锚）。
   *  耐久顺序（一审）：newConsumed 耐久化成功前不得发布任何 delivered 终局或推进水位——adapter 责任。 */
  readonly newConsumed: readonly JournalLine[];
  /** 直接后继终态时的水位推进目标（逐意图推进禁跳跃；cancelled 跳过；重算终点非旧终点）。 */
  readonly watermarkAdvanceTo: EntryIdentity | null;
}

interface GroupInfo {
  readonly key: IntentMatchKey;
  /** 组内按文件出现序的同 hash **user** 条目（B6：仅 user 入组；原始序=数组下标，禁候选内重编——十一审①）。 */
  readonly groupEntries: readonly SessionEntry[];
}

function buildGroups(entries: readonly SessionEntry[], intents: readonly IntentRecord[]): Map<string, GroupInfo> {
  const groups = new Map<string, SessionEntry[]>();
  for (const e of entries) {
    if (e.corrupt) continue; // 坏行不参与匹配也不污染归属
    if (e.role !== "user") continue; // B6：匹配面=user 条目（assistant 同 hash 不认锚）
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

/** 组内歧义判定（十八审①全口径+B5+B10 修）。
 * 歧义成立 ⟺ 锚冲突（≥2 意图共享同一 consumed 锚，任何状态）
 *            或（组内存在恢复态 sending 未收口意图 且（user 条目数<未取消意图数 或 唯一关联不成立））。
 * 运行态：sending=在飞非歧义源；条目短缺=序号超界→inflight，不判歧义（一审 B 复现⑥修）。 */
function groupAmbiguous(group: GroupInfo, members: readonly IntentRecord[], alive: boolean): boolean {
  const active = members.filter((m) => !m.cancelled);
  if (active.length < 2) return false; // 单意图组：无归属指认问题
  // B5：锚冲突无条件查（有无歧义源都查——共享锚=唯一关联破裂）
  const anchors = active.filter((m) => m.consumed).map((m) => m.consumed!.anchorEntryId);
  if (anchors.length !== new Set(anchors).size) return true; // 两意图共享同一锚
  // 恢复态歧义源：sending 后未收口意图
  const hasSource = active.some((m) => !alive && m.sending && !m.consumed);
  if (!hasSource) return false; // 运行态/无未收口：序号↔出现序一一对应可执行（十一审①取法场景）
  const countShort = group.groupEntries.length < active.length;
  if (countShort) return true;
  const allAnchored = anchors.length === active.length; // 锚不齐=唯一关联不成立（数量相等亦查——十八审①）
  return !allAnchored;
}

/** 区间分配：锚按投影序排，意图区间=[锚,下一锚)半开右排他（下一锚前一条或文件尾）——B4 排他的基础。
 * 返回 Map<锚ID, {endId, entryIds(区间全部含锚)}，供排他与终检与水位共用同一口径。 */
function assignIntervals(
  entries: readonly SessionEntry[],
  anchorIds: readonly string[],
  permanentExclusions: ReadonlySet<string>,
): Map<string, { endId: string; entryIds: string[] }> {
  const pos = new Map(anchorIds.map((id) => [id, entries.findIndex((e) => e.entryId === id)]));
  const out = new Map<string, { endId: string; entryIds: string[] }>();
  const sorted = [...pos.entries()].filter(([, p]) => p >= 0).sort((a, b) => a[1]! - b[1]!);
  for (let i = 0; i < sorted.length; i++) {
    const [id, p] = sorted[i]!;
    const nextP = i + 1 < sorted.length ? sorted[i + 1]![1]! : entries.length;
    const ids: string[] = [];
    for (const e of entries.slice(p!, nextP)) if (!permanentExclusions.has(e.entryId)) ids.push(e.entryId);
    out.set(id, { endId: entries[Math.max(0, nextP - 1)]!.entryId, entryIds: ids });
  }
  return out;
}

export function runRecovery(input: RecoveryInput): RecoveryOutput {
  const { entries, intents, permanentExclusions } = input;
  const alive = input.alive && !input.preconditions.roundTimedOut; // 三审④：轮超时=终裁窗口（等同恢复态：sending 可入歧义源）
  const verdicts: IntentVerdict[] = [];
  // R2-07 前置门：显式输入边界（水位身份/文件代次/写者静止/外部闩/轮超时）——任一不满足=全部暂定，终裁拒绝
  const pre = input.preconditions;
  const preFailed: string[] = [];
  if (!pre.watermarkValid) preFailed.push("水位身份验证失败");
  if (!pre.fileGenerationMatch) preFailed.push("文件代次不匹配");
  if (!pre.writerQuiesced) preFailed.push("写者未静止");
  if (pre.externalWriterLatched) preFailed.push("外部写者闩生效");
  if (preFailed.length > 0) { // roundTimedOut 非阻断（三审④：超时开终裁窗，与 :36 注释语义统一）
    return {
      verdicts: intents.map((j) => ({
        intentId: j.intentId,
        state: "unknown" as const,
        provisional: true,
        reason: `前置不满足：${preFailed.join("；")}——全部暂定，终裁拒绝（R2-07）`,
      })),
      newConsumed: [],
      watermarkAdvanceTo: null,
    };
  }
  const newConsumed: JournalLine[] = []; // 匹配命中即落（D8 身份证据先行耐久）；歧义意图禁落（十八审①）
  const extraAnchors = new Map<IntentId, string>(); // 第一遍新增锚（第二遍③/区间/水位用）
  const pendingFinalCheck: IntentRecord[] = []; // 第二遍待检集合（十八审②：命中/自有证据同入，第一遍不终检）

  const groups = buildGroups(entries, intents);
  const membersByGroup = new Map<string, IntentRecord[]>();
  for (const j of intents) {
    const k = `${j.matchKey.textHash}|${j.matchKey.attachmentIdentity}`;
    const arr = membersByGroup.get(k) ?? [];
    arr.push(j);
    membersByGroup.set(k, arr);
  }

  // 第一遍（身份与消费，逐意图串行；cancelled 意图参与身份门（占组员额）但不匹配——分派在第二遍后）
  for (const j of intents) {
    const groupKey = `${j.matchKey.textHash}|${j.matchKey.attachmentIdentity}`;
    const group = groups.get(groupKey)!;
    const members = membersByGroup.get(groupKey)!;

    if (j.cancelled) continue; // clear 分派延到第二遍后（B9）——第一遍不做执行终局判定

    if (j.consumed) {
      const anchorIdx = entries.findIndex((e) => e.entryId === j.consumed!.anchorEntryId);
      if (anchorIdx < 0) {
        verdicts.push({
          intentId: j.intentId,
          state: "unknown",
          untrusted: true, // 三审③：锚缺失=引用破裂——不可信，禁作分区依据禁被水位跨越
          reason: "锚不在当前投影（水位/分支不一致）——降级待重估（untrusted）",
        });
        continue;
      }
      // R2-01 既有锚同验证（不绕身份门）：锚条目须=组内 user 条目（role+textHash+attachmentIdentity 三验）
      // 且全局唯一（无其他意图跨组共享同锚）——失败=unknown+untrusted（终裁但身份证据破裂，禁推水位）
      const anchorEntry = entries[anchorIdx]!;
      const anchorOk =
        anchorEntry.role === "user" &&
        anchorEntry.textHash === j.matchKey.textHash &&
        anchorEntry.attachmentIdentity === j.matchKey.attachmentIdentity;
      const sharedGlobally = intents.some(
        (m) => m.intentId !== j.intentId && m.consumed?.anchorEntryId === j.consumed!.anchorEntryId,
      );
      if (!anchorOk || sharedGlobally) {
        verdicts.push({
          intentId: j.intentId,
          state: "unknown",
          untrusted: true,
          reason: !anchorOk
            ? "既有锚非组内 user 条目（角色/文本/附件不一致）——身份证据破裂（R2-01）"
            : "既有锚被跨意图共享——全局唯一性破裂（R2-01）",
        });
        continue;
      }
      // B1：不再按 journal 旧终点预检终答——直接过身份门后交第二遍按最新 E 重算（部分轮补齐后可收敛）
      if (groupAmbiguous(group, members, alive)) {
        verdicts.push({
          intentId: j.intentId,
          state: "unknown",
          untrusted: true,
          reason: "组内歧义：占用证据≠身份证明（身份冲突不推水位——R2-03）",
        });
        continue;
      }
      pendingFinalCheck.push(j);
      continue;
    }

    // 第二步·候选匹配（仅无自有证据；减法排他）
    if (groupAmbiguous(group, members, alive)) {
      verdicts.push({
        intentId: j.intentId,
        state: "unknown",
        untrusted: true,
        reason: "组内歧义（数量相等亦查唯一关联）：不落耐久记录（R2-03：身份冲突不推水位）",
      });
      continue;
    }
    // 减法排他：候选=水位后至文件尾 − ⋃C − P（九审R3）。⋃C 在匹配阶段的体现=全部
    // 已锚定条目（既有锚+本轮新落锚）——历史消费区间在水位边界之前不进投影，其条目由 P 挡。
    // （区间级分配不在此阶段：单锚尾长区间会误吞未匹配候选；区间互不重叠由锚唯一性+第二遍分界保证。）
    const occupied = new Set<string>();
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
    for (const m of intents) {
      const a = extraAnchors.get(m.intentId) ?? m.consumed?.anchorEntryId;
      if (a) occupied.add(a);
    }
    // R2-03 既有 C 区间排他：候选落在其他意图既有消费区间内→不得落新锚
    const coveredByExisting = intents.some((m) => {
      if (m.intentId === j.intentId || !m.consumed) return false;
      const aIdx = entries.findIndex((e) => e.entryId === m.consumed!.anchorEntryId);
      if (aIdx < 0) return false;
      const cIdx = entries.findIndex((e) => e.entryId === m.consumed!.intervalEnd.entryId);
      const last = cIdx >= aIdx ? cIdx : entries.length - 1;
      return entries.slice(aIdx, last + 1).some((e) => e.entryId === rawIdxK.entryId);
    });
    if (coveredByExisting || occupied.has(rawIdxK.entryId) || permanentExclusions.has(rawIdxK.entryId)) {
      verdicts.push({
        intentId: j.intentId,
        state: alive ? "inflight" : "unknown",
        reason: "原始序号条目已在消费区间/排除集内",
      });
      continue;
    }
    // 命中：身份门已过 → 立即占用锚并落 consumed 行（D8：匹配即落身份证据先行耐久，终检失败不撤锚；
    // 区间终点按当场锚分布重算，下次恢复扫描从最新 E 重算重估——十二审①）
    extraAnchors.set(j.intentId, rawIdxK.entryId);
    const curAnchors = new Map<IntentId, string>();
    for (const m of intents) {
      const a = extraAnchors.get(m.intentId) ?? m.consumed?.anchorEntryId;
      if (a) curAnchors.set(m.intentId, a);
    }
    const curIv = assignIntervals(entries, [...curAnchors.values()], permanentExclusions).get(rawIdxK.entryId);
    newConsumed.push({
      t: "consumed",
      intentId: j.intentId,
      anchorEntryId: rawIdxK.entryId,
      intervalEnd: { entryId: curIv?.endId ?? rawIdxK.entryId, lengthHash: "" },
    });
    pendingFinalCheck.push(j); // 十八审②：命中意图只记录不终检
  }

  // 第二遍（统一四联终检）
  const clauseZeroOk =
    entries.length > 0 &&
    fileTailSatisfiesClauseZero(entries[entries.length - 1]!) &&
    !entries[entries.length - 1]!.corrupt;
  // ③队列静止（TECH:169 恢复伪代码第二遍③原文：此时范围内全部可判定意图已过②′，
  // enqueue 行均有 consumed 或 clear 终局——超界/歧义意图无 consumed=队列不静止→全部暂定，不误终局；
  // 反例Ⓒ：I2 未消费未取消→I1 不得 delivered）
  // 三审③：可信锚与不可信引用分立——untrusted（锚验证失败/歧义/冲突）意图的锚不进区间分割、不占排他位、不作静止依据
  const untrustedIds = new Set(verdicts.filter((v) => v.untrusted).map((v) => v.intentId));
  const queueQuiesced = intents.every(
    (j) =>
      j.cancelled ||
      (!untrustedIds.has(j.intentId) && (extraAnchors.has(j.intentId) || j.consumed !== null)),
  ); // 三审③：untrusted 意图的 consumed 不作静止依据
  // 区间重算（B4 同一函数）：既有锚+新增锚一起分配（仅 trusted）
  const allAnchorIds = new Map<IntentId, string>();
  for (const j of intents) {
    if (untrustedIds.has(j.intentId)) continue;
    const a = extraAnchors.get(j.intentId) ?? j.consumed?.anchorEntryId;
    if (a) allAnchorIds.set(j.intentId, a);
  }
  const intervals = assignIntervals(entries, [...allAnchorIds.values()], permanentExclusions);
  const anchorOf = (j: IntentRecord): string | undefined => allAnchorIds.get(j.intentId);

  for (const j of pendingFinalCheck) {
    const anchorId = anchorOf(j)!;
    const iv = intervals.get(anchorId);
    if (!iv) {
      verdicts.push({ intentId: j.intentId, state: "unknown", reason: "区间分配失败（锚不在投影）" });
      continue;
    }
    if (!clauseZeroOk) {
      verdicts.push({
        intentId: j.intentId,
        state: "unknown",
        provisional: true,
        reason: "⓪不满足：文件尾非终答边界（续跑中/截断）→归组 unknown（反例Ⓔ）",
      });
      continue;
    }
    const c1 = intervalClosedByFinalAnswer(entries, anchorId, iv.endId, permanentExclusions);
    if (!c1) {
      verdicts.push({
        intentId: j.intentId,
        state: "unknown",
        provisional: true,
        reason: "①不满足：意图区间未闭合（user 后无终答）",
      });
      continue;
    }
    const c2 = intervalToolCallsPaired(entries, anchorId, iv.endId);
    if (!c2) {
      verdicts.push({
        intentId: j.intentId,
        state: "unknown",
        provisional: true,
        reason: "②不满足：区间内 toolCall/toolResult 未配对或含坏行",
      });
      continue;
    }
    if (!queueQuiesced) {
      verdicts.push({
        intentId: j.intentId,
        state: "unknown",
        provisional: true,
        reason: "③不满足：范围内存在未消费未取消 enqueue（反例Ⓒ；TECH:169 第二遍③）",
      });
      continue;
    }
    verdicts.push({ intentId: j.intentId, state: "delivered", reason: "四联⓪①②③全过（区间按最新 E 重算）" });
  }
  // R2-02+三审② 终点更新行：区间重算终点若≠耐久已知终点（本轮落行 or 重放 consumed——历史证据同样更新）→追加同锚新终点行
  for (const [iid, anchorId] of allAnchorIds) {
    const j = intents.find((x) => x.intentId === iid);
    const thisRound = newConsumed.filter((c) => c.t === "consumed" && c.intentId === iid);
    const knownEnd = thisRound.length > 0
      ? thisRound[thisRound.length - 1]!.t === "consumed" && (thisRound[thisRound.length - 1] as { intervalEnd: { entryId: string } }).intervalEnd.entryId
      : j?.consumed?.intervalEnd.entryId; // 重放来的历史终点（首扫无 newConsumed 场景——三审②反例）
    if (knownEnd === undefined) continue;
    const iv = intervals.get(anchorId);
    if (iv && iv.endId !== knownEnd) {
      newConsumed.push({
        t: "consumed",
        intentId: iid,
        anchorEntryId: anchorId, // 首锚不变（append-only）
        intervalEnd: { entryId: iv.endId, lengthHash: "" }, // 终点更新新行承载（耐久已知终点漂移必须落账本）
      });
    }
  }
  // 未进入终检的歧义/超界意图无 newConsumed（禁落耐久锚——十八审①）；自有证据意图不重复落行。

  // B9+三审①：clear 前置分派（第二遍后四分支——执行侧；通知侧独立按三 ACK/expired 判，不在此面）
  for (const j of intents) {
    if (!j.cancelled) continue;
    // 分支③：历史终局（journal 终态行重放）不改写——delivered/settled 保持原判并如数输出（三审①反例修）
    if (j.lastVerdict === "delivered" || j.lastVerdict === "settled") {
      verdicts.push({
        intentId: j.intentId,
        state: "delivered", // settled（通知侧收口）蕴含执行终局——恢复面统一报 delivered
        reason: "clear 重放：历史终局不改写（执行侧取消不覆盖已终局——分支③）",
      });
      continue;
    }
    const existing = verdicts.find((x) => x.intentId === j.intentId);
    const a = anchorOf(j);
    if (a && intervals.has(a) && existing?.state === "delivered") continue; // 分支③（本轮终检）：同上
    if (j.lastVerdict === "unknown") {
      verdicts.push({ intentId: j.intentId, state: "cancelled", reason: "clear 重放：历史身份不明（分支①）——取消终局，身份待重估" });
      continue;
    }
    if (a && !untrustedIds.has(j.intentId)) {
      verdicts.push({ intentId: j.intentId, state: "cancelled", reason: "clear 重放：身份确定+执行未终局→cancelled（分支②）" });
      continue;
    }
    if (existing) {
      verdicts.push({ intentId: j.intentId, state: "cancelled", reason: "clear 重放：身份不确定保留原判（分支①），执行侧取消仍记" });
      continue;
    }
    verdicts.push({ intentId: j.intentId, state: "cancelled", reason: "clear 重放：无锚（未消费）→取消有效" });
  }

  // 水位推进（B3）：逐意图序，delivered 或恢复态终裁 unknown（有锚）才推进；用重算终点；cancelled 跳过；遇未决停。
  let advanceTo: EntryIdentity | null = null;
  for (const j of intents) {
    const v = verdicts.find((x) => x.intentId === j.intentId);
    if (!v) break; // 未判决=未决→停
    if (v.state === "cancelled") continue; // 跳过（无消费终点）
    if (v.untrusted) break; // R2-03：身份证据破裂——禁推进（不可信终裁不越过）
    const a = anchorOf(j);
    const terminal =
      v.state === "delivered" || (v.state === "unknown" && !alive && a !== undefined && v.provisional !== true); // 恢复态终裁可推；暂定（四联未过/运行态）不推
    if (!terminal || a === undefined) break;
    const iv = intervals.get(a);
    advanceTo = iv ? { entryId: iv.endId, lengthHash: "" } : advanceTo;
  }

  return { verdicts, newConsumed, watermarkAdvanceTo: advanceTo };
}
