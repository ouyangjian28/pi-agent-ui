// D3-T1（设计稿 §7 承诺 E2E 腿，尾债清偿）：
//  Leg A（常跑，无 LLM）：受控 FakeRpcHost 注入缝（write.host）→ 生产 composition 全链
//    E-ui-1 问答往返：extension_ui_request → ui-request 帧 → ui-answer → extension_ui_response 落 stdin
//           → answered 撤框广播 + spawn 参数基底/追加项完整
//    E-ui-2 断开腿：末订阅者断开 → pending 问答 cancelled 落 stdin（pi 侧不悬挂）
//    E-ui-3 退役腿：stop → 代次终结 → pending 问答 cancelled 落 stdin + 订阅者收 ui-closed(process-retired)
//  Leg B（PI_E2E=1 才跑，真调一轮 LLM）：真 pi + fixture 扩展（--no-extensions -e ...）
//    E-ui-4 真消费者：before_agent_start 弹 select → 全链往返 → notify 回执 ui-note 帧 → stop 收口
// 与单元测试分工：W-ui-s*（会话面）/W-ui-g*（网关面）已分层证；本文件证 composition 接线
// （registry 三回调+uiSink 晚绑定+uiHost.answer 适配）端到端不断链。
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startServer, type PiAgentUiServer } from "../../apps/server/src/composition.ts";
import type { ProcessHandle, ProcessHostPort, ProcessSpawnHandlers } from "@pi-agent-ui/protocol";

const RUN_REAL = process.env.PI_E2E === "1";
const PI_BIN = "/home/yyj/.nvm/versions/node/v24.18.0/bin/pi";
const PI_VERSION = "0.0.0"; // 管道面不锁版本（同 d1-live-e2e 口径）
const ORIGIN = "http://localhost:5173";
const until = async (pred: () => boolean, what: string, ms = 10_000): Promise<void> => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

interface Frame {
  t?: string; requestId?: string; file?: string; reason?: string; method?: string; options?: string[];
  timeoutMs?: number; outcome?: { kind?: string; exit?: number }; kind?: string; message?: string;
  origin?: string; events?: Array<{ kind?: string; message?: string }>; [k: string]: unknown;
}

/** 受控 pi 进程宿主：auto-回 readiness 探针；测试用 emitEvent 注入进程输出、frames 断言 stdin。
 *  stop() 同步 emitExit(0)=干净退出（write-stop-ack confirmed 需要真退出证据）。 */
class FakeRpcHost implements ProcessHostPort {
  readonly frames: string[] = [];
  readonly spawnArgs: string[][] = [];
  private handler: ProcessSpawnHandlers | null = null;
  spawn(args: readonly string[], h: ProcessSpawnHandlers): ProcessHandle {
    this.spawnArgs.push([...args]);
    this.handler = h;
    return { id: `fake-${this.spawnArgs.length}` };
  }
  async writeStdin(_h: ProcessHandle, text: string): Promise<void> {
    this.frames.push(text);
    const obj = JSON.parse(text) as { id?: string; type?: string };
    if (obj.type === "get_state" && obj.id !== undefined && obj.id.startsWith("ready-")) {
      this.emitEvent({ id: obj.id, type: "response", command: "get_state", success: true });
    }
  }
  stop(): void { this.emitExit(0, null); }
  closeStdin(): void { /* noop */ }
  emitEvent(obj: unknown): void { this.handler?.onEvent(obj); }
  emitExit(code: number | null, signal: string | null): void { this.handler?.onExit(code, signal); }
  /** stdin 中的 extension_ui_response 行（解析后）。 */
  uiResponses(): Array<Record<string, unknown>> {
    return this.frames
      .filter((f) => f.includes("extension_ui_response"))
      .map((f) => JSON.parse(f) as Record<string, unknown>);
  }
}

/** 真响应序（探针 auto）：命令 response → agent_settled。 */
function settleTurn(h: FakeRpcHost): void {
  const promptFrame = [...h.frames].reverse().find((f) => (JSON.parse(f) as { type?: string }).type === "prompt");
  if (promptFrame === undefined) throw new Error("settleTurn：未见 prompt 帧");
  const { id } = JSON.parse(promptFrame) as { id: string };
  h.emitEvent({ id, type: "response", command: "prompt", success: true });
  h.emitEvent({ type: "agent_settled" });
}

describe("D3-T1 E2E Leg A：FakeRpcHost composition 全链（常跑）", () => {
  let dir = "";
  const audits: string[] = [];
  let server: PiAgentUiServer | null = null;
  let host: FakeRpcHost | null = null;
  let ws: WebSocket | null = null;
  const frames: Frame[] = [];
  const FILE = "ui-e2e.jsonl";
  const EXTRA = ["--no-extensions", "-e", "/nonexistent-e2e-marker.mjs"]; // 追加项证据（语义 Fake 不消费）
  let sessionFile = "";

  async function connect(): Promise<void> {
    const mark = frames.length; // 每连接独立等 snapshot（旧连接帧不算——重连腿竞态）
    ws = new WebSocket(`ws://127.0.0.1:${server!.port}`, { origin: ORIGIN });
    await new Promise<void>((res, rej) => { ws!.on("open", res); ws!.on("error", (e) => rej(e as Error)); });
    ws.on("message", (data) => frames.push(JSON.parse(String(data))));
    ws.send(JSON.stringify({ t: "hello", protocolVersion: 1, token: "tok-d3t1" }));
    await until(() => frames.slice(mark).some((f) => f.t === "welcome"), "welcome");
    ws.send(JSON.stringify({ t: "subscribe", requestId: `sub-${mark}`, file: FILE }));
    await until(() => frames.slice(mark).some((f) => f.t === "snapshot"), "snapshot");
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "d3t1-e2e-"));
    await mkdir(join(dir, "sessions"), { recursive: true });
    sessionFile = join(dir, "sessions", "ui-e2e.session");
    const tokenFile = join(dir, "tokens.json");
    await writeFile(tokenFile, JSON.stringify({ version: 1, tokens: ["tok-d3t1"] }), "utf8");
    await chmod(tokenFile, 0o600);
    // 订阅面合规首行（writer 声明；guarded writer 后续在其上宣誓）
    await writeFile(join(dir, FILE), JSON.stringify({ t: "writer", epoch: 1, bootId: "d3t1-e2e-boot", at: new Date().toISOString() }) + "\n", "utf8");
    host = new FakeRpcHost();
    server = await startServer({
      tokenFile,
      allowedOrigins: [ORIGIN],
      roots: [dir],
      scanDir: dir,
      tokenPollMs: 0,
      write: {
        sessionFor: () => sessionFile,
        host, // 受控替身注入缝（与 piBin 互斥）
        extraPiArgs: EXTRA,
        responseTimeoutMs: 60_000,
        turnTimeoutMs: 120_000,
        readinessTimeoutMs: 5_000,
      },
      audit: (l) => audits.push(l),
      trustFirstRecoveryCapture: true,
    });
    await connect();
  });
  afterAll(async () => {
    try { ws?.close(); } catch { /* 已关 */ }
    await server?.dispose().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  it("E-ui-0 配置门：write.host 与 piBin 同供=拒启（受控替身注入缝仅限测试）", async () => {
    const dir2 = await mkdtemp(join(tmpdir(), "d3t1-mutex-"));
    const tokenFile = join(dir2, "tokens.json");
    await writeFile(tokenFile, JSON.stringify({ version: 1, tokens: ["t"] }), "utf8");
    await expect(startServer({
      tokenFile, allowedOrigins: [ORIGIN], roots: [dir2], scanDir: dir2, tokenPollMs: 0,
      write: { sessionFor: (f) => f, host: new FakeRpcHost(), piBin: "/usr/bin/true" },
      audit: () => {},
    })).rejects.toThrow("互斥");
    await rm(dir2, { recursive: true, force: true });
  });

  it("E-ui-1 问答往返：ui-request 帧到达→ui-answer→extension_ui_response 落 stdin+answered 撤框", async () => {
    ws!.send(JSON.stringify({ t: "prompt", requestId: "eui1", file: FILE, text: "e2e 首轮（受控）" }));
    await until(() => frames.some((f) => f.t === "write-ack" && f.requestId === "eui1" && f.outcome?.kind === "launched"), "write-ack launched");
    // 轮内扩展问答（贴近 permission-gate 场景）
    host!.emitEvent({ type: "extension_ui_request", id: "q-e2e-1", method: "select", title: "E2E 选一个", options: ["甲", "乙"], timeout: 60_000 });
    await until(() => frames.some((f) => f.t === "ui-request" && f.requestId === "q-e2e-1"), "ui-request 帧");
    const req = frames.find((f) => f.t === "ui-request" && f.requestId === "q-e2e-1")!;
    expect(req.method).toBe("select");
    expect(req.options).toEqual(["甲", "乙"]);
    expect(req.timeoutMs).toBe(60_000);
    expect(req.file).toBe(FILE);
    ws!.send(JSON.stringify({ t: "ui-answer", requestId: "q-e2e-1", value: "乙" }));
    await until(() => host!.uiResponses().some((r) => r.id === "q-e2e-1" && r.value === "乙"), "extension_ui_response 落 stdin");
    await until(() => frames.some((f) => f.t === "ui-closed" && f.requestId === "q-e2e-1" && f.reason === "answered"), "answered 撤框广播");
    settleTurn(host!); // 轮收口（暖进程驻留）
    await until(() => frames.some((f) => f.t === "write-ack" && f.requestId === "eui1"), "write-ack 存在");
  });

  it("E-ui-2 断开腿：末订阅者断开→pending 问答 cancelled 落 stdin（pi 侧不悬挂）", async () => {
    host!.emitEvent({ type: "extension_ui_request", id: "q-e2e-2", method: "confirm", title: "断开腿", message: "还挂着吗" });
    await until(() => frames.some((f) => f.t === "ui-request" && f.requestId === "q-e2e-2"), "ui-request 帧");
    ws!.close(); // 真传输断开→末订阅者释放→pending 全 cancelled
    await until(() => host!.uiResponses().some((r) => r.id === "q-e2e-2" && r.cancelled === true), "cancelled 落 stdin");
    expect(host!.uiResponses().filter((r) => r.id === "q-e2e-2").length).toBe(1); // 恰一次
  });

  it("E-ui-3 退役腿：stop→pending cancelled 落 stdin+订阅者收 ui-closed(process-retired)+stop 收口", async () => {
    await connect(); // 重连重订阅（Leg A 内唯一订阅者，恢复 refs）
    host!.emitEvent({ type: "extension_ui_request", id: "q-e2e-3", method: "input", title: "退役腿", placeholder: "输入" });
    await until(() => frames.some((f) => f.t === "ui-request" && f.requestId === "q-e2e-3"), "ui-request 帧");
    ws!.send(JSON.stringify({ t: "stop", requestId: "eui3-stop", file: FILE }));
    await until(() => frames.some((f) => f.t === "write-stop-ack" && f.requestId === "eui3-stop" && f.outcome?.kind === "confirmed"), "write-stop-ack confirmed");
    // 设计语义（closeUiForGeneration）：换代不写死进程 stdin——撤框只走宿主广播；
    // 故断言 stdin 零 ui-response（q-e2e-3）+订阅者收 ui-closed(process-retired)。
    await until(() => frames.some((f) => f.t === "ui-closed" && f.requestId === "q-e2e-3" && f.reason === "process-retired"), "ui-closed(process-retired)");
    expect(host!.uiResponses().some((r) => r.id === "q-e2e-3")).toBe(false); // 不写死进程 stdin（设计不变量）
  });

  it("E-ui-1 附带：spawn 参数=基底（--mode rpc --session）+extraPiArgs 尾部追加完整", () => {
    expect(host!.spawnArgs.length).toBe(1); // 全程单进程（暖驻留，Leg A 不换代）
    const args = host!.spawnArgs[0]!;
    expect(args.slice(0, 4)).toEqual(["--mode", "rpc", "--session", sessionFile]);
    expect(args.slice(4)).toEqual(EXTRA);
  });
});

describe.skipIf(!RUN_REAL)("D3-T1 E2E Leg B：真 pi+fixture 扩展问答全链（PI_E2E=1）", () => {
  let dir = "";
  const audits: string[] = [];
  let server: PiAgentUiServer | null = null;
  let ws: WebSocket | null = null;
  const frames: Frame[] = [];
  const FILE = "ui-real.jsonl";

  beforeAll(async () => {
    const v = spawnSync(PI_BIN, ["--version"], { encoding: "utf8" });
    if (v.status !== 0) throw new Error(`pi 二进制不可用：${v.stderr}`);
    if (PI_VERSION !== "0.0.0" && v.stdout.trim() !== PI_VERSION) throw new Error(`pi 版本漂移：期望 ${PI_VERSION}`);
    dir = await mkdtemp(join(tmpdir(), "d3t1-real-"));
    await mkdir(join(dir, "sessions"), { recursive: true });
    const tokenFile = join(dir, "tokens.json");
    await writeFile(tokenFile, JSON.stringify({ version: 1, tokens: ["tok-d3t1r"] }), "utf8");
    await chmod(tokenFile, 0o600);
    await writeFile(join(dir, FILE), JSON.stringify({ t: "writer", epoch: 1, bootId: "d3t1-real-boot", at: new Date().toISOString() }) + "\n", "utf8");
    server = await startServer({
      tokenFile,
      allowedOrigins: [ORIGIN],
      roots: [dir],
      scanDir: dir,
      tokenPollMs: 0,
      write: {
        sessionFor: (f) => join(dir, "sessions", `${String(f).split("/").pop()}.session`),
        piBin: PI_BIN,
        extraPiArgs: ["--no-extensions", "-e", join(process.cwd(), "tests/fixtures/e2e-ui-extension.mjs")],
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
    ws.send(JSON.stringify({ t: "hello", protocolVersion: 1, token: "tok-d3t1r" }));
    await until(() => frames.some((f) => f.t === "welcome"), "welcome", 30_000);
    ws.send(JSON.stringify({ t: "subscribe", requestId: "sub-b", file: FILE }));
    await until(() => frames.some((f) => f.t === "snapshot"), "snapshot", 30_000);
  });
  afterAll(async () => {
    try { ws?.close(); } catch { /* 已关 */ }
    await server?.dispose().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  it("E-ui-4 真消费者全链：before_agent_start 弹 select→答题→notify 回执 ui-note→stop 收口", { timeout: 180_000 }, async () => {
    ws!.send(JSON.stringify({ t: "prompt", requestId: "eui4", file: FILE, text: "说 ok 即可" }));
    await until(() => frames.some((f) => f.t === "write-ack" && f.requestId === "eui4" && f.outcome?.kind === "launched"), "write-ack launched", 60_000);
    // 扩展在轮内弹问答
    await until(() => frames.some((f) => f.t === "ui-request" && f.method === "select"), "ui-request 帧", 60_000);
    const req = frames.find((f) => f.t === "ui-request" && f.method === "select")!;
    expect((req.options ?? []).join(",")).toContain("甲");
    ws!.send(JSON.stringify({ t: "ui-answer", requestId: req.requestId!, value: "乙" }));
    // 扩展收到答案→notify 回执→ui-note 帧（真 pi 侧 extension_ui_response→select resolve→notify）
    await until(() => frames.some((f) => f.t === "events" && (f as { origin?: string }).origin === "live"
      && Array.isArray(f.events) && f.events.some((e) => e.kind === "ui-note" && String(e.message).includes("e2e-ui-answered:乙"))),
      "ui-note 回执（答案真达扩展）", 90_000);
    ws!.send(JSON.stringify({ t: "stop", requestId: "eui4-stop", file: FILE }));
    await until(() => frames.some((f) => f.t === "write-stop-ack" && f.requestId === "eui4-stop"), "write-stop-ack", 60_000);
  });
});
