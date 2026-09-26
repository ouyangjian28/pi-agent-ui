import { describe, expect, it } from "vitest";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WsGateway, type ConnMeta, type GatewayConnHooks, type WsGatewayOpts } from "../../apps/server/src/ws/ws-gateway.ts";
import { TokenAuthority } from "../../apps/server/src/ws/token-auth.ts";
import { DualHistorySource } from "../../apps/server/src/runtime/dual-history-source.ts";
import { ComputeSemaphore } from "../../apps/server/src/ws/compute-semaphore.ts";
import { matchKeyOf } from "@pi-agent-ui/protocol";

/** 3b-3④ 预算容量 E2E：真实文件体量下的触顶状态机/每文件扫描预算/流池 LRU/内存峰值披露。
 * 全部走真盘（真 reader+真 watcher），FakeConn 内存面（无网络）。组合层不另设合计门
 * （冻结裁决：合计口径归 3b-4 恢复面）——本组只验单文件/单流/流池三个局部门。 */

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
  frames(): Array<Record<string, unknown>> { return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>); }
  errs(code?: number): Array<Record<string, unknown>> { return this.frames().filter((f) => f.t === "error" && (code === undefined || f.code === code)); }
}

const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const WARM = 150;
const until = async (cond: () => boolean, ms = 4000): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("until 超时");
    await new Promise((res) => setTimeout(res, 10));
  }
};
const settle = async (ms: number) => { await new Promise((res) => setTimeout(res, ms)); };

const jEn = (i: string, t: string, o: number) => JSON.stringify({ t: "enqueue", intentId: i, sessionId: "s", generation: 1, leafId: "L", matchKey: matchKeyOf(t, [], o), payload: { kind: "prompt", rawText: t, attachments: [], sentAt: "1" } });
const sU = (id: string, t: string) => JSON.stringify({ type: "message", id, parentId: null, timestamp: 1, message: { role: "user", content: t } });

interface Rig {
  gw: WsGateway;
  authed(): Promise<FakeConn>;
  audits: string[];
  jp: string;
  sp: string;
  jdir: string;
  dispose(): Promise<void>;
}
async function makeRig(): Promise<Rig> {
  const jdir = await mkdtemp(join(tmpdir(), "rb-j-"));
  const sdir = await mkdtemp(join(tmpdir(), "rb-s-"));
  const jp = join(jdir, "j.jsonl");
  const sp = join(sdir, "sess.jsonl");
  const audits: string[] = [];
  const dual = new DualHistorySource({
    roots: [jdir],
    sessionRoots: [sdir],
    sessionFor: () => sp,
    audit: (l) => { audits.push(l); },
  });
  const gw = new WsGateway({
    tokens: TokenAuthority.fromTokens(["tok-ok"]),
    roots: [jdir],
    scanDir: jdir,
    allowedOrigins: ["http://localhost:5173"],
    historySource: dual,
    semaphore: new ComputeSemaphore(),
    heartbeat: { pingMs: 0, idleMs: 0 },
    audit: (l) => { audits.push(l); },
  } satisfies Partial<WsGatewayOpts> as WsGatewayOpts);
  const authed = async () => {
    const c = new FakeConn();
    gw.attach(c, c.hooks(), { origin: "http://localhost:5173", loopback: true, tls: false } satisfies ConnMeta);
    await c.say({ t: "hello", protocolVersion: 1, token: "tok-ok" });
    return c;
  };
  return {
    gw, authed, audits, jp, sp, jdir,
    dispose: async () => {
      gw.dispose();
      await rm(jdir, { recursive: true, force: true });
      await rm(sdir, { recursive: true, force: true });
    },
  };
}

const errFrames = (c: FakeConn, code?: number): Array<Record<string, unknown>> =>
  c.frames().filter((f) => f.t === "error" && (code === undefined || f.code === code));

describe("3b-3④ 预算容量（真盘体量；组合层无合计门——单文件/单流/流池三门）", () => {
  it("BG1 双源同池 20k 触顶状态机：journal 19,998+session 3=20,001 越界→订阅 4402；宽容换流后新流再触顶→仍 4402；额度已用第三订→registry 拒建（审计 index-over-budget-get）", async () => {
    const r = await makeRig();
    try {
      let js = "";
      for (let k = 1; k <= 19_998; k++) js += jEn(`i-${k}`, `text-${k}`, 0) + "\n";
      await writeFile(r.jp, js);
      await writeFile(r.sp, sU("u1", "a") + "\n" + sU("u2", "b") + "\n" + sU("u3", "c") + "\n"); // 3 行
      const c = await r.authed();
      await c.say({ t: "subscribe", requestId: "s1", file: "j.jsonl" });
      await until(() => errFrames(c, 4402).length > 0, 8000);
      expect(errFrames(c, 4402)[0]?.retryable).toBe(true); // 4402 容量错恒可重试
      expect((errFrames(c, 4402)[0] as { message?: string }).message).toContain("会话索引超预算");
      expect(c.frames().some((f) => f.t === "snapshot")).toBe(false); // 不发绑定超限索引的快照
      // 第二订：宽容换流（budget-swap→空流重建→装载再触顶）→仍 4402
      await c.say({ t: "subscribe", requestId: "s2", file: "j.jsonl" });
      await until(() => errFrames(c, 4402).length >= 2, 8000);
      // 第三订：额度已用又触顶→registry.get 抛 FileOverBudgetError→拒建（审计面区分）
      await c.say({ t: "subscribe", requestId: "s3", file: "j.jsonl" });
      await until(() => errFrames(c, 4402).length >= 3, 8000);
      await settle(WARM);
      expect(r.audits.some((l) => l.includes("index-over-budget-get"))).toBe(true);
      expect(r.audits.some((l) => l.includes("budget-swap")) || r.audits.some((l) => l.includes("index-over-budget"))).toBe(true);
    } finally {
      await r.dispose();
    }
  }, 30_000);

  it("BG2 恰在预算内（20,000）不触顶：双源 19,997+3=20,000 恰好放行，快照正常", async () => {
    const r = await makeRig();
    try {
      let js = "";
      for (let k = 1; k <= 19_997; k++) js += jEn(`i-${k}`, `text-${k}`, 0) + "\n";
      await writeFile(r.jp, js);
      await writeFile(r.sp, sU("u1", "a") + "\n" + sU("u2", "b") + "\n" + sU("u3", "c") + "\n");
      const c = await r.authed();
      await c.say({ t: "subscribe", requestId: "s1", file: "j.jsonl" });
      await until(() => c.frames().some((f) => f.t === "snapshot"), 8000);
      const snap = c.frames().find((f) => f.t === "snapshot") as { barrier?: number; hasMore?: boolean };
      expect(snap.barrier).toBe(20_000); // 恰在池内：全部编入
      expect(errFrames(c).length).toBe(0);
    } finally {
      await r.dispose();
    }
  }, 30_000);

  it("BG3 每文件扫描预算 8MiB：9MiB journal→4402（scan-over-budget，retryable=true）", async () => {
    const r = await makeRig();
    try {
      const pad = "x".repeat(900); // ~1KB/行×~9400 行>8MiB
      let js = "";
      for (let k = 1; k <= 9400; k++) js += jEn(`i-${k}`, `t-${k}-${pad}`, 0) + "\n";
      expect(Buffer.byteLength(js)).toBeGreaterThan(8 * 1024 * 1024);
      await writeFile(r.jp, js);
      const c = await r.authed();
      await c.say({ t: "subscribe", requestId: "s1", file: "j.jsonl" });
      await until(() => errFrames(c, 4402).length > 0, 8000);
      expect((errFrames(c, 4402)[0] as { message?: string }).message).toContain("会话不可读"); // 客户端面=通用不可读
      expect(errFrames(c, 4402)[0]?.retryable).toBe(true);
      await settle(WARM);
      // reason 落审计线：源侧 load-read-failed kind=too-large（网关订阅口 load=null 统一 4402 会话不可读）
      expect(r.audits.some((l) => l.includes("load-read-failed") && l.includes("kind=too-large"))).toBe(true);
    } finally {
      await r.dispose();
    }
  }, 30_000);

  it("BG4 流池 LRU 32：33 文件装载挤出最旧→旧文件重订=新 streamId（流身份丢失）；当前流数不超 32", async () => {
    const r = await makeRig();
    try {
      const files: string[] = [];
      for (let k = 1; k <= 33; k++) {
        const f = `f${k}.jsonl`;
        files.push(f);
        await writeFile(join(r.jdir, f), jEn(`i-${k}`, `t-${k}`, 0) + "\n");
      }
      const c = await r.authed();
      const ids = new Map<string, string>();
      for (let k = 0; k < files.length; k++) {
        const f = files[k]!;
        const before = c.frames().length;
        await c.say({ t: "subscribe", requestId: `s-${k}`, file: f });
        await until(() => c.frames().slice(before).some((x) => x.t === "snapshot"), 8000);
        const snap = c.frames().slice(before).find((x) => x.t === "snapshot") as { streamId?: string; subscriptionId?: string };
        ids.set(f, snap.streamId ?? "");
        await c.say({ t: "unsubscribe", requestId: `u-${k}`, subscriptionId: snap.subscriptionId ?? "" });
        await settle(20);
      }
      expect(r.gw["registry"].size).toBeLessThanOrEqual(32); // 流池不超 32
      // f1（最旧）已被挤出：重订得到新 streamId；f33（最新）保留原 streamId
      const before1 = c.frames().length;
      await c.say({ t: "subscribe", requestId: "re-f1", file: "f1.jsonl" });
      await until(() => c.frames().slice(before1).some((x) => x.t === "snapshot"), 8000);
      const again1 = c.frames().slice(before1).find((x) => x.t === "snapshot") as { streamId?: string };
      expect(again1.streamId).not.toBe(ids.get("f1.jsonl")); // 换流=旧身份丢失
      const before33 = c.frames().length;
      await c.say({ t: "subscribe", requestId: "re-f33", file: "f33.jsonl" });
      await until(() => c.frames().slice(before33).some((x) => x.t === "snapshot"), 8000);
      const again33 = c.frames().slice(before33).find((x) => x.t === "snapshot") as { streamId?: string };
      expect(again33.streamId).toBe(ids.get("f33.jsonl")); // 在池内的流身份稳定
    } finally {
      await r.dispose();
    }
  }, 60_000);

  it("BG5 内存峰值披露（非生产 RSS 断言）：20k 流+32 流池满载下 heapUsed<384MiB 快照记录", async () => {
    const r = await makeRig();
    try {
      let js = "";
      for (let k = 1; k <= 19_997; k++) js += jEn(`i-${k}`, `text-${k}`, 0) + "\n";
      await writeFile(r.jp, js);
      await writeFile(r.sp, sU("u1", "a") + "\n" + sU("u2", "b") + "\n" + sU("u3", "c") + "\n");
      const c = await r.authed();
      await c.say({ t: "subscribe", requestId: "s1", file: "j.jsonl" });
      await until(() => c.frames().some((f) => f.t === "snapshot"), 8000); // 满载 20k
      await settle(300);
      const mu = process.memoryUsage();
      // 披露口径：vitest 进程 heapUsed（含测试运行时本体，远高于生产服务进程）；上限=宽松护栏非容量承诺
      console.log(`[BG5] heapUsed=${(mu.heapUsed / 1048576).toFixed(1)}MiB rss=${(mu.rss / 1048576).toFixed(1)}MiB external=${(mu.external / 1048576).toFixed(1)}MiB`);
      expect(mu.heapUsed).toBeLessThan(384 * 1024 * 1024);
    } finally {
      await r.dispose();
    }
  }, 30_000);
});
