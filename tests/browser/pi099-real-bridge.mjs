// Actual AppRoot/RealApp -> real application assembly -> real local pi.
// No WebSocket replacement, no UI business-state injection, no production auth.
import { build } from "esbuild";
import { chromium } from "playwright";
import { randomBytes, createHash } from "node:crypto";
import { createServer as createTcpServer } from "node:net";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { resolve, join, basename, relative } from "node:path";
import { pathToFileURL } from "node:url";

const repo = resolve(import.meta.dirname, "../..");
const root = process.env.PI099_FIXTURE_ROOT;
if (
  !root ||
  !basename(root).startsWith("pi099-real-app-") ||
  process.env.HOME !== root ||
  process.env.PI_CODING_AGENT_DIR !== join(root, "agent")
)
  throw new Error("Refuse non-isolated bridge environment; run the Python fixture launcher");
const out = process.env.PI099_OUTPUT_DIR ?? join(repo, ".pi/upgrade-checks/app-bridge");
if (!out.startsWith(join(repo, ".pi/upgrade-checks/app-bridge"))) throw new Error("Invalid bridge output path");
await mkdir(out, { recursive: true });
const piBin = join(repo, "node_modules/.bin/pi");
const actualVersion = execFileSync(piBin, ["--version"], { encoding: "utf8" }).trim();
if (actualVersion !== "0.99.2") throw new Error(`Actual candidate runtime drift: ${actualVersion}`);
const bundle = join(out, "application.mjs");
await build({
  absWorkingDir: repo,
  entryPoints: [join(repo, "apps/server/src/composition.ts")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["ws"],
  logLevel: "silent",
});
const { startServer } = await import(pathToFileURL(bundle).href);
const reservation = createTcpServer();
await new Promise((done, fail) => {
  reservation.once("error", fail);
  reservation.listen(0, "127.0.0.1", done);
});
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const origin = `http://127.0.0.1:${port}`;
const token = randomBytes(32).toString("hex");
const tokenFile = join(root, "fixture-token.json");
await writeFile(tokenFile, JSON.stringify({ version: 1, tokens: [token] }), { mode: 0o600, flag: "wx" });
const transcripts = join(root, "transcripts");
const journals = join(root, "journal");
const audits = [];
const frames = [];
const pageErrors = [];
const browserBlocked = [];
let browser;
let server;
let failure;
let result;
const assert = (value, message) => {
  if (!value) throw new Error(message);
};
async function until(predicate, label, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 40));
  }
  throw new Error(`Bridge deadline: ${label}`);
}
function liveEvents() {
  return frames.flatMap((f) => (f.t === "events" && f.origin === "live" ? f.events : []));
}
async function journal(file) {
  try {
    return (await readFile(join(journals, file), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}
async function settled(file, intent) {
  await until(
    async () => (await journal(file)).some((row) => row.t === "settled" && row.intentId === intent),
    `journal settled ${intent}`,
  );
  const rows = await journal(file);
  const indices = ["enqueue", "sending", "settled"].map((t) =>
    rows.findIndex((row) => row.t === t && row.intentId === intent),
  );
  assert(indices[0] >= 0 && indices[0] < indices[1] && indices[1] < indices[2], "Per-intent durable ordering failed");
}
try {
  server = await startServer({
    tokenFile,
    allowedOrigins: [origin],
    roots: [transcripts, journals, join(root, "workspace")],
    scanDir: transcripts,
    tokenPollMs: 0,
    port,
    host: "127.0.0.1",
    staticDir: join(repo, "apps/web/dist"),
    journalLayout: { transcriptsRoot: transcripts, journalRoot: journals },
    sessionFor: (file) => resolve(transcripts, file),
    write: {
      sessionFor: (file) => resolve(transcripts, relative(journals, file)),
      piBin,
      extraPiArgs: [
        "--offline",
        "--no-approve",
        "--no-extensions",
        "--no-context-files",
        "--no-skills",
        "--no-themes",
        "--no-prompt-templates",
        "--tools",
        "read",
      ],
      readinessTimeoutMs: 20000,
      responseTimeoutMs: 15000,
      turnTimeoutMs: 45000,
    },
    audit: (line) => audits.push(line),
  });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "127.0.0.1") {
      browserBlocked.push(url.origin);
      await route.abort();
    } else await route.continue();
  });
  await context.addInitScript((value) => localStorage.setItem("pi-agent-ui.token", value), token);
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("websocket", (socket) => {
    assert(new URL(socket.url()).hostname === "127.0.0.1", "Non-loopback browser socket");
    socket.on("framereceived", ({ payload }) => {
      frames.push(JSON.parse(String(payload)));
    });
  });
  await page.goto(origin);
  await page.locator(".hybrid-ui").waitFor();
  await page.locator(".new-session-btn").click();
  await page
    .locator('select[aria-label="模型选择"] option[value="ui-upgrade-test/fixture"]')
    .waitFor({ state: "attached" });
  assert(
    frames.some(
      (f) =>
        f.t === "models-list" &&
        !f.cause &&
        f.models.some((m) => m.provider === "ui-upgrade-test" && m.id === "fixture"),
    ),
    "Actual model listing did not reach browser",
  );
  await page.getByLabel("模型选择").selectOption("ui-upgrade-test/fixture");
  await page.getByLabel("首条消息").fill("第一次受控消息");
  await page.getByRole("button", { name: "发送并开始对话", exact: true }).click();
  await until(() => frames.some((f) => f.t === "write-ack"), "first write ack");
  const first = frames.find((f) => f.t === "write-ack");
  assert(first.outcome.kind === "launched", `First write rejected: ${JSON.stringify(first.outcome)}`);
  await until(
    () => liveEvents().some((e) => e.kind === "message-final" && e.text === "受控应用正文 ✓ 第1轮"),
    "actual pi final one",
  );
  await until(
    () => page.locator(".chat-assistant").filter({ hasText: "受控应用正文 ✓ 第1轮" }).count(),
    "first reply rendered",
  );
  await settled(first.file, first.outcome.intentId);
  assert(
    liveEvents().some((e) => e.kind === "message-delta" && e.part === "text" && e.delta),
    "Actual incremental text absent",
  );
  await page.screenshot({ path: join(out, "desktop-first-response.png"), fullPage: false });

  const textarea = page.getByLabel("写入消息内容");
  await textarea.fill("继续受控对话");
  await textarea.evaluate((node) => {
    node.dataset.pi099Owner = "same-owned-composer";
  });
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  const search = page.getByLabel("搜索已加载会话");
  await search.fill("owned-history.jsonl");
  await page.locator(".session-list button").click();
  await until(() => page.locator(".session-list button[aria-current]").count(), "old conversation selected");
  await search.fill(first.file);
  await page.locator(".session-list button").click();
  await until(
    () => textarea.inputValue().then((text) => text === "继续受控对话"),
    "draft restored after real subscription switch",
  );
  assert((await textarea.getAttribute("data-pi099-owner")) === "same-owned-composer", "Composer DOM was replaced");
  await search.fill("");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await until(() => frames.filter((f) => f.t === "write-ack").length === 2, "second write ack");
  const second = frames.filter((f) => f.t === "write-ack")[1];
  assert(
    second.file === first.file && second.outcome.kind === "launched",
    "Continuation did not target the same real session",
  );
  await until(
    () => liveEvents().some((e) => e.kind === "message-final" && e.text === "受控应用正文 ✓ 第2轮"),
    "actual pi final two",
  );
  await until(
    () => page.locator(".chat-assistant").filter({ hasText: "受控应用正文 ✓ 第2轮" }).count(),
    "second reply rendered",
  );
  await settled(second.file, second.outcome.intentId);
  await page.screenshot({ path: join(out, "desktop-second-response.png"), fullPage: false });
  await page.setViewportSize({ width: 390, height: 800 });
  await page.screenshot({ path: join(out, "mobile-real-response.png"), fullPage: false });
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await until(() => frames.some((f) => f.t === "write-stop-ack"), "real process stop");
  const stop = frames.find((f) => f.t === "write-stop-ack");
  assert(
    stop.file === first.file && stop.outcome.kind === "confirmed",
    `Actual process stop not confirmed: ${JSON.stringify(stop.outcome)}`,
  );
  assert(pageErrors.length === 0 && browserBlocked.length === 0, "Browser errors or external requests");
  const transcriptRows = (await readFile(join(transcripts, first.file), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert(transcriptRows[0].cwd === join(root, "workspace"), "Real pi working directory escaped owned workspace");
  assert(
    transcriptRows.some((row) => row.type === "message" && row.message?.role === "assistant"),
    "Actual pi transcript has no assistant message",
  );
  result = {
    runtime: actualVersion,
    sourceCommit: execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    applicationBundleSha256: createHash("sha256")
      .update(await readFile(bundle))
      .digest("hex"),
    checks: [
      "real browser model listing",
      "new model-selected first conversation",
      "actual pi delta/final rendered",
      "durable enqueue/sending/settled per intent",
      "real subscription switch and draft/DOM restoration",
      "same-session second turn",
      "actual process stop confirmation",
      "owned workspace and real persisted assistant transcript",
    ],
    policy: {
      realApp: true,
      fakeSocket: false,
      realPi: true,
      loopbackMockProvider: true,
      productionTokenUsed: false,
      realPhoneKeyboardTested: false,
    },
    limits: [
      "not paid provider/auth/billing",
      "not real phone keyboard",
      "not main CLI defaults or production deployment",
      "safety startup flags are explicit fixture configuration",
      "handled/queued slash commands, cancellation during streaming and recovery not tested here",
    ],
  };
} catch (error) {
  failure = error;
  result = { status: "failed", error: String(error), runtime: actualVersion };
} finally {
  await writeFile(join(out, "server-frames.json"), JSON.stringify(frames, null, 2) + "\n");
  await writeFile(join(out, "audits.log"), audits.join("\n") + "\n");
  await writeFile(join(out, "result.json"), JSON.stringify(result, null, 2) + "\n");
  const journalData = {};
  for (const file of await readdir(journals)) if (file.endsWith(".jsonl")) journalData[file] = await journal(file);
  await writeFile(join(out, "journals.json"), JSON.stringify(journalData, null, 2) + "\n");
  await browser?.close();
  await server?.dispose();
}
if (failure) throw failure;
console.log(JSON.stringify(result));
