// 3c-3：真进程写/停端到端（第19d轮 GO 放行范围；第20轮 F1/F2+第20b轮 B1/B2 修复版）。
// 守卫：默认 skip（真调 LLM）；显式跑=PI_E2E=1 npx vitest run tests/integration/ws-write-e2e.test.ts。
// 链=composition(write)→gateway→RpcWriteHost→session-registry→RpcSession→PiProcessHost→真 pi 0.86.1。
// journal 行=结构化 JSONL（t∈enqueue/sending/engaged/consumed/cancelled/delivered/settled，带 intentId；
// enqueue 另带 generation——冷启动代次证据）。逐行解析断言，不做 substring 冒充。
// 20b B2：E4 在飞=onSpawned 身份（spawn 时记录）+snapshot 判活（sending 已现且 settled 未现）+
// 窗口处理（dispose 后 settled 出现=检查后完成→换文件重试，含 server 重启）；销毁链=绑定 handle 的
// token 级索引比较（tests/helpers/e2e-evidence.ts，负例在 e2e-evidence-helpers.test.ts）。
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, writeFile, readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startServer, type PiAgentUiServer } from "../../apps/server/src/composition.ts";
import { assertExitShape, disposeChain, findSpawnFor, inFlightAt, type SpawnRecord } from "../../tests/helpers/e2e-evidence.js";

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
  // 20b B2：onSpawned 观测面——spawn 时即记录 (journal 绝对路径, handle, generation) 身份，E4 不事后反推
  const spawns: SpawnRecord[] = [];
  // 跨测试共享的轮次事实（E1 写、E2/E3 读）：journal 行解析后按 intentId 建档
  const turns = new Map<string, { enqueue: number; sending: number; settled: number; generation: number }>();

  async function startAndConnect(): Promise<void> {
    server = await startServer({
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
        onSpawned: (file, handle, generation) => { spawns.push({ file, id: handle.id, generation }); },
      },
      audit: (l) => audits.push(l),
    });
    ws = new WebSocket(`ws://127.0.0.1:${server.port}`, { origin: ORIGIN });
    await new Promise<void>((res, rej) => { ws!.on("open", res); ws!.on("error", (e) => rej(e as Error)); });
    ws.on("message", (data) => frames.push(JSON.parse(String(data))));
    ws.send(JSON.stringify({ t: "hello", protocolVersion: 1, token: TOKEN }));
    await until(() => frames.some((f) => f.t === "welcome"), "welcome");
  }

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
    await startAndConnect();
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

  it("E2 stop：settled 后暖进程驻留→stop 驱动退役→confirmed.exit 形状严格校验+该 stop 的真进程退出证据（绑定 handle）", { timeout: 60_000 }, async () => {
    const a0 = audits.length; // 审计边界（20b 尾项）：本用例只认边界后的 stop/exit 证据
    send({ t: "stop", requestId: "e2", file: "s1.jsonl" });
    const ack = await next("write-stop-ack", (f) => f.requestId === "e2");
    const kind = ack.outcome!.kind;
    if (kind === "confirmed") {
      assertExitShape((ack.outcome as { exit: unknown }).exit); // 形状严格校验（{}/[]/缺字段拒收，负例见 H15-N3）
    } else {
      // no-process（进程已被闲置回收）：诚实口径——边界后不得出现任何 stop 行（无进程可停不伪造）
      expect(kind).toBe("no-process");
      expect(audits.slice(a0).some((l) => l.startsWith("stop handle="))).toBe(false);
      return;
    }
    // 退役链真退出证据：边界后 stop handle=X 之后有同 X 的 exit 行（绑定 handle 的索引比较，非最后一条反推）
    await until(() => {
      const stop = audits.slice(a0).find((l) => l.startsWith("stop handle="));
      if (stop === undefined) return false;
      const handle = /stop handle=([\w.-]+)/.exec(stop)![1];
      return audits.slice(a0).some((l) => l.startsWith(`exit handle=${handle} `) || l === `exit handle=${handle}`);
    }, "stop→exit 证据", 30_000);
    const stop = audits.slice(a0).find((l) => l.startsWith("stop handle="))!;
    const handle = /stop handle=([\w.-]+)/.exec(stop)![1];
    const iStop = audits.indexOf(stop);
    const iExit = audits.findIndex((l, i) => i > iStop && (l.startsWith(`exit handle=${handle} `) || l === `exit handle=${handle}`));
    expect(iExit).toBeGreaterThan(iStop); // 同 handle 索引硬序
  });

  it("E3 退役后冷启动：同会话文件新轮次独有终态（journal 续写+新 intentId+enqueue 代次严格递增，显式断言）", { timeout: 180_000 }, async () => {
    const before = await readJournal("s1.jsonl"); // 边界：E1/E2 已有行
    const id1 = [...turns.keys()].find((k) => turns.get(k)!.generation >= 1) ?? [...turns.keys()][0];
    const gen1 = turns.get(id1)?.generation ?? -1; // E1 轮代次
    send({ t: "prompt", requestId: "e3", file: "s1.jsonl", text: "我上一句让你回复什么？只答那两个字" });
    const ack = await next("write-ack", (f) => f.requestId === "e3");
    expect(ack.outcome!.kind).toBe("launched");
    const id2 = ack.outcome!.intentId!;
    expect(id2).not.toBe(id1); // 显式：新轮次独有 intentId（非复用旧轮）
    expect(typeof id2).toBe("string");
    await awaitTurn("s1.jsonl", id2, "E3 三行齐");
    const tr2 = turns.get(id2)!;
    // 新轮次三行全部落在边界之后（E1/E2 旧行不能满足；含 sending——20b 尾项显式化）
    expect(tr2.enqueue).toBeGreaterThanOrEqual(before.length);
    expect(tr2.sending).toBeGreaterThanOrEqual(before.length);
    expect(tr2.settled).toBeGreaterThanOrEqual(before.length);
    expect(tr2.enqueue).toBeLessThan(tr2.sending);
    expect(tr2.sending).toBeLessThan(tr2.settled);
    // 冷启动代次：E2 已退役（confirmed+exit 证据），E3 必须新进程新代次（安全整数+严格递增）
    expect(Number.isSafeInteger(tr2.generation)).toBe(true);
    expect(tr2.generation).toBeGreaterThan(gen1);
    // 恢复面（结构性证据，诚实口径）：同文件追加+代次递增=会话在退役后从同一 journal 续写+冷启动新进程；
    // 回答文本不在本仓 journal（pi 转录另存），不断言自然语言内容——TECH B17 已注明。
  });

  it("E4 在飞销毁（20b B2 重写）：真在飞检查点+onSpawned 身份绑定+窗口重试→目标进程退出证据+审计序 stop<exit<registry<composition", { timeout: 240_000 }, async () => {
    // 长生成指令：把轮次在飞窗口拉长到秒级，让 snapshot→dispose 的毫秒级窗口不至于常命中
    const LONG = "请写一首十六行的诗（每行至少十字），写完后再逐行用一句话点评。";
    const files = ["s2.jsonl", "s2b.jsonl", "s2c.jsonl"];
    let killed = false;
    let missReason = "";
    for (let n = 0; n < files.length && !killed; n += 1) {
      const f = files[n];
      const rid = `e4-${n}`;
      if (server === null) await startAndConnect(); // 窗口重试后重启（前一 server 已 dispose）
      send({ t: "prompt", requestId: rid, file: f, text: LONG });
      const ack = await next("write-ack", (fr) => fr.requestId === rid);
      expect(ack.outcome!.kind).toBe("launched");
      const id = ack.outcome!.intentId!;
      // 身份：spawn 时即记录（onSpawned 观测面），不靠事后审计反推
      const absF = join(dir, f);
      await until(() => spawns.some((sp) => sp.file === absF), `onSpawned ${f}`);
      const rec = findSpawnFor(spawns, absF);
      expect(rec.generation).toBeGreaterThanOrEqual(1);
      // 在飞检查点：sending 已现（轮次真在执行，非仅受理）
      await until(async () => (await readJournal(f)).some((l) => l.t === "sending" && l.intentId === id), `${f} 在飞 sending`, 60_000);
      const snap = await readJournal(f); // 真在飞快照：settled 未现（历史 sending 行不冒充当前运行态）
      if (!inFlightAt(snap, id)) { missReason = `snapshot 已收口（attempt=${n}）`; continue; }
      const a0 = audits.length;
      const t0 = Date.now();
      await server!.dispose();
      server = null; // afterAll 不再重复 dispose
      expect(Date.now() - t0).toBeLessThan(30_000);
      // 窗口处理：检查后、调用前完成→journal 出现该轮 settled 行=本轮不算在飞击杀→重试
      const post = await readJournal(f);
      if (post.some((l) => l.t === "settled" && l.intentId === id)) {
        missReason = `窗口内收口（attempt=${n}：snapshot 无 settled，dispose 后出现）`;
        continue;
      }
      // 销毁链：绑定 rec.id 的 stop→exit→registry→composition（token 级比较，借不到其他 handle）
      await until(() => audits.some((l, i) => i >= a0 && l.startsWith(`exit handle=${rec.id} `)), "目标 exit 证据", 30_000);
      const chain = disposeChain(audits, rec.id, a0);
      expect(chain.stop).toBeGreaterThanOrEqual(a0);
      expect(chain.composition).toBeGreaterThan(chain.registry);
      killed = true;
    }
    if (!killed) throw new Error(`E4：三次尝试均未取得在飞击杀证据（最后原因：${missReason}）`);
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
