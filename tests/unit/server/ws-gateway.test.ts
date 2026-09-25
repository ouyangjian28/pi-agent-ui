// 切片③ 3a 网关单测（w0 验收 B7-B12 入口/C13-C17 订阅/D18-D23 恢复列表——受控端口面）
// 全部出帧经 ConnectionQueue→FakeConn（业务零直发 socket 由构造面保证）。
// 出队=setImmediate 异步 → 所有 recv 后断言前先 await tick()。
import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WsGateway, type ConnMeta, type GatewayConnHooks, type WsGatewayOpts } from "../../../apps/server/src/ws/ws-gateway.ts";
import { TokenAuthority } from "../../../apps/server/src/ws/token-auth.ts";
import type { RecoveryEvidenceSnapshot } from "../../../apps/server/src/runtime/recover.ts";

const tick = (): Promise<void> => new Promise((res) => setImmediate(() => res()));

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
      onMessage: (cb) => {
        this.msgCb = cb;
      },
      onClose: (cb) => {
        this.closeCb = cb;
      },
    };
  }
  /** 发一帧+等队列排空一轮 */
  async say(obj: unknown): Promise<void> {
    this.msgCb?.(JSON.stringify(obj), false);
    await tick();
  }
  async sayRaw(text: string): Promise<void> {
    this.msgCb?.(text, false);
    await tick();
  }
  async sayBinary(): Promise<void> {
    this.msgCb?.("{}", true);
    await tick();
  }
  closedByTransport(code = 1006): void {
    this.closeCb?.(code);
  }
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

interface Rig {
  gw: WsGateway;
  conn(): { c: FakeConn; handle: { id: string } };
  roots: string;
  scanDir: string;
  evidence: Map<string, RecoveryEvidenceSnapshot | null>;
  recoveryProvider: (file: string) => RecoveryEvidenceSnapshot | null | Promise<RecoveryEvidenceSnapshot | null>;
  dispose(): Promise<void>;
}

async function makeRig(over: Partial<WsGatewayOpts> = {}): Promise<Rig> {
  const d = await mkdtemp(join(tmpdir(), "ws-gw-"));
  const evidence = new Map<string, RecoveryEvidenceSnapshot | null>();
  const recoveryProvider: Rig["recoveryProvider"] = (file) => {
    const holder = evidence.get(file);
    if (holder !== undefined) return holder;
    return null;
  };
  const gw = new WsGateway({
    tokens: TokenAuthority.fromTokens(["tok-ok"]),
    roots: [d],
    scanDir: d,
    allowedOrigins: ["http://localhost:5173"],
    recoveryEvidence: recoveryProvider,
    heartbeat: { pingMs: 0, idleMs: 0 }, // 默认禁用（个别例覆盖）
    audit: () => {},
    ...over,
  });
  const conn = () => {
    const c = new FakeConn();
    const handle = gw.attach(c, c.hooks(), { origin: "http://localhost:5173", loopback: true, tls: false } satisfies ConnMeta);
    return { c, handle };
  };
  return { gw, conn, roots: d, scanDir: d, evidence, recoveryProvider, dispose: async () => { gw.dispose(); await rm(d, { recursive: true, force: true }); } };
}

async function authed(r: Rig): Promise<FakeConn> {
  const { c } = r.conn();
  await c.say({ t: "hello", protocolVersion: 1, token: "tok-ok" });
  return c;
}

describe("ws-gateway 3a（hello/入站管线）", () => {
  it("hello 成功→welcome；坏 token→4401+close", async () => {
    const r = await makeRig();
    try {
      const c = await authed(r);
      expect(c.frames().some((f) => f.t === "welcome")).toBe(true);
      const { c: c2 } = r.conn();
      await c2.say({ t: "hello", protocolVersion: 1, token: "bad" });
      expect(c2.frames().some((f) => f.code === 4401)).toBe(true);
      expect(c2.closes.length).toBeGreaterThan(0);
    } finally {
      await r.dispose();
    }
  });

  it("Origin 缺失/不在白名单→4401；非 loopback 无 TLS→4401", async () => {
    const r = await makeRig();
    try {
      const c1 = new FakeConn();
      r.gw.attach(c1, c1.hooks(), { loopback: true, tls: false });
      await c1.say({ t: "hello", protocolVersion: 1, token: "tok-ok" });
      expect(c1.frames().some((f) => f.code === 4401)).toBe(true);
      const c3 = new FakeConn();
      r.gw.attach(c3, c3.hooks(), { origin: "http://localhost:5173", loopback: false, tls: false });
      await c3.say({ t: "hello", protocolVersion: 1, token: "tok-ok" });
      expect(c3.frames().some((f) => f.code === 4401)).toBe(true);
    } finally {
      await r.dispose();
    }
  });

  it("protocolVersion=2→4403；hello 字段非法→4404", async () => {
    const r = await makeRig();
    try {
      const { c } = r.conn();
      await c.say({ t: "hello", protocolVersion: 2, token: "tok-ok" });
      expect(c.frames().some((f) => f.code === 4403)).toBe(true);
      const { c: c2 } = r.conn();
      await c2.say({ t: "hello", token: "tok-ok" }); // 缺 protocolVersion
      expect(c2.frames().some((f) => f.code === 4404)).toBe(true);
    } finally {
      await r.dispose();
    }
  });

  it("未认证非 hello→4401；hello 前窗口 3 帧超限→4401", async () => {
    const r = await makeRig();
    try {
      const { c } = r.conn();
      await c.say({ t: "ping", nonce: "x", requestId: "r1" });
      expect(c.frames().some((f) => f.code === 4401)).toBe(true);
      const { c: c2 } = r.conn();
      for (let i = 0; i < 4; i++) await c2.say({ t: "hello", protocolVersion: 1, token: "nope" });
      expect(c2.frames().filter((f) => f.code === 4401).length).toBeGreaterThan(0);
      expect(c2.closes.length).toBeGreaterThan(0);
    } finally {
      await r.dispose();
    }
  });

  it("hello 前窗口可配置：helloMaxFrames=1 时第 2 帧 hello（字段非法不关连接）→4401 关闭", async () => {
    // 不非法字段 hello 不关连接（4404 计数未到 3）；窗口检查先于字段验证——两者分立可观察
    const r = await makeRig({ helloMaxFrames: 1 });
    try {
      const { c } = r.conn();
      await c.say({ t: "hello", token: "tok-ok" }); // 缺 protocolVersion→4404 不关
      expect(c.frames().filter((f) => f.code === 4404).length).toBe(1);
      await c.say({ t: "hello", token: "tok-ok" }); // 窗口=1→第 2 帧→4401+关
      expect(c.frames().some((f) => f.code === 4401)).toBe(true);
      expect(c.closes.length).toBeGreaterThan(0);
    } finally {
      await r.dispose();
    }
  });

  it("入站管线：二进制/非 JSON/未知 t→4404；写类 t→4405；累计 3 次 4404→close 1002", async () => {
    const r = await makeRig();
    try {
      const { c } = r.conn();
      await c.say({ t: "hello", protocolVersion: 1, token: "tok-ok" });
      await c.sayBinary();
      await c.sayRaw("not-json");
      await c.say({ t: "wat", requestId: "r1" });
      expect(c.frames().filter((f) => f.code === 4404).length).toBe(3);
      expect(c.closes.some(([code]) => code === 1002)).toBe(true);
      const { c: c2 } = r.conn();
      await c2.say({ t: "hello", protocolVersion: 1, token: "tok-ok" });
      await c2.say({ t: "prompt", text: "hi", requestId: "r1" });
      expect(c2.frames().some((f) => f.code === 4405)).toBe(true);
    } finally {
      await r.dispose();
    }
  });

  it("requestId：缺失→4404；在途重复→4404；第 5 个并发→4429", async () => {
    const r = await makeRig();
    try {
      const c = await authed(r);
      await c.say({ t: "list-sessions" }); // 缺 requestId
      expect(c.frames().some((f) => f.code === 4404)).toBe(true);
      // provider 永挂（evidence Map 存 pending Promise）：4 个在途 + 在途重复 + 第 5 个并发
      const pending = new Promise<RecoveryEvidenceSnapshot | null>(() => {});
      r.evidence.set("hold.jsonl", pending as unknown as RecoveryEvidenceSnapshot);
      for (let i = 0; i < 4; i++) await c.say({ t: "get-recovery", requestId: `g${i}`, file: "hold.jsonl" });
      expect(c.frames().some((f) => f.code === 4429)).toBe(false); // 恰 4 个在途都受理
      await c.say({ t: "get-recovery", requestId: "g0", file: "hold.jsonl" }); // 在途重复→4404
      expect(c.frames().filter((f) => f.code === 4404).length).toBe(2);
      await c.say({ t: "get-recovery", requestId: "g4", file: "hold.jsonl" }); // 第 5 个并发→4429
      expect(c.frames().some((f) => f.code === 4429)).toBe(true);
    } finally {
      await r.dispose();
    }
  });
});

describe("ws-gateway 3a（订阅/列表/恢复/心跳）", () => {
  it("subscribe init：file 非法/越界→4404；空会话→snapshot 首页帧", async () => {
    const r = await makeRig();
    try {
      const c = await authed(r);
      await c.say({ t: "subscribe", requestId: "s1", file: "../evil.jsonl" });
      expect(c.frames().some((f) => f.code === 4404)).toBe(true);
      await c.say({ t: "subscribe", requestId: "s1b", file: "abc" }); // 非法名（无 .jsonl/非法字符）→4404
      expect(c.frames().filter((f) => f.code === 4404).length).toBe(2);
      await writeFile(join(r.roots, "empty.jsonl"), "");
      await c.say({ t: "subscribe", requestId: "s2", file: "empty.jsonl" });
      const f = c.frames().find((x) => x.t === "snapshot");
      expect(f).toBeDefined();
      expect(typeof (f as { snapshotId?: string }).snapshotId).toBe("string");
    } finally {
      await r.dispose();
    }
  });

  it("同 file 重订阅→4409 stream-replaced；第 9 个 file→4429", async () => {
    const r = await makeRig();
    try {
      const c = await authed(r);
      for (let i = 1; i <= 8; i++) {
        await writeFile(join(r.roots, `f${i}.jsonl`), "");
        await c.say({ t: "subscribe", requestId: `s${i}`, file: `f${i}.jsonl` });
      }
      expect(c.frames().some((f) => f.code === 4429)).toBe(false); // 8 个不同 file 合法
      await c.say({ t: "subscribe", requestId: "s10", file: "f1.jsonl" }); // 重订阅=先退旧→仍 8
      expect(c.frames().some((f) => f.code === 4409 && f.message === "stream-replaced（同文件新订阅）")).toBe(true);
      await writeFile(join(r.roots, "f10.jsonl"), "");
      await c.say({ t: "subscribe", requestId: "s11", file: "f10.jsonl" }); // 第 9 个 file→4429
      expect(c.frames().some((f) => f.code === 4429)).toBe(true);
    } finally {
      await r.dispose();
    }
  });

  it("page 分支无活动引擎→4404", async () => {
    const r = await makeRig();
    try {
      const c = await authed(r);
      await c.say({ t: "subscribe", requestId: "p1", file: "none.jsonl", snapshotId: "snap-1", historyNext: { streamId: "s-1", seq: 1 } });
      expect(c.frames().some((f) => f.code === 4404)).toBe(true);
    } finally {
      await r.dispose();
    }
  });

  it("list-sessions：帧含列表；limit 非法→4404", async () => {
    const r = await makeRig();
    try {
      const c = await authed(r);
      await writeFile(join(r.scanDir, "a.jsonl"), JSON.stringify({ type: "session", id: "s-a", timestamp: 1 }) + "\n");
      await c.say({ t: "list-sessions", requestId: "l1" });
      await new Promise((res) => setTimeout(res, 30));
      const f = c.frames().find((x) => x.t === "sessions");
      expect(f).toBeDefined();
      expect((f as unknown as { sessions: unknown[] }).sessions.length).toBe(1);
      await c.say({ t: "list-sessions", requestId: "l2", limit: 999 });
      expect(c.frames().some((x) => x.code === 4404)).toBe(true);
    } finally {
      await r.dispose();
    }
  });

  it("get-recovery：无快照→unavailable(no-evidence-snapshot)；有快照→available 帧", async () => {
    const r = await makeRig();
    try {
      const c = await authed(r);
      await writeFile(join(r.roots, "rec.jsonl"), "");
      await c.say({ t: "get-recovery", requestId: "g1", file: "rec.jsonl" });
      await new Promise((res) => setTimeout(res, 30));
      const u = c.frames().find((x) => x.t === "recovery") as unknown as { availability: string; reason: string };
      expect(u?.availability).toBe("unavailable");
      expect(u?.reason).toBe("no-evidence-snapshot");
      const snap: RecoveryEvidenceSnapshot = {
        version: 1, file: "rec.jsonl", sessionId: "sess-1", lines: [], bad: [],
        attributedFragments: [], repaired: false, createdAt: 1,
      };
      r.evidence.set("rec.jsonl", snap);
      await c.say({ t: "get-recovery", requestId: "g2", file: "rec.jsonl" });
      await new Promise((res) => setTimeout(res, 30));
      const a = c.frames().filter((x) => x.t === "recovery").pop() as unknown as { availability: string };
      expect(a?.availability).toBe("available");
    } finally {
      await r.dispose();
    }
  });

  it("ping→pong（经队列）", async () => {
    const r = await makeRig();
    try {
      const c = await authed(r);
      await c.say({ t: "ping", nonce: "n1", requestId: "r1" });
      const f = c.frames().find((x) => x.t === "pong") as unknown as { nonce: string };
      expect(f?.nonce).toBe("n1");
    } finally {
      await r.dispose();
    }
  });

  it("心跳空闲超时→4432+close 1000", async () => {
    const r = await makeRig({ heartbeat: { pingMs: 0, idleMs: 40 } });
    try {
      await authed(r);
      const { c } = r.conn();
      await c.say({ t: "hello", protocolVersion: 1, token: "tok-ok" });
      await new Promise((res) => setTimeout(res, 120));
      expect(c.frames().some((f) => f.code === 4432)).toBe(true);
      expect(c.closes.some(([code]) => code === 1000)).toBe(true);
    } finally {
      await r.dispose();
    }
  });

  it("令牌撤销：reload revoked 摘要→既有连接 4401 关闭", async () => {
    const d = await mkdtemp(join(tmpdir(), "tok-rev-"));
    try {
      const tf = join(d, "tokens.json");
      await writeFile(tf, JSON.stringify({ version: 1, tokens: ["tok-ok"] }));
      const auth = await TokenAuthority.fromFile(tf);
      const r = await makeRig({ tokens: auth });
      const { c } = r.conn();
      await c.say({ t: "hello", protocolVersion: 1, token: "tok-ok" });
      expect(c.frames().some((f) => f.t === "welcome")).toBe(true);
      await writeFile(tf, JSON.stringify({ version: 1, tokens: ["tok-new"] }));
      await r.gw.applyTokenReload();
      await tick();
      expect(c.frames().some((f) => f.code === 4401)).toBe(true);
      expect(c.closes.length).toBeGreaterThan(0);
      await r.dispose();
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  it("连接寿命上限→close 1000", async () => {
    // pingMs>0 才有心跳定时器循环（lifetime 检查挂同一 tick）；idleMs 放大不干扰
    const r = await makeRig({ maxLifetimeMs: 60, heartbeat: { pingMs: 20, idleMs: 90_000 } });
    try {
      const c = await authed(r);
      await new Promise((res) => setTimeout(res, 200));
      expect(c.closes.some(([code, reason]) => code === 1000 && reason === "lifetime-cap")).toBe(true);
    } finally {
      await r.dispose();
    }
  });

  it("传输关闭→清理（connectionCount 归零；重复关闭幂等）", async () => {
    const r = await makeRig();
    try {
      const { c } = r.conn();
      expect(r.gw.connectionCount).toBe(1);
      c.closedByTransport();
      expect(r.gw.connectionCount).toBe(0);
      c.closedByTransport();
      expect(r.gw.connectionCount).toBe(0);
    } finally {
      await r.dispose();
    }
  });
});
