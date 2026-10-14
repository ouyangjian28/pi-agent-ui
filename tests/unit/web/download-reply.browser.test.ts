// Native Chromium downloads, never a synthetic click/save success assertion.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { chromium, type Download, type Page } from "playwright";
import { createServer } from "vite";
import { describe, expect, it } from "vitest";

const label = "下载完整回复原文为 Markdown";
const CHROME = "/home/yyj/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell";
const source = '# 原文😀\r\n\r\n| A | B |\r\n| --- | --- |\r\n| **x** | `y` |\r\n```ts\r\nconst n = 1;  \r\n```\r\n```mermaid\r\nflowchart TD\r\nA[开始] --> B{结束?}\r\n```\r\n<script>alert(1)</script> [x](javascript:alert(2))\r\n' + "z".repeat(103_000) + "\r\n尾字  \r\n";
type DLWindow = Window & {
  dl: { calls: string[]; source: string; finish(): void; next(): void };
  downloadProbe: { mode: string; types: string[]; urls: string[]; revoked: string[]; reads: number };
};
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { SessionDetail } from '/apps/web/src/components/session-detail.tsx';
import { LiveStreamView } from '/apps/web/src/components/live-stream.tsx';
import '/apps/web/src/styles.css';
const source = ${JSON.stringify(source)};
const calls = []; const listeners = new Set();
const snapshot = {connState:'ready',errorKind:null,errorMessage:null,streamNote:null,file:'a.jsonl',phase:'live',subscriptionId:'s1',events:[{seq:1,ts:null,generation:null,intentId:null,kind:'message',entryId:'../../evil.exe',role:'assistant',final:true,blockCount:1,textPreview:{text:'截断预览，不得下载',truncated:true}}],liveEvents:[],status:null,cursor:null,uiRequests:[]};
const client = {subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},getSnapshot:()=>snapshot,subscribeSession(){},unsubscribeSession(){},resyncFromCursor(){calls.push('resync');},answerUi(){calls.push('answer');},expandEntry:async(file,id)=>{calls.push('entry-get');return {ok:true,frame:{t:'entry',requestId:'r1',entryId:id,source:'session',digest:'fnv1a64:a',state:'ok',blocks:[{kind:'thinking',text:'PRIVATE'},{kind:'text',text:source.slice(0,source.indexOf('| A'))},{kind:'text',text:source.slice(source.indexOf('| A'))},{kind:'toolCall',toolCallId:'t1',toolName:'bash',argsPreview:'PRIVATE TOOL'}]}};}};
const events = []; const delta={kind:'message-delta',part:'text',contentIndex:0,delta:'生成中'};
const liveRoot = createRoot(document.getElementById('live'));
const renderLive=()=>liveRoot.render(React.createElement(LiveStreamView,{liveEvents:[...events],historyEvents:[]}));
createRoot(document.getElementById('history')).render(React.createElement(SessionDetail,{client,file:'a.jsonl'}));
window.dl = {source,calls,finish(){events.push({kind:'message-final',role:'assistant',text:source});renderLive();},next(){events.push(delta);renderLive();}};
events.push(delta);renderLive();
`;
async function button(page: Page, target: "history" | "live") {
  const node = page.locator(`#${target}`).getByRole("button", { name: label });
  await node.waitFor(); await node.scrollIntoViewIfNeeded();
  expect(await node.isVisible()).toBe(true);
  const box = await node.boundingBox(); expect(box!.height).toBeGreaterThanOrEqual(44); expect(box!.width).toBeGreaterThanOrEqual(44);
  return node;
}
async function nativeDownload(page: Page, action: () => Promise<unknown>, downloads: Download[]) {
  const before = downloads.length;
  const pending = page.waitForEvent("download"); await action(); const saved = await pending;
  expect(downloads.length).toBe(before + 1); expect(downloads[before]).toBe(saved);
  expect(await saved.failure()).toBeNull(); expect(saved.suggestedFilename()).toMatch(/^reply-[0-9]+\.md$/);
  const path = await saved.path(); expect(path).not.toBeNull();
  const bytes = await readFile(path!);
  // Compare the actual saved UTF-8 bytes to the component's original text, not DOM.
  const componentSource = await page.evaluate(() => (window as DLWindow).dl.source);
  expect(componentSource).toBe(source); expect(bytes.equals(Buffer.from(componentSource, "utf8"))).toBe(true);
  return { filename: saved.suggestedFilename(), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

describe("DL-1~4 native download / failure separation / touch and keyboard", () => {
  it("360/1024 × light/dark: real saved bytes, loaded/unloaded, final, frozen reopen, honest failures", { timeout: 60_000 }, async () => {
    const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: `/tmp/pi-agent-ui-dl-vite-${process.pid}`, server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "dl-test-only", resolveId(id) { if (id === "/__dl-entry.tsx") return id; }, load(id) { if (id === "/__dl-entry.tsx") return entry; }, configureServer(vite) { vite.middlewares.use((req, res, next) => { if (req.url !== "/__dl.html") return next(); res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end('<!doctype html><html><body><div class="real-app"><main class="conversation"><div class="conversation-body"><label>草稿<textarea id="draft">未发送草稿</textarea></label><div id="history"></div><div id="live"></div></div></main></div><script type="module" src="/__dl-entry.tsx"></script></body></html>'); }); } }] });
    await server.listen(); const address = server.httpServer!.address() as { port: number };
    const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
    const evidence = "/home/yyj/ai/runs/ui-acceptance-20261013/gpt61-dl-evidence"; await mkdir(evidence, { recursive: true });
    const results: { width: number; theme: string; filename: string; bytes: number; sha256: string }[] = [];
    try {
      for (const width of [360, 1024]) for (const theme of ["light", "dark"]) {
        const context = await browser.newContext({ acceptDownloads: true, viewport: { width, height: 800 }, hasTouch: width === 360 });
        const page = await context.newPage(); const downloads: Download[] = []; const errors: string[] = []; const dialogs: string[] = [];
        page.on("download", (download) => downloads.push(download));
        const capture = async (action: () => Promise<unknown>) => { results.push({ width, theme, ...await nativeDownload(page, action, downloads) }); };
        page.on("pageerror", (error) => errors.push(error.message)); page.on("dialog", async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss(); });
        await page.addInitScript(() => {
          const probe = { mode: "native", types: [] as string[], urls: [] as string[], revoked: [] as string[], reads: 0 };
          Object.assign(window, { downloadProbe: probe });
          const NativeBlob = Blob; const create = URL.createObjectURL.bind(URL); const revoke = URL.revokeObjectURL.bind(URL); const click = HTMLAnchorElement.prototype.click;
          window.Blob = new Proxy(NativeBlob, { construct(target, args: ConstructorParameters<typeof Blob>) { if (probe.mode === "blob") throw new Error("Synthetic Blob failure"); return new target(...args); } });
          URL.createObjectURL = (blob: Blob | MediaSource) => { if (probe.mode === "url") throw new Error("Synthetic ObjectURL failure"); if (blob instanceof NativeBlob) probe.types.push(blob.type); const url = create(blob); probe.urls.push(url); return url; };
          URL.revokeObjectURL = (url) => { probe.revoked.push(url); revoke(url); };
          HTMLAnchorElement.prototype.click = function () { if (probe.mode === "click") throw new Error("Synthetic preparation click failure"); click.call(this); };
          Object.defineProperty(navigator.clipboard, "readText", { configurable: true, value: () => { probe.reads++; throw new Error("Never read clipboard"); } });
        });
        await page.goto(`http://127.0.0.1:${address.port}/__dl.html`);
        await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
        const history = await button(page, "history"); expect(await page.locator("#live .reply-download-button").count()).toBe(0);
        // Native path, no stubs for Blob/ObjectURL/click/download/save.
        await capture(() => width === 360 ? history.tap() : history.click());
        await page.locator("#history .reply-download [role=status]").filter({ hasText: "已发起下载" }).waitFor();
        expect(await page.evaluate(() => (window as DLWindow).dl.calls)).toEqual(["entry-get"]);
        expect(await page.locator("#history table").count()).toBe(1); expect(await page.locator("#history svg").count()).toBe(1); expect(await page.locator("#history pre code").count()).toBeGreaterThan(0);
        expect(await page.locator("#history script, #history img").count()).toBe(0);
        await button(page, "history");
        await page.screenshot({ path: `${evidence}/${width}-${theme}-history.png` });
        await capture(() => width === 360 ? history.tap() : history.click());
        expect(await page.evaluate(() => (window as DLWindow).dl.calls)).toEqual(["entry-get"]);
        await page.evaluate(() => (window as DLWindow).dl.finish());
        const live = await button(page, "live");
        await capture(() => width === 360 ? live.tap() : live.click());
        await page.screenshot({ path: `${evidence}/${width}-${theme}-final.png` });
        await page.evaluate(() => (window as DLWindow).dl.next());
        const toggle = page.locator("#live .frozen-summary"); await toggle.waitFor();
        expect(await page.locator("#live .frozen-content").count()).toBe(0); expect(await page.locator("#live .reply-download-button").count()).toBe(0);
        if (width === 360) await toggle.tap(); else await toggle.click();
        expect(await page.locator("#live .frozen-content table").count()).toBe(1); expect(await page.locator("#live .frozen-content svg").count()).toBe(1);
        // Start from the actual clicked toggle. Reach download through real Tab.
        for (let i = 0; i < 12; i++) { await page.keyboard.press("Tab"); if (await live.evaluate((node) => node === document.activeElement)) break; }
        expect(await live.evaluate((node) => node === document.activeElement)).toBe(true);
        expect(await live.evaluate((node) => getComputedStyle(node).outlineStyle)).not.toBe("none");
        await capture(() => page.keyboard.press("Enter"));
        expect(downloads).toHaveLength(4);
        // Preparation failure layer, explicitly separate from the native saves above.
        for (const mode of ["blob", "url", "click"]) {
          await page.evaluate((value) => { (window as DLWindow).downloadProbe.mode = value; }, mode);
          if (width === 360) await live.tap(); else await live.click();
          await page.locator("#live .reply-download [role=alert]").waitFor();
          expect(await page.locator("#live .reply-download").textContent()).toContain("下载失败");
          expect(await page.locator("#live .reply-download").textContent()).not.toContain("已发起下载");
          expect(downloads).toHaveLength(4);
        }
        await page.waitForFunction(() => { const p = (window as DLWindow).downloadProbe; return p.urls.length === p.revoked.length; });
        const probe = await page.evaluate(() => (window as DLWindow).downloadProbe);
        expect(probe.types).toEqual(Array(5).fill("text/markdown")); expect(new Set(probe.revoked)).toEqual(new Set(probe.urls)); expect(probe.reads).toBe(0);
        expect(await page.locator("a[download]").count()).toBe(0); expect(await page.getByText(/已保存/).count()).toBe(0);
        expect(await page.locator("#draft").inputValue()).toBe("未发送草稿"); expect(await page.evaluate(() => (window as DLWindow).dl.calls)).toEqual(["entry-get"]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(errors).toEqual([]); expect(dialogs).toEqual([]);
        console.log(`DL_NATIVE ${width}/${theme}: 4 downloads × ${Buffer.byteLength(source)} exact UTF-8 bytes; 3 separate synthetic failures; reads=0`);
        await context.close();
      }
      await writeFile(`${evidence}/results.json`, JSON.stringify(results, null, 2) + "\n");
    } finally { await browser.close(); await server.close(); }
  });
});
