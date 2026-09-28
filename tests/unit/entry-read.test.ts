// D4 批①（服务端读面·纯逻辑面）：docs/d4-fulltext-design.md v5.1 §5 W-d4-s* 面。
// 覆盖：ts 三件（ISO/数字回退 null/坏串 null）；thinking 门控两态（事件 hasThinking+entry 帧
// thinking 块+blockCount 可见口径）；stats 计数同源；entryBlocksOf 四形+denylist（嵌套/大小写）
// +toolResult 正文 sanitizeText 路+argsPreview 512 编码后字节；ReadIndex entryOf 登记
// （首见为准/system 不登/corrupt·unknown 天然不登）；assembleEntryFrame 两段式预算
// （ok/truncated/终判实测上界≤32_768/末块不可切尽仍超→oversized 基例/成功帧无 oversized 态/
// truncated 帧线上无 rawBytes 字段断言/truncatedAt 代码单元切位/中文多块有内容）。
import { describe, expect, it } from "vitest";
import {
  ENTRY_ARGS_PREVIEW_MAX_BYTES,
  LIMITS,
  ReadIndex,
  assembleEntryFrame,
  byteLenUtf8,
  entryBlocksOf,
  estimateFrameBytes,
  sessionToScanRows,
  type EntryBlock,
} from "@pi-agent-ui/protocol";

function msgLine(id: string, role: string, content: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "message", id, parentId: null, timestamp: "2026-10-10T12:00:00.000Z", message: { role, content, ...extra } });
}
function msgLineTs(id: string, role: string, content: unknown, ts: unknown): string {
  return JSON.stringify({ type: "message", id, parentId: null, timestamp: ts, message: { role, content } });
}
function project(text: string, thinkingVisible?: boolean) {
  return sessionToScanRows({ sessionText: text, enqueues: [], consumed: [], ...(thinkingVisible === true ? { thinkingVisible: true } : {}) });
}

describe("D4 §4.1a ts 三件", () => {
  it("ISO 字符串 timestamp→epoch ms；同一行多事件共享 ts", () => {
    const line = msgLine("a1", "assistant", [{ type: "text", text: "x" }, { type: "toolCall", id: "c1", name: "read", arguments: "{}" }]);
    const rows = project(`${line}\n`);
    expect(rows).toHaveLength(2); // 本体+toolCall 子事件
    expect(rows[0]?.event.kind === "message" && rows[0].event.ts).toBe(Date.parse("2026-10-10T12:00:00.000Z"));
    expect(rows[1]?.event.ts).toBe(Date.parse("2026-10-10T12:00:00.000Z"));
  });
  it("数字 timestamp→null（非字符串不采信）；坏 ISO 串→null 不抛", () => {
    const n = project(`${msgLineTs("a", "assistant", "x", 1790000000000)}\n`);
    expect(n[0]?.event.ts).toBeNull();
    const bad = project(`${msgLineTs("b", "assistant", "x", "not-a-date")}\n`);
    expect(bad[0]?.event.ts).toBeNull();
  });
});

describe("D4 §4.5a thinking 门控两态（事件面）", () => {
  const content = [
    { type: "thinking", text: "内心独白", thinkingSignature: "sig-never-out" },
    { type: "text", text: "回答" },
  ];
  const line = () => `${msgLine("a1", "assistant", content, { stopReason: "stop" })}\n`;

  it("门关（默认）：无 hasThinking；blockCount=可见口径（不含 thinking）", () => {
    const rows = project(line());
    const ev = rows[0]?.event;
    expect(ev && ev.kind === "message" && "hasThinking" in ev).toBe(false);
    expect(ev && ev.kind === "message" && ev.blockCount).toBe(1); // 仅 text 可见
  });
  it("门开且 thinkingCount>0：hasThinking:true；blockCount 仍可见口径", () => {
    const rows = project(line(), true);
    const ev = rows[0]?.event;
    expect(ev && ev.kind === "message" && ev.hasThinking).toBe(true);
    expect(ev && ev.kind === "message" && ev.blockCount).toBe(1);
  });
  it("门开但 thinkingCount=0：不置 hasThinking", () => {
    const rows = project(`${msgLine("a2", "assistant", [{ type: "text", text: "纯文本" }, { type: "toolCall", id: "c", name: "t", arguments: "{}" }], { stopReason: "stop" })}\n`, true);
    expect(rows[0]?.event.kind === "message" && "hasThinking" in (rows[0].event as object)).toBe(false);
    expect(rows[0]?.event.kind === "message" && rows[0].event.blockCount).toBe(2);
  });
  it("toolCall 子事件与本体同值（blockCount/hasThinking）", () => {
    const rows = project(`${msgLine("a3", "assistant", content.concat([{ type: "toolCall", id: "c9", name: "grep", arguments: "{}" }]), { stopReason: "toolUse" })}\n`, true);
    const sub = rows[1]?.event;
    expect(sub && sub.kind === "message" && sub.role === "toolCall" && sub.hasThinking).toBe(true);
    expect(sub && sub.kind === "message" && sub.blockCount).toBe(2); // text+toolCall
  });
});

describe("D4 §4.1a entryBlocksOf 投影+净化", () => {
  it("四形：text/thinking（门开）/toolCall（id+name+argsPreview）/attachment；thinkingSignature 永不投", () => {
    const content = [
      { type: "text", text: "正文" },
      { type: "thinking", text: "独白", thinkingSignature: "sig" },
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "/x" } },
      { type: "image", data: "base64data", mimeType: "image/png" },
    ];
    const blocks = entryBlocksOf(content, { thinkingVisible: true });
    expect(blocks.map((b) => b.kind)).toEqual(["text", "thinking", "toolCall", "attachment"]);
    const tc = blocks[2];
    expect(tc && tc.kind === "toolCall" && tc.toolCallId).toBe("c1");
    expect(tc && tc.kind === "toolCall" && tc.toolName).toBe("read");
    expect(tc && tc.kind === "toolCall" && tc.argsPreview).toBe(JSON.stringify({ path: "/x" }));
    expect(JSON.stringify(blocks)).not.toContain("sig"); // thinkingSignature 不投
    // attachment=attachmentIdOfBlock 派生（sha256(data) 前 12hex），不回原始 base64
    const at = blocks[3];
    expect(at && at.kind === "attachment" && /^[0-9a-f]{12}$/.test(at.attachmentId)).toBe(true);
    expect(JSON.stringify(blocks)).not.toContain("base64data");
  });
  it("门关：零 thinking 块（存在性不泄露）", () => {
    const blocks = entryBlocksOf([{ type: "thinking", text: "隐藏" }], { thinkingVisible: false });
    expect(blocks).toEqual([]);
  });
  it("denylist：嵌套键+大小写不敏感→[redacted]；无关键名不误伤", () => {
    const args = { ApiKey: "sk-live-123", nested: { session_TOKEN: "abc", note: "keep" }, path: "/ok" };
    const blocks = entryBlocksOf([{ type: "toolCall", id: "c", name: "t", arguments: args }], { thinkingVisible: false });
    const pv = blocks[0] && blocks[0].kind === "toolCall" ? blocks[0].argsPreview : "";
    expect(pv).toContain("[redacted]");
    expect(pv).not.toContain("sk-live-123");
    expect(pv).not.toContain("abc");
    expect(pv).toContain("keep");
    expect(pv).toContain("/ok");
  });
  it("toolResult 正文路：sanitizeText 秘密遮蔽（无键名纯文本）；assistant 文本不套", () => {
    const tr = entryBlocksOf([{ type: "text", text: "password=hunter2secret leaked" }], { thinkingVisible: false, role: "toolResult" });
    expect(tr[0] && tr[0].kind === "text" && tr[0].text).not.toContain("hunter2secret");
    const asst = entryBlocksOf([{ type: "text", text: "password=hunter2secret" }], { thinkingVisible: false, role: "assistant" });
    expect(asst[0] && asst[0].kind === "text" && asst[0].text).toContain("hunter2secret"); // 两路设计：仅 toolResult 套
  });
  it("argsPreview 512 编码后字节（中文 3B/字）；截断置 argsTruncated", () => {
    const long = "密".repeat(400); // 1200 UTF-8 字节 > 512
    const blocks = entryBlocksOf([{ type: "toolCall", id: "c", name: "t", arguments: { q: long } }], { thinkingVisible: false });
    const tc = blocks[0];
    expect(tc && tc.kind === "toolCall" && byteLenUtf8(tc.argsPreview) <= ENTRY_ARGS_PREVIEW_MAX_BYTES).toBe(true);
    expect(tc && tc.kind === "toolCall" && tc.argsTruncated).toBe(true);
    // 未超：无 argsTruncated 字段
    const small = entryBlocksOf([{ type: "toolCall", id: "c", name: "t", arguments: { q: "短" } }], { thinkingVisible: false });
    expect(small[0] && small[0].kind === "toolCall" && "argsTruncated" in small[0]).toBe(false);
  });
});

describe("D4 §4.2 ReadIndex.entryOf 登记", () => {
  const idx = () => new ReadIndex("f.jsonl", "st-1");
  const msgEv = (entryId: string, role: "user" | "assistant" | "system" = "assistant") =>
    ({ kind: "message", seq: 0, ts: 1, generation: null, intentId: null, entryId, role, final: true }) as const;

  it("message 登记+查询；重复 entryId 首见为准（locator 不被后见覆盖）", () => {
    const i = idx();
    i.append("session", "10", "r1", msgEv("e1"));
    i.append("session", "20", "r2", msgEv("e1")); // 同 entryId 再现
    const hit = i.entryOf("session", "e1");
    expect(hit?.locator).toBe("10");
    expect(hit?.digest).toBeTruthy();
  });
  it("system 不登（姿态继承：请求 system entryId=unknown-entry）；非 message 不登", () => {
    const i = idx();
    i.append("session", "10", "r1", msgEv("s1", "system"));
    i.append("session", "20", "r2", { kind: "unknown-line", seq: 0, ts: null, generation: null, intentId: null });
    i.append("session", "30", "r3", { kind: "corrupt-entry", seq: 0, ts: null, generation: null, intentId: null, entryId: "corrupt-30" });
    expect(i.entryOf("session", "s1")).toBeUndefined();
    expect(i.entryOf("session", "corrupt-30")).toBeUndefined();
  });
  it("源隔离：同 entryId 不同源不串", () => {
    const i = idx();
    i.append("journal", "5", "rj", msgEv("e9"));
    expect(i.entryOf("session", "e9")).toBeUndefined();
    expect(i.entryOf("journal", "e9")?.source).toBe("journal");
  });
});

describe("D4 §4.1b assembleEntryFrame 两段式预算", () => {
  const base = { requestId: "req-1", entryId: "e-1", digest: "fnv1a64:0123456789abcdef" };
  const text = (n: number, s = "a"): EntryBlock => ({ kind: "text", text: s.repeat(n) });

  it("ok 基例：全块装入；rawBytes 携带；totalBlockCount=总口径", () => {
    const r = assembleEntryFrame({ ...base, blocks: [text(10), { kind: "attachment", attachmentId: "abc123" }], stopReason: "stop", rawBytes: 42 });
    expect(r.oversized).toBeUndefined();
    if (r.frame) {
      expect(r.frame.state).toBe("ok");
      expect(r.frame.rawBytes).toBe(42);
      expect(r.frame.totalBlockCount).toBe(2);
      expect(r.frame.stopReason).toBe("stop");
      expect(estimateFrameBytes(r.frame) <= LIMITS.singleEventBytes).toBe(true);
    }
  });
  it("truncated：超预算→state=truncated；被截块记 truncatedAt（代码单元切位）；其后块省略但计数；rawBytes 字段线上缺席", () => {
    const blocks = [text(40_000), text(100), text(100)]; // 粗估 30_720B 内第一块即截
    const r = assembleEntryFrame({ ...base, blocks, rawBytes: 40_300 });
    if (!r.frame) throw new Error("expect frame");
    expect(r.frame.state).toBe("truncated");
    expect("rawBytes" in r.frame).toBe(false); // wire 级缺席（P2-N1'）
    expect(JSON.stringify(r.frame)).not.toContain("rawBytes");
    expect(r.frame.blocks).toHaveLength(1); // 其后块省略
    expect(r.frame.totalBlockCount).toBe(3); // 总口径
    const b0 = r.frame.blocks[0];
    expect(b0 && b0.kind === "text" && b0.truncatedAt !== undefined && b0.truncatedAt > 0).toBe(true);
    expect(estimateFrameBytes(r.frame) <= LIMITS.singleEventBytes).toBe(true); // 终判实测
  });
  it("中文多块有内容：截断不切到空", () => {
    const blocks = [text(5, "字"), text(20_000, "字"), text(50, "字")];
    const r = assembleEntryFrame({ ...base, blocks, rawBytes: 60_120 });
    if (!r.frame) throw new Error("expect frame");
    const joined = r.frame.blocks.map((b) => (b.kind === "text" ? b.text : "")).join("");
    expect(joined.length).toBeGreaterThan(5); // 中文多块有内容（非空壳）
    expect(r.frame.state).toBe("truncated");
  });
  it("终判实测上界：50% 换行+控制字符恶意行终判后仍 ≤32_768B", () => {
    const evil = ("x\ny\u0000\u0001z\t\n".repeat(30_000)); // JSON 转义膨胀素材（\n→2B、控制符→6B）
    const r = assembleEntryFrame({ ...base, blocks: [{ kind: "text", text: evil }], rawBytes: evil.length });
    if (!r.frame) throw new Error("expect frame");
    expect(estimateFrameBytes(r.frame) <= LIMITS.singleEventBytes).toBe(true);
  });
  it("末块切空仍超→显式 oversized 基例（全部不可切块：toolCall-only 超装）", () => {
    const blocks: EntryBlock[] = Array.from({ length: 64 }, (_, i) => ({
      kind: "toolCall", toolCallId: `c${i}`, toolName: "t",
      argsPreview: "z".repeat(500), // 64×500=32_000B>粗估 30_720→首装即截断；终判无 text/thinking 可切
    }));
    const r = assembleEntryFrame({ ...base, blocks, rawBytes: 40_000 });
    expect(r.oversized).toBe(true); // 4414 reason=oversized 专用出口
  });
  it("成功帧永无 oversized 态（state 联合仅 ok|truncated）", () => {
    const r = assembleEntryFrame({ ...base, blocks: [text(100)], rawBytes: 100 });
    if (!r.frame) throw new Error("expect frame");
    expect(r.frame.state === "ok" || r.frame.state === "truncated").toBe(true);
  });
});
