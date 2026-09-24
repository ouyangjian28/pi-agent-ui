// 三审（R2 修复回审）六必修反例回归
import { describe, expect, it } from "vitest";
import {
  matchKeyOf,
  runRecovery,
  replayIntents,
  textHash,
  normalizeText,
  intervalToolCallsPaired,
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

describe("三审① clear 不改写历史终局（lastVerdict 保护）", () => {
  it("enqueue→consumed→delivered→clear 重放：终局保持 delivered，绝不被改写 cancelled", () => {
    const t = "任务A";
    const lines: JournalLine[] = [
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
      { t: "delivered", intentId: "A" },
      { t: "clear", sessionId: "s1", cleared: ["A"] },
    ];
    const replayed = replayIntents(lines, "s1");
    const A = replayed.get("A")!;
    expect(A.cancelled).toBe(true); // clear 行照记取消
    expect(A.lastVerdict).toBe("delivered"); // 终态行重放保留
    const out = run([e("u1", "user", t), e("a1", "assistant", "答", { stopReason: "stop" })], [A]);
    expect(vOf(out, "A")?.state).toBe("delivered"); // 分支③：不改写
  });
});

describe("三审② 历史 consumed 终点漂移耐久化（重放来的也追加更新行）", () => {
  it("首扫单 user 暂定→重放（终点 u1）→宿主补终答→二扫追加终点更新行（新终点 a1）", () => {
    const t = "任务A";
    const first = run([e("u1", "user", t)], [mkIntent("A", t, 0)]);
    expect(vOf(first, "A")).toHaveProperty("provisional", true);
    expect(first.newConsumed.length).toBe(1); // 首扫落锚 u1（终点=u1：单条目区间）
    // 持久化：首扫产物+sending 行落 journal → 重放
    const lines: JournalLine[] = [
      {
        t: "enqueue",
        intentId: "A",
        sessionId: "s1",
        generation: 1,
        leafId: "l1",
        matchKey: matchKeyOf(t, [], 0),
        payload: { kind: "prompt", rawText: t, attachments: [], sentAt: "" },
      },
      { t: "sending", intentId: "A" },
      ...first.newConsumed,
    ];
    const replayed = replayIntents(lines, "s1");
    const A = replayed.get("A")!;
    expect(A.consumed?.anchorEntryId).toBe("u1"); // 重放锚存在（三审 N18b 防御断言）
    expect(A.consumed?.intervalEnd.entryId).toBe("u1"); // 耐久终点=首扫时点值
    // 二扫：宿主补终答（终态非 sending——恢复态）
    const second = run(
      [e("u1", "user", t), e("a1", "assistant", "答", { stopReason: "stop" })],
      [{ ...A, sending: false }],
    );
    expect(vOf(second, "A")?.state).toBe("delivered");
    const upd = second.newConsumed.filter(
      (c) => c.t === "consumed" && (c as { intentId: string }).intentId === "A",
    ) as Extract<JournalLine, { t: "consumed" }>[];
    expect(upd.length).toBe(1); // 只追加终点更新行（不重复落锚行——锚已耐久）
    expect(upd[0]?.anchorEntryId).toBe("u1"); // 首锚不变
    expect(upd[0]?.intervalEnd.entryId).toBe("a1"); // 新终点耐久化
  });
});

describe("三审③ untrusted 锚不作可信分区", () => {
  it("审者反例：uA→aA(stop)→x(toolCall 无 result)→tail(stop)——B 错锚 x 判 untrusted，A 不被 x 切分区间救成 delivered", () => {
    const tA = "任务A";
    const tB = "任务B";
    const entries: SessionEntry[] = [
      e("uA", "user", tA),
      e("aA", "assistant", "答A", { stopReason: "stop" }),
      { entryId: "x", role: "toolCall", textHash: "", attachmentIdentity: "", toolCallId: "tc1" },
      e("tail", "assistant", "尾", { stopReason: "stop" }),
    ];
    const B = mkIntent("B", tB, 0, {
      sending: true,
      consumed: { anchorEntryId: "x", intervalEnd: { entryId: "tail", lengthHash: "" } }, // 错锚：x 非 user
    });
    const A = mkIntent("A", tA, 0);
    const out = run(entries, [A, B]);
    expect(vOf(out, "B")).toHaveProperty("untrusted", true); // B 锚验证失败（x 非 user）
    expect(vOf(out, "A")?.state).toBe("unknown"); // A 区间=[uA,尾]：x 未配对→②不满足→不得 delivered
    expect(out.watermarkAdvanceTo).toBeNull(); // untrusted 拦水位
  });
});

describe("三审④ 前置必填+超时语义统一", () => {
  it("前置失败输出=空水位+空消费记录（终裁拒绝完整形态）", () => {
    const t = "任务A";
    const out = run(
      [e("u1", "user", t), e("a1", "assistant", "答", { stopReason: "stop" })],
      [mkIntent("A", t, 0)],
      { watermarkValid: false },
    );
    expect(out.watermarkAdvanceTo).toBeNull();
    expect(out.newConsumed).toHaveLength(0);
    expect(out.verdicts.every((v) => v.state === "unknown")).toBe(true);
  });
  it("roundTimedOut=true 开终裁窗：运行态 sending 意图按恢复态歧义源判定（非 inflight 直推）", () => {
    const t = "同文本";
    const A = mkIntent("A", t, 0, { sending: true });
    const B = mkIntent("B", t, 1, { sending: true });
    // alive=true 但超时→等同恢复态：单 user 双意图=唯一关联不成立→组歧义
    const out = run([e("u1", "user", t)], [A, B], { roundTimedOut: true }, true);
    expect(vOf(out, "A")?.state).toBe("unknown");
    expect(vOf(out, "B")?.state).toBe("unknown");
    expect(out.newConsumed).toHaveLength(0); // 歧义禁落锚
  });
});

describe("三审⑥ R2-01 补类（附件不一致/跨组共享/锚缺失）+R2-05 直接断言", () => {
  it("附件身份不一致的锚→untrusted", () => {
    const t = "带附件任务";
    const A = mkIntent("A", t, 0, {
      matchKey: { ...matchKeyOf(t, [], 0), attachmentIdentity: "att:sha:abc" }, // 意图带附件
      consumed: { anchorEntryId: "u1", intervalEnd: { entryId: "a1", lengthHash: "" } },
    });
    const out = run([e("u1", "user", t), e("a1", "assistant", "答", { stopReason: "stop" })], [A]);
    expect(vOf(out, "A")).toHaveProperty("untrusted", true); // u1 的 attachmentIdentity=""≠"att:sha:abc"
  });
  it("跨组共享锚（不同文本两意图同锚）→双 untrusted", () => {
    const A = mkIntent("A", "文本一", 0, { consumed: { anchorEntryId: "u1", intervalEnd: { entryId: "a1", lengthHash: "" } } });
    const B = mkIntent("B", "文本二", 0, { consumed: { anchorEntryId: "u1", intervalEnd: { entryId: "a1", lengthHash: "" } } });
    const out = run(
      [e("u1", "user", "文本一"), e("u2", "user", "文本二"), e("a1", "assistant", "答", { stopReason: "stop" })],
      [A, B],
    );
    expect(vOf(out, "A")).toHaveProperty("untrusted", true);
    expect(vOf(out, "B")).toHaveProperty("untrusted", true);
  });
  it("锚缺失（不在投影）→untrusted+水位不跨越", () => {
    const A = mkIntent("A", "任务A", 0, { consumed: { anchorEntryId: "gone", intervalEnd: { entryId: "a1", lengthHash: "" } } });
    const out = run([e("u1", "user", "任务A"), e("a1", "assistant", "答", { stopReason: "stop" })], [A]);
    expect(vOf(out, "A")).toHaveProperty("untrusted", true);
    expect(out.watermarkAdvanceTo).toBeNull();
  });
  it("R2-05 直接断言：缺 toolCallId 的 toolResult→区间不闭合；corrupt 双表示→不闭合", () => {
    const base: SessionEntry[] = [
      e("u1", "user", "t"),
      { entryId: "r1", role: "toolResult", textHash: "", attachmentIdentity: "" }, // 无 toolCallId
      e("a1", "assistant", "答", { stopReason: "stop" }),
    ];
    expect(intervalToolCallsPaired(base, "u1", "a1")).toBe(false);
    const corruptA: SessionEntry[] = [
      e("u1", "user", "t"),
      { entryId: "c1", role: "toolCall", textHash: "", attachmentIdentity: "", toolCallId: "tc", corrupt: true },
      e("a1", "assistant", "答", { stopReason: "stop" }),
    ];
    expect(intervalToolCallsPaired(corruptA, "u1", "a1")).toBe(false);
    const corruptB: SessionEntry[] = [
      e("u1", "user", "t"),
      { entryId: "c1", role: "corrupt" as SessionEntry["role"], textHash: "", attachmentIdentity: "", toolCallId: "tc" },
      e("a1", "assistant", "答", { stopReason: "stop" }),
    ];
    expect(intervalToolCallsPaired(corruptB, "u1", "a1")).toBe(false);
  });
});

describe("三审⑥ R2-03 区间排他真命中（候选在他人既有 C 区间内）", () => {
  it("组内两 user：B 锚 u1 终点 a2（区间含 u2）→C 候选 u2 落 B 区间内→不落锚", () => {
    const t = "同文本";
    const B = mkIntent("B", t, 0, { consumed: { anchorEntryId: "u1", intervalEnd: { entryId: "a2", lengthHash: "" } } });
    const C = mkIntent("C", t, 1); // ordinal 1→候选 u2（组内存在，非超界）
    const out = run(
      [e("u1", "user", t), e("u2", "user", t), e("a2", "assistant", "答", { stopReason: "stop" })],
      [B, C],
    );
    expect(vOf(out, "C")?.state).toBe("unknown"); // 不得落锚到 u2（在 B 既有区间 [u1,a2] 内）
    expect(out.newConsumed.filter((c) => (c as { intentId: string }).intentId === "C")).toHaveLength(0);
    expect(vOf(out, "B")?.state).toBe("unknown"); // B 亦暂定：C 无法静止拖住③（反例Ⓒ保守语义——不误终局）
  });
});
