// 3b-4 集成：真组合根（startServer 真 ws 监听）+真读源 recoveryEvidence——
// 验收②③：≥501 条多页完整期望 ID 数组；缓存命中期间源变仍同 hash 冻结页（无 hash 刷新）；
// 合计 8MiB 入口预算真路径（oversized 帧）；journal 缺失→file-unreadable→error 4402 retryable=true。
// （网关分页缓存/LRU 驱逐/挂起断开的假源面已由 ws-gateway.test.ts B7/B8/R4a/R4b/D22 覆盖——此处只证真源接线。）
import { describe, expect, it } from "vitest";
import { appendFile, chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startServer, type PiAgentUiServer } from "../../apps/server/src/composition.ts";
import { matchKeyOf } from "@pi-agent-ui/protocol";

const tick = (): Promise<void> => new Promise((res) => setImmediate(() => res()));
async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("until 超时");
    await tick();
  }
}

class WsClient {
  readonly ws: WebSocket;
  frames: Array<Record<string, unknown>> = [];
  opened = false;
  constructor(url: string, origin: string) {
    this.ws = new WebSocket(url, { headers: { Origin: origin } });
    this.ws.on("open", () => { this.opened = true; });
    this.ws.on("message", (d) => { this.frames.push(JSON.parse(d.toString()) as Record<string, unknown>); });
  }
  async say(obj: unknown): Promise<void> {
    await new Promise<void>((res) => { this.ws.once("open", () => res()); if (this.opened) res(); });
    this.ws.send(JSON.stringify(obj));
    await tick(); await tick();
  }
  async hello(): Promise<void> {
    await this.say({ t: "hello", protocolVersion: 1, token: "tok-ok" });
    await until(() => this.frames.some((f) => f.t === "welcome"));
  }
  recovery(): Array<Record<string, unknown>> { return this.frames.filter((f) => f.t === "recovery"); }
  errors(): Array<Record<string, unknown>> { return this.frames.filter((f) => f.t === "error"); }
  dispose(): void { this.ws.terminate(); }
}

// sessionId=文件名去后缀（provider 默认派生 q.jsonl→"q"；生产不变量：journal 文件名=会话 id）
const jEn = (i: string, t: string, o: number, sid = "q") => JSON.stringify({ t: "enqueue", intentId: i, sessionId: sid, generation: 1, leafId: "L", matchKey: matchKeyOf(t, [], o), payload: { kind: "prompt", rawText: t, attachments: [], sentAt: "1" } });

interface Rig { srv: PiAgentUiServer; url: string; jp: string; sp: string; audits: string[]; }
async function makeRig(maxRecovery?: number): Promise<Rig> {
  const jr = await mkdtemp(join(tmpdir(), "rr-j-"));
  const sr = await mkdtemp(join(tmpdir(), "rr-s-"));
  const td = await mkdtemp(join(tmpdir(), "rr-t-"));
  const tokenFile = join(td, "tokens.json");
  await writeFile(tokenFile, JSON.stringify({ version: 1, tokens: ["tok-ok"] }), { mode: 0o600 });
  await chmod(tokenFile, 0o600);
  const jp = join(jr, "q.jsonl");
  const sp = join(sr, "q.session.jsonl");
  const audits: string[] = [];
  const srv = await startServer({
    tokenFile,
    allowedOrigins: ["http://localhost:5173"],
    roots: [jr],
    sessionRoots: [sr],
    sessionFor: () => "q.session.jsonl",
    scanDir: jr,
    ...(maxRecovery !== undefined ? { maxRecoveryCombinedBytes: maxRecovery } : {}),
    trustFirstRecoveryCapture: true, // fix12：集成 rig 宿主声明首捕权威（B12-1 默认关）
    audit: (l) => { audits.push(l); },
  });
  return { srv, url: `ws://127.0.0.1:${srv.port}`, jp, sp, audits };
}
const rigDispose = async (r: Rig): Promise<void> => { await r.srv.dispose(); };

describe("3b-4 恢复真读源集成（真 WS+真文件）", () => {
  it("I1 501 意图多页完整期望 ID 数组；源变后同 hash 续页=冻结页（无刷新）；无 hash=新快照", async () => {
    const r = await makeRig();
    const c = new WsClient(r.url, "http://localhost:5173");
    try {
      await writeFile(r.jp, Array.from({ length: 501 }, (_, i) => jEn(`i-${i + 1}`, `t-${i + 1}`, i)).join("\n") + "\n");
      await writeFile(r.sp, "");
      await c.hello();
      // 第 1 页
      await c.say({ t: "get-recovery", requestId: "p1", file: "q.jsonl", offset: 0 });
      await until(() => c.recovery().some((f) => f.availability === "available"));
      const p1 = c.recovery().at(-1) as Record<string, unknown>;
      const hash = p1.evidenceHash as string;
      const per1 = p1.perIntent as { items: unknown[]; total: number; next: { offset: number } | null };
      expect(per1.total).toBe(501);
      expect(per1.next).not.toBeNull(); // 501>页大小=有续页
      // 源变（缓存命中期间追加大块）：续页携同 hash→冻结投影（不受盘面变化影响）
      await appendFile(r.jp, jEn("i-extra", "t-extra", 501) + "\n");
      await c.say({ t: "get-recovery", requestId: "p1", file: "q.jsonl", offset: per1.next!.offset, evidenceHash: hash });
      await until(() => c.recovery().length >= 2);
      const p2 = c.recovery().at(-1) as Record<string, unknown>;
      expect(p2.evidenceHash).toBe(hash); // 同 hash=冻结版本（无刷新）
      const ids: string[] = [];
      for (const pg of [p1, p2] as Array<Record<string, unknown>>) {
        for (const it of (pg.perIntent as { items: Array<{ intentId: string }> }).items) ids.push(it.intentId);
      }
      expect(ids.length).toBe(501); // 两页拼回全集
      expect(new Set(ids).size).toBe(501); // 无重
      const remain = new Set(Array.from({ length: 501 }, (_, i) => `i-${i + 1}`));
      for (const id of ids) remain.delete(id);
      expect(remain.size).toBe(0); // 恰为期望集（非仅长度对照）
      expect(ids).not.toContain("i-extra"); // 冻结页不含缓存后追加
      // 无 hash=读当前→新快照（含 i-extra，total=502，hash 变）
      await c.say({ t: "get-recovery", requestId: "p1", file: "q.jsonl", offset: 0 });
      await until(() => c.recovery().length >= 3);
      const p3 = c.recovery().at(-1) as Record<string, unknown>;
      expect(p3.evidenceHash).not.toBe(hash);
      expect((p3.perIntent as { total: number }).total).toBe(502);
    } finally {
      c.dispose();
      await rigDispose(r);
    }
  });

  it("I2 合计 8MiB 入口预算真路径：journal+session 合计超→unavailable/oversized 帧", async () => {
    const r = await makeRig(10_000); // 真路径用注入预算档（默认 8MiB 档由单测 R8 证）
    const c = new WsClient(r.url, "http://localhost:5173");
    try {
      await writeFile(r.jp, Buffer.alloc(6_000));
      await writeFile(r.sp, Buffer.alloc(4_001)); // 合计 10001>10000
      await c.hello();
      await c.say({ t: "get-recovery", requestId: "o1", file: "q.jsonl", offset: 0 });
      await until(() => c.recovery().length > 0);
      const f = c.recovery().at(-1) as Record<string, unknown>;
      expect(f).toMatchObject({ availability: "unavailable", reason: "oversized" });
      expect(r.audits.some((l) => l.includes("recovery-oversized") && l.includes("file=q.jsonl"))).toBe(true);
    } finally {
      c.dispose();
      await rigDispose(r);
    }
  });

  it("I3 journal 缺失→file-unreadable→error 4402 retryable=true（契约映射；审计带逻辑文件）", async () => {
    const r = await makeRig();
    const c = new WsClient(r.url, "http://localhost:5173");
    try {
      await writeFile(r.sp, ""); // session 在场，journal 不存在
      await c.hello();
      await c.say({ t: "get-recovery", requestId: "g1", file: "q.jsonl", offset: 0 });
      await until(() => c.errors().length > 0);
      const f = c.errors().at(-1) as Record<string, unknown>;
      expect(f).toMatchObject({ t: "error", code: 4402, retryable: true });
      expect(r.audits.some((l) => l.includes("recovery-unreadable") && l.includes("file=q.jsonl"))).toBe(true);
    } finally {
      c.dispose();
      await rigDispose(r);
    }
  });

  it("I4 撕裂尾真源：末行无换行→快照含 torn-tail 证据→blockedReasons 呈现（不洗白）", async () => {
    const r = await makeRig();
    const c = new WsClient(r.url, "http://localhost:5173");
    try {
      await writeFile(r.sp, "");
      await writeFile(r.jp, jEn("i-1", "t-1", 0) + "\n" + jEn("i-2", "t-2", 1).slice(0, -20)); // 末行截断=撕裂尾
      await c.hello();
      await c.say({ t: "get-recovery", requestId: "t1", file: "q.jsonl", offset: 0 });
      await until(() => c.recovery().length > 0);
      const f = c.recovery().at(-1) as Record<string, unknown>;
      expect(f.availability).toBe("available");
      expect(f.diskBlocked).toBe(true);
      expect(f.resumeBlocked).toBe(true);
      expect(JSON.stringify(f.blockedReasons)).toContain("torn-tail");
      expect((f.resumable as { items: unknown[] }).items).toHaveLength(0); // 阻断→无重发授权
    } finally {
      c.dispose();
      await rigDispose(r);
    }
  });

  it("I5/B12-3⑤ 真实 sessionId 映射实证：sessionFor→真 session 文件计入合计预算（超→oversized；宽→available）", async () => {
    // journal 恰 700B（合法行+填充）+真 session 文件 400B：700+400=1100>1000→oversized（session 真被打开计数）
    const r = await makeRig(1000);
    const c = new WsClient(r.url, "http://localhost:5173");
    try {
      const head = jEn("i-1", "t", 0) + "\n";
      const pad = Buffer.alloc(700 - Buffer.byteLength(head, "utf8")).fill("\n");
      await writeFile(r.jp, Buffer.concat([Buffer.from(head, "utf8"), pad]));
      await writeFile(r.sp, Buffer.alloc(400).fill("s")); // 真 session 面（内容任意，只计字节）
      await c.hello();
      await c.say({ t: "get-recovery", requestId: "i5a", file: "q.jsonl", offset: 0 });
      await until(() => c.recovery().length > 0);
      const f = c.recovery().at(-1) as Record<string, unknown>;
      expect(f).toMatchObject({ availability: "unavailable", reason: "oversized" });
      expect(r.audits.some((l) => l.includes("recovery-oversized") && l.includes("session=400"))).toBe(true);
    } finally {
      c.dispose();
      await rigDispose(r);
    }
    // 宽预算：同盘面 700+400=1100≤2000→available（session 参与但未超）
    const w = await makeRig(2000);
    const c2 = new WsClient(w.url, "http://localhost:5173");
    try {
      const head = jEn("i-1", "t", 0) + "\n";
      const pad = Buffer.alloc(700 - Buffer.byteLength(head, "utf8")).fill("\n");
      await writeFile(w.jp, Buffer.concat([Buffer.from(head, "utf8"), pad]));
      await writeFile(w.sp, Buffer.alloc(400).fill("s"));
      await c2.hello();
      await c2.say({ t: "get-recovery", requestId: "i5b", file: "q.jsonl", offset: 0 });
      await until(() => c2.recovery().length > 0);
      const f = c2.recovery().at(-1) as Record<string, unknown>;
      expect(f).toMatchObject({ availability: "available" });
    } finally {
      c2.dispose();
      await rigDispose(w);
    }
  });
});

