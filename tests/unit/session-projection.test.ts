// 3b-2b①：session-projection 纯函数单测（契约 §3.5 C3-R04）。
// 反例集设计（对照 PROJECT 3b-2b 冻结案①）：
// - 行分类三分：message/corrupt-entry（不可解析/缺 id/角色非法）/unknown-line（可解析非 message）
// - 撕裂尾不发布；空行=完整行不可解析→corrupt
// - locator=字节偏移（多字节字符稳定性）；同行多事件有序（本体先+toolCall 块序）
// - 归因：user 三元组（textHash/附件/ordinal 按序消费）+区间面（含锚自身回退）+孤儿 toolResult=null
// - final 映射全表+补全角色；预览脱敏（密码遮蔽走 sanitizer）+截断 200
import { describe, expect, it } from "vitest";
import { SESSION_PREVIEW_LIMIT, fnv1a64Hex, matchKeyOf, sessionToScanRows, type SessionEnqueueRef } from "@pi-agent-ui/protocol";
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
