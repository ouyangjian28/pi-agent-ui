#!/usr/bin/env node
// UI 审核截图包生成器（M-UX 批基建）：起真 main.ts 服务→playwright 走关键视图→PC 视口截图包。
// 用法：node scripts/ui-shots.mjs [输出目录=默认 /tmp/ui-review]
// 产物：login.png / list-empty.png / new-session.png / new-session-model.png / session-detail.png
// GPT UI 审=代码+视觉双面（pi read 图片附件）——本脚本只产证据，不判定。
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const REPO = resolve(import.meta.dirname, "..");
const OUT = process.argv[2] ?? "/tmp/ui-review";
const PORT = 18800 + Math.floor(Math.random() * 300);
const TOKEN = "ui-shots-token";
const VIEWPORT = { width: 1280, height: 800 }; // PC 视口（用户拍板 2026-10-10：手机 UI 冻结，PC 优先）

function until(f, what, ms = 15000) {
  const t0 = Date.now();
  return new Promise((res, rej) => {
    const tick = () => (f() ? res() : Date.now() - t0 > ms ? rej(new Error("timeout: " + what)) : setTimeout(tick, 100));
    tick();
  });
}

const base = await mkdtemp(join(tmpdir(), "ui-shots-"));
const root = join(base, "root");
const sessionDir = join(root, "sessions");
await mkdir(sessionDir, { recursive: true });
await writeFile(join(base, "tokens.json"), JSON.stringify({ version: 1, tokens: [TOKEN] }));
await mkdir(OUT, { recursive: true });

const proc = spawn(process.execPath, [
  "--experimental-transform-types", join(REPO, "apps/server/src/main.ts"),
  "--port", String(PORT), "--host", "127.0.0.1",
  "--token-file", join(base, "tokens.json"),
  "--root", root, "--session-dir", sessionDir,
  "--pi-bin", join(REPO, "tests/fixtures/mops-fake-pi.mjs"),
  "--static-dir", join(REPO, "apps/web/dist"),
], { cwd: REPO, env: { ...process.env, MOPS_FAKE_PI_MODE: "cwd", FAKE_PI_CWD_FILE: join(base, "cwd.jsonl") }, stdio: ["ignore", "pipe", "pipe"] });
proc.stdout.setEncoding("utf8");
const lines = [];
proc.stdout.on("data", (d) => lines.push(...d.split("\n")));
proc.stderr.setEncoding("utf8");
proc.stderr.on("data", () => {});

try {
  await until(() => lines.some((l) => l.includes("main ready")), "main ready", 20000);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: VIEWPORT });

  // 1. 登录页（未带 token）
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: join(OUT, "login.png"), fullPage: true });

  // 2. 列表空态（token query 直通）
  await page.goto(`http://127.0.0.1:${PORT}/?token=${TOKEN}`);
  await page.waitForLoadState("networkidle");
  await page.waitForSelector(".connbar, .session-list, [aria-label]", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(OUT, "list-empty.png"), fullPage: true });

  // 3. 新建会话视图（用户破损反馈主诉面）
  const newBtn = page.locator("button.new-session-btn, button", { hasText: "新建" });
  if (await newBtn.count() > 0) {
    await newBtn.first().click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(OUT, "new-session.png"), fullPage: true });
    // 3b. 目录选择器展开态（批A 新增）
    const dirSel = page.locator('select[aria-label="项目目录"]');
    if (await dirSel.count() > 0) {
      await dirSel.selectOption({ index: 0 }).catch(() => {});
      await page.screenshot({ path: join(OUT, "new-session-dir.png"), fullPage: true });
    }
  }

  // 4. 表单填充态（全字段填完——验「能否全部输入」主诉）
  const fileInput = page.locator('input[aria-label="会话文件名"]');
  if (await fileInput.count() > 0) {
    await fileInput.fill("shot.jsonl");
    await page.screenshot({ path: join(OUT, "new-session-filled.png"), fullPage: true });
    await page.locator('textarea, input[type="text"]').last().fill("截图探针消息").catch(() => {});
    const createBtn = page.locator("button", { hasText: "创建会话" });
    if (await createBtn.count() > 0) {
      await createBtn.click();
      await page.waitForTimeout(1500);
      await page.screenshot({ path: join(OUT, "session-detail.png"), fullPage: true });
    }
  }

  await browser.close();
  const shots = ["login.png", "list-empty.png", "new-session.png", "new-session-dir.png", "new-session-filled.png", "session-detail.png"].filter((f) => existsSync(join(OUT, f)));
  console.log(`OK 截图 ${shots.length} 张 → ${OUT}/: ${shots.join(", ")}`);
} finally {
  proc.kill("SIGTERM");
  await new Promise((r) => { proc.on("exit", r); setTimeout(r, 2000); });
  await rm(base, { recursive: true, force: true }).catch(() => {});
}
