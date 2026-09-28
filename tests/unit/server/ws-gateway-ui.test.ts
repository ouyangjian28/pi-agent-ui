// D3 扩展问答——网关面（docs/d3-ui-passthrough-design.md §7 W-ui-g*）。
// 覆盖矩阵：
//  W-ui-g1 ui-answer 未接线→4405                          W-ui-g6 零订阅派发→返回 0+不登记+host 未被调
//  W-ui-g2 派发→订阅者收 ui-request 帧（字段原样）        W-ui-g7 末订阅者断开→pending 全回 cancelled
//  W-ui-g3 合法答案→host.answer+answered 撤框广播          W-ui-g8 host 返回 stale→无 ui-closed 广播（会话层职责）
//  W-ui-g4 首答胜出：次答 4404；跨文件非订阅者 4404        W-ui-g9 ui-note→订阅者 live 流收 ui-note 事件
//  W-ui-g5 方法级校验：select 越项/confirm 收 value/input 收 confirmed→4404
import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WsGateway, type ConnMeta, type GatewayConnHooks, type HistorySinks, type HistorySourcePort, type ScanRowLike, type WsGatewayOpts } from "../../../apps/server/src/ws/ws-gateway.ts";
import type { UiHostPort, UiAnswerPayloadGateway, UiAnswerOutcomeGateway } from "../../../apps/server/src/ws/ui-host.ts";
import { TokenAuthority } from "../../../apps/server/src/ws/token-auth.ts";

const tick = (): Promise<void> => new Promise((res) => setImmediate(() => res()));

/** 轮询等待（泵=setTimeout(0)，负载下 setImmediate 序不保证先行——固定 tick 数会闪断）。 */
const until = (f: () => boolean, ms = 2000): Promise<void> => {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const step = (): void => {
      if (f()) return resolve();
      if (Date.now() - t0 > ms) return reject(new Error("until timeout"));
      setTimeout(step, 10);
    };
    step();
  });
};

class FakeConn {
  readyState = 1;
  sent: string[] = [];
  closes: Array<[number | undefined, string | undefined]> = [];
  private msgCb: ((data: string, isBinary: boolean) => void) | null = null;
  private closeCb: ((code: number) => void) | null = null;
  send(data: string): void { this.sent.push(data); }
  close(code?: number, reason?: string): void { this.closes.push([code, reason]); this.readyState = 2; }
  terminate(): void { this.readyState = 3; }
  hooks(): GatewayConnHooks {
    return { onMessage: (cb) => { this.msgCb = cb; }, onClose: (cb) => { this.closeCb = cb; }, onPong: () => {} };
  }
  async say(obj: unknown): Promise<void> { this.msgCb?.(JSON.stringify(obj), false); await tick(); await tick(); await tick(); }
  frames(): Array<Record<string, unknown>> { return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>); }
  /** 模拟传输断开（走网关 transportClosed 面=订阅释放+D3 无人可答规则挂钩点）。 */
  drop(): void { this.readyState = 3; this.closeCb?.(1006); }
}

/** 极简历史源：空文件可订阅（load 返回空行集）。 */
class EmptyHistory implements HistorySourcePort {
  async load(): Promise<readonly ScanRowLike[] | null> { return []; }
  observe(_file: string, _sinks: HistorySinks): (() => void) | null { return () => {}; }
}

class FakeUiHost implements UiHostPort {
  readonly answers: Array<{ file: string; requestId: string; payload: UiAnswerPayloadGateway }> = [];
  next: UiAnswerOutcomeGateway = { kind: "delivered" };
  async answer(file: string, requestId: string, payload: UiAnswerPayloadGateway): Promise<UiAnswerOutcomeGateway> {
    this.answers.push({ file, requestId, payload });
    return this.next;
  }
}

interface Rig {
  gw: WsGateway;
  conn(): FakeConn;
  host: FakeUiHost;
  audits: string[];
  file: string;
  dispose(): Promise<void>;
}

async function makeRig(withHost = true, over: Partial<WsGatewayOpts> = {}): Promise<Rig> {
  const d = await mkdtemp(join(tmpdir(), "ws-ui-"));
  const audits: string[] = [];
  const host = new FakeUiHost();
  const gw = new WsGateway({
    tokens: TokenAuthority.fromTokens(["tok-ok"]),
    roots: [d],
    scanDir: d,
    allowedOrigins: ["http://localhost:5173"],
    historySource: new EmptyHistory(),
    heartbeat: { pingMs: 0, idleMs: 0 },
    audit: (l) => { audits.push(l); },
    ...(withHost ? { uiHost: host } : {}),
    ...over,
  } as Partial<WsGatewayOpts>);
  const conn = () => {
    const c = new FakeConn();
    gw.attach(c, c.hooks(), { origin: "http://localhost:5173", loopback: true, tls: false } satisfies ConnMeta);
    return c;
  };
  return { gw, conn, host, audits, file: "s1.jsonl", dispose: async () => { gw.dispose(); await rm(d, { recursive: true, force: true }); } };
}

async function authedSub(r: Rig): Promise<FakeConn> {
  const c = r.conn();
  await c.say({ t: "hello", protocolVersion: 1, token: "tok-ok" });
  await c.say({ t: "subscribe", requestId: "sub-1", file: r.file });
  return c;
}

const errs = (c: FakeConn) => c.frames().filter((f) => f.t === "error") as Array<{ code: number; requestId?: string }>;

describe("D3 扩展问答：网关面", () => {
  it("W-ui-g1 未接线：ui-answer→4405", async () => {
    const r = await makeRig(false);
    try {
      const c = r.conn();
      await c.say({ t: "hello", protocolVersion: 1, token: "tok-ok" });
      await c.say({ t: "ui-answer", requestId: "q-1", value: "a" });
      expect(errs(c).some((f) => f.code === 4405)).toBe(true);
    } finally { await r.dispose(); }
  });

  it("W-ui-g2 派发：订阅者收 ui-request 帧（requestId/file/method/options/timeout 原样）；返回送达数", async () => {
    const r = await makeRig();
    try {
      const c = await authedSub(r);
      const n = r.gw.broadcastUiRequest(r.file, { requestId: "q-1", method: "select", title: "选", options: ["a", "b"], timeoutMs: 1000 });
      await tick(); await tick();
      expect(n).toBe(1);
      const req = c.frames().find((f) => f.t === "ui-request");
      expect(req).toMatchObject({ t: "ui-request", requestId: "q-1", file: r.file, method: "select", title: "选", options: ["a", "b"], timeoutMs: 1000 });
      expect(r.audits.some((l) => l.includes("ui-request") && l.includes("conns=1"))).toBe(true);
    } finally { await r.dispose(); }
  });

  it("W-ui-g3 合法答案：host.answer(file,id,value)→delivered→ui-closed(answered) 撤框广播", async () => {
    const r = await makeRig();
    try {
      const c = await authedSub(r);
      const n = r.gw.broadcastUiRequest(r.file, { requestId: "q-1", method: "select", options: ["a", "b"] });
      expect(n).toBe(1);
      await tick(); await tick();
      const req = c.frames().find((f) => f.t === "ui-request");
      expect(req).toMatchObject({ requestId: "q-1", file: r.file, method: "select", options: ["a", "b"] });
      await c.say({ t: "ui-answer", requestId: "q-1", value: "a" });
      expect(r.host.answers).toEqual([{ file: r.file, requestId: "q-1", payload: { value: "a" } }]);
      const closed = c.frames().find((f) => f.t === "ui-closed");
      expect(closed).toMatchObject({ t: "ui-closed", requestId: "q-1", reason: "answered" });
    } finally { await r.dispose(); }
  });

  it("W-ui-g4 首答胜出：次答 4404（未知或已答）；跨文件非订阅者 4404", async () => {
    const r = await makeRig();
    try {
      const c = await authedSub(r);
      r.gw.broadcastUiRequest(r.file, { requestId: "q-1", method: "input" });
      await c.say({ t: "ui-answer", requestId: "q-1", value: "x" });
      await c.say({ t: "ui-answer", requestId: "q-1", value: "y" });
      expect(errs(c).some((f) => f.code === 4404 && f.requestId === "q-1")).toBe(true);
      expect(r.host.answers.length).toBe(1); // 只回写首答
      // 跨文件：另开连接（未订阅）答新提问→4404 非订阅者
      r.gw.broadcastUiRequest(r.file, { requestId: "q-2", method: "input" });
      const c2 = r.conn();
      await c2.say({ t: "hello", protocolVersion: 1, token: "tok-ok" });
      await c2.say({ t: "ui-answer", requestId: "q-2", value: "x" });
      expect(errs(c2).some((f) => f.code === 4404)).toBe(true);
      expect(r.host.answers.length).toBe(1);
    } finally { await r.dispose(); }
  });

  it("W-ui-g5 方法级校验：select 越项/confirm 收 value/input 收 confirmed→4404 且 host 未被调（拆连接：4404 累计 3→close 1002 门）", async () => {
    const r = await makeRig();
    try {
      // 三案各一连接（同连接 4404×3 会触发 close 1002——错题教训：多案拆连接）
      const cases: Array<{ rid: string; ask: { requestId: string; method: "select" | "confirm" | "input"; options?: string[] }; ans: unknown; want: string }> = [
        { rid: "q-s", ask: { requestId: "q-s", method: "select", options: ["a"] }, ans: { t: "ui-answer", requestId: "q-s", value: "zzz" }, want: "value 不在选项内" },
        { rid: "q-c", ask: { requestId: "q-c", method: "confirm" }, ans: { t: "ui-answer", requestId: "q-c", value: "yes" }, want: "confirm 不接受 value" },
        { rid: "q-i", ask: { requestId: "q-i", method: "input" }, ans: { t: "ui-answer", requestId: "q-i", confirmed: true }, want: "仅 confirm 接受 confirmed" },
      ];
      for (const cs of cases) {
        const c = await authedSub(r);
        r.gw.broadcastUiRequest(r.file, cs.ask);
        await c.say(cs.ans);
        const e = errs(c).find((f) => f.code === 4404);
        expect(e).toBeDefined();
        expect((e as { message?: string }).message).toContain(cs.want);
        expect(c.closes.length).toBe(0); // 单 4404 不关连接
      }
      expect(r.host.answers.length).toBe(0); // 拒答不清 pending、不回写
      // 拒答后合法答案仍可答（首答胜出未被恶意占位）
      const c4 = await authedSub(r);
      r.gw.broadcastUiRequest(r.file, { requestId: "q-s", method: "select", options: ["a"] });
      await c4.say({ t: "ui-answer", requestId: "q-s", value: "a" });
      expect(r.host.answers.length).toBe(1);
      expect(r.host.answers[0]?.payload).toEqual({ value: "a" });
    } finally { await r.dispose(); }
  });

  it("W-ui-g6 零订阅派发：返回 0+不登记+host 未被调（组装层回 cancelled）", async () => {
    const r = await makeRig();
    try {
      const c = r.conn();
      await c.say({ t: "hello", protocolVersion: 1, token: "tok-ok" }); // 未订阅
      const n = r.gw.broadcastUiRequest(r.file, { requestId: "q-1", method: "input" });
      expect(n).toBe(0);
      await c.say({ t: "ui-answer", requestId: "q-1", value: "x" });
      expect(errs(c).some((f) => f.code === 4404)).toBe(true); // 未登记→4404
      expect(r.host.answers.length).toBe(0);
    } finally { await r.dispose(); }
  });

  it("W-ui-g7 末订阅者断开→该 file 全部 pending 回 cancelled（无人可答规则）", async () => {
    const r = await makeRig();
    try {
      const c = await authedSub(r);
      r.gw.broadcastUiRequest(r.file, { requestId: "q-1", method: "input" });
      r.gw.broadcastUiRequest(r.file, { requestId: "q-2", method: "confirm" });
      c.drop();
      await until(() => r.host.answers.length >= 2, "断开触发 cancelled");
      expect(r.host.answers.length).toBe(2);
      expect(r.host.answers.every((a) => a.file === r.file && a.payload.kind === undefined && "cancelled" in a.payload)).toBe(true);
      expect(r.audits.some((l) => l.includes("ui-cancel") && l.includes("q-1"))).toBe(true);
    } finally { await r.dispose(); }
  });

  it("W-ui-g8 host 返回 stale/write-failed→无 ui-closed 广播（撤框=会话层 emitUiClosed 职责）；审计留痕", async () => {
    const r = await makeRig();
    try {
      const c = await authedSub(r);
      r.host.next = { kind: "stale" };
      r.gw.broadcastUiRequest(r.file, { requestId: "q-1", method: "input" });
      await c.say({ t: "ui-answer", requestId: "q-1", value: "x" });
      expect(c.frames().some((f) => f.t === "ui-closed")).toBe(false);
      expect(r.audits.some((l) => l.includes("ui-answer") && l.includes("outcome=stale"))).toBe(true);
    } finally { await r.dispose(); }
  });

  it("W-ui-g9 ui-note→订阅者 live 流收 ui-note 事件（耐久流通道）", async () => {
    const r = await makeRig();
    try {
      const c = await authedSub(r);
      r.gw.broadcastUiNote(r.file, { notifyType: "warning", message: "注意" });
      await until(() => c.frames().some((f) => f.t === "events" && f.origin === "live"));
      const ev = c.frames().find((f) => f.t === "events" && f.origin === "live");
      expect(ev).toBeDefined();
      expect((ev?.["events"] as Array<Record<string, unknown>>).some((e) => e.kind === "ui-note" && e.notifyType === "warning" && e.message === "注意")).toBe(true);
    } finally { await r.dispose(); }
  });
});
