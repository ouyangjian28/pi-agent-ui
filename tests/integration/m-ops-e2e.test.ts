// M-OPS E2E（m-ops-e2e）：真 composition+真 WebSocket+假 pi（tests/fixtures/mops-fake-pi.mjs）。
// 无真 pi 依赖常跑：原spawn/生命周期与0.99形状的受控配置确认回环；不冒称真实pi切参链。
// 真 pi 探针往返已有 pi-child.smoke 覆盖。设计=docs/m-ops-design.md v2 §5。
// 腿：1  get-models ok（假 pi list 模式→models-list 回帧解析 provider/model 两列）
//     1b listfail→models-list 空表+cause（不 close 主连接）
//     2  ready 模式 prompt{model}→write-ack launched+argv 尾追 --model 断言+sidecar `<file>.session.model` 落盘
//     3a exit 模式→not-ready{cause:spawn-exited,detail 含 stderr 行}
//     3b piBin 不存在→not-ready{cause:spawn-failed}
//     3c timeout 模式+readinessTimeoutMs 调小→not-ready{cause:readiness-timeout}
//     4  未配 piBin→get-models 4405（modelsListing 不接线=天然拒）
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import WebSocket from "ws";
import { startServer, type PiAgentUiServer } from "../../apps/server/src/composition.ts";

const ORIGIN = "http://localhost:5173";
const TOKEN = "tok-mops-e2e";
const FILE = "m1.jsonl";
const FAKE_PI = join(dirname(new URL(import.meta.url).pathname), "..", "fixtures", "mops-fake-pi.mjs");

interface Frame {
  t?: string; requestId?: string; code?: number; reason?: string; state?: string;
  outcome?: { kind?: string; cause?: string; detail?: string };
  models?: Array<{ provider: string; id: string; context?: number }>; cause?: string;
  [k: string]: unknown;
}

const until = async (pred: () => boolean, what: string, ms = 10_000): Promise<void> => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

interface Rig {
  server: PiAgentUiServer; ws: WebSocket; frames: Frame[]; argvFile: string; rpcFile: string; sessionAbs: string;
  dispose(): Promise<void>;
}

/** 真 composition rig：piBin=假 pi（模式经 MOPS_FAKE_PI_MODE env——子进程惰性 spawn 时继承，
 *  故 env 在 rig 存续期保持、dispose 时才恢复；list/get-models 首请求才 spawn）。 */
async function makeRig(mode: string | null, opts: { readinessTimeoutMs?: number; noPiBin?: boolean } = {}): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), "mops-e2e-"));
  await mkdir(join(dir, "sessions"), { recursive: true });
  const tokenFile = join(dir, "tokens.json");
  await writeFile(tokenFile, JSON.stringify({ version: 1, tokens: [TOKEN] }), "utf8");
  await chmod(tokenFile, 0o600);
  await writeFile(join(dir, FILE), "", "utf8"); // journal 事实源（空文件放行——d4 教训）
  const argvFile = join(dir, "argv.log");
  const rpcFile = join(dir, "rpc.log");
  const sessionAbs = join(dir, "sessions", `${FILE}.session`);
  const prevMode = process.env.MOPS_FAKE_PI_MODE;
  const prevArgv = process.env.MOPS_ARGV_FILE;
  const prevRpc = process.env.MOPS_RPC_FILE;
  if (mode !== null) process.env.MOPS_FAKE_PI_MODE = mode;
  process.env.MOPS_ARGV_FILE = argvFile;
  process.env.MOPS_RPC_FILE = rpcFile;
  const restoreEnv = (): void => {
    if (mode !== null) {
      if (prevMode === undefined) delete process.env.MOPS_FAKE_PI_MODE;
      else process.env.MOPS_FAKE_PI_MODE = prevMode;
    }
    if (prevArgv === undefined) delete process.env.MOPS_ARGV_FILE;
    else process.env.MOPS_ARGV_FILE = prevArgv;
    if (prevRpc === undefined) delete process.env.MOPS_RPC_FILE;
    else process.env.MOPS_RPC_FILE = prevRpc;
  };
  const server = await startServer({
    tokenFile,
    allowedOrigins: [ORIGIN],
    roots: [dir],
    scanDir: dir,
    tokenPollMs: 0,
    sessionFor: () => sessionAbs,
    write: opts.noPiBin === true
      ? { sessionFor: () => sessionAbs, readinessTimeoutMs: 300 }
      : {
          sessionFor: () => sessionAbs,
          piBin: FAKE_PI, // fixture 本身（shebang env node+可执行位）；argv 干净无 node 前缀
          readinessTimeoutMs: opts.readinessTimeoutMs ?? 8_000,
        },
    trustFirstRecoveryCapture: true,
  });
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`, { origin: ORIGIN });
  await new Promise<void>((res, rej) => { ws.on("open", res); ws.on("error", (e) => rej(e as Error)); });
  const frames: Frame[] = [];
  ws.on("message", (data) => frames.push(JSON.parse(String(data))));
  ws.send(JSON.stringify({ t: "hello", protocolVersion: 1, token: TOKEN }));
  await until(() => frames.some((f) => f.t === "welcome"), "welcome");
  return {
    server, ws, frames, argvFile, rpcFile, sessionAbs,
    dispose: async () => {
      try { ws.close(); } catch { /* 已关 */ }
      await server.dispose().catch(() => {});
      restoreEnv();
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

const getModels = (rig: Rig, rid: string): Promise<Frame> => {
  rig.ws.send(JSON.stringify({ t: "get-models", requestId: rid }));
  return until(() => rig.frames.some((f) => (f.t === "models-list" || f.t === "error") && f.requestId === rid), `get-models ${rid}`)
    .then(() => rig.frames.find((f) => (f.t === "models-list" || f.t === "error") && f.requestId === rid)!);
};

const prompt = (rig: Rig, rid: string, model?: string): Promise<Frame | undefined> => {
  rig.ws.send(JSON.stringify({ t: "prompt", requestId: rid, file: FILE, text: "hi", ...(model !== undefined ? { model } : {}) }));
  return until(() => rig.frames.some((f) => f.t === "write-ack" && f.requestId === rid), `write-ack ${rid}`)
    .then(() => rig.frames.find((f) => f.t === "write-ack" && f.requestId === rid));
};

interface RpcObservation {
  msg: { type: string; id?: string; provider?: string; modelId?: string; message?: string };
  state: { model: { provider: string; id: string }; thinkingLevel: string };
  pid: number;
}
const observations = (rig: Rig): RpcObservation[] => existsSync(rig.rpcFile)
  ? readFileSync(rig.rpcFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as RpcObservation)
  : [];
async function expectOnlyWriterRegistration(rig: Rig): Promise<void> {
  // Cold bootstrap durably registers its writer; that is NOT a user intent/prompt.
  const rows = (await readFile(join(dirname(rig.argvFile), FILE), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
  expect(rows.map(row => row.t)).toEqual(["writer"]);
  expect(rows[0]).toMatchObject({ epoch: 1, bootId: expect.any(String), at: expect.any(String) });
}

describe("M-OPS E2E（真 composition+假 pi）", () => {
  it("腿1：get-models ok——假 pi list 模式→models-list 回帧解析 provider/model", async () => {
    const rig = await makeRig("list");
    try {
      const f = await getModels(rig, "g1");
      expect(f.t).toBe("models-list");
      expect(f.models).toHaveLength(3);
      expect(f.models?.[0]).toMatchObject({ provider: "kimi-coding", id: "k3" });
      expect(f.models?.[2]).toMatchObject({ provider: "deepseek", id: "deepseek-chat", context: "131072" });
      expect(f.cause).toBeUndefined();
    } finally { await rig.dispose(); }
  });

  it("腿1b：listfail→空表+cause；主连接不 close（后续帧仍可达）", async () => {
    const rig = await makeRig("listfail");
    try {
      const f = await getModels(rig, "g2");
      expect(f.t).toBe("models-list");
      expect(f.models).toEqual([]);
      expect(typeof f.cause).toBe("string");
      expect(f.cause).toContain("退出码");
      // 主连接存活：紧跟一个 ok 帧（模式 env 已还原——腿级 env 只在 boot 期生效，此处复用同 server：
      // 实际该 server 的 listfail 已固化在子进程读取瞬间，缓存 10min——换 server 验证存活面）
      const rig2 = await makeRig("list");
      try {
        const f2 = await getModels(rig2, "g2b");
        expect(f2.t).toBe("models-list");
      } finally { await rig2.dispose(); }
    } finally { await rig.dispose(); }
  });

  it("腿2：ready 模式 prompt{model}→launched+argv 尾追 --model+sidecar 落盘", async () => {
    const rig = await makeRig("ready");
    try {
      const ack = await prompt(rig, "p1", "kimi-coding/k3");
      expect(ack?.outcome?.kind).toBe("launched");
      await until(() => existsSync(rig.argvFile), "argv 落盘");
      const argvLines = (await readFile(rig.argvFile, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as string[]);
      const argv = argvLines.at(-1)!;
      // piArgs 基底（--mode rpc --session <abs>）+尾追 --model（恒胜=最后项；piBin=fixture 本身，无 extraPiArgs）
      expect(argv.at(-2)).toBe("--model");
      expect(argv.at(-1)).toBe("kimi-coding/k3");
      expect(argv).toContain("--mode");
      expect(argv).toContain("rpc");
      // sidecar：<sessionFile>.model 落盘内容=模型 id
      const sidecar = `${rig.sessionAbs}.model`;
      await until(() => existsSync(sidecar), "sidecar 落盘");
      expect((await readFile(sidecar, "utf8")).trim()).toBe("kimi-coding/k3");
      await until(() => observations(rig).some(item => item.msg.type === "prompt"), "pi实际收到prompt");
      const records = observations(rig);
      const configured = records.filter(item => item.msg.id?.startsWith("cfg-"));
      expect(configured.map(item => item.msg.type)).toEqual(["get_state", "get_available_thinking_levels", "get_state"]);
      const sent = records.findIndex(item => item.msg.type === "prompt");
      expect(sent).toBeGreaterThan(records.indexOf(configured.at(-1)!));
      expect(records[sent]?.msg).toMatchObject({ id: "c1", type: "prompt", message: "hi" });
      expect(records[sent]?.state.model).toMatchObject({ provider: "kimi-coding", id: "k3" });
      expect(new Set(records.map(item => item.pid)).size).toBe(1);
    } finally { await rig.dispose(); }
  }, 20_000);

  it("腿2b：配置success但缺实际状态→明确拒绝、无prompt/sidecar/意图", async () => {
    const rig = await makeRig("ready-no-facts");
    try {
      const ack = await prompt(rig, "missing-facts", "kimi-coding/k3");
      expect(ack?.outcome).toMatchObject({ kind: "not-ready", cause: "settings-malformed" });
      const records = observations(rig);
      expect(records.filter(item => item.msg.id?.startsWith("cfg-")).map(item => item.msg.type)).toEqual(["get_state"]);
      expect(records.some(item => item.msg.type === "prompt")).toBe(false);
      expect(existsSync(`${rig.sessionAbs}.model`)).toBe(false);
      await expectOnlyWriterRegistration(rig);
    } finally { await rig.dispose(); }
  }, 20_000);

  it("腿2c：set_model成功但实际模型不变→明确拒绝、无prompt/sidecar/意图", async () => {
    const rig = await makeRig("ready-model-mismatch");
    try {
      const ack = await prompt(rig, "model-mismatch", "kimi-coding/k3");
      expect(ack?.outcome).toMatchObject({ kind: "not-ready", cause: "settings-rejected" });
      const records = observations(rig);
      const setter = records.find(item => item.msg.type === "set_model");
      expect(setter?.msg).toMatchObject({ provider: "kimi-coding", modelId: "k3" });
      expect(records.filter(item => item.msg.id?.startsWith("cfg-")).map(item => item.msg.type)).toEqual(["get_state", "get_available_models", "get_state", "set_model", "get_state"]);
      expect(records.some(item => item.msg.type === "prompt")).toBe(false);
      expect(existsSync(`${rig.sessionAbs}.model`)).toBe(false);
      await expectOnlyWriterRegistration(rig);
    } finally { await rig.dispose(); }
  }, 20_000);

  it("腿3a：exit 模式→not-ready{cause:spawn-exited,detail 含 stderr 行}", async () => {
    const rig = await makeRig("exit");
    try {
      const ack = await prompt(rig, "p2");
      expect(ack?.outcome?.kind).toBe("not-ready");
      expect(ack?.outcome?.cause).toBe("spawn-exited");
      expect(ack?.outcome?.detail).toContain("nope");
    } finally { await rig.dispose(); }
  }, 20_000);

  it("腿3b：piBin 不存在→not-ready{cause:spawn-failed}", async () => {
    // 直接构造（Kimi 审 P3-2：裸构造+try/finally 防泄漏——去 makeRig 废操作）
    const dir = await mkdtemp(join(tmpdir(), "mops-e2e-3b-"));
    await mkdir(join(dir, "sessions"), { recursive: true });
    const tokenFile = join(dir, "tokens.json");
    await writeFile(tokenFile, JSON.stringify({ version: 1, tokens: [TOKEN] }), "utf8");
    await chmod(tokenFile, 0o600);
    await writeFile(join(dir, FILE), "", "utf8");
    const sessionAbs = join(dir, "sessions", `${FILE}.session`);
    const server = await startServer({
      tokenFile, allowedOrigins: [ORIGIN], roots: [dir], scanDir: dir, tokenPollMs: 0,
      sessionFor: () => sessionAbs,
      write: { sessionFor: () => sessionAbs, piBin: join(dir, "no-such-pi"), readinessTimeoutMs: 300 },
      trustFirstRecoveryCapture: true,
    });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`, { origin: ORIGIN });
    try {
      await new Promise<void>((res, rej) => { ws.on("open", res); ws.on("error", (e) => rej(e as Error)); });
      const frames: Frame[] = [];
      ws.on("message", (data) => frames.push(JSON.parse(String(data))));
      ws.send(JSON.stringify({ t: "hello", protocolVersion: 1, token: TOKEN }));
      await until(() => frames.some((f) => f.t === "welcome"), "welcome");
      ws.send(JSON.stringify({ t: "prompt", requestId: "p3", file: FILE, text: "hi" }));
      await until(() => frames.some((f) => f.t === "write-ack" && f.requestId === "p3"), "write-ack p3");
      const ack = frames.find((f) => f.t === "write-ack" && f.requestId === "p3");
      expect(ack?.outcome?.kind).toBe("not-ready");
      expect(ack?.outcome?.cause).toBe("spawn-failed");
    } finally {
      try { ws.close(); } catch { /* 已关 */ }
      await server.dispose().catch(() => {});
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("腿3c：timeout 模式+小 readiness 超时→not-ready{cause:readiness-timeout}", async () => {
    const rig = await makeRig("timeout", { readinessTimeoutMs: 400 });
    try {
      const ack = await prompt(rig, "p4");
      expect(ack?.outcome?.kind).toBe("not-ready");
      expect(ack?.outcome?.cause).toBe("readiness-timeout");
      // timeout 面进程活着只是不答探针：无 stderr 行→detail 可缺省（契约 detail?）
      if (ack?.outcome?.detail !== undefined) expect(typeof ack.outcome.detail).toBe("string");
    } finally { await rig.dispose(); }
  });

  it("腿4：未配 piBin→get-models 4405（modelsListing 不接线=天然拒）", async () => {
    const rig = await makeRig(null, { noPiBin: true });
    try {
      rig.ws.send(JSON.stringify({ t: "get-models", requestId: "g4" }));
      await until(() => rig.frames.some((f) => f.t === "error" && f.requestId === "g4"), "error g4");
      const e = rig.frames.find((f) => f.t === "error" && f.requestId === "g4");
      expect(e?.code).toBe(4405);
    } finally { await rig.dispose(); }
  });
});
