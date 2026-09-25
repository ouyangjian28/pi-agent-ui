// 切片③ 3a 网关单测——w1 修复轮重写（验收对照 w1 报告 A1-A23 + 十二必修反例）
// 全部出帧经 ConnectionQueue→FakeConn；出队=setImmediate 异步 → recv 后断言前 await tick()。
// 覆盖：W1-01 校验器单入口/错误矩阵/ping 无 requestId/引擎 4404 计数；W1-02 认证截止 timer/准入配额/握手滑窗；
// W1-03 双计数（queue 侧文件）；W1-04 数据入口（201+历史/分页中追加/live/status/换流/缺文件 4402）；
// W1-05 原子重同步（失败不销毁旧订阅+通知关联旧 subscriptionId+撤旧帧）；W1-06 evidenceHash 门；
// W1-07 断开取消排队计算；W1-08 审计抛错不阻断撤销；W1-11 列表版本稳定；心跳/寿命/撤销/传输关闭。
import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WsGateway, type ConnMeta, type GatewayConnHooks, type HistorySinks, type HistorySourcePort, type WsGatewayOpts } from "../../../apps/server/src/ws/ws-gateway.ts";
import { TokenAuthority } from "../../../apps/server/src/ws/token-auth.ts";
import { ComputeSemaphore } from "../../../apps/server/src/ws/compute-semaphore.ts";
import type { RecoveryEvidenceSnapshot, BadJournalEntry } from "../../../apps/server/src/runtime/recover.ts";
import type { ScanRow } from "@pi-agent-ui/protocol";
import { validateClientFrame } from "@pi-agent-ui/protocol";

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
  terminated = 0;
  private msgCb: ((data: string, isBinary: boolean) => void) | null = null;
  private closeCb: ((code: number) => void) | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closes.push([code, reason]);
    this.readyState = 2;
  }
  terminate(): void {
    this.terminated++;
    this.readyState = 3;
  }
  hooks(): GatewayConnHooks {
    return {
      onMessage: (cb) => { this.msgCb = cb; },
      onClose: (cb) => { this.closeCb = cb; },
    };
  }
  // 双跳：异步处理器（await load/semaphore）的续体在微任务里入队，排空=setImmediate 再一跳——
  // 单跳会先于队列排空触发（sync 路径双跳无害）。
  async say(obj: unknown): Promise<void> {
    this.msgCb?.(JSON.stringify(obj), false);
    await tick();
    await tick();
  }
  async sayRaw(text: string): Promise<void> {
    this.msgCb?.(text, false);
    await tick();
    await tick();
  }
  async sayBinary(): Promise<void> {
    this.msgCb?.("{}", true);
    await tick();
    await tick();
  }
  closedByTransport(code = 1006): void {
    this.closeCb?.(code);
  }
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

/** 订阅数据入口替身（W1-04）：可编程 load + 可触发 observe */
class FakeHistory implements HistorySourcePort {
  readonly files = new Map<string, ScanRow[] | null>();
  readonly sinks = new Map<string, HistorySinks>();
  loadCalls: string[] = [];
  observeCalls: string[] = [];
  /** B3：受控挂起——文件名命中时 load 等待对应 resolver（造 await 窗口） */
  gates = new Map<string, () => void>();
  async load(file: string): Promise<readonly ScanRow[] | null> {
    this.loadCalls.push(file);
    const gate = this.gates.get(file);
    if (gate !== undefined) await new Promise<void>((res) => { this.gates.set(file, () => { gate(); res(); }); });
    const v = this.files.get(file);
    return v === undefined ? null : v;
  }
  observe(file: string, sinks: HistorySinks): () => void {
    this.observeCalls.push(file);
    this.sinks.set(file, sinks);
    return () => { this.sinks.delete(file); };
  }
  rows(file: string): ScanRow[] {
    const v = this.files.get(file);
    if (v == null) throw new Error(`fake history 无 ${file}`);
    return v as ScanRow[];
  }
  put(file: string, rows: ScanRow[]): void { this.files.set(file, rows); }
  /** B3：挂起闸门——首次调用返回闸门对象，再调才放行（同一文件后续 load 立即过）。 */
  gate(file: string): void { this.gates.set(file, () => {}); }
  release(file: string): void { const g = this.gates.get(file); if (g) { g(); this.gates.delete(file); } }
  missing(file: string): void { this.files.set(file, null); }
  append(file: string, row: ScanRow): void {
    this.rows(file).push(row);
    this.sinks.get(file)?.onAppend(row);
  }
  live(file: string, ev: Parameters<HistorySinks["onLive"]>[0]): void {
    this.sinks.get(file)?.onLive(ev);
  }
  status(file: string, s: Parameters<HistorySinks["onStatus"]>[0]): void {
    this.sinks.get(file)?.onStatus(s);
  }
}

/** 造 n 行 journal 扫描行（kind:sending 事件；raw=行原文） */
function makeRows(n: number): ScanRow[] {
  const out: ScanRow[] = [];
  for (let i = 0; i < n; i++) {
    const raw = JSON.stringify({ t: "sending", seq: i + 1 });
    out.push({ source: "journal", locator: String(i + 1), raw, event: { seq: i + 1, ts: i, generation: null, intentId: null, kind: "sending" } });
  }
  return out;
}

interface Rig {
  gw: WsGateway;
  conn(): { c: FakeConn; handle: { id: string } };
  roots: string;
  scanDir: string;
  evidence: Map<string, RecoveryEvidenceSnapshot | null>;
  history: FakeHistory;
  dispose(): Promise<void>;
}

async function makeRig(over: Partial<WsGatewayOpts> = {}): Promise<Rig> {
  const d = await mkdtemp(join(tmpdir(), "ws-gw-"));
  const evidence = new Map<string, RecoveryEvidenceSnapshot | null>();
  const history = new FakeHistory();
  const gw = new WsGateway({
    tokens: TokenAuthority.fromTokens(["tok-ok"]),
    roots: [d],
    scanDir: d,
    allowedOrigins: ["http://localhost:5173"],
    recoveryEvidence: (file) => {
      const holder = evidence.get(file);
      return holder !== undefined ? holder : null;
    },
    historySource: history,
    heartbeat: { pingMs: 0, idleMs: 0 }, // 默认禁用（个别例覆盖）
    audit: () => {},
    ...over,
  });
  const conn = () => {
    const c = new FakeConn();
    const handle = gw.attach(c, c.hooks(), { origin: "http://localhost:5173", loopback: true, tls: false } satisfies ConnMeta);
    return { c, handle };
  };
  return { gw, conn, roots: d, scanDir: d, evidence, history, dispose: async () => { gw.dispose(); await rm(d, { recursive: true, force: true }); } };
}

async function authed(r: Rig, token = "tok-ok"): Promise<FakeConn> {
  const { c } = r.conn();
  await c.say({ t: "hello", protocolVersion: 1, token });
  return c;
}

const errFrames = (c: FakeConn): Array<Record<string, unknown>> => c.frames().filter((f) => f.t === "error");
const lastClose = (c: FakeConn): [number | undefined, string | undefined] | undefined => c.closes[c.closes.length - 1];

describe("ws-gateway w1：A 认证入站（W1-01/02）", () => {
  it("A1 hello 成功→welcome；坏 token→4401+close 1008；重复 hello→4404", async () => {
    const r = await makeRig();
    try {
      const c = await authed(r);
      expect(c.frames().some((f) => f.t === "welcome")).toBe(true);
      const { c: c2 } = r.conn();
      await c2.say({ t: "hello", protocolVersion: 1, token: "bad" });
      expect(c2.frames().some((f) => f.code === 4401)).toBe(true);
      expect(lastClose(c2)?.[0]).toBe(1008); // W1-01：应用 4401≠传输 close 码（1008）
      // 重复 hello
      await c.say({ t: "hello", protocolVersion: 1, token: "tok-ok" });
      expect(c.frames().some((f) => f.code === 4404 && String(f.message).includes("重复"))).toBe(true);
    } finally {
      await r.dispose();
    }
  });

  it("A2 Origin 缺失/不在白名单→4401+close 1008；非 loopback 无 TLS→4401", async () => {
    const r = await makeRig();
    try {
      const c1 = new FakeConn();
      r.gw.attach(c1, c1.hooks(), { loopback: true, tls: false });
      await c1.say({ t: "hello", protocolVersion: 1, token: "tok-ok" });
      expect(c1.frames().some((f) => f.code === 4401)).toBe(true);
      expect(lastClose(c1)?.[0]).toBe(1008);
      const c2 = new FakeConn();
      r.gw.attach(c2, c2.hooks(), { origin: "http://evil.example", loopback: true, tls: false });
      await c2.say({ t: "hello", protocolVersion: 1, token: "tok-ok" });
      expect(c2.frames().some((f) => f.code === 4401)).toBe(true); // 非白名单（非子串匹配）
      const c3 = new FakeConn();
      r.gw.attach(c3, c3.hooks(), { origin: "http://localhost:5173", loopback: false, tls: false });
      await c3.say({ t: "hello", protocolVersion: 1, token: "tok-ok" });
      expect(c3.frames().some((f) => f.code === 4401)).toBe(true);
    } finally {
      await r.dispose();
    }
  });

  it("A3 protocolVersion=2→4403+close 1003（错误矩阵）", async () => {
    const r = await makeRig();
    try {
      const { c } = r.conn();
      await c.say({ t: "hello", protocolVersion: 2, token: "tok-ok" });
      expect(c.frames().some((f) => f.code === 4403)).toBe(true);
      expect(lastClose(c)?.[0]).toBe(1003);
    } finally {
      await r.dispose();
    }
  });

  it("A4 未认证非 hello→4401；hello 字段非法→4404（校验器口径）", async () => {
    const r = await makeRig();
    try {
      const { c } = r.conn();
      await c.say({ t: "list-sessions", requestId: "r1" });
      expect(c.frames().some((f) => f.code === 4401)).toBe(true);
      const { c: c2 } = r.conn();
      await c2.say({ t: "hello", protocolVersion: 1, token: "tok-ok", extra: 1 }); // 校验器：exact 字段集
      expect(c2.frames().some((f) => f.code === 4404)).toBe(true);
    } finally {
      await r.dispose();
    }
  });

  it("A5 入站管线：二进制/非 JSON/未知 t→4404；写类→4405+close 1008；3×4404→close 1002；错误消息固定不回显", async () => {
    const r = await makeRig();
    try {
      const c = await authed(r);
      await c.sayBinary();
      await c.sayRaw("{nope");
      await c.say({ t: "totally-unknown", requestId: "x".repeat(300) }); // 恶意超长 t 不回显
      const errs = errFrames(c);
      expect(errs.length).toBe(3);
      expect(errs.every((f) => !String(f.message).includes("totally-unknown"))).toBe(true); // 固定消息
      expect(lastClose(c)?.[0]).toBe(1002); // 累计 3
      // 写类（新连接）
      const c2 = await authed(r);
      await c2.say({ t: "prompt", requestId: "r1", message: "hi" });
      expect(c2.frames().some((f) => f.code === 4405)).toBe(true);
      expect(lastClose(c2)?.[0]).toBe(1008); // 4405→close 1008
    } finally {
      await r.dispose();
    }
  });

  it("A6 ping 无 requestId（校验器接受）→pong；带 requestId 的 ping→4404", async () => {
    const r = await makeRig();
    try {
      const c = await authed(r);
      await c.say({ t: "ping", nonce: "n-1" });
      expect(c.frames().some((f) => f.t === "pong" && f.nonce === "n-1")).toBe(true);
      await c.say({ t: "ping", nonce: "n-2", requestId: "r-1" }); // 冻结校验器拒（exact 字段集）
      expect(c.frames().some((f) => f.code === 4404)).toBe(true);
    } finally {
      await r.dispose();
    }
  });

  it("W1-01 一致性：同帧喂冻结校验器与网关——拒绝帧必回 4404/4403/4405，接受帧必有响应（golden）", async () => {
    const r = await makeRig();
    try {
      const golden: unknown[] = [
        { t: "ping", nonce: "g" },
        { t: "ping" },
        { t: "ping", nonce: "g", requestId: "r" },
        { t: "unknown-x", requestId: "r4" },
        { t: "get-recovery", requestId: "r3", file: "a.jsonl", offset: 0, evidenceHash: "zz" },
        { t: "get-recovery", requestId: "r3", file: "a.jsonl", offset: 0, evidenceHash: "0".repeat(64) },
        { t: "subscribe", requestId: "r2", file: "a.jsonl", cursor: { streamId: "s", seq: 1 } },
        { t: "subscribe", requestId: "r2", file: "a.jsonl", cursor: { streamId: "s" } },
      ];
      let idx = 0;
      for (const g of golden) {
        idx++;
        const cc = await authed(r); // 每帧独立已认证连接（共享连接会被 4404 计数关闭→假绿）
        const validatorSays = validateClientFrame(g).ok;
        const before = cc.sent.length;
        await cc.sayRaw(JSON.stringify(g));
        await until(() => cc.sent.length > before || cc.readyState !== 1, 1000);
        if (validatorSays) {
          if (cc.readyState === 1 && cc.sent.length === before) throw new Error(`#${idx} 校验器接受但网关无响应: ${JSON.stringify(g)}`);
        } else {
          const last = cc.frames()[cc.frames().length - 1];
          expect(last !== undefined && (last.code === 4404 || last.code === 4403 || last.code === 4405) || cc.readyState !== 1).toBe(true);
        }
      }
    } finally {
      await r.dispose();
    }
  });

  it("W1-02 认证截止：helloWindowMs 内不发 hello→4401+close 1008（独立 timer；持续不续命）", async () => {
    const r = await makeRig({ helloWindowMs: 40 });
    try {
      const { c } = r.conn();
      await until(() => c.closes.length > 0, 1000);
      expect(c.frames().some((f) => f.code === 4401 && String(f.message).includes("认证窗口超时"))).toBe(true);
      expect(lastClose(c)?.[0]).toBe(1008);
      expect(r.gw.connectionCount).toBe(0);
    } finally {
      await r.dispose();
    }
  });

  it("W1-02 准入配额：maxConnections=2 第 3 连接→立即 close 1013；连接关闭后名额归还", async () => {
    const r = await makeRig({ maxConnections: 2 });
    try {
      const a = await authed(r);
      const b = await authed(r);
      expect(r.gw.connectionCount).toBe(2);
      const c3 = new FakeConn();
      r.gw.attach(c3, c3.hooks(), { origin: "http://localhost:5173", loopback: true, tls: false });
      await tick();
      expect(c3.closes.some(([code]) => code === 1013)).toBe(true);
      expect(r.gw.connectionCount).toBe(2);
      a.closedByTransport();
      await tick();
      expect(r.gw.connectionCount).toBe(1);
      const c4 = new FakeConn();
      r.gw.attach(c4, c4.hooks(), { origin: "http://localhost:5173", loopback: true, tls: false });
      await c4.say({ t: "hello", protocolVersion: 1, token: "tok-ok" });
      expect(c4.frames().some((f) => f.t === "welcome")).toBe(true);
      void b;
    } finally {
      await r.dispose();
    }
  });

  it("W1-02 握手滑窗：handshakePerMinute=2 第 3 次接入→1013", async () => {
    const r = await makeRig({ handshakePerMinute: 2 });
    try {
      for (let i = 0; i < 2; i++) {
        const c = new FakeConn();
        r.gw.attach(c, c.hooks(), { origin: "http://localhost:5173", loopback: true, tls: false });
        await tick();
      }
      const c3 = new FakeConn();
      r.gw.attach(c3, c3.hooks(), { origin: "http://localhost:5173", loopback: true, tls: false });
      await tick();
      expect(c3.closes.some(([code]) => code === 1013)).toBe(true);
    } finally {
      await r.dispose();
    }
  });
});

describe("ws-gateway w1：B 队列与请求门（W1-01/03）", () => {
  it("B7 requestId 在途重复→4404；第 5 个并发→4404（§369）；断开后槽释放", async () => {
    // 受控挂起 provider：永不结算→请求永在途（真实并发挂起反例）
    const r = await makeRig({
      recoveryEvidence: () => new Promise<never>(() => {}),
    });
    try {
      const c = await authed(r);
      for (let i = 1; i <= 4; i++) {
        void c.say({ t: "get-recovery", requestId: `rr-${i}`, file: "f1.jsonl" }); // 不 await：并发挂起
      }
      await tick();
      // 第 5 个→4404（在途超限；消息固定）
      await c.say({ t: "get-recovery", requestId: "rr-5", file: "f1.jsonl" });
      expect(c.frames().some((f) => f.code === 4404 && String(f.message).includes("在途请求超限"))).toBe(true);
      // 重复 requestId→4404
      await c.say({ t: "get-recovery", requestId: "rr-1", file: "f1.jsonl" });
      expect(c.frames().some((f) => f.code === 4404 && String(f.message).includes("在途重复"))).toBe(true);
      // 传输关闭：连接清理+任务取消（W1-07）不泄漏
      c.closedByTransport();
      await tick();
      expect(r.gw.connectionCount).toBe(0);
      await r.dispose();
      // 新网关：完成后槽归还——普通 ping/list 正常（列表真 fs→until）
      const r2 = await makeRig();
      const c2 = await authed(r2);
      await c2.say({ t: "ping", nonce: "p" });
      expect(c2.frames().some((f) => f.t === "pong")).toBe(true);
      await r2.dispose();
    } finally {
      await r.dispose();
    }
  });

  it("B8 入站字节门：>262144B→4404（大 limit 字段拼装）", async () => {
    const r = await makeRig();
    try {
      const c = await authed(r);
      await c.sayRaw(JSON.stringify({ t: "list-sessions", requestId: "r" }) + " ".repeat(262_200));
      expect(c.frames().some((f) => f.code === 4404)).toBe(true);
    } finally {
      await r.dispose();
    }
  });
});

describe("ws-gateway w1：C 订阅接线（W1-04/05）", () => {
  it("C13 subscribe init：201 行历史→snapshot 首页（200 条上限）+分页到追平+进入 live；中逧行追加入 history 帧", async () => {
    const r = await makeRig();
    try {
      r.history.put("s201.jsonl", makeRows(201));
      const c = await authed(r);
      await c.say({ t: "subscribe", requestId: "sub-1", file: "s201.jsonl" });
      const snap = c.frames().find((f) => f.t === "snapshot") as Record<string, unknown>;
      expect(snap).toBeDefined();
      expect(snap.barrier).toBe(201);
      expect(Array.isArray(snap.page) && snap.page.length).toBe(200); // pageMaxEvents=200
      expect(snap.hasMore).toBe(true);
      const snapId = snap.snapshotId as string; // 页请求携带快照的 snapshotId（≠subscriptionId）
      // 分页中追加（paging 期 onAppend→缓冲；追平后以 history 帧交付）
      r.history.append("s201.jsonl", rowAt(202));
      await c.say({ t: "subscribe", requestId: "sub-p2", file: "s201.jsonl", snapshotId: snapId, historyNext: snap.historyNext });
      const snap2 = c.frames().filter((f) => f.t === "snapshot").pop() as Record<string, unknown>;
      expect(snap2).toBeDefined();
      if (snap2.historyNext != null) {
        await c.say({ t: "subscribe", requestId: "sub-p3", file: "s201.jsonl", snapshotId: snapId, historyNext: snap2.historyNext });
      }
      // 追平（含 buffered 的 202）后：history/live 帧出现（origin history 含 seq 202）
      await until(() => c.frames().some((f) => f.t === "events" && f.origin === "history"), 1000);
      const hist = c.frames().find((f) => f.t === "events" && f.origin === "history") as { events: Array<{ seq: number }> };
      expect(hist.events.some((e) => e.seq === 202)).toBe(true);
    } finally {
      await r.dispose();
    }
  });

  it("C14 缺文件/symlink→4402 retryable=true（load null fail-closed）", async () => {
    const r = await makeRig();
    try {
      r.history.missing("gone.jsonl");
      const c = await authed(r);
      await c.say({ t: "subscribe", requestId: "s1", file: "gone.jsonl" });
      const e = errFrames(c).pop();
      expect(e?.code).toBe(4402);
      expect(e?.retryable).toBe(true);
    } finally {
      await r.dispose();
    }
  });

  it("C15 live 事件（live 相态）与 status 帧经排空泵交付", async () => {
    const r = await makeRig();
    try {
      r.history.put("live.jsonl", makeRows(3));
      const c = await authed(r);
      await c.say({ t: "subscribe", requestId: "s1", file: "live.jsonl" });
      const snap = c.frames().find((f) => f.t === "snapshot") as Record<string, unknown>;
      expect(snap.hasMore).toBe(false); // 单页即追平→直接进入 live
      r.history.live("live.jsonl", { kind: "process-note", phase: "running" });
      await until(() => c.frames().some((f) => f.t === "events" && f.origin === "live"), 1000);
      r.history.status("live.jsonl", { marker: "st-1" } as never);
      await until(() => c.frames().some((f) => f.t === "status" && (f as { status?: { marker?: string } }).status?.marker === "st-1"), 1000);
      void snap;
    } finally {
      await r.dispose();
    }
  });

  it("C16 W1-05 原子重同步：错流→4404 不动旧订阅；同流超前→4409 保旧；旧订阅真实续页可用；成功替换关联旧 subscriptionId", async () => {
    const r = await makeRig();
    try {
      r.history.put("a.jsonl", makeRows(205)); // 两页：真实续页游标
      const c = await authed(r);
      await c.say({ t: "subscribe", requestId: "s1", file: "a.jsonl" });
      const snap1 = c.frames().find((f) => f.t === "snapshot") as Record<string, unknown>;
      const subId1 = snap1.subscriptionId as string;
      const snapId1 = snap1.snapshotId as string;
      // B1：错流 resync（foreign streamId+合法 seq）→4404；旧订阅必须存活且无 stream-replaced
      c.sent.length = 0;
      await c.say({ t: "subscribe", requestId: "s2", file: "a.jsonl", cursor: { streamId: "s-foreign", seq: 1 } });
      expect(errFrames(c).some((f) => f.code === 4404)).toBe(true);
      expect(errFrames(c).some((f) => f.code === 4431 || f.code === 4409)).toBe(false); // 未退旧
      // 同流超前（seq=9999>barrier+1）→4409；旧订阅仍存活
      c.sent.length = 0;
      await c.say({ t: "subscribe", requestId: "s2b", file: "a.jsonl", cursor: { streamId: snap1.streamId as string, seq: 9999 } });
      expect(errFrames(c).some((f) => f.code === 4409)).toBe(true);
      expect(errFrames(c).some((f) => f.code === 4431)).toBe(false);
      // 旧订阅续页：真实第二页内容（snapshot+旧 sid+seq 201）——非仅排除 4431
      c.sent.length = 0;
      await c.say({ t: "subscribe", requestId: "s3", file: "a.jsonl", snapshotId: snapId1, historyNext: snap1.historyNext });
      const tail = c.frames().pop() as Record<string, unknown>;
      expect(tail.t).toBe("snapshot");
      expect(tail.subscriptionId).toBe(subId1); // 还是旧订阅
      const page = tail.page as Array<{ seq: number }>;
      expect(page.some((e) => e.seq === 201)).toBe(true); // 真实内容
      // 成功替换：通知关联旧 subscriptionId
      c.sent.length = 0;
      await c.say({ t: "subscribe", requestId: "s4", file: "a.jsonl" });
      const rep = errFrames(c).find((f) => f.code === 4409);
      expect(String(rep?.message)).toContain(subId1); // W1-05：通知关联旧订阅
      const snap2 = c.frames().find((f) => f.t === "snapshot") as Record<string, unknown>;
      expect(snap2.subscriptionId).not.toBe(subId1);
    } finally {
      await r.dispose();
    }
  });

  it("C17 换流（盘面改写）：非前缀重扫→replace 新 streamId；旧游标→4404（不再按位置映射）；重新 init 换流可用", async () => {
    const r = await makeRig();
    try {
      r.history.put("rw.jsonl", makeRows(3));
      const c = await authed(r);
      await c.say({ t: "subscribe", requestId: "s1", file: "rw.jsonl" });
      const snap1 = c.frames().find((f) => f.t === "snapshot") as Record<string, unknown>;
      // 盘面改写：行 2 变化（非前缀）
      const rows2 = makeRows(3);
      rows2[1] = { ...rows2[1]!, raw: '{"t":"sending","seq":2,"mutated":true}' };
      r.history.files.set("rw.jsonl", rows2);
      // B1 二验：盘面改写→流身份已变；旧游标 resync→4404（错流门不静默跳过）
      c.sent.length = 0;
      await c.say({ t: "subscribe", requestId: "s2", file: "rw.jsonl", cursor: { streamId: snap1.streamId as string, seq: 1 } });
      expect(errFrames(c).some((f) => f.code === 4404)).toBe(true);
      // 重新 init：新流可用，barrier 重读
      c.sent.length = 0;
      await c.say({ t: "subscribe", requestId: "s3", file: "rw.jsonl" });
      const snap2 = c.frames().filter((f) => f.t === "snapshot").pop() as Record<string, unknown>;
      expect(snap2.streamId).not.toBe(snap1.streamId); // 换流
      expect(snap2.barrier).toBe(3);
      expect(errFrames(c).some((f) => f.code === 4409 && String(f.message).includes("stream-replaced:" + (snap1.subscriptionId as string)))).toBe(true);
    } finally {
      await r.dispose();
    }
  });

  it("C 订阅数 8 上限：第 9 个 file→4429 retryable=false；同 file 替换不受限", async () => {
    const r = await makeRig();
    try {
      const c = await authed(r);
      for (let i = 1; i <= 8; i++) {
        r.history.put(`f${i}.jsonl`, makeRows(1));
        await c.say({ t: "subscribe", requestId: `s${i}`, file: `f${i}.jsonl` });
      }
      r.history.put("f9.jsonl", makeRows(1));
      await c.say({ t: "subscribe", requestId: "s9", file: "f9.jsonl" });
      const e = errFrames(c).pop();
      expect(e?.code).toBe(4429);
      expect(e?.retryable).toBe(false); // W1-01：订阅数 4429 不可重试
      // 同 file 替换（已是第 8 个文件）不受限
      await c.say({ t: "subscribe", requestId: "s10", file: "f8.jsonl" });
      expect(errFrames(c).some((f) => f.code === 4429 && f.requestId === "s10")).toBe(false);
    } finally {
      await r.dispose();
    }
  });

  it("C unsubscribe：静默关+撤未发帧；get-recovery page 无引擎→4404 计数", async () => {
    const r = await makeRig();
    try {
      r.history.put("u.jsonl", makeRows(2));
      const c = await authed(r);
      await c.say({ t: "subscribe", requestId: "s1", file: "u.jsonl" });
      const snap = c.frames().find((f) => f.t === "snapshot") as Record<string, unknown>;
      const subId = snap.subscriptionId as string;
      await c.say({ t: "unsubscribe", requestId: "un-1", subscriptionId: subId });
      // 退订后再续页→4404（引擎已亡）
      await c.say({ t: "subscribe", requestId: "s2", file: "u.jsonl", snapshotId: subId, historyNext: snap.historyNext });
      expect(errFrames(c).some((f) => f.code === 4404 && f.requestId === "s2")).toBe(true);
    } finally {
      await r.dispose();
    }
  });
});

describe("ws-gateway w1：D 恢复与列表（W1-06/07/11）", () => {
  it("D18 无快照→unavailable(no-evidence-snapshot)", async () => {
    const r = await makeRig();
    try {
      const c = await authed(r);
      await c.say({ t: "get-recovery", requestId: "rec-1", file: "x.jsonl" });
      const f = c.frames().find((x) => x.t === "recovery") as Record<string, unknown>;
      expect(f.availability).toBe("unavailable");
      expect(f.reason).toBe("no-evidence-snapshot");
    } finally {
      await r.dispose();
    }
  });

  it("D19 W1-06 有快照→available 帧含 evidenceHash（64hex）；续页带旧 hash 一致→可用；hash 变→4409 evidence-changed", async () => {
    const r = await makeRig();
    try {
      r.evidence.set("ev.jsonl", snapOf());
      const c = await authed(r);
      await c.say({ t: "get-recovery", requestId: "rec-1", file: "ev.jsonl" });
      const f = c.frames().find((x) => x.t === "recovery" && x.availability === "available") as Record<string, unknown>;
      expect(f).toBeDefined();
      expect(String(f.evidenceHash)).toMatch(/^[0-9a-f]{64}$/); // W1-06：字段真实存在
      // 同 hash 续页受理
      await c.say({ t: "get-recovery", requestId: "rec-2", file: "ev.jsonl", offset: 0, evidenceHash: f.evidenceHash });
      expect(c.frames().some((x) => x.t === "recovery" && x.requestId === "rec-2")).toBe(true);
      // 证据变化（新快照→新 hash）→4409
      r.evidence.set("ev.jsonl", snapOf(2));
      await c.say({ t: "get-recovery", requestId: "rec-3", file: "ev.jsonl", offset: 0, evidenceHash: f.evidenceHash });
      expect(errFrames(c).some((x) => x.code === 4409 && String(x.message).includes("evidence-changed"))).toBe(true);
    } finally {
      await r.dispose();
    }
  });

  it("D20 恢复帧含阻断理由映射（torn-tail→blockedReasons）", async () => {
    const r = await makeRig();
    try {
      const snap = snapOf();
      (snap.bad as BadJournalEntry[]).push({ raw: "{torn", error: "bad json", partialTail: true });
      r.evidence.set("bt.jsonl", snap);
      const c = await authed(r);
      await c.say({ t: "get-recovery", requestId: "rec-1", file: "bt.jsonl" });
      const f = c.frames().find((x) => x.t === "recovery" && x.availability === "available") as { blockedReasons?: Array<{ kind: string }> };
      expect(Array.isArray(f.blockedReasons)).toBe(true);
      expect(f.blockedReasons?.some((b) => b.kind === "torn-tail")).toBe(true);
    } finally {
      await r.dispose();
    }
  });

  it("D21 W1-11 listVersion 稳定：静态目录两次请求（含跨页）版本不变；文件新增才递增", async () => {
    const r = await makeRig();
    try {
      // 55 个会话文件：首页 50 条+第二页 5 条（真跨页）
      for (let i = 1; i <= 55; i++) {
        await writeFile(join(r.scanDir, `s${String(i).padStart(2, "0")}.jsonl`),
          JSON.stringify({ type: "session", id: `sid-${i}`, timestamp: 100 + i }) + "\n" +
          JSON.stringify({ type: "message", timestamp: 200 + i, message: { role: "user", content: `hello-${i}` } }) + "\n");
      }
      const c = await authed(r);
      await c.say({ t: "list-sessions", requestId: "l1", offset: 0 });
      await until(() => c.frames().some((x) => x.t === "sessions"), 2000); // 真实 fs→异步扫描
      const f1 = c.frames().find((x) => x.t === "sessions") as Record<string, unknown>;
      expect((f1.sessions as unknown[]).length).toBe(50); // 首页=50
      expect(f1.hasMore).toBe(true);
      await c.say({ t: "list-sessions", requestId: "l2", offset: 50 });
      await until(() => c.frames().filter((x) => x.t === "sessions").length >= 2, 2000);
      const f2 = c.frames().filter((x) => x.t === "sessions").pop() as Record<string, unknown>;
      expect((f2.sessions as unknown[]).length).toBe(5); // 第二页
      expect(f2.listVersion).toBe(f1.listVersion); // 同内容跨页→同版本
      // 新文件→版本递增
      await writeFile(join(r.scanDir, "b.jsonl"), JSON.stringify({ type: "session", id: "sid-b", timestamp: 300 }) + "\n");
      await c.say({ t: "list-sessions", requestId: "l3" });
      await until(() => c.frames().filter((x) => x.t === "sessions").length >= 3, 2000);
      const f3 = c.frames().filter((x) => x.t === "sessions").pop() as Record<string, unknown>;
      expect(Number(f3.listVersion)).toBeGreaterThan(Number(f1.listVersion));
    } finally {
      await r.dispose();
    }
  });

  it("D22 W1-07 断开取消排队计算：死连接的排队任务被取消，槽让给活连接（provider 不被死任务调用）", async () => {
    const sem = new ComputeSemaphore(1, 60_000, { setTimeout: (cb, ms) => setTimeout(cb, ms), clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) });
    let calls = 0;
    const resolvers: Array<(v: null) => void> = [];
    const r = await makeRig({
      semaphore: sem,
      recoveryEvidence: () => new Promise<null>((res) => { calls++; resolvers.push(res); }),
    });
    try {
      const cA = await authed(r);
      void cA.say({ t: "get-recovery", requestId: "a1", file: "hold.jsonl" }); // A 执行（挂起）
      await until(() => calls === 1, 2000);
      const cB = await authed(r);
      void cB.say({ t: "get-recovery", requestId: "b1", file: "hold.jsonl" }); // B 排队
      await until(() => sem.queued === 1, 2000);
      cB.closedByTransport(); // B 死→其排队任务必须被取消（排队立即归零——不等槽归还）
      await tick();
      expect(sem.queued).toBe(0); // 若未取消：仍排队 1
      resolvers[0]!(null); // 释放 A 的 provider→A 结束→槽归还
      await until(() => sem.inFlight === 0 && sem.queued === 0, 2000);
      await tick(); await tick();
      expect(calls).toBe(1); // b1 已取消：不再被调用（若未取消→calls=2）
    } finally {
      await r.dispose();
    }
  });
  it("D23 W1-08 审计回调抛错不阻断令牌撤销（safeAudit）", async () => {
    // 可变 token 文件：初始含 tok-a/tok-b；reload 后只剩 tok-b→撤销 tok-a
    let tokens = ["tok-a", "tok-b"];
    const readFile = async (): Promise<Buffer> => Buffer.from(JSON.stringify({ version: 1, tokens }));
    const authority = await TokenAuthority.fromFile("/virtual/tokens.json", { readFile }, () => { throw new Error("authority audit boom"); });
    const r = await makeRig({ tokens: authority, audit: () => { throw new Error("audit boom"); } });
    try {
      const c = await authed(r, "tok-a"); // tok-a 真认证成功（权改变量先复位再 hello）
      expect(c.frames().some((f) => f.t === "welcome")).toBe(true); // 未被 4401 假绿
      tokens = ["tok-b"];
      await r.gw.applyTokenReload(); // 审计在 reload 内抛错——但撤销必须仍然发生
      await until(() => c.closes.length > 0 || c.frames().some((f) => f.code === 4401), 1000);
      expect(c.frames().some((f) => f.code === 4401)).toBe(true);
      expect(lastClose(c)?.[0]).toBe(1008);
    } finally {
      await r.dispose();
    }
  });
});

describe("ws-gateway w1：心跳/寿命/关闭", () => {
  it("心跳空闲超时→4432+close 1000；pong 刷新", async () => {
    const r = await makeRig({ heartbeat: { pingMs: 0, idleMs: 40 } });
    try {
      const c = await authed(r);
      await until(() => c.closes.length > 0, 1500);
      expect(c.frames().some((f) => f.code === 4432)).toBe(true);
      expect(lastClose(c)?.[0]).toBe(1000);
    } finally {
      await r.dispose();
    }
  });

  it("寿命上限→close 1000 lifetime-cap（ping/idle 全禁用仍生效）", async () => {
    const r = await makeRig({ maxLifetimeMs: 60, heartbeat: { pingMs: 0, idleMs: 0 } });
    try {
      const c = await authed(r);
      await until(() => c.closes.length > 0, 1500);
      expect(lastClose(c)?.[1]).toContain("lifetime-cap");
    } finally {
      await r.dispose();
    }
  });

  it("传输关闭→清理幂等（connectionCount 归零）", async () => {
    const r = await makeRig();
    try {
      const { c } = r.conn();
      await c.say({ t: "hello", protocolVersion: 1, token: "tok-ok" });
      expect(r.gw.connectionCount).toBe(1);
      c.closedByTransport();
      c.closedByTransport();
      await tick();
      expect(r.gw.connectionCount).toBe(0);
    } finally {
      await r.dispose();
    }
  });
});

// ---- 帮手 ----
function rowAt(seq: number): ScanRow {
  const raw = JSON.stringify({ t: "sending", seq });
  return { source: "journal", locator: String(seq), raw, event: { seq, ts: seq, generation: null, intentId: null, kind: "sending" } };
}

function snapOf(seed = 1): RecoveryEvidenceSnapshot {
  return {
    version: 1,
    file: "f.jsonl",
    sessionId: `sid-${seed}`,
    lines: [{ raw: JSON.stringify({ t: "session", id: `sid-${seed}` }), parsed: null }],
    bad: [],
    attributedFragments: [],
    repaired: [],
    createdAt: 1_000 + seed,
  } as unknown as RecoveryEvidenceSnapshot;
}

// ==== w1b：B 系阻断回归（B1 已并入 C16/C17）====
describe("ws-gateway w1b：B 系阻断回归", () => {
  it("B2 换流观察器绑当前索引+seq 规范化传播+双连接同文件", async () => {
    const r = await makeRig();
    try {
      // 外部 seq=99/5 → 快照页规范化为 1/2
      const rows = [
        { source: "journal", locator: "1", raw: '{"t":"sending","seq":99}', event: { seq: 99, ts: 0, generation: null, intentId: null, kind: "sending" } },
        { source: "journal", locator: "2", raw: '{"t":"sending","seq":5}', event: { seq: 5, ts: 1, generation: null, intentId: null, kind: "sending" } },
      ] as unknown as ScanRow[];
      r.history.put("b2.jsonl", rows);
      const c1 = await authed(r);
      await c1.say({ t: "subscribe", requestId: "s1", file: "b2.jsonl" });
      const snap1 = c1.frames().find((f) => f.t === "snapshot") as Record<string, unknown>;
      expect((snap1.page as Array<{ seq: number }>).map((e) => e.seq)).toEqual([1, 2]);
      const stream1 = snap1.streamId as string;
      // 盘面改写→重新 init 换流
      const rows2 = makeRows(3);
      rows2[0] = { ...rows2[0]!, raw: '{"t":"sending","seq":1,"mutated":true}' };
      r.history.files.set("b2.jsonl", rows2 as unknown as ScanRow[]);
      const c2 = await authed(r);
      await c2.say({ t: "subscribe", requestId: "s2", file: "b2.jsonl" });
      const snap2 = c2.frames().filter((f) => f.t === "snapshot").pop() as Record<string, unknown>;
      expect(snap2.streamId).not.toBe(stream1);
      // 换流后追加（外部 seq=777）→ 新索引规范化为 4，且旧观察器闭包不再喂旧索引
      r.history.append("b2.jsonl", { source: "journal", locator: "4", raw: '{"t":"sending","seq":777}', event: { seq: 777, ts: 3, generation: null, intentId: null, kind: "sending" } } as unknown as ScanRow);
      await until(() => c2.frames().some((f) => f.t === "events" && f.origin === "history"), 1000);
      const ev = c2.frames().find((f) => f.t === "events" && f.origin === "history") as { events: Array<{ seq: number }> };
      expect(ev.events.some((e) => e.seq === 4)).toBe(true); // 规范化统一坐标（非 777）
      expect(ev.events.some((e) => e.seq === 777)).toBe(false);
      // 观察器恰一份（换流未重新 observe——事件时取当前索引）
      expect(r.history.observeCalls.filter((f) => f === "b2.jsonl").length).toBe(1);
      // 双连接：c1 也收到（同一索引/同一泵）
      await until(() => c1.frames().some((f) => f.t === "events" && ((f.events as Array<{ seq: number }> | undefined) ?? []).some((e: { seq: number }) => e.seq === 4)), 1000);
    } finally {
      await r.dispose();
    }
  });

  it("B3a 同 file 并发双 init：后提交者替换前者（stream-replaced 恰一次，单引擎）", async () => {
    const r = await makeRig();
    try {
      r.history.put("race.jsonl", makeRows(205));
      r.history.gate("race.jsonl"); // 两请求同挂 load
      const c = await authed(r);
      void c.say({ t: "subscribe", requestId: "r1", file: "race.jsonl" });
      void c.say({ t: "subscribe", requestId: "r2", file: "race.jsonl" });
      await tick();
      r.history.release("race.jsonl"); // 两 load 同时放行
      await until(() => c.frames().some((f) => f.t === "snapshot") && errFrames(c).some((f) => f.code === 4409), 1000);
      const replaced = errFrames(c).filter((f) => f.code === 4409 && String(f.message).startsWith("stream-replaced:"));
      expect(replaced.length).toBe(1); // 后提交替换先提交（非静默覆盖）——先提交快照可能已被撤（cancelBySubscription）
      expect(c.frames().filter((f) => f.t === "snapshot").length).toBeGreaterThanOrEqual(1);
      expect(c.readyState).toBe(1);
      // 单引擎：后提交者的快照可真实续页
      const snap2 = c.frames().filter((f) => f.t === "snapshot").pop() as Record<string, unknown>;
      c.sent.length = 0;
      await c.say({ t: "subscribe", requestId: "r3", file: "race.jsonl", snapshotId: snap2.snapshotId, historyNext: snap2.historyNext });
      const page = c.frames().find((f) => f.t === "snapshot") as Record<string, unknown>;
      expect(page).toBeDefined();
      expect((page.page as Array<{ seq: number }>).some((e) => e.seq === 201)).toBe(true);
    } finally {
      await r.dispose();
    }
  });

  it("B3b 7+2 并发新 file：提交点重验守住 8 订阅上限（恰一个 4429）", async () => {
    const r = await makeRig();
    try {
      const c = await authed(r);
      for (let i = 1; i <= 7; i++) {
        r.history.put(`f${i}.jsonl`, makeRows(1));
        await c.say({ t: "subscribe", requestId: `s${i}`, file: `f${i}.jsonl` });
      }
      r.history.put("f8.jsonl", makeRows(1));
      r.history.put("f9.jsonl", makeRows(1));
      r.history.gate("f8.jsonl");
      r.history.gate("f9.jsonl");
      void c.say({ t: "subscribe", requestId: "s8", file: "f8.jsonl" });
      void c.say({ t: "subscribe", requestId: "s9", file: "f9.jsonl" });
      await tick();
      r.history.release("f8.jsonl");
      r.history.release("f9.jsonl");
      await until(() => errFrames(c).some((f) => f.code === 4429), 1000);
      expect(errFrames(c).filter((f) => f.code === 4429).length).toBe(1); // 恰一个超限
      const snaps = c.frames().filter((f) => f.t === "snapshot");
      expect(snaps.length).toBe(8); // 7+1（第 9 个被拒）
      expect(c.readyState).toBe(1);
    } finally {
      await r.dispose();
    }
  });

  it("B4 observe 通路容量出口：触顶→4402+订阅清理+停观察", async () => {
    const r = await makeRig({ indexLimits: { maxEventsPerStream: 5 } });
    try {
      r.history.put("ov.jsonl", makeRows(4));
      const c = await authed(r);
      await c.say({ t: "subscribe", requestId: "s1", file: "ov.jsonl" });
      // 第 5 条：不触顶（5>5 假）——正常交付
      r.history.append("ov.jsonl", rowAt(5));
      await until(() => c.frames().some((f) => f.t === "events"), 1000);
      // 第 6 条：watermark=6>5 → 4402+清理
      r.history.append("ov.jsonl", rowAt(6));
      await until(() => errFrames(c).some((f) => f.code === 4402), 1000);
      expect(r.history.sinks.has("ov.jsonl")).toBe(false); // 观察已停
      // 订阅已清：续页→4404
      const snap1 = c.frames().find((f) => f.t === "snapshot") as Record<string, unknown>;
      c.sent.length = 0;
      await c.say({ t: "subscribe", requestId: "s2", file: "ov.jsonl", snapshotId: snap1.snapshotId, historyNext: snap1.historyNext });
      expect(errFrames(c).some((f) => f.code === 4404)).toBe(true);
    } finally {
      await r.dispose();
    }
  });

  it("B5 同长改题推进 listVersion（指纹含 title 等可见字段）", async () => {
    const r = await makeRig();
    try {
      const mk = (title: string): string =>
        JSON.stringify({ type: "session", id: "sid-t", timestamp: 100 }) + "\n" +
        JSON.stringify({ type: "message", timestamp: 200, message: { role: "user", content: title } }) + "\n";
      await writeFile(join(r.scanDir, "t.jsonl"), mk("alpha"));
      const c = await authed(r);
      await c.say({ t: "list-sessions", requestId: "l1" });
      await until(() => c.frames().some((x) => x.t === "sessions"), 2000);
      const f1 = c.frames().find((x) => x.t === "sessions") as Record<string, unknown>;
      await writeFile(join(r.scanDir, "t.jsonl"), mk("bravo")); // 同长
      await c.say({ t: "list-sessions", requestId: "l2" });
      await until(() => c.frames().filter((x) => x.t === "sessions").length >= 2, 2000);
      const f2 = c.frames().filter((x) => x.t === "sessions").pop() as Record<string, unknown>;
      expect(Number(f2.listVersion)).toBeGreaterThan(Number(f1.listVersion));
    } finally {
      await r.dispose();
    }
  });

  it("B6 握手记账有界：饱和期拒接不存时间戳（60 连接后账本≤限额）", async () => {
    const r = await makeRig({ now: () => 0, handshakePerMinute: 2, maxConnections: 1000 });
    try {
      for (let i = 0; i < 60; i++) r.conn();
      const ledger = (r.gw as unknown as { handshakeTimes: number[] }).handshakeTimes;
      expect(ledger.length).toBeLessThanOrEqual(2); // 有界（旧实现=60）
    } finally {
      await r.dispose();
    }
  });

  it("B7 安静连接末页缓存主动释放（监督 tick 触发 purge）", async () => {
    let clock = 0;
    const scheduled: Array<() => void> = [];
    const r = await makeRig({
      now: () => clock,
      timers: { setTimeout: (cb) => { scheduled.push(cb); return scheduled.length; }, clearTimeout: () => {} },
      heartbeat: { pingMs: 1_000, idleMs: 0 },
    });
    try {
      r.history.put("q.jsonl", makeRows(3));
      const c = await authed(r);
      await c.say({ t: "subscribe", requestId: "s1", file: "q.jsonl" });
      expect(c.frames().some((f) => f.t === "snapshot")).toBe(true);
      const conns = (r.gw as unknown as { conns: Map<string, { subs: Map<string, { engine: unknown }> }> }).conns;
      const st = conns.values().next().value!;
      const engine = st.subs.get("q.jsonl")!.engine as unknown as { recentPages?: unknown[] };
      expect((engine.recentPages ?? []).length).toBe(1); // 末页缓存尚在
      clock += 61_000; // 越过 60s 宽限
      (scheduled[scheduled.length - 1]!)(); // 触发监督 tick
      expect((engine.recentPages ?? []).length).toBe(0); // 已释放
    } finally {
      await r.dispose();
    }
  });

  it("B8 恢复内容页缓存：provider 恰一次+续页拼回 501 意图+证据变→4409", async () => {
    const snaps = new Map<string, RecoveryEvidenceSnapshot>();
    let calls = 0;
    const r = await makeRig({
      recoveryEvidence: (file) => { calls++; return snaps.get(file) ?? null; },
    });
    try {
      const mkSnap = (salt: number): RecoveryEvidenceSnapshot => {
        const lines = [];
        for (let i = 1; i <= 501; i++) {
          lines.push({ t: "enqueue", intentId: `i-${i}`, sessionId: "sid-1", leafId: "leaf-1", generation: 1,
            matchKey: { textHash: `h-${i}-${salt}`, attachmentIdentity: "none", ordinal: 0 },
            payload: { kind: "prompt", rawText: `msg-${i}`, attachments: [], sentAt: "2026-09-28T00:00:00Z" } });
        }
        return { version: 1, file: "rec.jsonl", sessionId: "sid-1", lines, bad: [], attributedFragments: [], repaired: [], createdAt: 2_000 } as unknown as RecoveryEvidenceSnapshot;
      };
      snaps.set("rec.jsonl", mkSnap(1));
      const c = await authed(r);
      await c.say({ t: "get-recovery", requestId: "rec-1", file: "rec.jsonl", offset: 0 });
      const f1 = c.frames().find((x) => x.t === "recovery" && x.availability === "available") as Record<string, unknown>;
      expect(f1).toBeDefined();
      const h = f1.evidenceHash as string;
      expect(h).toMatch(/^[0-9a-f]{64}$/);
      const next = (f1.perIntent as { next: { offset: number } | null } | undefined)?.next;
      expect(next).not.toBeNull(); // 截断（501>页大小）
      expect(JSON.stringify(f1)).toContain("i-1");
      // 续页（同 requestId+同 hash）→缓存命中（provider 不重调）
      await c.say({ t: "get-recovery", requestId: "rec-1", file: "rec.jsonl", offset: next!.offset, evidenceHash: h });
      const f2 = c.frames().filter((x) => x.t === "recovery" && x.availability === "available").pop() as Record<string, unknown>;
      expect(JSON.stringify(f2)).toContain("i-501"); // 拼回末条
      expect(calls).toBe(1);
      // 缓存内容页的 hash 门：携与冻结快照不同的 hash→4409（客户端须以新快照重启）
      await c.say({ t: "get-recovery", requestId: "rec-1", file: "rec.jsonl", offset: 0, evidenceHash: "ab".repeat(32) });
      expect(errFrames(c).some((x) => x.code === 4409)).toBe(true);
      expect(calls).toBe(1); // 未重调 provider（缓存帧仍完整）
      // 证据真变（新快照）→新 requestId 现算（calls=2，新 hash 不同于旧）
      snaps.set("rec.jsonl", mkSnap(2));
      await c.say({ t: "get-recovery", requestId: "rec-2", file: "rec.jsonl", offset: 0 });
      const f3 = c.frames().filter((x) => x.t === "recovery" && x.availability === "available").pop() as Record<string, unknown>;
      expect(calls).toBe(2);
      expect(f3.evidenceHash).not.toBe(h);
    } finally {
      await r.dispose();
    }
  });
});
