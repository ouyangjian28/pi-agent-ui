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
import { WsGateway, type ConnMeta, type GatewayConnHooks, type HistoryInvalidateReason, type HistorySinks, type HistorySourcePort, type HistoryUnavailableReason, type WsGatewayOpts } from "../../../apps/server/src/ws/ws-gateway.ts";
import { TokenAuthority } from "../../../apps/server/src/ws/token-auth.ts";
import { FileHistorySource, type HistoryReaderPort, type HistoryWatcherPort } from "../../../apps/server/src/runtime/history-source.ts";
import { DualHistorySource } from "../../../apps/server/src/runtime/dual-history-source.ts";
import { ComputeSemaphore } from "../../../apps/server/src/ws/compute-semaphore.ts";
import type { RecoveryEvidenceSnapshot, BadJournalEntry } from "../../../apps/server/src/runtime/recover.ts";
import type { ScanRow } from "@pi-agent-ui/protocol";
import { matchKeyOf, validateClientFrame } from "@pi-agent-ui/protocol";

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
  releaseCalls: string[] = [];
  /** R3 身份门探针：observe 可返 null（换代竞态），触发 observe-missed 路径 */
  failNextObserve = false;
  /** 3b2c-B4 探针：observe 右侧在返回 stop 前同步回调 onUnavailable（同步终止） */
  syncUnavailableOnObserve = false;
  /** 3b2e-C3 探针（GPT 3b2d D8）：observe 同步终止且返回 null——从未建立观察绑定 */
  syncNullOnObserve = false;
  /** 3b2e-C3 变体：同步 onInvalidate("replace") 且返回 null */
  syncNullOnInvalidateOnObserve = false;
  /** 3b2c-B4：stop 闭包调用计数（孤儿 stop 是否被即停） */
  readonly stopped: string[] = [];
  /** B3：受控挂起——文件名命中时 load 等待对应 resolver（造 await 窗口） */
  gates = new Map<string, () => void>();
  async load(file: string): Promise<readonly ScanRow[] | null> {
    this.loadCalls.push(file);
    const gate = this.gates.get(file);
    if (gate !== undefined) await new Promise<void>((res) => { this.gates.set(file, () => { gate(); res(); }); });
    const v = this.files.get(file);
    return v === undefined ? null : v;
  }
  private observeGate(): boolean { if (this.failNextObserve) { this.failNextObserve = false; return false; } return true; }
  observe(file: string, sinks: HistorySinks): (() => void) | null {
    this.observeCalls.push(file);
    if (!this.observeGate()) return null; // R1：无活跃代可绑（换代竞态）
    this.sinks.set(file, sinks);
    if (this.syncUnavailableOnObserve) sinks.onUnavailable?.("deleted"); // B4：赋值返回前同步终止
    if (this.syncNullOnObserve) { sinks.onUnavailable?.("deleted"); return null; } // C3/D8：同步终止+无绑定
    if (this.syncNullOnInvalidateOnObserve) { sinks.onInvalidate?.("replace"); return null; } // C3 变体
    return () => { this.stopped.push(file); this.sinks.delete(file); };
  }
  release(file: string): void { this.releaseCalls.push(file); }
  rows(file: string): ScanRow[] {
    const v = this.files.get(file);
    if (v == null) throw new Error(`fake history 无 ${file}`);
    return v as ScanRow[];
  }
  put(file: string, rows: ScanRow[]): void { this.files.set(file, rows); }
  /** B3：挂起闸门——首次调用返回闸门对象，再调才放行（同一文件后续 load 立即过）。 */
  gate(file: string): void { this.gates.set(file, () => {}); }
  openGate(file: string): void { const g = this.gates.get(file); if (g) { g(); this.gates.delete(file); } }
  missing(file: string): void { this.files.set(file, null); }
  append(file: string, row: ScanRow): void {
    this.rows(file).push(row);
    this.sinks.get(file)?.onAppend(row);
  }
  live(file: string, ev: Parameters<HistorySinks["onLive"]>[0]): void {
    this.sinks.get(file)?.onLive(ev);
  }
  /** 3b-2：源盘面失效/不可用触发器（走真源回调面） */
  invalidate(file: string, reason: HistoryInvalidateReason): void {
    this.sinks.get(file)?.onInvalidate?.(reason);
  }
  unavailable(file: string, reason: HistoryUnavailableReason): void {
    this.sinks.get(file)?.onUnavailable?.(reason);
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
  conn(meta?: Partial<ConnMeta>): { c: FakeConn; handle: { id: string } };
  roots: string;
  scanDir: string;
  evidence: Map<string, RecoveryEvidenceSnapshot | null>;
  history: FakeHistory;
  audits: string[];
  dispose(): Promise<void>;
}

async function makeRig(over: Partial<WsGatewayOpts> = {}): Promise<Rig> {
  const d = await mkdtemp(join(tmpdir(), "ws-gw-"));
  const evidence = new Map<string, RecoveryEvidenceSnapshot | null>();
  const history = new FakeHistory();
  const audits: string[] = [];
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
    audit: (l) => { audits.push(l); },
    ...over,
  });
  const conn = (meta?: Partial<ConnMeta>) => {
    const c = new FakeConn();
    const handle = gw.attach(c, c.hooks(), { origin: "http://localhost:5173", loopback: true, tls: false, ...meta } satisfies ConnMeta);
    return { c, handle };
  };
  return { gw, conn, roots: d, scanDir: d, evidence, history, audits, dispose: async () => { gw.dispose(); await rm(d, { recursive: true, force: true }); } };
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
      const w = c.frames().find((f) => f.t === "welcome") as { serverBuildId?: string };
      expect(typeof w?.serverBuildId === "string" && w.serverBuildId.length > 0).toBe(true); // R6/3b-1：代码/构建身份
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

  it("A6 R6/3b-1：per-IP 认证失败限速——同 IP 达限→正确令牌也拒；不同 IP 不受累（键控非全局）；审计可观测", async () => {
    const audits: string[] = [];
    const r = await makeRig({ authRate: { limit: 2, windowMs: 10_000, baseBlockMs: 5_000, maxBlockMs: 10_000 }, audit: (l) => audits.push(l) });
    try {
      for (let i = 0; i < 2; i++) {
        const { c } = r.conn({ clientIp: "1.1.1.1" });
        await c.say({ t: "hello", protocolVersion: 1, token: "bad" });
      }
      expect(audits.some((l) => l.includes("auth-rate-blocked ip=1.1.1.1"))).toBe(true);
      // 同 IP 第三次：正确令牌也拒（封锁内不查令牌）
      const c3 = r.conn({ clientIp: "1.1.1.1" }).c;
      await c3.say({ t: "hello", protocolVersion: 1, token: "tok-ok" });
      const err = c3.frames().find((f) => f.t === "error") as { code?: number; message?: string };
      expect(err?.code).toBe(4401);
      expect(String(err?.message)).toContain("限速");
      expect(lastClose(c3)?.[0]).toBe(1008);
      // 不同 IP：不受累（per-IP 键控非全局封锁）
      const other = r.conn({ clientIp: "2.2.2.2" }).c;
      await other.say({ t: "hello", protocolVersion: 1, token: "tok-ok" });
      expect(other.frames().some((f) => f.t === "welcome")).toBe(true);
    } finally {
      await r.dispose();
    }
  });

  it("A5 入站管线：二进制→4403+close 1003（R4/3b-1 契约冻结映射）；非 JSON/未知 t→4404；写类→4405+close 1008；3×4404→close 1002；错误消息固定不回显", async () => {
    const r = await makeRig();
    try {
      const c = await authed(r);
      await c.sayBinary();
      expect(c.frames().some((f) => f.code === 4403)).toBe(true); // R4：协议违规非帧错误
      expect(lastClose(c)?.[0]).toBe(1003); // 4403→close 1003
      // 新连接：非 JSON/未知 t 两式 4404（不叠加二进制）
      const c2 = await authed(r);
      await c2.sayRaw("{nope");
      await c2.say({ t: "totally-unknown", requestId: "x".repeat(300) }); // 恶意超长 t 不回显
      const errs = errFrames(c2);
      expect(errs.length).toBe(2);
      expect(errs.every((f) => !String(f.message).includes("totally-unknown"))).toBe(true); // 固定消息
      await c2.sayRaw("{nope2"); // 第三式 4404→计数 3→close 1002
      expect(lastClose(c2)?.[0]).toBe(1002);
      // 写类（新连接）
      const c3 = await authed(r);
      await c3.say({ t: "prompt", requestId: "r1", message: "hi" });
      expect(c3.frames().some((f) => f.code === 4405)).toBe(true);
      expect(lastClose(c3)?.[0]).toBe(1008); // 4405→close 1008
    } finally {
      await r.dispose();
    }
  });

  it("A6 B1/3b1b：封锁期不记账不延长（跨窗正确/错误令牌均不改 blockedUntil/strikes）；到期后恢复", async () => {
    let t = 0;
    const audits: string[] = [];
    const r = await makeRig({
      now: () => t,
      handshakePerMinute: 1000,
      authRate: { limit: 2, windowMs: 10_000, baseBlockMs: 60_000, maxBlockMs: 600_000 },
      audit: (l) => audits.push(l),
    });
    try {
      const bad = (ip: string): void => { void r.conn({ clientIp: ip }).c.say({ t: "hello", protocolVersion: 1, token: "bad" }); };
      t = 0; bad("1.1.1.1"); bad("1.1.1.1"); // 首轮：strikes=1 → blockedUntil=60000
      expect(audits.some((l) => l.includes("auth-rate-blocked ip=1.1.1.1 strikes=1"))).toBe(true);
      t = 60_001; bad("1.1.1.1"); bad("1.1.1.1"); // 跨窗二轮：strikes=2 → blockedUntil=180001
      expect(audits.some((l) => l.includes("auth-rate-blocked ip=1.1.1.1 strikes=2"))).toBe(true);
      // 封锁期内（t=120002<180001）：正确令牌也拒，但不得再记账/延长（旧实现在此推到 strikes=3/blockedUntil=360002）
      t = 120_002;
      for (let i = 0; i < 10; i++) {
        const ok = r.conn({ clientIp: "1.1.1.1" }).c;
        await ok.say({ t: "hello", protocolVersion: 1, token: "tok-ok" });
        expect(ok.frames().some((f) => f.t === "error" && (f as { code?: number }).code === 4401)).toBe(true);
      }
      const blockedAudits = audits.filter((l) => l.includes("auth-rate-blocked ip=1.1.1.1 strikes="));
      expect(blockedAudits.length).toBe(2); // 无 strikes=3（封锁内不记账）
      const untilAudits = audits.filter((l) => l.includes("hello-auth-rate-blocked"));
      expect(untilAudits.every((l) => !l.includes("until=360002"))).toBe(true); // blockedUntil 未被延长
      // 到期后（t=180002）：正确令牌恢复 welcome
      t = 180_002;
      const rec = r.conn({ clientIp: "1.1.1.1" }).c;
      await rec.say({ t: "hello", protocolVersion: 1, token: "tok-ok" });
      expect(rec.frames().some((f) => f.t === "welcome")).toBe(true);
    } finally {
      await r.dispose();
    }
  });

  it("A6 B2/3b1b：满表硬上界——全封锁时按最早到期显式淘汰+审计（不静默丢也不无界增长）", async () => {
    let t = 0;
    const audits: string[] = [];
    const r = await makeRig({
      now: () => t,
      handshakePerMinute: 5000,
      maxConnections: 5000,
      authRate: { limit: 1, windowMs: 10_000, baseBlockMs: 600_000, maxBlockMs: 600_000 },
      audit: (l) => audits.push(l),
    });
    try {
      // 1024 个不同 IP 各一次失败（limit=1：首败即封锁），时钟逐条递增 1ms → blockedUntil 严格递增（可断言淘汰对象）
      for (let i = 1; i <= 1024; i++) {
        t = i;
        const c = r.conn({ clientIp: `10.0.${Math.floor(i / 250)}.${(i % 250) + 1}` }).c;
        await c.say({ t: "hello", protocolVersion: 1, token: "bad" });
      }
      expect(audits.filter((l) => l.includes("auth-rate-blocked")).length).toBe(1024);
      expect(audits.some((l) => l.includes("auth-rate-table-evict-blocked"))).toBe(false); // 未满表前不淘汰
      // C2（3b1c）：断言真实容量而非仅审计——白盒读表，容量是 set 前硬条件（去 delete 只留审计的变异必须被杀）
      const table = (): number => (r.gw as unknown as { authFailures: Map<string, unknown> }).authFailures.size;
      expect(table()).toBe(1024);
      // 第 1025 个新 IP：满表+全封锁 → 显式淘汰最早到期者（t=1 的 ip=10.0.0.2，until=600001）+审计；容量仍 1024
      t = 1_030;
      const c25 = r.conn({ clientIp: "20.0.0.1" }).c;
      await c25.say({ t: "hello", protocolVersion: 1, token: "bad" });
      const evict = audits.find((l) => l.includes("auth-rate-table-evict-blocked"));
      expect(evict).toBeDefined();
      expect(evict).toMatch(/ip=10\.0\.0\.2 until=600001 size=1024/); // 淘汰对象=最早到期（非任意/非最新）
      expect(table()).toBe(1024); // 真实容量不增（M-B2-delete 变异在此暴露：无 delete 则 1025）
      expect(audits.some((l) => l.includes("auth-rate-blocked ip=20.0.0.1"))).toBe(true); // 新观测照常记账
      // 部分过期与活动封锁共存：t=600002 → 仅 i≤2（blockedUntil≤600002）过期；满表新 IP 走非封锁淘汰分支
      t = 600_002;
      const c26 = r.conn({ clientIp: "30.0.0.1" }).c;
      await c26.say({ t: "hello", protocolVersion: 1, token: "bad" });
      expect(audits.filter((l) => l.includes("auth-rate-table-evict-blocked")).length).toBe(1); // 淘汰审计数不增（走非封锁分支）
      expect(table()).toBe(1024);
      expect(audits.some((l) => l.includes("auth-rate-blocked ip=30.0.0.1"))).toBe(true);
      // 活动封锁保留：i=1024（blockedUntil=601024>600002 仍封锁）的正确令牌 hello 也拒（4401）
      const cLate = r.conn({ clientIp: "10.0.4.25" }).c; // i=1024 → 10.0.4.25
      await cLate.say({ t: "hello", protocolVersion: 1, token: "tok-ok" });
      expect(cLate.frames().some((f) => f.t === "error" && (f as { code?: number }).code === 4401)).toBe(true);
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
          // w1c 收紧：校验器接受→网关必有响应帧（连接关闭不再作逃生）
          if (cc.sent.length === before) throw new Error(`#${idx} 校验器接受但网关无响应: ${JSON.stringify(g)}`);
        } else {
          // w1c 收紧：拒绝帧最后一帧必为 4403/4404/4405（readyState 逃生删除）
          const last = cc.frames()[cc.frames().length - 1];
          expect(last !== undefined && (last.code === 4404 || last.code === 4403 || last.code === 4405)).toBe(true);
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
      // R2：s2 的 syncIndex 已换流并退役本连接旧订阅——4409 stream-replaced:${旧subscriptionId}
      expect(errFrames(c).some((f) => f.code === 4409 && String(f.message).includes("stream-replaced:" + (snap1.subscriptionId as string)))).toBe(true);
      // 重新 init：新流可用，barrier 重读
      c.sent.length = 0;
      await c.say({ t: "subscribe", requestId: "s3", file: "rw.jsonl" });
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
      // 换流证据：isPrefixOf 对 [source,locator,raw] 摘要比较——改 raw 即触发 replace；
      // 本用例改 event.ts 使扫描行内容真变（scanDigest 含 raw，重扫产出新行）→非前缀→换流
      rows2[1] = { ...rows2[1]!, event: { ...rows2[1]!.event, ts: 9_999 } };
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
      // R2 语义：换流退役把旧 refs 清空→unobserve；新订阅者 attach 时 watchFile 重建观察器（calls=2）。
      // 观察重建窗口的盘面新增行由 3b 真源 observe 语义（重扫补齐）承担——受控替身不模拟该窗口。
      expect(r.history.observeCalls.filter((f) => f === "b2.jsonl").length).toBe(2);
      // R2（w1c）：换流退役——c1 旧订阅收 4409 stream-replaced:${旧subscriptionId}（非新流事件）；
      // 旧引擎不再接收新流坐标的 seq4（跨流不串染）
      await until(() => errFrames(c1).some((f) => f.code === 4409 && String(f.message) === `stream-replaced:${snap1.subscriptionId}`), 1000);
      expect(c1.frames().some((f) => f.t === "events" && ((f.events as Array<{ seq: number }> | undefined) ?? []).some((e: { seq: number }) => e.seq === 4))).toBe(false);
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
      r.history.openGate("race.jsonl"); // 两 load 同时放行
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
      r.history.openGate("f8.jsonl");
      r.history.openGate("f9.jsonl");
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
      // 订阅已清+R3 统一容量出口：合法游标重订阅→4402（旧断言用 snapshotId 非法形态被校验器先拒=假绿）
      const snap1 = c.frames().find((f) => f.t === "snapshot") as Record<string, unknown>;
      c.sent.length = 0;
      await c.say({ t: "subscribe", requestId: "s2", file: "ov.jsonl", cursor: { streamId: snap1.streamId as string, seq: 1 } });
      expect(errFrames(c).some((f) => f.code === 4402 && String(f.message).includes("超预算"))).toBe(true);
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
    const scheduled: Array<(() => void) | undefined> = [];
    const r = await makeRig({
      now: () => clock,
      timers: {
        setTimeout: (cb) => { scheduled.push(cb as () => void); return scheduled.length; },
        clearTimeout: (t) => { const i = t as number; if (i >= 1 && i <= scheduled.length) scheduled[i - 1] = undefined; },
      },
      // ping 关闭：否则 tick 的 ping 帧→drain()→内部 purgeExpiredPages 会掩盖监督 purge 本身
      heartbeat: { pingMs: 0, idleMs: 0 },
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
      // 快照 [0]=auth 截止（hello 已 clearTimeout→undefined）、[1]=监督 tick、[2]=订阅期 pump drain
      // 只触发 tick：pump 的 drain() 首行也 purgeExpiredPages，混发会掩盖监督 purge 本身
      expect(scheduled.filter(Boolean).length).toBe(2);
      (scheduled[1] as () => void)(); // 触发监督 tick
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
      type Page = { items: Array<{ intentId: string }>; total: number; next: { offset: number } | null };
      const p1 = (f1.perIntent as Page);
      expect(p1.next).not.toBeNull(); // 截断（501>页大小）
      expect(p1.total).toBe(501); // 全集权威计数
      expect(p1.items.length).toBeGreaterThan(0);
      expect(p1.items[0]!.intentId).toBe("i-1");
      // w1d 收紧：直接拼 perIntent.items 数组断言（JSON 扫描同 ID 重复多次仍计数=不能证无缺无重）
      // 续页（同 requestId+同 hash）→缓存命中（provider 不重调）
      await c.say({ t: "get-recovery", requestId: "rec-1", file: "rec.jsonl", offset: p1.next!.offset, evidenceHash: h });
      const f2 = c.frames().filter((x) => x.t === "recovery" && x.availability === "available").pop() as Record<string, unknown>;
      const p2 = f2.perIntent as Page;
      expect(p2.next).toBeNull(); // 末页收口
      expect(p2.items[p2.items.length - 1]!.intentId).toBe("i-501"); // 拼回末条
      const ids = [...p1.items, ...p2.items].map((x) => x.intentId);
      expect(ids.length).toBe(501); // 两页拼回恰 501 条（无缺）
      expect(new Set(ids).size).toBe(501); // 无重
      // 完整集合对照（长度+唯一数+首末条仍不能证中间恰为期望集——与 i-1..i-501 全集比对）
      const remain = new Set(Array.from({ length: 501 }, (_, i) => `i-${i + 1}`));
      for (const id of ids) remain.delete(id);
      expect(remain.size).toBe(0);
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

describe("ws-gateway w1c：R 系阻断回归", () => {
  it("R1a 空流身份：已装载空流 resync seq1 受理（H+1 追平）；foreign 仍拒", async () => {
    const r = await makeRig();
    try {
      r.history.put("empty.jsonl", []);
      const c = await authed(r);
      await c.say({ t: "subscribe", requestId: "s1", file: "empty.jsonl" });
      const snap = c.frames().find((f) => f.t === "snapshot") as Record<string, unknown>;
      expect(snap).toBeDefined();
      expect((snap.page as unknown[]).length).toBe(0); // 空流 barrier=0
      const sid = snap.streamId as string;
      // 空流同身份 seq∈[1,H+1]=[1,1] → 受理（不得 4404「空流误判」）
      c.sent.length = 0;
      await c.say({ t: "subscribe", requestId: "s2", file: "empty.jsonl", cursor: { streamId: sid, seq: 1 } });
      expect(errFrames(c).some((f) => f.code === 4404)).toBe(false);
      const catchUp = c.frames().filter((f) => f.t === "snapshot").pop() as Record<string, unknown>;
      expect(catchUp).toBeDefined(); // 追平帧（空页+barrier）
      // foreign 仍拒（不得凭请求任意创建流身份）
      c.sent.length = 0;
      await c.say({ t: "subscribe", requestId: "s3", file: "empty.jsonl", cursor: { streamId: "s-foreign", seq: 1 } });
      expect(errFrames(c).some((f) => f.code === 4404)).toBe(true);
    } finally {
      await r.dispose();
    }
  });

  it("R1b 空流后追加：同坐标续读（live seq1 交付）", async () => {
    const r = await makeRig();
    try {
      r.history.put("empty2.jsonl", []);
      const c = await authed(r);
      await c.say({ t: "subscribe", requestId: "s1", file: "empty2.jsonl" });
      await until(() => c.frames().some((f) => f.t === "snapshot"), 1000);
      r.history.append("empty2.jsonl", rowAt(1));
      await until(() => c.frames().some((f) => f.t === "events"), 1000);
      const ev = c.frames().find((f) => f.t === "events") as { events: Array<{ seq: number }> };
      expect(ev.events.some((e) => e.seq === 1)).toBe(true); // 空流首条=seq1（统一坐标）
    } finally {
      await r.dispose();
    }
  });

  it("R2a 分页中换流：旧订阅 4409 退役+不收新流事件+旧游标 4404+重新 init 可用", async () => {
    const r = await makeRig();
    try {
      r.history.put("rw2.jsonl", makeRows(205));
      const cA = await authed(r);
      await cA.say({ t: "subscribe", requestId: "a1", file: "rw2.jsonl" });
      const snapA = cA.frames().find((f) => f.t === "snapshot") as Record<string, unknown>;
      expect((snapA.page as unknown[]).length).toBe(200); // 首页 200（截断）
      const subA = snapA.subscriptionId as string;
      // 盘面改写（行 2 事件真变+行数缩到 3）
      const rows2 = makeRows(3);
      rows2[1] = { ...rows2[1]!, event: { ...rows2[1]!.event, ts: 9_999 } };
      r.history.files.set("rw2.jsonl", rows2 as unknown as ScanRow[]);
      const cB = await authed(r);
      await cB.say({ t: "subscribe", requestId: "b1", file: "rw2.jsonl" });
      // A 收 4409 stream-replaced:${subA}（非新流事件）
      await until(() => errFrames(cA).some((f) => f.code === 4409 && String(f.message) === `stream-replaced:${subA}`), 1000);
      const snapB = cB.frames().find((f) => f.t === "snapshot") as Record<string, unknown>;
      expect(snapB.streamId).not.toBe(snapA.streamId);
      // 换流后追加：新流事件只到新订阅者（旧引擎不接收新坐标）
      r.history.append("rw2.jsonl", rowAt(4));
      await until(() => cB.frames().some((f) => f.t === "events" && f.origin === "history"), 1000);
      await tick(); await tick(); await tick(); // 稳定窗口：A 不得收到新流 seq4
      expect(cA.frames().some((f) => f.t === "events" && ((f.events as Array<{ seq: number }> | undefined) ?? []).some((e) => e.seq === 4))).toBe(false);
      // A 旧游标续页→4404（流身份已变，不按位置映射）
      cA.sent.length = 0;
      await cA.say({ t: "subscribe", requestId: "a2", file: "rw2.jsonl", cursor: { streamId: snapA.streamId as string, seq: 201 } });
      expect(errFrames(cA).some((f) => f.code === 4404)).toBe(true);
      // A 重新 init：新流可用（barrier=3）
      cA.sent.length = 0;
      await cA.say({ t: "subscribe", requestId: "a3", file: "rw2.jsonl" });
      const snapA2 = cA.frames().filter((f) => f.t === "snapshot").pop() as Record<string, unknown>;
      expect(snapA2.streamId).toBe(snapB.streamId);
      expect(snapA2.barrier).toBe(4); // 改写 3 行+追加 1 条=4（重扫全量）
    } finally {
      await r.dispose();
    }
  });

  it("R2b 双连接 live 换流：两旧订阅均退役；新流事件仅新订阅者收", async () => {
    const r = await makeRig();
    try {
      r.history.put("rw3.jsonl", makeRows(3));
      const c1 = await authed(r);
      const c2 = await authed(r);
      await c1.say({ t: "subscribe", requestId: "p1", file: "rw3.jsonl" });
      await c2.say({ t: "subscribe", requestId: "p2", file: "rw3.jsonl" });
      const s1 = c1.frames().find((f) => f.t === "snapshot") as Record<string, unknown>;
      const s2 = c2.frames().find((f) => f.t === "snapshot") as Record<string, unknown>;
      const rows2 = makeRows(3);
      // 换流须改 raw（isPrefixOf 对 [source,locator,raw] 摘要比较——只改 event 不触发 replace）
      rows2[0] = { ...rows2[0]!, raw: '{"t":"sending","seq":1,"mutated":true}' };
      r.history.files.set("rw3.jsonl", rows2 as unknown as ScanRow[]);
      const c3 = await authed(r);
      await c3.say({ t: "subscribe", requestId: "p3", file: "rw3.jsonl" });
      await until(() => errFrames(c1).some((f) => f.code === 4409) && errFrames(c2).some((f) => f.code === 4409), 1000);
      const s3 = c3.frames().find((f) => f.t === "snapshot") as Record<string, unknown>;
      expect(s3.streamId).not.toBe(s1.streamId);
      expect(s3.streamId).not.toBe(s2.streamId);
      r.history.append("rw3.jsonl", rowAt(4));
      await until(() => c3.frames().some((f) => f.t === "events" && f.origin === "history"), 1000);
      await tick(); await tick(); await tick();
      for (const c of [c1, c2]) {
        expect(c.frames().some((f) => f.t === "events")).toBe(false); // 旧订阅从未收到新流事件
      }
    } finally {
      await r.dispose();
    }
  });

  it("R3a 初装触顶：三连 init（宽容换流+registry 拒建路径）统一 4402 无快照；observe 追加面归 Q6 例", async () => {
    const r = await makeRig({ indexLimits: { maxEventsPerStream: 5 } });
    try {
      r.history.put("big.jsonl", makeRows(6));
      const c = await authed(r);
      await c.say({ t: "subscribe", requestId: "s1", file: "big.jsonl" });
      expect(errFrames(c).some((f) => f.code === 4402 && String(f.message).includes("超预算"))).toBe(true);
      expect(c.frames().some((f) => f.t === "snapshot")).toBe(false); // 不发绑定超限索引的快照
      expect(c.readyState).toBe(1);
      // 第二次 init：get 首次宽容（删旧标+新空索引）→ 重装 6 行仍触顶 → 同样 4402
      c.sent.length = 0;
      await c.say({ t: "subscribe", requestId: "s2", file: "big.jsonl" });
      expect(errFrames(c).some((f) => f.code === 4402 && String(f.message).includes("超预算"))).toBe(true);
      expect(c.frames().some((f) => f.t === "snapshot")).toBe(false);
      // 第三次 init：registry 拒建路径（hit 触顶+已标记→get 抛 FileOverBudgetError）→ sentinel→4402
      c.sent.length = 0;
      await c.say({ t: "subscribe", requestId: "s3", file: "big.jsonl" });
      expect(errFrames(c).some((f) => f.code === 4402 && String(f.message).includes("超预算"))).toBe(true);
      expect(c.frames().some((f) => f.t === "snapshot")).toBe(false);
      // D2（w1d）：4402 容量错 retryable=true（契约 §5.3——换流/冷凉后可重订阅）；连接存活
      expect(errFrames(c).some((f) => f.code === 4402 && f.retryable === true)).toBe(true);
      expect(c.readyState).toBe(1);
      // 注：observe 迟到回调的 FileOverBudgetError 吸收证明移至 w1d D1c/Q6 例（本例初装被拒未挂观察器，observe 追加为空观测）
    } finally {
      await r.dispose();
    }
  });

  it("R4a 无 hash 同 requestId=读当前：现取新快照覆盖缓存；携旧 hash→4409", async () => {
    const snaps = new Map<string, RecoveryEvidenceSnapshot>();
    let calls = 0;
    const r = await makeRig({ recoveryEvidence: (file) => { calls++; return snaps.get(file) ?? null; } });
    try {
      const mkSnap = (salt: number): RecoveryEvidenceSnapshot => {
        const lines = [];
        for (let i = 1; i <= 3; i++) {
          lines.push({ t: "enqueue", intentId: `i-${i}`, sessionId: "sid-1", leafId: "leaf-1", generation: 1,
            matchKey: { textHash: `h-${i}-${salt}`, attachmentIdentity: "none", ordinal: 0 },
            payload: { kind: "prompt", rawText: `msg-${i}`, attachments: [], sentAt: "2026-09-28T00:00:00Z" } });
        }
        return { version: 1, file: "q.jsonl", sessionId: "sid-1", lines, bad: [], attributedFragments: [], repaired: [], createdAt: 2_000 } as unknown as RecoveryEvidenceSnapshot;
      };
      snaps.set("q.jsonl", mkSnap(1));
      const c = await authed(r);
      await c.say({ t: "get-recovery", requestId: "q1", file: "q.jsonl", offset: 0 }); // 无 hash
      const f1 = c.frames().find((x) => x.t === "recovery" && x.availability === "available") as Record<string, unknown>;
      const h1 = f1.evidenceHash as string;
      expect(calls).toBe(1);
      // 证据前进；同 requestId 无 hash 复读→必须现取（不得回旧投影）
      snaps.set("q.jsonl", mkSnap(2));
      await c.say({ t: "get-recovery", requestId: "q1", file: "q.jsonl", offset: 0 });
      const f2 = c.frames().filter((x) => x.t === "recovery" && x.availability === "available").pop() as Record<string, unknown>;
      expect(calls).toBe(2); // provider 重调
      expect(f2.evidenceHash).not.toBe(h1); // 新快照
      // 携旧 hash 续页→缓存上下文已是新版本→4409（客户端须以新快照重启）
      await c.say({ t: "get-recovery", requestId: "q1", file: "q.jsonl", offset: 0, evidenceHash: h1 });
      expect(errFrames(c).some((f) => f.code === 4409)).toBe(true);
      expect(calls).toBe(2); // 未重调（缓存 hash 门拒绝）
    } finally {
      await r.dispose();
    }
  });

  it("R4b 缓存有界驱逐：第 9 个缓存驱逐最旧；被逐条目重读→provider 重调+offset0 现算（跨页续读归 B8 面）", async () => {
    const snaps = new Map<string, RecoveryEvidenceSnapshot>();
    let calls = 0;
    const r = await makeRig({ recoveryEvidence: (file) => { calls++; return snaps.get(file) ?? null; } });
    try {
      const mkSnap = (): RecoveryEvidenceSnapshot => {
        const lines = [];
        for (let i = 1; i <= 3; i++) {
          lines.push({ t: "enqueue", intentId: `i-${i}`, sessionId: "sid-1", leafId: "leaf-1", generation: 1,
            matchKey: { textHash: `h-${i}`, attachmentIdentity: "none", ordinal: 0 },
            payload: { kind: "prompt", rawText: `msg-${i}`, attachments: [], sentAt: "2026-09-28T00:00:00Z" } });
        }
        return { version: 1, file: "ev.jsonl", sessionId: "sid-1", lines, bad: [], attributedFragments: [], repaired: [], createdAt: 2_000 } as unknown as RecoveryEvidenceSnapshot;
      };
      snaps.set("ev.jsonl", mkSnap());
      const c = await authed(r);
      const hashes: string[] = [];
      for (let i = 1; i <= 9; i++) {
        await c.say({ t: "get-recovery", requestId: `e${i}`, file: "ev.jsonl", offset: 0 });
        const f = c.frames().filter((x) => x.t === "recovery" && x.availability === "available").pop() as Record<string, unknown>;
        hashes.push(f.evidenceHash as string);
      }
      expect(new Set(hashes).size).toBe(1); // 同快照同 hash
      expect(calls).toBe(9);
      // e1 已被驱逐（LRU 上限 8）：携其 hash 续页→缓存 miss→provider 重调+重建
      await c.say({ t: "get-recovery", requestId: "e1", file: "ev.jsonl", offset: 0, evidenceHash: hashes[0] });
      const f = c.frames().filter((x) => x.t === "recovery" && x.availability === "available").pop() as Record<string, unknown>;
      expect(calls).toBe(10); // 重调
      expect(JSON.stringify(f)).toContain("i-1"); // offset0 现算含首条（非缓存拼回）
      expect(f.evidenceHash).toBe(hashes[0]); // hash 匹配（快照未变）
    } finally {
      await r.dispose();
    }
  });
});

describe("ws-gateway w1d：D 系阻断回归", () => {
  it("D1a LRU 挤出协调：第 5 流挤出 f0→旧订阅 4409 退役+撤观察引用；旧游标 4404；重新 init=新流全量快照", async () => {
    const audits: string[] = [];
    const r = await makeRig({ registryMaxStreams: 4, audit: (l) => { audits.push(l); } });
    try {
      const files = ["d0.jsonl", "d1.jsonl", "d2.jsonl", "d3.jsonl", "d4.jsonl"];
      for (const f of files) r.history.put(f, makeRows(2));
      const c = await authed(r);
      await c.say({ t: "subscribe", requestId: "r0", file: "d0.jsonl" });
      const snap0 = c.frames().find((x) => x.t === "snapshot") as Record<string, unknown>;
      const s0 = snap0.streamId as string;
      const sub0 = snap0.subscriptionId as string;
      // 装载第 5 流（d4）→registry 挤出最旧 d0→流身份静默丢失必须协调旧持有者
      for (let i = 1; i <= 4; i++) {
        await c.say({ t: "subscribe", requestId: `r${i}`, file: files[i]! });
      }
      await until(() => c.frames().some((x) => x.code === 4409));
      expect(c.frames().some((x) => x.code === 4409 && String(x.message) === `stream-replaced:${sub0}`)).toBe(true);
      expect(r.history.sinks.has("d0.jsonl")).toBe(false); // 撤观察引用（unobserve）
      expect(audits.some((l) => l.includes("index-dropped") && l.includes("file=d0.jsonl") && l.includes("reason=lru") && l.includes("retired=1"))).toBe(true);
      // 旧流分页旧游标→4404（挤出后无已知流身份，不得凭请求任意创建）
      await c.say({ t: "subscribe", requestId: "rp0", file: "d0.jsonl", cursor: { streamId: s0, seq: 1 } });
      expect(errFrames(c).some((f) => f.code === 4404)).toBe(true);
      // 新订阅全量重扫：新 streamId+完整快照（2 行）
      const loads0 = r.history.loadCalls.filter((f) => f === "d0.jsonl").length;
      await c.say({ t: "subscribe", requestId: "rn0", file: "d0.jsonl" });
      const snaps = c.frames().filter((x) => x.t === "snapshot") as Array<Record<string, unknown>>;
      const last = snaps[snaps.length - 1]!;
      expect(last.streamId).not.toBe(s0);
      expect(last.barrier).toBe(2); // 全量重扫（2 行入索引）
      expect(r.history.loadCalls.filter((f) => f === "d0.jsonl").length).toBe(loads0 + 1);
    } finally {
      await r.dispose();
    }
  });

  it("D1c/Q6 宽容换流钩子+observe 迟到回调吸收：budget-swap 退役；FileOverBudgetError 不逸出；4402 retryable=true", async () => {
    const audits: string[] = [];
    const r = await makeRig({ indexLimits: { maxEventsPerStream: 5 }, audit: (l) => { audits.push(l); } });
    try {
      r.history.put("g.jsonl", makeRows(5));
      const c = await authed(r);
      await c.say({ t: "subscribe", requestId: "g1", file: "g.jsonl" });
      expect(c.frames().some((x) => x.t === "snapshot")).toBe(true);
      const sinks = r.history.sinks.get("g.jsonl")!;
      expect(sinks).toBeDefined(); // 成功订阅保留 sinks（真观察面，非空观测）
      // 盘面长到 6 行并经 observe 追加：触顶→4402（retryable=true）+关流+撤观察
      r.history.put("g.jsonl", makeRows(6));
      sinks.onAppend(rowAt(6));
      await until(() => c.frames().some((x) => x.code === 4402));
      const cap = c.frames().find((x) => x.code === 4402) as Record<string, unknown>;
      expect(cap.retryable).toBe(true); // D2：observe 出口容量错可重订阅
      expect(r.history.sinks.has("g.jsonl")).toBe(false);
      // 再次 init：get 宽容换流（删旧标+新空索引）→budget-swap 钩子（旧订阅已关，retired=0）→重装 6 行仍触顶→4402
      const c2 = await authed(r);
      await c2.say({ t: "subscribe", requestId: "g2", file: "g.jsonl" });
      expect(errFrames(c2).some((f) => f.code === 4402 && f.retryable === true)).toBe(true);
      expect(audits.some((l) => l.includes("index-dropped") && l.includes("file=g.jsonl") && l.includes("reason=budget-swap"))).toBe(true);
      // 3b2a-R3：退役旧闭包在身份门即被丢弃（watchers.get(file)!==rec）——不再触达
      // registry.get，FileOverBudgetError 路径对退役回调结构性不可达（僵尸回调
      // 永不入注册表=语义改进）；吸收=无新帧、连接不挂。
      const frames2 = c2.frames().length;
      sinks.onAppend(rowAt(7));
      await tick(); await tick();
      expect(c2.frames().length).toBe(frames2); // 旧闭包零效果
      expect(c2.readyState).toBe(1); // 未被未捕获异常拖死
    } finally {
      await r.dispose();
    }
  });

  it("D2 4402 错误矩阵·改写重建出口：盘面改写且超限→4402+retryable=true+无新快照+连接存活", async () => {
    const r = await makeRig({ indexLimits: { maxEventsPerStream: 5 } });
    try {
      r.history.put("w.jsonl", makeRows(3));
      const c = await authed(r);
      await c.say({ t: "subscribe", requestId: "w1", file: "w.jsonl" });
      expect(c.frames().some((x) => x.t === "snapshot")).toBe(true);
      // 盘面改写且超限（raw 摘要变→非前缀→replace 重建→append 6 行→触顶→统一容量出口）
      const rows2 = makeRows(6);
      rows2[0] = { ...rows2[0]!, raw: '{"t":"sending","seq":1,"mutated":true}' };
      r.history.put("w.jsonl", rows2 as unknown as ScanRow[]);
      c.sent.length = 0;
      await c.say({ t: "subscribe", requestId: "w2", file: "w.jsonl" });
      // 逐请求关联断言（不只 some()——空 requestId 的内联关旧帧也带 true，须证明 w2 自身出口帧）
      const w2err = errFrames(c).find((f) => f.code === 4402 && f.requestId === "w2");
      expect(w2err?.retryable).toBe(true);
      const inline = errFrames(c).find((f) => f.code === 4402 && f.requestId === "");
      expect(inline?.retryable).toBe(true); // 关旧通知内联帧同 true
      expect(errFrames(c).every((f) => f.code !== 4402 || f.retryable === true)).toBe(true);
      expect(c.frames().some((x) => x.t === "snapshot")).toBe(false); // 无新快照
      expect(c.readyState).toBe(1);
    } finally {
      await r.dispose();
    }
  });

  it("D2b 前缀增量出口：盘面同流增长跨阈（3→6）→重 init 走增量 append→4402+retryable=true+无新快照", async () => {
    const r = await makeRig({ indexLimits: { maxEventsPerStream: 5 } });
    try {
      r.history.put("p.jsonl", makeRows(3));
      const c = await authed(r);
      await c.say({ t: "subscribe", requestId: "p1", file: "p.jsonl" });
      expect(c.frames().some((x) => x.t === "snapshot")).toBe(true);
      // 同流前缀追加（不动已有 3 行，续 3 行 seq4-6）→第三个 append 出口（前缀增量，非 observe 非改写）
      const grown = [...makeRows(3)];
      for (let i = 4; i <= 6; i++) {
        grown.push({ source: "journal", locator: String(i), raw: JSON.stringify({ t: "sending", seq: i }),
          event: { seq: i, ts: i - 1, generation: null, intentId: null, kind: "sending" } });
      }
      r.history.put("p.jsonl", grown as unknown as ScanRow[]);
      c.sent.length = 0;
      await c.say({ t: "subscribe", requestId: "p2", file: "p.jsonl" });
      const p2err = errFrames(c).find((f) => f.code === 4402 && f.requestId === "p2");
      expect(p2err?.retryable).toBe(true);
      expect(c.frames().some((x) => x.t === "snapshot")).toBe(false);
      expect(c.readyState).toBe(1);
    } finally {
      await r.dispose();
    }
  });
});

describe("3b-2 源事件接线（onInvalidate/onUnavailable）", () => {
  it("invalidate(rewrite)→该文件订阅 4409 stream-replaced+撤观察+不自动重装载；重订阅=新流新装载", async () => {
    const r = await makeRig();
    try {
      r.history.put("x.jsonl", makeRows(2));
      const c = await authed(r);
      await c.say({ t: "subscribe", requestId: "s1", file: "x.jsonl" });
      const snap1 = c.frames().find((f) => f.t === "snapshot") as Record<string, unknown>;
      const subId1 = snap1.subscriptionId as string;
      const loadsBefore = r.history.loadCalls.length;
      c.sent.length = 0;
      r.history.invalidate("x.jsonl", "rewrite");
      await new Promise((res) => setTimeout(res, 5)); // 出队投递
      const rep = errFrames(c).find((f) => f.code === 4409);
      expect(rep).toBeDefined();
      expect(String(rep?.message)).toContain(`stream-replaced:${subId1}`);
      expect(r.history.sinks.has("x.jsonl")).toBe(false); // 观察引用已撤（unobserve）
      expect(r.history.loadCalls.length).toBe(loadsBefore); // 不自动重装载（fail-closed：新订阅才重扫）
      // 重新订阅→重新装载+新流+观察重建
      c.sent.length = 0;
      await c.say({ t: "subscribe", requestId: "s2", file: "x.jsonl" });
      const snap2 = c.frames().filter((f) => f.t === "snapshot").pop() as Record<string, unknown>;
      expect(snap2.subscriptionId).not.toBe(subId1); // 新订阅
      expect(snap2.streamId).not.toBe(snap1.streamId); // R4（3b2a-P8）：invalidate 已废弃旧流身份——同内容重订阅也必须换流（非内容寻址）
      expect(snap2.barrier).toBe(2);
      expect(r.history.loadCalls.length).toBe(loadsBefore + 1);
      expect(r.history.sinks.has("x.jsonl")).toBe(true);
    } finally {
      await r.dispose();
    }
  });

  it("R3（3b2a-P5）旧代 sink 闭包不得侵新订阅：旧 onAppend/onInvalidate/onUnavailable 全被身份门丢弃", async () => {
    const r = await makeRig();
    try {
      r.history.put("x.jsonl", makeRows(2));
      const c = await authed(r);
      await c.say({ t: "subscribe", requestId: "s1", file: "x.jsonl" });
      const oldSinks = r.history.sinks.get("x.jsonl") as HistorySinks; // 旧代闭包（捕1旧 rec）
      expect(oldSinks).toBeDefined();
      // 旧代退役：invalidate→4409+撤观察；重订阅产生新代闭包
      r.history.invalidate("x.jsonl", "rewrite");
      await new Promise((res) => setTimeout(res, 5));
      await c.say({ t: "subscribe", requestId: "s2", file: "x.jsonl" });
      const snap2 = c.frames().filter((f) => f.t === "snapshot").pop() as Record<string, unknown>;
      expect(snap2).toBeDefined();
      const newSinks = r.history.sinks.get("x.jsonl") as HistorySinks;
      expect(newSinks).not.toBe(oldSinks); // 新代闭包
      c.sent.length = 0;
      // 旧闭包三型迟发：全部不得作用于新订阅
      oldSinks.onAppend?.({ source: "journal", locator: "99", raw: "{}", event: { seq: 99, ts: 0, generation: null, intentId: null, kind: "sending" } });
      oldSinks.onInvalidate?.("rewrite");
      oldSinks.onUnavailable?.("deleted");
      await new Promise((res) => setTimeout(res, 8));
      expect(c.frames().some((f) => f.t === "events")).toBe(false); // 旧 onAppend 不入新引擎
      expect(errFrames(c).some((f) => f.code === 4409)).toBe(false); // 旧 onInvalidate 不退新订阅
      expect(errFrames(c).some((f) => f.code === 4402)).toBe(false); // 旧 onUnavailable 不关新订阅
      // 新代闭包照常工作
      newSinks.onAppend?.({ source: "journal", locator: "3", raw: JSON.stringify({ t: "sending", seq: 3 }), event: { seq: 3, ts: 2, generation: null, intentId: null, kind: "sending" } });
      await new Promise((res) => setTimeout(res, 8));
      expect(c.frames().some((f) => f.t === "events")).toBe(true);
    } finally {
      await r.dispose();
    }
  });

  it("R1（3b2a-P9）连接在 load 挂起期间断开→load 解析后释放引用、无孤儿观察", async () => {
    const r = await makeRig();
    try {
      r.history.put("x.jsonl", makeRows(2));
      r.history.gate("x.jsonl");
      const c = await authed(r);
      const p = c.say({ t: "subscribe", requestId: "s1", file: "x.jsonl" });
      await new Promise((res) => setTimeout(res, 5)); // load 已挂起
      c.closedByTransport(1006); // 宿主断开
      r.history.openGate("x.jsonl"); // 放行 load
      await p.catch(() => {});
      await new Promise((res) => setTimeout(res, 5));
      expect(r.history.releaseCalls).toContain("x.jsonl"); // st.closed 出口配对释放
      expect(r.history.sinks.has("x.jsonl")).toBe(false); // 无孤儿观察
      expect(r.history.observeCalls).not.toContain("x.jsonl"); // 未走到 watchFile
    } finally {
      await r.dispose();
    }
  });

  it("R1 observe-missed：observe 返 null（换代竞态）→4409 退本订阅+释放，不静默断流", async () => {
    const r = await makeRig();
    try {
      r.history.put("x.jsonl", makeRows(2));
      const c = await authed(r);
      r.history.failNextObserve = true; // watchFile 时无活跃代可绑
      await c.say({ t: "subscribe", requestId: "s1", file: "x.jsonl" });
      await new Promise((res) => setTimeout(res, 5));
      // 快照不投：4409 退订会 cancelBySubscription 撤回未发快照帧——订阅以显式
      // retryable 错误收口（客户端重订阅即得新代快照），比投死快照（观察已断、
      // 后续无增量）更诚实；「不静默断流」=客户端必收到 4409。
      const rep = errFrames(c).find((f) => f.code === 4409);
      expect(rep).toBeDefined(); // 显式退订（不静默断流）
      const snap = c.frames().find((f) => f.t === "snapshot");
      expect(snap).toBeUndefined(); // 快照已撤（不投递死订阅）
      expect(String(rep?.message)).toContain("stream-replaced:");
      expect(r.audits.some((l) => l.includes("observe-missed"))).toBe(true);
      expect(r.history.sinks.has("x.jsonl")).toBe(false); // 观察已撤
      expect(r.history.releaseCalls).toContain("x.jsonl"); // 引用释放
    } finally {
      await r.dispose();
    }
  });

  it("unavailable(deleted)→4402 历史源不可用文案+retryable+撤观察；不波及同连接他文件订阅", async () => {
    const r = await makeRig();
    try {
      r.history.put("a.jsonl", makeRows(2));
      r.history.put("b.jsonl", makeRows(2));
      const c = await authed(r);
      await c.say({ t: "subscribe", requestId: "s1", file: "a.jsonl" });
      await c.say({ t: "subscribe", requestId: "s2", file: "b.jsonl" });
      c.sent.length = 0;
      r.history.unavailable("a.jsonl", "deleted");
      await new Promise((res) => setTimeout(res, 5)); // 出队投递
      const err = errFrames(c).find((f) => f.code === 4402);
      expect(err).toBeDefined();
      expect(String(err?.message)).toContain("历史源不可用（deleted）");
      expect(err?.retryable).toBe(true);
      expect(r.history.sinks.has("a.jsonl")).toBe(false);
      expect(r.history.sinks.has("b.jsonl")).toBe(true); // 邻文件不受波及
      // b 仍活着：追加照常投递
      c.sent.length = 0;
      r.history.append("b.jsonl", makeRows(3)[2]!);
      await new Promise((res) => setTimeout(res, 5));
      expect(c.frames().some((f) => f.t === "events")).toBe(true);
    } finally {
      await r.dispose();
    }
  });
});

// ── 3b2c-B3/B4：load 引用恰一次结算 + observe 同步终止（对照 3b2b 报告 N11/N12 反例）──
describe("3b2c-B3/B4——引用恰一次配对与同步终止", () => {
  it("B3：首订阅 observe 消费引用→不 release；次订阅复用绑定→release 结算（恰一次/流）", async () => {
    const r = await makeRig();
    try {
      r.history.put("x.jsonl", makeRows(2));
      const c1 = await authed(r);
      const c2 = await authed(r);
      await c1.say({ t: "subscribe", requestId: "s1", file: "x.jsonl" });
      await new Promise((res) => setTimeout(res, 5));
      expect(r.history.observeCalls).toContain("x.jsonl");
      // 修复点（N11 根因）：本流 observe 已消费 load 引用——不得再 release
      //（旧逻辑 unobserve!==null→release=对本流双结算，多扣他方匿名计数）。
      expect(r.history.releaseCalls).not.toContain("x.jsonl");
      await c2.say({ t: "subscribe", requestId: "s2", file: "x.jsonl" });
      await new Promise((res) => setTimeout(res, 5));
      expect(c2.frames().some((f) => f.t === "snapshot")).toBe(true);
      expect(r.history.observeCalls.filter((f) => f === "x.jsonl")).toHaveLength(1); // 绑定复用：无二次 observe
      expect(r.history.releaseCalls.filter((f) => f === "x.jsonl")).toHaveLength(1); // c2 的 load 由 release 结算
      expect(r.history.sinks.has("x.jsonl")).toBe(true); // 绑定仍在（未被多扣关闭）
    } finally {
      await r.dispose();
    }
  });

  it("B3/N11：真源+他方裸 load——网关关流后他方引用仍在，观察句柄不归零；他方结算后才收", async () => {
    const d = await mkdtemp(join(tmpdir(), "ws-gw-n11-"));
    const handles: Array<{ closed: boolean }> = [];
    const src = new FileHistorySource({
      roots: [d],
      watcher: { watch: (_abs: string, _onNotice: () => void, _onError: (err: unknown) => void) => {
        const h = { closed: false, close(): void { h.closed = true; } };
        handles.push(h);
        return h;
      } },
      audit: () => {},
    });
    const gw = new WsGateway({
      tokens: TokenAuthority.fromTokens(["tok-ok"]),
      roots: [d],
      scanDir: d,
      allowedOrigins: ["http://localhost:5173"],
      recoveryEvidence: () => null,
      historySource: src,
      heartbeat: { pingMs: 0, idleMs: 0 },
      audit: () => {},
    });
    try {
      await writeFile(join(d, "x.jsonl"), `{"t":"sending","intentId":"a1"}\n{"t":"sending","intentId":"a2"}\n`);
      const ext = await src.load("x.jsonl"); // 他方（非网关）裸 load：持一份引用，不 observe 不 release
      expect(ext !== null && ext.length).toBe(2);
      const c = new FakeConn();
      gw.attach(c, c.hooks(), { origin: "http://localhost:5173", loopback: true, tls: false } satisfies ConnMeta);
      await c.say({ t: "hello", protocolVersion: 1, token: "tok-ok" });
      await c.say({ t: "subscribe", requestId: "s1", file: "x.jsonl" });
      await new Promise((res) => setTimeout(res, 15));
      expect(c.frames().some((f) => f.t === "snapshot")).toBe(true); // 订阅成功（快照已投）
      expect(handles.length).toBe(1); // 初扫观察已建立（真源单句柄）
      c.closedByTransport(1006); // 关闭网关侧唯一订阅者
      await new Promise((res) => setTimeout(res, 15));
      // 修复点：旧逻辑 observe 后又 release=多扣一份→关流后计数归零→entry 误关、句柄归零（N11 实测 0）。
      expect(handles.some((h) => !h.closed)).toBe(true); // 他方引用仍在→entry 活、句柄不归零
      src.release("x.jsonl"); // 他方结算（恰一次）
      await new Promise((res) => setTimeout(res, 15));
      expect(handles.every((h) => h.closed)).toBe(true); // 引用真归零→entry 关、句柄全收
    } finally {
      gw.dispose();
      await rm(d, { recursive: true, force: true });
    }
  });

  it("B4/N12：observe 同步终止（右侧未返回即 onUnavailable）→不发死快照+孤儿 stop 即停+audit", async () => {
    const r = await makeRig();
    try {
      r.history.put("x.jsonl", makeRows(2));
      r.history.syncUnavailableOnObserve = true; // 源在 observe 返回前同步 onUnavailable("deleted")
      const c = await authed(r);
      await c.say({ t: "subscribe", requestId: "s1", file: "x.jsonl" });
      await new Promise((res) => setTimeout(res, 8));
      expect(c.frames().some((f) => f.t === "snapshot")).toBe(false); // 死快照不发（订阅已被同步回调退役）
      expect(errFrames(c).some((f) => f.code === 4402)).toBe(true); // 同步终止→4402 历史源不可用
      expect(r.history.stopped.filter((f) => f === "x.jsonl")).toHaveLength(1); // 孤儿 stop 恰一次（旧=0 丢失）
      expect(r.audits.some((l) => l.includes("observe-sync-terminated"))).toBe(true);
    } finally {
      await r.dispose();
    }
  });
});

// ── 3b2e-C3（GPT 3b2d D8/D9）：observe 返回 null ≠ 已消费——未取得绑定必走未消费结算 ──
describe("3b2e-C3——observe null 消费判定", () => {
  it("C3/D8：同步 onUnavailable+observe 返回 null→无死快照+无孤儿 stop+引用必释放（恰一次）", async () => {
    const r = await makeRig();
    try {
      r.history.put("x.jsonl", makeRows(2));
      r.history.syncNullOnObserve = true; // 同步终止且从未建立观察绑定
      const c = await authed(r);
      await c.say({ t: "subscribe", requestId: "s1", file: "x.jsonl" });
      await new Promise((res) => setTimeout(res, 8));
      expect(c.frames().some((f) => f.t === "snapshot")).toBe(false); // 死快照不发
      expect(errFrames(c).some((f) => f.code === 4402)).toBe(true);   // 同步终止→4402
      expect(r.history.stopped).toHaveLength(0);                      // stop 从未取得——无可停
      expect(r.history.releaseCalls.filter((f) => f === "x.jsonl")).toHaveLength(1); // null≠已消费：未消费出口必释放（旧代码=0 泄漏）
      expect(r.audits.some((l) => l.includes("observe-sync-terminated"))).toBe(true);
    } finally {
      await r.dispose();
    }
  });

  it("C3 变体：同步 onInvalidate+observe 返回 null→4409+无死快照+释放恰一次", async () => {
    const r = await makeRig();
    try {
      r.history.put("x.jsonl", makeRows(2));
      r.history.syncNullOnInvalidateOnObserve = true;
      const c = await authed(r);
      await c.say({ t: "subscribe", requestId: "s1", file: "x.jsonl" });
      await new Promise((res) => setTimeout(res, 8));
      expect(c.frames().some((f) => f.t === "snapshot")).toBe(false);
      expect(errFrames(c).some((f) => f.code === 4409)).toBe(true);   // 盘面失效→4409 可重试
      expect(r.history.stopped).toHaveLength(0);
      expect(r.history.releaseCalls.filter((f) => f === "x.jsonl")).toHaveLength(1);
    } finally {
      await r.dispose();
    }
  });

  it("C3/D9：load 本就 null（文件缺失）→不取引用不释放（null 前置于一切）", async () => {
    const r = await makeRig();
    try {
      r.history.missing("x.jsonl"); // load 永返 null
      const c = await authed(r);
      await c.say({ t: "subscribe", requestId: "s1", file: "x.jsonl" });
      await new Promise((res) => setTimeout(res, 8));
      expect(c.frames().some((f) => f.t === "snapshot")).toBe(false);
      expect(r.history.releaseCalls).toHaveLength(0); // 从未取得引用——零释放
      expect(r.history.observeCalls).toHaveLength(0);
    } finally {
      await r.dispose();
    }
  });
});

describe("ws-gateway 3b-2b③：DualHistorySource 接线验证", () => {
  class PathReader implements HistoryReaderPort {
    readonly files = new Map<string, { text: string; identity: string }>();
    readonly failPaths = new Set<string>();
    read(absPath: string): Promise<{ text: string; identity: string }> {
      if (this.failPaths.has(absPath)) return Promise.reject(new Error("EACCES " + absPath));
      const f = this.files.get(absPath);
      if (!f) return Promise.reject(new Error("ENOENT " + absPath));
      return Promise.resolve({ text: f.text, identity: f.identity });
    }
    set(path: string, text: string, identity?: string): void { this.files.set(path, { text, identity: identity ?? `dev-ino-${path}` }); }
  }
  class PathWatcher implements HistoryWatcherPort {
    readonly handles: { abs: string; closed: boolean; onNotice: () => void; onError: (e: unknown) => void }[] = [];
    watch(abs: string, onNotice: () => void, onError: (e: unknown) => void) {
      const h = { abs, closed: false, onNotice, onError };
      this.handles.push(h);
      return { close: () => { h.closed = true; } };
    }
    notice(abs: string) { const h = [...this.handles].filter((x) => x.abs === abs && !x.closed).pop(); if (h) h.onNotice(); }
  }
  const TEXT_A = "hello gateway";
  const TEXT_B = "second turn";
  const TEXT_C = "third leg";
  const jEn = (i: string, t: string, o: number) => JSON.stringify({ t: "enqueue", intentId: i, sessionId: "s", generation: 1, leafId: "L", matchKey: matchKeyOf(t, [], o), payload: { kind: "prompt", rawText: t, attachments: [], sentAt: "1" } });
  const sU = (id: string, t: string) => JSON.stringify({ type: "message", id, parentId: null, timestamp: 1, message: { role: "user", content: t } });
  interface DualRig { r: Rig; reader: PathReader; watcher: PathWatcher; jp: string; sp: string; audits: string[]; dispose(): Promise<void>; }
  async function dualRig(over: { sessionFor?: (f: string) => string } = {}): Promise<DualRig> {
    const jr = await mkdtemp(join(tmpdir(), "dw-j-"));
    const sr = await mkdtemp(join(tmpdir(), "dw-s-"));
    const reader = new PathReader();
    const watcher = new PathWatcher();
    const audits: string[] = [];
    const dual = new DualHistorySource({
      roots: [jr],
      sessionRoots: [sr],
      sessionFor: over.sessionFor ?? ((_f: string) => join(sr, "sess.jsonl")),
      reader,
      watcher,
      audit: (l) => { audits.push(l); },
    });
    const r = await makeRig({ historySource: dual, roots: [jr], scanDir: jr });
    return { r, reader, watcher, jp: join(jr, "j.jsonl"), sp: join(sr, "sess.jsonl"), audits, dispose: async () => { await r.dispose(); await rm(jr, { recursive: true, force: true }); await rm(sr, { recursive: true, force: true }); } };
  }
  type Ev = { kind: string; intentId: string | null; seq: number; role?: string };

  it("D1 双源快照：journal 前 session 后；session user 事件带归因 intentId；无错流", async () => {
    const d = await dualRig();
    try {
      d.reader.set(d.jp, jEn("i-1", TEXT_A, 0) + "\n");
      d.reader.set(d.sp, sU("u1", TEXT_A) + "\n");
      const c = await authed(d.r);
      await c.say({ t: "subscribe", requestId: "sub-1", file: "j.jsonl" });
      const snap = c.frames().find((f) => f.t === "snapshot") as Record<string, unknown>;
      expect(snap).toBeDefined();
      expect(snap.barrier).toBe(2); // 两源屏障：journal 1 + session 1
      const page = snap.page as Ev[];
      expect(page.map((e) => e.kind)).toEqual(["turn-enqueued", "message"]); // journal 先 session 后
      expect(page[1]?.intentId).toBe("i-1"); // §3.5 归因：user 三元组命中 enqueue
      expect(page[1]?.role).toBe("user");
      expect(errFrames(c).length).toBe(0);
    } finally {
      await d.dispose();
    }
  });

  it("D2 live 追加双源各自到货→history 帧续投；交错不换流（无 4404/4409）", async () => {
    const d = await dualRig();
    try {
      d.reader.set(d.jp, jEn("i-1", TEXT_A, 0) + "\n");
      d.reader.set(d.sp, sU("u1", TEXT_A) + "\n");
      const c = await authed(d.r);
      await c.say({ t: "subscribe", requestId: "sub-1", file: "j.jsonl" });
      // journal 追加（live 到达序=journal 先到）
      d.reader.set(d.jp, jEn("i-1", TEXT_A, 0) + "\n" + jEn("i-2", TEXT_B, 0) + "\n");
      d.watcher.notice(d.jp);
      await until(() => { const f = c.frames().filter((x) => x.t === "events") as Array<{ events: Ev[]; origin: string }>; return f.some((x) => x.events.some((e) => e.kind === "turn-enqueued" && e.intentId === "i-2")); });
      // session 追加（session 后到——到达序与固定源序一致的简单面）
      d.reader.set(d.sp, sU("u1", TEXT_A) + "\n" + sU("u2", TEXT_B) + "\n");
      d.watcher.notice(d.sp);
      await until(() => { const f = c.frames().filter((x) => x.t === "events") as Array<{ events: Ev[] }>; return f.some((x) => x.events.some((e) => e.kind === "message" && e.intentId === "i-2")); });
      expect(errFrames(c).filter((f) => f.code === 4404 || f.code === 4409).length).toBe(0); // 未换流
    } finally {
      await d.dispose();
    }
  });

  it("D3 session 盘面换代→invalidate(replace)→旧订阅退役 4409；新订阅新流", async () => {
    const d = await dualRig();
    try {
      d.reader.set(d.jp, jEn("i-1", TEXT_A, 0) + "\n");
      d.reader.set(d.sp, sU("u1", TEXT_A) + "\n");
      const c = await authed(d.r);
      await c.say({ t: "subscribe", requestId: "sub-1", file: "j.jsonl" });
      const snap1 = c.frames().find((f) => f.t === "snapshot") as Record<string, unknown>;
      const stream1 = (snap1.streamId as string) ?? "";
      // session 文件身份换代（重写+identity 变）→ 子源 invalidate(replace) 转发
      d.reader.set(d.sp, sU("u1x", TEXT_A) + "\n", "dev-ino-changed");
      d.watcher.notice(d.sp);
      await until(() => errFrames(c).some((f) => f.code === 4409) || c.closes.length > 0);
      expect(errFrames(c).some((f) => f.code === 4409)).toBe(true); // 旧订阅退役
      // 新订阅走换流重建：新 streamId ≠ 旧
      await c.say({ t: "subscribe", requestId: "sub-2", file: "j.jsonl" });
      const snaps = c.frames().filter((f) => f.t === "snapshot") as Array<Record<string, unknown>>;
      const snap2 = snaps[snaps.length - 1] as Record<string, unknown> | undefined;
      expect(snap2).toBeDefined();
      expect(String(snap2?.streamId ?? "")).not.toBe(stream1);
    } finally {
      await d.dispose();
    }
  });

  it("D4 session 缺失→journal-only 降级（审计 session-missing；快照仅 journal 行；非 4402）", async () => {
    const d = await dualRig();
    try {
      d.reader.set(d.jp, jEn("i-1", TEXT_A, 0) + "\n");
      const c = await authed(d.r);
      await c.say({ t: "subscribe", requestId: "sub-1", file: "j.jsonl" });
      const snap = c.frames().find((f) => f.t === "snapshot") as Record<string, unknown>;
      expect(snap).toBeDefined();
      expect(snap.barrier).toBe(1);
      expect((snap.page as Ev[]).every((e) => e.kind === "turn-enqueued")).toBe(true);
      expect(errFrames(c).length).toBe(0); // 降级≠失败
      expect(d.audits.some((l) => l.includes("session-missing"))).toBe(true);
    } finally {
      await d.dispose();
    }
  });

  it("D6 交错 live 追加后二次装载：分流前缀成立不换流+continueFrom 余量序（journal 先）无重无漏", async () => {
    const d = await dualRig();
    try {
      d.reader.set(d.jp, jEn("i-1", TEXT_A, 0) + "\n");
      d.reader.set(d.sp, sU("u1", TEXT_A) + "\n");
      const c = await authed(d.r);
      await c.say({ t: "subscribe", requestId: "sub-1", file: "j.jsonl" });
      // 到达序交错：journal i-2 先到、session u2 后到（≠固定源序的 session 面在 journal 后本一致；再交叉一次）
      d.reader.set(d.jp, jEn("i-1", TEXT_A, 0) + "\n" + jEn("i-2", TEXT_B, 0) + "\n");
      d.watcher.notice(d.jp);
      await until(() => { const f = c.frames().filter((x) => x.t === "events") as Array<{ events: Ev[] }>; return f.some((x) => x.events.some((e) => e.intentId === "i-2")); });
      d.reader.set(d.sp, sU("u1", TEXT_A) + "\n" + sU("u2", TEXT_B) + "\n");
      d.watcher.notice(d.sp);
      await until(() => { const f = c.frames().filter((x) => x.t === "events") as Array<{ events: Ev[] }>; return f.some((x) => x.events.some((e) => e.kind === "message" && e.intentId === "i-2")); });
      // 盘面再各长一行（j3/s3），二次装载才有余量：固定源序重扫对交错编入索引→分流前缀成立+余量续编
      d.reader.set(d.jp, jEn("i-1", TEXT_A, 0) + "\n" + jEn("i-2", TEXT_B, 0) + "\n" + jEn("i-3", TEXT_C, 0) + "\n");
      d.reader.set(d.sp, sU("u1", TEXT_A) + "\n" + sU("u2", TEXT_B) + "\n" + sU("u3", TEXT_C) + "\n");
      const c2 = await authed(d.r);
      // 退掉首订阅→观察引用释放→二次装载走 load+syncIndex（前缀分支）而非共享观察快照路径
      const sub1 = (c.frames().find((f) => f.t === "snapshot") as Record<string, unknown>).subscriptionId as string;
      await c.say({ t: "unsubscribe", requestId: "un-1", subscriptionId: sub1 });
      await until(() => d.watcher.handles.every((h) => h.closed));
      await c2.say({ t: "subscribe", requestId: "sub-2", file: "j.jsonl" });
      const snap = c2.frames().find((f) => f.t === "snapshot") as Record<string, unknown>;
      expect(snap).toBeDefined();
      expect(snap.barrier).toBe(6); // 首载 2+live 2+余量续编 2
      const page = snap.page as Ev[];
      expect(page.map((e) => e.seq).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]); // 无重无漏（位置续编会把 s2 重复编入+漏 j3）
      expect(page.filter((e) => e.kind === "turn-enqueued").map((e) => e.intentId).sort()).toEqual(["i-1", "i-2", "i-3"]);
      expect(page.filter((e) => e.kind === "message").map((e) => e.intentId).sort()).toEqual(["i-1", "i-2", "i-3"]); // 归因两面
      expect(errFrames(c2).filter((f) => f.code === 4404 || f.code === 4409).length).toBe(0); // 未换流
    } finally {
      await d.dispose();
    }
  });

  it("D5 journal 读失败→整体 fail-closed→4402 retryable（session 在也不能洗白）", async () => {
    const d = await dualRig();
    try {
      d.reader.set(d.sp, sU("u1", TEXT_A) + "\n");
      d.reader.failPaths.add(d.jp);
      const c = await authed(d.r);
      await c.say({ t: "subscribe", requestId: "sub-1", file: "j.jsonl" });
      const e = errFrames(c).pop();
      expect(e?.code).toBe(4402);
      expect(e?.retryable).toBe(true);
    } finally {
      await d.dispose();
    }
  });

  it("D7 3b2b-R2：journal-only 订阅期 session 恢复+二次装载——续编行恰一次达 A（load 分发与活跃订阅协同）；后续通知不重复", async () => {
    const d = await dualRig();
    try {
      d.reader.set(d.jp, jEn("i-1", TEXT_A, 0) + "\n");
      // session 缺→A 订阅=journal-only（快照 barrier=1）
      const c = await authed(d.r);
      await c.say({ t: "subscribe", requestId: "sub-1", file: "j.jsonl" });
      const snap1 = c.frames().find((f) => f.t === "snapshot") as Record<string, unknown>;
      expect(snap1.barrier).toBe(1);
      // session 出现（两行：u1 可归因 i-1；u2 无对应 enqueue→intentId=null）——不触发 watcher（新槽首次装载自当盘）
      d.reader.set(d.sp, sU("u1", TEXT_A) + "\n" + sU("u2", TEXT_B) + "\n");
      const sessEvents = (frames: unknown[]): Array<{ intentId: string | null; role?: string }> => {
        const out: Array<{ intentId: string | null; role?: string }> = [];
        for (const f of frames) {
          const ev = f as { t?: string; events?: Ev[] };
          if (ev.t === "events") out.push(...(ev.events ?? []).filter((e) => e.kind === "message"));
        }
        return out;
      };
      const c2 = await authed(d.r);
      await c2.say({ t: "subscribe", requestId: "sub-2", file: "j.jsonl" });
      const snap2 = c2.frames().find((f) => f.t === "snapshot") as Record<string, unknown>;
      expect(snap2.barrier).toBe(3); // B：journal 1+session 新行 2（fresh 首扫）
      // A 经 load 续编分发恰一次收到两行 session 事件（去分发块则 A 永远收不到——R2 第四面）
      await until(() => sessEvents(c.frames()).length === 2);
      const got = sessEvents(c.frames());
      expect(got.filter((e) => e.intentId === "i-1").length).toBe(1); // u1 归因
      expect(got.filter((e) => e.intentId === null).length).toBe(1); // u2 无匹配
      // B 引擎建于 syncIndex 之后：B 的两行走快照（恰一次），不再收 live 分发
      expect(sessEvents(c2.frames()).length).toBe(0);
      const page2 = snap2.page as Ev[];
      expect(page2.filter((e) => e.kind === "message").length).toBe(2);
      // 随后 watcher 通知到达：源基线已前移→无重复编入
      d.watcher.notice(d.sp);
      await new Promise((res) => setTimeout(res, 30));
      expect(sessEvents(c.frames()).length).toBe(2);
      expect(sessEvents(c2.frames()).length).toBe(0);
      expect(errFrames(c).filter((f) => f.code === 4404 || f.code === 4409).length).toBe(0);
    } finally {
      await d.dispose();
    }
  });
});
