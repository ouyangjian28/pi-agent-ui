// 真生产构建 AppRoot→RealApp；仅浏览器 WebSocket 替身，本机静态端口，无生产服务/令牌。
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join, extname } from "node:path";
import { chromium } from "playwright";
const repo = resolve(import.meta.dirname, "../..");
const dist = join(repo, "apps/web/dist");
const out = process.argv[2] ?? "/tmp/ui-r1-evidence/state";
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
await new Promise((yes) => server.listen(0, "127.0.0.1", yes));
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ executablePath: "/home/yyj/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome", headless: true });
const evidence = [];
const behaviorOnly = process.argv.includes("--behavior-only");
try {
  for (const width of behaviorOnly ? [1280] : [390, 1280]) for (const theme of behaviorOnly ? ["light"] : ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width, height: 800 }, colorScheme: theme });
    await context.addInitScript(({ theme }) => {
      localStorage.setItem("pi-agent-ui.token", "local-ui-fixture-not-a-credential");
      localStorage.setItem("pi-agent-ui.theme", theme);
      const frames = []; const sockets = [];
      const dto = (file, title) => ({ sessionId: file, file, title: { text: title, truncated: false }, lastActiveMs: Date.now(), entryCount: 4, sizeBytes: 1024, hasRecoveryNotice: false, listReliability: "full" });
      const rows = [dto("design.jsonl", "设计一个安静的聊天工作台"), dto("notes.jsonl", "梳理本周的工作计划")];
      const status = (file) => ({ session: { sessionId: file, file, adapterSessionId: null }, process: { phase: "running", generation: 1, lastStartResult: null, lastStopResult: null, ready: true }, turn: { state: "idle" }, backgroundTasks: { availability: "known", activeCount: 0 }, reap: { eligible: false, idleElapsedMs: null, idleRemainingMs: null, idleMs: 0 }, recovery: { availability: "unavailable", resumeBlocked: null, diskBlocked: null, unknownEffectCount: null, unattributableFragments: null, intentsCount: null, settledCount: null, evidenceHash: null }, statusVersion: 1, serverTimeMs: Date.now() });
      let mode = "launched", seq = 0, subscription = "", liveSocket = null;
      const event = (role, text, n) => ({ seq: n, ts: Date.now(), generation: 1, intentId: null, kind: "message", entryId: `e-${n}`, role, final: true, textPreview: { text, truncated: false } });
      class Socket {
        readyState = 0; onopen = null; onclose = null; onmessage = null; onerror = null;
        constructor() { sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
        receive(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
        close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
        send(bytes) {
          const f = JSON.parse(bytes); frames.push(f);
          const receive = (value) => setTimeout(() => this.receive(value), 0);
          if (f.t === "hello") receive({ t: "welcome", serverBootId: "local-fixture", serverBuildId: "local-fixture", protocolVersion: 1 });
          if (f.t === "list-sessions") receive({ t: "sessions", requestId: f.requestId, sessions: rows.slice(f.offset ?? 0), total: rows.length, offset: f.offset ?? 0, hasMore: false, listVersion: 1, listReliability: "full" });
          if (f.t === "get-models") receive({ t: "models-list", requestId: f.requestId, models: [{ provider: "local", id: "test-model", context: "200k" }] });
          if (f.t === "get-roots") receive({ t: "roots-list", requestId: f.requestId, roots: ["/local-fixture"] });
          if (f.t === "subscribe") {
            liveSocket = this; subscription = `sub-${++seq}`;
            receive({ t: "snapshot", requestId: f.requestId, subscriptionId: subscription, streamId: `stream-${seq}`, snapshotId: `snap-${seq}`, barrier: 2, status: status(f.file), page: [event("user", "我想让聊天界面更清晰：保留必要信息，减少不必要的噪音。", 1), event("assistant", "可以。我们先让对话成为主角：左侧继续历史，右侧专注内容。连接状态和执行细节保留可查，但不占据阅读空间。", 2)], historyNext: null, liveFrom: { streamId: `stream-${seq}`, seq: 3 }, hasMore: false });
          }
          if (f.t === "prompt") {
            if (!rows.some((r) => r.file === f.file)) rows.unshift(dto(f.file, f.text.slice(0, 20)));
            if (mode === "hold") return;
            if (mode === "server") receive({ t: "error", requestId: f.requestId, code: 4402, retryable: true, message: "not-displayed" });
            else receive({ t: "write-ack", requestId: f.requestId, file: f.file, outcome: mode === "launched" ? { kind: "launched", intentId: "i-local", commandId: seq } : { kind: mode, cause: "spawn-exited", detail: "本地测试模型未启动。" } });
          }
        }
      }
      window.WebSocket = Socket;
      window.__uiRig = { frames, sockets, setMode: (value) => { mode = value; }, receive: (value) => liveSocket?.receive(value), subscription: () => subscription };
    }, { theme });
    const page = await context.newPage(); const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url); await page.locator('nav[aria-label="会话列表"]').waitFor();
    if (width === 390) await page.getByRole("button", { name: "＋新对话" }).click();
    for (const scene of behaviorOnly ? ["conversation"] : ["welcome", "conversation", "live", "question", "refused", "unknown", "health", "disconnected"]) {
      if (scene === "conversation") {
        if (width === 390) await page.getByRole("button", { name: "会话列表", exact: true }).click();
        await page.getByRole("button", { name: /设计一个安静的聊天工作台/ }).click();
      }
      if (scene === "conversation") await page.locator("section.session-detail").getByText(/可以。我们先让对话成为主角/).waitFor();
      if (scene === "live") {
        await page.evaluate(() => window.__uiRig.receive({ t: "events", subscriptionId: window.__uiRig.subscription(), origin: "live", refSeq: null, liveSeq: 3, events: [{ kind: "message-final", role: "assistant", text: "这条回复已生成，但当前协议不能证明它已经入档。" }, { kind: "message-final", role: "assistant", text: "这是另一个独立回复，不覆盖前一条。" }, { kind: "message-delta", part: "text", contentIndex: 0, delta: "下一条仍在生成中…" }] }));
        await page.getByText(/pi · 已生成/).first().waitFor();
      }
      if (scene === "question") {
        await page.evaluate(() => window.__uiRig.receive({ t: "ui-request", requestId: "q-local", file: "design.jsonl", method: "confirm", title: "是否继续调整布局？", message: "这是本地测试问题，不执行真实操作。" }));
        await page.getByText("是否继续调整布局？").waitFor();
      }
      if (scene === "refused" || scene === "unknown") {
        if (scene === "refused") await page.evaluate(() => window.__uiRig.receive({ t: "ui-closed", requestId: "q-local", reason: "answered" }));
        await page.evaluate((value) => window.__uiRig.setMode(value), scene === "refused" ? "busy" : "server");
        await page.getByLabel("写入消息内容").fill("发送失败时，这份草稿必须完整保留。");
        await page.getByRole("button", { name: "发送", exact: true }).click();
        await page.getByRole("alert").filter({ hasText: scene === "refused" ? "草稿已保留" : "可能已受理" }).waitFor();
      }
      if (scene === "health") await page.getByRole("button", { name: /连接状态：/ }).click();
      if (scene === "disconnected") {
        await page.keyboard.press("Escape");
        await page.evaluate(() => window.__uiRig.sockets[2].close(1006));
        await page.getByText(/自动重连中/).waitFor();
      }
      await page.evaluate(() => Promise.all(document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {}))));
      const path = join(out, `${width}-${theme}-${scene}.png`);
      await page.screenshot({ path, fullPage: true });
      const measurements = await page.evaluate(() => ({ overflowPx: document.documentElement.scrollWidth - innerWidth, textareas: [...document.querySelectorAll("textarea")].map((el) => ({ label: el.getAttribute("aria-label"), top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom })), frames: window.__uiRig.frames.map(({ t, file }) => ({ t, file })) }));
      evidence.push({ width, theme, scene, path, entry: "AppRoot→RealApp（无 demo）", url, errors, ...measurements });
    }
    if (width === 1280 && theme === "light") {
      await page.reload(); await page.locator('nav[aria-label="会话列表"]').waitFor();
      await page.getByRole("button", { name: /设计一个安静的聊天工作台/ }).click();
      await page.getByText(/可以。我们先让对话成为主角/).waitFor();
      await page.getByLabel("写入消息内容").fill("浏览器保活草稿");
      await page.evaluate(() => { window.__composerNode = document.querySelector(".write-composer textarea"); window.__uiRig.receive({ t: "events", subscriptionId: window.__uiRig.subscription(), origin: "history", refSeq: 121, events: Array.from({ length: 119 }, (_, index) => ({ seq: index + 3, ts: null, generation: null, intentId: null, kind: "message", entryId: `scroll-${index + 3}`, role: "assistant", final: true, textPreview: { text: `历史滚动 ${index + 3} ` + "用于核验贴底跟随和向上阅读保护。".repeat(12), truncated: false } })) }); });
      await page.waitForFunction(() => { const el = document.querySelector(".conversation-body"); return el.scrollHeight - el.scrollTop - el.clientHeight <= 4; });
      await page.evaluate(() => { const el = document.querySelector(".conversation-body"); el.scrollTop = 0; el.dispatchEvent(new Event("scroll", { bubbles: true })); window.__uiRig.receive({ t: "events", subscriptionId: window.__uiRig.subscription(), origin: "live", liveSeq: 1, refSeq: null, events: [{ kind: "message-delta", part: "text", contentIndex: 0, delta: "新增直播行，向上阅读时不能抢滚动。" }] }); });
      await page.getByText("新增直播行，向上阅读时不能抢滚动。").waitFor({ state: "attached" });
      const readerTop = await page.locator(".conversation-body").evaluate((el) => el.scrollTop);
      if (readerTop > 1) throw new Error(`向上阅读被直播抢回底部：${readerTop}`);
      const before = await page.evaluate(() => window.__uiRig.frames.filter((frame) => frame.t === "subscribe" || frame.t === "unsubscribe" || frame.t === "ui-answer" || frame.t === "stop").length);
      for (const viewportWidth of [767, 768, 390]) await page.setViewportSize({ width: viewportWidth, height: 800 });
      await page.getByRole("button", { name: "会话列表", exact: true }).click();
      await page.getByRole("button", { name: /设计一个安静的聊天工作台/ }).click();
      const preserved = await page.evaluate(() => window.__composerNode === document.querySelector(".write-composer textarea"));
      if (!preserved || await page.getByLabel("写入消息内容").inputValue() !== "浏览器保活草稿") throw new Error("断点/手机返回重挂或丢稿");
      const after = await page.evaluate(() => window.__uiRig.frames.filter((frame) => frame.t === "subscribe" || frame.t === "unsubscribe" || frame.t === "ui-answer" || frame.t === "stop").length);
      if (after !== before) throw new Error("可见性导航产生业务退订/作答/停止帧");
      await page.setViewportSize({ width: 390, height: 420 });
      await page.getByLabel("写入消息内容").click();
      const hit = await page.getByRole("button", { name: "发送", exact: true }).evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); });
      if (!hit) throw new Error("短动态视口下唯一发送入口被裁切或遮挡");
      await page.getByLabel("写入消息内容").evaluate((el) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true })));
      if (await page.evaluate(() => window.__uiRig.frames.some((frame) => frame.t === "prompt"))) throw new Error("真实浏览器 IME 选词触发发送");
      await page.screenshot({ path: join(out, "390-light-short-viewport.png"), fullPage: true });
      evidence.push({ scene: "browser-behaviors", readerTop, viewport: "390×420（缩短视口模拟，不冒充真手机软键盘）", composerPreserved: preserved, businessFrameDelta: after - before, sendHit: hit, imePromptCount: 0, errors });
    }
    await context.close();
  }
} finally { await browser.close(); await new Promise((yes) => server.close(yes)); }
const html = await readFile(join(dist, "index.html"), "utf8");
await writeFile(join(out, "manifest.json"), JSON.stringify({ build: html.match(/assets\/index-[^" ]+\.js/)?.[0], evidence }, null, 2));
console.log(`RealApp screenshots: ${evidence.length}; page errors: ${evidence.reduce((n, e) => n + e.errors.length, 0)}; ${out}`);
if (evidence.some((e) => e.errors.length)) process.exitCode = 1;
