// @vitest-environment jsdom
// D2 直播正文组件测试（LiveStreamView）：渲染面六场景——增量流→拼接、final 权威替换、thinking 缺省不渲染、
// turn 边界清空（正文落历史）、空 delta 直接收 final、part-end 缺失/重复幂等；外加 rAF 批处理与数组重置。
// 模式：纯组件渲染（props 由测试推进；仓惯例 .test.ts 无 JSX，用 React.createElement），flushFrame 等一帧让批处理提交。
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LiveStreamView } from "../../../apps/web/src/components/live-stream";
import type { HistoryEvent, LiveEvent } from "@pi-agent-ui/protocol/src/contracts";

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

function assistantMsg(seq: number, text = `助手消息 ${seq}`): HistoryEvent {
  return {
    seq,
    ts: null,
    generation: null,
    intentId: null,
    kind: "message",
    entryId: `e-${seq}`,
    role: "assistant",
    final: true,
    textPreview: { text, truncated: false },
  };
}

function mount(liveEvents: readonly LiveEvent[], historyEvents: readonly HistoryEvent[] = []) {
  return render(React.createElement(LiveStreamView, { liveEvents, historyEvents }));
}

/** 等一帧让 rAF 批处理提交（jsdom 有 rAF 走 rAF，无则宏任务回退——20ms 双覆盖）。 */
async function flushFrame(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

afterEach(cleanup);

describe("LiveStreamView 直播正文渲染", () => {
  it("增量流→拼接渲染：同段追加、跨段换行", async () => {
    const view = mount([]);
    expect(screen.queryByLabelText("直播正文")).toBeNull(); // 空态不占位
    view.rerender(React.createElement(LiveStreamView, { liveEvents: [delta("text", 0, "你好")], historyEvents: [] }));
    await flushFrame();
    view.rerender(
      React.createElement(LiveStreamView, {
        liveEvents: [delta("text", 0, "你好"), delta("text", 0, "，世界"), delta("text", 1, "第二段")],
        historyEvents: [],
      }),
    );
    await flushFrame();
    expect(screen.getByLabelText("直播正文").textContent).toBe("你好，世界\n第二段");
  });

  it("final 权威替换：增量残留被终局全文取代", async () => {
    const view = mount([delta("text", 0, "半截增量缺")]);
    await flushFrame();
    expect(screen.getByLabelText("直播正文").textContent).toBe("半截增量缺");
    view.rerender(
      React.createElement(LiveStreamView, {
        liveEvents: [delta("text", 0, "半截增量缺"), final("完整终局全文。")],
        historyEvents: [],
      }),
    );
    await flushFrame();
    expect(screen.getByLabelText("直播正文").textContent).toBe("完整终局全文。");
  });

  it("空 delta 直接收 final（合法路径）：零增量也渲染终局全文", async () => {
    mount([final("短回复整体吸收")]);
    await flushFrame();
    expect(screen.getByLabelText("直播正文").textContent).toBe("短回复整体吸收");
  });

  it("thinking 缺省不渲染：折叠区留槽（有内容才出开关），开关默认关、点开可见", async () => {
    mount([delta("text", 0, "正文"), delta("thinking", 0, "内心活动"), partEnd("thinking", 0)]);
    await flushFrame();
    const region = screen.getByLabelText("直播正文");
    expect(region.textContent).toContain("正文");
    expect(region.textContent).not.toContain("内心活动"); // 默认关=不渲染
    const toggle = screen.getByRole("button", { name: "思考过程" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(region.textContent).toContain("内心活动");
  });

  it("turn 边界清空：assistant 正文落历史后直播区清空本轮（防重复显示）", async () => {
    const live = [delta("text", 0, "本轮正文"), final("本轮正文")];
    const view = mount(live);
    await flushFrame();
    expect(screen.getByLabelText("直播正文").textContent).toBe("本轮正文");
    // 历史区落行（同帧不再含 live 新增）→ 直播区清空
    view.rerender(React.createElement(LiveStreamView, { liveEvents: live, historyEvents: [assistantMsg(1, "本轮正文")] }));
    await flushFrame();
    expect(screen.queryByLabelText("直播正文")).toBeNull();
  });

  it("part-end 缺失/重复幂等：缺锚下一 contentIndex 自闭合；重复锚输出不变", async () => {
    mount([
      delta("text", 0, "段一"),
      // 无 part-end
      delta("text", 1, "段二"),
      partEnd("text", 1),
      partEnd("text", 1), // 重复
      partEnd("text", 9), // 未知段
    ]);
    await flushFrame();
    expect(screen.getByLabelText("直播正文").textContent).toBe("段一\n段二");
  });

  it("直播数组重置（事实④ 重订阅缩短）即整体清零从头处理", async () => {
    const old = [delta("text", 0, "旧流内容"), delta("text", 0, "续")];
    const view = mount(old);
    await flushFrame();
    expect(screen.getByLabelText("直播正文").textContent).toBe("旧流内容续");
    view.rerender(React.createElement(LiveStreamView, { liveEvents: [], historyEvents: [] })); // 重订阅重置
    await flushFrame();
    expect(screen.queryByLabelText("直播正文")).toBeNull();
    view.rerender(React.createElement(LiveStreamView, { liveEvents: [delta("text", 0, "新流")], historyEvents: [] }));
    await flushFrame();
    expect(screen.getByLabelText("直播正文").textContent).toBe("新流");
  });

  it("rAF 批处理：同帧多批推进合并为一次提交，千级 delta 正确拼接", async () => {
    const view = mount([]);
    // 千级 delta 分 10 批在同一帧内推进（不进 flushFrame）——帧末合并提交
    const all: LiveEvent[] = [];
    for (let batch = 0; batch < 10; batch++) {
      for (let i = 0; i < 100; i++) all.push(delta("text", 0, `${batch * 100 + i},`));
      view.rerender(React.createElement(LiveStreamView, { liveEvents: [...all], historyEvents: [] }));
    }
    await flushFrame();
    const region = screen.getByLabelText("直播正文");
    expect(region.textContent).toBe(all.map((e) => (e.kind === "message-delta" ? e.delta : "")).join(""));
    expect(region.textContent?.length).toBeGreaterThan(3000);
  });

  it("final 后再来 delta=新一轮开始（事实⑤ 无轮次身份的划界）", async () => {
    const old = [final("上一轮全文")];
    const view = mount(old);
    await flushFrame();
    expect(screen.getByLabelText("直播正文").textContent).toBe("上一轮全文");
    view.rerender(
      React.createElement(LiveStreamView, { liveEvents: [...old, delta("text", 0, "新一轮增量")], historyEvents: [] }),
    );
    await flushFrame();
    expect(screen.getByLabelText("直播正文").textContent).toBe("新一轮增量");
  });
});
