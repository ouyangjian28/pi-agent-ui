// RpcSession 受控替身测试：FakeRpcHost 模拟 pi 子进程（stdin 收帧/stdout 注入事件/exit 注入）。
// 面readiness 往返/demux 三入口/两轮正常序/意外退出后重开/探针超时退役/串行化 dur。
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProcessHandle, ProcessHostPort, ProcessSpawnHandlers } from "@pi-agent-ui/protocol";
import { FileDurability } from "../../../apps/server/src/runtime/file-durability.js";
import { RpcSession } from "../../../apps/server/src/runtime/rpc-session.js";

/** 假 pi 进程宿主：记录写出的 stdin 帧；测试用 emitEvent/emitExit 注入进程输出。 */
class FakeRpcHost implements ProcessHostPort {
  readonly frames: string[] = [];
  private handler: ProcessSpawnHandlers | null = null;
  private stopped: string[] = [];
  handle: ProcessHandle | null = null;

  spawn(_args: readonly string[], h: ProcessSpawnHandlers): ProcessHandle {
    this.handler = h;
    this.handle = { id: `fake-${Date.now()}-${Math.random().toString(36).slice(2)}` };
    return this.handle;
  }

  async writeStdin(h: ProcessHandle, text: string): Promise<void> {
    void h;
    this.frames.push(text);
  }

  stop(h: ProcessHandle, signal: "SIGTERM" | "SIGKILL"): void {
    void h;
    this.stopped.push(signal);
    this.stopped = this.stopped;
  }

  /** 注入 stdout JSON 行（经真 demux 路径）。 */
  emitEvent(obj: unknown): void {
    this.handler?.onEvent(obj);
  }

  emitExit(code: number | null, signal: string | null): void {
    this.handler?.onExit(code, signal);
  }

  get stopSignals(): readonly string[] {
    return this.stopped;
  }
}

function until(f: () => boolean, what: string, ms = 2000): Promise<void> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (f()) return resolve();
      if (Date.now() - t0 > ms) return reject(new Error(`timeout: ${what}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

const dirs: string[] = [];
const sessions: RpcSession[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) s.dispose();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeSession(over: Partial<ConstructorParameters<typeof RpcSession>[0]> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "rpc-session-"));
  dirs.push(dir);
  const host = new FakeRpcHost();
  const audits: string[] = [];
  const dur = new FileDurability(join(dir, "journal.jsonl"));
  const session = new RpcSession({
    piArgs: ["--mode", "rpc", "--no-session"],
    journalPath: join(dir, "journal.jsonl"),
    sessionId: "s-test",
    host,
    durability: dur,
    readinessTimeoutMs: 500,
    responseTimeoutMs: 5_000,
    timeoutPollMs: 20,
    audit: (l) => audits.push(l),
    ...over,
  });
  sessions.push(session);
  return { session, host, audits, dur, dir };
}

/** 真响应序：探针回执→命令 response→agent_settled。帧计数基准=发送前的 prompt 帧数（旧帧不满足等待）。 */
async function runTurn(h: FakeRpcHost, session: RpcSession, message: string, gen: number): Promise<void> {
  const before = h.frames.filter((f) => f.includes('"type":"prompt"')).length;
  const cmd = session.send(message);
  await until(() => h.frames.filter((f) => f.includes('"type":"prompt"')).length === before + 1, "prompt 帧写出");
  const frame = JSON.parse(h.frames.filter((f) => f.includes('"prompt"')).slice(-1)[0]!) as { id: string };
  h.emitEvent({ id: frame.id, type: "response", command: "prompt", success: true });
  h.emitEvent({ type: "agent_settled" });
  const r = await cmd;
  expect(r.kind).toBe("launched");
  void gen;
}

describe("RpcSession（受控替身）", () => {
  it("start：spawn→get_state 探针→ready；探针回执不进事件流", async () => {
    const { session, host } = await makeSession();
    const p = session.start();
    await until(() => host.frames.some((f) => f.includes('"type":"get_state"')), "探针写出");
    const probe = JSON.parse(host.frames[0]!) as { id: string };
    expect(probe.id).toBe("ready-1");
    host.emitEvent({ id: "ready-1", type: "response", command: "get_state", success: true });
    const r = await p;
    expect(r).toEqual({ kind: "ready", generation: 1 });
  });

  it("两轮正常序：response 归因+settled 结算+gate 回 idle+journal 落盘", async () => {
    const { session, host, dir } = await makeSession();
    const p = session.start();
    await until(() => host.frames.length === 1, "探针");
    host.emitEvent({ id: "ready-1", type: "response", command: "get_state", success: true });
    expect((await p).kind).toBe("ready");

    await runTurn(host, session, "第一句", 1);
    await until(() => (session.getState().gate as { kind: string }).kind === "idle", "第一轮 gate idle");
    await runTurn(host, session, "第二句", 1);
    await until(() => (session.getState().gate as { kind: string }).kind === "idle", "第二轮 gate idle");

    // journal：两轮各含 enqueue+sending 行（三写硬序在纯逻辑层已单测，此处验落盘事实）
    const lines = (await readFile(join(dir, "journal.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { t: string });
    const kinds = lines.map((l) => l.t);
    expect(kinds.filter((t) => t === "enqueue").length).toBe(2);
    expect(kinds.filter((t) => t === "sending").length).toBe(2);
    expect(kinds.filter((t) => t === "settled").length).toBe(2);
  });

  it("意外退出：exit→gate 关(generation-retired)→start 重开→新代次新轮可跑", async () => {
    const { session, host } = await makeSession();
    const p = session.start();
    await until(() => host.frames.length === 1, "探针");
    host.emitEvent({ id: "ready-1", type: "response", command: "get_state", success: true });
    await p;

    const cmd = session.send("跑到一半");
    await until(() => host.frames.some((f) => f.includes('"prompt"')), "prompt 写出");
    host.emitEvent({ id: "c1", type: "response", command: "prompt", success: true });
    const launched = await cmd;
    expect(launched.kind).toBe("launched");

    host.emitExit(137, null); // 意外退出
    await until(() => (session.getState().gate as { kind: string }).kind === "closed", "gate 关闭");
    expect(session.getState().supervisor).toMatchObject({ phase: "idle" });

    const p2 = session.start(); // reopen→spawn gen2
    await until(() => host.frames.filter((f) => f.includes('"get_state"')).length === 2, "第二代探针");
    const probe2 = JSON.parse(host.frames.filter((f) => f.includes('"get_state"'))[1]!) as { id: string };
    expect(probe2.id).toBe("ready-2");
    host.emitEvent({ id: "ready-2", type: "response", command: "get_state", success: true });
    expect((await p2).kind).toBe("ready");

    await runTurn(host, session, "重启后第一句", 2); // 新代次整链路通
  });

  it("readiness 探针超时：自动退役+返回 readiness-timeout，不留活进程", async () => {
    const { session, host } = await makeSession({ readinessTimeoutMs: 80 });
    const r = session.start(); // 不回探针→超时→内部 retire 等 SIGTERM 退出确认
    await until(() => host.stopSignals.includes("SIGTERM"), "SIGTERM 已发");
    host.emitExit(null, "SIGTERM"); // 假进程响应信号退出（与 retire 等待并行）
    expect((await r).kind).toBe("readiness-timeout");
    expect(session.getState().supervisor).toMatchObject({ phase: "idle" });
    // 超时后重试：spawn gen2 成功
    const p2 = session.start();
    await until(() => host.frames.filter((f) => f.includes('"get_state"')).length === 2, "重试探针");
    host.emitEvent({ id: "ready-2", type: "response", command: "get_state", success: true });
    expect((await p2).kind).toBe("ready");
  });

  it("stop：SIGTERM→退出确认；再 start 拒 not-idle 不会发生（idle 后可再拉起）", async () => {
    const { session, host } = await makeSession();
    const p = session.start();
    await until(() => host.frames.length === 1, "探针");
    host.emitEvent({ id: "ready-1", type: "response", command: "get_state", success: true });
    await p;
    const stopP = session.stop();
    await until(() => host.stopSignals.includes("SIGTERM"), "SIGTERM");
    host.emitExit(0, null);
    expect((await stopP).kind).toBe("confirmed");
  });

  it("响应超时不阻断轮次收口：response 迟到被 ignored，settled 正常结算（协调器语义透传）", async () => {
    const { session, host } = await makeSession({ responseTimeoutMs: 60 });
    const p = session.start();
    await until(() => host.frames.length === 1, "探针");
    host.emitEvent({ id: "ready-1", type: "response", command: "get_state", success: true });
    await p;
    const cmd = session.send("慢响应");
    await until(() => host.frames.some((f) => f.includes('"prompt"')), "prompt 写出");
    // 不回 response→协调器 response-timeout（60ms）；之后 settled 到达按超时后路径结算
    await new Promise((r) => setTimeout(r, 120));
    host.emitEvent({ type: "agent_settled" });
    await cmd;
    await until(() => (session.getState().gate as { kind: string }).kind !== "in-flight", "轮次收口");
    const st = session.getState();
    expect((st.gate as { kind: string }).kind).not.toBe("in-flight");
    // 晚到 response：ignored-late（不炸、不改状态）
    host.emitEvent({ id: "c1", type: "response", command: "prompt", success: true });
    expect((session.getState().gate as { kind: string }).kind).not.toBe("in-flight");
  });

  it("FileDurability：JSONL 逐行落盘；失败后 fail-closed 直到 close 重置", async () => {
    const { dir } = await makeSession();
    const dur = new FileDurability(join(dir, "d.jsonl"));
    await dur.append({ t: "enqueue" } as never);
    await dur.append({ t: "sending" } as never);
    const lines = (await readFile(join(dir, "d.jsonl"), "utf8")).trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]!).t).toBe("enqueue");
    // 失败态：把路径换成目录 → append reject → 后续 append 一律拒绝
    const bad = new FileDurability(dir); // 目录：open("a") 在 Linux 上 EISDIR
    await expect(bad.append({ t: "enqueue" } as never)).rejects.toThrow();
    await expect(bad.append({ t: "sending" } as never)).rejects.toThrow(/未修复失败态/);
    await bad.close();
  });
});
