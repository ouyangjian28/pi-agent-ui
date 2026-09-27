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
    expect(JSON.stringify(out) === JSON.stringify({ kind: "confirmed", exit })).toBe(true);
    expect(encodeStopOutcome({ kind: "deadline-exceeded" })).toEqual({ kind: "deadline-exceeded" });
    expect(encodeStopOutcome({ kind: "no-process" })).toEqual({ kind: "no-process" });
    expect(encodeStopOutcome({ kind: "stopping" })).toEqual({ kind: "stopping" });
  });
  it("E8 编码不抛错承诺面：对每分支返回值 kind 均在 DTO 集（类型级由穷尽 switch 保证，此处行为面复验）", () => {
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
});
