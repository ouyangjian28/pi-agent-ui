// 十九审开工首序③：N18b 身份证据样例——新终答≠天然归属证明；唯一映射演算（matchKey）
import { describe, expect, it } from "vitest";
import { attachmentIdentity, matchKeyOf, normalizeText, textHash, runRecovery } from "@pi-agent-ui/protocol";

const PRE_OK = { watermarkValid: true, fileGenerationMatch: true, writerQuiesced: true, externalWriterLatched: false, roundTimedOut: false } as const;
import type { IntentRecord, SessionEntry } from "@pi-agent-ui/protocol";

describe("匹配键派生演算（三审定界冻结口径）", () => {
  it("同文本双发：序号区分（0/1）；hash 相同+附件多重集相同", () => {
    const k0 = matchKeyOf("hi\r\n", [], 0);
    const k1 = matchKeyOf("hi", [], 1);
    expect(k0.textHash).toBe(k1.textHash); // CRLF 规范化后同 hash
    expect(k0.ordinal).toBe(0);
    expect(k1.ordinal).toBe(1);
  });
  it("同文本不同图：附件多重集不同→不同组（保重复次数）", () => {
    expect(attachmentIdentity(["a", "b"])).not.toBe(attachmentIdentity(["a", "b", "b"]));
    expect(attachmentIdentity(["a", "b"])).toBe(attachmentIdentity(["b", "a"])); // 序无关
  });
  it("规范化=字节级+CRLF→LF+首尾 trim，中间空白不动", () => {
    expect(normalizeText("  hi there \r\n")).toBe("hi there");
    expect(normalizeText("a  b")).toBe("a  b");
    expect(textHash("a b")).not.toBe(textHash("a  b"));
  });
});

describe("N18b：新终答≠天然归属证明（身份证据样例）", () => {
  it("歧义组内即使出现完整轮（U+A stop），无锚意图仍 unknown——新终答不解锁归属", () => {
    const t = "同文本";
    const entries: SessionEntry[] = [
      { entryId: "u1", role: "user", textHash: textHash(t), attachmentIdentity: "" },
      { entryId: "a1", role: "assistant", textHash: textHash(""), attachmentIdentity: "", stopReason: "stop" },
      { entryId: "u2", role: "user", textHash: textHash(t), attachmentIdentity: "" },
      { entryId: "a2", role: "assistant", textHash: textHash(""), attachmentIdentity: "", stopReason: "stop" },
    ];
    const mk = (id: string, ordinal: number, kind: "prompt" | "steer"): IntentRecord => ({
      intentId: id,
      sessionId: "s1",
      generation: 1,
      matchKey: matchKeyOf(t, [], ordinal),
      payload: { kind, rawText: t, attachments: [], sentAt: "" },
      sending: true,
      consumed: null,
      cancelled: false,
      lastVerdict: null,
    });
    const out = runRecovery({
      entries,
      intents: [mk("I1", 0, "prompt"), mk("I2", 1, "steer")],
      permanentExclusions: new Set(),
      alive: false,
      preconditions: PRE_OK,
    });
    // 组内两 sending 未收口+锚缺失→唯一关联不成立→组级 unknown（两个完整轮也不能指认归属）
    expect(out.verdicts.every((v) => v.state === "unknown")).toBe(true);
    expect(out.newConsumed.length).toBe(0);
  });
  it("解除歧义=新增身份证据：I1 有锚后组内仍歧义（I2 sending 无锚）——十三审③第一步第二步同门", () => {
    const t = "同文本";
    const entries = [
      { entryId: "u1", role: "user", textHash: textHash(t), attachmentIdentity: "" } as SessionEntry,
      {
        entryId: "a1",
        role: "assistant",
        textHash: textHash(""),
        attachmentIdentity: "",
        stopReason: "stop",
      } as SessionEntry,
      { entryId: "u2", role: "user", textHash: textHash(t), attachmentIdentity: "" } as SessionEntry,
      {
        entryId: "a2",
        role: "assistant",
        textHash: textHash(""),
        attachmentIdentity: "",
        stopReason: "stop",
      } as SessionEntry,
    ];
    const I1 = {
      intentId: "I1",
      sessionId: "s1",
      generation: 1,
      matchKey: matchKeyOf(t, [], 0),
      payload: { kind: "prompt" as const, rawText: t, attachments: [] as string[], sentAt: "" },
      sending: true,
      consumed: { anchorEntryId: "u1", intervalEnd: { entryId: "a1", lengthHash: "" } },
      cancelled: false,
      lastVerdict: null,
    } satisfies IntentRecord;
    const I2: IntentRecord = { ...I1, intentId: "I2", matchKey: matchKeyOf(t, [], 1), consumed: null, lastVerdict: null };
    const out = runRecovery({ entries, intents: [I1, I2], permanentExclusions: new Set(), alive: false , preconditions: PRE_OK});
    // I2 sending 无锚→组歧义→I1 自有证据也压为 unknown（占用证据≠身份证明）
    expect(out.verdicts.find((v) => v.intentId === "I1")?.state).toBe("unknown");
    expect(out.verdicts.find((v) => v.intentId === "I2")?.state).toBe("unknown");
  });
});
