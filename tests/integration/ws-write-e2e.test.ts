// 3c-3：真进程写/停端到端（第19d轮 GO 放行范围；第20轮 F1/F2 修复版）。
// 守卫：默认 skip（真调 LLM）；显式跑=PI_E2E=1 npx vitest run tests/integration/ws-write-e2e.test.ts。
// 链=composition(write)→gateway→RpcWriteHost→session-registry→RpcSession→PiProcessHost→真 pi 0.86.1。
// journal 行=结构化 JSONL（t∈enqueue/sending/engaged/consumed/cancelled/delivered/settled，带 intentId；
// enqueue 另带 generation——冷启动代次证据）。逐行解析断言，不做 substring 冒充。
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, writeFile, readFile } from "node:fs/promises";
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

interface Frame { t?: string; requestId?: string; outcome?: { kind: string; intentId?: string; exit?: number }; [k: string]: unknown }
interface JLine { t?: string; intentId?: string; generation?: number; [k: string]: unknown }

const d = describe.skipIf(!RUN)("3c-3 真进程写/停 E2E", () => {
  let dir = "";
  let server: PiAgentUiServer | null = null;
  const audits: string[] = [];
  let ws: WebSocket | null = null;
  const frames: Frame[] = [];
  // 跨测试共享的轮次事实（E1 写、E2/E3 读）：journal 行解析后按 intentId 建档
  const turns = new Map<string, { enqueue: number; sending: number; settled: number; generation: number }>();

  beforeAll(async () => {
    const v = spawnSync(PI_BIN, ["--version"], { encoding: "utf8" });
    if (v.status !== 0 || v.stdout.trim() !== PI_VERSION) { // 精确版本相等（20轮尾项：锁死=全等非 includes）
      throw new Error(`pi 版本漂移：期望 ${PI_VERSION}，status=${v.status}，stdout=${JSON.stringify(v.stdout)}`);
    }
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
  /** 解析 journal（文件名）为结构化行；坏行原样标 t="<corrupt>"。 */
  async function readJournal(file: string): Promise<JLine[]> {
    try {
      const raw = (await readFile(join(dir, file), "utf8")).split("\n").filter((l) => l.length > 0);
      return raw.map((l) => { try { return JSON.parse(l) as JLine; } catch { return { t: "<corrupt>" }; } });
    } catch { return []; }
  }
  /** 等待某轮三行齐并记录索引/代次（硬序断言在各 it 内）。 */
  async function awaitTurn(file: string, intentId: string, what: string, timeoutMs = 150_000): Promise<void> {
    await until(async () => {
      const ls = await readJournal(file);
      const enq = ls.findIndex((l) => l.t === "enqueue" && l.intentId === intentId);
      const send = ls.findIndex((l) => l.t === "sending" && l.intentId === intentId);
      const set = ls.findIndex((l) => l.t === "settled" && l.intentId === intentId);
      if (enq >= 0 && send >= 0 && set >= 0) {
        turns.set(intentId, { enqueue: enq, sending: send, settled: set, generation: Number(ls[enq].generation) });
        return true;
      }
      return false;
    }, what, timeoutMs);
  }

  it("E1 基本写回路：prompt→launched→本轮三行硬序落盘（enqueue→sending→settled 同 intentId 索引递增）", { timeout: 180_000 }, async () => {
    send({ t: "prompt", requestId: "e1", file: "s1.jsonl", text: "只回复两个字：收到" });
    const ack = await next("write-ack", (f) => f.requestId === "e1");
    expect(ack.outcome!.kind).toBe("launched");
    const intentId = ack.outcome!.intentId!;
    expect(typeof intentId).toBe("string");
    await awaitTurn("s1.jsonl", intentId, "E1 三行齐");
    const tr = turns.get(intentId)!;
    expect(tr.enqueue).toBeLessThan(tr.sending);
    expect(tr.sending).toBeLessThan(tr.settled); // 三写硬序：结构化行索引断言
  });

  it("E2 stop：settled 后暖进程驻留→stop 驱动退役→confirmed.exit={code,signal} 形状+该 stop 的真进程退出证据", { timeout: 60_000 }, async () => {
    const lsBefore = (await readJournal("s1.jsonl")).length;
    send({ t: "stop", requestId: "e2", file: "s1.jsonl" });
    const ack = await next("write-stop-ack", (f) => f.requestId === "e2");
    const kind = ack.outcome!.kind;
    if (kind === "confirmed") {
      const exit = (ack.outcome as { exit: { code: number | null; signal: string | null } }).exit;
      expect(exit !== null && typeof exit === "object").toBe(true); // 形状断言（20轮尾项）：exit={code,signal}
      expect(exit.code !== null || exit.signal !== null).toBe(true); // 真进程退出证据二选一在场
    } else {
      expect(kind).toBe("no-process");
    }
    // 退役链真退出证据：stop handle=X 之后有同 X 的 exit 行
    await until(() => {
      const stopIdx = audits.map((l) => l.includes("stop handle=") ? l : "").filter(Boolean).length;
      return stopIdx > 0 && audits.some((l) => l.includes("exit handle="));
    }, "stop→exit 证据", 30_000);
    const stopLine = audits.filter((l) => l.includes("stop handle=")).pop()!;
    const handle = /stop handle=([\w.-]+)/.exec(stopLine)![1];
    expect(audits.some((l) => l.includes(`exit handle=${handle}`))).toBe(true);
    void lsBefore;
  });

  it("E3 退役后冷启动：同会话文件新轮次独有终态（journal 边界+新 intentId+enqueue 代次严格递增）", { timeout: 180_000 }, async () => {
    const before = await readJournal("s1.jsonl"); // 边界：E1/E2 已有行
    const gen1 = [...turns.values()][0]?.generation ?? -1; // E1 轮代次
    send({ t: "prompt", requestId: "e3", file: "s1.jsonl", text: "我上一句让你回复什么？只答那两个字" });
    const ack = await next("write-ack", (f) => f.requestId === "e3");
    expect(ack.outcome!.kind).toBe("launched");
    const id2 = ack.outcome!.intentId!;
    await awaitTurn("s1.jsonl", id2, "E3 三行齐");
    const tr2 = turns.get(id2)!;
    // 新轮次三行全部落在边界之后（E1 旧行不能满足）
    expect(tr2.enqueue).toBeGreaterThanOrEqual(before.length);
    expect(tr2.settled).toBeGreaterThanOrEqual(before.length);
    // 冷启动代次：E2 已退役（confirmed+exit 证据），E3 必须新进程新代次
    expect(tr2.generation).toBeGreaterThan(gen1);
    // 恢复面（结构性证据，诚实口径）：同文件追加+代次连续计数=会话在退役后从同一 journal 继续；
    // 回答文本不在本仓 journal（pi 转录另存），不断言自然语言内容——TECH B17 已注明。
  });

  it("E4 在飞销毁：launched+sending 检查点后 dispose→目标进程退出证据+审计序 stop<exit<registry<composition", { timeout: 90_000 }, async () => {
    send({ t: "prompt", requestId: "e4", file: "s2.jsonl", text: "数到一百再停" });
    const ack = await next("write-ack", (f) => f.requestId === "e4");
    expect(ack.outcome!.kind).toBe("launched"); // 只认 launched 作在飞起点（20轮F2）
    const id4 = ack.outcome!.intentId!;
    // 在飞检查点：s2 journal 已出现该轮 sending 行（轮次真在执行，非仅受理）
    await until(async () => (await readJournal("s2.jsonl")).some((l) => l.t === "sending" && l.intentId === id4), "s2 在飞 sending", 60_000);
    const t0 = Date.now();
    await server!.dispose();
    expect(Date.now() - t0).toBeLessThan(30_000);
    server = null; // afterAll 不再重复 dispose
    // 审计序：stop handle=X → exit handle=X → session-registry disposed → composition disposed
    const stopLine = audits.filter((l) => l.includes("stop handle=")).pop()!;
    const handle = /stop handle=([\w.-]+)/.exec(stopLine)![1];
    const iStop = audits.indexOf(stopLine);
    const iExit = audits.findIndex((l) => l.includes(`exit handle=${handle}`) && audits.indexOf(l) > iStop);
    const iReg = audits.findIndex((l) => l.includes("session-registry disposed"));
    const iComp = audits.findIndex((l) => l.includes("composition disposed"));
    expect(iExit).toBeGreaterThan(iStop); // 目标进程（本轮 stop 的句柄）退出证据
    expect(iReg).toBeGreaterThan(iExit);
    expect(iComp).toBeGreaterThan(iReg);
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
