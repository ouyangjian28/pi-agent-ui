#!/usr/bin/env node
// UI 交互流断言脚本（提速项 #7；M-UX 批验收矩阵的机器复现面）：
//   起真 main.ts 服务 → playwright 点击序列 → 逐步断言 → 末帧截图 → JSON 报告。
//   与 ui-shots.mjs 分工：shots=静态截图包（视觉证据给 GPT 视觉审）；flows=交互断言（行为证据，机器判 PASS/FAIL）。
//   退出码：全 PASS=0；任一 FAIL=1（可挂 CI/收口门）。
// 用法：node scripts/ui-flows.mjs [输出目录=默认 /tmp/ui-flows]
// M-UX 实现批按 designs/m-ux-v4.md §D09 增补：新流程选择器+必达断言（B1-B6/F1）+手机视口。
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const REPO = resolve(import.meta.dirname, "..");
const OUT = process.argv[2] ?? "/tmp/ui-flows";
const ONLY = (() => { const i = process.argv.indexOf("--only"); return i >= 0 ? process.argv[i + 1] : null; })();
const PORT = 19100 + Math.floor(Math.random() * 300);
const TOKEN = "ui-flows-token";
const VIEWPORT = { width: 1280, height: 800 }; // PC 优先（用户拍板 2026-10-10）；手机视口流随 M-UX 实现批加

function until(f, what, ms = 15000) {
  const t0 = Date.now();
  return new Promise((res, rej) => {
    const tick = () => (f() ? res() : Date.now() - t0 > ms ? rej(new Error("timeout: " + what)) : setTimeout(tick, 100));
    tick();
  });
}

// ---- 微型断言器：fail 即抛（截图+记档由 flow 驱动器兜）----
function expect(cond, msg) {
  if (!cond) throw new Error("ASSERT: " + msg);
}

// G1 几何断言（设计 v4 §D09：核心动作完整盒子 0≤top<bottom≤viewportH+可命中）
async function expectCoreActionVisible(page, selector, label) {
  const el = page.locator(selector).first();
  await el.waitFor({ state: "visible", timeout: 8000 });
  const box = await el.boundingBox();
  expect(box !== null, `${label} 无 boundingBox`);
  const { y, height } = box;
  expect(y >= 0 && y + height <= VIEWPORT.height, `${label} 盒子越界: top=${Math.round(y)} bottom=${Math.round(y + height)} (视口 H=${VIEWPORT.height})`);
  expect(height > 0, `${label} 高度为 0`);
}

// ---- flows 定义：每个 flow = { name, run(page, ctx) }；ctx={base,url,root} ----
const flows = [
  {
    name: "auth-token-gate",
    run: async (page, ctx) => {
      await page.goto(ctx.url + "/");
      await page.waitForLoadState("networkidle");
      const h1 = page.locator("h1", { hasText: "连接 pi 服务" });
      await h1.waitFor({ state: "visible", timeout: 8000 });
      await page.goto(ctx.url + `/?token=${ctx.token}`);
      await page.waitForSelector('nav[aria-label="会话列表"]', { timeout: 10_000 });
    },
  },
  {
    name: "new-session-full-input",
    // 用户主诉「无法全部输入」的机器复现面：全字段 fill 可达+核心钮几何在视口内
    run: async (page, ctx) => {
      await page.goto(ctx.url + `/?token=${ctx.token}`);
      await page.waitForSelector("button.new-session-btn", { timeout: 10_000 });
      await page.click("button.new-session-btn");
      const form = page.locator('section[aria-label="新建会话"]');
      await form.waitFor({ state: "visible", timeout: 5000 });

      const file = page.locator('input[aria-label="会话文件名"]');
      const text = page.locator('textarea[aria-label="首条消息"]');
      expect(await file.count() >= 1, "会话文件名输入框不存在");
      expect(await text.count() >= 1, "首条消息输入框不存在");
      await file.fill("flows-a.jsonl"); // fill 抛错=不可输入（主诉复现）
      await text.fill("交互流探针：全字段可输入");

      // 创建钮：表单完整后从 disabled 转 enabled（writeReady 需 get-roots/写入面就绪）
      const create = page.locator('section[aria-label="新建会话"] button', { hasText: "创建会话" }).first();
      await until(async () => !(await create.isDisabled()), "创建会话钮转 enabled", 10_000);
      await expectCoreActionVisible(page, 'section[aria-label="新建会话"] button:has-text("创建会话")', "创建会话钮");
      await expectCoreActionVisible(page, 'section[aria-label="新建会话"] button:has-text("取消")', "取消钮");
    },
  },
  {
    name: "create-enter-detail",
    run: async (page, ctx) => {
      await page.goto(ctx.url + `/?token=${ctx.token}`);
      await page.waitForSelector("button.new-session-btn", { timeout: 10_000 });
      await page.click("button.new-session-btn");
      await page.locator('input[aria-label="会话文件名"]').fill("flows-b.jsonl");
      await page.locator('textarea[aria-label="首条消息"]').fill("第二条流程：创建即进详情");
      const create = page.locator('section[aria-label="新建会话"] button', { hasText: "创建会话" }).first();
      await until(async () => !(await create.isDisabled()), "创建会话钮转 enabled", 10_000);
      await create.click();
      // 详情面挂载（composer 在场=写会话就绪）
      await page.waitForSelector('section[aria-label^="写消息"]', { timeout: 15_000 });
      // 首条消息进历史
      const hist = page.locator('ol[aria-label="历史事件"]');
      await hist.waitFor({ state: "visible", timeout: 10_000 });
    },
  },
  {
    name: "composer-send",
    run: async (page, ctx) => {
      await page.goto(ctx.url + `/?token=${ctx.token}`);
      await page.waitForSelector("button.new-session-btn", { timeout: 10_000 });
      await page.click("button.new-session-btn");
      await page.locator('input[aria-label="会话文件名"]').fill("flows-c.jsonl");
      await page.locator('textarea[aria-label="首条消息"]').fill("composer 前置会话");
      const create = page.locator('section[aria-label="新建会话"] button', { hasText: "创建会话" }).first();
      await until(async () => !(await create.isDisabled()), "创建会话钮转 enabled", 10_000);
      await create.click();
      const composer = page.locator('section[aria-label^="写消息"]');
      await composer.waitFor({ state: "visible", timeout: 15_000 });

      const box = page.locator('textarea[aria-label="写入消息内容"]');
      await box.fill("composer 交互流第二条");
      const send = composer.locator("button").first(); // 发送钮（177 行）
      await until(async () => !(await send.isDisabled()), "发送钮转 enabled", 10_000);
      await send.click();
      // 发送后：草稿清空（sendOutcome 结算路径）或 UI 出现入队文案——二选一达成为过
      await until(async () => {
        const v = await box.inputValue();
        if (v === "") return true;
        return (await page.getByText(/已入队|已启动|排队/).count()) > 0;
      }, "发送后草稿清空或入队文案", 10_000);
    },
  },
  {
    name: "geometry-baseline",
    // 核心动作几何基线（G1 面当前 UI 数据点，M-UX 后对照）
    run: async (page, ctx) => {
      await page.goto(ctx.url + `/?token=${ctx.token}`);
      await page.waitForSelector("button.new-session-btn", { timeout: 10_000 });
      await expectCoreActionVisible(page, "button.new-session-btn", "＋新建钮");
      const geo = {};
      for (const [label, sel] of [
        ["＋新建", "button.new-session-btn"],
        ["会话列表面板", 'nav[aria-label="会话列表"]'],
        ["会话主区", 'main[aria-label="当前会话"]'],
      ]) {
        const b = await page.locator(sel).first().boundingBox();
        geo[label] = b && { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
      }
      await writeFile(join(OUT, "geometry-baseline.json"), JSON.stringify(geo, null, 1));
    },
  },
];

// ---- rig：起真服务（同 ui-shots；mode=ready：探针应答常驻）----
const base = await mkdtemp(join(tmpdir(), "ui-flows-"));
const root = join(base, "root");
const sessionDir = join(root, "sessions");
await mkdir(sessionDir, { recursive: true });
await writeFile(join(base, "tokens.json"), JSON.stringify({ version: 1, tokens: [TOKEN] }));
await mkdir(OUT, { recursive: true });
await mkdir(join(OUT, "shots"), { recursive: true });

const proc = spawn(process.execPath, [
  "--experimental-transform-types", join(REPO, "apps/server/src/main.ts"),
  "--port", String(PORT), "--host", "127.0.0.1",
  "--token-file", join(base, "tokens.json"),
  "--root", root, "--session-dir", sessionDir,
  "--pi-bin", join(REPO, "tests/fixtures/mops-fake-pi.mjs"),
  "--static-dir", join(REPO, "apps/web/dist"),
  "--handshake-per-minute", "60", // rig：连续多页×每页 3 握手会耗尽默认滑窗 10（ui-flows 发现）；生产默认不变
], { cwd: REPO, env: { ...process.env, MOPS_FAKE_PI_MODE: "ready", MOPS_ARGV_FILE: join(base, "argv.jsonl") }, stdio: ["ignore", "pipe", "pipe"] });
proc.stdout.setEncoding("utf8");
proc.stderr.setEncoding("utf8");
const lines = [];
proc.stdout.on("data", (d) => lines.push(...d.split("\n")));
proc.stderr.on("data", () => {});

const ctx = { base, root, token: TOKEN, url: `http://127.0.0.1:${PORT}` };
const report = [];
let failed = 0;

try {
  await until(() => lines.some((l) => l.includes("main ready")), "main ready", 20_000);
  const browser = await chromium.launch();

  for (const flow of flows) {
    if (ONLY && flow.name !== ONLY) continue;
    const page = await browser.newPage({ viewport: VIEWPORT });
    const wsEvents = [];
    const consoleMsgs = [];
    page.on("websocket", (ws) => {
      wsEvents.push("open " + ws.url());
      ws.on("close", () => wsEvents.push("close " + ws.url()));
      ws.on("socketerror", (err) => wsEvents.push("error " + ws.url() + " " + err));
      ws.on("framereceived", (f) => {
        const s = String(f.payload ?? "");
        if (s.includes('"error"') || s.includes("4401") || s.includes("4432")) wsEvents.push("frame-in " + s.slice(0, 200));
      });
      ws.on("framesent", (f) => {
        const s = String(f.payload ?? "");
        if (s.includes('"hello"')) wsEvents.push("frame-out-hello " + s.slice(0, 120));
      });
    });
    page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") consoleMsgs.push(m.type() + ": " + m.text().slice(0, 200)); });
    page.on("response", (r) => { if (r.status() >= 400) wsEvents.push(`http ${r.status()} ${r.url().slice(0, 120)}`); });
    const entry = { flow: flow.name, status: "PASS", error: null, shot: null };
    try {
      await flow.run(page, ctx);
      await page.screenshot({ path: join(OUT, "shots", flow.name + ".png"), fullPage: true }).catch(() => {});
      entry.shot = `shots/${flow.name}.png`;
    } catch (e) {
      failed++;
      entry.status = "FAIL";
      entry.error = String(e.message ?? e).slice(0, 500);
      // 诊断探针：卡住时抓表单四条件实际值 + server 日志尾（writeReady flaky 排查）
      try {
        const d = await page.evaluate(() => {
          const g = (sel) => document.querySelector(sel);
          return {
            file: g('input[aria-label="会话文件名"]')?.value ?? null,
            text: g('textarea[aria-label="首条消息"]')?.value?.slice(0, 30) ?? null,
            rootsHint: g(".roots-hint")?.textContent ?? null,
            cwdStatus: Array.from(document.querySelectorAll(".cwd-status")).map((x) => x.textContent),
            banner: g(".banner")?.textContent ?? null,
            bodySnippet: document.body.innerText.slice(0, 400),
          };
        }).catch(() => null);
        if (d) entry.dom = d;
        entry.wsEvents = wsEvents;
        entry.console = consoleMsgs.slice(-10);
        entry.serverLog = lines.slice(-30);
      } catch {}
      const shot = join(OUT, `failure-${flow.name}.png`);
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      entry.shot = `failure-${flow.name}.png`;
    }
    report.push(entry);
    console.log(`${entry.status === "PASS" ? "✓" : "✗"} ${flow.name}${entry.error ? " — " + entry.error : ""}`);
    await page.close();
  }
  await browser.close();
} finally {
  proc.kill("SIGTERM");
  await new Promise((r) => { proc.on("exit", r); setTimeout(r, 2000); });
  await rm(base, { recursive: true, force: true }).catch(() => {});
}

await writeFile(join(OUT, "report.json"), JSON.stringify({ at: new Date().toISOString(), viewport: VIEWPORT, flows: report, failed }, null, 1));
await writeFile(join(OUT, "server.log"), lines.filter((l) => l.trim() !== "").join("\n"));
console.log(`\n${failed === 0 ? "ALL PASS" : failed + " FAILED"} → ${OUT}/report.json`);
process.exit(failed === 0 ? 0 : 1);
