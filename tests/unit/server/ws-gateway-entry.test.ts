// D4 批②（网关 4414 面·W-d4-g*）：docs/d4-fulltext-design.md v5.1 §4.1-4.3+§5。
// 覆盖：正路径 ok/truncated 两态；reason 六值出口（unknown-entry/not-subscribed/stale 三源/
// oversized 两源/index-evicted/in-flight 重复与超限）；在途门分流（entry 族永不过 4404 计数
// 器——与订阅面 4404 共存不误伤）；digest 三元组对账；file 越界→4404 保留计数（与 subscribe
// 同面）；thinkingVisible 门（网关→entryBlocksOf 透传）；audit 行三态；retryable 档案
// （stale/in-flight=true，余 false）；同步面七行之分派占位（subscribe-client 侧单测另面）。
import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { WsGateway, type GatewayConnHooks, type HistorySinks, type HistorySourcePort, type WsGatewayOpts } from "../../../apps/server/src/ws/ws-gateway.ts";
import { TokenAuthority } from "../../../apps/server/src/ws/token-auth.ts";
import { sessionToScanRows, type ScanRow } from "@pi-agent-ui/protocol";

const tick = (): Promise<void> => new Promise((res) => setImmediate(() => res()));
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("until 超时");
    await tick();
  }
}

class FakeConn {
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  closes: Array<[number | undefined, string | undefined]> = [];
  private msgCb: ((data: string, isBinary: boolean) => void) | null = null;
  private closeCb: ((code: number) => void) | null = null;
  send(data: string): void { this.sent.push(data); }
  close(code?: number, reason?: string): void { this.closes.push([code, reason]); this.readyState = 2; }
  terminate(): void { this.readyState = 3; }
  hooks(): GatewayConnHooks {
    return { onMessage: (cb) => { this.msgCb = cb; }, onClose: (cb) => { this.closeCb = cb; } };
  }
  async say(obj: unknown): Promise<void> {
    this.msgCb?.(JSON.stringify(obj), false);
    await tick();
    await tick();
  }
  /** 同 tick 连发（不 await 单帧——造在途窗口；entry-get 异步读链在 openSafeFile await 让出） */
  saySync(obj: unknown): void { this.msgCb?.(JSON.stringify(obj), false); }
  /** 等 entry 族终帧（entry 帧或 4414 错帧）达 n 条——异步读链（真 fs open/read）需轮询非数 tick。 */
  async awaitEntry(n = 1, ms = 2000): Promise<void> {
    await until(() => this.frames().filter((f) => f.t === "entry" || (f.t === "error" && f.code === 4414)).length >= n, ms);
  }
  frames(): Array<Record<string, unknown>> { return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>); }
  async drain(n: number, ms = 2000): Promise<void> { await until(() => this.sent.length >= n, ms); }
}

class FakeHistory implements HistorySourcePort {
  readonly files = new Map<string, ScanRow[] | null>();
  readonly sinks = new Map<string, HistorySinks>();
  async load(file: string): Promise<readonly ScanRow[] | null> {
    const v = this.files.get(file);
    return v === undefined ? null : v;
  }
  observe(file: string, sinks: HistorySinks): (() => void) | null {
    this.sinks.set(file, sinks);
    return () => { this.sinks.delete(file); };
  }
  release(): void { /* fake 面无观测账 */ }
  append(file: string, ...rows: ScanRow[]): void {
    const list = this.files.get(file);
    if (list) list.push(...rows);
    for (const row of rows) this.sinks.get(file)?.onAppend(row);
  }
}

interface Rig {
  gw: WsGateway;
  conn(): FakeConn;
  dir: string;
  audits: string[];
  history: FakeHistory;
  dispose(): Promise<void>;
}

const FILE = "s1.jsonl"; // filePattern 扁平名（无目录段——网关 file 正则拒 /）

async function makeRig(over: Partial<WsGatewayOpts> = {}): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), "ws-gw-entry-"));
  const history = new FakeHistory();
  const audits: string[] = [];
  const gw = new WsGateway({
    tokens: TokenAuthority.fromTokens(["tok-ok"]),
    roots: [dir],
    scanDir: dir,
    allowedOrigins: ["http://localhost:5173"],
    recoveryEvidence: () => null,
    historySource: history,
    heartbeat: { pingMs: 0, idleMs: 0 },
    audit: (l) => { audits.push(l); },
    entryAbsFor: (f) => (f === FILE ? join(dir, FILE) : null),
    ...over,
  });
  const conn = () => {
    const c = new FakeConn();
    gw.attach(c, c.hooks(), { origin: "http://localhost:5173", loopback: true, tls: false });
    return c;
  };
  return { gw, conn, dir, audits, history, dispose: async () => { gw.dispose(); await rm(dir, { recursive: true, force: true }); } };
}

async function authed(r: Rig): Promise<FakeConn> {
  const c = r.conn();
  await c.say({ t: "hello", protocolVersion: 1, token: "tok-ok" });
  return c;
}

function msgLine(id: string, role: string, content: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "message", id, parentId: null, timestamp: "2026-10-10T12:00:00.000Z", message: { role, content, ...extra } });
}

/** 落盘+装载扫描面：text 进文件（含尾 \n），rows=sessionToScanRows 真投影（locator=行首偏移）。 */
async function seeded(r: Rig, lines: string[], thinkingVisible = false): Promise<void> {
  const abs = join(r.dir, FILE);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, lines.map((l) => `${l}\n`).join(""), "utf8");
  const rows = sessionToScanRows({ sessionText: `${lines.map((l) => `${l}\n`).join("")}`, enqueues: [], consumed: [], ...(thinkingVisible ? { thinkingVisible: true } : {}) });
  r.history.files.set(FILE, rows);
}

const sub = (c: FakeConn, rid = "sub-1", file = FILE): Promise<void> =>
  c.say({ t: "subscribe", requestId: rid, file });
const entryErr = (c: FakeConn): Array<Record<string, unknown>> =>
  c.frames().filter((f) => f.t === "error" && f.code === 4414);

describe("D4 批② W-d4-g：正路径两态", () => {
  it("g1 ok：索引命中→定点读→三元组 digest 对账→entry 帧 state=ok（blocks/digest/rawBytes/totalBlockCount）+audit 行", async () => {
    const r = await makeRig();
    try {
      await seeded(r, [msgLine("a1", "assistant", [{ type: "text", text: "你好全文" }], { stopReason: "stop" })]);
      const c = await authed(r);
      await sub(c);
      await c.say({ t: "entry-get", requestId: "e1", file: FILE, entryId: "a1" });
      await c.awaitEntry(1);
      const f = c.frames().find((x) => x.t === "entry") as Record<string, unknown>;
      expect(f).toBeDefined();
      expect(f.state).toBe("ok");
      expect(f.entryId).toBe("a1");
      expect(f.requestId).toBe("e1");
      expect(Array.isArray(f.blocks)).toBe(true);
      expect(f.totalBlockCount).toBe(1);
      expect(typeof f.rawBytes).toBe("number");
      expect("truncatedAt" in f).toBe(false);
      expect(f.stopReason).toBe("stop");
      expect(r.audits.some((l) => l.includes("entry-get") && l.includes("state=ok") && l.includes("id=a1"))).toBe(true);
    } finally { await r.dispose(); }
  });

  it("g2 truncated：粗估超 30_720 的长文→state=truncated+truncatedAt 在+rawBytes wire 级缺席", async () => {
    const r = await makeRig();
    try {
      const long = "长".repeat(16_000); // 16k 代码单元×3 字节=48KB>粗估门
      await seeded(r, [msgLine("big", "assistant", [{ type: "text", text: long }])]);
      const c = await authed(r);
      await sub(c);
      await c.say({ t: "entry-get", requestId: "e2", file: FILE, entryId: "big" });
      await c.awaitEntry(1);
      const f = c.frames().find((x) => x.t === "entry") as Record<string, unknown>;
      expect(f.state).toBe("truncated");
      // truncatedAt=块级切位（EntryBlock 内；帧级无此字段——契约 §5.2）
      const blocks = f.blocks as Array<Record<string, unknown>>;
      expect(blocks.some((b) => typeof b.truncatedAt === "number")).toBe(true);
      expect("rawBytes" in f).toBe(false);
      expect(r.audits.some((l) => l.includes("state=truncated"))).toBe(true);
    } finally { await r.dispose(); }
  });

  it("g3 thinking 门关（默认）：thinking 块被门控；门开（opts.thinkingVisible=true）：透传 entryBlocksOf", async () => {
    const content = [{ type: "thinking", text: "独白" }, { type: "text", text: "答" }];
    for (const [vis, expectCount] of [[false, 1], [true, 2]] as const) {
      const r = await makeRig(vis ? { thinkingVisible: true } : {});
      try {
        await seeded(r, [msgLine("t1", "assistant", content)], vis);
        const c = await authed(r);
        await sub(c);
        await c.say({ t: "entry-get", requestId: "e3", file: FILE, entryId: "t1" });
      await c.awaitEntry(1);
        const f = c.frames().find((x) => x.t === "entry") as Record<string, unknown>;
        expect((f.blocks as unknown[]).length).toBe(expectCount);
        const blocks = f.blocks as Array<Record<string, unknown>>;
        if (!vis) expect(blocks.some((b) => b.type === "thinking")).toBe(false);
      } finally { await r.dispose(); }
    }
  });
});

describe("D4 批② W-d4-g：reason 六值出口", () => {
  it("g4 unknown-entry：未登记 entryId（扫描面没见过）", async () => {
    const r = await makeRig();
    try {
      await seeded(r, [msgLine("a1", "assistant", "x")]);
      const c = await authed(r);
      await sub(c);
      await c.say({ t: "entry-get", requestId: "e4", file: FILE, entryId: "nope" });
      await c.awaitEntry(1);
      const errs = entryErr(c);
      expect(errs).toHaveLength(1);
      expect(errs[0]?.reason).toBe("unknown-entry");
      expect(errs[0]?.retryable).toBe(false);
      expect(c.closes).toHaveLength(0); // 不 close
      expect(c.frames().some((f) => f.t === "close")).toBe(false);
    } finally { await r.dispose(); }
  });

  it("g5 not-subscribed：订阅未建立（先于索引查询）", async () => {
    const r = await makeRig();
    try {
      await seeded(r, [msgLine("a1", "assistant", "x")]);
      const c = await authed(r);
      await c.say({ t: "entry-get", requestId: "e5", file: FILE, entryId: "a1" });
      await c.awaitEntry(1);
      expect(entryErr(c)[0]?.reason).toBe("not-subscribed");
      expect(entryErr(c)[0]?.retryable).toBe(false);
    } finally { await r.dispose(); }
  });

  it("g6 stale·源一 digest 对账：盘面行改写（同 locator 异 raw）→三元组不符", async () => {
    const r = await makeRig();
    try {
      await seeded(r, [msgLine("a1", "assistant", "原文")]);
      const c = await authed(r);
      await sub(c);
      // 订阅装载后改写盘面（扫描 rows 不变→索引 digest 仍旧值）
      await writeFile(join(r.dir, FILE), `${msgLine("a1", "assistant", "被改写")}\n`, "utf8");
      await c.say({ t: "entry-get", requestId: "e6", file: FILE, entryId: "a1" });
      await c.awaitEntry(1);
      expect(entryErr(c)[0]?.reason).toBe("stale");
      expect(entryErr(c)[0]?.retryable).toBe(true);
      expect(r.audits.some((l) => l.includes("err:4414/stale"))).toBe(true);
    } finally { await r.dispose(); }
  });

  it("g7 stale·源二 文件不可读：订阅装载后删除文件→openSafeFile 失败", async () => {
    const r = await makeRig();
    try {
      await seeded(r, [msgLine("a1", "assistant", "x")]);
      const c = await authed(r);
      await sub(c);
      await rm(join(r.dir, FILE), { force: true });
      await c.say({ t: "entry-get", requestId: "e7", file: FILE, entryId: "a1" });
      await c.awaitEntry(1);
      expect(entryErr(c)[0]?.reason).toBe("stale");
    } finally { await r.dispose(); }
  });

  it("g8 stale·源三 行界失效：换行为改写使 locator 前字节非 0x0A（readLineAt 判据①）", async () => {
    const r = await makeRig();
    try {
      await seeded(r, [msgLine("a1", "assistant", "x")]);
      const c = await authed(r);
      await sub(c);
      // locator=0（首行）；首字节前插无换行内容→offset>0 且前字节非 0x0A→bad-start→stale
      await writeFile(join(r.dir, FILE), `xx${msgLine("a1", "assistant", "x")}\n`, "utf8");
      await c.say({ t: "entry-get", requestId: "e8", file: FILE, entryId: "a1" });
      await c.awaitEntry(1);
      expect(entryErr(c)[0]?.reason).toBe("stale");
    } finally { await r.dispose(); }
  });

  it("g9 oversized·源一：行超 1MiB 硬读限→oversized（readLineAt 口径）", async () => {
    const r = await makeRig();
    try {
      const huge = "x".repeat(1_049_000); // >1MiB（含 JSON 包壳）
      await seeded(r, [msgLine("huge", "assistant", [{ type: "text", text: huge }])]);
      const c = await authed(r);
      await sub(c);
      await c.say({ t: "entry-get", requestId: "e9", file: FILE, entryId: "huge" });
      await c.awaitEntry(1);
      expect(entryErr(c)[0]?.reason).toBe("oversized");
      expect(entryErr(c)[0]?.retryable).toBe(false);
    } finally { await r.dispose(); }
  });

  it("g10 触顶流废弃：装载 20_001 行>maxEventsPerStream→订阅被拒+订阅面清空——后续 entry-get→not-subscribed（index-evicted 为纵深防御位：closeSubscriptionsFor 同步删 subs，正常时序必先落 not-subscribed；audit 落 index-over-budget）", async () => {
    const r = await makeRig();
    try {
      const lines: string[] = [];
      for (let i = 0; i < 20_001; i++) lines.push(msgLine(`id-${i}`, "assistant", [{ type: "text", text: `行${i}` }]));
      await seeded(r, lines);
      const c = await authed(r);
      await c.say({ t: "subscribe", requestId: "sub-10", file: FILE });
      await until(() => c.frames().some((f) => f.t === "error"), 15_000); // 触顶拒订阅（非 snapshot）
      await c.say({ t: "entry-get", requestId: "e10", file: FILE, entryId: "id-0" });
      await c.awaitEntry(1);
      expect(entryErr(c)[0]?.reason).toBe("not-subscribed"); // 订阅已随触顶清空（真实可达序）
      expect(r.audits.some((l) => l.includes("index-over-budget"))).toBe(true);
    } finally { await r.dispose(); }
  }, 25_000);
});

describe("D4 批② W-d4-g：在途门分流（entry 族永不过 4404 计数器）", () => {
  it("g11 requestId 在途重复→4414 in-flight（非 4404）；同连接后续帧不受污染", async () => {
    const r = await makeRig();
    try {
      await seeded(r, [msgLine("a1", "assistant", "x")]);
      const c = await authed(r);
      await sub(c);
      // 同 tick 双发同 rid：第一帧进异步读链（inflight 已占），第二帧走分流
      c.saySync({ t: "entry-get", requestId: "dup", file: FILE, entryId: "a1" });
      c.saySync({ t: "entry-get", requestId: "dup", file: FILE, entryId: "a1" });
      await until(() => c.frames().some((f) => f.t === "entry") && entryErr(c).length >= 1);
      const errs = entryErr(c);
      expect(errs).toHaveLength(1);
      expect(errs[0]?.reason).toBe("in-flight");
      expect(errs[0]?.retryable).toBe(true);
      const entry = c.frames().filter((f) => f.t === "entry");
      expect(entry).toHaveLength(1); // 首帧正常完帧
      expect(c.closes).toHaveLength(0); // 不计数→不 close
      // 后续正常帧不受影响（槽已还）
      await c.say({ t: "entry-get", requestId: "next", file: FILE, entryId: "a1" });
      await until(() => c.frames().filter((f) => f.t === "entry").length >= 2);
      expect(c.frames().filter((f) => f.t === "entry")).toHaveLength(2);
      expect(c.closes).toHaveLength(0);
    } finally { await r.dispose(); }
  });

  it("g12 第 5 个并发在途→4414 in-flight 超限（4 槽满）；仍不计数 4404", async () => {
    const r = await makeRig();
    try {
      await seeded(r, [
        msgLine("a1", "assistant", "x"),
        msgLine("a2", "assistant", "y"),
        msgLine("a3", "assistant", "z"),
        msgLine("a4", "assistant", "w"),
        msgLine("a5", "assistant", "v"),
      ]);
      const c = await authed(r);
      await sub(c);
      for (let i = 1; i <= 5; i++) c.saySync({ t: "entry-get", requestId: `r${i}`, file: FILE, entryId: `a${i}` });
      await until(() => c.frames().filter((f) => f.t === "entry").length >= 4 && entryErr(c).length >= 1);
      const errs = entryErr(c);
      expect(errs).toHaveLength(1);
      expect(errs[0]?.reason).toBe("in-flight");
      expect(errs[0]?.requestId).toBe("r5");
      expect(c.frames().filter((f) => f.t === "entry")).toHaveLength(4);
      expect(c.closes).toHaveLength(0);
    } finally { await r.dispose(); }
  });

  it("g13 分流不误伤：非 entry 帧重复 requestId 仍走 4404（既有面回归）", async () => {
    const r = await makeRig();
    try {
      const c = await authed(r);
      c.saySync({ t: "list-sessions", requestId: "x" });
      c.saySync({ t: "list-sessions", requestId: "x" });
      await c.drain(2);
      const e4404 = c.frames().filter((f) => f.t === "error" && f.code === 4404);
      expect(e4404).toHaveLength(1);
      expect(entryErr(c)).toHaveLength(0);
    } finally { await r.dispose(); }
  });
});

describe("D4 批② W-d4-g：权限与解析面", () => {
  it("g14 file 越界→4404（与 subscribe 同面，保留计数；非 4414）", async () => {
    const r = await makeRig();
    try {
      const c = await authed(r);
      await c.say({ t: "entry-get", requestId: "e14", file: "../outside.jsonl", entryId: "a1" });
      await c.drain(1);
      const e = c.frames().filter((f) => f.t === "error");
      expect(e).toHaveLength(1);
      expect(e[0]?.code).toBe(4404);
      expect(entryErr(c)).toHaveLength(0);
    } finally { await r.dispose(); }
  });

  it("g15 共享解析器身份复核：行改写为非 message 行且 digest 恰同（防御纵深——构造法：同 raw 不同 entryId 不可达，以 registry 首见行为基准验证 entryId 比对分支的存在性），此例走 digest 先挂；同 locator 等长不同 entryId 行→stale", async () => {
    const r = await makeRig();
    try {
      await seeded(r, [msgLine("a1", "assistant", "x")]);
      const c = await authed(r);
      await sub(c);
      // 等长改写：id 同长度不同值——digest 必变（raw 变），走 stale（身份复核为纵深第二道）
      await writeFile(join(r.dir, FILE), `${msgLine("b2", "assistant", "x")}\n`, "utf8");
      await c.say({ t: "entry-get", requestId: "e15", file: FILE, entryId: "a1" });
      await c.awaitEntry(1);
      expect(entryErr(c)[0]?.reason).toBe("stale");
    } finally { await r.dispose(); }
  });

  it("g16 entryAbsFor 映射不中→unknown-entry（journal-only/无会话映射）", async () => {
    const r = await makeRig({ entryAbsFor: () => null });
    try {
      await seeded(r, [msgLine("a1", "assistant", "x")]);
      const c = await authed(r);
      await sub(c);
      await c.say({ t: "entry-get", requestId: "e16", file: FILE, entryId: "a1" });
      await c.awaitEntry(1);
      expect(entryErr(c)[0]?.reason).toBe("unknown-entry");
    } finally { await r.dispose(); }
  });
});
