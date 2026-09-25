// 3b-2a+3b2a-R5：journalToScanRows 投影器单测（纯逻辑）。
// R5 纪律：夹具全部合法 schema（kind∈INTENT_KINDS、consumed 带 intervalEnd 对象、clear 带 sessionId+cleared、
// response-timeout 带 commandId≥1）——非法输入单独用例断 corrupt，不再依赖「宽松缺省」。
import { describe, expect, it } from "vitest";
import { HISTORY_PREVIEW_LIMIT, journalToScanRows } from "@pi-agent-ui/protocol";
import type { ScanRow } from "@pi-agent-ui/protocol";

function enqueueLine(n: number, text = `msg-${n}`, ordinal = n): string {
  return JSON.stringify({
    t: "enqueue", intentId: `i-${n}`, sessionId: "s", generation: n, leafId: `L${n}`,
    matchKey: { textHash: `h${n}`, attachmentIdentity: "", ordinal },
    payload: { kind: "prompt", rawText: text, attachments: [], sentAt: "123" },
  });
}
function simple(t: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ t, ...extra });
}
function consumedLine(id = "i"): string {
  return JSON.stringify({ t: "consumed", intentId: id, anchorEntryId: "e", intervalEnd: { entryId: "e2", lengthHash: "lh" } });
}
function clearLine(): string {
  return JSON.stringify({ t: "clear", sessionId: "s", cleared: ["a", "b", "c"] });
}

describe("journalToScanRows（3b-2a 投影；R5 严格 schema）", () => {
  it("enqueue→turn-enqueued（preview/ordinal/generation/intentId/locator 全链）", () => {
    const rows = journalToScanRows(`${enqueueLine(1, "hello", 7)}\n`);
    expect(rows).toHaveLength(1);
    const r = rows[0] as ScanRow;
    expect(r.source).toBe("journal");
    expect(r.locator).toBe("1");
    expect(r.raw).toBe(enqueueLine(1, "hello", 7));
    expect(r.event).toMatchObject({ kind: "turn-enqueued", preview: { text: "hello", truncated: false }, ordinal: 7, generation: 1, intentId: "i-1", seq: 0, ts: null });
  });

  it("完整行集合各 kind 映射（sending/engaged/consumed/cancelled/delivered/settled/unknown/response-timeout/clear）", () => {
    const text = [
      simple("sending", { intentId: "i" }),
      simple("engaged", { intentId: "i" }),
      consumedLine(),
      simple("cancelled", { intentId: "i" }),
      simple("delivered", { intentId: "i" }),
      simple("settled", { intentId: "i" }),
      simple("unknown", { intentId: "i", reason: "x" }),
      simple("response-timeout", { intentId: "i", generation: 1, commandId: 42 }),
      clearLine(),
    ].join("\n") + "\n";
    const kinds = journalToScanRows(text).map((r) => r.event.kind);
    expect(kinds).toEqual([
      "sending", "turn-engaged", "turn-consumed", "turn-cancelled",
      "verdict-delivered", "verdict-settled", "verdict-unknown", "response-timeout", "clear",
    ]);
  });

  it("撕裂尾（无换行）不发布；补全换行后成行", () => {
    const torn = journalToScanRows(`${enqueueLine(1)}\n${enqueueLine(2)}`); // 第 2 行无 \n
    expect(torn).toHaveLength(1);
    const done = journalToScanRows(`${enqueueLine(1)}\n${enqueueLine(2)}\n`);
    expect(done).toHaveLength(2);
    expect(done[1]?.locator).toBe("2");
  });

  it("空文本=0 行；空行=journal-corrupt 占位（完整行不静默丢）", () => {
    expect(journalToScanRows("")).toEqual([]);
    const rows = journalToScanRows("\n\n");
    expect(rows.map((r) => r.event.kind)).toEqual(["journal-corrupt", "journal-corrupt"]);
    expect(rows[0]?.raw).toBe("");
  });

  it("坏完整行分型：JSON 解析失败/非对象/null/缺 t/未知 t→journal-corrupt", () => {
    const text = ["not-json", "123", "null", JSON.stringify({ x: 1 }), JSON.stringify({ t: "from-the-future" })].join("\n") + "\n";
    const rows = journalToScanRows(text);
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.event.kind === "journal-corrupt")).toBe(true);
    expect(rows[0]?.raw).toBe("not-json");
    // 缺 generation/intentId 的行：基底 null（不猜）
    expect(rows[3]?.event).toMatchObject({ kind: "journal-corrupt", generation: null, intentId: null });
  });

  it("R5/P1：schema 非法行→journal-corrupt 不抛错（严格校验与恢复侧同权威）", () => {
    const bad = [
      // P1 原：payload.rawText 非字符串（旧宽松解析抛 TypeError）
      JSON.stringify({ t: "enqueue", intentId: "i", sessionId: "s", generation: 1, leafId: "L", matchKey: { textHash: "h", attachmentIdentity: "", ordinal: 0 }, payload: { kind: "prompt", rawText: 123, attachments: [], sentAt: "x" } }),
      // P1b 原：sending intentId 非字符串（流入事件）
      simple("sending", { intentId: {} }),
      // enqueue 缺 payload/matchKey/leafId 等必需字段
      simple("enqueue", { intentId: "i", sessionId: "s", generation: 1 }),
      // generation 非法（0=小于 1）
      simple("enqueue", { intentId: "i", sessionId: "s", generation: 0, leafId: "L", matchKey: { textHash: "h", attachmentIdentity: "", ordinal: 0 }, payload: { kind: "prompt", rawText: "x", attachments: [], sentAt: "1" } }),
      // payload.kind 不在白名单
      JSON.stringify({ t: "enqueue", intentId: "i", sessionId: "s", generation: 1, leafId: "L", matchKey: { textHash: "h", attachmentIdentity: "", ordinal: 0 }, payload: { kind: "user", rawText: "x", attachments: [], sentAt: "1" } }),
      // consumed intervalEnd 非对象
      simple("consumed", { intentId: "i", anchorEntryId: "e", intervalEnd: 5 }),
      // clear 缺 sessionId / cleared 非数组
      simple("clear", { cleared: ["a"] }),
      simple("clear", { sessionId: "s", cleared: "a" }),
      // response-timeout 缺 commandId / commandId=0
      simple("response-timeout", { intentId: "i", generation: 1 }),
      simple("response-timeout", { intentId: "i", generation: 1, commandId: 0 }),
      // unknown 缺 reason
      simple("unknown", { intentId: "i" }),
      // matchKey.ordinal 负数
      JSON.stringify({ t: "enqueue", intentId: "i", sessionId: "s", generation: 1, leafId: "L", matchKey: { textHash: "h", attachmentIdentity: "", ordinal: -1 }, payload: { kind: "prompt", rawText: "x", attachments: [], sentAt: "1" } }),
      // attachments 元素非字符串
      JSON.stringify({ t: "enqueue", intentId: "i", sessionId: "s", generation: 1, leafId: "L", matchKey: { textHash: "h", attachmentIdentity: "", ordinal: 0 }, payload: { kind: "prompt", rawText: "x", attachments: [1], sentAt: "1" } }),
    ];
    const rows = journalToScanRows(bad.join("\n") + "\n");
    expect(rows).toHaveLength(bad.length);
    expect(rows.every((r) => r.event.kind === "journal-corrupt")).toBe(true); // 全部判坏、零异常、零漏投影
  });

  it("R5：未知行型不猜语义（未来版本行保守 corrupt）", () => {
    const rows = journalToScanRows(`${JSON.stringify({ t: "new-thing", intentId: "i" })}\n`);
    expect(rows[0]?.event.kind).toBe("journal-corrupt");
  });

  it("合法行容忍额外字段（前向兼容：多余键不判坏）", () => {
    const rows = journalToScanRows(`${simple("sending", { intentId: "i", extra: 1 })}\n`);
    expect(rows[0]?.event.kind).toBe("sending");
  });

  it("preview 截断到 HISTORY_PREVIEW_LIMIT（200）", () => {
    const long = "x".repeat(600);
    const rows = journalToScanRows(`${enqueueLine(1, long)}\n`);
    const preview = (rows[0]?.event as unknown as { preview: { text: string; truncated: boolean } }).preview;
    expect(preview.text.length).toBe(HISTORY_PREVIEW_LIMIT);
    expect(preview.truncated).toBe(true);
  });

  it("行号定位：坏行也占行号（locator 连续）", () => {
    const text = [`garbage`, enqueueLine(1), enqueueLine(2)].join("\n") + "\n";
    const rows = journalToScanRows(text);
    expect(rows.map((r) => r.locator)).toEqual(["1", "2", "3"]);
    expect(rows.map((r) => r.event.kind)).toEqual(["journal-corrupt", "turn-enqueued", "turn-enqueued"]);
  });

  it("跨行序完整性：100 行→100 行、locator 单调", () => {
    const text = Array.from({ length: 100 }, (_, i) => enqueueLine(i + 1)).join("\n") + "\n";
    const rows = journalToScanRows(text);
    expect(rows).toHaveLength(100);
    for (let i = 0; i < 100; i++) expect(rows[i]?.locator).toBe(String(i + 1));
  });

  it("同文本不同两行=两行各自投影（去重归源 diff，不归投影）", () => {
    const same = enqueueLine(5, "dup");
    const rows = journalToScanRows(`${same}\n${same}\n`);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.event).toMatchObject({ kind: "turn-enqueued", preview: { text: "dup", truncated: false } });
    expect(rows[1]?.locator).toBe("2");
  });

  it("sanitize 面：控制字符被剥后进 preview", () => {
    const rows = journalToScanRows(`${enqueueLine(1, "a\u0000b\u0007c")}\n`);
    expect((rows[0]?.event as unknown as { preview: { text: string } }).preview.text).toBe("abc");
  });

  it("baseEvent 只认行内字段（跨行不串扰）", () => {
    const rows = journalToScanRows(`${enqueueLine(1)}\n${simple("sending", { intentId: "i2" })}\n`);
    expect(rows[0]?.event).toMatchObject({ generation: 1, intentId: "i-1" });
    expect(rows[1]?.event).toMatchObject({ generation: null, intentId: "i2" });
  });

  it("R5 与恢复侧同权威：journalLineSchemaError 直接对照（同输入同判定）", async () => {
    const { journalLineSchemaError } = await import("@pi-agent-ui/protocol");
    const bad = JSON.parse(simple("sending", { intentId: {} })) as Record<string, unknown>;
    expect(journalLineSchemaError(bad)).toContain("intentId");
    const good = JSON.parse(simple("sending", { intentId: "i" })) as Record<string, unknown>;
    expect(journalLineSchemaError(good)).toBeNull();
  });
});
