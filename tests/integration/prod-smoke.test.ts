// 批A 生产烟测（P1-01 修复证明）：真实 main.ts 启动入口→全链写面回环。
// 与 M-OPS E2E（startServer rig 手动装配）分立：这里 spawn 真正的 `node main.ts` 进程——
// GPT 全量审 P1-01 点名的缺口=「M-OPS/D3/D4 E2E 测的是 rig 手动装配面非生产 main」。
// 断言链：
//   ① main 进程 ready（stdout 审计行含 write=on）
//   ② hello→welcome（生产 token 面）
//   ③ get-roots→roots-list（v1.5 新帧生产面）
//   ④ prompt{file,cwd}→write-ack launched（生产写面接线——P1-01 核心）
//   ⑤ fake pi 记录 cwd=项目根（per-session cwd 真达子进程）
//   ⑥ journal 落在 --session-dir 树
// 无真 pi 依赖：piBin=tests/fixtures/mops-fake-pi.mjs（cwd 模式）。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, chmod, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import WebSocket from "ws";

const require = createRequire(import.meta.url);
const REPO = resolve(__dirname, "../..");
const MAIN = join(REPO, "apps/server/src/main.ts");
const FAKE_PI = join(REPO, "tests/fixtures/mops-fake-pi.mjs");
const NODE = process.execPath;
const TOKEN = "prod-smoke-token";
const ORIGIN_PORT = 33100 + Math.floor(Math.random() * 2000); // 随机高位避碰撞
const ORIGIN = `http://127.0.0.1:${ORIGIN_PORT}`;

interface Rig {
  proc: ChildProcess;
  stdout: string[];
  projRoot: string;
  sessionDir: string;
  cwdRecordFile: string;
  dispose: () => Promise<void>;
}

let rig: Rig | null = null;

function until(f: () => boolean, what: string, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  return new Promise((res, rej) => {
    const tick = (): void => {
      if (f()) return res();
      if (Date.now() - t0 > ms) return rej(new Error(`timeout: ${what}`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), "prod-smoke-"));
  const projRoot = join(base, "proj");
  const sessionDir = join(projRoot, "sessions"); // 须在 roots 内（main.ts 校验）
  await mkdir(projRoot);
  await mkdir(sessionDir);
  const tokenFile = join(base, "tokens.json");
  await readFile; // keep import used
  const { writeFile } = await import("node:fs/promises");
  await writeFile(tokenFile, JSON.stringify({ version: 1, tokens: [TOKEN] }), { mode: 0o600 });
  await chmod(tokenFile, 0o600);
  const cwdRecordFile = join(base, "fake-pi-cwd.jsonl");

  const proc = spawn(NODE, [
    "--experimental-transform-types", MAIN,
    "--port", String(ORIGIN_PORT),
    "--host", "127.0.0.1",
    "--token-file", tokenFile,
    "--root", projRoot,
    "--session-dir", sessionDir,
    "--pi-bin", FAKE_PI,
  ], {
    cwd: REPO, // 服务进程 cwd=repo（与生产 systemd WorkingDirectory 语义对齐：≠项目根）
    env: { ...process.env, FAKE_PI_CWD_FILE: cwdRecordFile, MOPS_FAKE_PI_MODE: "cwd" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: string[] = [];
  proc.stdout!.setEncoding("utf8");
  proc.stdout!.on("data", (d: string) => { stdout.push(d); process.stdout.write(`[main] ${d}`); });
  proc.stderr!.setEncoding("utf8");
  proc.stderr!.on("data", (d: string) => { process.stdout.write(`[main:err] ${d}`); });

  rig = {
    proc, stdout, projRoot, sessionDir, cwdRecordFile,
    dispose: async () => {
      if (proc.exitCode === null) {
        proc.kill("SIGTERM");
        await new Promise<void>((res) => { proc.on("exit", () => res()); setTimeout(res, 3000); });
      }
      await rm(base, { recursive: true, force: true }).catch(() => {});
    },
  };
  await until(() => stdout.some((l) => l.includes("main ready")), "main ready 审计行");
}, 30_000);

afterAll(async () => { await rig?.dispose(); });

interface Frame { t?: string; [k: string]: unknown }

async function connect(): Promise<{ ws: WebSocket; frames: Frame[]; say: (f: Frame) => Promise<void> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${ORIGIN_PORT}`, { origin: ORIGIN });
  await new Promise<void>((res, rej) => { ws.on("open", res); ws.on("error", (e) => rej(e as Error)); });
  const frames: Frame[] = [];
  ws.on("message", (data) => frames.push(JSON.parse(String(data))));
  const say = async (f: Frame): Promise<void> => { ws.send(JSON.stringify(f)); };
  await say({ t: "hello", protocolVersion: 1, token: TOKEN });
  await until(() => frames.some((fr) => fr.t === "welcome"), "welcome");
  return { ws, frames, say };
}

describe("批A 生产烟测：真实 main.ts 入口→写面全链", () => {
  it("① main ready 审计行含 write=on+sessionDir", () => {
    const r = rig!;
    expect(r.stdout.some((l) => l.includes("write=on"))).toBe(true);
    expect(r.stdout.some((l) => l.includes(r.sessionDir))).toBe(true);
  });

  it("②③④ hello→welcome；get-roots→roots-list；prompt{cwd}→write-ack launched", async () => {
    const r = rig!;
    const { ws, frames, say } = await connect();
    try {
      await say({ t: "get-roots", requestId: "roots-1" });
      await until(() => frames.some((f) => f.t === "roots-list"), "roots-list");
      const rootsFrame = frames.find((f) => f.t === "roots-list") as unknown as { roots: string[] };
      // effectiveRoots 序：journal 树（sessionDir）排首（写面 file 域首根命中）+项目根授权域全量。
      expect(rootsFrame.roots).toEqual([r.sessionDir, r.projRoot]);

      await say({ t: "prompt", requestId: "p1", file: "smoke.jsonl", text: "在项目目录里跑起来", cwd: r.projRoot });
      await until(() => frames.some((f) => f.t === "write-ack"), "write-ack");
      const ack = frames.find((f) => f.t === "write-ack") as unknown as { outcome?: { kind?: string } };
      expect(ack.outcome?.kind).toBe("launched");
    } finally { ws.close(); }
  }, 20_000);

  it("⑤ fake pi 子进程 cwd=项目根（per-session cwd 真达子进程）", async () => {
    const r = rig!;
    await until(() => existsSync(r.cwdRecordFile), "fake pi cwd 记录落盘");
    const raw = await readFile(r.cwdRecordFile, "utf8");
    const rec = JSON.parse(raw.trim().split("\n")[0]!) as { cwd: string; argv: string[] };
    expect(rec.cwd).toBe(r.projRoot);
    // argv 面：--session 绝对路径在场（journal 不受 cwd 影响的机制前提）
    expect(rec.argv.includes("--session")).toBe(true);
  }, 15_000);

  it("⑥ pi argv --session 指向 --session-dir 树内（journal 目标树正确；真 pi 才写盘，fake 不写——机制面等价断言）", async () => {
    const r = rig!;
    await until(() => existsSync(r.cwdRecordFile), "fake pi cwd 记录落盘");
    const raw = await readFile(r.cwdRecordFile, "utf8");
    const rec = JSON.parse(raw.trim().split("\n")[0]!) as { argv: string[] };
    const sessionArg = rec.argv[rec.argv.indexOf("--session") + 1];
    expect(sessionArg).toBe(join(r.sessionDir, "smoke.jsonl"));
  }, 15_000);
});

// vitest 环境 require 兜底（保持 CommonJS require 引用不坠落）
void require;
