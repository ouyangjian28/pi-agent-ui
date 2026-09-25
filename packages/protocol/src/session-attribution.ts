// ②WS/UI 会话条目归因（契约 v1.2 §3.5；纯投影，c6 C5-06）。
//
// 权威模型（与恢复算法同向，GPT c5 复审定向）：
// - 归因区间=[本意图 user 锚（consumed.anchorEntryId 字符串身份）, intervalEnd{entryId,lengthHash}]，
//   **从锚向后**到区间终点（含两端）。user-A/assistant-A/user-B/assistant-B 场景中
//   assistant-A 归 A（A 区间闭合于 B 锚之前）——旧「向前到下一锚」口径会把 assistant-A 归 B，方向反了。
// - 锚=entryId 身份（非行号/扫描序）；终点=entryId+lengthHash 双身份（防同 id 改写伪造终点）。
// - 区间无效（锚不可见/终点不可见/终点在锚之前/哈希不符）→ 该意图区间整体 null（不猜，不回改已发布）。
// - 重叠区间：嵌套/交错时内层（更近的未闭合锚）优先——条目归最近的后开锚；
//   与「区间=[锚,终点]包含判定」一致，且对 journal 行扫描顺序置换不敏感（纯集合关系）。
// - 同一意图多次 consumed：最新（journal 序末条）生效；锚不变更权威（append-only 契约）。
import type { EntryIdentity } from "./identity.ts";

/** 会话条目引用（宿主从 session 文件投影；有序） */
export interface SessionEntryRef {
  readonly entryId: string;
  readonly lengthHash: string;
  readonly kind: "user" | "assistant" | "toolResult" | "system";
}

/** consumed 证据（journal 行投影；intentId+anchor+区间终点） */
export interface ConsumedInterval {
  readonly intentId: string;
  readonly anchorEntryId: string;
  readonly intervalEnd: EntryIdentity;
}

export interface AttributionInput {
  readonly consumed: readonly ConsumedInterval[];
  readonly entries: readonly SessionEntryRef[];
}

export interface EntryAttribution {
  readonly entryId: string;
  readonly intentId: string | null; // null=未归因（无覆盖区间/区间无效）
}

/** 归因主投影：每个会话条目→意图 id 或 null。
 *  纯函数：只依赖条目序列与 consumed 集合，不依赖两源的扫描先后（置换不敏感）。 */
export function attributeSessionEntries(input: AttributionInput): EntryAttribution[] {
  // 1. 每意图取最新 consumed（journal 序末条）
  const latest = new Map<string, ConsumedInterval>();
  for (const c of input.consumed) latest.set(c.intentId, c);

  // 2. 条目位置索引（entryId 唯一；重复 id=宿主数据错——首见为准，不猜）
  const pos = new Map<string, number>();
  input.entries.forEach((e, i) => { if (!pos.has(e.entryId)) pos.set(e.entryId, i); });
  const hashOf = new Map<string, string>();
  input.entries.forEach((e) => { if (!hashOf.has(e.entryId)) hashOf.set(e.entryId, e.lengthHash); });

  // 3. 有效区间表（intentId → [startIndex, endIndex]；无效不入表）
  const spans: { intentId: string; from: number; to: number; order: number }[] = [];
  let order = 0;
  for (const [intentId, c] of latest) {
    const a = pos.get(c.anchorEntryId);
    const b = pos.get(c.intervalEnd.entryId);
    if (a === undefined || b === undefined) continue; // 锚/终点不可见→null（不猜）
    if (hashOf.get(c.intervalEnd.entryId) !== c.intervalEnd.lengthHash) continue; // 终点哈希不符→不采信
    if (b < a) continue; // 终点在锚前→无效区间
    spans.push({ intentId, from: a, to: b, order: order++ });
  }

  // 4. 逐条目归属：覆盖它的**最近锚**（from 最大者；并列取 journal 序最新——保守一致）
  const byIndex: (string | null)[] = input.entries.map(() => null);
  for (let i = 0; i < input.entries.length; i++) {
    let best: { intentId: string; from: number; order: number } | null = null;
    for (const sp of spans) {
      if (i >= sp.from && i <= sp.to) {
        if (best === null || sp.from > best.from || (sp.from === best.from && sp.order > best.order)) best = sp;
      }
    }
    byIndex[i] = best === null ? null : best.intentId;
  }
  return input.entries.map((e, i) => ({ entryId: e.entryId, intentId: byIndex[i] ?? null }));
}
