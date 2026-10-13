// GT 视觉修复回归：真实 Chromium 触摸事件 + 生产构建 + 合成 WS；不连接生产。
// 运行：node tests/browser/ui-visfix-capture.mjs <报告目录>
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join, extname } from "node:path";
import { chromium } from "playwright";

const repo = resolve(import.meta.dirname, "../..");
const dist = join(repo, "apps/web/dist");
const out = resolve(process.argv[2] ?? join(repo, "apps/web/dist/visfix-evidence"));
await mkdir(out, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const target = resolve(dist, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!target.startsWith(`${dist}/`)) { res.writeHead(404).end(); return; }
    const bytes = await readFile(target);
    res.setHeader("Content-Type", ({ ".html": "text/html", ".js": "application/javascript", ".css": "text/css" })[extname(target)] ?? "application/octet-stream");
    res.end(bytes);
  } catch { res.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
let browser;
const evidence = [];
let checks = 0;
const check = (name, value) => { assert.ok(value, name); checks++; };
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/home/yyj/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome", headless: true });
  for (const [width, theme] of [[390, "light"], [390, "dark"], [767, "light"], [768, "dark"], [1280, "light"], [1280, "dark"]]) {
    const narrow = width <= 767;
    const context = await browser.newContext({ viewport: { width, height: 800 }, colorScheme: theme, hasTouch: narrow });
    await context.addInitScript(({ theme }) => {
      localStorage.setItem("pi-agent-ui.token", "local-ui-fixture-not-a-credential");
      localStorage.setItem("pi-agent-ui.theme", theme);
      const frames = [], touches = [];
      document.addEventListener("pointerdown", (e) => touches.push({ trusted: e.isTrusted, type: e.pointerType }));
      const dto = (file, text) => ({ sessionId: file, file, title: { text, truncated: false }, lastActiveMs: Date.now(), entryCount: 2, sizeBytes: 100, hasRecoveryNotice: false, listReliability: "full" });
      const rows = Array.from({ length: 20 }, (_, i) => dto(`fixture-${i}.jsonl`, `可读会话条目 ${i + 1}`));
      const status = (file, state, version) => ({ session: { sessionId: file, file, adapterSessionId: null }, process: { phase: "running", generation: 1, ready: true, lastStartResult: null, lastStopResult: null }, turn: state === "idle" ? { state } : { state, intentId: "i-fixture" }, backgroundTasks: { availability: "known", activeCount: 0 }, reap: { eligible: false, idleElapsedMs: null, idleRemainingMs: null, idleMs: 0 }, recovery: { availability: "unavailable", resumeBlocked: null, diskBlocked: null, unknownEffectCount: null, unattributableFragments: null, intentsCount: null, settledCount: null, evidenceHash: null }, statusVersion: version, serverTimeMs: Date.now() });
      let mode = "launched", liveSocket, subscription, activeFile, counter = 0;
      const accepted = new Map();
      class Socket {
        readyState = 0; onopen = null; onmessage = null; onclose = null; onerror = null;
        constructor() { setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
        close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
        receive(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
        send(bytes) {
          const f = JSON.parse(bytes); frames.push(f);
          const reply = (frame) => setTimeout(() => this.receive(frame), 0);
          if (f.t === "hello") reply({ t: "welcome", serverBootId: "local-fixture", serverBuildId: "local-fixture", protocolVersion: 1 });
          if (f.t === "list-sessions") reply({ t: "sessions", requestId: f.requestId, sessions: rows, total: rows.length, offset: 0, hasMore: false, listVersion: ++counter, listReliability: "full" });
          if (f.t === "get-models") reply({ t: "models-list", requestId: f.requestId, models: [] });
          if (f.t === "subscribe") {
            liveSocket = this; subscription = `sub-${++counter}`; activeFile = f.file;
            reply({ t: "snapshot", requestId: f.requestId, subscriptionId: subscription, streamId: `stream-${counter}`, snapshotId: `snap-${counter}`, barrier: 1, status: status(f.file, accepted.has(f.file) ? "in-flight" : "idle", 1), page: [], historyNext: null, liveFrom: { streamId: `stream-${counter}`, seq: 1 }, hasMore: false });
            if (accepted.has(f.file)) setTimeout(() => this.receive({ t: "events", subscriptionId: subscription, origin: "live", refSeq: null, liveSeq: 1, events: [{ kind: "message-final", role: "assistant", text: "合成回复已显示；final 不是整轮结束。" }] }), 30);
          }
          if (f.t === "prompt") {
            if (mode === "hold") return;
            if (mode === "unknown") { reply({ t: "error", requestId: f.requestId, code: 4402, retryable: true, message: "never display" }); return; }
            if (mode === "busy") { reply({ t: "write-ack", requestId: f.requestId, file: f.file, outcome: { kind: "busy" } }); return; }
            accepted.set(f.file, f.text);
            if (mode !== "unlisted" && !rows.some((row) => row.file === f.file)) rows.unshift(dto(f.file, f.text));
            reply({ t: "write-ack", requestId: f.requestId, file: f.file, outcome: { kind: "launched", intentId: "i-fixture", commandId: ++counter } });
          }
          if (f.t === "stop") reply({ t: "write-stop-ack", requestId: f.requestId, file: f.file, outcome: { kind: "no-process" } });
        }
      }
      window.WebSocket = Socket;
      window.__visRig = { frames, touches, setMode: (value) => { mode = value; }, idle: () => liveSocket.receive({ t: "status", subscriptionId: subscription, status: status(activeFile, "idle", 2) }) };
    }, { theme });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const press = async (locator) => { if (narrow) await locator.tap(); else await locator.click(); };
    const countPrompts = () => page.evaluate(() => window.__visRig.frames.filter((f) => f.t === "prompt").length);
    const back = async () => { await press(page.getByRole("button", { name: "会话列表", exact: true })); await page.locator('.real-app[data-view="list"]').waitFor(); };
    const sendFirst = async (text, mode) => {
      await page.evaluate((value) => window.__visRig.setMode(value), mode);
      await press(page.getByRole("button", { name: "＋新对话" }));
      await page.getByLabel("首条消息").fill(text);
      await press(page.getByRole("button", { name: "发送并开始对话" }));
    };
    await page.goto(url);
    await page.getByRole("button", { name: /可读会话条目 1/ }).first().waitFor();
    await sendFirst("触摸首发已受理", "launched");
    await page.getByText("合成回复已显示；final 不是整轮结束。", { exact: true }).waitFor();
    check("受理文案中性", await page.getByText("消息已受理。", { exact: true }).isVisible());
    check("final 不伪造 idle", !(await page.locator(".conversation-heading small").textContent()).includes("空闲"));
    check("final 未确认入档保留", await page.getByText(/未确认入档/).isVisible());
    const textareaHeight = (await page.getByLabel("写入消息内容").boundingBox()).height;
    if (narrow) check("手机编辑区 64px", textareaHeight === 64);
    check("三主题按钮保留", await page.getByRole("group", { name: "主题" }).getByRole("button").count() === 3);
    if (narrow) {
      const heights = await page.locator(".theme-toggle button").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
      check("主题触摸高度不缩至 30px", heights.every((height) => height >= 44));
    }
    await page.screenshot({ path: join(out, `${width}-${theme}-reply.png`) });
    await page.evaluate(() => window.__visRig.idle());
    await page.waitForFunction(() => document.querySelector(".conversation-heading small").textContent.includes("空闲"));
    check("真实 status idle 不清受理事实", await page.getByText("消息已受理。", { exact: true }).isVisible());
    if (narrow) await back();
    check("入列后无空 section", await page.locator("section.unfinished-drafts").count() === 0);
    const layout = await page.evaluate(() => {
      const rect = (selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return { y: r.y, height: r.height, bottom: r.bottom }; };
      return { workspace: rect(".workspace"), nav: rect(".session-panel"), list: rect(".session-list-region"), conversationDisplay: getComputedStyle(document.querySelector(".conversation")).display, maxHeight: getComputedStyle(document.querySelector(".session-panel")).maxHeight, overflow: document.documentElement.scrollWidth - innerWidth };
    });
    check("零横向溢出", layout.overflow === 0);
    check("列表没有 40vh 上限", layout.maxHeight === "none");
    check("列表主体超过半屏", layout.list.height > 400);
    check("列表面板占满工作区", Math.abs(layout.nav.height - layout.workspace.height) <= 1);
    if (narrow) check("列表页会话不占布局", layout.conversationDisplay === "none");
    else check("桌面仍保两窗格", layout.conversationDisplay === "flex");
    await page.screenshot({ path: join(out, `${width}-${theme}-list.png`) });
    const last = page.getByRole("button", { name: /可读会话条目 20/ });
    await last.scrollIntoViewIfNeeded();
    check("末条可滚动阅读", await last.isVisible() && (await last.boundingBox()).height >= 44);
    await press(page.getByRole("button", { name: "＋新对话" }));
    await press(page.getByRole("button", { name: "返回列表" }));
    await sendFirst("未入列的受理身份", "unlisted");
    await page.getByLabel("写入消息内容").waitFor();
    if (narrow) await back();
    const accepted = page.getByRole("button", { name: /打开已受理对话/ });
    check("未入列受理身份可见", await accepted.isVisible());
    const promptsBeforeRestore = await countPrompts();
    await press(accepted);
    await page.getByLabel("写入消息内容").waitFor();
    check("打开已受理身份不补发", await countPrompts() === promptsBeforeRestore);
    if (narrow) await back();
    await sendFirst("拒收原稿：保护全文", "busy");
    await page.getByRole("alert").filter({ hasText: "草稿已保留" }).waitFor();
    await press(page.getByRole("button", { name: "返回列表" }));
    const rejected = page.getByRole("button", { name: /找回未发送成功的草稿/ });
    check("拒收条目含原稿", (await rejected.textContent()).includes("拒收原稿：保护全文"));
    await press(rejected);
    check("拒收原稿全文找回", await page.getByLabel("首条消息").inputValue() === "拒收原稿：保护全文");
    await press(page.getByRole("button", { name: "返回列表" }));
    await sendFirst("未知原稿：保护身份", "unknown");
    await page.getByRole("alert").filter({ hasText: "可能已受理" }).waitFor();
    await press(page.getByRole("button", { name: "返回列表" }));
    const unknown = page.getByRole("button", { name: /找回结果未知的草稿/ });
    check("未知条目含原稿", (await unknown.textContent()).includes("未知原稿：保护身份"));
    await press(unknown);
    const promptCount = await countPrompts();
    page.once("dialog", (dialog) => dialog.dismiss());
    await press(page.getByRole("button", { name: "发送并开始对话" }));
    check("未知二发取消确认零帧", await countPrompts() === promptCount);
    page.once("dialog", (dialog) => dialog.accept());
    await press(page.getByRole("button", { name: "发送并开始对话" }));
    await page.waitForFunction((count) => window.__visRig.frames.filter((f) => f.t === "prompt").length === count + 1, promptCount);
    check("未知二发只有确认后多一帧", await countPrompts() === promptCount + 1);
    await press(page.getByRole("button", { name: "返回列表" }));
    await sendFirst("在途原稿：不能隐藏", "hold");
    await press(page.getByRole("button", { name: "返回列表" }));
    check("在途条目可见", await page.getByRole("button", { name: /找回发送中的草稿/ }).isVisible());
    check("在途新建仍禁用", await page.getByRole("button", { name: "＋新对话" }).isDisabled());
    check("四类恢复身份并存", await page.locator("section.unfinished-drafts button").count() === 4);
    const trustedTouches = await page.evaluate(() => window.__visRig.touches.filter((e) => e.trusted && e.type === "touch").length);
    if (narrow) check("确实使用 trusted touch 而非鼠标或 force", trustedTouches >= 15);
    check("零页面异常", errors.length === 0);
    await page.screenshot({ path: join(out, `${width}-${theme}-protected-drafts.png`) });
    evidence.push({ width, theme, textareaHeight, trustedTouches, layout, errors });
    await context.close();
  }
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
const html = await readFile(join(dist, "index.html"), "utf8");
await writeFile(join(out, "manifest.json"), JSON.stringify({ sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(), createdAt: new Date().toISOString(), build: html.match(/assets\/index-[^" ]+\.js/)?.[0], checks, policy: { fakeSocket: true, productionTokenUsed: false, physicalDevice: false, touchMethod: "Playwright locator.tap / trusted pointerType=touch" }, evidence }, null, 2));
console.log(`PASS: ${checks} checks, ${evidence.length} viewport/theme combinations; ${out}`);
