// Real Chromium layout/theme probe; no production build or deployment.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { MarkdownView } from "../../../apps/web/src/components/markdown-view";

const CHROME = "/home/yyj/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell";

describe("I3-MD real browser containment and themes", () => {
  it.skipIf(!existsSync(CHROME))("keeps code scrolling local at mobile/desktop widths in both themes", { timeout: 60_000 }, async () => {
    const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
    try {
      const page = await browser.newPage();
      const css = readFileSync(join(process.cwd(), "apps/web/src/styles.css"), "utf8");
      const text = "# One\n## Two\n### Three\n- item\n  1. nested\n[link](https://example.test)\n```ts\n" + "x".repeat(2_000) + "\n```";
      const markup = renderToStaticMarkup(React.createElement(MarkdownView, { text }));
      const colors: string[] = [];
      for (const width of [360, 1_024]) {
        await page.setViewportSize({ width, height: 800 });
        await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body><div class="real-app"><main class="conversation"><section class="session-detail"><article class="chat-message"><h2 class="conversation-heading">Session</h2>${markup}</article></section></main></div></body></html>`);
        for (const theme of ["light", "dark"]) {
          await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
          const state = await page.evaluate(() => {
            const root = document.querySelector<HTMLElement>(".markdown-view")!;
            const pre = root.querySelector("pre")!;
            const style = getComputedStyle(pre);
            return {
              pageWidth: document.documentElement.scrollWidth,
              viewport: window.innerWidth,
              codeWidth: pre.clientWidth,
              codeScroll: pre.scrollWidth,
              overflow: style.overflowX,
              whitespace: style.whiteSpace,
              font: style.fontFamily,
              background: style.backgroundColor,
              tokenBackground: getComputedStyle(document.documentElement).getPropertyValue("--c-neutral-bg").trim(),
              headings: Array.from(root.querySelectorAll("h1,h2,h3"), (node) => Number.parseFloat(getComputedStyle(node).fontSize)),
              listIndent: Number.parseFloat(getComputedStyle(root.querySelector("ul")!).paddingLeft),
              color: getComputedStyle(root).color,
              linkColor: getComputedStyle(root.querySelector("a")!).color,
            };
          });
          expect(state.pageWidth).toBeLessThanOrEqual(state.viewport);
          expect(state.codeScroll).toBeGreaterThan(state.codeWidth);
          expect(state.overflow).toBe("auto");
          expect(state.whitespace).toBe("pre");
          expect(state.font).toContain("monospace");
          expect(state.headings).toEqual([15, 14, 13]);
          expect(state.listIndent).toBeGreaterThan(0);
          expect(state.linkColor).not.toBe(state.color);
          colors.push(state.background);
          expect(state.tokenBackground).toBeTruthy();
        }
      }
      expect(colors[0]).not.toBe(colors[1]);
      expect(colors[0]).toBe(colors[2]);
      expect(colors[1]).toBe(colors[3]);
    } finally {
      await browser.close();
    }
  });
});
