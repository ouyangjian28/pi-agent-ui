// ⑤C：真组合根 E2E——生产形态单端口（staticDir 静态面+同源 WS+token+write 接线+真 pi 0.86.1）。
// 守卫：默认 skip（真调一轮 LLM，成本面=一次小 prompt+一次 stop）；显式跑=PI_E2E=1 npx vitest run tests/integration/composed-e2e.test.ts。
// 与 ws-write-e2e 的分工：那里证写/停/退役/在飞销毁全深度（E1-E4）；这里证**组合根生产形态共存面**：
// 静态 GET 与 WS 同端口同源、token 门贯穿静态/订阅/写三面、订阅投影与写 journal 同组合联动、资源收口。
// 不重复：深写链路硬序细节（E1 已证）——这里 journal 三行只做一致性收口断言。
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startServer, type PiAgentUiServer } from "../../apps/server/src/composition.ts";
import { assertExitShape, exitLineFor, stopHandleOf } from "../../tests/helpers/e2e-evidence.js";

const PI_BIN = "/home/yyj/.nvm/versions/node/v24.18.0/bin/pi";
const PI_VERSION = "0.86.1"; // 与 pi-e2e/ws-write-e2e 同锁（升级须显式改并复跑三处）
const RUN = process.env.PI_E2E === "1";
const PORT = Number(process.env.COMPOSED_E2E_PORT ?? 4319); // staticDir 模式要求固定 port（同源 origin 须预知）
const ORIGIN = `http://127.0.0.1:${PORT}`;
const TOKEN = "tok-5c-composed";
const MARKER = "<!--composed-e2e-marker-->";

interface Frame { t?: string; requestId?: string; subscriptionId?: string; outcome?: { kind: string; intentId?: string; exit?: number }; [k: string]: unknown }
interface JLine { t?: string; intentId?: string; generation?: number; [k: string]: unknown }

const d = describe.skipIf(!RUN)("⑤C 真组合根 E2E（生产形态单端口）", () => {
  let dir = "";
  let staticDir = "";
  let server: PiAgentUiServer | null = null;
  const audits: string[] = [];
  let ws: WebSocket | null = null;
  const frames: Frame[] = [];

  async function connectAndHello(): Promise<void> {
    ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { origin: ORIGIN });
    await new Promise<void>((res, rej) => { ws!.on("open", res); ws!.on("error", (e) => rej(e as Error)); });
    ws.on("message", (data) => frames.push(JSON.parse(String(data))));
    ws.send(JSON.stringify({ t: "hello", protocolVersion: 1, token: TOKEN }));
    await until(() => frames.some((f) => f.t === "welcome"), "welcome");
  }

  beforeAll(async () => {
    const v = spawnSync(PI_BIN, ["--version"], { encoding: "utf8" });
    if (v.status !== 0 || v.stdout.trim() !== PI_VERSION) {
      throw new Error(`pi 版本漂移：期望 ${PI_VERSION}，status=${v.status}，stdout=${JSON.stringify(v.stdout)}`);
    }
    dir = await mkdtemp(join(tmpdir(), "e2e-5c-"));
    await mkdir(join(dir, "recovery-evidence"), { recursive: true });
    await mkdir(join(dir, "sessions"), { recursive: true });
    staticDir = join(dir, "public");
    await mkdir(staticDir, { recursive: true });
    await writeFile(join(staticDir, "index.html"), `<!doctype html><html><body>${MARKER}<script src="/app.js"></script></body></html>`);
    await writeFile(join(staticDir, "app.js"), "console.log('composed-e2e');\n");
    const tokenFile = join(dir, "tokens.json");
    await writeFile(tokenFile, JSON.stringify({ version: 1, tokens: [TOKEN] }), { mode: 0o600 });
    await chmod(tokenFile, 0o600);
    await writeFile(join(dir, "s1.jsonl"), ""); // 订阅面预置空文件（写轮 journal 追加于此）
    server = await startServer({
      port: PORT, // staticDir 模式强制固定 port
      staticDir,
      tokenFile: join(dir, "tokens.json"),
      allowedOrigins: [ORIGIN],
      roots: [dir],
      scanDir: dir,
      tokenPollMs: 0,
      write: {
        sessionFor: (f) => join(dir, "sessions", `${f.split("/").pop()}.session`),
        piBin: PI_BIN,
        responseTimeoutMs: 60_000,
        turnTimeoutMs: 120_000,
        readinessTimeoutMs: 20_000,
      },
      audit: (l) => audits.push(l),
    });
  });

  afterAll(async () => {
    try { ws?.close(); } catch { /* 已关 */ }
    await server?.dispose().catch(() => {});
    if (dir !== "") await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  function send(f: Frame): void { ws!.send(JSON.stringify(f)); }
  async function next(t: string, pred?: (f: Frame) => boolean): Promise<Frame> {
    await until(() => frames.some((f) => f.t === t && (pred === undefined || pred(f))), t);
    return frames.find((f) => f.t === t && (pred === undefined || pred(f)))!;
  }
  async function readJournal(file: string): Promise<JLine[]> {
    try {
      const raw = (await readFile(join(dir, file), "utf8")).split("\n").filter((l) => l.length > 0);
      return raw.map((l) => { try { return JSON.parse(l) as JLine; } catch { return { t: "<corrupt>" }; } });
    } catch { return []; }
  }

  it("C-1 同端口静态+WS+token 贯穿（无 LLM）：GET 200/404+审计行+坏 token 4401+好 token welcome", async () => {
    // 静态面（同端口同源）
    const idx = await fetch(`${ORIGIN}/index.html`);
    expect(idx.status).toBe(200);
    expect(await idx.text()).toContain(MARKER);
    const js = await fetch(`${ORIGIN}/app.js`);
    expect(js.status).toBe(200);
    const miss = await fetch(`${ORIGIN}/nope.html`);
    expect(miss.status).toBe(404);
    // 审计行：静态命中/未中都有结构化痕迹（⑤B 面在组合根真实接线）
    expect(audits.some((l) => l.startsWith("static-hit path=/index.html"))).toBe(true);
    expect(audits.some((l) => l.startsWith("static-miss path=/nope.html"))).toBe(true);
    // token 门贯穿：坏 token → 4401 错误帧先行+close 1008（契约 §5.6；不吞错误进欢迎）
    const bad = new WebSocket(`ws://127.0.0.1:${PORT}`, { origin: ORIGIN });
    const badFrames: Frame[] = [];
    bad.on("message", (m) => badFrames.push(JSON.parse(String(m))));
    const badClose = await new Promise<{ code: number | undefined }>((res) => {
      bad.on("open", () => bad.send(JSON.stringify({ t: "hello", protocolVersion: 1, token: "wrong" })));
      bad.on("close", (code) => res({ code }));
      bad.on("error", () => { /* close 会跟随 */ });
    });
    expect(badFrames.some((f) => f.t === "error" && f.code === 4401)).toBe(true);
    expect(badClose.code).toBe(1008);
    // 好 token → welcome
    await connectAndHello();
    expect(frames.some((f) => f.t === "welcome")).toBe(true);
  });

  it("C-2 订阅+写全链（真 pi 一轮）：snapshot→prompt→write-ack→journal 三行硬序→订阅面 events 投影", { timeout: 180_000 }, async () => {
    // 订阅面：预置空文件快照
    send({ t: "subscribe", requestId: "c2-sub", file: "s1.jsonl" });
    const snap = await next("snapshot", (f) => f.requestId === "c2-sub");
    expect(typeof snap.subscriptionId).toBe("string");
    const subId = snap.subscriptionId!;
    // 写面：小 prompt（成本面=一轮 LLM）
    send({ t: "prompt", requestId: "c2", file: "s1.jsonl", text: "只回复两个字：收到" });
    const ack = await next("write-ack", (f) => f.requestId === "c2");
    expect(ack.outcome!.kind).toBe("launched");
    const intentId = ack.outcome!.intentId!;
    // journal 三行一致收口（硬序细节归 ws-write-e2e E1；这里只锁同组合下成立）
    await until(async () => {
      const ls = await readJournal("s1.jsonl");
      return ls.some((l) => l.t === "enqueue" && l.intentId === intentId)
        && ls.some((l) => l.t === "sending" && l.intentId === intentId)
        && ls.some((l) => l.t === "settled" && l.intentId === intentId);
    }, "C-2 三行齐");
    const ls = await readJournal("s1.jsonl");
    const tr = {
      enqueue: ls.findIndex((l) => l.t === "enqueue" && l.intentId === intentId),
      sending: ls.findIndex((l) => l.t === "sending" && l.intentId === intentId),
      settled: ls.findIndex((l) => l.t === "settled" && l.intentId === intentId),
    };
    expect(tr.enqueue).toBeLessThan(tr.sending);
    expect(tr.sending).toBeLessThan(tr.settled);
    expect(Number(ls[tr.enqueue].generation)).toBeGreaterThanOrEqual(1);
    // 订阅面投影：同文件被写宿主追加 → 该订阅收到 events 帧且 seq 单调（组合根内 watch→投影→推送真链路）
    await until(() => frames.some((f) => f.t === "events" && f.subscriptionId === subId
      && Array.isArray(f.events) && (f.events as Array<{ seq?: number }>).some((e) => typeof e.seq === "number")), "订阅面 events");
    const evFrames = frames.filter((f) => f.t === "events" && f.subscriptionId === subId);
    for (const ef of evFrames) {
      const seqs = (ef.events as Array<{ seq?: number }>).map((e) => Number(e.seq));
      for (let i = 1; i < seqs.length; i += 1) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
    expect(evFrames.length).toBeGreaterThanOrEqual(1);
  });

  it("C-3 stop+dispose 收口：write-stop-ack confirmed+exit 形状+stop→exit 同 handle 硬序+dispose 有界", { timeout: 60_000 }, async () => {
    const a0 = audits.length;
    send({ t: "stop", requestId: "c3", file: "s1.jsonl" });
    const ack = await next("write-stop-ack", (f) => f.requestId === "c3");
    expect(ack.outcome!.kind).toBe("confirmed"); // C-2 刚 settled，暖进程驻留 → 此处应有进程可停
    assertExitShape((ack.outcome as { exit: unknown }).exit);
    await until(() => {
      const stop = audits.slice(a0).find((l) => stopHandleOf(l) !== null);
      if (stop === undefined) return false;
      return audits.slice(a0).some((l) => exitLineFor(stopHandleOf(stop)!).test(l));
    }, "stop→exit 证据");
    const stop = audits.slice(a0).find((l) => stopHandleOf(l) !== null)!;
    const iStop = audits.indexOf(stop);
    const iExit = audits.findIndex((l, i) => i > iStop && exitLineFor(stopHandleOf(stop)!).test(l));
    expect(iExit).toBeGreaterThan(iStop);
    // dispose 有界（同 ws-write 口径）
    const t0 = Date.now();
    await server!.dispose();
    server = null; // afterAll 不再重复 dispose
    expect(Date.now() - t0).toBeLessThan(30_000);
  });
});

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 90_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

export { d };
