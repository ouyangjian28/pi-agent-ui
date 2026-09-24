// 十九审开工首序①：两遍式恢复（十八审②）+ 四联终检五反例（研究档 D8 测试锚点）
// 规格=TECH §5.5/§5.6；反例=验收用例，断言失败=规格或实现漂移，禁 skip。
import { describe, expect, it } from "vitest";
import { matchKeyOf, textHash, normalizeText } from "@pi-agent-ui/protocol";
import { runRecovery, type RecoveryInput } from "@pi-agent-ui/protocol";
import type { IntentRecord, JournalLine } from "@pi-agent-ui/protocol";
import type { SessionEntry } from "@pi-agent-ui/protocol";

let _seq = 0;
function mkIntent(id: string, text: string, ordinal: number, opts: Partial<IntentRecord> = {}): IntentRecord {
  _seq += 1;
  return {
    intentId: id,
    sessionId: "s1",
    generation: 1,
    matchKey: matchKeyOf(text, [], ordinal),
    payload: { kind: "prompt", rawText: text, attachments: [], sentAt: new Date(0).toISOString() },
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
function run(entries: SessionEntry[], intents: IntentRecord[], alive = false) {
  return runRecovery({ entries, intents, permanentExclusions: new Set(), alive } satisfies RecoveryInput);
}
function verdictOf(
  out: { readonly verdicts: readonly { intentId: string; state: string; reason?: string }[] },
  id: string,
) {
  return out.verdicts.find((v) => v.intentId === id);
}

describe("四联终检五反例（D8 锚点）", () => {
  it("Ⓔ 已消费未生成回答：文件尾=user（续跑中）→整个归组 unknown（即使 I1 区间完整）", () => {
    const t1 = "跑测试",
      t2 = "继续";
    const entries = [e("u1", "user", t1), e("a1", "assistant", "答", "stop"), e("u2", "user", t2)];
    const out = run(entries, [mkIntent("I1", t1, 0)]);
    expect(verdictOf(out, "I1")?.state).toBe("unknown");
    expect(verdictOf(out, "I1")?.reason).toContain("⓪");
    // consumed 不撤销（十七审②：消费事实已确证，终局可下次扫描补）
    expect(out.newConsumed.length).toBe(1);
  });

  it("Ⓐ 末条 assistant 自带 toolCall（toolUse）→⓪不满足→unknown", () => {
    const t = "调工具";
    const entries = [e("u1", "user", t), e("a1", "assistant", "调用", "toolUse")];
    const out = run(entries, [mkIntent("I1", t, 0)]);
    expect(verdictOf(out, "I1")?.state).toBe("unknown");
  });

  it("Ⓑ abort 轮后崩溃（stopReason=aborted）→⓪不满足→unknown", () => {
    const t = "中断轮";
    const entries = [e("u1", "user", t), e("a1", "assistant", "中断", "aborted")];
    const out = run(entries, [mkIntent("I1", t, 0)]);
    expect(verdictOf(out, "I1")?.state).toBe("unknown");
  });

  it("Ⓒ 本轮完成但队列未静止（enqueue 未 consumed/clear）→③不满足→unknown", () => {
    const t1 = "第一问",
      t2 = "第二问";
    const entries = [e("u1", "user", t1), e("a1", "assistant", "答1", "stop")];
    // I1 可匹配，I2 尚未消费（队列不静止）
    const out = run(entries, [mkIntent("I1", t1, 0), mkIntent("I2", t2, 0)]);
    expect(verdictOf(out, "I1")?.state).toBe("unknown");
    expect(verdictOf(out, "I1")?.reason).toContain("③");
  });

  it("Ⓓ 首 assistant 前崩溃（零落盘）→候选空+恢复态→unknown（不洗白）", () => {
    const out = run([], [mkIntent("I1", "未落盘", 0)]);
    expect(verdictOf(out, "I1")?.state).toBe("unknown");
  });
});

describe("两遍式调度（十八审②：第一遍身份+消费，第二遍统一终检）", () => {
  it("A 落 consumed 后终检时 B 已有 consumed——两遍式让 A/B 同轮 delivered（单遍会把 A 误拦）", () => {
    const t1 = "问一",
      t2 = "问二";
    const entries = [
      e("u1", "user", t1),
      e("a1", "assistant", "答1", "stop"),
      e("u2", "user", t2),
      e("a2", "assistant", "答2", "stop"),
    ];
    const out = run(entries, [mkIntent("I1", t1, 0), mkIntent("I2", t2, 0)]);
    expect(verdictOf(out, "I1")?.state).toBe("delivered");
    expect(verdictOf(out, "I2")?.state).toBe("delivered");
    // 双锚已落（十八审①：候选命中+唯一关联成立才落）
    expect(out.newConsumed.map((c: JournalLine) => (c as { intentId: string }).intentId).sort()).toEqual(["I1", "I2"]);
  });

  it("②工具配对：区间内 toolCall 无 toolResult→unknown", () => {
    const t = "调工具轮";
    const entries = [
      e("u1", "user", t),
      { ...e("c1", "toolCall", ""), toolCallId: "tc1" }, // toolCall=独立条目（toolUse 发起）
      e("a2", "assistant", "终答", "stop"),
    ];
    const out = run(entries, [mkIntent("I1", t, 0)]);
    expect(verdictOf(out, "I1")?.state).toBe("unknown");
    expect(verdictOf(out, "I1")?.reason).toContain("②");
  });
});
