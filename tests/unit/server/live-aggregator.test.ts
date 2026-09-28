// D1 直播面聚合器单元（设计稿 docs/d1-live-stream-design.md §6 W-d1-2..6）。
// disposition 门（W-d1-8b）已提成 shouldBroadcastLive 纯函数——本文件覆盖。
import { describe, expect, it } from "vitest";
import { LiveAggregator, assistantFinalText, makeLiveOnPiEvent, shouldBroadcastLive, type LiveContentEvent } from "../../../apps/server/src/runtime/live-aggregator.ts";

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

  it("W-d1-3d 缺省窗=80ms：schedule 延时参数=80（锁缺省值——缺省 0=每 delta 即发，节流失效）", () => {
    const delays: number[] = [];
    const t = new ManualTimer();
    const a = collect();
    const wrap = (fn: () => void, ms: number) => { delays.push(ms); return t.schedule(fn, ms); };
    const agg = new LiveAggregator({ schedule: wrap }); // 不传 windowMs——锁缺省值
    agg.onPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "x" } }, a.sink);
    expect(a.events).toEqual([]);  // 入窗挂起（ManualTimer 不自动跑）
    expect(delays).toEqual([80]);  // 首窗延时=缺省 80ms（杀 Mu-d1-1：缺省 0）
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

  it("W-d1-9 P1-1 turn 预算跨 turn 复位：turn1 超限→turn_start 复位→turn2 delta 恢复", () => {
    const a = collect();
    const agg = new LiveAggregator({ turnBudgetBytes: 16 });
    // turn1：超限（20B>16）
    agg.onPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "0123456789" } }, a.sink);
    agg.onPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "abcdefghij" } }, a.sink);
    agg.onPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "XYZ" } }, a.sink); // 停
    // turn 边界：agent_start/turn_start 复位预算
    agg.onPiEvent({ type: "message_end", message: { role: "assistant", content: "t1" } }, a.sink);
    agg.onPiEvent({ type: "agent_end" }, a.sink);
    agg.onPiEvent({ type: "agent_start" }, a.sink);
    agg.onPiEvent({ type: "turn_start" }, a.sink);
    // turn2：delta 恢复（未超限不再停）
    agg.onPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "turn2-ok" } }, a.sink);
    agg.onPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "XYZ" } }, a.sink); // 复位后不应被停
    agg.onPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 1 } }, a.sink); // 真闭触发 flush（窗内两 delta 落帧）
    agg.onPiEvent({ type: "message_end", message: { role: "assistant", content: "t2" } }, a.sink);
    const deltas = a.events.filter((e) => e.kind === "message-delta").map((e) => (e as { delta: string }).delta).join("");
    expect(deltas).toBe("0123456789abcdefghijturn2-okXYZ"); // turn2 两个 delta 全到（XYZ 不再被停）
  });

  it("W-d1-10 P2-5 超限路径只发 delta 不补提前 part-end；真 text_end 仍补锚（不重复）", () => {
    const a = collect();
    const agg = new LiveAggregator({ turnBudgetBytes: 16 });
    agg.onPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "0123456789" } }, a.sink);
    agg.onPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "abcdefghij" } }, a.sink); // 超限 flush
    expect(a.events.filter((e) => e.kind === "message-part-end")).toEqual([]); // 不发提前 part-end（段未真闭合）
    agg.onPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 1 } }, a.sink); // 真闭
    const pes = a.events.filter((e) => e.kind === "message-part-end");
    expect(pes).toEqual([{ kind: "message-part-end", part: "text", contentIndex: 1 }]); // 恰一个锚（不重复）
  });

  it("W-d1-11 P2-3 字节口径：中文 delta 按 UTF-8 字节计预算/切分（码元口径会 3× 放水）", () => {
    const a = collect();
    const agg = new LiveAggregator({ turnBudgetBytes: 12, maxChunkBytes: 6, windowMs: 0 });
    // "中"=3 字节：预算 12=4 个中文字；第 5 个触发超限
    agg.onPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "中中中中" } }, a.sink); // 12B 恰好未超
    agg.onPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "文" } }, a.sink); // +3=15>12 超限 flush
    agg.onPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "停" } }, a.sink); // 停
    const deltas = a.events.filter((e) => e.kind === "message-delta").map((e) => (e as { delta: string }).delta).join("");
    expect(deltas).toBe("中中中中文"); // 「停」被停（码元口径下 5 字=5「字节」不会超 12——杀口径回归）
    // 切分：flush 时按字节 6B=2 中文字切帧（码元口径会切 6 个字）
    const a2 = collect();
    const agg2 = new LiveAggregator({ maxChunkBytes: 6, windowMs: 0 });
    agg2.onPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "中中中中中中" } }, a2.sink); // 18B→3 帧
    agg2.onPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 1 } }, a2.sink);
    const chunks = a2.events.filter((e) => e.kind === "message-delta").map((e) => (e as { delta: string }).delta);
    expect(chunks).toEqual(["中中", "中中", "中中"]); // 每帧 2 字（6B）
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

describe("shouldBroadcastLive disposition 门", () => {
  it("W-d1-8b buffered/delivered 放行；dropped-stale-generation/overflow-closed 拒（杀 Mu-d1-4）", () => {
    expect(shouldBroadcastLive("delivered")).toBe(true);
    expect(shouldBroadcastLive("buffered")).toBe(true);
    expect(shouldBroadcastLive("dropped-stale-generation")).toBe(false);
    expect(shouldBroadcastLive("overflow-closed")).toBe(false);
  });
});

describe("W-d1-1 D1 接线工厂 makeLiveOnPiEvent（K3 审 P2-6①：CI 可跑的接线级覆盖）", () => {
  it("W-d1-1a 键归一：journal 绝对路径→roots 相对逻辑名（广播/sink 收相对名）", () => {
    const roots = ["/data/roots"];
    const aggs = new Map();
    const got: Array<{ file: string; kind: string }> = [];
    const route = makeLiveOnPiEvent({ roots, sink: () => (file, ev) => got.push({ file, kind: ev.kind }), aggregators: aggs });
    route("/data/roots/a/b.md", { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "hi" } }, 1, "delivered");
    route("/data/roots/a/b.md", { type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 1 } }, 1, "delivered");
    expect(got.length).toBeGreaterThan(0);
    expect(got.every((g) => g.file === "a/b.md")).toBe(true); // 相对逻辑名（不归一则全早退/绝对路径泄漏）
    expect(aggs.has("a/b.md")).toBe(true); // per-file 聚合器按逻辑名复用
  });

  it("W-d1-1b roots 外绝对路径回退原样（fail-closed 零广播面外的静默路径）", () => {
    const aggs = new Map();
    const got: unknown[] = [];
    const route = makeLiveOnPiEvent({ roots: ["/data/roots"], sink: () => () => { got.push(1); }, aggregators: aggs });
    route("/etc/x.md", { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "hi" } }, 1, "delivered");
    route("/etc/x.md", { type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 1 } }, 1, "delivered");
    expect(got.length).toBeGreaterThan(0); // 回退绝对路径仍广播（订阅面同键=无人收，fail-closed 无泄漏）
    expect(aggs.has("/etc/x.md")).toBe(true);
  });

  it("W-d1-8/Mu-d1-4 接线级：dropped-stale-generation/overflow-closed/未知 disposition 零广播（白名单门在路由层）", () => {
    const aggs = new Map();
    const got: unknown[] = [];
    const route = makeLiveOnPiEvent({ roots: ["/r"], sink: () => () => { got.push(1); }, aggregators: aggs });
    for (const disp of ["dropped-stale-generation", "overflow-closed", "some-new-future-disposition"]) {
      route("/r/a.md", { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "x" } }, 1, disp);
      route("/r/a.md", { type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 1 } }, 1, disp);
    }
    expect(got).toEqual([]); // 全拒（黑名单制的未知态也拒=白名单杀点）
    expect(aggs.size).toBe(0); // 拒在聚合器创建之前
  });

  it("W-d1-8b sink 晚绑定：null 期丢弃不炸；置 sink 后恢复广播", () => {
    const aggs = new Map();
    let sink: ((f: string, e: unknown) => void) | null = null;
    const route = makeLiveOnPiEvent({ roots: ["/r"], sink: () => sink, aggregators: aggs });
    const ev = (t: string) => ({ type: "message_update", assistantMessageEvent: t === "d" ? { type: "text_delta", contentIndex: 1, delta: "x" } : { type: "text_end", contentIndex: 1 } });
    route("/r/a.md", ev("d"), 1, "delivered");
    route("/r/a.md", ev("e"), 1, "delivered"); // null 期：丢弃
    expect(aggs.size).toBe(0); // 零订阅期不建聚合器（零状态，晚绑定后首事件才建）
    const got: unknown[] = [];
    sink = () => { got.push(1); };
    route("/r/a.md", ev("d"), 1, "delivered");
    route("/r/a.md", ev("e"), 1, "delivered");
    expect(got.length).toBeGreaterThan(0); // 晚绑定后恢复
  });
});
