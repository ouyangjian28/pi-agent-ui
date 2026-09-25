// RpcSession 受控替身测试：FakeRpcHost 模拟 pi 子进程（stdin 收帧/stdout 注入事件/exit 注入）。
// 面readiness 往返/demux 三入口/两轮正常序/意外退出后重开/探针超时退役/串行化 dur。
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DurabilityPort, ProcessHandle, ProcessHostPort, ProcessSpawnHandlers } from "@pi-agent-ui/protocol";
import { FileDurability } from "../../../apps/server/src/runtime/file-durability.js";
import { RpcSession } from "../../../apps/server/src/runtime/rpc-session.js";

/** 假 pi 进程宿主：记录写出的 stdin 帧；测试用 emitEvent/emitExit 注入进程输出。
 *  writeMode：ok=正常受理；fail=write reject（S4-03 写入失败）；hang=write 永不兑现（S4-03 挂起窗口）。 */
class FakeRpcHost implements ProcessHostPort {
  readonly frames: string[] = [];
  writeMode: "ok" | "fail" | "hang" = "ok";
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
    if (this.writeMode === "fail") throw new Error("stdin 写入失败（探针）");
    if (this.writeMode === "hang") await new Promise<void>(() => undefined); // 永不兑现
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

/** 受控耐久替身（S4-05）：可挂起第 N 次 append（行已计入）→release() 手动结算。 */
class HoldDurability {
  readonly lines: unknown[] = [];
  calls = 0;
  holdAt = 0;
  private releasers: Array<(err?: Error) => void> = [];
  append(line: unknown): Promise<void> {
    this.calls += 1;
    const n = this.calls;
    this.lines.push(line);
    if (this.holdAt === n) {
      return new Promise<void>((res, rej) => {
        this.releasers.push((err) => (err ? rej(err) : res()));
      });
    }
    return Promise.resolve();
  }
  release(err?: Error): void {
    this.releasers.shift()?.(err);
  }
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

  it("FileDurability：JSONL 逐行落盘；失败后 fail-closed；close 不解锁（S4-06：拒绝续写，不复位）", async () => {
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
    await bad.close(); // 关闭≠修复授权：不解锁（S4-06）
    await expect(bad.append({ t: "settled" } as never)).rejects.toThrow(/已关闭|失败态/);
    // 换段语义：新实例+新路径可继续落盘（尾部修复归恢复流程，非 close）
    const fresh = new FileDurability(join(dir, "d2.jsonl"));
    await fresh.append({ t: "enqueue" } as never);
    await fresh.close();
  });

  // ---- S4-03：readiness 写入/响应/超时=同一有界启动操作；无孤立 rejection ----
  it("S4-03a 探针 write reject：启动失败→立即退役（不等超时）→readiness-timeout", async () => {
    const { session, host } = await makeSession({ readinessTimeoutMs: 5_000 }); // 远大于写失败处置时间：证明 SIGTERM 由写失败驱动
    host.writeMode = "fail";
    const r = session.start();
    await until(() => host.stopSignals.includes("SIGTERM"), "写失败→立即 SIGTERM（非 5s 超时路径）", 800);
    host.emitExit(null, "SIGTERM");
    expect((await r)).toMatchObject({ kind: "readiness-timeout", generation: 1 });
    expect(session.getState().supervisor).toMatchObject({ phase: "idle" });
  });

  it("S4-03b 探针 write 挂起：超时能结束启动等待→退役；重试第二代 ready（GPT P4）", async () => {
    const { session, host } = await makeSession({ readinessTimeoutMs: 100 });
    host.writeMode = "hang";
    const r = session.start(); // write 永不兑现+探针无响应→超时必须终止等待
    await until(() => host.stopSignals.includes("SIGTERM"), "超时→SIGTERM（不等 write）");
    host.emitExit(null, "SIGTERM");
    expect((await r).kind).toBe("readiness-timeout");
    expect(session.getState().supervisor).toMatchObject({ phase: "idle" });
    host.writeMode = "ok"; // 重试：第二代正常
    const p2 = session.start();
    await until(() => host.frames.filter((f) => f.includes('"get_state"')).length === 2, "重试探针");
    host.emitEvent({ id: "ready-2", type: "response", command: "get_state", success: true });
    expect((await p2).kind).toBe("ready");
  });

  // ---- S4-04：成败续体绑定代次所有权；旧代不得退役/污染新代 ----
  it("S4-04a 旧 start 超时续体不退役新代（GPT P5）：A 挂起→退出→B ready→A=superseded 且 B 不收信号", async () => {
    const { session, host } = await makeSession({ readinessTimeoutMs: 120 });
    host.writeMode = "hang";
    const startA = session.start(); // gen1 探针挂起
    await until(() => host.frames.some((f) => f.includes('"get_state"')), "A 探针写出");
    host.emitExit(1, null); // A 意外退出→idle（gen1 收口）
    host.writeMode = "ok";
    const startB = session.start(); // gen2 正常就绪
    await until(() => host.frames.filter((f) => f.includes('"get_state"')).length === 2, "B 探针");
    host.emitEvent({ id: "ready-2", type: "response", command: "get_state", success: true });
    expect((await startB)).toMatchObject({ kind: "ready", generation: 2 });
    expect(host.stopSignals.length).toBe(0); // B 未被旧续体打扰
    const ra = await startA; // A 旧超时续体恢复（~120ms）
    expect(ra).toMatchObject({ kind: "superseded", generation: 1 });
    expect(host.stopSignals.length).toBe(0); // 关键：没把 SIGTERM 打到 gen2
    const stopP = session.stop();
    await until(() => host.stopSignals.includes("SIGTERM"), "B 正常退役");
    host.emitExit(0, null);
    expect((await stopP).kind).toBe("confirmed");
  });

  it("S4-04b 同步段窗口（GPT P6）：探针回执后同段退出→start 不得返回 ready（superseded）", async () => {
    const { session, host } = await makeSession();
    const startA = session.start();
    await until(() => host.frames.length === 1, "探针写出");
    // 同一同步段：回执后立即退出（探针续体还没跑）
    host.emitEvent({ id: "ready-1", type: "response", command: "get_state", success: true });
    host.emitExit(0, null);
    expect((await startA)).toMatchObject({ kind: "superseded", generation: 1 });
    expect(session.getState().supervisor).toMatchObject({ phase: "idle" });
  });

  it("S4-04c 启动中 stop：取消挂起探针→stop confirmed；旧 start=superseded 不双退", async () => {
    const { session, host } = await makeSession({ readinessTimeoutMs: 5_000 });
    host.writeMode = "hang";
    const startA = session.start();
    await until(() => host.frames.some((f) => f.includes('"get_state"')), "探针写出");
    const stopP = session.stop(); // 取消 readiness+退役
    await until(() => host.stopSignals.includes("SIGTERM"), "SIGTERM");
    host.emitExit(null, "SIGTERM");
    expect((await stopP).kind).toBe("confirmed");
    expect((await startA)).toMatchObject({ kind: "superseded", generation: 1 });
    expect(host.stopSignals.length).toBe(1); // 恰一次（旧 start 不再补一发）
  });

  // ---- S4-05：完成通知只从协调器确认路径发出；恰好一次 ----
  it("S4-05a 耐久挂起不提前通知：settled 行 fsync 挂起→onSettled 不触发；释放→结算→恰好一次；重复 settled 不再触发", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rpc-s405-"));
    dirs.push(dir);
    const host = new FakeRpcHost();
    const audits: string[] = [];
    const dur = new HoldDurability();
    const settledCalls: number[] = [];
    const session = new RpcSession({
      piArgs: ["--mode", "rpc", "--no-session"],
      journalPath: join(dir, "journal.jsonl"),
      sessionId: "s-test",
      host,
      durability: dur as unknown as DurabilityPort,
      readinessTimeoutMs: 500,
      responseTimeoutMs: 5_000,
      timeoutPollMs: 20,
      audit: (l) => audits.push(l),
      onSettled: (g) => settledCalls.push(g),
    });
    sessions.push(session);
    dur.holdAt = 3; // 第 3 次 append=settled 行：挂起
    const p = session.start();
    await until(() => host.frames.length === 1, "探针");
    host.emitEvent({ id: "ready-1", type: "response", command: "get_state", success: true });
    await p;
    const cmd = session.send("挂起结算");
    await until(() => host.frames.some((f) => f.includes('"prompt"')), "prompt 写出");
    host.emitEvent({ id: "c1", type: "response", command: "prompt", success: true });
    host.emitEvent({ type: "agent_settled" }); // settled 行 append 挂起中
    await until(() => (session.getState().gate as { kind: string }).kind === "settling", "进入 settling");
    expect(settledCalls).toEqual([]); // 不提前通知（S4-05/P7）
    dur.release(); // 耐久兑现→结算完成
    await cmd;
    await until(() => settledCalls.length === 1, "结算确认后通知");
    expect(settledCalls).toEqual([1]);
    await until(() => (session.getState().gate as { kind: string }).kind === "idle", "gate idle");
    host.emitEvent({ type: "agent_settled" }); // idle 后重复 settled：discard，不重复通知
    await new Promise((r) => setTimeout(r, 60));
    expect(settledCalls.length).toBe(1); // 恰好一次
  });

  it("S4-05b 超时记录收口路径：response 超时→settled 到→通知恰一次", async () => {
    const dir2 = await mkdtemp(join(tmpdir(), "rpc-s405b-"));
    dirs.push(dir2);
    const host2 = new FakeRpcHost();
    const dur2 = new FileDurability(join(dir2, "journal.jsonl"));
    const settledCalls: number[] = [];
    const s2 = new RpcSession({
      piArgs: ["--mode", "rpc", "--no-session"],
      journalPath: join(dir2, "journal.jsonl"),
      sessionId: "s-test",
      host: host2,
      durability: dur2,
      readinessTimeoutMs: 500,
      responseTimeoutMs: 60,
      timeoutPollMs: 20,
      onSettled: (g) => settledCalls.push(g),
    });
    sessions.push(s2);
    const p = s2.start();
    await until(() => host2.frames.length === 1, "探针");
    host2.emitEvent({ id: "ready-1", type: "response", command: "get_state", success: true });
    await p;
    const cmd = s2.send("慢响应");
    await until(() => host2.frames.some((f) => f.includes('"prompt"')), "prompt 写出");
    await new Promise((r) => setTimeout(r, 140)); // response 超时（60ms，poll 20ms）→recorded
    host2.emitEvent({ type: "agent_settled" }); // 超时后 settled→结算
    await cmd;
    await until(() => settledCalls.length === 1, "超时记录收口路径通知");
    expect(settledCalls).toEqual([1]);
  });

  it("S4-05c settled 先于 response（buffered）：不提前通知；response 回绑即结算→恰一次", async () => {
    const dir3 = await mkdtemp(join(tmpdir(), "rpc-s405c-"));
    dirs.push(dir3);
    const host3 = new FakeRpcHost();
    const dur3 = new FileDurability(join(dir3, "journal.jsonl"));
    const settledCalls: number[] = [];
    const s3 = new RpcSession({
      piArgs: ["--mode", "rpc", "--no-session"],
      journalPath: join(dir3, "journal.jsonl"),
      sessionId: "s-test",
      host: host3,
      durability: dur3,
      readinessTimeoutMs: 500,
      responseTimeoutMs: 5_000,
      timeoutPollMs: 20,
      onSettled: (g) => settledCalls.push(g),
    });
    sessions.push(s3);
    const p = s3.start();
    await until(() => host3.frames.length === 1, "探针");
    host3.emitEvent({ id: "ready-1", type: "response", command: "get_state", success: true });
    await p;
    const cmd = s3.send("settled 先到");
    await until(() => host3.frames.some((f) => f.includes('"prompt"')), "prompt 写出");
    host3.emitEvent({ type: "agent_settled" }); // response 未到：协调器 buffer（不得通知）
    await new Promise((r) => setTimeout(r, 80));
    expect(settledCalls).toEqual([]); // buffered 路径不通知（S4-05）
    host3.emitEvent({ id: "c1", type: "response", command: "prompt", success: true }); // 回绑即结算
    await cmd;
    await until(() => settledCalls.length === 1, "回绑即结算后通知");
    expect(settledCalls).toEqual([1]);
  });

  // ---- s4b B1：响应先到不撤销总截止/取消口（写+响应=同一有界操作） ----
  it("S4-B1a 响应先到+写永久挂起：总截止仍终结启动（readiness-timeout，非永久 pending）", async () => {
    const { session, host } = await makeSession({ readinessTimeoutMs: 100 });
    host.writeMode = "hang"; // 写永不兑现
    const r = session.start();
    await until(() => host.frames.length === 1, "探针写出");
    host.emitEvent({ id: "ready-1", type: "response", command: "get_state", success: true }); // 响应先到（旧代码此处会清 timer）
    await until(() => host.stopSignals.includes("SIGTERM"), "总截止仍触发退役", 1000); // 100ms 超时驱动
    host.emitExit(null, "SIGTERM");
    expect((await r)).toMatchObject({ kind: "readiness-timeout", generation: 1 });
    expect(session.getState().supervisor).toMatchObject({ phase: "idle" });
  });

  it("S4-B1b 响应已到+写挂起：stop 取消口仍有效（superseded 不永久等待）", async () => {
    const { session, host } = await makeSession({ readinessTimeoutMs: 5_000 });
    host.writeMode = "hang";
    const startA = session.start();
    await until(() => host.frames.length === 1, "探针写出");
    host.emitEvent({ id: "ready-1", type: "response", command: "get_state", success: true }); // 响应已到
    const stopP = session.stop(); // 取消口必须仍在（旧代码 waiter 已删=找不到取消入口）
    await until(() => host.stopSignals.includes("SIGTERM"), "stop→SIGTERM");
    host.emitExit(null, "SIGTERM");
    expect((await stopP).kind).toBe("confirmed");
    expect((await startA)).toMatchObject({ kind: "superseded", generation: 1 });
    expect(host.stopSignals.length).toBe(1);
  });

  // ---- s4b B2：ready 不得对应 stopping/已退出进程 ----
  it("S4-B2a 响应后同段 stop：start 不返回 ready（P4），旧启动失效", async () => {
    const { session, host } = await makeSession();
    const startA = session.start();
    await until(() => host.frames.length === 1, "探针写出");
    host.emitEvent({ id: "ready-1", type: "response", command: "get_state", success: true });
    const stopP = session.stop(); // 同一同步段（探针续体微任务未跑）
    await until(() => host.stopSignals.includes("SIGTERM"), "SIGTERM");
    host.emitExit(null, "SIGTERM");
    expect((await stopP).kind).toBe("confirmed");
    const ra = await startA; // 旧代码此处=ready(1) 而 supervisor=stopping（P4 反例）
    expect(ra.kind).not.toBe("ready");
    expect(ra).toMatchObject({ kind: "superseded", generation: 1 });
  });

  it("S4-B2b 探针成功与 start 返回之间退出（P2 终窗）：返回前复核，不报 ready", async () => {
    const { session, host } = await makeSession();
    const startA = session.start();
    await until(() => host.frames.length === 1, "探针写出");
    host.emitEvent({ id: "ready-1", type: "response", command: "get_state", success: true });
    // 探针续体微任务与退出微任务交替：退出在 start 最终返回前落定
    queueMicrotask(() => host.emitExit(0, null));
    const ra = await startA; // 旧代码=ready(1) 而 supervisor=idle/generation=null（P2 反例）
    expect(ra.kind).not.toBe("ready");
    expect(ra).toMatchObject({ kind: "superseded", generation: 1 });
  });

  it("S4-B2c 探针成功路径内同步退出（readyGeneration 已置→finish 前窗口）：返回前复核兜底", async () => {
    // 审计钩子在探针成功路径内同步观察：readyGeneration 已置、finish 未落——用它在精确窗口注入退出
    const dir6 = await mkdtemp(join(tmpdir(), "rpc-s402c-"));
    dirs.push(dir6);
    const host6 = new FakeRpcHost();
    const dur6 = new FileDurability(join(dir6, "journal.jsonl"));
    const s6 = new RpcSession({
      piArgs: ["--mode", "rpc", "--no-session"],
      journalPath: join(dir6, "journal.jsonl"),
      sessionId: "s-test",
      host: host6,
      durability: dur6,
      readinessTimeoutMs: 500,
      timeoutPollMs: 20,
      audit: (l) => {
        if (l.includes("rpc-session ready")) host6.emitExit(0, null); // 同步窗口：readyGeneration 已置、探针未 finish
      },
    });
    sessions.push(s6);
    const startA = s6.start();
    await until(() => host6.frames.length === 1, "探针写出");
    host6.emitEvent({ id: "ready-1", type: "response", command: "get_state", success: true });
    const ra = await startA; // 探针成功路径内已退出：终窗复核不得返回 ready
    expect(ra.kind).not.toBe("ready");
    expect(ra).toMatchObject({ kind: "superseded", generation: 1 });
  });

  it("S4-05d settled 先缓冲→超时记录收口（recorded-and-settled）：通知恰一次", async () => {
    const dir4 = await mkdtemp(join(tmpdir(), "rpc-s405d-"));
    dirs.push(dir4);
    const settledCalls: number[] = [];
    const host4 = new FakeRpcHost();
    const dur4 = new FileDurability(join(dir4, "journal.jsonl"));
    const s4 = new RpcSession({
      piArgs: ["--mode", "rpc", "--no-session"],
      journalPath: join(dir4, "journal.jsonl"),
      sessionId: "s-test",
      host: host4,
      durability: dur4,
      readinessTimeoutMs: 500,
      responseTimeoutMs: 60,
      timeoutPollMs: 20,
      onSettled: (g) => settledCalls.push(g),
    });
    sessions.push(s4);
    const p = s4.start();
    await until(() => host4.frames.length === 1, "探针");
    host4.emitEvent({ id: "ready-1", type: "response", command: "get_state", success: true });
    await p;
    const cmd = s4.send("settled 先缓冲后超时");
    await until(() => host4.frames.some((f) => f.includes('"prompt"')), "prompt 写出");
    host4.emitEvent({ type: "agent_settled" }); // response 未到：缓冲
    await new Promise((r) => setTimeout(r, 140)); // 超时（60ms）→记录→缓冲 settled 合并结算=recorded-and-settled
    await cmd;
    await until(() => settledCalls.length === 1, "recorded-and-settled 通知");
    expect(settledCalls).toEqual([1]);
    await until(() => (s4.getState().gate as { kind: string }).kind === "idle", "gate idle");
  });

  it("S4-05e settled 耐久 reject：零通知（settle-durability-failed 不发完成通知）", async () => {
    const dir5 = await mkdtemp(join(tmpdir(), "rpc-s405e-"));
    dirs.push(dir5);
    const host5 = new FakeRpcHost();
    const dur5 = new HoldDurability();
    const settledCalls: number[] = [];
    const audits: string[] = [];
    const s5 = new RpcSession({
      piArgs: ["--mode", "rpc", "--no-session"],
      journalPath: join(dir5, "journal.jsonl"),
      sessionId: "s-test",
      host: host5,
      durability: dur5 as unknown as DurabilityPort,
      readinessTimeoutMs: 500,
      responseTimeoutMs: 5_000,
      timeoutPollMs: 20,
      audit: (l) => audits.push(l),
      onSettled: (g) => settledCalls.push(g),
    });
    sessions.push(s5);
    dur5.holdAt = 3; // settled 行 append 挂起
    const p = s5.start();
    await until(() => host5.frames.length === 1, "探针");
    host5.emitEvent({ id: "ready-1", type: "response", command: "get_state", success: true });
    await p;
    const cmd = s5.send("耐久拒绝");
    await until(() => host5.frames.some((f) => f.includes('"prompt"')), "prompt 写出");
    host5.emitEvent({ id: "c1", type: "response", command: "prompt", success: true });
    host5.emitEvent({ type: "agent_settled" }); // settled append 挂起中
    await until(() => (s5.getState().gate as { kind: string }).kind === "settling", "settling");
    dur5.release(new Error("EIO: 模拟磁盘错误")); // 拒绝（非兑现）
    await new Promise((r) => setTimeout(r, 60));
    expect(settledCalls).toEqual([]); // 耐久失败零通知
    await until(
      () => audits.some((l) => l.includes("settle-held") || l.includes("settle-durability-failed")),
      "耐久失败审计可见",
    );
    void cmd;
  });
});
