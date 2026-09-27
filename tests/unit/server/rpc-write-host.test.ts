// 3c-2 适配器：encodeSendOutcome/encodeStopOutcome 编码矩阵 + createRpcWriteHost 注册表/异常面。
// E1-E8=纯编码（穷尽分支）；H1-H8=宿主适配（注册表缓存/剥离重抛/审计隔离）。
import { describe, expect, it } from "vitest";
import { encodeSendOutcome, encodeStopOutcome, createRpcWriteHost, type RpcLikeSession } from "../../../apps/server/src/ws/rpc-write-host.ts";
import type { SessionSendResult } from "../../../apps/server/src/runtime/rpc-session.ts";
import type { RetireOutcome } from "@pi-agent-ui/protocol";

const TK = { intentId: "i-7", commandId: 42, generation: 3 };

describe("3c-2 编码器：SessionSendResult→WriteSendOutcomeDTO", () => {
  it("E1 launched：key 扁平化（intentId/commandId 保留，generation 不跨面）", () => {
    expect(encodeSendOutcome({ kind: "launched", key: TK })).toEqual({ kind: "launched", intentId: "i-7", commandId: 42 });
  });
  it("E2 busy/gate-rejected 透传", () => {
    expect(encodeSendOutcome({ kind: "busy" })).toEqual({ kind: "busy" });
    expect(encodeSendOutcome({ kind: "gate-rejected", reason: "closed" })).toEqual({ kind: "gate-rejected", reason: "closed" });
  });
  it("E3 gate-failed：stage 保留、error 截断（unknown 不跨面）", () => {
    expect(encodeSendOutcome({ kind: "gate-failed", stage: "sending", error: new Error("内部细节") })).toEqual({ kind: "gate-failed", stage: "sending" });
  });
  it("E4 invalidated 四 stage 全透传（enqueue/sending/post-send/first-byte）", () => {
    const stages = ["enqueue", "sending", "post-send", "first-byte"] as const;
    for (const stage of stages) expect(encodeSendOutcome({ kind: "invalidated", stage })).toEqual({ kind: "invalidated", stage });
  });
  it("E5 no-process", () => {
    expect(encodeSendOutcome({ kind: "no-process" })).toEqual({ kind: "no-process" });
  });
  it("E6 not-ready：cause 有/无两形（源可选→DTO 可选）", () => {
    expect(encodeSendOutcome({ kind: "not-ready", cause: "spawn-failed" })).toEqual({ kind: "not-ready", cause: "spawn-failed" });
    expect(encodeSendOutcome({ kind: "not-ready" })).toEqual({ kind: "not-ready" });
  });
  it("E7 stop 四分支同构（confirmed 复制 exit，不携引用）", () => {
    const exit = { code: 1, signal: "SIGTERM" };
    const out = encodeStopOutcome({ kind: "confirmed", exit });
    expect(out).toEqual({ kind: "confirmed", exit: { code: 1, signal: "SIGTERM" } });
    expect(out.exit).not.toBe(exit); // 引用独立：复制而非携引用（第19轮补强）
    exit.code = 99; // 改原对象不影响已编码 DTO
    expect(out).toEqual({ kind: "confirmed", exit: { code: 1, signal: "SIGTERM" } });
    expect(encodeStopOutcome({ kind: "deadline-exceeded" })).toEqual({ kind: "deadline-exceeded" });
    expect(encodeStopOutcome({ kind: "no-process" })).toEqual({ kind: "no-process" });
    expect(encodeStopOutcome({ kind: "stopping" })).toEqual({ kind: "stopping" });
  });
  it("E8 kind 集合冒烟（值正确性由 E1/E6 等完整对象断言负责；对值失真盲=E1/H1 才是杀伤面）", () => {
    const samples: SessionSendResult[] = [
      { kind: "launched", key: TK }, { kind: "busy" }, { kind: "gate-rejected", reason: "busy" },
      { kind: "gate-failed", stage: "enqueue", error: null }, { kind: "invalidated", stage: "post-send" },
      { kind: "no-process" }, { kind: "not-ready", cause: "not-running" }, { kind: "not-ready" },
    ];
    const ok = new Set(["launched", "busy", "gate-rejected", "gate-failed", "invalidated", "no-process", "not-ready"]);
    for (const s of samples) expect(ok.has(encodeSendOutcome(s).kind)).toBe(true);
  });
});

interface FakeSession extends RpcLikeSession {
  sent: string[];
  stopped: number;
  next: SessionSendResult;
  nextStop: RetireOutcome;
}

function mkSession(next: SessionSendResult = { kind: "launched", key: TK }, nextStop: RetireOutcome = { kind: "confirmed", exit: { code: 0, signal: null } }): FakeSession {
  return { sent: [], stopped: 0, next, nextStop, async send(m: string) { this.sent.push(m); return this.next; }, async stop() { this.stopped += 1; return this.nextStop; } };
}

describe("3c-2 宿主适配：createRpcWriteHost", () => {
  it("H1 sendPrompt：file 交工厂、text 交会话、DTO 回 launched 扁平形", async () => {
    const s = mkSession();
    const host = createRpcWriteHost({ sessionFor: (f) => { expect(f).toBe("/abs/s.jsonl"); return s; } });
    expect(await host.sendPrompt("/abs/s.jsonl", "你好")).toEqual({ kind: "launched", intentId: "i-7", commandId: 42 });
    expect(s.sent).toEqual(["你好"]);
  });
  it("H2 stop：RetireOutcome 同构回传", async () => {
    const s = mkSession(undefined, { kind: "deadline-exceeded" });
    const host = createRpcWriteHost({ sessionFor: () => s });
    expect(await host.stop("/abs/s.jsonl")).toEqual({ kind: "deadline-exceeded" });
    expect(s.stopped).toBe(1);
  });
  it("H3 注册表缓存：同 file 工厂只调一次（send+stop 共享实例）", async () => {
    let calls = 0;
    const s = mkSession();
    const host = createRpcWriteHost({ sessionFor: () => { calls += 1; return s; } });
    await host.sendPrompt("/abs/s.jsonl", "a");
    await host.stop("/abs/s.jsonl");
    await host.sendPrompt("/abs/s.jsonl", "b");
    expect(calls).toBe(1);
  });
  it("H4 不同 file 不同实例（缓存按 file 分桶）", async () => {
    const made: string[] = [];
    const host = createRpcWriteHost({ sessionFor: (f) => { made.push(f); return mkSession(); } });
    await host.sendPrompt("/abs/a.jsonl", "1");
    await host.sendPrompt("/abs/b.jsonl", "2");
    expect(made).toEqual(["/abs/a.jsonl", "/abs/b.jsonl"]);
  });
  it("H5 工厂抛错→审计留细节+剥离重抛（无内部串外泄）", async () => {
    const audits: string[] = [];
    const host = createRpcWriteHost({ sessionFor: () => { throw new Error("SEKRET /root/path"); }, audit: (l) => audits.push(l) });
    await expect(host.sendPrompt("/abs/s.jsonl", "x")).rejects.toThrow("write-host-internal: prompt");
    await expect(host.stop("/abs/s.jsonl")).rejects.toThrow("write-host-internal: stop");
    expect(audits.some((l) => l.includes("write-host-error") && l.includes("op=prompt") && l.includes("SEKRET"))).toBe(true);
    expect(audits.some((l) => l.includes("write-host-error") && l.includes("op=stop"))).toBe(true);
  });
  it("H6 会话 send 抛错同面：审计+剥离重抛（W9 的 4402 通道来源）", async () => {
    const audits: string[] = [];
    const bad = { ...mkSession(), send: async () => { throw new Error("rpc-boom"); } } as RpcLikeSession;
    const host = createRpcWriteHost({ sessionFor: () => bad, audit: (l) => audits.push(l) });
    await expect(host.sendPrompt("/abs/s.jsonl", "x")).rejects.toThrow("write-host-internal: prompt");
    expect(audits.some((l) => l.includes("rpc-boom"))).toBe(true);
  });
  it("H7 审计回调自身抛错被隔离（不影响重抛语义）", async () => {
    const host = createRpcWriteHost({ sessionFor: () => { throw new Error("x"); }, audit: () => { throw new Error("audit-down"); } });
    await expect(host.sendPrompt("/abs/s.jsonl", "x")).rejects.toThrow("write-host-internal: prompt");
  });
  it("H8 异步工厂（Promise 返回）可用", async () => {
    const host = createRpcWriteHost({ sessionFor: async (_f) => mkSession() });
    expect(await host.stop("/abs/s.jsonl")).toEqual({ kind: "confirmed", exit: { code: 0, signal: null } });
  });

  // ---- 第19轮 GPT F1：注册表首次并发（single-flight）----
  it("H9 同步工厂首次并发 prompt+stop：恰建一次、两操作落同实例、后续仍缓存", async () => {
    let calls = 0;
    let shared: FakeSession | null = null;
    const host = createRpcWriteHost({
      sessionFor: () => { calls += 1; shared = mkSession(); return shared; },
    });
    const p = host.sendPrompt("/abs/s.jsonl", "a"); // 首个调用同步发布 pending（在首个 await 前）
    const q = host.stop("/abs/s.jsonl");            // 重入共享同一创建，不二次建
    await Promise.all([p, q]);
    expect(calls).toBe(1);
    expect(shared).not.toBeNull();
    expect(shared!.sent).toEqual(["a"]); // prompt 落在共享实例
    expect(shared!.stopped).toBe(1);     // stop 也落在同一实例
    await host.sendPrompt("/abs/s.jsonl", "b"); // 后续缓存归属：不再建
    expect(calls).toBe(1);
    expect(shared!.sent).toEqual(["a", "b"]);
  });

  it("H10 可控异步工厂并发 prompt/prompt：deferred 释放后仍恰建一次、两 text 落同实例", async () => {
    let release!: (s: FakeSession) => void;
    let calls = 0;
    const host = createRpcWriteHost({
      sessionFor: () => { calls += 1; return new Promise<FakeSession>((res) => { release = res; }); },
    });
    const p1 = host.sendPrompt("/abs/s.jsonl", "x1");
    const p2 = host.sendPrompt("/abs/s.jsonl", "x2"); // 首建未决期间重入
    await new Promise((res) => setImmediate(res)); // 工厂压微任务后执行（生产件 F1 修复语义），先让工厂进入
    const shared = mkSession();
    release(shared);
    const [a1, a2] = await Promise.all([p1, p2]);
    expect(calls).toBe(1);
    expect(a1).toEqual({ kind: "launched", intentId: "i-7", commandId: 42 });
    expect(a2).toEqual({ kind: "launched", intentId: "i-7", commandId: 42 });
    expect(shared.sent).toEqual(["x1", "x2"]); // 两操作同一实例（无双写者）
  });

  it("H11 工厂失败（并发共享同一失败）后健康重试：占位已清、重试恰再建一次", async () => {
    let calls = 0;
    let fail = true;
    const host = createRpcWriteHost({
      sessionFor: () => { calls += 1; if (fail) throw new Error("factory-down"); return mkSession(); },
    });
    const p1 = host.sendPrompt("/abs/s.jsonl", "a");
    const p2 = host.stop("/abs/s.jsonl"); // 共享同一失败（不得各自再建）
    await expect(p1).rejects.toThrow("write-host-internal: prompt");
    await expect(p2).rejects.toThrow("write-host-internal: stop");
    expect(calls).toBe(1); // 失败也只建一次
    fail = false; // 健康重试：占位已按身份删除
    expect(await host.sendPrompt("/abs/s.jsonl", "b")).toEqual({ kind: "launched", intentId: "i-7", commandId: 42 });
    expect(calls).toBe(2); // 重试恰再建一次
    await host.stop("/abs/s.jsonl"); // 成功后缓存
    expect(calls).toBe(2);
  });

  // ---- 第19轮异常边界补强：格式化隔离+固定剥离 ----
  it("H12 恶意不可字符串化拒绝值×两 op：仍固定 message、无内部附带字段（格式化不逃逸）", async () => {
    const hostile: unknown = { toString() { throw new Error("TOASTRING-BOOM"); } }; // String() 路径炸
    const audits: string[] = [];
    const host = createRpcWriteHost({
      sessionFor: () => { throw hostile; },
      audit: (l) => audits.push(l),
    });
    const e1 = await host.sendPrompt("/abs/s.jsonl", "x").then(() => null, (e: unknown) => e as Error);
    expect(e1).toBeInstanceOf(Error);
    expect(e1!.message).toBe("write-host-internal: prompt");
    expect(e1!.message).not.toContain("BOOM");
    const e2 = await host.stop("/abs/s.jsonl").then(() => null, (e: unknown) => e as Error);
    expect(e2!.message).toBe("write-host-internal: stop");
    let getterReads = 0;
    const hostileErr2 = Object.defineProperty(new Error("x"), "message", {
      get() { getterReads += 1; throw new Error("GETTER-BOOM-2"); },
    });
    const audits2: string[] = [];
    const badSend2 = { ...mkSession(), send: async () => { throw hostileErr2; } } as RpcLikeSession;
    const host2 = createRpcWriteHost({ sessionFor: () => badSend2, audit: (l) => audits2.push(l) });
    const e3 = await host2.sendPrompt("/abs/s.jsonl", "y").then(() => null, (e: unknown) => e as Error);
    expect(e3!.message).toBe("write-host-internal: prompt");
    expect(getterReads).toBeGreaterThan(0); // getter 确实被格式化读取（非可选链短路空覆盖）
    expect(audits2.length).toBe(0); // getter 中途抛错→该审计行被整体隔离丢弃，不半写入
    expect(e3!.message).not.toContain("GETTER-BOOM-2");
    for (const e of [e1!, e2!, e3!]) {
      expect((e as { cause?: unknown }).cause).toBeUndefined();
      expect(Object.keys(e).length).toBe(0); // 无附带内部字段
    }
  });

  it("H13 会话 stop 自身拒绝→同样剥离（write-host-internal: stop）+审计留细节", async () => {
    const audits: string[] = [];
    const bad = { ...mkSession(), stop: async () => { throw new Error("stop-boom"); } } as RpcLikeSession;
    const host = createRpcWriteHost({ sessionFor: () => bad, audit: (l) => audits.push(l) });
    await expect(host.stop("/abs/s.jsonl")).rejects.toThrow("write-host-internal: stop");
    expect(audits.some((l) => l.includes("stop-boom") && l.includes("op=stop"))).toBe(true);
  });

  it("H14 gate-failed 细节截断前落审计：audit 行含 stage+detail，DTO 仍无 error", async () => {
    const audits: string[] = [];
    const s = mkSession({ kind: "gate-failed", stage: "sending", error: new Error("内部细节-XYZ") });
    const host = createRpcWriteHost({ sessionFor: () => s, audit: (l) => audits.push(l) });
    const out = await host.sendPrompt("/abs/s.jsonl", "z");
    expect(out).toEqual({ kind: "gate-failed", stage: "sending" }); // 契约面仍截断
    expect(audits.some((l) => l.includes("write-host-gate-failed-detail") && l.includes("stage=sending") && l.includes("内部细节-XYZ"))).toBe(true);
  });
});
