// c6 C5-06：会话条目归因（前向区间+锚身份+扫描置换不敏感）。
import { describe, expect, it } from "vitest";
import { attributeSessionEntries, type ConsumedInterval, type SessionEntryRef } from "@pi-agent-ui/protocol";

function e(id: string, kind: SessionEntryRef["kind"], hash = `h-${id}`): SessionEntryRef { return { entryId: id, lengthHash: hash, kind }; }
function c(intentId: string, anchorEntryId: string, endId: string, endHash?: string): ConsumedInterval {
  return { intentId, anchorEntryId, intervalEnd: { entryId: endId, lengthHash: endHash ?? `h-${endId}` } };
}

describe("会话条目归因（c6 C5-06）", () => {
  it("①GPT 定向反例：user-A/assistant-A/user-B/assistant-B——assistant-A 归 A（前向区间，非旧「向前到下一锚」）", () => {
    const entries = [e("u1", "user"), e("a1", "assistant"), e("u2", "user"), e("a2", "assistant")];
    const r = attributeSessionEntries({ consumed: [c("i-1", "u1", "a1"), c("i-2", "u2", "a2")], entries });
    expect(r.map((x) => x.intentId)).toEqual(["i-1", "i-1", "i-2", "i-2"]); // assistant-A 归 A 非 B
  });

  it("②锚=entryId 身份（同位置换 id 不串）；区间含两端（锚与终点都归意图）", () => {
    const entries = [e("x", "user"), e("m", "assistant")];
    const r = attributeSessionEntries({ consumed: [c("i", "x", "m")], entries });
    expect(r.map((x) => x.intentId)).toEqual(["i", "i"]);
  });

  it("③终点哈希不符→区间整体不采信（条目 null，不猜）", () => {
    const entries = [e("u1", "user"), e("a1", "assistant")];
    const r = attributeSessionEntries({ consumed: [c("i-1", "u1", "a1", "h-forged")], entries });
    expect(r.map((x) => x.intentId)).toEqual([null, null]);
  });

  it("④锚/终点不可见（session 文件截断）→null；终点在锚前→无效区间", () => {
    const entries = [e("a1", "assistant"), e("u1", "user")]; // 终点 a1 在锚 u1 前
    const r1 = attributeSessionEntries({ consumed: [c("i", "u1", "a1")], entries });
    expect(r1.map((x) => x.intentId)).toEqual([null, null]); // 无效区间
    const r2 = attributeSessionEntries({ consumed: [c("i", "u-missing", "a1")], entries });
    expect(r2.map((x) => x.intentId)).toEqual([null, null]); // 锚不可见
  });

  it("⑤重叠/嵌套区间：内层（更近锚）优先", () => {
    const entries = [e("u1", "user"), e("u2", "user"), e("m", "assistant"), e("e2", "assistant")];
    // i-1 区间 [u1..e2]（大）；i-2 区间 [u2..e2]（内嵌）
    const r = attributeSessionEntries({ consumed: [c("i-1", "u1", "e2"), c("i-2", "u2", "e2")], entries });
    expect(r.map((x) => x.intentId)).toEqual(["i-1", "i-2", "i-2", "i-2"]); // u2/m/e2 归内层 i-2；u1 归 i-1
  });

  it("⑥同意图多次 consumed：最新生效（区间扩张）；旧区间外条目按新区间判", () => {
    const entries = [e("u1", "user"), e("m1", "assistant"), e("m2", "assistant")];
    const r = attributeSessionEntries({ consumed: [c("i", "u1", "m1"), c("i", "u1", "m2")], entries });
    expect(r.map((x) => x.intentId)).toEqual(["i", "i", "i"]); // 最新区间到 m2
  });

  it("⑦序前置条件（c7 C5-06 残余收口）：不同意图 consumed 逆序**不保证**同结果——journal 序是前置条件；同锚多次 consumed=数组末项（journal 序最晚）生效", () => {
    const entries = [e("u1", "user"), e("a1", "assistant"), e("u2", "user"), e("a2", "assistant")];
    const fwd = attributeSessionEntries({ consumed: [c("i-1", "u1", "a1"), c("i-2", "u2", "a2")], entries });
    const rev = attributeSessionEntries({ consumed: [c("i-2", "u2", "a2"), c("i-1", "u1", "a1")], entries });
    // 前置条件（consumed 按 journal 序给定）满足时，两源扫描调度置换不影响结果——
    // 但**反转数组本身违反前置条件**（撤销旧「任意置换不变」过宽承诺）：非重叠区间时逆序恰巧同结果
    expect(rev).toEqual(fwd); // 本例区间不重叠：排序无关（结构性）
    // 同锚多次 consumed：数组末项（journal 序最晚）生效——逆序会选错区间（证前置条件必要）
    const entries2 = [e("u1", "user"), e("m1", "assistant"), e("m2", "assistant")];
    const journalOrder = attributeSessionEntries({ consumed: [c("i", "u1", "m1"), c("i", "u1", "m2")], entries: entries2 });
    expect(journalOrder.map((x) => x.intentId)).toEqual(["i", "i", "i"]); // 最新=到 m2
    const reversed = attributeSessionEntries({ consumed: [c("i", "u1", "m2"), c("i", "u1", "m1")], entries: entries2 });
    expect(reversed.map((x) => x.intentId)).toEqual(["i", "i", null]); // 末项=旧区间 m1→m2 不归（前置条件被违反的可见后果）
  });

  it("⑦b c8 R3：同意图不同锚=最新 consumed 生效，旧锚区间作废（GPT 反例 u1,a1,u2,a2→[null,null,I,I]）", () => {
    const entries = [e("u1", "user"), e("a1", "assistant"), e("u2", "user"), e("a2", "assistant")];
    // journal 序：先 consumed(u1→a1)，后 consumed(u2→a2)——同意图两区间
    const r = attributeSessionEntries({ consumed: [c("i", "u1", "a1"), c("i", "u2", "a2")], entries });
    expect(r.map((x) => x.intentId)).toEqual([null, null, "i", "i"]); // u1/a1 落作废区间（非「各区间独立生效」——旧承诺已废）
  });

  it("⑧无 consumed→全 null；system/toolResult 同规则归区间", () => {
    const entries = [e("u1", "user"), e("s1", "system"), e("t1", "toolResult")];
    const r0 = attributeSessionEntries({ consumed: [], entries });
    expect(r0.map((x) => x.intentId)).toEqual([null, null, null]);
    const r1 = attributeSessionEntries({ consumed: [c("i", "u1", "t1")], entries });
    expect(r1.map((x) => x.intentId)).toEqual(["i", "i", "i"]);
  });

  it("⑨blockIndex 语义外置：多 toolCall 共用 entryId 区分靠宿主（entryId 唯一化后进入本投影）——此例固化约束", () => {
    // 宿主投影前须将 entryId 唯一化（如 `${entryId}#${blockIndex}`）；本层按字符串身份处理
    const entries = [e("u1", "user"), e("tc1#0", "toolResult"), e("tc1#1", "toolResult")];
    const r = attributeSessionEntries({ consumed: [c("i", "u1", "tc1#1")], entries });
    expect(r.map((x) => x.intentId)).toEqual(["i", "i", "i"]);
  });
});
