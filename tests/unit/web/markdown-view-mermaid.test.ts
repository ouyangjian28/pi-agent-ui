// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MarkdownView } from "../../../apps/web/src/components/markdown-view";
import { LiveStreamView } from "../../../apps/web/src/components/live-stream";
import { SessionDetail } from "../../../apps/web/src/components/session-detail";
import type { SessionDetailSnapshot } from "../../../apps/web/src/ws/subscribe-client";
import type { LiveEvent } from "@pi-agent-ui/protocol/src/contracts";

afterEach(cleanup);
const fence = (body: string) => "```mermaid\n" + body + "\n```";
const source = fence("graph TD\nA[开始] --> B{判断?}\nB -->|通过| C((完成))\nB -->|拒绝| D[保留]");
const mount = (text: string) => render(React.createElement(MarkdownView, { text }));
const diagramText = (root: Element) => Array.from(root.querySelectorAll("svg text"), (node) => node.textContent);
const expectDiagram = (root: Element) => {
  expect(root.querySelectorAll("svg[role=img]")).toHaveLength(1);
  expect(root.querySelectorAll(".mermaid-node")).toHaveLength(4);
  expect(root.querySelectorAll(".mermaid-edge")).toHaveLength(3);
  expect(diagramText(root)).toEqual(expect.arrayContaining(["开始", "判断?", "完成", "保留", "通过", "拒绝"]));
};
const expectLiteral = (text: string, reason?: string) => {
  const view = mount(text);
  expect(view.container.querySelector("svg")).toBeNull();
  expect(view.container.querySelector(".markdown-literal")?.textContent).toBe(text);
  expect(screen.getAllByRole("note").map((note) => note.textContent).join(" ")).toContain(reason ?? "Mermaid");
  return view;
};

describe("MM-1 restricted flowcharts and lossless fallback", () => {
  it("renders TD shapes, arrows and labels as actual SVG, retaining following Markdown", () => {
    const { container } = mount(source + "\n# After\n- item\n[safe](https://example.test/)\n| A |\n|---|\n| B |\n```ts\ncode\n```");
    expectDiagram(container);
    expect(container.querySelector("svg rect")).toBeTruthy();
    expect(container.querySelector("svg polygon")).toBeTruthy();
    expect(container.querySelector("svg circle")).toBeTruthy();
    const paths = container.querySelectorAll(".mermaid-edge");
    expect(paths[paths.length - 1]!.compareDocumentPosition(container.querySelector(".mermaid-edge-text")!) & 4).toBe(4);
    expect(container.querySelector("h1")?.textContent).toBe("After");
    expect(container.querySelector("li")?.textContent).toBe("item");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://example.test/");
    expect(container.querySelector("table td")?.textContent).toBe("B");
    expect(container.querySelector("pre code")?.textContent).toBe("code\n");
  });

  it.each(["graph LR; A[one] -->|next| B((two)); B --> C{three}", "flowchart TD\r\nA[one] --> B((two))\r\nB -->|next| C{three}", "graph TD; A --> B --> C", "graph LR\n__proto__[one] --> constructor[two]\nconstructor --> __proto__", "graph TD\nA[\"Unicode 😀 [link](javascript:alert(1))\"] --> A"])("supports references, chains, cycles, CRLF and semicolons: %s", (body) => {
    const { container } = mount(fence(body));
    expect(container.querySelector("svg")).toBeTruthy();
    expect(container.querySelector(".markdown-literal")).toBeNull();
  });

  it("LR actually advances columns; TD advances rows; geometry is deterministic", () => {
    const view = mount(fence("graph LR; A --> B --> C"));
    const positions = () => Array.from(view.container.querySelectorAll(".mermaid-node"), (node) => node.getAttribute("transform"));
    const lr = positions();
    expect(new Set(lr)).toHaveProperty("size", 3);
    const coords = lr.map((value) => value!.match(/[\d.]+/g)!.map(Number));
    expect(coords[0]![0]).toBeLessThan(coords[1]![0]!);
    expect(coords[0]![1]).toBe(coords[1]![1]);
    view.rerender(React.createElement(MarkdownView, { text: fence("graph TD; A --> B --> C") }));
    const td = positions().map((value) => value!.match(/[\d.]+/g)!.map(Number));
    expect(td[0]![1]).toBeLessThan(td[1]![1]!);
    view.rerender(React.createElement(MarkdownView, { text: fence("graph LR; A --> B --> C") }));
    expect(positions()).toEqual(lr);
  });

  it.each(["sequenceDiagram\nA->>B: hello", "gantt\ntitle Plan", "pie\n\"A\": 1", "classDiagram\nclass A", "graph TB\nA-->B", "graph TD\nsubgraph group\nA-->B\nend", "graph TD\nA[broken --> B", "graph TD\nA-->B\nunsupported tail **keep**", "graph TD\nA -.-> B", "graph TD\nA -->|unfinished B", "graph TD", "graph TD\nA[x] B[y]"])("keeps the entire original fence and explains unsupported/damaged input: %s", (body) => {
    expectLiteral(fence(body));
  });

  it("opening → partial → complete → partial never swallows or keeps a stale diagram", () => {
    const partial = "```mermaid\r\ngraph TD\r\n  A[**literal** <img>] --> B";
    const view = mount(partial);
    expect(view.container.querySelector(".markdown-literal")?.textContent).toBe(partial);
    expect(screen.getByRole("note").textContent).toContain("未闭合");
    view.rerender(React.createElement(MarkdownView, { text: partial + "\r\n```" }));
    expect(view.container.querySelector("svg")).toBeTruthy();
    view.rerender(React.createElement(MarkdownView, { text: partial }));
    expect(view.container.querySelector("svg")).toBeNull();
    expect(view.container.querySelector(".markdown-literal")?.textContent).toBe(partial);
  });
});

describe("MM-2 inert text and bounded whole-block degradation", () => {
  it("HTML/event/URL text is only SVG text, and click is preserved but never executable", () => {
    const payload = '<img src=x onerror="alert(1)"><a href="javascript:alert(2)">raw</a>';
    const click = "  click A call alert('x')\n";
    const { container } = mount(fence(`graph LR\nA[${payload}] -->|<svg onload=alert(3)>| B[内嵌 [js](javascript:alert(4)) 链接]\n${click}B --> C[https://example.test/]`));
    expect(container.querySelector("svg")).toBeTruthy();
    expect(diagramText(container)).toEqual(expect.arrayContaining([payload, "内嵌 [js](javascript:alert(4)) 链接", "https://example.test/", "<svg onload=alert(3)>"]));
    expect(container.querySelector(".markdown-literal")?.textContent).toBe(click);
    expect(screen.getByRole("note").textContent).toContain("click");
    expect(container.querySelector("a,img,script,foreignObject,use,iframe")).toBeNull();
    for (const node of container.querySelectorAll("*")) for (const attr of node.attributes) {
      expect(attr.name).not.toMatch(/^on|href/i);
    }
  });

  it.each([
    ["physical line", "graph TD\nA[" + "x".repeat(4097) + "]"],
    ["nodes", "graph TD\n" + Array.from({ length: 65 }, (_, i) => `N${i}[node]`).join("\n")],
    ["edges", "graph TD\n" + "A --> B\n".repeat(129)],
    ["label", "graph TD\nA[" + "x".repeat(513) + "]"],
    ["depth", "graph TD\nA[" + "[".repeat(8) + "x" + "]".repeat(8) + "]"],
  ])("%s limit retains the entire original block", (_name, body) => { expectLiteral(fence(body), "预算"); });

  it("canvas dimension/area limits also degrade atomically, without consuming following Markdown", () => {
    const body = "graph LR\n" + Array.from({ length: 64 }, (_, i) => `N${i}[${"W".repeat(500)}]`).join("\n");
    const text = fence(body);
    const { container } = mount(text + "\n# Still here");
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector(".markdown-literal")?.textContent).toBe(text + "\n");
    expect(screen.getByRole("note").textContent).toContain("预算");
    expect(container.querySelector("h1")?.textContent).toBe("Still here");
  });

  it("allows the 64-node boundary and handles parallel/cyclic/self edges without losing any", () => {
    const view = mount(fence("graph TD\n" + Array.from({ length: 64 }, (_, i) => `N${i}`).join("\n")));
    expect(view.container.querySelectorAll(".mermaid-node")).toHaveLength(64);
    view.rerender(React.createElement(MarkdownView, { text: fence("graph LR\nA -->|one| B\nA -->|two| B\nB --> A\nA --> A") }));
    expect(view.container.querySelectorAll(".mermaid-edge")).toHaveLength(4);
    expect(diagramText(view.container)).toEqual(expect.arrayContaining(["one", "two", "A", "B"]));
  });

  it("reserves the shared element budget before committing any SVG", () => {
    // Stay below 2,000 lines: heading + nested emphasis costs 3/line.
    const compact = "# ***x***\n".repeat(1328);
    const view = mount(compact + source);
    expect(view.container.querySelector("svg")).toBeNull();
    expect(view.container.querySelector(".markdown-literal")?.textContent).toContain(source);
    expect(screen.getAllByRole("note").some((note) => note.textContent?.includes("预算"))).toBe(true);
    expect(view.container.querySelectorAll("*").length).toBeLessThanOrEqual(4004);
  });

  it("charges parsing and layout to the existing shared scan budget, not a new pool", () => {
    const expensive = ("**x** ".repeat(300) + "\n").repeat(20);
    const text = fence("graph TD\nA[" + "x".repeat(500) + "]\n" + "A --> B\n".repeat(100));
    const view = mount(expensive + text);
    expect(view.container.querySelector("svg")).toBeNull();
    expect(view.container.textContent).toContain("预算");
    expect(view.container.textContent).toContain("A --> B");
  });

  it.each(["x".repeat(120000), "A\n".repeat(2100)])("global display caps still apply before Mermaid parsing", (tail) => {
    const { container } = mount("```mermaid\ngraph TD\n" + tail + "\n```");
    expect(container.querySelector("svg")).toBeNull();
    expect(container.textContent).toContain("已截断");
    expect(container.textContent!.length).toBeLessThan(103000);
  });
});

describe("MM-1/MM-4 actual consumers", () => {
  it("history expansion and live final render the same graph; real collapse/reopen is stable", async () => {
    const snap: SessionDetailSnapshot = { connState: "ready", errorKind: null, errorMessage: null, streamNote: null, file: "mm.jsonl", phase: "live", subscriptionId: "sub-mm", events: [{ seq: 1, ts: null, generation: null, intentId: null, kind: "message", entryId: "e-mm", role: "assistant", final: true, blockCount: 1, textPreview: { text: source, truncated: true } }], liveEvents: [], status: null, cursor: null, uiRequests: [] };
    const client = { subscribe: () => () => {}, getSnapshot: () => snap, subscribeSession: () => {}, unsubscribeSession: () => {}, resyncFromCursor: () => {}, answerUi: () => {}, expandEntry: async () => ({ ok: true as const, frame: { t: "entry" as const, requestId: "r-mm", entryId: "e-mm", source: "session" as const, digest: "fixture", state: "ok" as const, blocks: [{ kind: "text" as const, text: source }] } }) };
    const history = render(React.createElement(SessionDetail, { client, file: "mm.jsonl" }));
    expect(history.container.querySelector("svg")).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "展开" })); });
    expectDiagram(history.container);
    const historyText = diagramText(history.container);
    const delta = (text: string): LiveEvent => ({ kind: "message-delta", part: "text", contentIndex: 0, delta: text });
    const partial = source.slice(0, -3);
    const events: LiveEvent[] = [delta(partial)];
    const props = () => ({ liveEvents: [...events], historyEvents: [] });
    const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); };
    const live = render(React.createElement(LiveStreamView, props()));
    await flush();
    expect(live.container.querySelector(".markdown-literal")?.textContent).toBe(partial);
    expect(live.container.querySelector("svg")).toBeNull();
    events.push(delta("```"));
    live.rerender(React.createElement(LiveStreamView, props()));
    await flush();
    expectDiagram(live.container);
    events.push({ kind: "message-final", role: "assistant", text: source });
    live.rerender(React.createElement(LiveStreamView, props()));
    await flush();
    expect(diagramText(live.container)).toEqual(historyText);
    events.push(delta("next"));
    live.rerender(React.createElement(LiveStreamView, props()));
    await flush();
    expect(live.container.querySelector("svg")).toBeNull();
    fireEvent.click(live.container.querySelector(".live-final button")!);
    expectDiagram(live.container);
    expect(diagramText(live.container)).toEqual(historyText);
  });
});
