// @vitest-environment jsdom
// LS-MD: exercise the real live-event -> rAF -> MarkdownView DOM path.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LiveStreamView } from "../../../apps/web/src/components/live-stream";
import { MarkdownView } from "../../../apps/web/src/components/markdown-view";
import type { LiveEvent } from "@pi-agent-ui/protocol/src/contracts";

const delta = (text: string): LiveEvent => ({ kind: "message-delta", part: "text", contentIndex: 0, delta: text });
const final = (text: string): LiveEvent => ({ kind: "message-final", role: "assistant", text });
const props = (liveEvents: readonly LiveEvent[]) => ({ liveEvents, historyEvents: [] });
const flushFrame = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); };
const richParts = ["# Live title\n", "**bold**\n", "- first\n- second\n", "[secure](https://example.test/docs) [plain](http://example.test/docs)\n", "```ts\n", "const answer = 42;\n", "```"];
function expectRich(root: Element) {
  expect(root.querySelector("pre > code")?.textContent).toBe("const answer = 42;\n");
  expect(root.querySelector("h1")?.textContent).toBe("Live title");
  expect(root.querySelector("strong")?.textContent).toBe("bold");
  expect(Array.from(root.querySelectorAll("li"), (node) => node.textContent)).toEqual(["first", "second"]);
  const links = root.querySelectorAll("a");
  expect(Array.from(links, (node) => node.getAttribute("href"))).toEqual(["https://example.test/docs", "http://example.test/docs"]);
  for (const link of links) {
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  }
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe("LS-MD live and frozen body wiring", () => {
  it("实时流正文应富渲染：增量围栏、标题、粗体、列表及 http(s) 链接", async () => {
    const events: LiveEvent[] = [];
    const view = render(React.createElement(LiveStreamView, props(events)));
    for (const part of richParts) {
      events.push(delta(part));
      view.rerender(React.createElement(LiveStreamView, props([...events])));
      await flushFrame();
    }
    expectRich(screen.getByLabelText("直播正文"));
  });

  it.each([
    { opening: "```ts\n", body: '# literal **bold**\n- item\n<script>alert(1)</script>\n', closing: "```", selector: "pre > code" },
    { opening: "before `", body: "**bold** <script>alert(1)</script>", closing: "`", selector: "p > code" },
  ])("半截语法保字且 HTML 惰性，闭合后呈现 $selector", async ({ opening, body, closing, selector }) => {
    const events: LiveEvent[] = [delta(opening)];
    const view = render(React.createElement(LiveStreamView, props(events)));
    await flushFrame();
    const root = screen.getByLabelText("直播正文");
    expect(root.querySelector(".markdown-view")?.textContent).toBe(opening);
    events.push(delta(body));
    view.rerender(React.createElement(LiveStreamView, props([...events])));
    await flushFrame();
    expect(root.querySelector(".markdown-view")?.textContent).toBe(opening + body);
    expect(root.querySelector("pre, code, h1, strong, li, script")).toBeNull();
    events.push(delta(closing));
    view.rerender(React.createElement(LiveStreamView, props([...events])));
    await flushFrame();
    expect(root.querySelector(selector)?.textContent).toBe(body);
    expect(root.querySelector("script, strong, h1, li")).toBeNull();
  });

  it("final 全文富渲染、未确认入档保留；次条 delta 折叠后真实点击恢复全部内容", async () => {
    const text = richParts.join("") + "\n终局独有尾字：完整不丢😀";
    const events: LiveEvent[] = [delta("被 final 替换的半截")];
    const view = render(React.createElement(LiveStreamView, props(events)));
    await flushFrame();
    events.push(final(text));
    view.rerender(React.createElement(LiveStreamView, props([...events])));
    await flushFrame();
    const frozen = view.container.querySelector(".live-final")!;
    expectRich(frozen);
    expect(frozen.querySelector(".markdown-view")?.textContent).toContain("终局独有尾字：完整不丢😀");
    const completeText = frozen.querySelector(".markdown-view")!.textContent;
    expect(frozen.textContent).not.toContain("被 final 替换的半截");
    expect(screen.getByText("pi · 已生成（未确认入档）")).toBeTruthy();
    events.push(delta("# Next body"));
    view.rerender(React.createElement(LiveStreamView, props([...events])));
    await flushFrame();
    expect(frozen.querySelector(".frozen-content")).toBeNull();
    const toggle = frozen.querySelector("button")!;
    expect(toggle.textContent).toBe(`已生成 · ${text.slice(0, 40)}…`);
    expect(toggle.querySelector("h1, strong, pre, a")).toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expectRich(frozen);
    expect(frozen.querySelector(".markdown-view")?.textContent).toBe(completeText);
    expect(screen.getByText("pi · 已生成（未确认入档）")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("正在生成回复。已生成 1 条回复，归档状态待核对。");
  });

  it.each(["delta", "final"])("%s 路径的 javascript: 链接与 HTML 保持惰性", async (kind) => {
    const text = '[bad](javascript:alert(1)) <script>alert(1)</script> <img src=x onerror="alert(1)">';
    const view = render(React.createElement(LiveStreamView, props([kind === "delta" ? delta(text) : final(text)])));
    await flushFrame();
    expect(view.container.querySelector(".markdown-view")?.textContent).toBe(text);
    expect(view.container.querySelector("a, script, img")).toBeNull();
  });

  it("thinking 生成中与 final details 均保持纯文本，正文才接 MarkdownView", async () => {
    const thinking = "# Thinking **literal** <script>inert</script>";
    const events: LiveEvent[] = [delta("**body**"), { kind: "message-delta", part: "thinking", contentIndex: 0, delta: thinking }];
    const view = render(React.createElement(LiveStreamView, props(events)));
    await flushFrame();
    fireEvent.click(screen.getByRole("button", { name: "思考过程" }));
    const liveThinking = view.container.querySelector(".live-stream-thinking-body")!;
    expect(liveThinking.textContent).toBe(thinking);
    expect(liveThinking.querySelector("h1, strong, script, .markdown-view")).toBeNull();
    events.push(final("**complete**"));
    view.rerender(React.createElement(LiveStreamView, props([...events])));
    await flushFrame();
    const details = view.container.querySelector(".frozen-content details")!;
    expect(details.querySelector("p")?.textContent).toBe(thinking);
    expect(details.querySelector("h1, strong, script, .markdown-view")).toBeNull();
    expect(view.container.querySelector(".frozen-content .markdown-view strong")?.textContent).toBe("complete");
  });

  it("长增量走已有显示上限，正文不每 token 无界解析", async () => {
    const events = Array.from({ length: 1_000 }, () => delta("x".repeat(150)));
    const view = render(React.createElement(LiveStreamView, props(events)));
    await flushFrame();
    expect(view.container.querySelector(".markdown-view > p")?.textContent).toHaveLength(100 * 1024);
    expect(screen.getByRole("note").textContent).toContain("已截断显示");
  });

  it("真实 MarkdownView memo：未变的 final 正文不随新 final、重绘或展开后的后续 delta 重解析", async () => {
    // Observe the real memo component's inner parser; keep its default comparator
    // and implementation intact, rather than replacing MarkdownView with a stub.
    const parser = vi.spyOn(MarkdownView as React.MemoExoticComponent<(props: React.ComponentProps<typeof MarkdownView>) => React.ReactElement>, "type");
    const frozenText = "**stable frozen**";
    const events: LiveEvent[] = [final(frozenText)];
    const view = render(React.createElement(LiveStreamView, props(events)));
    await flushFrame();
    const parses = () => parser.mock.calls.filter(([input]) => input.text === frozenText).length;
    expect(parses()).toBe(1);
    events.push(final("another frozen"));
    view.rerender(React.createElement(LiveStreamView, props([...events])));
    await flushFrame();
    expect(parses()).toBe(1);
    events.push(delta("new"));
    view.rerender(React.createElement(LiveStreamView, props([...events])));
    await flushFrame();
    fireEvent.click(screen.getByRole("button", { name: /已生成 · \*\*stable frozen\*\*/ }));
    expect(parses()).toBe(2); // Unmount on collapse -> one bounded parse on reopen.
    for (const part of [" increment", " again"]) {
      events.push(delta(part));
      view.rerender(React.createElement(LiveStreamView, props([...events])));
      await flushFrame();
      expect(parses()).toBe(2);
    }
    expect(view.container.querySelector(".live-final .markdown-view strong")?.textContent).toBe("stable frozen");
  });
});
