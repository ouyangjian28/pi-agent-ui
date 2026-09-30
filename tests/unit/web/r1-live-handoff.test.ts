// @vitest-environment jsdom
// 诚实不足分支的正文断言：以下三分页反例验证消费者不以不完整历史证明覆盖，
// 不声称服务器会在 paging 相发送 live final。
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LiveStreamView } from "../../../apps/web/src/components/live-stream";
import type { HistoryEvent, LiveEvent } from "@pi-agent-ui/protocol/src/contracts";
const final = (text: string): LiveEvent => ({ kind: "message-final", role: "assistant", text });
const delta = (text: string): LiveEvent => ({ kind: "message-delta", part: "text", contentIndex: 0, delta: text });
const history = (seq: number, text: string): HistoryEvent => ({ kind: "message", seq, ts: null, intentId: null, generation: null, entryId: `e-${seq}`, role: "assistant", final: true, textPreview: { text, truncated: false } });
const flush = async () => { await act(async () => { await new Promise((yes) => setTimeout(yes, 25)); }); };
function props(liveEvents: readonly LiveEvent[], historyEvents: readonly HistoryEvent[] = [], generationKey: unknown = "A") { return { liveEvents, historyEvents, generationKey }; }
function frozenTexts() { return Array.from(document.querySelectorAll(".live-final .live-stream-text"), (node) => node.textContent); }
afterEach(cleanup);
describe("v6 每个 final 独立、不因历史增量或文本配对删除", () => {
  it("连续 final/零 delta/同文本都独立定格，工具前后多个 assistant 不互相覆盖", async () => {
    const live = [final("工具前回复"), final("工具后回复"), final("工具后回复"), final("")];
    const r = render(React.createElement(LiveStreamView, props(live))); await flush();
    expect(frozenTexts()).toEqual(["工具前回复", "工具后回复", "工具后回复", "（空正文）"]); expect(screen.getAllByText(/未确认入档/)).toHaveLength(4);
    r.rerender(React.createElement(LiveStreamView, props(live, [history(1, "工具前回复"), history(2, "工具后回复"), history(3, "工具后回复")]))); await flush();
    expect(frozenTexts()).toEqual(["工具前回复", "工具后回复", "工具后回复", "（空正文）"]); expect(screen.getAllByText(/未确认入档/)).toHaveLength(4);
  });
  it("新 delta 收起旧 final 是非删除，可再次展开完整正文；标注常在", async () => {
    const text = "长回复正文".repeat(20); const live = [final(text)];
    const r = render(React.createElement(LiveStreamView, props(live))); await flush();
    r.rerender(React.createElement(LiveStreamView, props([...live, delta("下一条回复")] ))); await flush();
    expect(document.querySelectorAll(".live-final")).toHaveLength(1); expect(screen.getByText(/未确认入档/)).toBeTruthy();
    const toggle = screen.getByRole("button", { name: /已生成 · 长回复正文/ }); expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle); expect(frozenTexts()).toEqual([text]); expect(toggle.getAttribute("aria-expanded")).toBe("true"); fireEvent.click(toggle);
    expect(document.querySelectorAll(".live-final")).toHaveLength(1); expect(screen.getByText(/未确认入档/)).toBeTruthy();
  });
  it("唯一清理=世代切换（包含等长 live 数组），旧 file/client/subscription 内容不泄漏", async () => {
    const live = [final("旧正文")]; const r = render(React.createElement(LiveStreamView, props(live))); await flush();
    r.rerender(React.createElement(LiveStreamView, props(live, [history(1, "新增历史")]))); await flush(); expect(frozenTexts()).toEqual(["旧正文"]);
    r.rerender(React.createElement(LiveStreamView, props([final("新正文")], [], "B"))); await flush(); expect(frozenTexts()).toEqual(["新正文"]); expect(screen.queryByText("旧正文")).toBeNull();
  });
  it("首页部分：基线未完成，任何已读 assistant 增量都不能删当前直播定格正文", async () => {
    const live = [final("本轮未证实入档")]; const r = render(React.createElement(LiveStreamView, props(live, [history(1, "首页旧回复")]))); await flush();
    r.rerender(React.createElement(LiveStreamView, props(live, [history(1, "首页旧回复"), history(2, "下一页旧回复")]))); await flush();
    expect(frozenTexts()).toEqual(["本轮未证实入档"]); expect(screen.getByText(/未确认入档/)).toBeTruthy();
  });
  it("相位门丢 final：未见的新轮只出现在历史，H/F 数量相等不授权删上一条定格", async () => {
    const live = [final("已收到 F1")]; const r = render(React.createElement(LiveStreamView, props(live))); await flush();
    r.rerender(React.createElement(LiveStreamView, props(live, [history(1, "相位门未广播 F2")]))); await flush(); expect(frozenTexts()).toEqual(["已收到 F1"]);
  });
  it("续页保留旧历史数组：数组累计含多个旧 assistant，不是当前 final 的覆盖证明", async () => {
    const old = [history(1, "旧助手1"), history(2, "旧助手2")]; const live = [final("当前 final")];
    const r = render(React.createElement(LiveStreamView, props(live, old))); await flush();
    r.rerender(React.createElement(LiveStreamView, props(live, [...old, history(3, "续页旧助手3")]))); await flush(); expect(frozenTexts()).toEqual(["当前 final"]);
  });
});
