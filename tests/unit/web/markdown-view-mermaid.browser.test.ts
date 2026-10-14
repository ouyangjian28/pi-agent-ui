// Actual Chromium + complete theme CSS; no production build or fixture writes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { MarkdownView } from "../../../apps/web/src/components/markdown-view";
const CHROME = "/home/yyj/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell";

describe("MM-2/MM-3 real Chromium geometry, safety and theme containment", () => {
  it("all shapes, labels, edges and cycles remain inside their scrollable canvas at 360/1024 × light/dark", { timeout: 60_000 }, async () => {
    // Do not silently skip frozen acceptance when the browser is unavailable.
    const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
    try {
      const page = await browser.newPage();
      const css = readFileSync(join(process.cwd(), "apps/web/src/styles.css"), "utf8");
      const text = ["```mermaid", "flowchart TD", "A[开始] --> B{分支 判断?}", "B -->|通过| C((完成))", "B -->|拒绝| D[" + "long中文😀".repeat(10) + "]", "D --> A", "D --> D", "```", "```mermaid", "graph LR", 'X[<img src=x onerror="alert(1)">] -->|label| Y[内嵌 [js](javascript:alert(2)) 链接]', "Y --> Z((终点))", "```"].join("\n");
      const markup = renderToStaticMarkup(React.createElement(MarkdownView, { text }));
      const themes: string[] = [];
      for (const width of [360, 1024]) for (const theme of ["light", "dark"]) {
        await page.setViewportSize({ width, height: 800 });
        await page.setContent(`<!doctype html><html data-theme="${theme}"><head><style>${css}</style></head><body><div class="real-app"><div class="workspace two-col"><aside class="sidebar">Sessions</aside><main class="conversation"><div class="conversation-body"><section class="session-detail"><ol class="history-list"><li class="chat-message chat-assistant">${markup}</li></ol></section><section class="live-stream"><article class="chat-message chat-assistant"><div class="live-stream-text">${markup}</div></article></section></div></main></div></div></body></html>`);
        const result = await page.evaluate(() => ({
          page: document.documentElement.scrollWidth, body: document.body.scrollWidth, viewport: innerWidth,
          conversation: document.querySelector(".conversation-body")!.scrollWidth,
          conversationClient: document.querySelector(".conversation-body")!.clientWidth,
          diagrams: Array.from(document.querySelectorAll<HTMLElement>(".markdown-mermaid-wrap"), (wrap) => {
            wrap.scrollLeft = 100;
            wrap.scrollTop = 100;
            const svg = wrap.querySelector("svg")!;
            const view = svg.viewBox.baseVal;
            const boxes = Array.from(svg.querySelectorAll<SVGGraphicsElement>(".mermaid-node, .mermaid-edge, .mermaid-edge-text"), (node) => {
              const box = node.getBBox();
              const matrix = node.transform.baseVal.consolidate()?.matrix;
              return { x: box.x + (matrix?.e ?? 0), y: box.y + (matrix?.f ?? 0), width: box.width, height: box.height };
            });
            const nodeTextFits = Array.from(svg.querySelectorAll<SVGGElement>(".mermaid-node"), (node) => {
              const shape = node.firstElementChild as SVGGraphicsElement;
              const shapeBox = shape.getBBox();
              const textBox = node.querySelector("text")!.getBBox();
              return textBox.x >= shapeBox.x && textBox.x + textBox.width <= shapeBox.x + shapeBox.width && textBox.y >= shapeBox.y && textBox.y + textBox.height <= shapeBox.y + shapeBox.height;
            });
            const shape = svg.querySelector(".mermaid-node > rect, .mermaid-node > circle, .mermaid-node > polygon")!;
            return { client: wrap.clientWidth, scroll: wrap.scrollWidth, left: wrap.scrollLeft, top: wrap.scrollTop, scrollHeight: wrap.scrollHeight, clientHeight: wrap.clientHeight, overflow: getComputedStyle(wrap).overflowX, width: view.width, height: view.height, boxes, nodeTextFits, fill: getComputedStyle(shape).fill, textFill: getComputedStyle(svg.querySelector("text")!).fill, active: svg.querySelectorAll("a,img,script,foreignObject,use,iframe").length, badAttributes: Array.from(svg.querySelectorAll("*"), (node) => Array.from(node.attributes).filter((attr) => /^on|href/i.test(attr.name)).length).reduce((a, b) => a + b, 0), text: svg.textContent };
          }),
        }));
        expect(result.page).toBeLessThanOrEqual(result.viewport);
        expect(result.body).toBeLessThanOrEqual(result.viewport);
        expect(result.conversation).toBeLessThanOrEqual(result.conversationClient);
        expect(result.diagrams).toHaveLength(4);
        for (const diagram of result.diagrams) {
          expect(diagram.overflow).toBe("auto");
          expect(diagram.client).toBeGreaterThan(0);
          if (diagram.scroll > diagram.client) expect(diagram.left).toBeGreaterThan(0);
          if (diagram.scrollHeight > diagram.clientHeight) expect(diagram.top).toBeGreaterThan(0);
          expect(diagram.nodeTextFits.every(Boolean)).toBe(true);
          for (const box of diagram.boxes) {
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.y).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width).toBeLessThanOrEqual(diagram.width);
            expect(box.y + box.height).toBeLessThanOrEqual(diagram.height);
          }
          expect(diagram.fill).not.toBe(diagram.textFill);
          expect(diagram.active).toBe(0);
          expect(diagram.badAttributes).toBe(0);
        }
        expect(result.diagrams[1]!.text).toContain('<img src=x onerror="alert(1)">');
        themes.push(result.diagrams[0]!.fill);
        const wrap = page.locator(".markdown-mermaid-wrap").first();
        await wrap.focus();
        expect(await wrap.evaluate((node) => node === document.activeElement)).toBe(true);
      }
      expect(themes[0]).not.toBe(themes[1]);
      expect(themes[0]).toBe(themes[2]);
      expect(themes[1]).toBe(themes[3]);
    } finally { await browser.close(); }
  });
});
