// D1 直播面 E2E（PI_E2E=1 才跑；真 pi 一轮→订阅连接收 message-delta 流+message-final 全文）。
// 验证链：rpc-session onPiEvent → composition 聚合器（delivered 门+thinking 滤）→ gateway.broadcastLive
// → 订阅引擎 live 帧 → WebSocket 客户端收帧。设计稿 docs/d1-live-stream-design.md §6 E2E。
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startServer, type PiAgentUiServer } from "../../apps/server/src/composition.ts";

const RUN = process.env.PI_E2E === "1";
const PI_BIN = "/home/yyj/.nvm/versions/node/v24.18.0/bin/pi";
const PI_VERSION = "0.0.0"; // 不锁版本（本探针面只验事件流管道）
const ORIGIN = "http://localhost:5173";
const TOKEN = "tok-d1";
const until = async (pred: () => boolean, what: string, ms = 30_000): Promise<void> => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};

interface Frame { t?: string; origin?: string; events?: Array<{ kind: string; delta?: string; text?: string; part?: string }>; [k: string]: unknown }

const d = describe.skipIf(!RUN)("D1 直播面 E2E（真 pi 增量流→订阅连接）", () => {
  let dir = "";
  const audits: string[] = [];
  let server: PiAgentUiServer | null = null;
  let ws: WebSocket | null = null;
  const frames: Frame[] = [];

  beforeAll(async () => {
    const v = spawnSync(PI_BIN, ["--version"], { encoding: "utf8" });
    if (v.status !== 0) throw new Error(`pi 二进制不可用：${v.stderr}`);
    dir = await mkdtemp(join(tmpdir(), "d1-e2e-"));
    await mkdir(join(dir, "sessions"), { recursive: true });
    const tokenFile = join(dir, "tokens.json");
    await writeFile(tokenFile, JSON.stringify({ version: 1, tokens: [TOKEN] }), "utf8");
    await chmod(tokenFile, 0o600);
    server = await startServer({
      tokenFile,
      allowedOrigins: [ORIGIN],
      roots: [dir],
      scanDir: dir,
      tokenPollMs: 0,
      write: {
        sessionFor: (f) => join(dir, "sessions", `${String(f).split("/").pop()}.session`),
        piBin: PI_BIN,
        responseTimeoutMs: 60_000,
        turnTimeoutMs: 120_000,
        readinessTimeoutMs: 20_000,
      },
      audit: (l) => audits.push(l),
      trustFirstRecoveryCapture: true,
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
    await rm(dir, { recursive: true, force: true });
  });

  it("D1-E2E 真 pi 一轮：订阅收 message-delta 增量流+message-final=assistant 全文", async () => {
    // journal 预置（订阅面需要文件存在——4402 fail-closed；合规首行 writer 声明）
    const file = "d1-live.jsonl";
    await writeFile(join(dir, file), JSON.stringify({ t: "writer", epoch: 1, bootId: "d1-e2e-boot", at: new Date().toISOString() }) + "\n", "utf8");
    // 订阅先于 prompt（进 live 相态）
    ws!.send(JSON.stringify({ t: "subscribe", requestId: "d1-sub", file }));
    await until(() => frames.some((f) => f.t === "snapshot"), "snapshot");
    // 真 pi 一轮（write 面 prompt→settled）
    ws!.send(JSON.stringify({ t: "prompt", requestId: "d1-r1", file, text: "请写一段大约一百二十字的短文，谈谈流式输出界面的意义，写满别偷懒" }));
    await until(() => frames.some((f) => f.t === "write-ack" && (f as { requestId?: string }).requestId === "d1-r1"), "write-ack", 60_000);
    // 终局：message-final 到达（增量流至少一帧 delta）
    await until(() => frames.some((f) => f.t === "events" && f.origin === "live"
      && f.events?.some((e) => e.kind === "message-final" && typeof e.text === "string" && e.text.length > 0)), "message-final", 120_000);
    const liveEvents = frames.flatMap((f) => (f.t === "events" && f.origin === "live" ? (f.events ?? []) : []));
    const deltas = liveEvents.filter((e) => e.kind === "message-delta");
    expect(deltas.length).toBeGreaterThan(0); // 增量流非空
    expect(deltas.every((e) => e.part === "text")).toBe(true); // thinking 缺省滤（探针实证 pi 每轮必有 thinking）
    const final = liveEvents.find((e) => e.kind === "message-final")!;
    expect(final.text!.length).toBeGreaterThan(0);
    // 拼接增量=final 全文前缀（终局权威：delta 流未丢段）
    const joined = deltas.map((e) => e.delta ?? "").join("");
    expect(joined.length).toBeGreaterThan(10); // 长回复跨节流窗：增量流非空（短回复可能整体在窗内被 final 权威吸收）
    expect(final.text!.startsWith(joined) || joined.startsWith(final.text!.slice(0, joined.length))).toBe(true);
  }, 180_000);
});
