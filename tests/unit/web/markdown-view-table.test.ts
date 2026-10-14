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
const mount = (text: string) => render(React.createElement(MarkdownView, { text }));
const source = "| Name | Value |\n| :--- | ---: |\n| **Alice** | `12` |\n| Bob | 8 |";
const cells = (root: Element) => Array.from(root.querySelectorAll("th, td"), (node) => node.textContent);
const expectTable = (root: Element) => {
  expect(root.querySelectorAll("thead th")).toHaveLength(2);
  expect(root.querySelectorAll("tbody tr")).toHaveLength(2);
  expect(cells(root)).toEqual(["Name", "Value", "Alice", "12", "Bob", "8"]);
};

describe("TB-MD pipe syntax and shared safe inline semantics", () => {
  it("renders semantic headers, rows, cells and alignment", () => {
    const { container } = mount(source);
    expectTable(container);
    expect(container.querySelector(".markdown-table-wrap > table")).toBeTruthy();
    expect(container.querySelector("th")?.getAttribute("scope")).toBe("col");
    expect((container.querySelector("th") as HTMLElement).style.textAlign).toBe("left");
    expect((container.querySelector("td:nth-child(2)") as HTMLElement).style.textAlign).toBe("right");
    expect(container.querySelector("td strong")?.textContent).toBe("Alice");
    expect(container.querySelector("td code")?.textContent).toBe("12");
  });

  it.each(["| A | B | C |\n| --- | :-: | ---: |\n| 1 | 2 | 3 |", "A | B | C\n--- | :-: | ---:\n1 | 2 | 3", " | A | B | C |\r\n | --- | :-: | ---: |\r\n | 1 | 2 | 3 |\r\n"])("accepts plain/outer pipes, CRLF and short center separator: %s", (text) => {
    const { container } = mount(text);
    expect(cells(container)).toEqual(["A", "B", "C", "1", "2", "3"]);
    expect((container.querySelector("th:nth-child(2)") as HTMLElement).style.textAlign).toBe("center");
  });

  it("accepts a complete header-only table and empty cells without losing columns", () => {
    const view = mount("| A | B |\n|---|---|");
    expect(view.container.querySelectorAll("th")).toHaveLength(2);
    expect(view.container.querySelectorAll("td")).toHaveLength(0);
    view.rerender(React.createElement(MarkdownView, { text: "| A | B |\n|---|---|\n| | |" }));
    expect(cells(view.container)).toEqual(["A", "B", "", ""]);
  });

  it("handles escaped pipes including code/link cells, and keeps other escapes", () => {
    const { container } = mount("| A\\|B | C |\n|---|---|\n| `x\\|y` | [a\\|b](https://example.test/) |\n| \\\\ | \\*literal |\n");
    expect(cells(container)).toEqual(["A|B", "C", "x|y", "a|b", "\\\\", "\\*literal"]);
    expect(container.querySelectorAll("td")).toHaveLength(4);
  });

  it("keeps HTML inert and unsafe links wholly literal in headers and cells", () => {
    const bad = "[**bad**](javascript:alert(1))";
    const { container } = mount(`| <b>header</b> | ${bad} |\n|---|---|\n| <img src=x onerror=alert(1)><script>alert(1)</script> | ${bad} |\n| [safe](https://example.test/) | [http](http://example.test/) |`);
    expect(container.querySelector("table")).toBeTruthy();
    expect(container.querySelector("b, img, script, strong")).toBeNull();
    expect(cells(container)[0]).toBe("<b>header</b>");
    expect(cells(container)[1]).toBe(bad);
    expect(cells(container)[3]).toBe(bad);
    const links = container.querySelectorAll("a");
    expect(Array.from(links, (link) => link.getAttribute("href"))).toEqual(["https://example.test/", "http://example.test/"]);
    for (const link of links) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    }
  });

  it.each(["data:text/html,bad", "//example.test/", "https://", "https://example.test/ bad", "jav&#x61;script:alert(1)"])("does not broaden safeHref: %s", (href) => {
    const value = `[x](${href})`;
    const { container } = mount(`| A |\n|---|\n| ${value} |`);
    expect(container.querySelector("td")?.textContent).toBe(value);
    expect(container.querySelector("a")).toBeNull();
  });

  it("does not steal ordinary pipe-containing inline code, links or emphasis from the old parser", () => {
    const { container } = mount("Use `a | b` and **bold** | plain\n[pipe](https://example.test/a|b)");
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector("code")?.textContent).toBe("a | b");
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://example.test/a|b");
  });

  it("starts tables after prose, ends at blank/block boundaries, and leaves fenced tables literal", () => {
    const { container } = mount("before\n" + source + "\n\n# after\n- item\n```md\n" + source + "\n```\n" + source);
    expect(container.querySelectorAll("table")).toHaveLength(2);
    expect(container.querySelector("p")?.textContent).toBe("before\n");
    expect(container.querySelector("h1")?.textContent).toBe("after");
    expect(container.querySelector("li")?.textContent).toBe("item");
    expect(container.querySelector("pre code")?.textContent).toBe(source + "\n");
  });
});

describe("TB-MD conservative streaming and malformed fallback", () => {
  it.each([
    "| **A** | B |", "| **A** | B |\n| --- |", "| A | B |\n|---|nope|\n| 1 | 2 |",
    "| A | B |\n|---|\n| 1 | 2 |", "| A | B |\n|---|---|\n| **one** |",
    "| A | B |\n|---|---|\n| 1 | 2 | 3 |", "| A | B |\n|---|---|\n| **one** | two",
    "| A | B |\n|---|---|\n| 1 | 2 |\n| interrupted", "| A | B |\n|---|---|\n| `open | 2 |",
  ])("keeps the entire ambiguous candidate literal, not silently padded/dropped: %s", (text) => {
    const { container } = mount(text);
    expect(container.querySelector(".markdown-view")?.textContent).toBe(text);
    expect(container.querySelector("table, strong, code, a")).toBeNull();
  });

  it("reparses header -> separator -> incomplete row -> complete -> incomplete without stale cells", () => {
    const header = "| **A** | B |\n";
    const delimiter = "|---|---|\n";
    const view = mount(header);
    for (const text of [header, header + "|---|", header + delimiter + "| one |", header + delimiter + "| one | two"]) {
      view.rerender(React.createElement(MarkdownView, { text }));
      expect(view.container.querySelector(".markdown-view")?.textContent).toBe(text);
      expect(view.container.querySelector("table, strong")).toBeNull();
    }
    view.rerender(React.createElement(MarkdownView, { text: header + delimiter + "| one | two |" }));
    expect(cells(view.container)).toEqual(["A", "B", "one", "two"]);
    view.rerender(React.createElement(MarkdownView, { text: header }));
    expect(view.container.querySelector("table")).toBeNull();
    expect(view.container.querySelector(".markdown-view")?.textContent).toBe(header);
  });
});

describe("TB-MD local limits never expand shared budgets", () => {
  it.each([33, 500])("limits huge columns (%s) with exact raw text and a note", (count) => {
    const row = "|" + " x |".repeat(count);
    const text = row + "\n|" + "---|".repeat(count) + "\n" + row;
    const { container } = mount(text);
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector(".markdown-literal")?.textContent).toBe(text);
    expect(screen.getByRole("note").textContent).toContain("表格");
  });

  it("accepts 32 columns within the element budget", () => {
    const row = "|" + " x |".repeat(32);
    const { container } = mount(row + "\n|" + "---|".repeat(32) + "\n" + row);
    expect(container.querySelectorAll("th")).toHaveLength(32);
    expect(container.querySelectorAll("td")).toHaveLength(32);
  });

  it.each([500, 501])("bounds data rows at 500 (%s)", (count) => {
    const text = "| A |\n|---|\n" + "| x |\n".repeat(count);
    const { container } = mount(text);
    if (count === 500) expect(container.querySelectorAll("tbody tr")).toHaveLength(500);
    else {
      expect(container.querySelector("table")).toBeNull();
      expect(container.querySelector(".markdown-literal")?.textContent).toBe(text);
      expect(screen.getByRole("note").textContent).toContain("表格");
    }
  });

  it("does not bypass the 4096 physical-line inline gate by splitting long rows into short cells", () => {
    const text = "| A | B |\n|---|---|\n| " + "**x**".repeat(700) + " | " + "y".repeat(700) + " |";
    const { container } = mount(text);
    expect(container.querySelector("table, strong")).toBeNull();
    expect(container.querySelector(".markdown-literal")?.textContent).toBe(text);
    expect(screen.getByRole("note")).toBeTruthy();
  });

  it("preflights structural elements before rendering any table and preserves all rows", () => {
    const row = "|" + " x |".repeat(32) + "\n";
    const text = row + "|" + "---|".repeat(32) + "\n" + row.repeat(125);
    const { container } = mount(text);
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector(".markdown-literal")?.textContent).toBe(text);
    expect(screen.getByRole("note").textContent).toContain("解析预算");
    expect(container.querySelectorAll("*").length).toBeLessThan(4_050);
  });

  it("charges table cell inline searches to the shared 2M scan budget and falls back atomically", () => {
    const row = "| " + "**x** ".repeat(300) + "|\n";
    const text = "| A |\n|---|\n" + row.repeat(45);
    const { container } = mount(text);
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector(".markdown-literal")?.textContent).toBe(text);
    expect(screen.getByRole("note").textContent).toContain("解析预算");
    expect(container.querySelectorAll("*").length).toBeLessThan(4_050);
  });

  it("still clips 100Ki characters / 2000 lines with explicit notes", () => {
    const { container } = mount("| A |\n|---|\n" + "| x |\n".repeat(30_000));
    expect(screen.getAllByRole("note").some((note) => note.textContent?.includes("已截断"))).toBe(true);
    expect(container.querySelectorAll("*").length).toBeLessThan(4_050);
    expect(container.textContent!.length).toBeLessThan(100 * 1024 + 200);
  });
});

describe("TB-MD real consumers", () => {
  it("history entry expansion uses the same renderer and retains cells on rerender", async () => {
    const snap: SessionDetailSnapshot = { connState: "ready", errorKind: null, errorMessage: null, streamNote: null, file: "a.jsonl", phase: "live", subscriptionId: "sub-1", events: [{ seq: 1, ts: null, generation: null, intentId: null, kind: "message", entryId: "e-1", role: "assistant", final: true, blockCount: 1, textPreview: { text: source, truncated: true } }], liveEvents: [], status: null, cursor: null, uiRequests: [] };
    let calls = 0;
    const client = { subscribe: () => () => {}, getSnapshot: () => snap, subscribeSession: () => {}, unsubscribeSession: () => {}, resyncFromCursor: () => {}, answerUi: () => {}, expandEntry: async () => { calls++; return { ok: true as const, frame: { t: "entry" as const, requestId: "r-1", entryId: "e-1", source: "session" as const, digest: "fixture", state: "ok" as const, blocks: [{ kind: "text" as const, text: source }] } }; } };
    const view = render(React.createElement(SessionDetail, { client, file: "a.jsonl" }));
    expect(view.container.querySelector("table")).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "展开" })); });
    expectTable(view.container);
    // History has no collapse control; real collapse/reopen is tested below on final.
    view.rerender(React.createElement(SessionDetail, { client, file: "a.jsonl" }));
    expectTable(view.container);
    expect(calls).toBe(1);
  });

  it("delta preserves a partial table, final renders it, real collapse/reopen retains cells", async () => {
    const delta = (text: string): LiveEvent => ({ kind: "message-delta", part: "text", contentIndex: 0, delta: text });
    const events: LiveEvent[] = [delta("| Name | Value |")];
    const props = () => ({ liveEvents: [...events], historyEvents: [] });
    const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); };
    const view = render(React.createElement(LiveStreamView, props()));
    await flush();
    expect(view.container.querySelector("table")).toBeNull();
    expect(view.container.querySelector(".markdown-view")?.textContent).toBe("| Name | Value |");
    events.push(delta("\n| :--- | ---: |\n| **Alice** | `12` |\n| Bob | 8 |"));
    view.rerender(React.createElement(LiveStreamView, props()));
    await flush();
    expectTable(screen.getByLabelText("直播正文"));
    events.push({ kind: "message-final", role: "assistant", text: source });
    view.rerender(React.createElement(LiveStreamView, props()));
    await flush();
    const frozen = view.container.querySelector(".live-final")!;
    expectTable(frozen);
    events.push(delta("next"));
    view.rerender(React.createElement(LiveStreamView, props()));
    await flush();
    expect(frozen.querySelector("table")).toBeNull();
    fireEvent.click(frozen.querySelector("button")!);
    expectTable(frozen);
  });
});
