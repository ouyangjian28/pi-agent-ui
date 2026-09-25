// 轮派发屏障测试（TECH §3③+§5 三写硬序+§5.5 三标记制；r8/r8c 风险序 1：派发屏障与耐久接口）
// 覆盖：硬序两 fsync 先于 send 许可／屏障占用与释放／受理≠轮终／终态耐久失败 fail-closed／
// 乱序基础（settled 先于 success、晚到回执 no-op）／轮超时中断呈现／reopen。
import { describe, expect, it } from "vitest";
import type { JournalLine } from "@pi-agent-ui/protocol";
import { TurnGate } from "@pi-agent-ui/protocol";
import type { DurabilityPort, TurnIntentInput } from "@pi-agent-ui/protocol";

const T0 = "2026-09-25T00:00:00Z";
const t = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();

/** 受控耐久端口：记录行序；可按脚本失败（failOn=追加第 N 次时 reject）。 */
class FakeDurability implements DurabilityPort {
  readonly lines: JournalLine[] = [];
  failAt = -1; // 1 基调用序；命中 reject
  failError = new Error("fsync-eio");
  calls = 0;

  append(line: JournalLine): Promise<void> {
    this.calls += 1;
    if (this.failAt === this.calls) return Promise.reject(this.failError);
    this.lines.push(line);
    return Promise.resolve();
  }
}

const intent = (id = "i-1"): TurnIntentInput => ({
  intentId: id,
  sessionId: "s-1",
  generation: 1,
  leafId: "leaf-0",
  matchKey: { textHash: "ab12cd34", attachmentIdentity: "", ordinal: 0 },
  payload: { kind: "prompt", rawText: "你好", attachments: [], sentAt: T0 },
});

const makeGate = (dur: FakeDurability, nowMs = 0, turnTimeoutMs?: number): TurnGate =>
  new TurnGate({ durability: dur, now: () => t(nowMs), ...(turnTimeoutMs === undefined ? {} : { turnTimeoutMs }) });

describe("轮派发屏障（TurnGate）", () => {
  it("硬序：enqueue→sending 两 fsync 完成后才发 send 许可（行序=机械硬序①②）", async () => {
    const dur = new FakeDurability();
    const gate = makeGate(dur);
    const p = gate.submit(intent());
    // submit 未 resolve 前（dispatching）无 send 许可；resolve 后两行均已 fsync
    const out = await p;
    expect(out).toEqual({ kind: "send" });
    expect(dur.lines.map((l) => l.t)).toEqual(["enqueue", "sending"]);
    expect(gate.getState().kind).toBe("in-flight");
  });

  it("屏障占用：in-flight 中第二意图 submit=busy 拒绝", async () => {
    const dur = new FakeDurability();
    const gate = makeGate(dur);
    await gate.submit(intent());
    const out = await gate.submit(intent("i-2"));
    expect(out).toEqual({ kind: "rejected", reason: "busy" });
    expect(dur.lines).toHaveLength(2); // 第二意图未产生任何账本行
  });

  it("enqueue fsync 失败：failed(stage enqueue)+closed 保持+无 sending 行+后续 submit=closed 拒绝", async () => {
    const dur = new FakeDurability();
    dur.failAt = 1;
    const gate = makeGate(dur);
    const out = await gate.submit(intent());
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") {
      expect(out.stage).toBe("enqueue");
      expect(out.error).toBe(dur.failError);
    }
    expect(gate.getState()).toEqual({ kind: "closed", reason: "durability-failure" });
    expect(dur.lines).toHaveLength(0); // 意图行也未落（fsync 失败）
    expect(await gate.submit(intent())).toEqual({ kind: "rejected", reason: "closed" });
  });

  it("sending fsync 失败：failed(stage sending)+closed；journal=有 enqueue 无 sending（=崩溃矩阵自动补发面）", async () => {
    const dur = new FakeDurability();
    dur.failAt = 2;
    const gate = makeGate(dur);
    const out = await gate.submit(intent());
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") expect(out.stage).toBe("sending");
    expect(gate.getState()).toEqual({ kind: "closed", reason: "durability-failure" });
    expect(dur.lines.map((l) => l.t)).toEqual(["enqueue"]); // written 无 sending
  });

  it("success 仅受理不释放屏障：onAccepted 后第二意图仍 busy", async () => {
    const dur = new FakeDurability();
    const gate = makeGate(dur, 5_000);
    await gate.submit(intent());
    gate.onAccepted(); // RPC response=受理回执
    expect(gate.getState()).toMatchObject({ kind: "in-flight", acceptedAt: t(5_000) });
    expect(await gate.submit(intent("i-2"))).toEqual({ kind: "rejected", reason: "busy" });
  });

  it("settled+终态耐久成功才释放：idle 后下一意图可受理；settled 行已 fsync", async () => {
    const dur = new FakeDurability();
    const gate = makeGate(dur, 0);
    await gate.submit(intent());
    await gate.onTurnSettled();
    expect(dur.lines.map((l) => l.t)).toEqual(["enqueue", "sending", "settled"]);
    expect(gate.getState().kind).toBe("idle");
    expect(await gate.submit(intent("i-2"))).toEqual({ kind: "send" });
  });

  it("终态耐久失败：closed 保持（屏障不释放）；reopen 后可受理", async () => {
    const dur = new FakeDurability();
    dur.failAt = 3; // settled 行 fsync 失败
    const gate = makeGate(dur);
    await gate.submit(intent());
    await gate.onTurnSettled();
    expect(gate.getState()).toEqual({ kind: "closed", reason: "durability-failure" });
    expect(dur.lines.map((l) => l.t)).toEqual(["enqueue", "sending"]);
    expect(gate.reopen()).toBe(true);
    expect(gate.getState().kind).toBe("idle");
  });

  it("乱序基础：settled 先于 success（acceptedAt 仍 null）正常收口 idle", async () => {
    const dur = new FakeDurability();
    const gate = makeGate(dur);
    await gate.submit(intent());
    await gate.onTurnSettled(); // 未见过受理回执
    expect(gate.getState().kind).toBe("idle");
    expect(dur.lines.map((l) => l.t)).toEqual(["enqueue", "sending", "settled"]);
  });

  it("晚到回执均 no-op：settled 收口后的 accepted 与 settled 不炸不开新轮", async () => {
    const dur = new FakeDurability();
    const gate = makeGate(dur);
    await gate.submit(intent());
    await gate.onTurnSettled();
    gate.onAccepted(); // 超时后晚到 success 同此路径
    await gate.onTurnSettled(); // 晚到 settled
    expect(gate.getState().kind).toBe("idle");
    expect(dur.lines.map((l) => l.t)).toEqual(["enqueue", "sending", "settled"]); // 不追加行
  });

  it("轮超时：in-flight 超窗→closed(turn-timeout)=中断呈现；窗口内不裁决；reopen 解锁", async () => {
    const dur = new FakeDurability();
    const gate = makeGate(dur, 0, 30 * 60 * 1000);
    await gate.submit(intent());
    gate.checkTimeout(t(29 * 60 * 1000)); // 窗口内
    expect(gate.getState().kind).toBe("in-flight");
    gate.checkTimeout(t(30 * 60 * 1000 + 1)); // 超窗（> 上界）
    expect(gate.getState()).toEqual({ kind: "closed", reason: "turn-timeout" });
    expect(await gate.onTurnSettled()).toBeUndefined(); // 晚到 settled=no-op
    expect(gate.getState()).toEqual({ kind: "closed", reason: "turn-timeout" });
    expect(gate.reopen()).toBe(true);
    expect(gate.getState().kind).toBe("idle");
  });
});
