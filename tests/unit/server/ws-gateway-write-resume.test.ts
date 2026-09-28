// P0-2 r3a 帧身份门——resume 帧+prompt.generation 校验（写宿主面身份门）。
// 覆盖矩阵（身份门序：恢复数据在场→未阻断→授权→代次；任何拒绝=零副作用不触 sessionFor）：
//  W-res-1  形校验：缺 intentId/generation→4404；generation 负数/非整数→4404；多余字段→4404
//  W-res-2  只读网关（未接写宿主）→resume 4405+close 1008（v1 冻结面不变）
//  W-res-3  无权威源（resumeAuthority 缺省）→identity-rejected{no-recovery-data}（fail-closed）
//  W-res-4  无恢复数据（reportFor→null）→no-recovery-data
//  W-res-5  resumeBlocked 优先于授权判定→resume-blocked
//  W-res-6  intentId ∉ resendAuthorized→resume-not-authorized
//  W-res-7  generation 不匹配→generation-mismatch
//  W-res-8  全过→execution-pending（r3b 执行面占位）+write-resume-ack 帧结构+requestId 槽归还
//  W-res-9  零副作用：全部 identity-rejected 路径 sessionFor 从未被调
//  W-res-10 prompt.generation 旧代→identity-rejected{generation-mismatch}（write-ack 面）；
//           缺省 generation→放行（v1 兼容）；无活进程（generationFor→null）→放行
//  W-res-11 authority.reportFor 抛错→stripped（write-host-internal: resume）→网关 4402
import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WsGateway, type ConnMeta, type GatewayConnHooks, type WsGatewayOpts } from "../../../apps/server/src/ws/ws-gateway.ts";
import { createRpcWriteHost, type ResumeAuthority } from "../../../apps/server/src/ws/rpc-write-host.ts";
import { TokenAuthority } from "../../../apps/server/src/ws/token-auth.ts";
import type { SessionSendResult } from "../../../apps/server/src/runtime/rpc-session.ts";
import type { WriteSendOutcomeDTO } from "@pi-agent-ui/protocol";

const tick = (): Promise<void> => new Promise((res) => setImmediate(() => res()));

class FakeConn {
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  closes: Array<[number | undefined, string | undefined]> = [];
  private msgCb: ((data: string, isBinary: boolean) => void) | null = null;
  hooks(): GatewayConnHooks {
    return { onMessage: (cb) => { this.msgCb = cb; }, onClose: () => {} };
  }
  send(data: string): void { this.sent.push(data); }
  close(code?: number, reason?: string): void { this.closes.push([code, reason]); this.readyState = 2; }
  terminate(): void { this.terminated++; this.readyState = 3; }
  terminated = 0;
  async say(obj: unknown): Promise<void> { this.msgCb?.(JSON.stringify(obj), false); await tick(); await tick(); }
  frames(): Array<Record<string, unknown>> { return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>); }
}

/** 会话替身：记录 send 调用（零副作用断言=从不触发）。 */
class RecordingSession {
  sends: string[] = [];
  async send(message: string): Promise<SessionSendResult> { this.sends.push(message); return { kind: "launched", key: { intentId: "i-x", commandId: 1 } }; }
  async stop(): Promise<{ kind: "confirmed"; exit: { code: number | null; signal: string | null } }> { return { kind: "confirmed", exit: { code: 0, signal: null } }; }
}

interface Rig {
  gw: WsGateway;
  conn: () => FakeConn;
  session: RecordingSession;
  audits: string[];
  dir: string;
  inFile: string;
  authority: { report: { resendAuthorized: readonly string[]; resumeBlocked: boolean } | null; liveGen: number | null; throwReport: boolean };
  dispose(): Promise<void>;
}

async function makeRig(): Promise<Rig> {
  const d = await mkdtemp(join(tmpdir(), "ws-resume-"));
  const audits: string[] = [];
  const session = new RecordingSession();
  const authority = { report: { resendAuthorized: ["i-auth"], resumeBlocked: false } as { resendAuthorized: readonly string[]; resumeBlocked: boolean } | null, liveGen: 3 as number | null, throwReport: false };
  const resumeAuthority: ResumeAuthority = {
    reportFor: async () => {
      if (authority.throwReport) throw new Error("boom-report");
      return authority.report;
    },
    generationFor: () => authority.liveGen,
  };
  const writeHost = createRpcWriteHost({
    sessionFor: () => session,
    audit: (l) => { audits.push(l); },
    resumeAuthority,
  });
  const gw = new WsGateway({
    tokens: TokenAuthority.fromTokens(["tok-ok"]),
    roots: [d],
    scanDir: d,
    allowedOrigins: ["http://localhost:5173"],
    heartbeat: { pingMs: 0, idleMs: 0 },
    audit: (l) => { audits.push(l); },
    writeHost,
  });
  const conn = () => {
    const c = new FakeConn();
    gw.attach(c, c.hooks(), { origin: "http://localhost:5173", loopback: true, tls: false } satisfies ConnMeta);
    return c;
  };
  return { gw, conn, session, audits, dir: d, inFile: "s1.jsonl", authority, dispose: async () => { gw.dispose(); await rm(d, { recursive: true, force: true }); } };
}

async function authed(r: Rig): Promise<FakeConn> {
  const c = r.conn();
  await c.say({ t: "hello", protocolVersion: 1, token: "tok-ok" });
  return c;
}

const errs = (c: FakeConn) => c.frames().filter((f) => f.t === "error");
const resumeAck = (c: FakeConn) => c.frames().find((f) => f.t === "write-resume-ack");

describe("P0-2 r3a 帧身份门：resume/prompt.generation", () => {
  it("W-res-1 形校验：resume 缺/坏字段→4404（不触写宿主；4404 累计 3→close 1002 故拆两连接）", async () => {
    const r = await makeRig();
    try {
      const c1 = await authed(r);
      await c1.say({ t: "resume", requestId: "r1", file: r.inFile, generation: 3 }); // 缺 intentId
      await c1.say({ t: "resume", requestId: "r2", file: r.inFile, intentId: "i-auth" }); // 缺 generation
      await c1.say({ t: "resume", requestId: "r3", file: r.inFile, intentId: "i-auth", generation: -1 }); // 负数
      expect(errs(c1).filter((f) => f.code === 4404).length).toBe(3);
      const c2 = await authed(r);
      await c2.say({ t: "resume", requestId: "r4", file: r.inFile, intentId: "i-auth", generation: 3.5 }); // 非整数
      await c2.say({ t: "resume", requestId: "r5", file: r.inFile, intentId: "i-auth", generation: 3, extra: 1 }); // 多余字段
      expect(errs(c2).filter((f) => f.code === 4404).length).toBe(2);
      expect(r.session.sends.length).toBe(0);
    } finally { await r.dispose(); }
  });

  it("W-res-2 只读网关：resume→4405+close 1008（v1 冻结不变）", async () => {
    const d = await mkdtemp(join(tmpdir(), "ws-resume-ro-"));
    const gw = new WsGateway({
      tokens: TokenAuthority.fromTokens(["tok-ok"]), roots: [d], scanDir: d,
      allowedOrigins: ["http://localhost:5173"], heartbeat: { pingMs: 0, idleMs: 0 }, audit: () => {},
    });
    try {
      const c = new FakeConn();
      gw.attach(c, c.hooks(), { origin: "http://localhost:5173", loopback: true, tls: false } satisfies ConnMeta);
      await c.say({ t: "hello", protocolVersion: 1, token: "tok-ok" });
      await c.say({ t: "resume", requestId: "r1", file: "s1.jsonl", intentId: "i-auth", generation: 3 });
      expect(errs(c).some((f) => f.code === 4405)).toBe(true);
      expect(c.closes.some(([code, reason]) => code === 1008 && reason === "write-frozen")).toBe(true);
    } finally { gw.dispose(); await rm(d, { recursive: true, force: true }); }
  });

  it("W-res-3 无权威源（resumeAuthority 缺省）→no-recovery-data（fail-closed）", async () => {
    const d = await mkdtemp(join(tmpdir(), "ws-resume-na-"));
    const audits: string[] = [];
    const session = new RecordingSession();
    const writeHost = createRpcWriteHost({ sessionFor: () => session, audit: (l) => { audits.push(l); } }); // 无 resumeAuthority
    const gw = new WsGateway({
      tokens: TokenAuthority.fromTokens(["tok-ok"]), roots: [d], scanDir: d,
      allowedOrigins: ["http://localhost:5173"], heartbeat: { pingMs: 0, idleMs: 0 },
      audit: (l) => { audits.push(l); }, writeHost,
    });
    try {
      const c = new FakeConn();
      gw.attach(c, c.hooks(), { origin: "http://localhost:5173", loopback: true, tls: false } satisfies ConnMeta);
      await c.say({ t: "hello", protocolVersion: 1, token: "tok-ok" });
      await c.say({ t: "resume", requestId: "r1", file: "s1.jsonl", intentId: "i-auth", generation: 3 });
      const ack = resumeAck(c);
      expect(ack?.["outcome"]).toEqual({ kind: "identity-rejected", cause: "no-recovery-data" });
      expect(session.sends.length).toBe(0);
      expect(audits.some((l) => l.includes("cause=no-recovery-data") && l.includes("source=absent"))).toBe(true);
    } finally { gw.dispose(); await rm(d, { recursive: true, force: true }); }
  });

  it("W-res-4 无恢复数据（reportFor→null）→no-recovery-data", async () => {
    const r = await makeRig();
    try {
      r.authority.report = null;
      const c = await authed(r);
      await c.say({ t: "resume", requestId: "r1", file: r.inFile, intentId: "i-auth", generation: 3 });
      expect(resumeAck(c)?.["outcome"]).toEqual({ kind: "identity-rejected", cause: "no-recovery-data" });
      expect(r.session.sends.length).toBe(0);
    } finally { await r.dispose(); }
  });

  it("W-res-5 resumeBlocked 优先→resume-blocked（即使 intentId 在授权集内）", async () => {
    const r = await makeRig();
    try {
      r.authority.report = { resendAuthorized: ["i-auth"], resumeBlocked: true };
      const c = await authed(r);
      await c.say({ t: "resume", requestId: "r1", file: r.inFile, intentId: "i-auth", generation: 3 });
      expect(resumeAck(c)?.["outcome"]).toEqual({ kind: "identity-rejected", cause: "resume-blocked" });
      expect(r.session.sends.length).toBe(0);
    } finally { await r.dispose(); }
  });

  it("W-res-6 未授权 intentId→resume-not-authorized", async () => {
    const r = await makeRig();
    try {
      const c = await authed(r);
      await c.say({ t: "resume", requestId: "r1", file: r.inFile, intentId: "i-other", generation: 3 });
      expect(resumeAck(c)?.["outcome"]).toEqual({ kind: "identity-rejected", cause: "resume-not-authorized" });
      expect(r.session.sends.length).toBe(0);
      expect(r.audits.some((l) => l.includes("cause=resume-not-authorized"))).toBe(true);
    } finally { await r.dispose(); }
  });

  it("W-res-7 旧代次→generation-mismatch（授权已过）", async () => {
    const r = await makeRig();
    try {
      const c = await authed(r);
      await c.say({ t: "resume", requestId: "r1", file: r.inFile, intentId: "i-auth", generation: 2 }); // 活代=3
      expect(resumeAck(c)?.["outcome"]).toEqual({ kind: "identity-rejected", cause: "generation-mismatch" });
      expect(r.session.sends.length).toBe(0);
      expect(r.audits.some((l) => l.includes("frame=2") && l.includes("live=3"))).toBe(true);
    } finally { await r.dispose(); }
  });

  it("W-res-8 全过→execution-pending+帧结构+槽归还", async () => {
    const r = await makeRig();
    try {
      const c = await authed(r);
      await c.say({ t: "resume", requestId: "r1", file: r.inFile, intentId: "i-auth", generation: 3 });
      const ack = resumeAck(c);
      expect(ack).toMatchObject({ t: "write-resume-ack", requestId: "r1", file: r.inFile, outcome: { kind: "execution-pending" } });
      // 槽归还：同 requestId 可复用
      await c.say({ t: "resume", requestId: "r1", file: r.inFile, intentId: "i-auth", generation: 3 });
      expect(resumeAck(c)).toBeDefined();
      expect(r.session.sends.length).toBe(0); // 执行面 r3b：身份门通过也不触 send（诚实占位）
      expect(r.audits.some((l) => l.includes("outcome=execution-pending"))).toBe(true);
    } finally { await r.dispose(); }
  });

  it("W-res-9 无活进程（generationFor→null）→放行（无冒充对象）；代次匹配→放行", async () => {
    const r = await makeRig();
    try {
      r.authority.liveGen = null;
      const c = await authed(r);
      await c.say({ t: "resume", requestId: "r1", file: r.inFile, intentId: "i-auth", generation: 99 }); // 任意代次
      expect(resumeAck(c)?.["outcome"]).toEqual({ kind: "execution-pending" });
    } finally { await r.dispose(); }
  });

  it("W-res-10 prompt.generation：旧代→identity-rejected（write-ack 面）+零副作用；缺省→放行；无活进程→放行", async () => {
    const r = await makeRig();
    try {
      const c = await authed(r);
      // 旧代（活=3）
      await c.say({ t: "prompt", requestId: "p1", file: r.inFile, text: "hi", generation: 1 });
      const ack1 = c.frames().find((f) => f.t === "write-ack" && f.requestId === "p1");
      expect(ack1?.["outcome"]).toEqual({ kind: "identity-rejected", cause: "generation-mismatch" });
      expect(r.session.sends.length).toBe(0); // 零副作用：身份拒在 sessionFor 之前
      // 匹配代（3）→放行（触 send）
      await c.say({ t: "prompt", requestId: "p2", file: r.inFile, text: "hi", generation: 3 });
      const ack2 = c.frames().find((f) => f.t === "write-ack" && f.requestId === "p2");
      expect((ack2?.["outcome"] as Record<string, unknown>)?.["kind"]).toBe("launched");
      expect(r.session.sends).toEqual(["hi"]);
      // v1 兼容：缺省 generation→跳过校验
      await c.say({ t: "prompt", requestId: "p3", file: r.inFile, text: "hi2" });
      const ack3 = c.frames().find((f) => f.t === "write-ack" && f.requestId === "p3");
      expect((ack3?.["outcome"] as Record<string, unknown>)?.["kind"]).toBe("launched");
      // 无活进程→放行
      r.authority.liveGen = null;
      await c.say({ t: "prompt", requestId: "p4", file: r.inFile, text: "hi3", generation: 7 });
      const ack4 = c.frames().find((f) => f.t === "write-ack" && f.requestId === "p4");
      expect((ack4?.["outcome"] as Record<string, unknown>)?.["kind"]).toBe("launched");
    } finally { await r.dispose(); }
  });

  it("W-res-11 reportFor 抛错→stripped（write-host-internal: resume）→网关 4402", async () => {
    const r = await makeRig();
    try {
      r.authority.throwReport = true;
      const c = await authed(r);
      await c.say({ t: "resume", requestId: "r1", file: r.inFile, intentId: "i-auth", generation: 3 });
      expect(errs(c).some((f) => f.code === 4402)).toBe(true);
      expect(r.audits.some((l) => l.includes("write-host-error op=resume"))).toBe(true);
      expect(resumeAck(c)).toBeUndefined();
    } finally { await r.dispose(); }
  });
});
