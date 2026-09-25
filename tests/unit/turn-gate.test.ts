// 轮派发屏障测试（TECH §3③+§5 三写硬序+§5.5 三标记制；r8/r8c 风险序 1：派发屏障与耐久接口）
// 覆盖：硬序两 fsync 先于 send 许可／屏障占用与释放／受理≠轮终／终态耐久失败 fail-closed／
// 乱序基础（settled 先于 success、晚到回执 no-op）／轮超时中断呈现／reopen／
// A1-01 关闭失效旧 submit（enqueue/sending/settled 三 pending 窗口）／A1-02 reject≠盘上无行（写后拒绝替身）。
import { describe, expect, it } from "vitest";
import type { JournalLine } from "@pi-agent-ui/protocol";
import { TurnGate } from "@pi-agent-ui/protocol";
import type { DurabilityPort, TurnIntentInput } from "@pi-agent-ui/protocol";

const T0 = "2026-09-25T00:00:00Z";
const t = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();

/**
 * 受控耐久端口。三种故障/挂起模式（A1-02 审读意见）：
 * - failAt+failMode:"before"（默认）=写前拒绝：行未进数组（进程内视角=确认未写入的替身下界）
 * - failAt+failMode:"after"=写后拒绝：行已进数组再 reject（fsync 报错但 write 已落——证明 reject≠盘上无行）
 * - holdAt=第 N 次 append 挂起（行已进数组），测试手动 resolve/reject（pending 窗口注入，A1-01）
 */
class FakeDurability implements DurabilityPort {
  readonly lines: JournalLine[] = [];
  failAt = -1; // 1 基调用序；命中按 failMode 拒绝
  failMode: "before" | "after" = "before";
  failError = new Error("fsync-eio");
  holdAt = -1; // 1 基调用序；命中挂起（行已记录），由 releaseHold/failHold 结算
  calls = 0;
  private held?: { line: JournalLine; resolve: () => void; reject: (e: unknown) => void } | undefined;

  append(line: JournalLine): Promise<void> {
    this.calls += 1;
    if (this.failAt === this.calls && this.failMode === "before") return Promise.reject(this.failError);
    if (this.holdAt === this.calls) {
      this.lines.push(line); // 挂起=行已写入内存视角，磁盘结果待结算
      return new Promise<void>((resolve, reject) => {
        this.held = { line, resolve, reject };
      });
    }
    if (this.failAt === this.calls && this.failMode === "after") {
      this.lines.push(line); // 已落行再报错
      return Promise.reject(this.failError);
    }
    this.lines.push(line);
    return Promise.resolve();
  }

  isHeld(): boolean {
    return this.held !== undefined;
  }

  releaseHold(): void {
    if (!this.held) throw new Error("no held append");
    this.held.resolve();
    this.held = undefined;
  }

  failHold(error: unknown = this.failError): void {
    if (!this.held) throw new Error("no held append");
    this.held.reject(error);
    this.held = undefined;
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

/** 等待第 N 次 append 真正挂起（submit 内部 await 后才发起后续 append——需让出微任务）。 */
const untilHeld = async (dur: FakeDurability): Promise<void> => {
  for (let i = 0; i < 100 && !dur.isHeld(); i += 1) await Promise.resolve();
  if (!dur.isHeld()) throw new Error("append never held");
};

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

  it("enqueue fsync 失败（写前拒绝替身）：failed(stage enqueue)+closed 保持+无 sending 行+后续 submit=closed 拒绝", async () => {
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
    expect(dur.lines).toHaveLength(0); // 写前拒绝：进程内替身视角无行（真实盘态由恢复重放裁决）
    expect(await gate.submit(intent())).toEqual({ kind: "rejected", reason: "closed" });
  });

  it("sending fsync 失败（写前拒绝替身）：failed(stage sending)+closed；journal=有 enqueue 无 sending", async () => {
    const dur = new FakeDurability();
    dur.failAt = 2;
    const gate = makeGate(dur);
    const out = await gate.submit(intent());
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") expect(out.stage).toBe("sending");
    expect(gate.getState()).toEqual({ kind: "closed", reason: "durability-failure" });
    expect(dur.lines.map((l) => l.t)).toEqual(["enqueue"]); // written 无 sending（进程内视角）
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
    expect(await gate.onTurnSettled()).toBe("not-in-flight"); // 晚到 settled=no-op（未开轮/已收口）
    expect(gate.getState()).toEqual({ kind: "closed", reason: "turn-timeout" });
    expect(gate.reopen()).toBe(true);
    expect(gate.getState().kind).toBe("idle");
  });
});

describe("A1-01：close/reopen 使 pending 中的旧操作失效", () => {
  it("enqueue fsync pending 期间 close：旧 submit=invalidated(enqueue)，不发放 send、不尝试 sending、不覆盖 closed", async () => {
    const dur = new FakeDurability();
    dur.holdAt = 1;
    const gate = makeGate(dur);
    const p = gate.submit(intent());
    expect(gate.getState().kind).toBe("dispatching");
    gate.close("manual"); // 关闭意图（如进程换代）
    dur.releaseHold(); // enqueue 追加随后成功
    expect(await p).toEqual({ kind: "invalidated", stage: "enqueue" });
    expect(gate.getState()).toEqual({ kind: "closed", reason: "manual" }); // close 的裁决不被旧 submit 覆盖
    expect(dur.lines.map((l) => l.t)).toEqual(["enqueue"]); // 行已写（成功路径）；不再追加 sending
    expect(dur.calls).toBe(1);
  });

  it("sending fsync pending 期间 close：旧 submit=invalidated(sending)（两 fsync 均已成功仍不发 send）", async () => {
    const dur = new FakeDurability();
    dur.holdAt = 2;
    const gate = makeGate(dur);
    const p = gate.submit(intent());
    await untilHeld(dur); // 等第二次 append（sending）真正挂起
    gate.close("manual");
    dur.releaseHold();
    expect(await p).toEqual({ kind: "invalidated", stage: "sending" });
    expect(gate.getState()).toEqual({ kind: "closed", reason: "manual" });
    expect(dur.lines.map((l) => l.t)).toEqual(["enqueue", "sending"]);
  });

  it("fsync pending 期间 close 且随后 reject：invalidated 优先于 failed（生命周期接管）", async () => {
    const dur = new FakeDurability();
    dur.holdAt = 1;
    const gate = makeGate(dur);
    const p = gate.submit(intent());
    gate.close("manual");
    dur.failHold(); // append 失败
    expect(await p).toEqual({ kind: "invalidated", stage: "enqueue" }); // 不再置 durability-failure（状态已是 manual）
    expect(gate.getState()).toEqual({ kind: "closed", reason: "manual" });
  });

  it("settled 行 fsync pending 期间 close：追加成功后不转 idle（closed 保持）", async () => {
    const dur = new FakeDurability();
    dur.holdAt = 3;
    const gate = makeGate(dur);
    await gate.submit(intent());
    const sp = gate.onTurnSettled();
    gate.close("manual");
    dur.releaseHold();
    await sp;
    expect(gate.getState()).toEqual({ kind: "closed", reason: "manual" }); // 旧结算成功不复活屏障
  });

  it("旧轮 settled 追加失败发生在换代后的新在飞轮：不得关闭新轮（A1-04 反例后半）", async () => {
    const dur = new FakeDurability();
    dur.holdAt = 3;
    const gate = makeGate(dur);
    await gate.submit(intent("i-a"));
    const sp = gate.onTurnSettled(); // A 轮 settled 追加挂起
    gate.close("manual"); // 换代/接管
    expect(gate.reopen()).toBe(true);
    expect(await gate.submit(intent("i-b"))).toEqual({ kind: "send" }); // B 轮在飞
    dur.failHold(); // A 的旧追加此刻失败
    await sp;
    expect(gate.getState()).toMatchObject({ kind: "in-flight", intentId: "i-b" }); // 旧失败不关新轮
  });

  it("settling 期间（settled 行 fsync pending）submit=busy（终态未耐久不放屏障）", async () => {
    const dur = new FakeDurability();
    dur.holdAt = 3;
    const gate = makeGate(dur);
    await gate.submit(intent());
    const sp = gate.onTurnSettled();
    expect(gate.getState().kind).toBe("settling");
    expect(await gate.submit(intent("i-2"))).toEqual({ kind: "rejected", reason: "busy" });
    dur.releaseHold();
    await sp;
    expect(gate.getState().kind).toBe("idle");
  });
});

describe("A1-02：fsync reject≠盘上无行（写后拒绝替身）", () => {
  it("sending 写后拒绝：failed(stage sending)+closed，但 journal 已含 sending 行（进程内不得宣称「无 sending」）", async () => {
    const dur = new FakeDurability();
    dur.failAt = 2;
    dur.failMode = "after"; // write 已落（含部分行可能），fsync 报错
    const gate = makeGate(dur);
    const out = await gate.submit(intent());
    expect(out).toMatchObject({ kind: "failed", stage: "sending" });
    expect(gate.getState()).toEqual({ kind: "closed", reason: "durability-failure" });
    expect(dur.lines.map((l) => l.t)).toEqual(["enqueue", "sending"]); // 行已在——恢复以实际重放裁决，不得按 Promise 结果宣称矩阵行
  });

  it("写后拒绝下副作用通道仍未开栓（send 许可从未发放=未发送成立；盘态另行裁决）", async () => {
    const dur = new FakeDurability();
    dur.failAt = 1;
    dur.failMode = "after";
    const gate = makeGate(dur);
    const out = await gate.submit(intent());
    expect(out).toMatchObject({ kind: "failed", stage: "enqueue" });
    expect(gate.getState().kind).toBe("closed");
    expect(dur.lines.map((l) => l.t)).toEqual(["enqueue"]); // 行在（与写前拒绝的关键差异）
    expect(dur.calls).toBe(1); // 无 sending 追加
  });
});

describe("B1-01：非 closed 的 reopen=无副作用假失败（不得取消 pending 中的有效操作）", () => {
  it("enqueue fsync pending 期间 reopen()=false 且无副作用：追加完成→send 许可正常发放，屏障不卡死", async () => {
    const dur = new FakeDurability();
    dur.holdAt = 1;
    const gate = makeGate(dur);
    const p = gate.submit(intent());
    await untilHeld(dur);
    expect(gate.reopen()).toBe(false); // 屏障仍在忙（dispatching）：拒绝解锁且不递增 epoch
    dur.releaseHold();
    expect(await p).toEqual({ kind: "send" }); // 原操作正常推进（未被作废）
    expect(gate.getState().kind).toBe("in-flight");
  });

  it("sending fsync pending 期间 reopen()=false：追加完成→send 许可正常发放", async () => {
    const dur = new FakeDurability();
    dur.holdAt = 2;
    const gate = makeGate(dur);
    const p = gate.submit(intent());
    await untilHeld(dur);
    expect(gate.reopen()).toBe(false);
    dur.releaseHold();
    expect(await p).toEqual({ kind: "send" });
    expect(gate.getState().kind).toBe("in-flight");
  });

  it("settled 行 fsync pending 期间 reopen()=false：追加完成→idle 正常释放，下一意图可受理", async () => {
    const dur = new FakeDurability();
    dur.holdAt = 3;
    const gate = makeGate(dur);
    await gate.submit(intent());
    const sp = gate.onTurnSettled();
    await untilHeld(dur);
    expect(gate.reopen()).toBe(false);
    dur.releaseHold();
    await sp;
    expect(gate.getState().kind).toBe("idle");
    expect(await gate.submit(intent("i-2"))).toEqual({ kind: "send" });
  });

  it("失败 reopen 后原操作失败路径不受污染：enqueue reject→failed(enqueue)+closed（正常 fail-closed）", async () => {
    const dur = new FakeDurability();
    dur.holdAt = 1;
    const gate = makeGate(dur);
    const p = gate.submit(intent());
    await untilHeld(dur);
    expect(gate.reopen()).toBe(false);
    dur.failHold();
    expect(await p).toMatchObject({ kind: "failed", stage: "enqueue" }); // 正常失败语义（非 invalidated）
    expect(gate.getState()).toEqual({ kind: "closed", reason: "durability-failure" });
    // 真 closed 后 reopen 仍有效（解锁路径不受本修复影响）
    expect(gate.reopen()).toBe(true);
    expect(gate.getState().kind).toBe("idle");
  });
});

describe("硬序 pending 面（s1b：未关闭时直接断言许可不早于追加完成）", () => {
  it("sending fsync 挂起期间 submit 不 resolve：send 许可不先于第二次追加完成", async () => {
    const dur = new FakeDurability();
    dur.holdAt = 2;
    const gate = makeGate(dur);
    const p = gate.submit(intent());
    await untilHeld(dur);
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    for (let i = 0; i < 20; i += 1) await Promise.resolve(); // 排空微任务：仍 pending
    expect(settled).toBe(false);
    dur.releaseHold();
    expect(await p).toEqual({ kind: "send" });
    expect(settled).toBe(true);
  });
});

describe("B1-01 补遗（s1c 建议固化：失败 reopen 后原操作失败路径两窗口）", () => {
  it("sending fsync pending 假失败 reopen 后 reject：failed(sending)+closed（正常 fail-closed，非 invalidated）", async () => {
    const dur = new FakeDurability();
    dur.holdAt = 2;
    const gate = makeGate(dur);
    const p = gate.submit(intent());
    await untilHeld(dur);
    expect(gate.reopen()).toBe(false);
    dur.failHold();
    expect(await p).toMatchObject({ kind: "failed", stage: "sending" });
    expect(gate.getState()).toEqual({ kind: "closed", reason: "durability-failure" });
    expect(gate.reopen()).toBe(true); // 真 closed 解锁仍有效
  });

  it("settled 行 fsync pending 假失败 reopen 后 reject：closed（durability-failure），未错误释放为 idle", async () => {
    const dur = new FakeDurability();
    dur.holdAt = 3;
    const gate = makeGate(dur);
    await gate.submit(intent());
    const sp = gate.onTurnSettled();
    await untilHeld(dur);
    expect(gate.reopen()).toBe(false);
    dur.failHold();
    await sp;
    expect(gate.getState()).toEqual({ kind: "closed", reason: "durability-failure" }); // 终态未耐久=不放行
    expect(await gate.submit(intent("i-2"))).toEqual({ kind: "rejected", reason: "closed" });
  });
});
