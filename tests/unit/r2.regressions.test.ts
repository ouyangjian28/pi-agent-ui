// 二审 R2-01~07 回归（真实样例：不手填 consumed/不改 sending 绕门——任务 3 要求）
import { describe, expect, it } from "vitest";
import { matchKeyOf, runRecovery, textHash, normalizeText, replayIntents } from "@pi-agent-ui/protocol";
import type { IntentRecord, JournalLine, SessionEntry } from "@pi-agent-ui/protocol";

const PRE_OK = { watermarkValid: true, fileGenerationMatch: true, writerQuiesced: true, externalWriterLatched: false, roundTimedOut: false } as const;

function mkIntent(id: string, text: string, ordinal: number, opts: Partial<IntentRecord> = {}): IntentRecord {
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
    lastVerdict: opts.lastVerdict ?? null,
  };
}
function e(id: string, role: SessionEntry["role"], text: string, stopReason?: SessionEntry["stopReason"]): SessionEntry {
  return {
    entryId: id,
    role,
    textHash: textHash(normalizeText(text)),
    attachmentIdentity: "",
    ...(stopReason !== undefined ? { stopReason } : {}),
  };
}
function run(
  entries: SessionEntry[],
  intents: IntentRecord[],
  opts?: { alive?: boolean; P?: Set<string>; pre?: Parameters<typeof runRecovery>[0]["preconditions"] },
) {
  return runRecovery({
    entries,
    intents,
    permanentExclusions: opts?.P ?? new Set(),
    alive: opts?.alive ?? false,
    preconditions: opts?.pre ?? PRE_OK,
  } satisfies Parameters<typeof runRecovery>[0]);
}
function verdictOf(out: { readonly verdicts: readonly { intentId: string; state: string; reason?: string }[] }, id: string) {
  return out.verdicts.find((v) => v.intentId === id);
}
const consumedAnchor = (entryId: string): { anchorEntryId: string; intervalEnd: { entryId: string; lengthHash: string } } => ({
  anchorEntryId: entryId,
  intervalEnd: { entryId, lengthHash: "" },
});

describe("R2-01 既有锚同验证（不得绕过身份门）", () => {
  it("既有锚指向 assistant 条目→unknown+untrusted，绝不 delivered", () => {
    const t = "任务A";
    const A = mkIntent("A", t, 0, { consumed: consumedAnchor("a1") }); // 锚=assistant！
    const out = run([e("u1", "user", t), e("a1", "assistant", "答", "stop")], [A]);
    expect(verdictOf(out, "A")?.state).toBe("unknown");
    expect(verdictOf(out, "A")).toHaveProperty("untrusted", true);
    expect(out.watermarkAdvanceTo).toBeNull(); // untrusted 禁推水位
  });
  it("既有锚文本与意图 matchKey 不一致（错组）→unknown+untrusted", () => {
    const A = mkIntent("A", "意图文本", 0, { consumed: consumedAnchor("u1") });
    // u1 是别的文本的 user 条目
    const out = run([e("u1", "user", "完全不同的文本"), e("a1", "assistant", "答", "stop")], [A]);
    expect(verdictOf(out, "A")?.state).toBe("unknown");
    expect(verdictOf(out, "A")).toHaveProperty("untrusted", true);
  });
});

describe("R2-03 排他与水位不可信证据", () => {
  it("区间终答在永久排除集 P 中→不作①证据→unknown", () => {
    const t = "任务A";
    const out = run([e("u1", "user", t), e("a1", "assistant", "答", "stop")], [mkIntent("A", t, 0)], {
      P: new Set(["a1"]), // 终答被 GC 转储
    });
    expect(verdictOf(out, "A")?.state).toBe("unknown");
  });
  it("候选落在他人既有 C 区间内→不落新锚（不吞证据）", () => {
    const t = "同文本";
    // B 既有 C=[u1,a1]；C 无锚匹配——候选 u1 在 B 区间内
    const B = mkIntent("B", t, 0, { consumed: { anchorEntryId: "u1", intervalEnd: { entryId: "a1", lengthHash: "" } } });
    const C = mkIntent("C", t, 1);
    const out = run([e("u1", "user", t), e("a1", "assistant", "答", "stop")], [B, C]);
    expect(verdictOf(out, "C")?.state).toBe("unknown"); // 不得落锚到 u1（在 B 区间内）
    expect(out.newConsumed.filter((c) => (c as { intentId: string }).intentId === "C")).toHaveLength(0);
  });
  it("冲突锚双 unknown 时水位不推进（untrusted 拦）", () => {
    const t = "同文本";
    const A = mkIntent("A", t, 0, { consumed: consumedAnchor("e1") });
    const B = mkIntent("B", t, 1, { consumed: consumedAnchor("e1") }); // 冲突
    const out = run([e("e1", "user", t), e("a1", "assistant", "答", "stop")], [A, B]);
    expect(verdictOf(out, "A")?.state).toBe("unknown");
    expect(out.watermarkAdvanceTo).toBeNull();
  });
});

describe("R2-07 前置条件显式门", () => {
  it("水位身份验证失败→全部暂定（终裁拒绝）", () => {
    const t = "任务A";
    const out = run([e("u1", "user", t), e("a1", "assistant", "答", "stop")], [mkIntent("A", t, 0)], {
      pre: { watermarkValid: false, fileGenerationMatch: true, writerQuiesced: true, externalWriterLatched: false, roundTimedOut: false },
    });
    expect(verdictOf(out, "A")?.state).toBe("unknown");
    expect(verdictOf(out, "A")).toHaveProperty("provisional", true);
    expect(verdictOf(out, "A")?.reason).toContain("前置不满足");
  });
  it("外部写者闩→永暂定", () => {
    const t = "任务A";
    const out = run([e("u1", "user", t), e("a1", "assistant", "答", "stop")], [mkIntent("A", t, 0)], {
      pre: { watermarkValid: true, fileGenerationMatch: true, writerQuiesced: true, externalWriterLatched: true, roundTimedOut: false },
    });
    expect(verdictOf(out, "A")).toHaveProperty("provisional", true);
  });
  it("恢复态写者未静止→暂定（alive=false 不再是终裁默契授权）", () => {
    const t = "任务A";
    const out = run([e("u1", "user", t), e("a1", "assistant", "答", "stop")], [mkIntent("A", t, 0)], {
      pre: { watermarkValid: true, fileGenerationMatch: true, writerQuiesced: false, externalWriterLatched: false, roundTimedOut: false },
    });
    expect(verdictOf(out, "A")).toHaveProperty("provisional", true);
  });
});

describe("R2-04 clear 行重放接通", () => {
  it("journal 层：enqueue→sending→clear 行重放→cancelled=true（非预填布尔）", () => {
    const lines: JournalLine[] = [
      { t: "enqueue", intentId: "i1", sessionId: "s1", generation: 1, leafId: "l1", matchKey: matchKeyOf("任务", [], 0), payload: { kind: "prompt", rawText: "任务", attachments: [], sentAt: "" } },
      { t: "enqueue", intentId: "i2", sessionId: "s1", generation: 1, leafId: "l1", matchKey: matchKeyOf("任务二", [], 0), payload: { kind: "prompt", rawText: "任务二", attachments: [], sentAt: "" } },
      { t: "sending", intentId: "i1" },
      { t: "clear", sessionId: "s1", cleared: ["i1", "i2"] },
    ];
    const m = replayIntents(lines, "s1");
    expect(m.get("i1")?.cancelled).toBe(true);
    expect(m.get("i2")?.cancelled).toBe(true);
  });
  it("recovery 层：cancelled 意图恰一 verdict（组内多意图不漏判）", () => {
    const t = "同文本";
    const A = mkIntent("A", t, 0, { cancelled: true });
    const B = mkIntent("B", t, 1);
    const C = mkIntent("C", t, 2);
    const out = run([e("e1", "user", t), e("a1", "assistant", "答", "stop")], [A, B, C]);
    const count = out.verdicts.filter((v) => v.intentId === "A").length;
    expect(count).toBe(1); // 恰一（R2-04 三意图组漏判修）
    expect(verdictOf(out, "A")?.state).toBe("cancelled");
  });
});

describe("N18 连扫两次不造锚（真实样例：同一歧义输入两次，不手填）", () => {
  it("恢复态 sending 双意图一 user 条目→两次扫描 verdict 一致+锚为空", () => {
    const t = "同文本";
    const intents = [mkIntent("A", t, 0, { sending: true }), mkIntent("B", t, 1, { sending: true })];
    const entries = [e("e1", "user", t)]; // 只有一条 user（数量短缺+恢复态 sending=歧义源）
    const out1 = run(entries, intents);
    const out2 = run(entries, intents); // 连扫第二次（不喂第一次产物）
    expect(verdictOf(out1, "A")?.state).toBe("unknown");
    expect(verdictOf(out1, "B")?.state).toBe("unknown");
    expect(out1.newConsumed).toHaveLength(0); // 禁落锚
    expect(out2.verdicts).toEqual(out1.verdicts); // 幂等一致
    expect(out2.newConsumed).toHaveLength(0);
  });
});

describe("N18b 全链正向样例（二审任务 3：首扫产物→journal 重放→二扫，不手填 consumed）", () => {
  it("首扫落行持久化→replayIntents 重放→二扫与手填口径同判（sending 恢复态）", () => {
    const t = "任务A";
    const first = run([e("u1", "user", t)], [mkIntent("A", t, 0, { sending: true })]);
    expect(verdictOf(first, "A")).toHaveProperty("provisional", true); // 单 user 无终答→①不满足暂定
    const secondEntries = [e("u1", "user", t), e("a1", "assistant", "答", "stop")];
    // 持久化链：首扫 newConsumed 落 journal →（宿主补终答）→重放重建意图
    const journalLines: JournalLine[] = [
      {
        t: "enqueue",
        intentId: "A",
        sessionId: "s1",
        generation: 1,
        leafId: "l1",
        matchKey: first.verdicts[0] ? matchKeyOf(t, [], 0) : matchKeyOf(t, [], 0),
        payload: { kind: "prompt", rawText: t, attachments: [], sentAt: "" },
      },
      ...first.newConsumed,
    ];
    const replayed = replayIntents(journalLines, "s1");
    const A2: IntentRecord = { ...replayed.get("A")!, sending: true };
    const second = run(secondEntries, [A2]);
    expect(verdictOf(second, "A")?.state).toBe("delivered"); // 终答补齐后终检过
  });
});
