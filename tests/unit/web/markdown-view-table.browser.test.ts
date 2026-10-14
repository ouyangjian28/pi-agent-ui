// Real Chromium: full CSS, no production build, no server modifications.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { MarkdownView } from "../../../apps/web/src/components/markdown-view";

const CHROME = "/home/yyj/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell";

describe("TB-MD-3 table containment in real Chromium", () => {
  it.skipIf(!existsSync(CHROME))("scrolls only the table at 360/1024 in light/dark themes", { timeout: 60_000 }, async () => {
    const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
    try {
      const page = await browser.newPage();
      const css = readFileSync(join(process.cwd(), "apps/web/src/styles.css"), "utf8");
      const text = "# Table\n| A | B | C |\n|:---|:-:|---:|\n| <b>inert</b> | " + "long".repeat(400) + " | [bad](javascript:alert(1)) |\n| **bold** | [safe](https://example.test/) | 12 |";
      const markup = renderToStaticMarkup(React.createElement(MarkdownView, { text }));
      const colors: string[] = [];
      for (const width of [360, 1024]) {
        await page.setViewportSize({ width, height: 800 });
        for (const theme of ["light", "dark"]) {
          // Exercise both consumers' enclosing markup and the real two-column shell.
          await page.setContent(`<!doctype html><html data-theme="${theme}"><head><style>${css}</style></head><body><div class="real-app"><div class="workspace two-col"><aside class="sidebar">Sessions</aside><main class="conversation"><div class="conversation-body"><section class="session-detail"><ol class="history-list"><li class="chat-message chat-assistant">${markup}</li></ol></section><section class="live-stream"><article class="chat-message chat-assistant"><div class="live-stream-text">${markup}</div></article></section></div></main></div></div></body></html>`);
          const result = await page.evaluate(() => {
            const wraps = Array.from(document.querySelectorAll<HTMLElement>(".markdown-table-wrap"));
            return {
              pageWidth: document.documentElement.scrollWidth,
              viewport: innerWidth,
              bodyWidth: document.body.scrollWidth,
              conversationWidth: document.querySelector(".conversation-body")!.scrollWidth,
              conversationClient: document.querySelector(".conversation-body")!.clientWidth,
              tables: wraps.map((wrap) => {
                wrap.scrollLeft = 120;
                return { width: wrap.clientWidth, scroll: wrap.scrollWidth, left: wrap.scrollLeft, overflow: getComputedStyle(wrap).overflowX, right: wrap.getBoundingClientRect().right, background: getComputedStyle(wrap.querySelector("th")!).backgroundColor, foreground: getComputedStyle(wrap.querySelector("th")!).color, align: Array.from(wrap.querySelectorAll("th"), (th) => getComputedStyle(th).textAlign), text: wrap.textContent, safeLinks: wrap.querySelectorAll('a[href^="https:"]').length, activeTags: wrap.querySelectorAll("b, script, img").length };
              }),
            };
          });
          expect(result.pageWidth).toBeLessThanOrEqual(result.viewport);
          expect(result.bodyWidth).toBeLessThanOrEqual(result.viewport);
          expect(result.conversationWidth).toBeLessThanOrEqual(result.conversationClient);
          expect(result.tables).toHaveLength(2);
          for (const table of result.tables) {
            expect(table.width).toBeGreaterThan(0);
            expect(table.right).toBeLessThanOrEqual(width);
            expect(table.scroll).toBeGreaterThan(table.width);
            expect(table.left).toBe(120); // Actual scrolling, not hidden/clipped content.
            expect(table.overflow).toBe("auto");
            expect(table.align).toEqual(["left", "center", "right"]);
            expect(table.text).toContain("<b>inert</b>");
            expect(table.text).toContain("[bad](javascript:alert(1))");
            expect(table.safeLinks).toBe(1);
            expect(table.activeTags).toBe(0);
            expect(table.background).not.toBe(table.foreground);
          }
          colors.push(result.tables[0]!.background);
        }
      }
      expect(colors[0]).not.toBe(colors[1]);
      expect(colors[0]).toBe(colors[2]);
      expect(colors[1]).toBe(colors[3]);
    } finally { await browser.close(); }
  });
});
