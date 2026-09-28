// D1 直播面聚合器单元（设计稿 docs/d1-live-stream-design.md §6 W-d1-2..6）。
// delivered 过滤（W-d1-1）在 composition 接线层——本文件不覆盖（变异 Mu-d1-4 在 composition 面）。
import { describe, expect, it } from "vitest";
import { LiveAggregator, assistantFinalText, type LiveContentEvent } from "../../../apps/server/src/runtime/live-aggregator.ts";

/** 手动时钟：收集定时器，advance 触发到期回调（节流窗测试）。 */
class ManualTimer {
  private seq = 0;
  private tasks: { at: number; fn: () => void }[] = [];
  private now = 0;
  readonly schedule = (fn: () => void, ms: number): (() => void) => {
    const t = { at: this.now + ms, fn };
    this.tasks.push(t);
    return () => { this.tasks = this.tasks.filter((x) => x !== t); };
  };
  get pending(): number { return this.tasks.length; }
  fire(): void {
    this.seq++;
    this.now = Math.max(this.now, 1) + this.seq; // 单调推进
    const due = this.tasks;
    this.tasks = [];
    for (const t of due) t.fn();
  }
}

const collect = (): { events: LiveContentEvent[]; sink: (e: LiveContentEvent) => void } => {
  const events: LiveContentEvent[] = [];
  return { events, sink: (e) => events.push(e) };
};

describe("D1 LiveAggregator（docs/d1-live-stream-design.md）", () => {
  it("W-d1-2 thinking 缺省不透：thinking_delta 无帧；开关开=透（part=thinking）", () => {
    const a = collect();
    const agg = new LiveAggregator();
    agg.onPiEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "隐" } }, a.sink);
    agg.onPiEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0 } }, a.sink);
    expect(a.events).toEqual([]); // 缺省滤：无 delta 帧、无 part-end

    const b = collect();
    const agg2 = new LiveAggregator({ thinkingVisible: true });
    agg2.onPiEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "显" } }, b.sink);
    agg2.onPiEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0 } }, b.sink);
    expect(b.events).toEqual([
      { kind: "message-delta", part: "thinking", contentIndex: 0, delta: "显" },
      { kind: "message-part-end", part: "thinking", contentIndex: 0 },
    ]);
  });

  it("W-d1-3 节流窗合并：窗内同段多 delta 一帧；窗到才发；text_end 即时 flush", () => {
    const t = new ManualTimer();
    const a = collect();
    const agg = new LiveAggregator({ windowMs: 80, schedule: t.schedule });
    agg.onPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "第" } }, a.sink);
    agg.onPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "二" } }, a.sink);
    agg.onPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "段" } }, a.sink);
    expect(a.events).toEqual([]); // 窗未到：零帧
    expect(t.pending).toBe(1);
    t.fire(); // 窗到
    expect(a.events).toEqual([{ kind: "message-delta", part: "text", contentIndex: 1, delta: "第二段" }]);
    // text_end 即时 flush（无 timer 参与）
    agg.onPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "！" } }, a.sink);
    agg.onPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 1 } }, a.sink);
    expect(a.events.slice(-2)).toEqual([
      { kind: "message-delta", part: "text", contentIndex: 1, delta: "！" },
      { kind: "message-part-end", part: "text", contentIndex: 1 },
    ]);
  });

  it("W-d1-3b 异段独立窗合并：text 两段（contentIndex 1/2）互不并段", () => {
    const t = new ManualTimer();
    const a = collect();
    const agg = new LiveAggregator({ windowMs: 80, schedule: t.schedule });
    agg.onPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "A" } }, a.sink);
    agg.onPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 2, delta: "B" } }, a.sink);
    t.fire();
    // 窗到 flush=只发 delta（part-end 属段闭事件，非窗边界）
    expect(a.events.map((e) => e.kind === "message-delta" ? `${e.contentIndex}:${e.delta}` : "end")).toEqual(["1:A", "2:B"]);
  });

  it("W-d1-4 8KiB 切分：单 delta 超 maxChunkBytes 切多帧（帧序=切段序）", () => {
    const a = collect();
    const agg = new LiveAggregator({ maxChunkBytes: 8 });
    const long = "0123456789abcdef"; // 16 字节 → 8+8 两帧
    agg.onPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: long } }, a.sink);
    agg.onPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 1 } }, a.sink);
    expect(a.events.filter((e) => e.kind === "message-delta").map((e) => (e as { delta: string }).delta)).toEqual(["01234567", "89abcdef"]);
    expect(a.events.at(-1)).toEqual({ kind: "message-part-end", part: "text", contentIndex: 1 });
  });

  it("W-d1-5 2MiB 软上限：超限停 delta（final 仍发）", () => {
    const a = collect();
    const agg = new LiveAggregator({ turnBudgetBytes: 16, maxChunkBytes: 8 });
    agg.onPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "0123456789" } }, a.sink); // 10B
    agg.onPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "abcdefghij" } }, a.sink); // +10=20>16 → overBudget
    agg.onPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "XYZ" } }, a.sink); // 停：不进窗
    agg.onPiEvent({ type: "message_end", message: { role: "assistant", content: "全文" } }, a.sink); // final 仍发
    const deltas = a.events.filter((e) => e.kind === "message-delta");
    expect(deltas.map((e) => (e as { delta: string }).delta).join("")).toBe("0123456789abcdefghij"); // XYZ 停
    expect(a.events.some((e) => e.kind === "message-final" && e.text === "全文")).toBe(true);
  });

  it("W-d1-6 final 只透 assistant；content 数组取 text 段拼接（thinking 段不并入）；final 前清窗", () => {
    const a = collect();
    const agg = new LiveAggregator();
    agg.onPiEvent({ type: "message_end", message: { role: "user", content: "用户输入" } }, a.sink);
    expect(a.events).toEqual([]);
    agg.onPiEvent({ type: "message_end", message: { role: "system", content: "系统提示" } }, a.sink);
    expect(a.events).toEqual([]);
    agg.onPiEvent({ type: "message_end", message: { role: "assistant", content: null } }, a.sink); // content null → 提取 null → 不发
    expect(a.events).toEqual([]);
    // 窗内残留 delta → final 到达先清窗（终局全文权威）
    agg.onPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "残留" } }, a.sink);
    agg.onPiEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "思考" }, { type: "text", text: "正" }, { type: "text", text: "文" }] } }, a.sink);
    expect(a.events).toEqual([{ kind: "message-final", role: "assistant", text: "正文" }]);
  });

  it("边界：agent_settled/turn 边界清窗；extension_ui_request/response 不可识别返回 false", () => {
    const t = new ManualTimer();
    const a = collect();
    const agg = new LiveAggregator({ windowMs: 80, schedule: t.schedule });
    agg.onPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "尾" } }, a.sink);
    expect(agg.onPiEvent({ type: "extension_ui_request", id: "x", method: "setStatus" }, a.sink)).toBe(false);
    expect(agg.onPiEvent({ type: "response", id: "x", result: {} }, a.sink)).toBe(false);
    agg.onPiEvent({ type: "agent_settled" }, a.sink); // 清窗
    expect(a.events).toEqual([{ kind: "message-delta", part: "text", contentIndex: 1, delta: "尾" }, { kind: "message-part-end", part: "text", contentIndex: 1 }]);
    expect(t.pending).toBe(0); // 窗已清
  });

  it("assistantFinalText：string 直取/数组 text 段拼接/其它 null", () => {
    expect(assistantFinalText("直接")).toBe("直接");
    expect(assistantFinalText([{ type: "text", text: "a" }, { type: "thinking", thinking: "b" }, { type: "text", text: "c" }])).toBe("ac");
    expect(assistantFinalText(42)).toBeNull();
    expect(assistantFinalText([{ type: "tool_use" }])).toBe("");
  });
});
