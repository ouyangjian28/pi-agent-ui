// 3c-1 写侧帧接线——网关派发面（prompt/stop→WriteHostPort→write-ack/write-stop-ack）。
// 覆盖矩阵：
//  W1 未接线写帧→4405+close 1008（v1 冻结行为不变）   W7 未认证写帧→4401（优先级①先于写层）
//  W2 prompt 合法→write-ack+宿主收到 file/text        W8 requestId 在途重复→4404
//  W3 stop 合法→write-stop-ack                        W9 宿主抛错→4402(retryable)+审计
//  W4 file 越界→4404（宿主未被调）                    W10 text 超 64KiB→4404
//  W5 形状违反→4404（前三案独立可观测；空 text 案在本连接 W5 曾被 close 遮蔽，W13 分连接版补齐）
//  W11 槽归还：同 rid 先后可复用（W15/W15b 补失败路径：prompt/stop 4402 后同 rid 复用）
//  W6 未开放写类 t（send/kill）→4405（接线态同样）     W12 接线态读路径回归冒烟（hello→welcome 不变）
import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { WsGateway, type ConnMeta, type GatewayConnHooks, type WsGatewayOpts } from "../../../apps/server/src/ws/ws-gateway.ts";
import type { WriteHostPort } from "../../../apps/server/src/ws/write-host.ts";
import { TokenAuthority } from "../../../apps/server/src/ws/token-auth.ts";
import { WRITE_TEXT_MAX_BYTES, type WriteSendOutcomeDTO, type WriteStopOutcomeDTO } from "@pi-agent-ui/protocol";

const tick = (): Promise<void> => new Promise((res) => setImmediate(() => res()));

class FakeConn {
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  closes: Array<[number | undefined, string | undefined]> = [];
  terminated = 0;
  private msgCb: ((data: string, isBinary: boolean) => void) | null = null;
  private closeCb: ((code: number) => void) | null = null;
  send(data: string): void { this.sent.push(data); }
  close(code?: number, reason?: string): void { this.closes.push([code, reason]); this.readyState = 2; }
  terminate(): void { this.terminated++; this.readyState = 3; }
  hooks(): GatewayConnHooks {
    return { onMessage: (cb) => { this.msgCb = cb; }, onClose: (cb) => { this.closeCb = cb; } };
  }
  async say(obj: unknown): Promise<void> { this.msgCb?.(JSON.stringify(obj), false); await tick(); await tick(); }
  frames(): Array<Record<string, unknown>> { return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>); }
}

/** 写宿主替身：记录调用；可编程 outcome 与抛错。 */
class FakeWriteHost implements WriteHostPort {
  prompts: Array<{ file: string; text: string; generation?: number; model?: string; cwd?: string }> = [];
  stops: string[] = [];
  next: WriteSendOutcomeDTO = { kind: "launched", intentId: "i-1", commandId: 1 };
  nextStop: WriteStopOutcomeDTO = { kind: "confirmed", exit: { code: 0, signal: null } };
  throwPrompt = false;
  /** W15b：stop 抛错开关。 */
  throwStop = false;
  /** W8/W14：挂起门——非空时 sendPrompt 等待该 promise（造在途窗口；用可释放 deferred）。 */
  gatePrompt: Promise<void> | null = null;
  async sendPrompt(file: string, text: string, generation?: number, model?: string, cwd?: string): Promise<WriteSendOutcomeDTO> {
    this.prompts.push({ file, text, generation, model, cwd });
    if (this.gatePrompt !== null) await this.gatePrompt;
    if (this.throwPrompt) throw new Error("boom-prompt");
    return this.next;
  }
  async stop(file: string): Promise<WriteStopOutcomeDTO> {
    this.stops.push(file);
    if (this.throwStop) throw new Error("boom-stop");
    return this.nextStop;
  }
}

interface Rig {
  gw: WsGateway;
  conn: (meta?: Partial<ConnMeta>) => { c: FakeConn };
  host: FakeWriteHost;
  audits: string[];
  /** 授权根目录（临时）。 */
  dir: string;
  /** 契约 file=裸文件名；inAbs=网关解析后宿主应收到的绝对路径。 */
  inFile: string;
  inAbs: string;
  dispose(): Promise<void>;
}

async function makeRig(over: Partial<WsGatewayOpts> = {}, withHost = true): Promise<Rig> {
  const d = await mkdtemp(join(tmpdir(), "ws-write-"));
  const audits: string[] = [];
  const host = new FakeWriteHost();
  const gw = new WsGateway({
    tokens: TokenAuthority.fromTokens(["tok-ok"]),
    roots: [d],
    scanDir: d,
    allowedOrigins: ["http://localhost:5173"],
    heartbeat: { pingMs: 0, idleMs: 0 },
    audit: (l) => { audits.push(l); },
    ...(withHost ? { writeHost: host } : {}),
    ...over,
  });
  const conn = (meta?: Partial<ConnMeta>) => {
    const c = new FakeConn();
    gw.attach(c, c.hooks(), { origin: "http://localhost:5173", loopback: true, tls: false, ...meta } satisfies ConnMeta);
    return { c };
  };
  return { gw, conn, host, audits, dir: d, inFile: "s1.jsonl", inAbs: join(d, "s1.jsonl"), dispose: async () => { gw.dispose(); await rm(d, { recursive: true, force: true }); } };
}

async function authed(r: Rig): Promise<FakeConn> {
  const { c } = r.conn();
  await c.say({ t: "hello", protocolVersion: 1, token: "tok-ok" });
  return c;
}

const errs = (c: FakeConn) => c.frames().filter((f) => f.t === "error");

describe("3c-1 写侧帧：网关派发面", () => {
  it("W1 未接线：prompt→4405+close 1008（v1 冻结不变）", async () => {
    const r = await makeRig({}, false);
    try {
      const c = await authed(r);
      await c.say({ t: "prompt", requestId: "r1", file: r.inFile, text: "hi" });
      expect(errs(c).some((f) => f.code === 4405)).toBe(true);
      expect(c.closes.some(([code, reason]) => code === 1008 && reason === "write-frozen")).toBe(true);
      expect(r.host.prompts.length).toBe(0);
    } finally { await r.dispose(); }
  });

  it("W2 prompt 合法→write-ack launched；宿主收到 file/text；审计行", async () => {
    const r = await makeRig();
    try {
      const c = await authed(r);
      await c.say({ t: "prompt", requestId: "r2", file: r.inFile, text: "你好 pi" });
      const ack = c.frames().find((f) => f.t === "write-ack");
      expect(ack).toBeDefined();
      expect(ack?.["requestId"]).toBe("r2");
      const oc = ack?.["outcome"] as Record<string, unknown>;
      expect(oc["kind"]).toBe("launched");
      expect(oc["intentId"]).toBe("i-1");
      expect(r.host.prompts).toEqual([{ file: r.inAbs, text: "你好 pi" }]);
      expect(r.audits.some((l) => l.includes("write-frame") && l.includes("t=prompt") && l.includes("outcome=launched"))).toBe(true);
    } finally { await r.dispose(); }
  });

  it("W3 stop 合法→write-stop-ack confirmed", async () => {
    const r = await makeRig();
    try {
      const c = await authed(r);
      await c.say({ t: "stop", requestId: "r3", file: r.inFile });
      const ack = c.frames().find((f) => f.t === "write-stop-ack");
      expect(ack).toBeDefined();
      expect((ack?.["outcome"] as Record<string, unknown>)["kind"]).toBe("confirmed");
      expect(r.host.stops).toEqual([r.inAbs]);
    } finally { await r.dispose(); }
  });

  it("W4 file 越界→4404 且宿主未被调", async () => {
    const r = await makeRig();
    try {
      const c = await authed(r);
      await c.say({ t: "prompt", requestId: "r4", file: "/etc/passwd", text: "x" });
      expect(errs(c).some((f) => f.code === 4404)).toBe(true);
      expect(r.host.prompts.length).toBe(0);
    } finally { await r.dispose(); }
  });

  it("W5 形状违反→4404（缺 text/多余字段/rid 非法/空 text）", async () => {
    const r = await makeRig();
    try {
      const c = await authed(r);
      await c.say({ t: "prompt", requestId: "r5a", file: r.inFile }); // 缺 text
      await c.say({ t: "prompt", requestId: "r5b", file: r.inFile, text: "x", extra: 1 }); // 多余字段
      await c.say({ t: "prompt", requestId: "BAD RID", file: r.inFile, text: "x" }); // rid 非法
      await c.say({ t: "prompt", requestId: "r5d", file: r.inFile, text: "" }); // 空 text
      // 4404 计数≥3→close 1002：本连接只证前三个 4404 触发关限；空 text 案在 W13 分连接单独证（19c 勘正旧注）
      expect(c.closes.some(([code]) => code === 1002)).toBe(true);
    } finally { await r.dispose(); }
  });

  it("W6 未开放写类 t（send/kill）→4405（接线态同样）", async () => {
    const r = await makeRig();
    try {
      const c = await authed(r);
      await c.say({ t: "send", requestId: "r6a", file: r.inFile, text: "x" });
      expect(errs(c).some((f) => f.code === 4405)).toBe(true);
      expect(c.closes.some(([code]) => code === 1008)).toBe(true);
    } finally { await r.dispose(); }
  });

  it("W7 未认证写帧→4401（优先级①先于写层）", async () => {
    const r = await makeRig();
    try {
      const { c } = r.conn();
      await c.say({ t: "prompt", requestId: "r7", file: r.inFile, text: "hi" });
      expect(errs(c).some((f) => f.code === 4401)).toBe(true);
      expect(c.closes.some(([code]) => code === 1008)).toBe(true);
      expect(r.host.prompts.length).toBe(0);
    } finally { await r.dispose(); }
  });

  it("W8 requestId 在途重复→第二次 4404（宿主只调一次）", async () => {
    const r = await makeRig();
    let release8: (() => void) | undefined; // 19b：声明提级——finally 释放兜底可用
    try {
      const c = await authed(r);
      r.host.gatePrompt = new Promise<void>((res) => { release8 = res; }); // 可释放挂起门（第19轮：清理前收束）
      await c.say({ t: "prompt", requestId: "r8", file: r.inFile, text: "1" });
      await c.say({ t: "prompt", requestId: "r8", file: r.inFile, text: "2" });
      expect(errs(c).some((f) => f.code === 4404 && f.message === "requestId 在途重复")).toBe(true);
      expect(r.host.prompts.length).toBe(1);
      release8!(); // 正常路径放门：write-ack 到达+槽归还（不是死门悬置到 dispose）；构造已赋值（195 行门内同步）
      await tick(); await tick();
      expect(c.frames().filter((f) => f.t === "write-ack").length).toBe(1);
      await c.say({ t: "prompt", requestId: "r8", file: r.inFile, text: "3" }); // rid 复用成功=槽已归还
      expect(c.frames().filter((f) => f.t === "write-ack").length).toBe(2);
      expect(r.host.prompts.length).toBe(2);
    } finally {
      release8?.(); // 幂等兜底（19b）：前置断言失败也不遗留挂起门；Promise 二次 resolve 无害
      await tick(); await tick();
      await r.dispose();
    }
  });

  it("W9 宿主抛错→4402 retryable=true+审计 write-frame-error", async () => {
    const r = await makeRig();
    try {
      const c = await authed(r);
      r.host.throwPrompt = true;
      await c.say({ t: "prompt", requestId: "r9", file: r.inFile, text: "x" });
      const e = errs(c).find((f) => f.code === 4402);
      expect(e).toBeDefined();
      expect(e?.["retryable"]).toBe(true);
      expect(r.audits.some((l) => l.includes("write-frame-error") && l.includes("t=prompt"))).toBe(true);
    } finally { await r.dispose(); }
  });

  it("W10 text 超 WRITE_TEXT_MAX_BYTES→4404", async () => {
    const r = await makeRig();
    try {
      const c = await authed(r);
      const big = "a".repeat(WRITE_TEXT_MAX_BYTES + 1);
      await c.say({ t: "prompt", requestId: "r10", file: r.inFile, text: big });
      expect(errs(c).some((f) => f.code === 4404)).toBe(true);
      expect(r.host.prompts.length).toBe(0);
    } finally { await r.dispose(); }
  });

  it("W11 槽归还：同 rid 先后可复用（第一次 ack 后不再在途）", async () => {
    const r = await makeRig();
    try {
      const c = await authed(r);
      await c.say({ t: "prompt", requestId: "r11", file: r.inFile, text: "1" });
      expect(c.frames().filter((f) => f.t === "write-ack").length).toBe(1);
      await c.say({ t: "stop", requestId: "r11", file: r.inFile }); // 同 rid 复用（不同 t 亦可——槽已归还）
      expect(c.frames().filter((f) => f.t === "write-stop-ack").length).toBe(1);
      expect(errs(c).some((f) => f.code === 4404)).toBe(false);
    } finally { await r.dispose(); }
  });

  // ---- 3c-2 首批加固（第18轮 GPT 对抗推演要求的四案）----
  it("W13 W5 分连接版：每坏帧独立连接→各自 4404（空 text 案现在可观测）", async () => {
    const r = await makeRig();
    try {
      const bads: unknown[] = [
        { t: "prompt", requestId: "b1", file: r.inFile }, // 缺 text
        { t: "prompt", requestId: "b2", file: r.inFile, text: "x", extra: 1 }, // 多余字段
        { t: "prompt", requestId: "BAD RID", file: r.inFile, text: "x" }, // rid 非法
        { t: "prompt", requestId: "b4", file: r.inFile, text: "" }, // 空 text（原 W5 里被 close 遮蔽的第 4 案）
      ];
      for (const bad of bads) {
        const c = await authed(r); // 每案新连接：前一连接的 close 不影响本连接
        await c.say(bad);
        expect(errs(c).some((f) => f.code === 4404)).toBe(true);
      }
      expect(r.host.prompts.length).toBe(0); // 四案全在格式层被拒
    } finally { await r.dispose(); }
  });

  it("W14 容量门独立：4 个不同 rid 在途后第 5 个→4404 在途请求超限（非重复门）", async () => {
    const r = await makeRig();
    let release14: (() => void) | undefined; // 19b：声明提级——finally 释放兜底可用
    try {
      const c = await authed(r);
      r.host.gatePrompt = new Promise<void>((res) => { release14 = res; }); // 可释放挂起门（第19轮：清理前收束）
      for (let i = 1; i <= 4; i += 1) await c.say({ t: "prompt", requestId: `r14-${i}`, file: r.inFile, text: "x" });
      await c.say({ t: "prompt", requestId: "r14-5", file: r.inFile, text: "x" }); // 第 5 个不同 rid
      const e = errs(c).find((f) => f.code === 4404 && f.message === "在途请求超限");
      expect(e).toBeDefined();
      expect(r.host.prompts.length).toBe(4); // 第 5 个未达宿主
      release14!(); // 释放四门：write-ack 全部到达+四槽归还；构造已赋值（273 行门内同步）
      await tick(); await tick();
      expect(c.frames().filter((f) => f.t === "write-ack").length).toBe(4);
      const errsBefore = errs(c).filter((f) => f.code === 4404).length;
      await c.say({ t: "prompt", requestId: "r14-1", file: r.inFile, text: "y" }); // rid 复用=四槽真归还（19b 补）
      await tick();
      expect(errs(c).filter((f) => f.code === 4404).length).toBe(errsBefore); // 无新增 4404（旧 r14-5 超限帧仍在，按计数）
      expect(c.frames().filter((f) => f.t === "write-ack").length).toBe(5);
      expect(r.host.prompts.length).toBe(5);
    } finally {
      release14?.(); // 幂等兜底（19b）：前置断言失败也不遗留挂起门
      await tick(); await tick();
      await r.dispose();
    }
  });

  it("W15 失败路径槽归还：prompt 4402 后同 rid 可复用（stop→ack，再 prompt→ack）", async () => {
    const r = await makeRig();
    try {
      const c = await authed(r);
      r.host.throwPrompt = true;
      await c.say({ t: "prompt", requestId: "r15", file: r.inFile, text: "x" });
      expect(errs(c).some((f) => f.code === 4402)).toBe(true); // 失败路径 finally 已归还？
      r.host.throwPrompt = false;
      await c.say({ t: "stop", requestId: "r15", file: r.inFile }); // 同 rid 复用（若未归还应 4404）
      expect(c.frames().some((f) => f.t === "write-stop-ack")).toBe(true);
      await c.say({ t: "prompt", requestId: "r15", file: r.inFile, text: "y" }); // 再复用
      expect(c.frames().some((f) => f.t === "write-ack")).toBe(true);
      expect(errs(c).some((f) => f.code === 4404)).toBe(false);
    } finally { await r.dispose(); }
  });

  it("W15b stop 失败路径槽归还：4402 后同 rid 可复用（prompt→ack）", async () => {
    const r = await makeRig();
    try {
      const c = await authed(r);
      r.host.throwStop = true;
      await c.say({ t: "stop", requestId: "r15b", file: r.inFile });
      expect(errs(c).some((f) => f.code === 4402)).toBe(true); // stop 失败路径 finally 已归还？
      r.host.throwStop = false;
      await c.say({ t: "prompt", requestId: "r15b", file: r.inFile, text: "y" }); // 同 rid 复用（若未归还应 4404）
      expect(c.frames().some((f) => f.t === "write-ack")).toBe(true);
      expect(errs(c).some((f) => f.code === 4404)).toBe(false);
    } finally { await r.dispose(); }
  });

  it("W16 ack.file 显式回显契约裸名（W2/W3 的补强断言）", async () => {
    const r = await makeRig();
    try {
      const c = await authed(r);
      await c.say({ t: "prompt", requestId: "r16a", file: r.inFile, text: "x" });
      await c.say({ t: "stop", requestId: "r16b", file: r.inFile });
      expect(c.frames().find((f) => f.t === "write-ack")?.["file"]).toBe(r.inFile);
      expect(c.frames().find((f) => f.t === "write-stop-ack")?.["file"]).toBe(r.inFile);
      expect(r.host.prompts[0]?.file).toBe(r.inAbs); // 宿主面=abs（与 ack 回显=裸名成对照）
    } finally { await r.dispose(); }
  });

  it("W17 UTF-8 字节边界：恰 65536B（含多字节）过；65538B（多字节）拒", async () => {
    const r = await makeRig();
    try {
      const c = await authed(r);
      const exact = "你".repeat(21845) + "a"; // 3*21845+1 = 65536 字节
      expect(Buffer.byteLength(exact, "utf8")).toBe(WRITE_TEXT_MAX_BYTES);
      await c.say({ t: "prompt", requestId: "r17a", file: r.inFile, text: exact });
      expect(c.frames().some((f) => f.t === "write-ack")).toBe(true);
      const over = "你".repeat(21846); // 65538 字节
      expect(Buffer.byteLength(over, "utf8")).toBe(WRITE_TEXT_MAX_BYTES + 2);
      await c.say({ t: "prompt", requestId: "r17b", file: r.inFile, text: over });
      expect(errs(c).some((f) => f.code === 4404)).toBe(true);
      expect(r.host.prompts.map((p) => p.text)).toEqual([exact]); // 超限案未达宿主
    } finally { await r.dispose(); }
  });

  it("W12 接线态读路径回归：hello→welcome、ping→pong 不受影响", async () => {
    const r = await makeRig();
    try {
      const c = await authed(r);
      await c.say({ t: "ping", nonce: "n1" });
      expect(c.frames().some((f) => f.t === "welcome")).toBe(true);
      expect(c.frames().some((f) => f.t === "pong")).toBe(true);
    } finally { await r.dispose(); }
  });

  // v1.5（批A）：prompt 帧 cwd 域（项目目录）——网关授权门+透传。
  it("W16 prompt 携 cwd（根内目录）→透传宿主（write-ack launched；cwd 原样）", async () => {
    const r = await makeRig();
    try {
      const c = await authed(r);
      await c.say({ t: "prompt", requestId: "r16", file: r.inFile, text: "hi", cwd: r.dir });
      expect(c.frames().some((f) => f.t === "write-ack" && (f as { outcome?: { kind?: string } }).outcome?.kind === "launched")).toBe(true);
      expect(r.host.prompts).toEqual([{ file: r.inAbs, text: "hi", generation: undefined, model: undefined, cwd: r.dir }]);
    } finally { await r.dispose(); }
  });

  it("W17 prompt 携 cwd 越界（根外绝对路径）→4404 且宿主未被调", async () => {
    const r = await makeRig();
    try {
      const c = await authed(r);
      const outside = await mkdtemp(join(tmpdir(), "outside-"));
      try {
        await c.say({ t: "prompt", requestId: "r17", file: r.inFile, text: "hi", cwd: outside });
        expect(errs(c).some((f) => f.code === 4404)).toBe(true);
        expect(r.host.prompts.length).toBe(0);
      } finally { await rm(outside, { recursive: true, force: true }); }
    } finally { await r.dispose(); }
  });

  it("W18 prompt 携 cwd 非目录（根内文件）→4404；cwd 相对路径→4404（校验器形状层拒）", async () => {
    const r = await makeRig();
    try {
      const c = await authed(r);
      await c.say({ t: "prompt", requestId: "r18a", file: r.inFile, text: "hi", cwd: join(r.dir, "not-dir") }); // 根内但不存在
      expect(errs(c).some((f) => f.code === 4404)).toBe(true);
      await c.say({ t: "prompt", requestId: "r18b", file: r.inFile, text: "hi", cwd: "relative/path" }); // 非绝对→形状层拒
      expect(errs(c).some((f) => f.code === 4404)).toBe(true);
      expect(r.host.prompts.length).toBe(0);
    } finally { await r.dispose(); }
  });

  it("W19 prompt 不携 cwd→宿主收 undefined（缺省=继承服务进程；不新增拒因）", async () => {
    const r = await makeRig();
    try {
      const c = await authed(r);
      await c.say({ t: "prompt", requestId: "r19", file: r.inFile, text: "hi" });
      expect(r.host.prompts).toEqual([{ file: r.inAbs, text: "hi", generation: undefined, model: undefined, cwd: undefined }]);
    } finally { await r.dispose(); }
  });

  // v1.5（批A）：get-roots 帧（目录选择器数据源）。
  it("W20 get-roots→roots-list（授权根原序下发；requestId 回显）", async () => {
    const r = await makeRig();
    try {
      const c = await authed(r);
      await c.say({ t: "get-roots", requestId: "rr1" });
      const f = c.frames().find((fr) => fr.t === "roots-list") as { roots?: string[] } | undefined;
      expect(f).toBeDefined();
      expect(f?.roots).toEqual([r.dir]);
    } finally { await r.dispose(); }
  });

  // v1.6（批A-r2）：writeJournalFor 双树映射+journalRoot 下发+cwd realpath 门。
  it("W21 writeJournalFor 配置→写帧宿主收 journal 键（T 内名→D 同名）；未配=首根旧语义", async () => {
    const d2 = await mkdtemp(join(tmpdir(), "ws-write-jd-"));
    const r = await makeRig({ writeJournalFor: (f) => join(d2, basename(f)) });
    try {
      const c = await authed(r);
      await c.say({ t: "prompt", requestId: "r21", file: r.inFile, text: "hi" });
      expect(c.frames().some((f) => f.t === "write-ack" && (f as { outcome?: { kind?: string } }).outcome?.kind === "launched")).toBe(true);
      expect(r.host.prompts).toEqual([{ file: join(d2, "s1.jsonl"), text: "hi", generation: undefined, model: undefined, cwd: undefined }]); // journal 键=映射后
      expect(c.frames().some((f) => f.t === "error")).toBe(false);
    } finally { await r.dispose(); await rm(d2, { recursive: true, force: true }); }
  });

  it("W22 prompt 携根内 symlink 指根外→4404 拒（realpath 复核；宿主未被调）", async () => {
    const r = await makeRig();
    const outside = await mkdtemp(join(tmpdir(), "outside-"));
    try {
      const { symlink } = await import("node:fs/promises");
      await symlink(outside, join(r.dir, "esc-link"));
      const c = await authed(r);
      await c.say({ t: "prompt", requestId: "r22", file: r.inFile, text: "hi", cwd: join(r.dir, "esc-link") });
      expect(errs(c).some((f) => f.code === 4404)).toBe(true); // 词法根内但真实身份根外
      expect(r.host.prompts.length).toBe(0);
    } finally { await r.dispose(); await rm(outside, { recursive: true, force: true }); }
  });

  it("W23 journalRoot 配置→roots-list 下发 journalRoot 字段；未配→无字段", async () => {
    const d2 = await mkdtemp(join(tmpdir(), "ws-write-jd2-"));
    const r = await makeRig({ journalRoot: d2 });
    try {
      const c = await authed(r);
      await c.say({ t: "get-roots", requestId: "rr23" });
      const f = c.frames().find((fr) => fr.t === "roots-list") as { roots?: string[]; journalRoot?: string } | undefined;
      expect(f?.journalRoot).toBe(d2);
    } finally { await r.dispose(); await rm(d2, { recursive: true, force: true }); }
    const r2 = await makeRig();
    try {
      const c = await authed(r2);
      await c.say({ t: "get-roots", requestId: "rr23b" });
      const f = c.frames().find((fr) => fr.t === "roots-list") as { journalRoot?: string } | undefined;
      expect(f?.journalRoot).toBeUndefined(); // 未配=字段缺席（客户端可选消费）
    } finally { await r2.dispose(); }
  });
});
