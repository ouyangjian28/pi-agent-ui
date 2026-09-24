// 四审（三审修复回审）五必修反例回归
import { describe, expect, it } from "vitest";
import {
  matchKeyOf,
  runRecovery,
  replayIntents,
  textHash,
  normalizeText,
  accountDomainClose,
  closeWithAcks,
  type IntentRecord,
  type JournalLine,
  type SessionEntry,
} from "@pi-agent-ui/protocol";

const PRE_OK = {
  watermarkValid: true as boolean,
  fileGenerationMatch: true as boolean,
  writerQuiesced: true as boolean,
  externalWriterLatched: false as boolean,
  roundTimedOut: false as boolean,
};

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
function e(id: string, role: SessionEntry["role"], text: string, extra: Partial<SessionEntry> = {}): SessionEntry {
  return { entryId: id, role, textHash: textHash(normalizeText(text)), attachmentIdentity: "", ...extra };
}
function run(entries: SessionEntry[], intents: IntentRecord[], pre?: Partial<typeof PRE_OK>, alive = false) {
  return runRecovery({
    entries,
    intents,
    permanentExclusions: new Set(),
    alive,
    preconditions: { ...PRE_OK, ...pre },
  });
}
const vOf = (out: { readonly verdicts: readonly { intentId: string; state: string }[] }, id: string) =>
  out.verdicts.find((v) => v.intentId === id);

describe("四审① 历史 delivered+clear 不授权新增尾部（证据定格）", () => {
  it("历史 delivered 区间不因尾部 x 扩展：无更新行+水位不被带跑", () => {
    const entries = [
      e("u1", "user", "文本A"),
      e("a1", "assistant", "答A", { stopReason: "stop" }),
      e("x", "assistant", "工具轮", { stopReason: "toolUse", toolCallId: "tc1" }), // 尾部：无 result 配对
    ];
    const lines: JournalLine[] = [
      {
        t: "enqueue",
        intentId: "A",
        sessionId: "s1",
        generation: 1,
        leafId: "l1",
        matchKey: matchKeyOf("文本A", [], 0),
        payload: { kind: "prompt", rawText: "文本A", attachments: [], sentAt: "" },
      },
      { t: "consumed", intentId: "A", anchorEntryId: "u1", intervalEnd: { entryId: "a1", lengthHash: "" } },
      { t: "delivered", intentId: "A" },
      { t: "clear", sessionId: "s1", cleared: ["A"] },
    ];
    const re = replayIntents(lines, "s1");
    expect(re.get("A")?.lastVerdict).toBe("delivered"); // 重放保留终局（lastVerdict=字符串联合）
    expect(re.get("A")?.cancelled).toBe(true); // clear 落 cancelled
    const out = run(entries, [re.get("A")!]);
    expect(vOf(out, "A")?.state).toBe("delivered"); // 历史终局如数输出
    expect(out.newConsumed).toHaveLength(0); // 无更新行：[u1,a1] 不扩展到 x
    expect(out.watermarkAdvanceTo).toBeNull(); // 水位不推到未经终检的 x
  });
});

describe("五审① 无 clear 的历史终局不降级（如数输出+证据定格）", () => {
  const t = "文本A";
  const mkJournal = (): JournalLine[] => [
    {
      t: "enqueue",
      intentId: "A",
      sessionId: "s1",
      generation: 1,
      leafId: "l1",
      matchKey: matchKeyOf(t, [], 0),
      payload: { kind: "prompt", rawText: t, attachments: [], sentAt: "" },
    },
    { t: "consumed", intentId: "A", anchorEntryId: "u1", intervalEnd: { entryId: "a1", lengthHash: "" } },
  ];
  it("delivered 无 clear：保持 delivered，不进待终检（不降级 unknown）", () => {
    const lines = [...mkJournal(), { t: "delivered", intentId: "A" } as JournalLine]; // 无 clear 行
    const A = replayIntents(lines, "s1").get("A")!;
    expect(A.lastVerdict).toBe("delivered");
    expect(A.cancelled).toBe(false);
    const out = run([e("u1", "user", t), e("a1", "assistant", "答", { stopReason: "stop" })], [A]);
    expect(vOf(out, "A")?.state).toBe("delivered"); // 五审反例：此前被降级 unknown「区间分配失败」
    expect(out.newConsumed).toHaveLength(0); // 无更新行
    expect(out.watermarkAdvanceTo).toBeNull(); // 不推水位（证据定格）
  });
  it("settled 无 clear：统一报 delivered（settled 蕴含执行终局）", () => {
    const lines = [...mkJournal(), { t: "settled", intentId: "A" } as JournalLine];
    const A = replayIntents(lines, "s1").get("A")!;
    expect(A.lastVerdict).toBe("settled");
    const out = run([e("u1", "user", t), e("a1", "assistant", "答", { stopReason: "stop" })], [A]);
    expect(vOf(out, "A")?.state).toBe("delivered"); // 恢复面统一口径
    expect(out.newConsumed).toHaveLength(0);
    expect(out.watermarkAdvanceTo).toBeNull();
  });
});

describe("六审① 历史终局+同组未收口 sending：歧义优先于直输出", () => {
  const t = "文本A";
  const histLines = (final: JournalLine): JournalLine[] => [
    {
      t: "enqueue",
      intentId: "A",
      sessionId: "s1",
      generation: 1,
      leafId: "l1",
      matchKey: matchKeyOf(t, [], 0),
      payload: { kind: "prompt", rawText: t, attachments: [], sentAt: "" },
    },
    { t: "consumed", intentId: "A", anchorEntryId: "u1", intervalEnd: { entryId: "a1", lengthHash: "" } },
    final,
  ];
  const mkB = (): IntentRecord => mkIntent("B", t, 1, { sending: true }); // 同文本组未收口 sending（无 consumed）
  it("delivered+B 同组 sending：A 不直输出，歧义判 unknown+untrusted", () => {
    const A = replayIntents(histLines({ t: "delivered", intentId: "A" }), "s1").get("A")!;
    const out = run([e("u1", "user", t), e("a1", "assistant", "答", { stopReason: "stop" })], [A, mkB()]);
    const vA = vOf(out, "A") as { state: string; untrusted?: boolean };
    expect(vA.state).toBe("unknown"); // 六审反例：此前直输出 delivered 绕过组歧义
    expect(vA.untrusted).toBe(true);
    expect(out.newConsumed).toHaveLength(0);
    expect(out.watermarkAdvanceTo).toBeNull();
  });
  it("settled+B 同组 sending：同判 unknown+untrusted", () => {
    const A = replayIntents(histLines({ t: "settled", intentId: "A" }), "s1").get("A")!;
    const out = run([e("u1", "user", t), e("a1", "assistant", "答", { stopReason: "stop" })], [A, mkB()]);
    expect((vOf(out, "A") as { untrusted?: boolean }).untrusted).toBe(true);
    expect(vOf(out, "A")?.state).toBe("unknown");
  });
});

describe("四审③ untrusted 不占候选排他位（第一遍预扫）", () => {
  const entries = [e("uA", "user", "文本A"), e("aA", "assistant", "答A", { stopReason: "stop" })];
  const mkBWrongAnchor = (): IntentRecord =>
    mkIntent("B", "文本B", 0, {
      consumed: { anchorEntryId: "uA", intervalEnd: { entryId: "aA", lengthHash: "" } }, // 错锚：B 的文本对不上 uA
    });
  it("顺序 [B,A]：B 错锚不挡 A 的合法候选", () => {
    const out = run(entries, [mkBWrongAnchor(), mkIntent("A", "文本A", 0)]);
    expect((vOf(out, "B") as { untrusted?: boolean }).untrusted).toBe(true);
    // 核心断言：B 的错锚不挡 A——A 仍落身份证据（四审反例=「A 无法落身份证据」）
    expect(out.newConsumed.filter((c) => c.t === "consumed").map((c) => (c as { intentId: string }).intentId)).toEqual(["A"]);
    expect((vOf(out, "A") as { untrusted?: boolean }).untrusted).not.toBe(true); // A 身份成立非不可信
  });
  it("顺序 [A,B]：交换顺序同样不挡", () => {
    const out = run(entries, [mkIntent("A", "文本A", 0), mkBWrongAnchor()]);
    expect(out.newConsumed.filter((c) => c.t === "consumed").map((c) => (c as { intentId: string }).intentId)).toEqual(["A"]); // 落锚不受顺序影响
    expect((vOf(out, "A") as { untrusted?: boolean }).untrusted).not.toBe(true);
    expect((vOf(out, "B") as { untrusted?: boolean }).untrusted).toBe(true);
  });
});

describe("四审④ 超时=开终裁窗（非全体暂定）", () => {
  const entries = [e("u1", "user", "文本1"), e("a1", "assistant", "答1", { stopReason: "stop" })];
  it("roundTimedOut=true：同文本组歧义判终裁 untrusted（非暂定拒绝）", () => {
    // 同文本组两意图+单 user 候选 → 组内歧义 → untrusted 终裁；若把超时加回阻断列→暂定（无 untrusted 标记）→断言失败
    const out = run(entries, [mkIntent("U1", "文本1", 0, { sending: true }), mkIntent("U2", "文本1", 1)], { roundTimedOut: true }, true);
    for (const id of ["U1", "U2"]) {
      const v = vOf(out, id) as { state: string; untrusted?: boolean };
      expect(v.state).toBe("unknown");
      expect(v.untrusted).toBe(true); // 终裁带标记=走了歧义判定（开终裁窗）；暂定拒绝无此标记
    }
    expect(out.newConsumed).toHaveLength(0);
  });
  it("roundTimedOut=true：单意图完整轮正例可 delivered（终裁窗内过四联）", () => {
    const out = run(entries, [mkIntent("U", "文本1", 0, { sending: true })], { roundTimedOut: true }, false);
    // alive=false（超时即停轮）+完整轮 [u1,a1]：①终答闭合②配对③静止④四联全过 → delivered
    expect(vOf(out, "U")?.state).toBe("delivered");
  });
});

describe("四审⑤ 通知 doneReason 断言补齐", () => {
  it("closeWithAcks 三 ACK 齐收口必带 doneReason='acks'", () => {
    const r = closeWithAcks("started", { channelAck: true, presentAck: true, effectAck: true });
    expect(r.closed).toBe(true);
    expect(r.doneReason).toBe("acks"); // 若删此字段赋值，断言失败
  });
  it("derived+outbox expired → accountDomainClose 映射账本域 done(reason=expired)", () => {
    const r = accountDomainClose("derived", "expired", null);
    expect(r.closed).toBe(true);
    expect(r.doneReason).toBe("expired"); // derived 账本态 + outbox expired 证据 → 跨域映射收口
  });
});
