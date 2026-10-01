// M-OPS（v1.4）模型选择后端面单测：会话级模型记忆+sidecar 持久化+spawn 尾追恒胜+not-ready detail 净化。
// 复用 rpc-session.test.ts 的 FakeRpcHost 形态（spawnArgs 记录面=本批主断言锚）。
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProcessHandle, ProcessHostPort, ProcessSpawnHandlers } from "@pi-agent-ui/protocol";
import { FileDurability } from "../../../apps/server/src/runtime/file-durability.js";
import { RpcSession } from "../../../apps/server/src/runtime/rpc-session.js";

class FakeRpcHost implements ProcessHostPort {
  readonly frames: string[] = [];
  readonly spawnArgs: string[][] = [];
  /** spawn 即抛（spawn-failed 面）。 */
  failSpawn = false;
  /** stderr 注入队列（spawn 后逐条发出）。 */
  stderrLines: string[] = [];
  private handler: ProcessSpawnHandlers | null = null;
  autoExit = false;
  dropSettings = false;
  clampThinking = false;
  thinking = "off";
  model = { provider: "litellm", id: "default", name: "default", input: ["text"] };
  stateOverride: Record<string, unknown> = {};
  levels: unknown = ["off", "low", "high"];

  spawn(args: readonly string[], h: ProcessSpawnHandlers): ProcessHandle {
    if (this.failSpawn) throw new Error("spawn 失败（测试注入）");
    this.spawnArgs.push([...args]);
    const selected = args.at(-2) === "--model" ? args.at(-1) : undefined;
    if (selected !== undefined) { const slash = selected.indexOf("/"); this.model = { provider: selected.slice(0, slash), id: selected.slice(slash + 1), name: selected, input: ["text"] }; }
    this.handler = h;
    for (const line of this.stderrLines.splice(0)) h.onStderr(line);
    return { id: `fake-${Math.random().toString(36).slice(2)}` };
  }

  async writeStdin(h: ProcessHandle, text: string): Promise<void> {
    void h;
    this.frames.push(text);
    const frame = JSON.parse(text) as { id?: string; type: string; provider?: string; modelId?: string; level?: string };
    if (!frame.id?.startsWith("cfg-") || this.dropSettings) return; // readiness still needs the explicit helper
    let data: unknown;
    switch (frame.type) {
      case "get_state": data = { model: this.model, thinkingLevel: this.thinking, isStreaming: false, isCompacting: false, pendingMessageCount: 0, ...this.stateOverride }; break;
      case "get_available_models": data = { models: ["one", "two"].map(id => ({ provider: "fixture", id, name: id, input: ["text", "image"] })) }; break;
      case "set_model": this.model = { provider: frame.provider!, id: frame.modelId!, name: frame.modelId!, input: ["text"] }; data = this.model; break;
      case "get_available_thinking_levels": data = { levels: this.levels }; break;
      case "set_thinking_level": this.thinking = this.clampThinking ? "low" : frame.level!; break;
      default: throw new Error(`unexpected fixture control ${frame.type}`);
    }
    const handler = this.handler;
    queueMicrotask(() => handler?.onEvent({ type: "response", id: frame.id, command: frame.type, success: true, data }));
  }

  stop(_h: ProcessHandle, signal: "SIGTERM" | "SIGKILL"): void { this.stopSignals.push(signal); if (this.autoExit) queueMicrotask(() => this.handler?.onExit(null, signal)); }
  readonly stopSignals: string[] = [];
  closeStdin(_h: ProcessHandle): void { /* no-op */ }

  emitEvent(obj: unknown): void { this.handler?.onEvent(obj); }
  emitExit(code: number | null, signal: string | null): void { this.handler?.onExit(code, signal); }
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

const sessions: RpcSession[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.dispose()));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeSession(over: Partial<ConstructorParameters<typeof RpcSession>[0]> = {}, preSidecar?: string) {
  const dir = await mkdtemp(join(tmpdir(), "rpc-model-"));
  dirs.push(dir);
  const host = new FakeRpcHost();
  const sessionFile = join(dir, "s1.pi");
  if (preSidecar !== undefined) await writeFile(`${sessionFile}.model`, preSidecar, "utf8");
  const session = new RpcSession({
    sessionFile,
    journalPath: join(dir, "journal.jsonl"),
    sessionId: "s-model-test",
    host,
    durability: new FileDurability(join(dir, "journal.jsonl")),
    readinessTimeoutMs: 500,
    responseTimeoutMs: 5_000,
    timeoutPollMs: 20,
    audit: () => undefined,
    ...over,
  });
  sessions.push(session);
  return { session, host, dir, sessionFile };
}

/** 探针回执注入（readiness 就绪面；id 必须回显探针帧 id——demux 按 id 对账）。 */
async function readyProbe(host: FakeRpcHost): Promise<void> {
  await until(() => host.frames.some((f) => f.includes('"type":"get_state"')), "探针写出");
  const probeFrame = host.frames.find((f) => f.includes('"type":"get_state"'));
  const probeId = (JSON.parse(probeFrame!) as { id: string }).id;
  host.emitEvent({ id: probeId, type: "response", command: "get_state", success: true });
}

describe("M-OPS 模型选择：spawn 尾追+sidecar+detail", () => {
  it("W-o-s1：send 带 model→spawn 尾追 --model（在 extraPiArgs 之后=恒胜）+sidecar 落盘", async () => {
    const { session, host, sessionFile } = await makeSession({ extraPiArgs: ["--no-extensions"] });
    const p = session.send("hi", undefined, "litellm/glm-5.3");
    await readyProbe(host);
    const r = await p;
    expect(r.kind).toBe("launched");
    // 尾追恒胜：--model 必须是最后一对（extraPiArgs 之后）
    expect(host.spawnArgs[0]).toEqual(["--mode", "rpc", "--session", sessionFile, "--no-extensions", "--model", "litellm/glm-5.3"]);
    expect(await readFile(`${sessionFile}.model`, "utf8")).toBe("litellm/glm-5.3\n");
  });

  it("W-o-s2：构造期 sidecar 恢复——无 model send 冷启动沿用 sidecar 值", async () => {
    const { session, host, sessionFile } = await makeSession({}, "openai-codex/gpt-6-astra\n");
    const p = session.send("hi");
    await readyProbe(host);
    expect((await p).kind).toBe("launched");
    expect(host.spawnArgs[0]).toEqual(["--mode", "rpc", "--session", sessionFile, "--model", "openai-codex/gpt-6-astra"]);
  });

  it("W-o-s3：无 model 无 sidecar→spawn 不带 --model（pi 默认）", async () => {
    const { session, host, sessionFile } = await makeSession();
    const p = session.send("hi");
    await readyProbe(host);
    expect((await p).kind).toBe("launched");
    expect(host.spawnArgs[0]).toEqual(["--mode", "rpc", "--session", sessionFile]);
    expect(host.spawnArgs[0]!.some((a) => a === "--model")).toBe(false);
  });

  it("W-o-s4：sidecar 损坏（超 128）→保守忽略回退 pi 默认", async () => {
    const { session, host, sessionFile } = await makeSession({}, "x".repeat(129));
    const p = session.send("hi");
    await readyProbe(host);
    expect((await p).kind).toBe("launched");
    expect(host.spawnArgs[0]!.some((a) => a === "--model")).toBe(false);
  });

  it("W-o-s5：spawn-failed→not-ready{cause, detail=stderr 尾行 strip 控制字符+≤500}；空缓冲无 detail", async () => {
    // 面 A：有 stderr——spawn 后 writeStdin 前注入（探针读失败路径复杂，直接用 spawn 即抛更稳）
    const a = await makeSession();
    a.host.failSpawn = true;
    const ra = await a.session.send("hi", undefined, "litellm/nonexistent");
    expect(ra).toEqual({ kind: "not-ready", cause: "spawn-failed" }); // spawn 即抛无 stderr 面=无 detail
    // 面 B：detail 净化（readiness-timeout+stderr 尾行；超时→retire 等 SIGTERM 退出确认→补 emitExit）
    const b = await makeSession({ readinessTimeoutMs: 80 });
    b.host.stderrLines = ["正常行", "Error: Model \"bad\" not found. Use --list-models\x1b[31m红\x07"];
    const rbP = b.session.send("hi");
    await until(() => b.host.stopSignals.includes("SIGTERM"), "SIGTERM 已发");
    b.host.emitExit(null, "SIGTERM");
    const rb = await rbP;
    expect(rb.kind).toBe("not-ready");
    expect(rb.cause).toBe("readiness-timeout");
    expect((rb as { detail?: string }).detail).toBe("Error: Model \"bad\" not found. Use --list-models[31m红"); // strip 仅控制符（\x1b/\x07）——[31m 可打印保留
  });

  it("W-o-s6：500 字符截断+多行取尾（环缓冲）", async () => {
    const b = await makeSession({ readinessTimeoutMs: 80 });
    b.host.stderrLines = ["a".repeat(600), "b\x00".repeat(300)]; // 尾行=600 控制符行 strip 后 600>a 行
    const rbP = b.session.send("hi");
    await until(() => b.host.stopSignals.includes("SIGTERM"), "SIGTERM 已发");
    b.host.emitExit(null, "SIGTERM");
    const rb = await rbP;
    expect(rb.kind).toBe("not-ready");
    const detail = (rb as { detail?: string }).detail ?? "";
    expect(detail.length).toBeLessThanOrEqual(500);
    expect(detail.startsWith("b")).toBe(true); // 取尾非空行（b 行 strip \x00 后 300 字符）
    expect(detail).toHaveLength(300);
  });

  it("W-o-s7：换代 spawn 前清 stderrTail——上代残留行不入当代 detail（K3 审 P2-1）", async () => {
    const s = await makeSession();
    s.host.stderrLines = ["gen1 正常运行的 stderr 噪声行"];
    const p1 = s.session.send("hi");
    await readyProbe(s.host); // gen1 就绪（stderr 噪声已入环缓冲）
    const r1 = await p1;
    expect(r1.kind).toBe("launched");
    s.host.emitExit(0, null); // gen1 进程退出→换代（残留行留在 session 级缓冲）
    s.host.failSpawn = true; // 下代 spawn 即抛（无新 stderr）
    const r2 = await s.session.send("again", undefined, "litellm/next");
    // 旧实现：detail="gen1 正常运行的 stderr 噪声行"（陈旧行错归当代）；P2-1 修后：缓冲已清→无 detail
    expect(r2).toEqual({ kind: "not-ready", cause: "spawn-failed" });
  });
});

async function seedAndSettle() {
  const r = await makeSession({ settingsTimeoutMs: 150 });
  const p = r.session.send("first", undefined, "fixture/one"); await readyProbe(r.host); expect((await p).kind).toBe("launched");
  const frame = r.host.frames.map(f => JSON.parse(f) as { id: string; type: string }).find(f => f.type === "prompt")!;
  r.host.emitEvent({ type: "response", id: frame.id, command: "prompt", success: true });
  r.host.emitEvent({ type: "agent_settled" });
  await until(() => (r.session.getState().gate as { kind: string }).kind === "idle", "first settled");
  return r;
}

describe("next-prompt settings: actual RPC before journal and prompt", () => {
  it("warm process switches model and thinking before its next prompt, with confirmed sidecar", async () => {
    const r = await seedAndSettle(); const start = r.host.frames.length;
    expect((await r.session.send("second", 1, "fixture/two", { thinkingLevel: "high" })).kind).toBe("launched");
    const frames = r.host.frames.slice(start).map(f => JSON.parse(f) as { type: string; provider?: string; modelId?: string; level?: string });
    const types = frames.map(f => f.type);
    expect(types.indexOf("set_model")).toBeGreaterThan(-1); expect(types.indexOf("set_thinking_level")).toBeGreaterThan(types.indexOf("set_model")); expect(types.indexOf("prompt")).toBeGreaterThan(types.indexOf("set_thinking_level"));
    expect(frames.find(f => f.type === "set_model")).toMatchObject({ provider: "fixture", modelId: "two" });
    expect(frames.find(f => f.type === "set_thinking_level")).toMatchObject({ level: "high" });
    expect(await readFile(`${r.sessionFile}.model`, "utf8")).toBe("fixture/two\n"); expect(r.host.spawnArgs).toHaveLength(1); expect(r.host.thinking).toBe("high");
  });
  it("busy request never changes parameters, sidecar or stdin", async () => {
    const r = await seedAndSettle(); expect((await r.session.send("active", 1)).kind).toBe("launched"); const count = r.host.frames.length;
    expect(await r.session.send("blocked", 1, "fixture/two", { thinkingLevel: "high" })).toEqual({ kind: "busy" });
    expect(r.host.frames).toHaveLength(count); expect(await readFile(`${r.sessionFile}.model`, "utf8")).toBe("fixture/one\n");
  });
  it("stale generation performs no control writes or preference changes", async () => {
    const r = await seedAndSettle(); const count = r.host.frames.length;
    expect(await r.session.send("stale", 999, "fixture/two", { thinkingLevel: "high" })).toEqual({ kind: "invalidated", stage: "first-byte" });
    expect(r.host.frames).toHaveLength(count); expect(await readFile(`${r.sessionFile}.model`, "utf8")).toBe("fixture/one\n");
  });
  it.each(["streaming", "compacting", "queued", "missing-fact"])("pi %s state is not idle; no mutation or user intent", async busy => {
    const r = await seedAndSettle(); const start = r.host.frames.length; const before = await readFile(join(r.dir, "journal.jsonl"), "utf8"); r.host.autoExit = true;
    r.host.stateOverride = busy === "streaming" ? { isStreaming: true } : busy === "compacting" ? { isCompacting: true } : busy === "queued" ? { pendingMessageCount: 1 } : { isStreaming: undefined };
    expect((await r.session.send("blocked", 1, "fixture/two")).kind).toBe("not-ready");
    const types = r.host.frames.slice(start).map(f => (JSON.parse(f) as { type: string }).type); expect(types).not.toContain("set_model"); expect(types).not.toContain("prompt");
    expect(await readFile(join(r.dir, "journal.jsonl"), "utf8")).toBe(before); expect(await readFile(`${r.sessionFile}.model`, "utf8")).toBe("fixture/one\n");
  });
  it("unsupported target model preserves journal and preference", async () => {
    const r = await seedAndSettle(); const start = r.host.frames.length;
    expect(await r.session.send("bad", 1, "fixture/unknown")).toMatchObject({ kind: "not-ready", cause: "settings-rejected" });
    const types = r.host.frames.slice(start).map(f => (JSON.parse(f) as { type: string }).type); expect(types).not.toContain("set_model"); expect(types).not.toContain("prompt"); expect(await readFile(`${r.sessionFile}.model`, "utf8")).toBe("fixture/one\n");
  });
  it("unsupported thinking after model switch retires partial configuration, never sends or overwrites sidecar", async () => {
    const r = await seedAndSettle(); r.host.autoExit = true; const start = r.host.frames.length; const before = await readFile(join(r.dir, "journal.jsonl"), "utf8");
    expect(await r.session.send("bad", 1, "fixture/two", { thinkingLevel: "max" })).toMatchObject({ kind: "not-ready", cause: "settings-rejected" });
    const types = r.host.frames.slice(start).map(f => (JSON.parse(f) as { type: string }).type); expect(types).toContain("set_model"); expect(types).not.toContain("set_thinking_level"); expect(types).not.toContain("prompt"); expect(r.host.stopSignals).toEqual(["SIGTERM"]);
    expect(await readFile(join(r.dir, "journal.jsonl"), "utf8")).toBe(before); expect(await readFile(`${r.sessionFile}.model`, "utf8")).toBe("fixture/one\n");
  });
  it("SDK success with clamped thinking is not a parameter confirmation", async () => {
    const r = await seedAndSettle(); r.host.clampThinking = true; r.host.autoExit = true; const start = r.host.frames.length;
    expect(await r.session.send("bad", 1, undefined, { thinkingLevel: "high" })).toMatchObject({ kind: "not-ready", cause: "settings-rejected" });
    expect(r.host.frames.slice(start).some(f => (JSON.parse(f) as { type: string }).type === "prompt")).toBe(false); expect(r.host.stopSignals).toEqual(["SIGTERM"]);
  });
  it("timeout cannot write a user intent and retires only the timed-out generation", async () => {
    const r = await seedAndSettle(); r.host.dropSettings = true; r.host.autoExit = true; const before = await readFile(join(r.dir, "journal.jsonl"), "utf8"); const start = r.host.frames.length;
    expect(await r.session.send("bad", 1, "fixture/two")).toMatchObject({ kind: "not-ready", cause: "settings-timeout" });
    expect(r.host.frames.slice(start).some(f => (JSON.parse(f) as { type: string }).type === "prompt")).toBe(false); expect(await readFile(join(r.dir, "journal.jsonl"), "utf8")).toBe(before); expect(r.host.stopSignals).toEqual(["SIGTERM"]);
  });
  it("stop during preparation cancels it; another concurrent send performs zero extra writes", async () => {
    const r = await seedAndSettle(); r.host.dropSettings = true; r.host.autoExit = true; const start = r.host.frames.length;
    const p = r.session.send("aborted", 1, "fixture/two"); await until(() => r.host.frames.length > start, "configuration frame"); const count = r.host.frames.length;
    expect(await r.session.send("parallel", 1, "fixture/one")).toEqual({ kind: "busy" }); expect(r.host.frames).toHaveLength(count);
    await r.session.stop(); expect(await p).toMatchObject({ kind: "not-ready", cause: "settings-stale" }); expect(r.host.frames.slice(start).some(f => (JSON.parse(f) as { type: string }).type === "prompt")).toBe(false); expect(r.host.stopSignals).toEqual(["SIGTERM"]);
  });
});
