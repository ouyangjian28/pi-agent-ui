// 3b-3③：真实传输+慢客户端矩阵（冻结案③，PROJECT.md 3b-3 节）
// 组合根 startServer 起**真 ws 监听**（127.0.0.1:0）+真 ws 客户端（ws 库）——无 LLM 默认跑。
// 场景对照（冻结清单）：快/慢双连接并存；4431 两级分立（订阅级 retryable=false 关订阅 vs 连接级 retryable=true 断链）；
// 应用门 262,144B（4404）vs 传输门 1MiB（close 1009）；慢客户端恢复（cursor 续读）；断开竞态+跨连接共享观察；
// Origin 403/token 4401 真路径。（clientIp/代理面由 ws-transport.net.test.ts 覆盖，此处不重复。）
import { describe, expect, it } from "vitest";
import { appendFile, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startServer, type PiAgentUiServer } from "../../apps/server/src/composition.ts";
import { matchKeyOf } from "@pi-agent-ui/protocol";

const tick = (): Promise<void> => new Promise((res) => setImmediate(() => res()));
const settle = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));
async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("until 超时");
    await tick();
  }
}
const WARM = 150;

class WsClient {
  readonly ws: WebSocket;
  frames: Array<Record<string, unknown>> = [];
  closed: { code: number | undefined; reason: string } | null = null;
  opened = false;
  private waiters: Array<() => void> = [];
  constructor(url: string, origin: string) {
    this.ws = new WebSocket(url, { headers: { Origin: origin } });
    this.ws.on("open", () => { this.opened = true; });
    this.ws.on("message", (d) => {
      this.frames.push(JSON.parse(d.toString()) as Record<string, unknown>);
      for (const w of this.waiters.splice(0)) w();
    });
    this.ws.on("close", (code, reason) => { this.closed = { code, reason: reason.toString() }; for (const w of this.waiters.splice(0)) w(); });
  }
  get alive(): boolean { return this.ws.readyState === WebSocket.OPEN; }
  async waitOpen(ms = 5000): Promise<void> {
    if (this.opened) return;
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error("ws open 超时")), ms);
      this.ws.once("open", () => { clearTimeout(t); res(); });
      this.ws.once("unexpected-response", () => { clearTimeout(t); rej(new Error("ws 握手被拒")); });
      this.ws.once("error", (e) => { clearTimeout(t); rej(e); });
    });
  }
  async say(obj: unknown): Promise<void> {
    await this.waitOpen();
    this.ws.send(JSON.stringify(obj));
    await tick(); await tick();
  }
  async hello(token = "tok-ok"): Promise<void> {
    await this.say({ t: "hello", protocolVersion: 1, token });
    await until(() => this.frames.some((f) => f.t === "welcome" || f.t === "error"));
  }
  events(sub: string): Array<Record<string, unknown>> {
    return this.frames.filter((f) => f.t === "events" && f.subscriptionId === sub).flatMap((f) => f.events as Array<Record<string, unknown>>);
  }
  errs(code?: number): Array<Record<string, unknown>> {
    return this.frames.filter((f) => f.t === "error" && (code === undefined || f.code === code));
  }
  pauseSocket(): void { (this.ws as unknown as { _socket: { pause(): void } })._socket.pause(); }
  resumeSocket(): void { (this.ws as unknown as { _socket: { resume(): void } })._socket.resume(); }
  dispose(): void { this.ws.terminate(); }
}

const jEn = (i: string, t: string, o: number) => JSON.stringify({ t: "enqueue", intentId: i, sessionId: "s", generation: 1, leafId: "L", matchKey: matchKeyOf(t, [], o), payload: { kind: "prompt", rawText: t, attachments: [], sentAt: "1" } });

interface Rig { srv: PiAgentUiServer; url: string; jp: string; audits: string[]; dispose(): Promise<void>; }
async function makeRig(): Promise<Rig> {
  const jr = await mkdtemp(join(tmpdir(), "rw-j-"));
  const sr = await mkdtemp(join(tmpdir(), "rw-s-"));
  const td = await mkdtemp(join(tmpdir(), "rw-t-"));
  const tokenFile = join(td, "tokens.json");
  await writeFile(tokenFile, JSON.stringify({ version: 1, tokens: ["tok-ok"] }), { mode: 0o600 });
  await chmod(tokenFile, 0o600);
  const jp = join(jr, "j.jsonl");
  const sp = join(sr, "sess.jsonl");
  const audits: string[] = [];
  const srv = await startServer({
    tokenFile,
    allowedOrigins: ["http://localhost:5173"],
    roots: [jr],
    sessionRoots: [sr],
    sessionFor: () => sp,
    scanDir: jr,
    host: "127.0.0.1",
    port: 0,
    tokenPollMs: 0,
    audit: (l) => { audits.push(l); },
  });
  const url = `ws://127.0.0.1:${srv.port}`;
  const clients: WsClient[] = [];
  return {
    srv, url, jp, audits,
    dispose: async () => {
      for (const c of clients) c.dispose();
      await srv.dispose();
      await rm(jr, { recursive: true, force: true });
      await rm(sr, { recursive: true, force: true });
      await rm(td, { recursive: true, force: true });
    },
  };
}

function openClient(url: string, origin = "http://localhost:5173"): WsClient { return new WsClient(url, origin); }

async function seedJournal(jp: string, n: number): Promise<void> {
  let buf = "";
  for (let k = 1; k <= n; k++) buf += jEn(`i-${k}`, `turn ${k} payload`, 0) + "\n";
  await writeFile(jp, buf);
}
async function appendBurst(jp: string, from: number, to: number): Promise<void> {
  let buf = "";
  for (let k = from; k <= to; k++) buf += jEn(`i-${k}`, `turn ${k} payload`, 0) + "\n";
  await appendFile(jp, buf);
}

describe("3b-3③ real-ws：真实传输+慢客户端矩阵", () => {
  it("RW1 快/慢并存：慢客户端卡分页→订阅级 4431（retryable=false 只关订阅）；快客户端全量不受影响；慢客户端 cursor 续读恢复", async () => {
    const r = await makeRig();
    try {
      await seedJournal(r.jp, 250); // >pageMaxEvents(200)→快照分页
      const fast = openClient(r.url);
      const slow = openClient(r.url);
      try {
        await fast.hello();
        await slow.hello();
        await fast.say({ t: "subscribe", requestId: "fa", file: "j.jsonl" });
        await slow.say({ t: "subscribe", requestId: "sb", file: "j.jsonl" });
        await until(() => fast.frames.some((f) => f.t === "snapshot") && slow.frames.some((f) => f.t === "snapshot"));
        const fastSnap = fast.frames.find((f) => f.t === "snapshot") as Record<string, unknown>;
        const slowSnap = slow.frames.find((f) => f.t === "snapshot") as Record<string, unknown>;
        expect(fastSnap.hasMore).toBe(true); // 两端都停在第一页（200）
        const slowSub = slowSnap.subscriptionId as string;
        const fastSub = fastSnap.subscriptionId as string;
        // 快客户端追平（第二页 50）
        await fast.say({ t: "subscribe", requestId: "fa2", file: "j.jsonl", snapshotId: fastSnap.snapshotId, historyNext: fastSnap.historyNext });
        await until(() => fast.frames.filter((f) => f.t === "snapshot").some((f) => f.hasMore === false));
        await settle(WARM);
        // 慢客户端永不翻页——快照滞留态下灌 1100 事件（>订阅积压 1024）
        await appendBurst(r.jp, 251, 1350);
        await until(() => slow.errs(4431).length > 0);
        const e4431 = slow.errs(4431)[0] as { retryable?: boolean; message?: string };
        expect(e4431.retryable).toBe(false); // 订阅级：可恢复=重新订阅，连接不断
        expect(e4431.message).toContain("订阅积压超限"); // 慢客户端语义显式化
        await settle(300);
        expect(slow.events(slowSub).length).toBe(0); // 关订阅后零残留事件帧
        expect(slow.alive).toBe(true); // 连接仍在（订阅级不断链）
        // 快客户端全量到账：200+50+1100（live 续投）
        await until(() => fast.events(fastSub).length >= 1100);
        await settle(250);
        expect(fast.events(fastSub).length).toBe(1100); // 恰全量
        expect(fast.errs().length).toBe(0);
        // 慢客户端恢复：cursor 续读（含起始 seq 重发；翻页到追平——契约 §212）
        await slow.say({ t: "subscribe", requestId: "sb2", file: "j.jsonl", cursor: { streamId: slowSnap.streamId as string, seq: 200 } });
        await until(() => slow.frames.some((f) => f.t === "snapshot" && f.subscriptionId !== slowSub));
        for (let guard = 0; guard < 12; guard++) {
          const cur = slow.frames.filter((f) => f.t === "snapshot").pop() as { page?: Array<{ seq?: number }>; hasMore?: boolean; snapshotId?: string; historyNext?: { streamId: string; seq: number } | null };
          if (cur.hasMore === false) break;
          await slow.say({ t: "subscribe", requestId: `sb2p${guard}`, file: "j.jsonl", snapshotId: cur.snapshotId, historyNext: cur.historyNext });
          await until(() => { const last = slow.frames.filter((f) => f.t === "snapshot").pop() as { snapshotId?: string }; return last.snapshotId === cur.snapshotId && slow.frames.filter((f) => f.t === "snapshot").length >= guard + 3; });
        }
        const snap2 = slow.frames.filter((f) => f.t === "snapshot").pop() as { page?: Array<{ seq?: number }>; hasMore?: boolean };
        expect(Number(snap2.page?.slice(-1)[0]?.seq)).toBe(1350); // 翻页补齐到末位
        expect(snap2.hasMore).toBe(false);
      } finally {
        fast.dispose(); slow.dispose();
      }
    } finally {
      await r.dispose();
    }
  }, 20000);

  it("RW2 停读套接字（真慢客户端）：live 积压转运→连接级 4431（retryable=true 断链重连）；订阅级不误杀", async () => {
    const r = await makeRig();
    try {
      await seedJournal(r.jp, 250);
      const a = openClient(r.url);
      try {
        await a.hello();
        await a.say({ t: "subscribe", requestId: "s1", file: "j.jsonl" });
        await until(() => a.frames.some((f) => f.t === "snapshot"));
        const snap = a.frames.find((f) => f.t === "snapshot") as Record<string, unknown>;
        await a.say({ t: "subscribe", requestId: "s2", file: "j.jsonl", snapshotId: snap.snapshotId, historyNext: snap.historyNext });
        await until(() => a.frames.filter((f) => f.t === "snapshot").some((f) => f.hasMore === false));
        await settle(WARM);
        a.pauseSocket(); // 真停读：内核缓冲+服务端出账都无法前进
        await appendBurst(r.jp, 251, 7000); // ~1.2MB 事件流（超 connQueueBytes 1MiB+订阅积压 1024）
        await settle(1200); // 服务端侧堆积判定的观察窗（不依赖客户端反馈）
        a.resumeSocket(); // 恢复读：堆积帧倾泻（含 4431 错误帧与 close）
        await until(() => a.closed !== null || a.errs(4431).length > 0, 5000);
        await settle(400);
        // 3b3c 两级语义（同步排水修正后）：live 引擎 outbox 由同步排水搬运→真慢客户端积压转入连接发送队列；
        // 订阅级 4431 只属于 paging 滞留（RW1 面），本场景不触发。
        expect(a.errs(4431).some((x) => x.retryable === false)).toBe(false); // 无订阅级误杀
        const conn4431 = a.errs(4431).find((x) => x.retryable === true);
        expect(conn4431).toBeDefined(); // 连接级 4431（发送队列超限，可重连续读）
        expect((conn4431 as { message?: string }).message).toContain("发送队列超限");
      } finally {
        a.dispose();
      }
    } finally {
      await r.dispose();
    }
  });

  it("RW3 字节门两级：262,145B 应用帧→4404（帧超字节上限）；>1MiB 传输帧→close 1009", async () => {
    const r = await makeRig();
    try {
      const a = openClient(r.url);
      try {
        await a.hello();
        const pad262k = JSON.stringify({ t: "hello", protocolVersion: 1, token: "tok-ok", pad: "a".repeat(262_145) });
        expect(Buffer.byteLength(pad262k)).toBeGreaterThan(262_144);
        await a.say(JSON.parse(pad262k) as Record<string, unknown>); // 应用门：网关 4404
        await until(() => a.errs(4404).length > 0);
        expect((a.errs(4404)[0] as { message?: string }).message).toContain("帧超字节上限");
        expect(a.closed).toBeNull(); // 应用门不断链
        // 传输门：单帧 >1MiB——接收器 close 1009（可无应用 error 帧）
        const big = "a".repeat(1_100_000);
        a.ws.send(JSON.stringify({ t: "hello", protocolVersion: 1, token: "tok-ok", pad: big }));
        await until(() => a.closed !== null, 5000);
        expect(a.closed?.code).toBe(1009);
      } finally {
        a.dispose();
      }
    } finally {
      await r.dispose();
    }
  });

  it("RW4 Origin/token 真路径：白名单外 Origin→HTTP 403 拒握手；坏 token→4401+close 1008", async () => {
    const r = await makeRig();
    try {
      const rejectP = new Promise<number>((res) => {
        const ws = new WebSocket(r.url, { headers: { Origin: "http://evil.example" } });
        ws.on("unexpected-response", (_req, rs) => { res(rs.statusCode ?? 0); ws.terminate(); });
        ws.on("open", () => { res(-1); ws.terminate(); });
      });
      expect(await rejectP).toBe(403);
      const a = openClient(r.url);
      try {
        await a.hello("tok-bad");
        expect(a.errs(4401).length).toBe(1);
        await until(() => a.closed !== null);
        expect(a.closed?.code).toBe(1008);
      } finally {
        a.dispose();
      }
    } finally {
      await r.dispose();
    }
  });

  it("RW5 断开竞态：A 硬断（不退订）→B 共享观察不受扰，续投恰一次；服务端连接清理有审计", async () => {
    const r = await makeRig();
    try {
      await seedJournal(r.jp, 3);
      const a = openClient(r.url);
      const b = openClient(r.url);
      try {
        await a.hello();
        await b.hello();
        await a.say({ t: "subscribe", requestId: "sa", file: "j.jsonl" });
        await b.say({ t: "subscribe", requestId: "sb", file: "j.jsonl" });
        await until(() => a.frames.some((f) => f.t === "snapshot") && b.frames.some((f) => f.t === "snapshot"));
        const bSub = (b.frames.find((f) => f.t === "snapshot") as { subscriptionId: string }).subscriptionId;
        await settle(WARM);
        await appendBurst(r.jp, 4, 23);
        await until(() => b.events(bSub).length >= 20);
        a.dispose(); // A 硬断：无 unsubscribe——网关须靠传输 onClose 清理
        await settle(400);
        await appendBurst(r.jp, 24, 33);
        await until(() => b.events(bSub).length >= 30);
        await settle(200);
        expect(b.events(bSub).length).toBe(30); // B 恰全量（20+10），A 断开零影响
        expect(b.errs().length).toBe(0);
        await until(() => r.audits.some((l) => l.includes("conn-transport-closed")));
      } finally {
        a.dispose(); b.dispose();
      }
    } finally {
      await r.dispose();
    }
  });
});
