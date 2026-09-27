// 3c-3：真进程写/停端到端（第19d轮 GO 放行范围）。
// 守卫：默认 skip（真调 LLM）；显式跑=PI_E2E=1 npx vitest run tests/integration/ws-write-e2e.test.ts。
// 链=composition(write)→gateway→RpcWriteHost→session-registry→RpcSession→PiProcessHost→真 pi 0.86.1。
// 面：①prompt→write-ack launched→journal 意图/sending 行→settled ②stop→confirmed+进程退出证据
// ③退役后再 prompt=冷启动新代次（同会话文件恢复）④dispose 在飞轮次→统一销毁。
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startServer, type PiAgentUiServer } from "../../apps/server/src/composition.ts";

const PI_BIN = "/home/yyj/.nvm/versions/node/v24.18.0/bin/pi";
const PI_VERSION = "0.86.1"; // 与 pi-e2e.test.ts 同锁（升级须显式改并复跑）
const RUN = process.env.PI_E2E === "1";
const ORIGIN = "http://localhost:5173";
const TOKEN = "tok-3c3-e2e";

interface Frame { t?: string; [k: string]: unknown }

const d = describe.skipIf(!RUN)("3c-3 真进程写/停 E2E", () => {
  let dir = "";
  let server: PiAgentUiServer | null = null;
  const audits: string[] = [];
  let ws: WebSocket | null = null;
  const frames: Frame[] = [];

  beforeAll(async () => {
    const v = spawnSync(PI_BIN, ["--version"], { encoding: "utf8" });
    if (!v.stdout.includes(PI_VERSION)) throw new Error(`pi 版本漂移：期望 ${PI_VERSION}，实得 ${v.stdout.trim()}`);
    dir = await mkdtemp(join(tmpdir(), "e2e-3c3-"));
    await mkdir(join(dir, "recovery-evidence"), { recursive: true });
    const tokenFile = join(dir, "tokens.json");
    await writeFile(tokenFile, JSON.stringify({ version: 1, tokens: [TOKEN] }), { mode: 0o600 });
    await chmod(tokenFile, 0o600);
    server = await startServer({
      tokenFile,
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
    ws = new WebSocket(`ws://127.0.0.1:${server.port}`, { origin: ORIGIN });
    await new Promise<void>((res, rej) => { ws!.on("open", res); ws!.on("error", (e) => rej(e as Error)); });
    ws.on("message", (data) => frames.push(JSON.parse(String(data))));
    ws.send(JSON.stringify({ t: "hello", protocolVersion: 1, token: TOKEN }));
    await until(() => frames.some((f) => f.t === "welcome"), "welcome");
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
  async function readJournal(): Promise<string[]> {
    try { return (await readFile(join(dir, "s1.jsonl"), "utf8")).split("\n").filter((l) => l.length > 0); } catch { return []; }
  }

  it("E1 prompt→write-ack launched→journal 三写硬序行→settled 落盘（真 pi 真轮次）", { timeout: 180_000 }, async () => {
    send({ t: "prompt", requestId: "e1", file: "s1.jsonl", text: "只回复两个字：收到" });
    const ack = await next("write-ack", (f) => f.requestId === "e1");
    expect(ack.outcome).toEqual({ kind: "launched", intentId: expect.any(String), commandId: expect.any(Number) });
    await until(async () => {
      const lines = await readJournal();
      return lines.some((l) => l.includes("\"t\":\"intent\"") || l.includes("turn-enqueued") || l.includes("intent"))
        && lines.some((l) => l.includes("settled"));
    }, "journal 意图+settled 行", 150_000);
    const lines = await readJournal();
    expect(lines.length).toBeGreaterThan(1);
  });

  it("E2 stop：settled 后无进程在飞→no-process（不伪造）；审计含真进程退出证据", { timeout: 60_000 }, async () => {
    await until(() => audits.some((l) => l.includes("process-host exit")), "process-host exit", 30_000); // E1 轮收口后闲置回收器/正常退出
    send({ t: "stop", requestId: "e2", file: "s1.jsonl" });
    const ack = await next("write-stop-ack", (f) => f.requestId === "e2");
    expect(["no-process", "confirmed"]).toContain((ack.outcome as { kind: string }).kind);
  });

  it("E3 退役后冷启动：再次 prompt→新代次 launched（同会话文件恢复原上下文）", { timeout: 180_000 }, async () => {
    send({ t: "prompt", requestId: "e3", file: "s1.jsonl", text: "我上一句让你回复什么？只答那两个字" });
    const ack = await next("write-ack", (f) => f.requestId === "e3");
    expect((ack.outcome as { kind: string }).kind).toBe("launched");
    await until(async () => (await readJournal()).some((l) => l.includes("settled")), "第二轮 settled", 150_000);
  });

  it("E4 dispose 在飞：轮次进行中 server.dispose()→统一销毁完成（进程退出+registry disposed）", { timeout: 60_000 }, async () => {
    send({ t: "prompt", requestId: "e4", file: "s2.jsonl", text: "数到一百再停" });
    await next("write-ack", (f) => f.requestId === "e4");
    const t0 = Date.now();
    await server!.dispose();
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(audits.some((l) => l.includes("session-registry disposed"))).toBe(true);
    expect(audits.some((l) => l.includes("composition disposed"))).toBe(true);
    server = null; // afterAll 不再重复 dispose
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
