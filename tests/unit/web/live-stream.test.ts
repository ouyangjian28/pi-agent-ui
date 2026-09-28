// D2 直播正文组装器纯逻辑测试（渲染态机=D1 契约事实①~⑤逐条固化）。
// 组件面（rAF 批处理/DOM 渲染/turn 边界衔接）测试在 live-stream-view.test.ts。
import { describe, expect, it } from "vitest";
import {
  applyLiveEvent,
  clearLiveStream,
  createLiveStreamState,
  liveStreamEmpty,
  liveTextOf,
  thinkingTextOf,
} from "../../../apps/web/src/ws/live-stream";
import type { LiveEvent } from "@pi-agent-ui/protocol/src/contracts";

const delta = (part: "text" | "thinking", contentIndex: number, d: string): LiveEvent => ({
  kind: "message-delta",
  part,
  contentIndex,
  delta: d,
});
const partEnd = (part: "text" | "thinking", contentIndex: number): LiveEvent => ({
  kind: "message-part-end",
  part,
  contentIndex,
});
const final = (text: string): LiveEvent => ({ kind: "message-final", role: "assistant", text });

describe("live-stream 组装器（D1 契约事实态机）", () => {
  it("增量流按 (part,contentIndex) 拼接：同段追加、跨段换行、text/thinking 分列", () => {
    const s = createLiveStreamState();
    applyLiveEvent(s, delta("text", 0, "你好"));
    applyLiveEvent(s, delta("text", 0, "，世界"));
    applyLiveEvent(s, delta("thinking", 0, "先想一下"));
    applyLiveEvent(s, delta("text", 1, "第二段"));
    expect(liveTextOf(s)).toBe("你好，世界\n第二段");
    expect(thinkingTextOf(s)).toBe("先想一下");
    expect(liveStreamEmpty(s)).toBe(false);
  });

  it("事实①：final 权威替换——增量残留（窗内缺尾）整体作废", () => {
    const s = createLiveStreamState();
    applyLiveEvent(s, delta("text", 0, "半截增量缺"));
    applyLiveEvent(s, final("完整终局全文。"));
    expect(liveTextOf(s)).toBe("完整终局全文。");
  });

  it("事实①：空 delta 直接收 final 是合法路径（零增量不报错）", () => {
    const s = createLiveStreamState();
    applyLiveEvent(s, final("短回复整体在窗内被 final 吸收"));
    expect(liveTextOf(s)).toBe("短回复整体在窗内被 final 吸收");
  });

  it("事实①：final 可重复到达（同值覆盖幂等）", () => {
    const s = createLiveStreamState();
    applyLiveEvent(s, final("甲"));
    applyLiveEvent(s, final("甲"));
    expect(liveTextOf(s)).toBe("甲");
  });

  it("事实②：part-end 重复到达幂等；对未知段到达=无操作（不建档、不占位）", () => {
    const s = createLiveStreamState();
    applyLiveEvent(s, delta("text", 0, "内容"));
    applyLiveEvent(s, partEnd("text", 0));
    applyLiveEvent(s, partEnd("text", 0)); // 重复
    applyLiveEvent(s, partEnd("text", 7)); // 未知段
    expect(liveTextOf(s)).toBe("内容");
    expect(s.textParts).toHaveLength(1);
    expect(s.textParts.find((p) => p.contentIndex === 0)?.closed).toBe(true);
  });

  it("事实②：part-end 缺失——下一 contentIndex 增量自闭合开新段", () => {
    const s = createLiveStreamState();
    applyLiveEvent(s, delta("text", 0, "段一"));
    // 无 part-end
    applyLiveEvent(s, delta("text", 1, "段二"));
    expect(liveTextOf(s)).toBe("段一\n段二");
  });

  it("事实③：预算触发路径（delta 骤停+final 到达）按正常 final 替换渲染", () => {
    const s = createLiveStreamState();
    applyLiveEvent(s, delta("text", 0, "超限前内容"));
    applyLiveEvent(s, final("超限后终局全文")); // 骤停后 final 仍发
    expect(liveTextOf(s)).toBe("超限后终局全文");
  });

  it("事实⑤：final 后再来 delta=新一轮开始（整体重置重新累积）", () => {
    const s = createLiveStreamState();
    applyLiveEvent(s, final("上一轮全文"));
    applyLiveEvent(s, delta("text", 0, "新一轮增量"));
    expect(liveTextOf(s)).toBe("新一轮增量");
  });

  it("空 delta 幂等吸收（不产生空段）", () => {
    const s = createLiveStreamState();
    applyLiveEvent(s, delta("text", 0, ""));
    expect(liveTextOf(s)).toBe("");
    expect(s.textParts).toHaveLength(0);
    expect(liveStreamEmpty(s)).toBe(true);
  });

  it("非直播三形（pi-progress/turn-state/process-note）与正文面无关", () => {
    const s = createLiveStreamState();
    applyLiveEvent(s, { kind: "pi-progress", piType: "turn_start", note: "message-start" });
    applyLiveEvent(s, { kind: "process-note", phase: "running" });
    applyLiveEvent(s, { kind: "turn-state", statusVersion: 1, turn: { state: "idle" } });
    expect(liveStreamEmpty(s)).toBe(true);
  });

  it("clearLiveStream 整体清空（turn 边界：正文落历史后）", () => {
    const s = createLiveStreamState();
    applyLiveEvent(s, delta("text", 0, "增量"));
    applyLiveEvent(s, delta("thinking", 0, "思考"));
    applyLiveEvent(s, final("全文"));
    clearLiveStream(s);
    expect(liveStreamEmpty(s)).toBe(true);
    expect(liveTextOf(s)).toBe("");
    expect(thinkingTextOf(s)).toBe("");
  });

  it("final 为空串（空回复终局）也权威——不回退到增量", () => {
    const s = createLiveStreamState();
    applyLiveEvent(s, delta("text", 0, "增量残留"));
    applyLiveEvent(s, final(""));
    expect(liveTextOf(s)).toBe("");
  });
});
