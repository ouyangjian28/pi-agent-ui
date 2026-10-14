// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MarkdownView } from "../../../apps/web/src/components/markdown-view";

// Assert the component DOM tree and text nodes, never serialized innerHTML.
afterEach(cleanup);
const mount = (text: string) => render(React.createElement(MarkdownView, { text }));

describe("I3-MD core syntax", () => {
  it("renders multiline fenced code literally with an optional language label", () => {
    const code = 'const x = "<script>";\nconsole.log(`**not bold** ${x}`);\n';
    const { container } = mount("```typescript\n" + code + "```\n\n```\nplain\n```");
    const blocks = container.querySelectorAll("pre > code");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.textContent).toBe(code);
    expect(blocks[1]!.textContent).toBe("plain\n");
    expect(screen.getByText("typescript").className).toBe("markdown-language");
    expect(container.querySelector("strong, script")).toBeNull();
  });

  it("accepts CRLF and a longer closing fence, preserving code whitespace", () => {
    const { container } = mount("```` js\r\n  x\r\n```\r\n````\r\n");
    expect(container.querySelector("pre > code")?.textContent).toBe("  x\r\n```\r\n");
  });

  it("mixes inline code, bold and italic, including one nested emphasis", () => {
    const { container } = mount("Text `a < b` **bold *em*** and *soft **strong***; ***both*** _other_ __heavy__.");
    expect(container.querySelector("p > code")?.textContent).toBe("a < b");
    expect(container.querySelector("p > strong > em")?.textContent).toBe("em");
    expect(container.querySelector("p > em > strong")?.textContent).toBe("strong");
    expect(screen.getByText("both").tagName).toBe("EM");
    expect(screen.getByText("both").parentElement?.tagName).toBe("STRONG");
    expect(screen.getByText("other").tagName).toBe("EM");
    expect(screen.getByText("heavy").tagName).toBe("STRONG");
    expect(container.querySelector(".markdown-view")?.textContent).toBe("Text a < b bold em and soft strong; both other heavy.");
  });

  it("does not close emphasis on a delimiter inside code", () => {
    const { container } = mount("*before `*` after*");
    expect(container.querySelector("em > code")?.textContent).toBe("*");
    expect(container.querySelector("em")?.textContent).toBe("before * after");
  });

  it("renders unordered and ordered lists nested one level in either direction", () => {
    const { container } = mount("- outer\n  3. nested first\n  4. nested second\n- sibling\n\n2. ordered\n   - nested bullet\n3. last");
    const root = container.querySelector(".markdown-view")!;
    expect(root.querySelectorAll(":scope > ul > li")).toHaveLength(2);
    expect(root.querySelectorAll(":scope > ul > li > ol > li")).toHaveLength(2);
    expect(root.querySelector("ul > li > ol")?.getAttribute("start")).toBe("3");
    expect(root.querySelectorAll(":scope > ol > li")).toHaveLength(2);
    expect(root.querySelectorAll(":scope > ol > li > ul > li")).toHaveLength(1);
    expect(root.querySelector(":scope > ol")?.getAttribute("start")).toBe("2");
    expect(screen.getByText("nested bullet").tagName).toBe("LI");
  });

  it.each(["https://example.test/docs", "http://example.test/a_(b)?x=1&y=2", "HTTPS://example.test/"])("allows safe link %s with fixed navigation protections", (href) => {
    mount(`[read **docs**](${href})`);
    const link = screen.getByRole("link", { name: "read docs" });
    expect(link.getAttribute("href")).toBe(href);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.querySelector("strong")?.textContent).toBe("docs");
  });

  it("renders h1-h3 and leaves h4 spelling intact", () => {
    mount("# One\n## Two\n### Three `x`\n#### Four");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("One");
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Two");
    expect(screen.getByRole("heading", { level: 3 }).querySelector("code")?.textContent).toBe("x");
    expect(screen.queryByRole("heading", { level: 4 })).toBeNull();
    expect(screen.getByText("#### Four")).toBeTruthy();
  });
});

describe("I3-MD zero-trust and literal fallback", () => {
  it.each([
    "<script>alert(1)</script>",
    '<img src=x onerror="alert(1)">',
    '<a href="javascript:alert(1)">click</a>',
    '<svg onload="alert(1)"></svg>',
  ])("keeps HTML as text, not elements: %s", (text) => {
    const { container } = mount(text);
    expect(container.querySelector(".markdown-view")?.textContent).toBe(text);
    expect(container.querySelector("script, img, a, svg")).toBeNull();
  });

  it.each([
    "javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>alert(1)</script>",
    "vbscript:alert(1)", "file:///etc/passwd", "//example.test", "/relative", "mailto:x@example.test",
    "https://", "https://example.test/ bad", "https://example.test/\u0000bad", "jav&#x61;script:alert(1)",
  ])("keeps unsafe/unsupported link wholly literal: %s", (href) => {
    const text = `[**x**](${href})`;
    const { container } = mount(text);
    expect(container.querySelector("a, strong")).toBeNull();
    expect(container.querySelector(".markdown-view")?.textContent).toBe(text);
  });

  it.each([
    "![image](https://example.test/a.png)", "> quote", "| a | b |\n| 1 | 2 |", // Missing table separator stays literal.
    "~~strike~~", "foo_bar_baz", "[broken](", "**open", "****unknown****",
    "``**literal**``", "``**half**", "`not closed by double``",
  ])("preserves unsupported or partial spelling: %s", (text) => {
    const { container } = mount(text);
    expect(container.querySelector(".markdown-view")?.textContent).toBe(text);
    expect(container.querySelector("img, table, blockquote, del, a")).toBeNull();
  });

  it("treats mermaid as literal fenced code, not a diagram or embed", () => {
    const { container } = mount("```mermaid\ngraph TD; A-->B\n```");
    expect(container.querySelector("pre > code")?.textContent).toBe("graph TD; A-->B\n");
    expect(container.querySelector("svg, iframe, img")).toBeNull();
  });

  it("retains deeper list markers rather than dropping unsupported nesting", () => {
    const { container } = mount("- a\n  - b\n    - c\n- d");
    expect(container.querySelectorAll("ul")).toHaveLength(2);
    expect(container.querySelector(".markdown-literal")?.textContent).toBe("\n    - c\n");
    expect(screen.getByText("d").tagName).toBe("LI");
  });
});

describe("I3-MD incremental frames", () => {
  it.each(["```", "```ts\n", "```ts\n# keep **literal**\n- item\n", "before `", "before `**half** <img>\n", "`half"])("does not lose characters or parse a half-open construct: %s", (text) => {
    const { container } = mount(text);
    expect(container.querySelector(".markdown-view")?.textContent).toBe(text);
    expect(container.querySelector("pre, code, strong, img, h1, ul")).toBeNull();
  });

  it("re-renders opening-only -> content -> closed -> incomplete without stale syntax", () => {
    const view = mount("```js\n");
    for (const text of ["```js\nconst x = 1;\n", "```js\nconst x = 1;\n```"]) {
      view.rerender(React.createElement(MarkdownView, { text }));
    }
    expect(view.container.querySelector("pre > code")?.textContent).toBe("const x = 1;\n");
    view.rerender(React.createElement(MarkdownView, { text: "```js\n" }));
    expect(view.container.querySelector("pre")).toBeNull();
    expect(view.container.querySelector(".markdown-view")?.textContent).toBe("```js\n");
  });

  it("preserves source truncation separately from syntax", () => {
    const { container } = render(React.createElement(MarkdownView, { text: "**bold**", truncated: true }));
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(screen.getByLabelText("原文已截断").textContent).toBe("…");
  });
});

describe("I3-MD rendering budgets", () => {
  it("caps a huge message before parsing, with an explicit truncation note", () => {
    const { container } = mount("x".repeat(150_000) + "NEVER_DISPLAY");
    expect(container.querySelector(".markdown-view > p")?.textContent).toHaveLength(100 * 1024);
    expect(screen.getByRole("note").textContent).toContain("已截断");
    expect(container.textContent).not.toContain("NEVER_DISPLAY");
  });

  it("does not split a Unicode surrogate pair at the display boundary", () => {
    const { container } = mount("x".repeat(100 * 1024 - 1) + "😀tail");
    expect(container.querySelector(".markdown-view > p")?.textContent).toBe("x".repeat(100 * 1024 - 1));
  });

  it("caps newline-heavy input at 2,000 lines with a note", () => {
    const { container } = mount("line\n".repeat(3_000));
    expect(container.querySelector(".markdown-view > p")?.textContent).toBe("line\n".repeat(2_000));
    expect(screen.getByRole("note").textContent).toContain("2,000 行");
  });

  it("keeps a long inline line wholly literal instead of scanning its delimiters", () => {
    const text = "**bold**" + "`*[(".repeat(1_100);
    const { container } = mount(text);
    expect(container.querySelector(".markdown-view")?.textContent).toBe(text);
    expect(container.querySelector("strong, code, a")).toBeNull();
  });

  it("handles a near-limit invalid fence info line without quadratic whitespace backtracking", () => {
    const text = "```" + " ".repeat(95_000) + "!";
    const { container } = mount(text);
    expect(container.querySelector(".markdown-view")?.textContent).toBe(text);
    expect(container.querySelector("pre")).toBeNull();
  });

  it("also stops list parsing at the shared scan budget, retaining remaining markers", () => {
    const text = ("- " + "**x** ".repeat(300) + "\n").repeat(45);
    const { container } = mount(text);
    expect(screen.getByRole("note").textContent).toContain("解析预算");
    expect(container.querySelector(".markdown-view > .markdown-literal")?.textContent).toContain("- **x**");
    expect(container.textContent?.match(/x/g)).toHaveLength(13_500);
    expect(container.querySelectorAll("*").length).toBeLessThan(4_050);
  });

  it("degrades delimiter-heavy input to text with a bounded element count", () => {
    const text = ("**x** ".repeat(300) + "\n").repeat(45);
    const { container } = mount(text);
    const note = screen.getByRole("note");
    expect(note.textContent).toContain("解析预算");
    expect(container.querySelectorAll("*").length).toBeLessThan(4_050);
    // All non-delimiter content remains present even after budget fallback.
    expect(container.textContent?.match(/x/g)).toHaveLength(13_500);
  });
});
