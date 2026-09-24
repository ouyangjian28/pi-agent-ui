// 十九审开工首序②：身份门全口径（十八审①数量相等亦查唯一关联+十一审①原始序号禁重编+八审水位不吞）
import { describe, expect, it } from "vitest";
import { matchKeyOf, runRecovery, textHash, normalizeText } from "@pi-agent-ui/protocol";
import type { IntentRecord, SessionEntry, EntryIdentity } from "@pi-agent-ui/protocol";

function mkIntent(id: string, text: string, ordinal: number, opts: Partial<IntentRecord> = {}): IntentRecord {
  return {
    intentId: id,
    sessionId: "s1",
    generation: 1,
    matchKey: matchKeyOf(text, [], ordinal),
    payload: { kind: "prompt", rawText: text, attachments: [], sentAt: "" },
    sending: true,
    consumed: null,
    cancelled: false,
    ...opts,
  };
}
function e(
  id: string,
  role: SessionEntry["role"],
  text: string,
  stopReason?: SessionEntry["stopReason"],
): SessionEntry {
  return {
    entryId: id,
    role,
    textHash: textHash(normalizeText(text)),
    attachmentIdentity: "",
    ...(stopReason !== undefined ? { stopReason } : {}),
  };
}
const consumedAnchor = (entryId: string): { anchorEntryId: string; intervalEnd: EntryIdentity } => ({
  anchorEntryId: entryId,
  intervalEnd: { entryId, lengthHash: "" },
});

describe("十八审①：数量相等但消费身份未知→组级 unknown，不落任何耐久锚", () => {
  it("steer+followUp 同文本同图，条目数=意图数，锚缺失→歧义", () => {
    const t = "同文本";
    const entries = [e("e1", "user", t), e("e2", "user", t)];
    const I1 = mkIntent("I1", t, 0, { payload: { kind: "prompt", rawText: t, attachments: [], sentAt: "" } });
    const I2 = mkIntent("I2", t, 1, { payload: { kind: "steer", rawText: t, attachments: [], sentAt: "" } });
    const out = runRecovery({ entries, intents: [I1, I2], permanentExclusions: new Set(), alive: false });
    expect(out.verdicts.find((v) => v.intentId === "I1")?.state).toBe("unknown");
    expect(out.verdicts.find((v) => v.intentId === "I2")?.state).toBe("unknown");
    expect(out.newConsumed.length).toBe(0); // 禁落耐久锚（先落后判=自造身份证据）
  });
});

describe("十一审①：原始序号禁候选内重编", () => {
  it("A/B/C=e1/e2/e3 同文本，A 已锚 e1→B 取原始序号 2=e2（非候选重编第 2=e3）", () => {
    const t = "同文本";
    const entries = [e("e1", "user", t), e("e2", "user", t), e("e3", "user", t)];
    // 运行态对账（alive=true）：sending=在飞非歧义源（五审不进入情形①）；测的是取法本身
    const A = mkIntent("A", t, 0, { consumed: consumedAnchor("e1") });
    const B = mkIntent("B", t, 1);
    const C = mkIntent("C", t, 2);
    const out = runRecovery({ entries, intents: [A, B, C], permanentExclusions: new Set(), alive: true });
    const bAnchor = out.newConsumed.find((c) => (c as { intentId: string }).intentId === "B") as
      { anchorEntryId: string } | undefined;
    expect(bAnchor?.anchorEntryId).toBe("e2"); // 原始序号第 2=e2；候选重编会错取 e3
  });
});

describe("八审：水位不吞未决意图的恢复证据", () => {
  it("A 未决 B 完成：B 可 delivered，水位停（advanceTo=null），A 证据不被吞", () => {
    const t1 = "问A",
      t2 = "问B";
    // A 的轮只有 user（续跑中），B 完整
    const entries = [e("ua", "user", t1), e("ub", "user", t2), e("ab", "assistant", "答B", "stop")];
    const A = mkIntent("A", t1, 0);
    const B = mkIntent("B", t2, 0);
    const out = runRecovery({ entries, intents: [A, B], permanentExclusions: new Set(), alive: false });
    // 尾=assistant stop→⓪过；A ①不过（ua 后无终答）→unknown；B delivered
    expect(out.verdicts.find((v) => v.intentId === "B")?.state).toBe("delivered");
    expect(out.verdicts.find((v) => v.intentId === "A")?.state).toBe("unknown");
    expect(out.watermarkAdvanceTo).toBeNull(); // A 未决→水位停在 A 之前
    // A 的消费锚已落（下次扫描按新尾部重估——十二审①）
    expect(out.newConsumed.some((c) => (c as { intentId: string }).intentId === "A")).toBe(true);
  });
});

describe("clear 前置分派与 cancelled 水位跳过", () => {
  it("cancelled 意图不阻塞后续 delivered 判定（十七审②：跳过直接推进）", () => {
    const t1 = "被取消",
      t2 = "正常";
    const entries = [e("u2", "user", t2), e("a2", "assistant", "答", "stop")];
    const C1 = mkIntent("C1", t1, 0, { cancelled: true });
    const I2 = mkIntent("I2", t2, 0);
    const out = runRecovery({ entries, intents: [C1, I2], permanentExclusions: new Set(), alive: false });
    expect(out.verdicts.find((v) => v.intentId === "C1")?.state).toBe("cancelled");
    expect(out.verdicts.find((v) => v.intentId === "I2")?.state).toBe("delivered");
  });
});
