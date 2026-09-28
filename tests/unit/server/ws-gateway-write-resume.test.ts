// P0-2 r3a 帧身份门——resume 帧+prompt.generation 校验（写宿主面身份门）。
// 覆盖矩阵（身份门序：恢复数据在场→未阻断→授权→代次；任何拒绝=零副作用不触 sessionFor）：
//  W-res-1  形校验：缺 intentId/generation→4404；generation 负数/非整数→4404；多余字段→4404
//  W-res-2  只读网关（未接写宿主）→resume 4405+close 1008（v1 冻结面不变）
//  W-res-3  无权威源（resumeAuthority 缺省）→identity-rejected{no-recovery-data}（fail-closed）
//  W-res-4  无恢复数据（reportFor→null）→no-recovery-data
//  W-res-5  resumeBlocked 优先于授权判定→resume-blocked
//  W-res-6  intentId ∉ resendAuthorized→resume-not-authorized
//  W-res-7  generation 不匹配→generation-mismatch
//  W-res-8  全过→执行面：launched+payload 透传 send+审计 newIntentId+槽归还（r3b）
//  W-res-9  无活进程→放行至执行；代次匹配→放行执行
//  W-res-9  无活进程（generationFor→null）→放行（无冒充对象）
//  W-res-10 prompt.generation：旧代→identity-rejected（write-ack 面）+零副作用；缺省→放行（v1 兼容）；无活进程→放行
//  W-res-11 authority.reportFor 抛错→stripped（write-host-internal: resume）→网关 4402
//  W-res-12 prompt.generation+无权威源→no-recovery-data（K3 审 P2-1 fail-closed；零副作用）
import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WsGateway, type ConnMeta, type GatewayConnHooks, type WsGatewayOpts } from "../../../apps/server/src/ws/ws-gateway.ts";
import { createRpcWriteHost, type ResumeAuthority } from "../../../apps/server/src/ws/rpc-write-host.ts";
import { ComputeGateQueueTimeout } from "../../../apps/server/src/ws/compute-semaphore.ts";
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
  async send(message: string): Promise<SessionSendResult> { this.sends.push(message); return { kind: "launched", key: { intentId: "i-x", commandId: 1, generation: 1 } }; }
  async stop(): Promise<{ kind: "confirmed"; exit: { code: number | null; signal: string | null } }> { return { kind: "confirmed", exit: { code: 0, signal: null } }; }
}

interface Rig {
  gw: WsGateway;
  conn: () => FakeConn;
  session: RecordingSession;
  audits: string[];
  dir: string;
  inFile: string;
  created: { n: number }; // sessionFor 调用计数（零副作用杀点：身份拒必须不触会话创建）
  authority: {
    report: { resendAuthorized: readonly string[]; resumeBlocked: boolean } | null;
    liveGen: number | null;
    throwReport: boolean;
    throwExec: boolean;
    throwGateTimeout: boolean; // W-res-18：闸排队超时（ComputeGateQueueTimeout）
    execNull: boolean; // executeFor→null（执行点无数据面）
    execReport: { resendAuthorized: readonly string[]; resumeBlocked: boolean } | null; // 执行点复核报告（缺省复用门序报告）
    payload: { rawText: string } | null; // 执行点载荷（null=payload-unavailable）
  };
  dispose(): Promise<void>;
}

async function makeRig(): Promise<Rig> {
  const d = await mkdtemp(join(tmpdir(), "ws-resume-"));
  const audits: string[] = [];
  const session = new RecordingSession();
  const authority = {
    report: { resendAuthorized: ["i-auth"], resumeBlocked: false } as { resendAuthorized: readonly string[]; resumeBlocked: boolean } | null,
    liveGen: 3 as number | null,
    throwReport: false,
    throwExec: false,
    throwGateTimeout: false, // W-res-18：闸排队超时（ComputeGateQueueTimeout）
    execNull: false,
    execReport: null as { resendAuthorized: readonly string[]; resumeBlocked: boolean } | null,
    payload: { rawText: "re-hi" } as { rawText: string } | null,
  };
  const created = { n: 0 };
  const resumeAuthority: ResumeAuthority = {
    reportFor: async () => {
      if (authority.throwGateTimeout) throw new ComputeGateQueueTimeout();
      if (authority.throwReport) throw new Error("boom-report");
      return authority.report;
    },
    generationFor: () => authority.liveGen,
    executeFor: async () => {
      if (authority.throwExec) throw new Error("boom-exec");
      if (authority.execNull) return null;
      return { report: authority.execReport ?? authority.report ?? { resendAuthorized: [], resumeBlocked: false }, payload: authority.payload };
    },
  };
  const writeHost = createRpcWriteHost({
    sessionFor: () => { created.n++; return session; },
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
  return { gw, conn, session, audits, dir: d, inFile: "s1.jsonl", created, authority, dispose: async () => { gw.dispose(); await rm(d, { recursive: true, force: true }); } };
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
      const c3 = await authed(r);
      await c3.say({ t: "resume", requestId: "r6", file: r.inFile, intentId: "i-x\noutcome=execution-pending", generation: 3 }); // K3 审 P2-2：审计注入形（换行）
      await c3.say({ t: "resume", requestId: "r7", file: r.inFile, intentId: "", generation: 3 }); // 空串
      expect(errs(c3).filter((f) => f.code === 4404).length).toBe(2);
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
      expect(r.created.n).toBe(0);
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
      expect(r.created.n).toBe(0);
    } finally { await r.dispose(); }
  });

  it("W-res-6 未授权 intentId→resume-not-authorized", async () => {
    const r = await makeRig();
    try {
      const c = await authed(r);
      await c.say({ t: "resume", requestId: "r1", file: r.inFile, intentId: "i-other", generation: 3 });
      expect(resumeAck(c)?.["outcome"]).toEqual({ kind: "identity-rejected", cause: "resume-not-authorized" });
      expect(r.session.sends.length).toBe(0);
      expect(r.created.n).toBe(0);
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
      expect(r.created.n).toBe(0);
      expect(r.audits.some((l) => l.includes("frame=2") && l.includes("live=3"))).toBe(true);
    } finally { await r.dispose(); }
  });

  it("W-res-8 全过→执行面：launched+payload 透传 send+审计 newIntentId+槽归还", async () => {
    const r = await makeRig();
    try {
      const c = await authed(r);
      await c.say({ t: "resume", requestId: "r1", file: r.inFile, intentId: "i-auth", generation: 3 });
      const ack = resumeAck(c);
      expect(ack).toMatchObject({ t: "write-resume-ack", requestId: "r1", file: r.inFile, outcome: { kind: "launched", intentId: "i-x", commandId: 1 } });
      expect(r.session.sends).toEqual(["re-hi"]); // 执行点载荷透传 send
      expect(r.created.n).toBe(1); // 执行面触会话创建
      // 槽归还：同 requestId 可复用
      await c.say({ t: "resume", requestId: "r1", file: r.inFile, intentId: "i-auth", generation: 3 });
      expect(resumeAck(c)).toBeDefined();
      expect(r.audits.some((l) => l.includes("outcome=launched") && l.includes("newIntentId=i-x"))).toBe(true); // 原意图→新意图关联在审计行
    } finally { await r.dispose(); }
  });

  it("W-res-9 无活进程（generationFor→null）→放行至执行（无冒充对象）；代次匹配→放行执行", async () => {
    const r = await makeRig();
    try {
      r.authority.liveGen = null;
      const c = await authed(r);
      await c.say({ t: "resume", requestId: "r1", file: r.inFile, intentId: "i-auth", generation: 99 }); // 任意代次
      expect(resumeAck(c)?.["outcome"]).toMatchObject({ kind: "launched" });
      expect(r.session.sends).toEqual(["re-hi"]);
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
      expect(r.created.n).toBe(0);
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

  it("W-res-12 prompt.generation+无权威源→no-recovery-data（fail-closed；零副作用）", async () => {
    const d = await mkdtemp(join(tmpdir(), "ws-resume-pna-"));
    const audits: string[] = [];
    const session = new RecordingSession();
    let created = 0;
    const writeHost = createRpcWriteHost({ sessionFor: () => { created += 1; return session; }, audit: (l) => { audits.push(l); } }); // 无 resumeAuthority
    const gw = new WsGateway({
      tokens: TokenAuthority.fromTokens(["tok-ok"]), roots: [d], scanDir: d,
      allowedOrigins: ["http://localhost:5173"], heartbeat: { pingMs: 0, idleMs: 0 },
      audit: (l) => { audits.push(l); }, writeHost,
    });
    try {
      const c = new FakeConn();
      gw.attach(c, c.hooks(), { origin: "http://localhost:5173", loopback: true, tls: false } satisfies ConnMeta);
      await c.say({ t: "hello", protocolVersion: 1, token: "tok-ok" });
      await c.say({ t: "prompt", requestId: "r1", file: "s1.jsonl", text: "hi", generation: 2 });
      const ack = c.sent.map((s) => JSON.parse(s) as Record<string, unknown>).find((f) => f["t"] === "write-ack");
      expect(ack?.["outcome"]).toEqual({ kind: "identity-rejected", cause: "no-recovery-data" });
      expect(session.sends.length).toBe(0);
      expect(created).toBe(0); // 零副作用：fail-closed 拒在 sessionFor 之前
      expect(audits.some((l) => l.includes("op=prompt") && l.includes("cause=no-recovery-data") && l.includes("source=absent"))).toBe(true);
      // v1 兼容面不受影响：缺省 generation 照常放行（无权威源≠写面关闭）
      await c.say({ t: "prompt", requestId: "r2", file: "s1.jsonl", text: "hi2" });
      const ack2 = c.sent.map((s) => JSON.parse(s) as Record<string, unknown>).filter((f) => f["t"] === "write-ack").pop();
      expect(ack2?.["outcome"]).not.toEqual({ kind: "identity-rejected", cause: "no-recovery-data" });
      expect(session.sends.length).toBe(1);
    } finally { gw.dispose(); await rm(d, { recursive: true, force: true }); }
  });
});

describe("P0-2 r3b 执行面：执行点读+复核+send 接线", () => {
  it("W-res-13 执行点复核：门序后新阻断/授权撤销→identity-rejected（零副作用；审计 source=execute-recheck）", async () => {
    const r = await makeRig();
    try {
      // 门序通过但执行点快照变：新阻断到达
      r.authority.execReport = { resendAuthorized: ["i-auth"], resumeBlocked: true };
      let c = await authed(r);
      await c.say({ t: "resume", requestId: "r1", file: r.inFile, intentId: "i-auth", generation: 3 });
      expect(resumeAck(c)?.["outcome"]).toEqual({ kind: "identity-rejected", cause: "resume-blocked" });
      expect(r.session.sends.length).toBe(0);
      expect(r.created.n).toBe(0); // 复核拒也在 sessionFor 之前
      expect(r.audits.some((l) => l.includes("cause=resume-blocked") && l.includes("source=execute-recheck"))).toBe(true);
      // 授权撤销（新裁决 abandon 到达）
      r.authority.execReport = { resendAuthorized: [], resumeBlocked: false };
      c = await authed(r);
      await c.say({ t: "resume", requestId: "r2", file: r.inFile, intentId: "i-auth", generation: 3 });
      expect(resumeAck(c)?.["outcome"]).toEqual({ kind: "identity-rejected", cause: "resume-not-authorized" });
      expect(r.audits.some((l) => l.includes("cause=resume-not-authorized") && l.includes("source=execute-recheck"))).toBe(true);
      expect(r.created.n).toBe(0);
    } finally { await r.dispose(); }
  });

  it("W-res-14 授权在但载荷读不回→execution-failed{payload-unavailable}（零副作用）", async () => {
    const r = await makeRig();
    try {
      r.authority.payload = null;
      const c = await authed(r);
      await c.say({ t: "resume", requestId: "r1", file: r.inFile, intentId: "i-auth", generation: 3 });
      expect(resumeAck(c)?.["outcome"]).toEqual({ kind: "execution-failed", cause: "payload-unavailable" });
      expect(r.session.sends.length).toBe(0);
      expect(r.created.n).toBe(0);
      expect(r.audits.some((l) => l.includes("outcome=execution-failed cause=payload-unavailable"))).toBe(true);
    } finally { await r.dispose(); }
  });

  it("W-res-15 executeFor 抛错→stripped→4402；executeFor→null→no-recovery-data source=execute", async () => {
    const r = await makeRig();
    try {
      r.authority.execNull = true;
      let c = await authed(r);
      await c.say({ t: "resume", requestId: "r1", file: r.inFile, intentId: "i-auth", generation: 3 });
      expect(resumeAck(c)?.["outcome"]).toEqual({ kind: "identity-rejected", cause: "no-recovery-data" });
      expect(r.audits.some((l) => l.includes("source=execute"))).toBe(true);
      expect(r.session.sends.length).toBe(0);
      r.authority.execNull = false;
      r.authority.throwExec = true;
      c = await authed(r);
      await c.say({ t: "resume", requestId: "r2", file: r.inFile, intentId: "i-auth", generation: 3 });
      expect(errs(c).some((f) => f.code === 4402)).toBe(true);
      expect(r.audits.some((l) => l.includes("write-host-error op=resume") && l.includes("boom-exec"))).toBe(true);
    } finally { await r.dispose(); }
  });

  it("W-res-16 执行点代次复核：门序后换代→generation-mismatch source=execute-recheck（send 不触）", async () => {
    // 单元面直测（同一 host 逻辑；网关帧面已由 W-res-8 锁）：门序首查=3、执行点重查=4（进程重启换代）
    const host = createRpcWriteHost({
      sessionFor: () => { throw new Error("must-not-create"); },
      audit: () => {},
      resumeAuthority: {
        reportFor: async () => ({ resendAuthorized: ["i-auth"], resumeBlocked: false }),
        generationFor: (() => { let n = 0; return () => { n++; return n === 1 ? 3 : 4; }; })(),
        executeFor: async () => ({ report: { resendAuthorized: ["i-auth"], resumeBlocked: false }, payload: { rawText: "x" } }),
      },
    });
    const out = await host.resume("f.jsonl", "i-auth", 3);
    expect(out).toEqual({ kind: "identity-rejected", cause: "generation-mismatch" });
  });

  it("W-res-17 send 执行结果透传：busy/gate-rejected/not-ready 同形映射", async () => {
    const r = await makeRig();
    try {
      const outcomes: SessionSendResult[] = [
        { kind: "busy" },
        { kind: "gate-rejected", reason: "busy" },
        { kind: "no-process" },
      ];
      let i = 0;
      (r.session as unknown as { send: (m: string) => Promise<SessionSendResult> }).send = async () => {
        const o = outcomes[i]!;
        i++;
        return o;
      };
      for (let k = 0; k < outcomes.length; k++) {
        const c = await authed(r);
        await c.say({ t: "resume", requestId: `r${k}`, file: r.inFile, intentId: "i-auth", generation: 3 });
        expect(resumeAck(c)?.["outcome"]).toEqual(outcomes[k]);
      }
      expect(r.audits.some((l) => l.includes("intentId=i-auth outcome=busy"))).toBe(true);
    } finally { await r.dispose(); }
  });

  it("W-res-18 闸排队超时→4409 retryable（r3b-fix K3 P2-1：忙非宿主错，不 4402）", async () => {
    const r = await makeRig();
    try {
      r.authority.throwGateTimeout = true;
      const c = await authed(r);
      await c.say({ t: "resume", requestId: "rq1", file: r.inFile, intentId: "i-auth", generation: 3 });
      const f = errs(c);
      expect(f.length).toBe(1);
      expect(f[0]!.code).toBe(4409);
      expect(f[0]!.retryable).toBe(true);
      expect(r.created.n).toBe(0); // 零副作用
      expect(r.audits.some((l) => l.includes("outcome=gate-queue-timeout"))).toBe(true);
    } finally { await r.dispose(); }
  });
});
