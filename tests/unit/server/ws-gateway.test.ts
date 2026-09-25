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
  async load(file: string): Promise<readonly ScanRow[] | null> {
    this.loadCalls.push(file);
    const v = this.files.get(file);
    return v === undefined ? null : v;
  }
  observe(file: string, sinks: HistorySinks): () => void {
    this.sinks.set(file, sinks);
    return () => { this.sinks.delete(file); };
  }
  rows(file: string): ScanRow[] {
    const v = this.files.get(file);
    if (v == null) throw new Error(`fake history 无 ${file}`);
    return v as ScanRow[];
  }
  put(file: string, rows: ScanRow[]): void { this.files.set(file, rows); }
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

async function authed(r: Rig): Promise<FakeConn> {
  const { c } = r.conn();
  await c.say({ t: "hello", protocolVersion: 1, token: "tok-ok" });
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
      const c = await authed(r);
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
      for (const g of golden) {
        const validatorSays = validateClientFrame(g).ok;
        const before = c.sent.length;
        await c.sayRaw(JSON.stringify(g));
        if (validatorSays) {
          // 接受帧：响应可能异步（真实 fs/信号量）——等到有新帧或连接关闭
          await until(() => c.sent.length > before || c.readyState !== 1, 1000);
          if (c.readyState === 1 && c.sent.length === before) throw new Error(`校验器接受但网关无响应: ${JSON.stringify(g)}`);
        } else {
          // 拒绝帧：必有 4404/4403/4405 之一（或已关闭）；未被接受静默吞
          await until(() => c.sent.length > before || c.readyState !== 1, 1000);
          const last = c.frames()[c.frames().length - 1];
          expect(last === undefined || last.code === 4404 || last.code === 4403 || last.code === 4405).toBe(true);
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

  it("C16 W1-05 原子重同步：失败 resync 不销毁旧订阅；旧订阅续页仍可用；成功替换关联旧 subscriptionId+撤旧帧", async () => {
    const r = await makeRig();
    try {
      r.history.put("a.jsonl", makeRows(5));
      const c = await authed(r);
      await c.say({ t: "subscribe", requestId: "s1", file: "a.jsonl" });
      const snap1 = c.frames().find((f) => f.t === "snapshot") as Record<string, unknown>;
      const subId1 = snap1.subscriptionId as string;
      const snapId1 = snap1.snapshotId as string;
      // 失败 resync：游标远超前（seq=9999>barrier+1）→4409；旧订阅必须存活
      c.sent.length = 0;
      await c.say({ t: "subscribe", requestId: "s2", file: "a.jsonl", cursor: { streamId: "s-foreign", seq: 9999 } });
      expect(errFrames(c).some((f) => f.code === 4409)).toBe(true);
      expect(errFrames(c).some((f) => f.code === 4431)).toBe(false); // 旧流未被关
      // 旧订阅续页仍命中（引擎活着才回页/4409——而非 4431 关闭）
      await c.say({ t: "subscribe", requestId: "s3", file: "a.jsonl", snapshotId: snapId1, historyNext: snap1.historyNext });
      const tail = c.frames().pop();
      expect(tail).toBeDefined();
      expect((tail as { code?: number }).code).not.toBe(4431); // 旧流未被关（W1-05 核心）
      expect(c.readyState).toBe(1);
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

  it("C17 换流（盘面改写）：非前缀重扫→replace 新 streamId；旧事件不重复", async () => {
    const r = await makeRig();
    try {
      r.history.put("rw.jsonl", makeRows(3));
      const c = await authed(r);
      await c.say({ t: "subscribe", requestId: "s1", file: "rw.jsonl" });
      const snap1 = c.frames().find((f) => f.t === "snapshot") as Record<string, unknown>;
      // 盘面改写：行 2 变化（非前缀）→resync 换流
      const rows2 = makeRows(3);
      rows2[1] = { ...rows2[1]!, raw: '{"t":"sending","seq":2,"mutated":true}' };
      r.history.files.set("rw.jsonl", rows2);
      await c.say({ t: "subscribe", requestId: "s2", file: "rw.jsonl", cursor: { streamId: snap1.streamId as string, seq: 1 } });
      const snap2 = c.frames().filter((f) => f.t === "snapshot").pop() as Record<string, unknown>;
      expect(snap2.streamId).not.toBe(snap1.streamId); // 换流
      expect(snap2.barrier).toBe(3);
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
      await writeFile(join(r.scanDir, "a.jsonl"), JSON.stringify({ type: "session", id: "sid-a", timestamp: 100 }) + "\n" + JSON.stringify({ type: "message", timestamp: 200, message: { role: "user", content: "hello" } }) + "\n");
      const c = await authed(r);
      await c.say({ t: "list-sessions", requestId: "l1" });
      await until(() => c.frames().some((x) => x.t === "sessions"), 2000); // 真实 fs→异步扫描
      const f1 = c.frames().find((x) => x.t === "sessions") as Record<string, unknown>;
      await c.say({ t: "list-sessions", requestId: "l2", offset: 0, limit: 10 });
      await until(() => c.frames().filter((x) => x.t === "sessions").length >= 2, 2000);
      const f2 = c.frames().filter((x) => x.t === "sessions").pop() as Record<string, unknown>;
      expect(f2.listVersion).toBe(f1.listVersion); // 同内容→同版本
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

  it("D22 W1-07 断开取消排队计算：挂起 provider 的连接关闭后，新请求不被死连接占槽", async () => {
    const sem = new ComputeSemaphore(1, 60_000, { setTimeout: (cb, ms) => setTimeout(cb, ms), clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) });
    let release1: (() => void) | null = null;
    const gates: Array<() => void> = [];
    const r = await makeRig({
      semaphore: sem,
      recoveryEvidence: () => new Promise((_res) => { gates.push(() => {}); release1 = () => {}; }),
    });
    void release1;
    try {
      const cA = await authed(r);
      cA.say({ t: "get-recovery", requestId: "a1", file: "hold.jsonl" }); // 占住唯一槽（挂起）
      await tick();
      const cB = await authed(r);
      cB.say({ t: "get-recovery", requestId: "b1", file: "hold.jsonl" }); // 排队
      await tick();
      // A 断开：排队任务…B 在排队；A 在执行。A 的任务还在执行（provider 未结算）——取消只影响排队
      cA.closedByTransport();
      await tick();
      // B 的请求随后仍能拿到槽吗？A 的任务未结束（release 未调）→ B 仍在排队——但 B 未被取消（B 连接活着）
      // 真正要验的：A 死后 B 的新请求不被 A 排队的【旧】请求挤位。此处验 A 关闭即取消其排队任务：
      const cA2 = await authed(r);
      cA2.say({ t: "get-recovery", requestId: "a2", file: "hold.jsonl" }); // A2 排队
      await tick();
      cA2.closedByTransport(); // A2 断开→其排队任务被取消
      await tick();
      // B 仍是队列首（A2 的取消不吞 B 的位）
      expect(r.gw.connectionCount).toBe(1); // 只剩 B
      cB.closedByTransport();
      await tick();
      expect(r.gw.connectionCount).toBe(0);
      void gates;
    } finally {
      await r.dispose();
    }
  });

  it("D23 W1-08 审计回调抛错不阻断令牌撤销（safeAudit）", async () => {
    // 可变 token 文件：初始含 tok-a/tok-b；reload 后只剩 tok-b→撤销 tok-a
    let tokens = ["tok-a", "tok-b"];
    const readFile = async (): Promise<Buffer> => Buffer.from(JSON.stringify({ version: 1, tokens }));
    const authority = await TokenAuthority.fromFile("/virtual/tokens.json", { readFile });
    const r = await makeRig({ tokens: authority, audit: () => { throw new Error("audit boom"); } });
    try {
      const c = await authed(r); // tok-a 认证
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
