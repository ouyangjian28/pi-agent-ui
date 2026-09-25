// 派发协调层测试（切片 2；TECH §169④ 事件归属屏障语义权威）
// 反例集=s1b §九 7 条+溢出+四联丢弃+超时分派表分支；纯逻辑注入（FakeDurability 三模式+受控时钟）。
import { describe, expect, it } from "vitest";
import type { JournalLine } from "@pi-agent-ui/protocol";
import { DispatchCoordinator, TurnGate } from "@pi-agent-ui/protocol";
import type { CoordinatorDeps, TurnIntentInput } from "@pi-agent-ui/protocol";

const T0 = "2026-09-25T00:00:00Z";
const t = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();

/** 受控耐久端口（与 turn-gate.test 同构：写前拒绝/写后拒绝/挂起三模式）。 */
class FakeDurability {
  readonly lines: JournalLine[] = [];
  failAt = -1; // 1 基调用序
  failMode: "before" | "after" = "before";
  failError = new Error("fsync-eio");
  holdAt = -1;
  calls = 0;
  private held?: { line: JournalLine; resolve: () => void; reject: (e: unknown) => void } | undefined;

  append(line: JournalLine): Promise<void> {
    this.calls += 1;
    if (this.failAt === this.calls && this.failMode === "before") return Promise.reject(this.failError);
    if (this.holdAt === this.calls) {
      this.lines.push(line);
      return new Promise<void>((resolve, reject) => {
        this.held = { line, resolve, reject };
      });
    }
    if (this.failAt === this.calls && this.failMode === "after") {
      this.lines.push(line);
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
}

const intent = (id = "i-1", generation = 1): TurnIntentInput => ({
  intentId: id,
  sessionId: "s-1",
  generation,
  leafId: `leaf-${id}`,
  matchKey: { textHash: "ab12cd34", attachmentIdentity: "", ordinal: 0 },
  payload: { kind: "prompt", rawText: "你好", attachments: [], sentAt: T0 },
});

interface Harness {
  coord: DispatchCoordinator;
  gate: TurnGate;
  dur: FakeDurability;
  audits: string[];
  drained: unknown[][];
  clock: { iso: string };
}

function makeHarness(overrides: { maxBufferedEvents?: number } = {}): Harness {
  const dur = new FakeDurability();
  const audits: string[] = [];
  const drained: unknown[][] = [];
  const clock = { iso: T0 };
  const gate = new TurnGate({ durability: dur, now: () => clock.iso, turnTimeoutMs: 30 * 60 * 1000 });
  const deps: CoordinatorDeps = {
    gate,
    durability: dur,
    now: () => clock.iso,
    responseTimeoutMs: 60_000,
    maxBufferedEvents: overrides.maxBufferedEvents ?? 3,
    audit: (l) => audits.push(l),
    onBufferDrain: (evs) => drained.push([...evs]),
  };
  return { coord: new DispatchCoordinator(deps), gate, dur, audits, drained, clock };
}

/** 等待第 N 次 append 真正挂起。 */
const untilHeld = async (dur: FakeDurability): Promise<void> => {
  for (let i = 0; i < 100 && !dur.isHeld(); i += 1) await Promise.resolve();
  if (!dur.isHeld()) throw new Error("append never held");
};

describe("派发协调层（DispatchCoordinator，§169④）", () => {
  it("正常序：launch→success 回绑→settled 结算→屏障释放", async () => {
    const h = makeHarness();
    const launch = await h.coord.submitTurn(intent("i-1"), 101);
    expect(launch).toEqual({ kind: "launched", key: { intentId: "i-1", commandId: 101, generation: 1 } });
    expect((await h.coord.onRpcResponse(101, 1, true)).kind).toBe("accepted");
    expect(h.gate.getState()).toMatchObject({ kind: "in-flight", acceptedAt: T0 });
    const st = await h.coord.onSettledEvent({ generation: 1, commandId: 101 });
    expect(st).toMatchObject({ kind: "settled" });
    expect(h.gate.getState()).toEqual({ kind: "idle" });
    expect(h.coord.getState().command).toBeNull();
  });

  it("反例1 事件→settled→success：settled 先到保留缓冲，success 回绑即结算（不等第二个）", async () => {
    const h = makeHarness();
    await h.coord.submitTurn(intent("i-1"), 101);
    expect(h.coord.onPiEvent({ type: "message_start" }, 1)).toEqual({ kind: "buffered" });
    expect(h.coord.onPiEvent({ type: "message_update" }, 1)).toEqual({ kind: "buffered" });
    const pre = await h.coord.onSettledEvent({ generation: 1, commandId: 101 });
    expect(pre).toMatchObject({ kind: "buffered" }); // prompt 在途+settled 先到=保留（唯一读法）
    const resp = await h.coord.onRpcResponse(101, 1, true);
    expect(resp).toMatchObject({ kind: "accepted-and-settled" });
    expect(h.gate.getState()).toEqual({ kind: "idle" });
    expect(h.coord.getState().command).toBeNull();
    expect(h.drained).toEqual([[{ type: "message_start" }, { type: "message_update" }]]); // 回绑交付缓冲
    // 结算后无 id settled=迟到观察丢弃（四联空）
    expect(await h.coord.onSettledEvent({ generation: 1 })).toMatchObject({ kind: "discarded", reason: "fourfold-empty" });
  });

  it("反例2 响应超时→晚到 success→晚到 settled：先耐久记录再移出；不回绑不开 run；晚到 settled 结算记录", async () => {
    const h = makeHarness();
    await h.coord.submitTurn(intent("i-1"), 101);
    h.clock.iso = t(120_000); // 超 60s 响应窗
    const to = await h.coord.checkResponseTimeout();
    expect(to).toMatchObject({ kind: "recorded" });
    expect(h.dur.lines.some((l) => l.t === "response-timeout")).toBe(true); // 记录已耐久（先于移出）
    expect(h.coord.getState().command).toMatchObject({ phase: "response-timed-out" });
    expect(h.gate.getState().kind).toBe("in-flight"); // 屏障保持等 settled/换代
    expect(await h.coord.onRpcResponse(101, 1, true)).toMatchObject({ kind: "ignored-late" }); // 不回绑不开 run
    expect(h.gate.getState()).toMatchObject({ kind: "in-flight", acceptedAt: null });
    expect(h.audits).toContain("response-late commandId=101 phase=response-timed-out");
    expect(await h.coord.onSettledEvent({ generation: 1, commandId: 101 })).toMatchObject({ kind: "settled" });
    expect(h.gate.getState()).toEqual({ kind: "idle" });
  });

  it("反例3 settled 已缓冲→超时处理：记录+结算一次；重复 settled=迟到丢弃", async () => {
    const h = makeHarness();
    await h.coord.submitTurn(intent("i-1"), 101);
    await h.coord.onSettledEvent({ generation: 1, commandId: 101 }); // 先到缓冲
    h.clock.iso = t(120_000);
    const to = await h.coord.checkResponseTimeout();
    expect(to).toMatchObject({ kind: "recorded-and-settled" });
    expect(h.gate.getState()).toEqual({ kind: "idle" });
    expect(h.coord.getState().command).toBeNull();
    expect(await h.coord.onSettledEvent({ generation: 1, commandId: 101 })).toMatchObject({
      kind: "discarded",
      reason: "retired-command",
    });
  });

  it("反例4 终态耐久失败→重复事件保持关闭（重复 settled 再呈现 settle-durability-failed 不改写）", async () => {
    const h = makeHarness();
    await h.coord.submitTurn(intent("i-1"), 101);
    await h.coord.onRpcResponse(101, 1, true);
    h.dur.failAt = 3; // 第 3 次 append=settled 行（写前拒绝）
    expect(await h.coord.onSettledEvent({ generation: 1, commandId: 101 })).toMatchObject({
      kind: "settle-durability-failed",
    });
    expect(h.gate.getState()).toEqual({ kind: "closed", reason: "durability-failure" });
    // 重复 settled：gate 已 closed（onTurnSettled 守卫不重写终态行），协调器呈现 held 不改状态
    expect(await h.coord.onSettledEvent({ generation: 1, commandId: 101 })).toMatchObject({
      kind: "settle-durability-failed",
    });
    expect(h.gate.getState()).toEqual({ kind: "closed", reason: "durability-failure" }); // 保持关闭
  });

  it("反例5 A 收口后 B 在飞：A 晚到 settled（带 id）不得结算 B", async () => {
    const h = makeHarness();
    await h.coord.submitTurn(intent("i-1"), 101);
    await h.coord.onRpcResponse(101, 1, true);
    await h.coord.onSettledEvent({ generation: 1, commandId: 101 });
    expect(h.gate.getState()).toEqual({ kind: "idle" });
    await h.coord.submitTurn(intent("i-2"), 102);
    await h.coord.onRpcResponse(102, 1, true); // B run-open
    expect(await h.coord.onSettledEvent({ generation: 1, commandId: 101 })).toMatchObject({
      kind: "discarded",
      reason: "retired-command",
    });
    expect(h.gate.getState()).toMatchObject({ kind: "in-flight", intentId: "i-2" }); // B 不受影响
    expect(await h.coord.onSettledEvent({ generation: 1, commandId: 102 })).toMatchObject({ kind: "settled" });
  });

  it("反例6 close 插入 submit 耐久窗口：invalidated 不登记、晚到 response=未登记", async () => {
    const h = makeHarness();
    h.dur.holdAt = 1; // enqueue append 挂起
    const pending = h.coord.submitTurn(intent("i-1"), 101);
    await untilHeld(h.dur);
    h.gate.close("manual");
    h.dur.releaseHold();
    expect(await pending).toEqual({ kind: "invalidated", stage: "enqueue" });
    expect(h.coord.getState().command).toBeNull(); // 无登记（无 stdin 许可）
    expect(await h.coord.onRpcResponse(101, 1, true)).toMatchObject({ kind: "ignored-unknown" });
  });

  it("反例7 换代：旧代次登记清除+晚到事件丢弃；新代次轮不受影响", async () => {
    const h = makeHarness();
    await h.coord.submitTurn(intent("i-1", 7), 101); // gen=7
    expect(h.coord.onGenerationRetired(7)).toEqual({ clearedCommands: 1, clearedEvents: 0 });
    expect(h.coord.getState().command).toBeNull();
    expect(await h.coord.onSettledEvent({ generation: 7 })).toMatchObject({ kind: "discarded", reason: "fourfold-empty" });
    expect(await h.coord.onRpcResponse(101, 7, true)).toMatchObject({ kind: "ignored-unknown" });
    // 屏障解除依据归宿主：旧轮 gate 仍 in-flight，须走换代手续（close→reopen）才可开新轮
    h.gate.close("manual");
    expect(h.gate.reopen()).toBe(true);
    await h.coord.submitTurn(intent("i-2", 8), 201); // 新代次正常
    await h.coord.onRpcResponse(201, 8, true);
    expect(await h.coord.onSettledEvent({ generation: 8, commandId: 201 })).toMatchObject({ kind: "settled" });
  });

  it("事件缓冲溢出：关闭屏障+审计，已缓冲保留呈现（不静默丢）", async () => {
    const h = makeHarness({ maxBufferedEvents: 2 });
    await h.coord.submitTurn(intent("i-1"), 101);
    expect(h.coord.onPiEvent({ i: 1 }, 1)).toEqual({ kind: "buffered" });
    expect(h.coord.onPiEvent({ i: 2 }, 1)).toEqual({ kind: "buffered" });
    expect(h.coord.onPiEvent({ i: 3 }, 1)).toEqual({ kind: "discarded", reason: "overflow-closed" });
    expect(h.gate.getState()).toEqual({ kind: "closed", reason: "buffer-overflow" });
    expect(h.audits).toContain("event-buffer-overflow cap=2");
    expect(h.coord.getState().command?.bufferedEvents).toHaveLength(2);
  });

  it("run-open 事件直接交付；旧代次/轮外事件丢弃", async () => {
    const h = makeHarness();
    await h.coord.submitTurn(intent("i-1"), 101);
    await h.coord.onRpcResponse(101, 1, true);
    expect(h.coord.onPiEvent({ i: 1 }, 1)).toEqual({ kind: "deliver" });
    expect(h.coord.onPiEvent({ i: 2 }, 9)).toEqual({ kind: "discarded", reason: "stale-generation" });
    h.coord.onGenerationRetired(1);
    expect(h.coord.onPiEvent({ i: 3 }, 1)).toEqual({ kind: "discarded", reason: "no-in-flight" });
  });

  it("响应超时记录 fsync 失败：gate fail-closed 且不移出在途", async () => {
    const h = makeHarness();
    await h.coord.submitTurn(intent("i-1"), 101);
    h.dur.failAt = 3; // 第 3 次 append=response-timeout 行
    h.clock.iso = t(120_000);
    expect(await h.coord.checkResponseTimeout()).toMatchObject({ kind: "durability-failure" });
    expect(h.gate.getState()).toEqual({ kind: "closed", reason: "durability-failure" });
    expect(h.coord.getState().command).toMatchObject({ phase: "awaiting-response" }); // 未移出
  });

  it("无在途时无 id settled=四联空丢弃+审计", async () => {
    const h = makeHarness();
    expect(await h.coord.onSettledEvent({ generation: 1 })).toMatchObject({
      kind: "discarded",
      reason: "fourfold-empty",
    });
    expect(h.audits).toContain("settled-late-fourfold-empty");
  });

  it("响应失败(ok=false)：审计+屏障不动（处置面宿主接管）", async () => {
    const h = makeHarness();
    await h.coord.submitTurn(intent("i-1"), 101);
    expect(await h.coord.onRpcResponse(101, 1, false)).toMatchObject({ kind: "response-failure" });
    expect(h.gate.getState()).toMatchObject({ kind: "in-flight", acceptedAt: null });
    expect(h.coord.getState().command).toMatchObject({ phase: "awaiting-response" });
  });

  it("整轮超时委托 gate：closed(turn-timeout) 中断呈现", async () => {
    const h = makeHarness();
    await h.coord.submitTurn(intent("i-1"), 101);
    await h.coord.onRpcResponse(101, 1, true);
    h.clock.iso = t(31 * 60_000); // 超 30min 整轮窗
    h.coord.checkTurnTimeout();
    expect(h.gate.getState()).toEqual({ kind: "closed", reason: "turn-timeout" });
  });
});
