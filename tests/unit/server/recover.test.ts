// recover.ts 受控单测（切片4c）：撕裂尾/坏行/判据分档——变异面（真 pi E2E 只作接线证据）。
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJournalFile, buildRecoverReport, recoverFromJournal } from "../../../apps/server/src/runtime/recover.js";
import type { BadJournalEntry } from "../../../apps/server/src/runtime/recover.js";
import type { JournalLine } from "@pi-agent-ui/protocol";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function writeJournal(lines: readonly string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "recover-"));
  dirs.push(dir);
  const p = join(dir, "journal.jsonl");
  await writeFile(p, lines.join("\n"), "utf8");
  return p;
}

const enq = (id: string): string =>
  JSON.stringify({ t: "enqueue", intentId: id, sessionId: "s1", generation: 1, leafId: `leaf-${id}`, matchKey: { textHash: `h-${id}`, attachmentIdentity: "", ordinal: 0 }, payload: { kind: "prompt", rawText: id, attachments: [], sentAt: "t" } });

describe("recover（恢复入口受控面）", () => {
  it("完整两轮（enqueue/sending/settled）：无坏行、两轮已结算、无效果未知、不阻断", async () => {
    const p = await writeJournal([enq("i-1"), '{"t":"sending","intentId":"i-1"}', '{"t":"settled","intentId":"i-1"}', enq("i-2"), '{"t":"sending","intentId":"i-2"}', '{"t":"settled","intentId":"i-2"}', ""]);
    const r = await recoverFromJournal(p, "s1");
    expect(r.bad).toEqual([]);
    expect(r.blocked).toBe(false);
    expect(r.intents.map((x) => x.intentId)).toEqual(["i-1", "i-2"]);
    expect(r.settledCount).toBe(2);
    expect(r.unknownEffect).toEqual([]);
    expect(r.resumable).toEqual([]);
  });

  it("撕裂尾：末段无换行→partialTail 坏行、好行保留（写入中断=效果未知面）", async () => {
    const p = await writeJournal([enq("i-1"), '{"t":"sending","intentId":"i-1"']);
    // writeFile 用 \n join：末段=半行 JSON 无尾换行
    const r = await readJournalFile(p);
    expect(r.lines.map((l) => (l as { t: string }).t)).toEqual(["enqueue"]); // sending 半行不入好行
    expect(r.bad).toHaveLength(1);
    expect(r.bad[0]?.partialTail).toBe(true);
    expect(r.bad[0]?.raw).toContain("sending");
  });

  it("R1：enqueue 完整+sending 撕裂尾→阻断恢复授权（blocked+resumable 空）+残片可关联→效果未知", async () => {
    const p = await writeJournal([enq("i-1"), '{"t":"sending","intentId":"i-1"']);
    const r = await recoverFromJournal(p, "s1");
    expect(r.blocked).toBe(true);
    expect(r.resumable).toEqual([]); // 识别了坏尾≠已处理其影响：不给出任何重发授权
    expect(r.unknownEffect).toEqual(["i-1"]); // 残片可靠关联→保守证据并入
  });

  it("R1b：残片不可关联（撕裂断在 intentId 前）→阻断依旧、不臆造效果未知", async () => {
    const p = await writeJournal([enq("i-1"), '{"t":"send']);
    const r = await recoverFromJournal(p, "s1");
    expect(r.blocked).toBe(true);
    expect(r.resumable).toEqual([]);
    expect(r.unknownEffect).toEqual([]); // 提取不到意图身份→不并入（blocked 已全局阻断）
  });

  it("R1c：截尾修复后重读须携带先前残片证据（不能把「证据不存在」解释为「从未发送」）", async () => {
    const p = await writeJournal([enq("i-1"), '{"t":"sending","intentId":"i-1"']);
    const r1 = await recoverFromJournal(p, "s1");
    expect(r1.blocked).toBe(true);
    expect(r1.unknownEffect).toEqual(["i-1"]);
    const buf = await readFile(p);
    await truncate(p, buf.lastIndexOf(0x0a) + 1); // 宿主截尾修复（字节索引）
    const r2 = await readJournalFile(p);
    expect(r2.bad).toEqual([]);
    // 修复后重读：无参传递 prior bad→残片证据丢失，i-1 会被误判「可重发」（反例演示）
    const naive = buildRecoverReport(r2.lines, "s1");
    expect(naive.resumable).toEqual(["i-1"]); // ← 这就是 GPT 红线：裸截尾后直接授权=错
    // 正确流程：携带修复前残片证据+显式解除阻断→保守呈现不变
    const fixed = buildRecoverReport(r2.lines, "s1", { fragments: r1.bad, blocked: false });
    expect(fixed.blocked).toBe(false);
    expect(fixed.unknownEffect).toEqual(["i-1"]);
    expect(fixed.resumable).toEqual([]);
  });

  it("坏行分型：完整行但 JSON 损坏/无 t 字段→partialTail=false；空行跳过不判坏", async () => {
    const p = await writeJournal([enq("i-1"), '{"broken": ', '{"t":123}', "", '{"t":"sending","intentId":"i-1"}', '{"t":"settled","intentId":"i-1"}', ""]);
    const r = await readJournalFile(p);
    expect(r.lines.map((l) => (l as { t: string }).t)).toEqual(["enqueue", "sending", "settled"]);
    expect(r.bad).toHaveLength(2);
    expect(r.bad.map((b) => b.partialTail)).toEqual([false, false]);
    expect(r.bad[0]?.error).toContain("JSON 解析失败");
    expect(r.bad[1]?.error).toContain("无 t 字段");
  });

  it("R2：schema 损坏拒收（可解析但非法行型不进重放不抛异常）", async () => {
    const p = await writeJournal([
      '{"t":"clear","sessionId":"s1"}', // 缺 cleared（GPT 探针：旧版抛 line.cleared is not iterable）
      '{"t":"enqueue","intentId":"i-9","sessionId":"s1","generation":"bad","leafId":"l","matchKey":{},"payload":{}}', // generation 字符串
      '{"t":"sending"}', // 缺 intentId
      '{"t":"response-timeout","intentId":"i-1","generation":1}', // 缺 commandId
      '{"t":"future-proof"}', // 未知行型
      enq("i-1"),
      '{"t":"sending","intentId":"i-1"}',
      '{"t":"settled","intentId":"i-1"}',
      "",
    ]);
    const r = await recoverFromJournal(p, "s1");
    expect(r.bad.map((b) => b.error)).toEqual([
      "schema 损坏：缺字段/错类型 cleared",
      "schema 损坏：缺字段/错类型 generation",
      "schema 损坏：缺字段/错类型 intentId",
      "schema 损坏：缺字段/错类型 commandId",
      "schema 损坏：未知行型 future-proof",
    ]);
    expect(r.intents.map((x) => x.intentId)).toEqual(["i-1"]); // 好行照常重放
    expect(r.settledCount).toBe(1);
    expect(r.blocked).toBe(true); // 有 schema 坏行→仍阻断（修复/裁决后再授权）
    expect(r.resumable).toEqual([]);
  });

  it("效果未知三分档：sending 无终态/超时未结算/已判 unknown；非 sending 无终态=可重发", async () => {
    const lines: JournalLine[] = [
      JSON.parse(enq("i-1")) as JournalLine,
      { t: "sending", intentId: "i-1" }, // 写后中断：sending 无终态
      JSON.parse(enq("i-2")) as JournalLine,
      { t: "sending", intentId: "i-2" },
      { t: "response-timeout", intentId: "i-2", generation: 1, commandId: 2 }, // 超时未结算
      JSON.parse(enq("i-3")) as JournalLine,
      { t: "sending", intentId: "i-3" },
      { t: "unknown", intentId: "i-3", reason: "写后中断" }, // 已判 unknown
      JSON.parse(enq("i-4")) as JournalLine, // 受理未发送：resumable
    ];
    const r = buildRecoverReport(lines, "s1");
    expect(r.unknownEffect).toEqual(["i-1", "i-2", "i-3"]);
    expect(r.resumable).toEqual(["i-4"]);
    expect(r.settledCount).toBe(0);
    expect(r.blocked).toBe(false);
  });

  it("会话过滤：他 session 的 enqueue 不进重放（跨会话 journal 隔离）", async () => {
    const other = JSON.parse(enq("i-x")) as { sessionId: string } & JournalLine;
    other.sessionId = "other";
    const lines: JournalLine[] = [other as JournalLine, JSON.parse(enq("i-1")) as JournalLine];
    const r = buildRecoverReport(lines, "s1");
    expect(r.intents.map((x) => x.intentId)).toEqual(["i-1"]);
  });

  it("前提演示：非 enqueue 行无会话身份——同文件另一 session 的终态行可越界结算同 id 意图（输入前提=每会话独立 journal 文件，由组装层保证）", () => {
    // 本例展示风险面：journal 文件与会话一一对应是 recover 正确性的输入前提（非 enqueue 行不携会话身份）。
    // 构造：s1 的 enqueue(i-1) 与 s2 视角的 settled(i-1) 共存于同一文件。
    const lines: JournalLine[] = [JSON.parse(enq("i-1")) as JournalLine, { t: "settled", intentId: "i-1" }];
    const r2 = buildRecoverReport(lines, "s2"); // s2 视角：自己无 enqueue，但若 s2 也有同 id enqueue 则会被越界结算
    expect(r2.intents).toEqual([]); // 本构造下 s2 无 enqueue→终态行无处归依；前提本身由 RpcSession 每会话一 journalPath 保证
  });

  it("sending+cancelled：取消挡重发，但不抹此前发送副作用未知的呈现（拆 GPT 第四节1：不再泛化「cancelled 不算效果未知」）", () => {
    const lines: JournalLine[] = [
      JSON.parse(enq("i-1")) as JournalLine,
      { t: "sending", intentId: "i-1" },
      { t: "cancelled", intentId: "i-1" }, // 发送后取消：副作用可能已发生
    ];
    const r = buildRecoverReport(lines, "s1");
    expect(r.unknownEffect).toEqual(["i-1"]); // 此前发送效果未知→保守呈现
    expect(r.resumable).toEqual([]); // 取消是终局：不重发
  });

  it("cancelled/delivered 终态：未发送的 cancelled 与已 delivered 均不进效果未知也不进可重发", async () => {
    const lines: JournalLine[] = [
      JSON.parse(enq("i-1")) as JournalLine,
      { t: "cancelled", intentId: "i-1" },
      JSON.parse(enq("i-2")) as JournalLine,
      { t: "sending", intentId: "i-2" },
      { t: "delivered", intentId: "i-2" },
    ];
    const r = buildRecoverReport(lines, "s1");
    expect(r.unknownEffect).toEqual([]); // cancelled/delivered 均有终局
    expect(r.resumable).toEqual([]);
  });

  // ---- s4f F1：不可关联残片=恢复范围级阻断（盘面修复≠重发裁决）；转义 ID 解码；宿主显式归因 ----

  it("F1a：不可关联 sending 残片（{\"t\":\"send）→修复后续读（blocked=false）resumable 仍恒空+unattributableFragments 呈现；显式归因后解锁", () => {
    const enqueue: JournalLine = {
      t: "enqueue",
      intentId: "i-1",
      sessionId: "s1",
      generation: 1,
      leafId: "l1",
      matchKey: { textHash: "h", attachmentIdentity: "", ordinal: 0 },
      payload: { kind: "prompt", rawText: "x", attachments: [], sentAt: "t" },
    };
    const frag: BadJournalEntry = { raw: '{"t":"send', error: "撕裂尾", partialTail: true };
    // 修复后续读：盘面已截齐（好行）+携残片证据+blocked:false——不可关联→恢复范围级阻断
    const r = buildRecoverReport([enqueue], "s1", { fragments: [frag], blocked: false });
    expect(r.blocked).toBe(false);
    expect(r.unattributableFragments).toEqual([frag]); // 呈现交宿主裁决
    expect(r.resumable).toEqual([]); // 不可关联→不给任何重发授权（两证分离）
    // 宿主人工调查后显式归因到已知意图→并入 unknown+阻断解除
    const r2 = buildRecoverReport([enqueue], "s1", {
      fragments: [frag],
      blocked: false,
      attributedFragments: [{ raw: frag.raw, intentId: "i-1" }],
    });
    expect(r2.unattributableFragments).toEqual([]);
    expect(r2.unknownEffect).toEqual(["i-1"]);
    expect(r2.resumable).toEqual([]); // i-1 已发送（残片归因）→仍不可重发
  });

  it("F1b：残片 intentId 为 JSON 转义（\\u0069-1=i-1）→字面量解码后正确关联（裸正则提取会漏）", () => {
    const enqueue: JournalLine = {
      t: "enqueue",
      intentId: "i-1",
      sessionId: "s1",
      generation: 1,
      leafId: "l1",
      matchKey: { textHash: "h", attachmentIdentity: "", ordinal: 0 },
      payload: { kind: "prompt", rawText: "x", attachments: [], sentAt: "t" },
    };
    // raw 原文含转义序列（非解码后的 i-1）——合法 JSON 字符串身份
    const frag: BadJournalEntry = { raw: '{"t":"sending","intentId":"\\u0069-1"', error: "撕裂尾", partialTail: true };
    const r = buildRecoverReport([enqueue], "s1", { fragments: [frag], blocked: false });
    expect(r.unattributableFragments).toEqual([]); // 解码成功→可关联
    expect(r.unknownEffect).toEqual(["i-1"]);
  });

  it("F1c：归因不在场（raw 不匹配任何残片）→忽略，阻断保留", () => {
    const enqueue: JournalLine = {
      t: "enqueue",
      intentId: "i-1",
      sessionId: "s1",
      generation: 1,
      leafId: "l1",
      matchKey: { textHash: "h", attachmentIdentity: "", ordinal: 0 },
      payload: { kind: "prompt", rawText: "x", attachments: [], sentAt: "t" },
    };
    const frag: BadJournalEntry = { raw: '{"t":"send', error: "撕裂尾", partialTail: true };
    const r = buildRecoverReport([enqueue], "s1", {
      fragments: [frag],
      blocked: false,
      attributedFragments: [{ raw: '{"t":"resp', intentId: "i-1" }], // 不在场的 raw
    });
    expect(r.unattributableFragments).toEqual([frag]);
    expect(r.resumable).toEqual([]);
  });

  it("F2：嵌套结构校验（payload={}/matchKey=[]/cleared=[42]/intervalEnd=[]/kind 非法/attachments 元素非字符串/ordinal 非整数→拒收不进重放）", async () => {
    const goodEnq = JSON.parse(enq("i-1")) as Record<string, unknown>;
    const p = await writeJournal([
      JSON.stringify({ ...goodEnq, payload: {} }), // payload 缺四字段（GPT 探针：旧版照常 resumable）
      JSON.stringify({ ...goodEnq, matchKey: [] }), // 数组冒充对象
      JSON.stringify({ ...goodEnq, payload: { ...(goodEnq.payload as object), kind: "nope" } }), // kind 非枚举
      JSON.stringify({ ...goodEnq, payload: { ...(goodEnq.payload as object), attachments: [1] } }), // 元素非字符串
      JSON.stringify({ ...goodEnq, matchKey: { ...(goodEnq.matchKey as object), ordinal: 1.5 } }), // 非整数
      '{"t":"clear","sessionId":"s1","cleared":[42]}', // cleared 元素非字符串（旧版静默略过）
      '{"t":"consumed","intentId":"i-1","anchorEntryId":"a","intervalEnd":[]}', // intervalEnd 数组冒充
      enq("i-1"),
      '{"t":"settled","intentId":"i-1"}',
      "",
    ]);
    const r = await readJournalFile(p);
    expect(r.lines.map((l) => (l as { t: string }).t)).toEqual(["enqueue", "settled"]); // 嵌套非法全拒收
    expect(r.bad).toHaveLength(7);
    expect(r.bad.every((b) => b.error.includes("嵌套非法"))).toBe(true);
    expect(r.bad.map((b) => b.error)).toEqual([
      "schema 损坏：嵌套非法 payload.kind", // payload={}：kind 检查先于 rawText（首报 kind）
      "schema 损坏：嵌套非法 matchKey",
      "schema 损坏：嵌套非法 payload.kind",
      "schema 损坏：嵌套非法 payload.attachments",
      "schema 损坏：嵌套非法 matchKey.ordinal",
      "schema 损坏：嵌套非法 cleared（元素须字符串）",
      "schema 损坏：嵌套非法 intervalEnd",
    ]);
  });
});
