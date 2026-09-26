// 3b-3②：真实 OS 文件时序 E2E（冻结案②，PROJECT.md 3b-3 节）
// 真实 tmpdir+真实 fs.watch+真实 reader（DualHistorySource 默认装配全真）；连接面=内存 FakeConn（无网络、无 LLM、默认跑）。
// 时序纪律：fs.watch 事件有 OS 延迟且可能合并——一律 until() 条件等待+恰一次断言，不测瞬时序；
// 快照到达（=load 完成）后 settle(WARM) 再动盘，给观察建立窗口（观察建立=rescan 内同步 watch，W1-05/H5 面已单测）。
// 场景对照（冻结清单）：双源同 tick 追加/撕裂尾跨写补全/rename-over 同字节（重挂）/rename-over 改写（4409 真路径）/
// delete（4402 真路径）/recreate/缺源恢复晚附/旧 cursor 分页 H 后增长/句柄票据收口（全退后观察代理静默）/4404 真路径。
import { describe, expect, it } from "vitest";
import { appendFile, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WsGateway, type ConnMeta, type GatewayConnHooks, type WsGatewayOpts } from "../../apps/server/src/ws/ws-gateway.ts";
import { TokenAuthority } from "../../apps/server/src/ws/token-auth.ts";
import { DualHistorySource } from "../../apps/server/src/runtime/dual-history-source.ts";
import { ComputeSemaphore } from "../../apps/server/src/ws/compute-semaphore.ts";
import { matchKeyOf } from "@pi-agent-ui/protocol";

const tick = (): Promise<void> => new Promise((res) => setImmediate(() => res()));
const settle = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("until 超时");
    await tick();
  }
}
const WARM = 150; // 快照后观察建立窗口

class FakeConn {
  readyState = 1;
  sent: string[] = [];
  closes: Array<[number | undefined, string | undefined]> = [];
  terminated = 0;
  private msgCb: ((data: string, isBinary: boolean) => void) | null = null;
  private closeCb: ((code: number) => void) | null = null;
  send(data: string): void { this.sent.push(data); }
  close(code?: number, reason?: string): void { this.closes.push([code, reason]); this.readyState = 2; }
  terminate(): void { this.terminated++; this.readyState = 3; }
  hooks(): GatewayConnHooks {
    return {
      onMessage: (cb) => { this.msgCb = cb; },
      onClose: (cb) => { this.closeCb = cb; },
    };
  }
  async say(obj: unknown): Promise<void> {
    this.msgCb?.(JSON.stringify(obj), false);
    await tick(); await tick();
  }
  closedByTransport(code = 1006): void { this.closeCb?.(code); }
  frames(): Array<Record<string, unknown>> { return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>); }
  events(sub: string): Array<Record<string, unknown>> {
    return this.frames()
      .filter((f) => f.t === "events" && f.subscriptionId === sub)
      .flatMap((f) => f.events as Array<Record<string, unknown>>);
  }
}

const TEXT_A = "hello real fs";
const TEXT_B = "second turn";
const TEXT_C = "third leg";
const jEn = (i: string, t: string, o: number) => JSON.stringify({ t: "enqueue", intentId: i, sessionId: "s", generation: 1, leafId: "L", matchKey: matchKeyOf(t, [], o), payload: { kind: "prompt", rawText: t, attachments: [], sentAt: "1" } });
const sU = (id: string, t: string) => JSON.stringify({ type: "message", id, parentId: null, timestamp: 1, message: { role: "user", content: t } });

interface Rig {
  gw: WsGateway;
  conn(): { c: FakeConn };
  authed(): Promise<FakeConn>;
  audits: string[];
  jp: string;
  sp: string;
  dispose(): Promise<void>;
}
async function makeRig(): Promise<Rig> {
  const jr = await mkdtemp(join(tmpdir(), "rf-j-"));
  const sr = await mkdtemp(join(tmpdir(), "rf-s-"));
  const jp = join(jr, "j.jsonl");
  const sp = join(sr, "sess.jsonl");
  const audits: string[] = [];
  const dual = new DualHistorySource({
    roots: [jr],
    sessionRoots: [sr],
    sessionFor: () => sp,
    audit: (l) => { audits.push(l); },
  });
  const gw = new WsGateway({
    tokens: TokenAuthority.fromTokens(["tok-ok"]),
    roots: [jr],
    scanDir: jr,
    allowedOrigins: ["http://localhost:5173"],
    historySource: dual,
    semaphore: new ComputeSemaphore(),
    heartbeat: { pingMs: 0, idleMs: 0 },
    audit: (l) => { audits.push(l); },
  });
  const conn = () => {
    const c = new FakeConn();
    gw.attach(c, c.hooks(), { origin: "http://localhost:5173", loopback: true, tls: false } satisfies ConnMeta);
    return { c };
  };
  const authed = async () => {
    const { c } = conn();
    await c.say({ t: "hello", protocolVersion: 1, token: "tok-ok" });
    return c;
  };
  return {
    gw, conn, authed, audits, jp, sp,
    dispose: async () => {
      gw.dispose();
      await rm(jr, { recursive: true, force: true });
      await rm(sr, { recursive: true, force: true });
    },
  };
}

const errFrames = (c: FakeConn, code?: number): Array<Record<string, unknown>> =>
  c.frames().filter((f) => f.t === "error" && (code === undefined || f.code === code));
const subIdOf = (c: FakeConn): string => {
  const snap = c.frames().find((f) => f.t === "snapshot") as { subscriptionId?: string };
  return snap?.subscriptionId ?? "";
};

async function subAndWait(r: Rig, reqId = "sub-1"): Promise<{ c: FakeConn; sub: string }> {
  const c = await r.authed();
  await c.say({ t: "subscribe", requestId: reqId, file: "j.jsonl" });
  await until(() => c.frames().some((f) => f.t === "snapshot"));
  return { c, sub: subIdOf(c) };
}

describe("3b-3② real-fs：真实 OS 文件时序（真 tmpdir+真 fs.watch+真 reader）", () => {
  it("RF1 双源同 tick 追加：journal+session 各恰一次到货，无错流无换流", async () => {
    const r = await makeRig();
    try {
      await writeFile(r.jp, jEn("i-1", TEXT_A, 0) + "\n");
      await writeFile(r.sp, sU("u1", TEXT_A) + "\n");
      const { c, sub } = await subAndWait(r);
      await settle(WARM);
      await appendFile(r.jp, jEn("i-2", TEXT_B, 0) + "\n");
      await appendFile(r.sp, sU("u2", TEXT_B) + "\n");
      await until(() => c.events(sub).length >= 2);
      await settle(120); // 等合并事件余波（幂等面：多事件不重发）
      const evs = c.events(sub);
      expect(evs.filter((e) => e.kind === "turn-enqueued")).toHaveLength(1); // i-2 恰一次
      expect(evs.filter((e) => e.kind === "message" && e.entryId === "u2")).toHaveLength(1); // u2 恰一次
      expect(evs.filter((e) => e.kind === "message" && e.entryId === "u2")[0]?.intentId).toBe("i-2"); // 归因直达
      expect(errFrames(c).length).toBe(0);
      expect(c.frames().some((f) => f.t === "resync-required")).toBe(false);
    } finally {
      await r.dispose();
    }
  });

  it("RF2 撕裂尾跨写补全：半行不发布，补全+换行后恰一次发布（session 面）", async () => {
    const r = await makeRig();
    try {
      await writeFile(r.jp, jEn("i-1", TEXT_A, 0) + "\n");
      await writeFile(r.sp, sU("u1", TEXT_A) + "\n");
      const { c, sub } = await subAndWait(r);
      await settle(WARM);
      const half = sU("u9", TEXT_C).slice(0, 25); // 无 \n 撕裂尾
      await appendFile(r.sp, half);
      await settle(250);
      expect(c.events(sub).length).toBe(0); // 半行不发布
      const rest = sU("u9", TEXT_C).slice(25) + "\n";
      await appendFile(r.sp, rest);
      await until(() => c.events(sub).length === 1);
      await settle(150);
      expect(c.events(sub)).toHaveLength(1); // 恰一次
      expect(c.events(sub)[0]?.entryId).toBe("u9");
      expect(errFrames(c).length).toBe(0);
    } finally {
      await r.dispose();
    }
  });

  it("RF3 rename-over 同字节：不换流（fingerprint 短路）+重挂后新追加仍达（watch 重建）", async () => {
    const r = await makeRig();
    try {
      const baseJ = jEn("i-1", TEXT_A, 0) + "\n";
      const baseS = sU("u1", TEXT_A) + "\n";
      await writeFile(r.jp, baseJ);
      await writeFile(r.sp, baseS);
      const { c, sub } = await subAndWait(r);
      await settle(WARM);
      const tmp = r.sp + ".tmp";
      await writeFile(tmp, baseS); // 同字节、未来 rename 换 inode
      const { rename } = await import("node:fs/promises");
      await rename(tmp, r.sp);
      await settle(300);
      expect(errFrames(c).length).toBe(0); // 同字节短路：无 4409
      expect(r.audits.some((l) => l.includes("fingerprint-skip-identity-change"))).toBe(true);
      await appendFile(r.sp, sU("u3", TEXT_B) + "\n"); // 新 inode 上追加
      await until(() => c.events(sub).some((e) => e.entryId === "u3"));
      expect(c.events(sub).filter((e) => e.entryId === "u3")).toHaveLength(1); // 重挂成活
      expect(errFrames(c).length).toBe(0);
    } finally {
      await r.dispose();
    }
  });

  it("RF4 rename-over 改写：在订连接收 4409（invalid-stream 真路径）；重订得新 streamId", async () => {
    const r = await makeRig();
    try {
      await writeFile(r.jp, jEn("i-1", TEXT_A, 0) + "\n");
      await writeFile(r.sp, sU("u1", TEXT_A) + "\n");
      const { c, sub } = await subAndWait(r);
      const oldStream = (c.frames().find((f) => f.t === "snapshot") as { streamId?: string })?.streamId;
      await settle(WARM);
      const tmp = r.sp + ".tmp";
      await writeFile(tmp, sU("u1", "hello rewritten") + "\n"); // 改写（前缀破坏）
      const { rename } = await import("node:fs/promises");
      await rename(tmp, r.sp);
      await until(() => errFrames(c, 4409).length + c.frames().filter((f) => f.t === "resync-required").length > 0);
      await settle(150);
      // 重订：新流新内容
      const c2 = await r.authed();
      await c2.say({ t: "subscribe", requestId: "s2", file: "j.jsonl" });
      await until(() => c2.frames().some((f) => f.t === "snapshot"));
      const snap2 = c2.frames().find((f) => f.t === "snapshot") as { streamId?: string; barrier?: number };
      expect(snap2.streamId).not.toBe(oldStream);
      expect(snap2.barrier).toBe(2); // journal 1 + session 改写后 1
      expect(c2.frames().some((f) => f.t === "resync-required")).toBe(false);
      void sub;
    } finally {
      await r.dispose();
    }
  });

  it("RF5 delete：unlink→4402（retryable=true）+订阅终止；RF6 recreate：新装载成流", async () => {
    const r = await makeRig();
    try {
      await writeFile(r.jp, jEn("i-1", TEXT_A, 0) + "\n");
      await writeFile(r.sp, sU("u1", TEXT_A) + "\n");
      const { c } = await subAndWait(r);
      await settle(WARM);
      await unlink(r.jp);
      await until(() => errFrames(c, 4402).length > 0);
      const e = errFrames(c, 4402)[0] as { retryable?: boolean };
      expect(e.retryable).toBe(true); // 契约：4402 容量/不可读错可重试
      // recreate：同路径重写
      await writeFile(r.jp, jEn("i-1", TEXT_A, 0) + "\n");
      const c2 = await r.authed();
      await c2.say({ t: "subscribe", requestId: "s3", file: "j.jsonl" });
      await until(() => c2.frames().some((f) => f.t === "snapshot"));
      const snap = c2.frames().find((f) => f.t === "snapshot") as { barrier?: number };
      expect(snap.barrier).toBe(2); // 双源完整装载
      expect(errFrames(c2).length).toBe(0);
    } finally {
      await r.dispose();
    }
  });

  it("RF7 缺源恢复晚附：journal-only 订阅→session 落盘→后续新行直达+晚附行恰一次", async () => {
    const r = await makeRig();
    try {
      await writeFile(r.jp, jEn("i-1", TEXT_A, 0) + "\n"); // 无 session
      const { c, sub } = await subAndWait(r);
      expect((c.frames().find((f) => f.t === "snapshot") as { barrier?: number }).barrier).toBe(1); // journal-only
      await settle(WARM);
      await writeFile(r.sp, sU("u1", TEXT_A) + "\n"); // session 恢复
      const c2 = await r.authed(); // B 触发装载→晚附 A
      await c2.say({ t: "subscribe", requestId: "sb", file: "j.jsonl" });
      await until(() => c.events(sub).some((e) => e.entryId === "u1"));
      expect(c.events(sub).filter((e) => e.entryId === "u1")).toHaveLength(1); // 恢复行恰一次
      await appendFile(r.sp, sU("u2", TEXT_B) + "\n"); // 晚附成活：新行直达
      await until(() => c.events(sub).some((e) => e.entryId === "u2"));
      expect(c.events(sub).filter((e) => e.entryId === "u2")).toHaveLength(1);
      expect(errFrames(c).length).toBe(0);
    } finally {
      await r.dispose();
    }
  });

  it("RF8 旧 cursor 分页：H 后增长 2 行→resync(cursor@H) 补齐 2 行→续投 live 无重无漏", async () => {
    const r = await makeRig();
    try {
      await writeFile(r.jp, jEn("i-1", TEXT_A, 0) + "\n");
      await writeFile(r.sp, sU("u1", TEXT_A) + "\n");
      const { c, sub } = await subAndWait(r);
      const snap1 = c.frames().find((f) => f.t === "snapshot") as { streamId?: string; page?: Array<{ seq?: number }> };
      const streamId = snap1.streamId ?? "";
      // 单页快照 historyNext=null——续读 cursor=已见末位 seq（客户端视角：跟踪最后收到的 seq）
      const h = Math.max(0, ...(snap1.page ?? []).map((e) => Number(e.seq ?? 0)));
      await settle(WARM);
      await appendFile(r.jp, jEn("i-2", TEXT_B, 0) + "\n");
      await appendFile(r.sp, sU("u2", TEXT_B) + "\n");
      await until(() => c.events(sub).length >= 2); // A live 收 2
      const c2 = await r.authed(); // 断线客户端用旧 cursor 续读
      await c2.say({ t: "subscribe", requestId: "rc", file: "j.jsonl", cursor: { streamId, seq: h } });
      await until(() => c2.frames().some((f) => f.t === "snapshot"));
      const snap2 = c2.frames().find((f) => f.t === "snapshot") as { page?: Array<Record<string, unknown>>; historyNext?: { seq: number } };
      const paged = snap2.page ?? [];
      // 契约 §212：cursor{streamId,455}→补 455..H'（含起始 seq 的重发语义——幂等续读）
      expect(paged.map((e) => e.seq).sort((x, y) => Number(x) - Number(y))).toEqual([h, h + 1, h + 2]); // 增长 2 行恰入（含游标重发）
      await appendFile(r.sp, sU("u3", TEXT_C) + "\n"); // 续投 live
      // 快照后追加的行经 events 帧续投（origin=history|live 取决于引擎相位——恰一次为断言面）
      await until(() => c2.frames().filter((f) => f.t === "events").flatMap((f) => f.events as Array<Record<string, unknown>>).some((e) => e.entryId === "u3"));
      const ev2 = c2.frames().filter((f) => f.t === "events").flatMap((f) => f.events as Array<Record<string, unknown>>);
      expect(ev2.filter((e) => e.entryId === "u3")).toHaveLength(1); // 恰一次
      expect(c.events(sub).filter((e) => e.entryId === "u3")).toHaveLength(1); // A 也恰一次
      expect(errFrames(c2, 4404).length).toBe(0);
      expect(errFrames(c2, 4409).length).toBe(0);
    } finally {
      await r.dispose();
    }
  });

  it("RF9 句柄票据收口：全退订后盘面追加静默（观察代理零泄漏）+再订可恢复", async () => {
    const r = await makeRig();
    try {
      await writeFile(r.jp, jEn("i-1", TEXT_A, 0) + "\n");
      await writeFile(r.sp, sU("u1", TEXT_A) + "\n");
      const a = await subAndWait(r, "s-a");
      const b = await subAndWait(r, "s-b");
      await settle(WARM);
      const framesA = a.c.sent.length;
      const framesB = b.c.sent.length;
      await a.c.say({ t: "unsubscribe", requestId: "u-a", subscriptionId: a.sub });
      await b.c.say({ t: "unsubscribe", requestId: "u-b", subscriptionId: b.sub });
      await settle(WARM);
      await appendFile(r.sp, sU("u5", TEXT_C) + "\n"); // 无人观察期增长
      await appendFile(r.jp, jEn("i-5", TEXT_C, 0) + "\n");
      await settle(400);
      expect(a.c.sent.length).toBe(framesA); // 静默：无任何新帧（事件/错误/状态）
      expect(b.c.sent.length).toBe(framesB);
      const c3 = await r.authed(); // 再订：按需装载恢复
      await c3.say({ t: "subscribe", requestId: "s-c", file: "j.jsonl" });
      await until(() => c3.frames().some((f) => f.t === "snapshot"));
      const snap = c3.frames().find((f) => f.t === "snapshot") as { barrier?: number };
      expect(snap.barrier).toBe(4); // J1,S1,S5(u5),J5(i-5) 增长期全部编入
      expect(errFrames(c3).length).toBe(0);
    } finally {
      await r.dispose();
    }
  });

  it("RF10 4404 真路径：从未装载文件的 resync cursor→4404（错流门）", async () => {
    const r = await makeRig();
    try {
      const c = await r.authed();
      await c.say({ t: "subscribe", requestId: "r404", file: "j.jsonl", cursor: { streamId: "bogus-stream", seq: 1 } });
      await until(() => errFrames(c, 4404).length > 0);
      expect(r.audits.some((l) => l.includes("resync-wrong-stream"))).toBe(true);
    } finally {
      await r.dispose();
    }
  });
});
