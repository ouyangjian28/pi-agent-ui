// Actual React consumers in Chromium, with native writeText success separated
// from simulated rejection/missing API. Clipboard contents are NEVER read.
import { chromium, type Page } from "playwright";
import { createServer } from "vite";
import { describe, expect, it } from "vitest";

type CopyWindow = Window & { cp: { calls: string[]; finish(): void; next(): void }; clipboardProbe: { writes: string[]; fulfilled: string[]; mode: string; reads: number } };
const CHROME = "/home/yyj/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell";
const source = '# 原文😀\r\n\r\n| A | B |\r\n| --- | --- |\r\n| **x** | `y` |\r\n```mermaid\r\nflowchart TD\r\nA[开始] --> B{结束?}\r\n```\r\n<script>alert(1)</script> [x](javascript:alert(2))\r\n尾字  \r\n';
// Virtual entry only; no fixture/dist/server file writes and no extra dependency.
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { SessionDetail } from '/apps/web/src/components/session-detail.tsx';
import { LiveStreamView } from '/apps/web/src/components/live-stream.tsx';
import '/apps/web/src/styles.css';
const source = ${JSON.stringify(source)};
const calls = []; const listeners = new Set();
const snapshot = {connState:'ready',errorKind:null,errorMessage:null,streamNote:null,file:'a.jsonl',phase:'live',subscriptionId:'s1',events:[{seq:1,ts:null,generation:null,intentId:null,kind:'message',entryId:'e-1',role:'assistant',final:true,blockCount:1,textPreview:{text:'截断预览，不得复制',truncated:true}}],liveEvents:[],status:null,cursor:null,uiRequests:[]};
const client = {subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},getSnapshot:()=>snapshot,subscribeSession(){},unsubscribeSession(){},resyncFromCursor(){calls.push('resync');},answerUi(){calls.push('answer');},expandEntry:async(file,id)=>{calls.push('entry-get');return {ok:true,frame:{t:'entry',requestId:'r1',entryId:id,source:'session',digest:'fnv1a64:a',state:'ok',blocks:[{kind:'thinking',text:'PRIVATE'},{kind:'text',text:source},{kind:'toolCall',toolCallId:'t1',toolName:'bash',argsPreview:'PRIVATE TOOL'}]}};}};
const events = []; const delta={kind:'message-delta',part:'text',contentIndex:0,delta:'生成中'};
const liveRoot = createRoot(document.getElementById('live'));
const renderLive=()=>liveRoot.render(React.createElement(LiveStreamView,{liveEvents:[...events],historyEvents:[]}));
createRoot(document.getElementById('history')).render(React.createElement(SessionDetail,{client,file:'a.jsonl'}));
window.cp = {source,calls,finish(){events.push({kind:'message-final',role:'assistant',text:source});renderLive();},next(){events.push(delta);renderLive();}};
events.push(delta);renderLive();
`;
async function pressCopy(page: Page, target: "history" | "live", touch: boolean) {
  const button = page.locator(`#${target}`).getByRole("button", { name: "复制完整回复原文" });
  await expectVisible(button);
  if (touch) await button.tap(); else await button.click();
}
async function expectVisible(button: ReturnType<Page["getByRole"]>) {
  expect(await button.isVisible()).toBe(true);
  await button.scrollIntoViewIfNeeded();
  const box = await button.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(box!.width).toBeGreaterThanOrEqual(44);
}

describe("CP-1~4 Chromium clipboard/keyboard/tap/theme acceptance", () => {
  it("360/1024 × light/dark: native success, loaded source, final, real reopen, denial and manual fallback", { timeout: 60_000 }, async () => {
    const server = await createServer({ configFile: false, root: process.cwd(), server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "cp-test-only", resolveId(id) { if (id === "/__cp-entry.tsx") return id; }, load(id) { if (id === "/__cp-entry.tsx") return entry; }, configureServer(vite) { vite.middlewares.use((req, res, next) => { if (req.url !== "/__cp.html") return next(); res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end('<!doctype html><html><body><div class="real-app"><main class="conversation"><div class="conversation-body"><label>草稿<textarea id="draft">未发送草稿</textarea></label><div id="history"></div><div id="live"></div></div></main></div><script type="module" src="/__cp-entry.tsx"></script></body></html>'); }); } }] });
    await server.listen();
    const address = server.httpServer!.address() as { port: number };
    const origin = `http://127.0.0.1:${address.port}`;
    const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
    try {
      for (const width of [360, 1024]) for (const theme of ["light", "dark"]) {
        const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: width === 360, permissions: ["clipboard-write"] });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.addInitScript(() => {
          const nativeWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
          const writes: string[] = []; const fulfilled: string[] = [];
          Object.assign(window, { clipboardProbe: { writes, fulfilled, mode: "native", reads: 0 } });
          Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, value: async (text: string) => {
            const probe = (window as CopyWindow).clipboardProbe;
            writes.push(text);
            if (probe.mode === "denied") throw new DOMException("Denied", "NotAllowedError");
            await nativeWrite(text); fulfilled.push(text);
          } });
          Object.defineProperty(navigator.clipboard, "readText", { configurable: true, value: () => { (window as CopyWindow).clipboardProbe.reads++; throw new Error("Never read clipboard"); } });
        });
        await page.goto(`${origin}/__cp.html`);
        await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
        await page.locator("#history .reply-copy-button").waitFor();
        expect(await page.locator("#live .reply-copy-button").count()).toBe(0);
        // Real native write under secure localhost; wrapper observes its promise,
        // not readText, and does not turn a rejection into success.
        await pressCopy(page, "history", width === 360);
        await page.locator("#history .reply-copy-status").filter({ hasText: "已复制" }).waitFor();
        expect(await page.evaluate(() => (window as CopyWindow).clipboardProbe.fulfilled)).toEqual([source]);
        expect(await page.evaluate(() => (window as CopyWindow).cp.calls)).toEqual(["entry-get"]);
        expect(await page.locator("#history table").count()).toBe(1);
        expect(await page.locator("#history svg").count()).toBe(1);
        expect(await page.locator("#history script, #history img").count()).toBe(0);
        // Already-loaded path; no extra entry-get.
        await pressCopy(page, "history", width === 360);
        await page.waitForFunction(() => (window as CopyWindow).clipboardProbe.fulfilled.length === 2);
        expect(await page.evaluate(() => (window as CopyWindow).cp.calls)).toEqual(["entry-get"]);
        await page.evaluate(() => (window as CopyWindow).cp.finish());
        await page.locator("#live .live-final .reply-copy-button").waitFor();
        await pressCopy(page, "live", width === 360);
        await page.waitForFunction(() => (window as CopyWindow).clipboardProbe.fulfilled.length === 3);
        await page.evaluate(() => (window as CopyWindow).cp.next());
        const toggle = page.locator("#live .frozen-summary");
        await toggle.waitFor();
        expect(await page.locator("#live .frozen-content").count()).toBe(0);
        await toggle.click();
        expect(await page.locator("#live .frozen-content table").count()).toBe(1);
        expect(await page.locator("#live .frozen-content svg").count()).toBe(1);
        // Actual Tab navigation to the copy button, then Enter (not .focus()).
        await toggle.focus();
        for (let i = 0; i < 10; i++) {
          await page.keyboard.press("Tab");
          if (await page.locator("#live .reply-copy-button").evaluate((node) => node === document.activeElement)) break;
        }
        expect(await page.locator("#live .reply-copy-button").evaluate((node) => node === document.activeElement)).toBe(true);
        expect(await page.locator("#live .reply-copy-button").evaluate((node) => getComputedStyle(node).outlineStyle)).not.toBe("none");
        await page.keyboard.press("Enter");
        await page.waitForFunction(() => (window as CopyWindow).clipboardProbe.fulfilled.length === 4);
        expect(await page.evaluate(() => (window as CopyWindow).clipboardProbe.fulfilled)).toEqual([source, source, source, source]);
        // Simulated refusal is deliberately separate from the native-success layer.
        await page.evaluate(() => { (window as CopyWindow).clipboardProbe.mode = "denied"; });
        await pressCopy(page, "live", width === 360);
        await page.locator("#live [role=alert]").waitFor();
        expect(await page.locator("#live .reply-copy-status").filter({ hasText: "已复制" }).count()).toBe(0);
        const manual = page.getByRole("textbox", { name: "回复原文（手工复制）" });
        expect(await manual.inputValue()).toBe(source.replace(/\r\n/g, "\n"));
        await manual.focus();
        expect(await manual.evaluate((node) => { const area = node as HTMLTextAreaElement; return area.selectionStart === 0 && area.selectionEnd === area.value.length && area.readOnly; })).toBe(true);
        await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined }); });
        await pressCopy(page, "live", width === 360);
        expect(await page.locator("#live [role=alert]").textContent()).toContain("复制失败");
        expect(await page.locator("#draft").inputValue()).toBe("未发送草稿");
        expect(await page.evaluate(() => (window as CopyWindow).cp.calls)).toEqual(["entry-get"]);
        expect(await page.evaluate(() => (window as CopyWindow).clipboardProbe.reads)).toBe(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(errors).toEqual([]);
        await context.close();
      }
    } finally { await browser.close(); await server.close(); }
  });
});
