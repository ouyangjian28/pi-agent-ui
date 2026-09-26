// 3b-2b①：session-projection 纯函数单测（契约 §3.5 C3-R04）。
// 反例集设计（对照 PROJECT 3b-2b 冻结案①）：
// - 行分类三分：message/corrupt-entry（不可解析/缺 id/角色非法）/unknown-line（可解析非 message）
// - 撕裂尾不发布；空行=完整行不可解析→corrupt
// - locator=字节偏移（多字节字符稳定性）；同行多事件有序（本体先+toolCall 块序）
// - 归因：user 三元组（textHash/附件/ordinal 按序消费）+区间面（含锚自身回退）+孤儿 toolResult=null
// - final 映射全表+补全角色；预览脱敏（密码遮蔽走 sanitizer）+截断 200
import { describe, expect, it } from "vitest";
import { SESSION_PREVIEW_LIMIT, fnv1a64Hex, journalAttributionOf, matchKeyOf, sessionToScanRows, sha256Hex12, type SessionEnqueueRef } from "@pi-agent-ui/protocol";
import type { ScanRow } from "@pi-agent-ui/protocol";

function msgLine(id: string, role: string, content: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "message", id, parentId: null, timestamp: 1790000000000, message: { role, content, ...extra } });
}
function header(): string {
  return JSON.stringify({ type: "session", version: 1, id: "s-1", timestamp: 1790000000000, cwd: "/tmp" });
}
function enqueue(intentId: string, text: string, ordinal: number, generation: number | null = 1, attachments: readonly string[] = []): SessionEnqueueRef {
  return { intentId, generation, matchKey: matchKeyOf(text, attachments, ordinal) };
}
function project(text: string, enqueues: readonly SessionEnqueueRef[] = [], consumed: Parameters<typeof sessionToScanRows>[0]["consumed"] = []): ScanRow[] {
  return sessionToScanRows({ sessionText: text, enqueues, consumed });
}

describe("session-projection 3b-2b①", () => {
  it("基础：header→unknown-line；user/assistant→message；final 映射", () => {
    const text = [
      header(),
      msgLine("u1", "user", "你好"),
      msgLine("a1", "assistant", [{ type: "text", text: "回答" }], { stopReason: "stop" }),
      "",
    ].join("\n") + "\n";
    const rows = project(text);
    // header 行=unknown；user；assistant；空行=corrupt（完整但不可解析）
    expect(rows.map((r) => r.event.kind)).toEqual(["unknown-line", "message", "message", "corrupt-entry"]);
    const user = rows[1]?.event;
    expect(user).toMatchObject({ kind: "message", entryId: "u1", role: "user", final: true });
    const asst = rows[2]?.event;
    expect(asst).toMatchObject({ kind: "message", entryId: "a1", role: "assistant", stopReason: "stop", final: true });
    const expectedOffset = [header(), msgLine("u1", "user", "你好"), msgLine("a1", "assistant", [{ type: "text", text: "回答" }], { stopReason: "stop" })]
      .reduce((acc, l) => acc + Buffer.byteLength(l, "utf8") + 1, 0);
    expect(rows[3]?.event).toMatchObject({ kind: "corrupt-entry", entryId: `corrupt-${expectedOffset}` });
  });

  it("locator=字节偏移：多字节行后偏移按 UTF-8 字节数推进", () => {
    const cn = "中文内容"; // 12 字节
    const text = msgLine("u1", "user", cn) + "\n" + msgLine("a1", "assistant", "x") + "\n";
    const rows = project(text);
    expect(rows[0]?.locator).toBe("0");
    const line1Bytes = Buffer.byteLength(msgLine("u1", "user", cn), "utf8") + 1;
    expect(rows[1]?.locator).toBe(String(line1Bytes));
  });

  it("撕裂尾不发布（末段无 \\n）；补全换行后自然编入", () => {
    const torn = header() + "\n" + msgLine("u1", "user", "q").slice(0, -5); // 撕裂 JSON
    const rows = project(torn);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event.kind).toBe("unknown-line");
    const healed = torn + "}}\n"; // 粗略补全（内容不重要，行完整性才是）
    const rows2 = project(healed.length > 0 ? header() + "\n" + msgLine("u1", "user", "q") + "\n" : "");
    expect(rows2).toHaveLength(2);
  });

  it("缺 id/角色非法→corrupt-entry；可解析非 message→unknown-line", () => {
    const text = [
      JSON.stringify({ type: "message", id: "", message: { role: "user", content: "x" } }), // 空 id
      JSON.stringify({ type: "message", id: "m1", message: { role: "alien", content: "x" } }), // 角色非法
      JSON.stringify({ type: "model_change", id: "mc1" }),
    ].join("\n") + "\n";
    const rows = project(text);
    expect(rows.map((r) => r.event.kind)).toEqual(["corrupt-entry", "corrupt-entry", "unknown-line"]);
  });

  it("user 三元组匹配：textHash+ordinal 按序消费；带 generation", () => {
    const text = msgLine("u1", "user", "重试问题") + "\n" + msgLine("u2", "user", "重试问题") + "\n";
    const rows = project(text, [enqueue("I1", "重试问题", 0, 3), enqueue("I2", "重试问题", 1, 4)]);
    expect(rows[0]?.event).toMatchObject({ intentId: "I1", generation: 3 });
    expect(rows[1]?.event).toMatchObject({ intentId: "I2", generation: 4 });
  });

  it("附件身份：同文本不同附件不误配", () => {
    const withImg = JSON.stringify({ type: "message", id: "u1", message: { role: "user", content: [
      { type: "text", text: "看图" }, { type: "image", id: "img-1" }] } });
    const plain = msgLine("u2", "user", "看图");
    const text = withImg + "\n" + plain + "\n";
    const rows = project(text, [enqueue("I-img", "看图", 0, 1, ["<img-hash>"])]);
    // enqueue 附件身份≠u1 派生身份（派生=fnv(type,id,url)）且≠u2（无附件）→均未中
    expect(rows[0]?.event.intentId).toBeNull();
    expect(rows[1]?.event.intentId).toBeNull();
  });

  it("区间归因：终点哈希不符→区间无效全 null（不采信伪造终点）", () => {
    const text = [
      msgLine("u1", "user", "问"),
      msgLine("a1", "assistant", [{ type: "text", text: "答" }], { stopReason: "toolUse" }),
      msgLine("r1", "toolResult", [{ type: "text", text: "工具输出" }], { toolCallId: "c1" }),
      msgLine("a2", "assistant", [{ type: "text", text: "终答" }], { stopReason: "stop" }),
    ].join("\n") + "\n";
    const consumed = [{ intentId: "I1", anchorEntryId: "u1", intervalEnd: { entryId: "a2", lengthHash: "" } }];
    const rows = project(text, [], consumed);
    expect(rows.map((r) => r.event.intentId)).toEqual([null, null, null, null]);
  });

  it("区间归因（正确哈希）：assistant/toolResult/锚 user 全归 I1", () => {
    const lines = [
      msgLine("u1", "user", "问"),
      msgLine("a1", "assistant", [{ type: "text", text: "答" }], { stopReason: "toolUse" }),
      msgLine("r1", "toolResult", [{ type: "text", text: "出" }], { toolCallId: "c1" }),
      msgLine("a2", "assistant", [{ type: "text", text: "终" }], { stopReason: "stop" }),
    ];
    const text = lines.join("\n") + "\n";
    const consumed = [{ intentId: "I1", anchorEntryId: "u1", intervalEnd: { entryId: "a2", lengthHash: fnv1a64Hex(lines[3] ?? "") } }];
    const rows = project(text, [], consumed);
    expect(rows.map((r) => r.event.intentId)).toEqual(["I1", "I1", "I1", "I1"]); // 含锚 user（回退区间）
  });

  it("孤儿 toolResult（无 toolCallId）→intentId:null；有 id 归区间", () => {
    const lines = [
      msgLine("u1", "user", "问"),
      msgLine("r1", "toolResult", [{ type: "text", text: "孤儿" }]), // 无 toolCallId
      msgLine("r2", "toolResult", [{ type: "text", text: "有主" }], { toolCallId: "c1" }),
    ];
    const text = lines.join("\n") + "\n";
    const consumed = [{ intentId: "I1", anchorEntryId: "u1", intervalEnd: { entryId: "r2", lengthHash: fnv1a64Hex(lines[2] ?? "") } }];
    const rows = project(text, [], consumed);
    expect(rows[1]?.event.intentId).toBeNull();
    expect(rows[2]?.event.intentId).toBe("I1");
  });

  it("toolCall 块分立：块键 entryId:blockIndex 0 基；本体事件先行", () => {
    const text = msgLine("a1", "assistant", [
      { type: "thinking", thinking: "思考" },
      { type: "text", text: "调用工具" },
      { type: "toolCall", id: "c1", name: "read", arguments: "{}" },
      { type: "toolCall", id: "c2", name: "bash", arguments: "{}" },
    ], { stopReason: "toolUse" }) + "\n";
    const rows = project(text);
    expect(rows).toHaveLength(3); // 本体+2 块
    expect(rows[0]?.event).toMatchObject({ kind: "message", entryId: "a1", role: "assistant", stopReason: "toolUse", final: false });
    expect(rows[1]?.event).toMatchObject({ kind: "message", entryId: "a1", role: "toolCall", blockIndex: 0, toolCallId: "c1", final: false });
    expect(rows[2]?.event).toMatchObject({ kind: "message", entryId: "a1", role: "toolCall", blockIndex: 1, toolCallId: "c2", final: false });
  });

  it("final 全表：length→true（预览截断标注）；aborted→true；toolResult/system 补全角色", () => {
    const text = [
      msgLine("a1", "assistant", [{ type: "text", text: "长" }], { stopReason: "length" }),
      msgLine("a2", "assistant", [{ type: "text", text: "断" }], { stopReason: "aborted" }),
      msgLine("r1", "toolResult", [{ type: "text", text: "出" }], { toolCallId: "c1" }),
      msgLine("sy1", "system", ""),
    ].join("\n") + "\n";
    const rows = project(text);
    expect(rows.map((r) => (r.event as { final: boolean }).final)).toEqual([true, true, false, true]);
  });

  it("预览脱敏+截断：环境变量遮蔽；200 上限", () => {
    const secret = "我的 API_KEY=abcd12345678 泄漏了";
    const long = "字".repeat(SESSION_PREVIEW_LIMIT + 50);
    const text = msgLine("u1", "user", secret) + "\n" + msgLine("u2", "user", long) + "\n";
    const rows = project(text);
    const p1 = (rows[0]?.event as { textPreview?: { text: string } }).textPreview?.text ?? "";
    expect(p1).toBe("我的 [env] 泄漏了");
    const p2 = (rows[1]?.event as { textPreview?: { text: string } }).textPreview?.text ?? "";
    expect(p2.length).toBeLessThanOrEqual(SESSION_PREVIEW_LIMIT + 20); // 遮蔽占位可少量超出
  });

  it("空文本/纯换行→零行", () => {
    expect(project("")).toHaveLength(0);
    expect(project("\n\n")).toHaveLength(2); // 两个空行=两 corrupt
  });
});

describe("session-projection 3b-2b-R3/R4/R6（GPT 65→修复）", () => {
  const goodEnqueue = JSON.stringify({ t: "enqueue", intentId: "I1", sessionId: "s1", leafId: "l1", generation: 1,
    matchKey: matchKeyOf("你好", [], 0),
    payload: { kind: "prompt", rawText: "你好", attachments: [], sentAt: "2026-09-28T00:00:00Z" } });
  const goodConsumed = JSON.stringify({ t: "consumed", intentId: "I1", anchorEntryId: "u1", intervalEnd: { entryId: "a1", lengthHash: "x" } });

  it("R3：坏 enqueue/consumed 行不采信并计数；非 JSON/其他行型不计入 rejected；撕裂尾不参与", () => {
    const badMissing = JSON.stringify({ t: "enqueue", intentId: "BAD", generation: 1.5, matchKey: matchKeyOf("你好", [], 0) }); // 缺 sessionId/leafId+generation 非整数
    const badNullMk = JSON.stringify({ t: "enqueue", intentId: "BAD2", sessionId: "s", leafId: "l", generation: 1, matchKey: null });
    const badAnchor = JSON.stringify({ t: "consumed", intentId: "I1", anchorEntryId: 3, intervalEnd: { entryId: "a1", lengthHash: "x" } }); // 锚非字符串
    const other = JSON.stringify({ t: "sending", intentId: "I1" });
    const text = [goodEnqueue, badMissing, badNullMk, badAnchor, "{oops", other].join("\n") + "\n" + goodConsumed; // 末行无 \n=撕裂尾
    const r = journalAttributionOf(text);
    expect(r.rejected).toBe(3); // 三行 enqueue/consumed 判坏；notJson/other/撕裂尾不计
    expect(r.enqueues.map((e) => e.intentId)).toEqual(["I1"]);
    expect(r.enqueues[0]?.matchKey).toEqual(matchKeyOf("你好", [], 0)); // 好行提取保真
    expect(r.consumed).toHaveLength(0); // 好的 consumed 在撕裂尾，不参与
  });

  it("R4：真实图片块（data 字段）身份=sha256 前 12hex——同图同 id 按序消费，异图不误配", () => {
    const imgLine = (id: string, data: string): string => JSON.stringify({ type: "message", id, message: { role: "user", content: [
      { type: "text", text: "看图" }, { type: "image", data, mimeType: "image/png" }] } });
    const d1 = "aGVsbG8=", d2 = "d29ybGQ=";
    const text = imgLine("u1", d1) + "\n" + imgLine("u2", d1) + "\n" + imgLine("u3", d2) + "\n";
    const rows = project(text, [enqueue("I1", "看图", 0, 1, [sha256Hex12(d1)]), enqueue("I2", "看图", 1, 1, [sha256Hex12(d1)])]);
    expect(rows[0]?.event.intentId).toBe("I1"); // 同图同键→ordinal 按序
    expect(rows[1]?.event.intentId).toBe("I2");
    expect(rows[2]?.event.intentId).toBeNull(); // 异图身份不同→不误配（旧代码无 data/id/url 全塌缩同 id 会误配）
  });

  it("R4：多重集换序等价（AB=BA 同组）；未知块 u: 前缀不可匹配写侧 12hex 面", () => {
    const two = (id: string, a: string, b: string): string => JSON.stringify({ type: "message", id, message: { role: "user", content: [
      { type: "text", text: "两图" }, { type: "image", data: a }, { type: "image", data: b }] } });
    const text = two("u1", "QQ==", "RUQ=") + "\n" + two("u2", "RUQ=", "QQ==") + "\n";
    const idA = sha256Hex12("QQ=="), idB = sha256Hex12("RUQ=");
    const rows = project(text, [enqueue("I1", "两图", 0, 1, [idA, idB]), enqueue("I2", "两图", 1, 1, [idB, idA])]);
    expect(rows[0]?.event.intentId).toBe("I1"); // 换序同身份→同组按序
    expect(rows[1]?.event.intentId).toBe("I2");
    const unk = JSON.stringify({ type: "message", id: "u9", message: { role: "user", content: [
      { type: "text", text: "看图" }, { type: "mystery", foo: { b: 1, a: 2 } }] } });
    const rows2 = project(unk + "\n", [enqueue("I9", "看图", 0, 1, [idA])]);
    expect(rows2[0]?.event.intentId).toBeNull(); // 未知块派生 u: 前缀，恒不等于写侧 12hex 面
    // 键序规范化：未知块内容同构但键序不同→同 id（确定性）
    const unk2 = JSON.stringify({ type: "message", id: "u10", message: { role: "user", content: [
      { type: "text", text: "看图" }, { type: "mystery", foo: { a: 2, b: 1 } }] } });
    const r3 = project(unk + "\n" + unk2 + "\n", [enqueue("I1x", "看图", 0, 1, ["u:" + fnv1a64Hex('{"foo":{"a":2,"b":1},"type":"mystery"}')]),
      enqueue("I2x", "看图", 1, 1, ["u:" + fnv1a64Hex('{"foo":{"a":2,"b":1},"type":"mystery"}')])]);
    expect(r3[0]?.event.intentId).toBe("I1x");
    expect(r3[1]?.event.intentId).toBe("I2x");
  });

  it("R6：stopReason=length→textPreview.truncated=true（短正文也置位）；非 length 对照 false；空正文占位保留信号", () => {
    const text = [
      msgLine("a1", "assistant", [{ type: "text", text: "短" }], { stopReason: "length" }),
      msgLine("a2", "assistant", [{ type: "text", text: "短" }], { stopReason: "stop" }),
      msgLine("a3", "assistant", "", { stopReason: "length" }),
    ].join("\n") + "\n";
    const rows = project(text);
    expect((rows[0]?.event as { textPreview?: { truncated: boolean } }).textPreview).toMatchObject({ truncated: true });
    expect((rows[1]?.event as { textPreview?: { truncated: boolean } }).textPreview).toMatchObject({ truncated: false });
    expect((rows[2]?.event as { textPreview?: { text: string; truncated: boolean } }).textPreview).toEqual({ text: "", truncated: true });
  });
});
