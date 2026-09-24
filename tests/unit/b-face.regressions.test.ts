// 开工轮一审 B 面五反例回归+N19b 混合路径+二扫正向解除（C1/C2 补缺）
import { describe, expect, it } from "vitest";
import { matchKeyOf, runRecovery, textHash, normalizeText } from "@pi-agent-ui/protocol";
import type { IntentRecord, SessionEntry } from "@pi-agent-ui/protocol";

let _seq = 0;
function mkIntent(id: string, text: string, ordinal: number, opts: Partial<IntentRecord> = {}): IntentRecord {
  _seq += 1;
  return {
    intentId: id,
    sessionId: "s1",
    generation: 1,
    matchKey: matchKeyOf(text, [], ordinal),
    payload: { kind: "prompt", rawText: text, attachments: [], sentAt: "" },
    sending: false,
    cancelled: false,
    consumed: null,
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
function run(entries: SessionEntry[], intents: IntentRecord[], alive = false) {
  return runRecovery({ entries, intents, permanentExclusions: new Set(), alive } satisfies Parameters<
    typeof runRecovery
  >[0]);
}
function verdictOf(
  out: { readonly verdicts: readonly { intentId: string; state: string; reason?: string }[] },
  id: string,
) {
  return out.verdicts.find((v) => v.intentId === id);
}
const consumedAnchor = (
  entryId: string,
): { anchorEntryId: string; intervalEnd: { entryId: string; lengthHash: string } } => ({
  anchorEntryId: entryId,
  intervalEnd: { entryId, lengthHash: "" },
});

describe("一审 B 面五反例回归", () => {
  it("B1 部分轮补齐后收敛：首扫 unknown（暂定）→补终答重扫 delivered（旧终点不得卡死）", () => {
    const t = "任务A";
    const A = mkIntent("A", t, 0, { consumed: consumedAnchor("u1") });
    // 首扫：u1 后无终答（部分轮）——unknown 且暂定
    const out1 = run([e("u1", "user", t)], [A]);
    expect(verdictOf(out1, "A")?.state).toBe("unknown");
    // 补齐终答后重扫（journal 旧终点仍是 u1——必须按最新 E 重算而非旧终点预检）
    const out2 = run([e("u1", "user", t), e("a1", "assistant", "答", "stop")], [A]);
    expect(verdictOf(out2, "A")?.state).toBe("delivered");
  });

  it("B3 完整轮水位推进到重算终点（终答 entry）而非锚 user/旧终点", () => {
    const t = "任务A";
    const out = run([e("u1", "user", t), e("a1", "assistant", "答", "stop")], [mkIntent("A", t, 0)]);
    expect(verdictOf(out, "A")?.state).toBe("delivered");
    expect(out.watermarkAdvanceTo?.entryId).toBe("a1"); // 不是 u1（锚）——区间末条=终答
  });

  it("B6 无 user 条目时绝不 delivered（assistant 同 hash 不认锚）", () => {
    const t = "任务A";
    const entries = [e("a1", "assistant", t, "stop")]; // 只有 assistant 同 hash
    const out = run(entries, [mkIntent("A", t, 0)]);
    expect(verdictOf(out, "A")?.state).toBe("unknown"); // 恢复态超界=unknown，绝不 delivered
  });

  it("B5 两意图共享同一 consumed 锚→锚冲突=组歧义→双 unknown（不得双 delivered）", () => {
    const t = "同文本";
    const A = mkIntent("A", t, 0, { consumed: consumedAnchor("e1") });
    const B = mkIntent("B", t, 1, { consumed: consumedAnchor("e1") }); // 共享锚！
    const out = run([e("e1", "user", t), e("a1", "assistant", "答", "stop")], [A, B]);
    expect(verdictOf(out, "A")?.state).toBe("unknown");
    expect(verdictOf(out, "B")?.state).toBe("unknown");
  });

  it("B7 工具配对假阳性修复：孤立 result=false；1call+2 同 id result=false；重复 id 按次数", () => {
    const t = "工具轮";
    // 孤立 result（只 result 无 call）
    const out1 = run(
      [e("u1", "user", t), { ...e("r1", "toolResult", ""), toolCallId: "tc1" }, e("a1", "assistant", "答", "stop")],
      [mkIntent("A", t, 0)],
    );
    expect(verdictOf(out1, "A")?.state).toBe("unknown");
    // 1 call + 2 同 id result（重复不共享）
    const out2 = run(
      [
        e("u1", "user", t),
        { ...e("c1", "toolCall", ""), toolCallId: "tc1" },
        { ...e("r1", "toolResult", ""), toolCallId: "tc1" },
        { ...e("r2", "toolResult", ""), toolCallId: "tc1" },
        e("a1", "assistant", "答", "stop"),
      ],
      [mkIntent("A", t, 0)],
    );
    expect(verdictOf(out2, "A")?.state).toBe("unknown");
    // 正常 1:1 配对通过
    const out3 = run(
      [
        e("u1", "user", t),
        { ...e("c1", "toolCall", ""), toolCallId: "tc1" },
        { ...e("r1", "toolResult", ""), toolCallId: "tc1" },
        e("a1", "assistant", "答", "stop"),
      ],
      [mkIntent("A", t, 0)],
    );
    expect(verdictOf(out3, "A")?.state).toBe("delivered");
  });

  it("B8 区间内坏行（corrupt）→证据不完整→unknown", () => {
    const t = "坏行轮";
    const entries: SessionEntry[] = [
      e("u1", "user", t),
      { ...e("x1", "assistant", ""), corrupt: true },
      e("a1", "assistant", "答", "stop"),
    ];
    const out = run(entries, [mkIntent("A", t, 0)]);
    expect(verdictOf(out, "A")?.state).toBe("unknown");
  });
});

describe("N19b 混合路径+C1 二扫正向解除", () => {
  it("N19b：A 自有锚+B 新匹配同轮终检——A 区间被 B 锚切分，A 借不到 B 的终答", () => {
    const t = "同文本";
    const A = mkIntent("A", t, 0, { consumed: consumedAnchor("u1") }); // 自有锚（历史部分轮）
    const B = mkIntent("B", t, 1); // 无自有 consumed，靠匹配
    const out = run([e("u1", "user", t), e("u2", "user", t), e("ab", "assistant", "答", "stop")], [A, B]);
    expect(verdictOf(out, "A")?.state).toBe("unknown"); // A 区间=[u1,u2) 无终答——暂定，不得借 ab
    expect(verdictOf(out, "B")?.state).toBe("delivered"); // B 区间=[u2,ab] 闭合
    expect(verdictOf(out, "A")).toHaveProperty("provisional", true); // 暂定标记（下次补齐可重估）
  });

  it("C1 二扫正向解除：首扫 I2 超界 unknown→补齐新 user+终答后二扫 I2 落锚 delivered", () => {
    const t = "同文本";
    const first = run(
      [e("e1", "user", t), e("a1", "assistant", "答", "stop")],
      [mkIntent("I1", t, 0), mkIntent("I2", t, 1)],
    );
    expect(verdictOf(first, "I1")?.state).toBe("unknown"); // I2 无 consumed→③不静止→I1 亦暂定（反例Ⓒ口径）
    expect(verdictOf(first, "I2")?.state).toBe("unknown"); // 超界（恢复态）
    // 二扫：宿主补写了 e2+终答（真身份证据=新条目出现）
    const second = run(
      [e("e1", "user", t), e("a1", "assistant", "答", "stop"), e("e2", "user", t), e("a2", "assistant", "答2", "stop")],
      [mkIntent("I1", t, 0, { consumed: consumedAnchor("e1") }), mkIntent("I2", t, 1)],
    );
    expect(verdictOf(second, "I1")?.state).toBe("delivered");
    expect(verdictOf(second, "I2")?.state).toBe("delivered"); // 正向解除：新证据落锚
    const i2c = second.newConsumed.find((c) => (c as { intentId: string }).intentId === "I2");
    expect((i2c as { anchorEntryId: string } | undefined)?.anchorEntryId).toBe("e2");
  });
});
