// 派发协调层测试（切片 2；TECH §169④ 事件归属屏障语义权威）
// 反例集=s1b §九 7 条+溢出+四联丢弃+超时分派表分支；纯逻辑注入（FakeDurability 三模式+受控时钟）。
// S2 修复组：S2-01 超时等待窗口合并/superseded/重入；S2-02 旧超时跨换代失效；S2-03 结算失败缓冲保留+abandonHeld。
// s2b 修复组：B1 结算等待窗口最新缓冲交付；B2 超时槽位所有权；B3 失败侧所有权；Y1 无关代次退役 no-op；Y4 drain 回调隔离。
import { describe, expect, it } from "vitest";
import type { IntentId, JournalLine, SessionId } from "@pi-agent-ui/protocol";
import { DispatchCoordinator, TurnGate, replayIntents } from "@pi-agent-ui/protocol";
import type { CoordinatorDeps, LaunchOutcome, TurnIntentInput } from "@pi-agent-ui/protocol";

const T0 = "2026-09-25T00:00:00Z";
const t = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();

/** 受控耐久端口（与 turn-gate.test 同构：写前拒绝/写后拒绝/挂起三模式）。 */
class FakeDurability {
  readonly lines: JournalLine[] = [];
  failAt = -1; // 1 基调用序
  failMode: "before" | "after" = "before";
  failError = new Error("fsync-eio");
  holdAt = -1; // 1 基调用序；命中挂起（支持多挂起槽）
  holdAt2 = -1; // 第二挂起点（B2：两个 append 同时挂起的窗口）
  calls = 0;
  private held: { line: JournalLine; resolve: () => void; reject: (e: unknown) => void }[] = [];

  append(line: JournalLine): Promise<void> {
    this.calls += 1;
    if (this.failAt === this.calls && this.failMode === "before") return Promise.reject(this.failError);
    if (this.holdAt === this.calls || this.holdAt2 === this.calls) {
      this.lines.push(line);
      return new Promise<void>((resolve, reject) => {
        this.held.push({ line, resolve, reject });
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
    return this.held.length > 0;
  }

  /** 结算第 which 个挂起（默认最早；B2 双槽用序号）。 */
  releaseHold(which = 0): void {
    const h = this.held[which];
    if (!h) throw new Error("no held append");
    this.held.splice(which, 1);
    h.resolve();
  }

  rejectHold(which = 0): void {
    const h = this.held[which];
    if (!h) throw new Error("no held append");
    this.held.splice(which, 1);
    h.reject(this.failError);
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

function makeHarness(overrides: { maxBufferedEvents?: number; onBufferDrain?: (events: readonly unknown[]) => void } = {}): Harness {
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
    onBufferDrain: overrides.onBufferDrain ?? ((evs) => drained.push([...evs])),
  };
  return { coord: new DispatchCoordinator(deps), gate, dur, audits, drained, clock };
}

/** 等待第 N 次 append 真正挂起。 */
const untilHeld = async (dur: FakeDurability): Promise<void> => {
  for (let i = 0; i < 100 && !dur.isHeld(); i += 1) await Promise.resolve();
  if (!dur.isHeld()) throw new Error("append never held");
};

/** 等到第 N 次 append 已发起（双挂起窗口：首槽已占时等第二槽）。 */
const untilCalls = async (dur: FakeDurability, n: number): Promise<void> => {
  for (let i = 0; i < 100 && dur.calls < n; i += 1) await Promise.resolve();
  if (dur.calls < n) throw new Error(`append calls ${dur.calls} < ${n}`);
};

describe("派发协调层（DispatchCoordinator，§169④）", () => {
  it("正常序：launch→success 回绑→settled 结算→屏障释放；未登记 response=ignored-unknown", async () => {
    const h = makeHarness();
    const launch = await h.coord.submitTurn(intent("i-1"), 101);
    expect(launch).toEqual({ kind: "launched", key: { intentId: "i-1", commandId: 101, generation: 1 } });
    expect((await h.coord.onRpcResponse(101, 1, true)).kind).toBe("accepted");
    expect(h.gate.getState()).toMatchObject({ kind: "in-flight", acceptedAt: T0 });
    expect(await h.coord.onRpcResponse(999, 1, true)).toEqual({ kind: "ignored-unknown" }); // 错 commandId 不猜归属
    expect(h.audits).toContain("response-unknown commandId=999 generation=1");
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
    // awaiting 重复 settled=迟到丢弃（保留首个，不双结算）
    expect(await h.coord.onSettledEvent({ generation: 1, commandId: 101 })).toMatchObject({ kind: "discarded-duplicate" });
    const resp = await h.coord.onRpcResponse(101, 1, true);
    expect(resp).toMatchObject({ kind: "accepted-and-settled" });
    expect(h.gate.getState()).toEqual({ kind: "idle" });
    expect(h.coord.getState().command).toBeNull();
    expect(h.drained).toEqual([[{ type: "message_start" }, { type: "message_update" }]]); // 回绑交付缓冲
    // 结算后无 id settled=迟到观察丢弃（四联空）
    expect(await h.coord.onSettledEvent({ generation: 1 })).toMatchObject({ kind: "discarded-idle" });
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

  it("超时后无 id settled：唯一在途归因结算（attribution 审计）", async () => {
    const h = makeHarness();
    await h.coord.submitTurn(intent("i-1"), 101);
    h.clock.iso = t(120_000);
    expect(await h.coord.checkResponseTimeout()).toMatchObject({ kind: "recorded" });
    expect(await h.coord.onSettledEvent({ generation: 1 })).toMatchObject({ kind: "settled" }); // 无 id：归因唯一在途
    expect(h.audits).toContain("settled-attribution-by-single-flight commandId=101");
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
    expect(h.dur.lines.filter((l) => l.t === "settled")).toHaveLength(1); // 结算行恰一次
    expect(await h.coord.onSettledEvent({ generation: 1, commandId: 101 })).toMatchObject({
      kind: "discarded-idle",
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
      kind: "discarded-retired-command",
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

  it("反例7 换代：旧代次登记清除（含非空缓冲计数）+晚到事件丢弃；新代次轮不受影响", async () => {
    const h = makeHarness();
    await h.coord.submitTurn(intent("i-1", 7), 101); // gen=7
    h.coord.onPiEvent({ i: 1 }, 7);
    h.coord.onPiEvent({ i: 2 }, 7);
    expect(h.coord.onGenerationRetired(7)).toEqual({ clearedCommands: 1, clearedEvents: 2 }); // 丢弃计数不静默
    expect(h.audits.some((l) => l.startsWith("generation-retired generation=7") && l.includes("clearedEvents=2"))).toBe(true);
    expect(h.coord.getState().command).toBeNull();
    expect(await h.coord.onSettledEvent({ generation: 7 })).toMatchObject({ kind: "discarded-idle" });
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
    expect(h.coord.onPiEvent({ i: 3 }, 1)).toEqual({ kind: "overflow-closed" });
    expect(h.gate.getState()).toEqual({ kind: "closed", reason: "buffer-overflow" });
    expect(h.audits).toContain("buffer-overflow commandId=101 buffered=2 limit=2");
    expect(h.coord.getState().command?.bufferedEvents).toHaveLength(2);
  });

  it("run-open 事件直接交付；旧代次/轮外事件丢弃", async () => {
    const h = makeHarness();
    await h.coord.submitTurn(intent("i-1"), 101);
    await h.coord.onRpcResponse(101, 1, true);
    expect(h.coord.onPiEvent({ i: 1 }, 1)).toEqual({ kind: "delivered" });
    expect(h.coord.onPiEvent({ i: 2 }, 9)).toEqual({ kind: "dropped-stale-generation" });
    h.coord.onGenerationRetired(1);
    expect(h.coord.onPiEvent({ i: 3 }, 1)).toEqual({ kind: "dropped-stale-generation" });
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
    expect(await h.coord.onSettledEvent({ generation: 1 })).toMatchObject({ kind: "discarded-idle" });
    expect(h.audits).toContain("settled-idle generation=1");
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

  it("response-timeout 行重放：记录标记+终态由 settled 行承载（S2-06）", () => {
    const seed = intent("i-1");
    const base: JournalLine[] = [
      {
        t: "enqueue",
        intentId: seed.intentId,
        sessionId: seed.sessionId,
        generation: 1,
        leafId: seed.leafId,
        matchKey: seed.matchKey,
        payload: seed.payload,
      },
      { t: "sending", intentId: seed.intentId },
      { t: "response-timeout", intentId: seed.intentId, generation: 1, commandId: 101 },
    ];
    const open = replayIntents(base, "s-1" as SessionId);
    expect(open.get("i-1" as IntentId)?.responseTimeoutRecorded).toBe(true);
    expect(open.get("i-1" as IntentId)?.lastVerdict).toBeNull(); // 行在+无终态=效果未知呈现
    const closed = replayIntents([...base, { t: "settled", intentId: seed.intentId }], "s-1" as SessionId);
    expect(closed.get("i-1" as IntentId)?.lastVerdict).toBe("settled"); // 终态由 settled 行承载
    expect(closed.get("i-1" as IntentId)?.responseTimeoutRecorded).toBe(true);
  });

  describe("S2-01 超时记录等待窗口（挂起期世界变化合并裁决）", () => {
    it("等待期 event+settled 到达：合并保留→recorded-and-settled+缓冲交付", async () => {
      const h = makeHarness();
      await h.coord.submitTurn(intent("i-1"), 101);
      h.dur.holdAt = 3; // 第 3 次 append=response-timeout 记录
      h.clock.iso = t(120_000);
      const pending = h.coord.checkResponseTimeout();
      await untilHeld(h.dur);
      expect(h.coord.onPiEvent({ type: "message_start" }, 1)).toEqual({ kind: "buffered" }); // 等待期事件
      expect(h.coord.onPiEvent({ type: "message_update" }, 1)).toEqual({ kind: "buffered" });
      expect(await h.coord.onSettledEvent({ generation: 1, commandId: 101 })).toMatchObject({ kind: "buffered" }); // 等待期 settled
      h.dur.releaseHold();
      expect(await pending).toMatchObject({ kind: "recorded-and-settled" }); // 合并：不吞等待期到达
      expect(h.gate.getState()).toEqual({ kind: "idle" });
      expect(h.coord.getState().command).toBeNull();
      expect(h.drained).toEqual([[{ type: "message_start" }, { type: "message_update" }]]);
      expect(h.dur.lines.filter((l) => l.t === "settled")).toHaveLength(1);
    });

    it("等待期 success 回绑：superseded（超时未生效，gate 保持 run）", async () => {
      const h = makeHarness();
      await h.coord.submitTurn(intent("i-1"), 101);
      h.dur.holdAt = 3;
      h.clock.iso = t(120_000);
      const pending = h.coord.checkResponseTimeout();
      await untilHeld(h.dur);
      h.coord.onPiEvent({ type: "message_start" }, 1);
      expect(await h.coord.onRpcResponse(101, 1, true)).toMatchObject({ kind: "accepted" }); // 回绑在等待期完成
      expect(h.drained).toEqual([[{ type: "message_start" }]]);
      h.dur.releaseHold();
      expect(await pending).toMatchObject({ kind: "superseded" }); // 不用旧快照覆盖 run-open
      expect(h.audits).toContain("response-timeout-superseded-by-success commandId=101");
      const gs = h.gate.getState();
      expect(gs.kind).toBe("in-flight"); // run 不被超时打掉
      if (gs.kind === "in-flight") expect(gs.acceptedAt).not.toBeNull();
      expect(h.coord.getState().command).toMatchObject({ phase: "run-open" });
    });

    it("等待期重入：pending（不重复追加记录行）", async () => {
      const h = makeHarness();
      await h.coord.submitTurn(intent("i-1"), 101);
      h.dur.holdAt = 3;
      h.clock.iso = t(120_000);
      const pending = h.coord.checkResponseTimeout();
      await untilHeld(h.dur);
      expect(await h.coord.checkResponseTimeout()).toMatchObject({ kind: "pending" });
      expect(h.dur.calls).toBe(3); // 无第二次 append 尝试
      h.dur.releaseHold();
      expect(await pending).toMatchObject({ kind: "recorded" });
      expect(h.coord.getState().command).toMatchObject({ phase: "response-timed-out" });
    });
  });

  describe("S2-02 旧超时跨换代/新轮失效（不得覆盖新登记、不得关新 Gate）", () => {
    it("换代+新轮在飞：旧超时完成=invalidated，不覆盖 B；A 晚到 settled 丢弃", async () => {
      const h = makeHarness();
      await h.coord.submitTurn(intent("i-1", 1), 101);
      h.dur.holdAt = 3;
      h.clock.iso = t(120_000);
      const pendingA = h.coord.checkResponseTimeout();
      await untilHeld(h.dur);
      h.coord.onGenerationRetired(1); // 换代：opEpoch 失效旧操作
      h.gate.close("manual");
      expect(h.gate.reopen()).toBe(true);
      const launchB = await h.coord.submitTurn(intent("i-2", 2), 202);
      expect(launchB).toMatchObject({ kind: "launched", key: { intentId: "i-2", commandId: 202, generation: 2 } });
      await h.coord.onRpcResponse(202, 2, true); // B 回绑开 run
      h.dur.releaseHold();
      expect(await pendingA).toMatchObject({ kind: "invalidated" }); // 旧超时不改新状态
      expect(h.audits).toContain("response-timeout-invalidated commandId=101 appended=true");
      expect(h.coord.getState().command?.key).toMatchObject({ intentId: "i-2", commandId: 202 }); // B 不被覆盖
      expect(h.gate.getState()).toMatchObject({ kind: "in-flight", intentId: "i-2" }); // 新轮不被旧操作关掉
      expect(await h.coord.onSettledEvent({ generation: 1, commandId: 101 })).toMatchObject({
        kind: "discarded-retired-command",
      });
      expect(await h.coord.onSettledEvent({ generation: 2, commandId: 202 })).toMatchObject({ kind: "settled" }); // B 正常收口
    });

    it("换代+新轮在飞：旧超时 append 失败=invalidated，不关新轮 Gate", async () => {
      const h = makeHarness();
      await h.coord.submitTurn(intent("i-1", 1), 101);
      h.dur.holdAt = 3;
      h.clock.iso = t(120_000);
      const pendingA = h.coord.checkResponseTimeout();
      await untilHeld(h.dur);
      h.coord.onGenerationRetired(1);
      h.gate.close("manual");
      expect(h.gate.reopen()).toBe(true);
      await h.coord.submitTurn(intent("i-2", 2), 202);
      h.dur.rejectHold(); // 旧超时记录失败
      expect(await pendingA).toMatchObject({ kind: "invalidated" }); // 不得关新轮
      expect(h.audits).toContain("response-timeout-record-invalidated commandId=101");
      expect(h.gate.getState()).toMatchObject({ kind: "in-flight", intentId: "i-2" }); // 新轮存活
    });
  });

  describe("S2-03 结算失败缓冲保留+弃置恢复手续（abandonHeld）", () => {
    it("accepted-settle-failed：缓冲保留在登记上；reopen→abandonHeld→新轮可 submit", async () => {
      const h = makeHarness();
      await h.coord.submitTurn(intent("i-1"), 101);
      h.coord.onPiEvent({ i: 1 }, 1);
      h.coord.onPiEvent({ i: 2 }, 1);
      await h.coord.onSettledEvent({ generation: 1, commandId: 101 }); // settled 先到缓冲
      h.dur.failAt = 3; // 第 3 次 append=settled 行（success 回绑触发，写前拒绝）
      expect(await h.coord.onRpcResponse(101, 1, true)).toMatchObject({ kind: "accepted-settle-failed" });
      expect(h.coord.getState().command?.bufferedEvents).toHaveLength(2); // S2-03：失败不丢缓冲
      expect(h.drained).toEqual([]); // 未交付
      expect(h.gate.getState()).toEqual({ kind: "closed", reason: "durability-failure" });
      expect(h.gate.reopen()).toBe(true);
      expect(h.coord.abandonHeld("recover")).toEqual({ droppedEvents: 2, droppedSettled: true }); // 丢弃计数不静默
      expect(h.coord.getState().command).toBeNull();
      const next = await h.coord.submitTurn(intent("i-2"), 102); // 恢复手续后可开新轮
      expect(next).toMatchObject({ kind: "launched", key: { intentId: "i-2", commandId: 102 } });
    });

    it("写后拒绝（settled 行已落盘）：held 保留缓冲；abandonHeld 计数后新轮可 submit", async () => {
      const h = makeHarness();
      await h.coord.submitTurn(intent("i-1"), 101);
      h.coord.onPiEvent({ i: 1 }, 1);
      await h.coord.onSettledEvent({ generation: 1, commandId: 101 });
      h.dur.failAt = 3;
      h.dur.failMode = "after"; // settled 行写后拒绝：行已在盘
      expect(await h.coord.onRpcResponse(101, 1, true)).toMatchObject({ kind: "accepted-settle-failed" });
      expect(h.dur.lines.filter((l) => l.t === "settled")).toHaveLength(1); // 行已落
      expect(h.coord.getState().command?.bufferedEvents).toHaveLength(1); // 缓冲保留呈现
      expect(h.gate.getState()).toEqual({ kind: "closed", reason: "durability-failure" });
      h.gate.reopen();
      expect(h.coord.abandonHeld("recover-after-write")).toEqual({ droppedEvents: 1, droppedSettled: true });
      expect((await h.coord.submitTurn(intent("i-2"), 102)).kind).toBe("launched");
    });

    it("abandonHeld 拒绝弃置活轮（gate 在飞）与空登记", async () => {
      const h = makeHarness();
      expect(h.coord.abandonHeld("nothing")).toBeNull(); // 无登记
      await h.coord.submitTurn(intent("i-1"), 101);
      expect(h.coord.abandonHeld("live")).toBeNull(); // gate in-flight=活轮
      expect(h.coord.getState().command).not.toBeNull();
    });
  });

  describe("S2-B1 结算等待窗口：交付取登记上最新缓冲", () => {
    it("timed-out→settled 挂起窗口新增事件：一并交付（e0+e1 都在 drain）", async () => {
      const h = makeHarness();
      await h.coord.submitTurn(intent("i-1"), 101);
      h.clock.iso = t(120_000);
      expect(await h.coord.checkResponseTimeout()).toMatchObject({ kind: "recorded" }); // 超时记录完成→timed-out
      expect(h.coord.onPiEvent({ i: 0 }, 1)).toEqual({ kind: "buffered" }); // e0
      h.dur.holdAt = 4; // 第 4 次 append=settled 行挂起
      const p = h.coord.onSettledEvent({ generation: 1, commandId: 101 });
      await untilHeld(h.dur);
      expect(h.coord.onPiEvent({ i: 1 }, 1)).toEqual({ kind: "buffered" }); // 结算等待窗口新增 e1
      h.dur.releaseHold();
      expect(await p).toMatchObject({ kind: "settled" });
      expect(h.drained).toEqual([[{ i: 0 }, { i: 1 }]]); // B1：取最新缓冲，e1 不被旧数组吞
      expect(h.coord.getState().command).toBeNull();
    });

    it("bufferedSettled→超时分派第二次等待窗口新增事件：recorded-and-settled 一并交付", async () => {
      const h = makeHarness();
      await h.coord.submitTurn(intent("i-1"), 101);
      expect(h.coord.onPiEvent({ i: 0 }, 1)).toEqual({ kind: "buffered" });
      expect(await h.coord.onSettledEvent({ generation: 1, commandId: 101 })).toMatchObject({ kind: "buffered" });
      h.dur.holdAt = 4; // 仅挂第 4 次（settled 结算行）；第 3 次（response-timeout 记录）正常完成
      h.clock.iso = t(120_000);
      const p = h.coord.checkResponseTimeout();
      await untilHeld(h.dur); // 记录已完成，结算 append 挂起
      expect(h.coord.onPiEvent({ i: 1 }, 1)).toEqual({ kind: "buffered" }); // 结算等待窗口新增 e1
      h.dur.releaseHold();
      expect(await p).toMatchObject({ kind: "recorded-and-settled" });
      expect(h.drained).toEqual([[{ i: 0 }, { i: 1 }]]); // 第二次 await 前后新增事件不丢
      expect(h.coord.getState().command).toBeNull();
    });
  });

  describe("S2-B2 超时槽位所有权（退役释放；旧 finally 不清新槽）", () => {
    it("A 挂起→退役（槽位释放）→新轮 B 超时可自行发起；旧 A 完成=invalidated 不动 B", async () => {
      const h = makeHarness();
      await h.coord.submitTurn(intent("i-1", 1), 101);
      h.dur.holdAt = 3;
      h.clock.iso = t(120_000);
      const pendingA = h.coord.checkResponseTimeout();
      await untilHeld(h.dur);
      h.coord.onGenerationRetired(1); // 释放槽位+登记
      expect(h.audits).toContain(
        "generation-retired generation=1 clearedCommands=1 clearedEvents=0 droppedSettled=false releasedPendingTimeout=true",
      );
      h.gate.close("manual");
      expect(h.gate.reopen()).toBe(true);
      await h.coord.submitTurn(intent("i-2", 2), 202); // 调用 4/5
      h.clock.iso = t(240_000); // B 也超窗
      const outB = await h.coord.checkResponseTimeout(); // 调用 6=B 的 response-timeout
      expect(outB).toMatchObject({ kind: "recorded", key: { commandId: 202 } }); // B 自行发起（旧 pending 不占位）
      expect(h.dur.lines.filter((l) => l.t === "response-timeout").map((l) => l.commandId)).toEqual([101, 202]);
      h.dur.releaseHold(); // 旧 A 完成
      expect(await pendingA).toMatchObject({ kind: "invalidated", key: { commandId: 101 } });
      expect(h.coord.getState().command?.key).toMatchObject({ commandId: 202 }); // B 不动
      expect(h.gate.getState()).toMatchObject({ kind: "in-flight", intentId: "i-2" });
    });

    it("旧 A 完成不清 B 槽位：B 再查=pending(B)；不双追加", async () => {
      const h = makeHarness();
      await h.coord.submitTurn(intent("i-1", 1), 101);
      h.dur.holdAt = 3;
      h.clock.iso = t(120_000);
      const pendingA = h.coord.checkResponseTimeout();
      await untilHeld(h.dur);
      h.coord.onGenerationRetired(1);
      h.gate.close("manual");
      expect(h.gate.reopen()).toBe(true);
      await h.coord.submitTurn(intent("i-2", 2), 202); // 调用 4/5
      h.dur.holdAt2 = 6;
      h.clock.iso = t(240_000);
      const pendingB = h.coord.checkResponseTimeout(); // 调用 6=B 的 response-timeout 挂起
      await untilCalls(h.dur, 6);
      h.dur.releaseHold(0); // 旧 A 完成：finally 不得清 B 的槽位
      expect(await pendingA).toMatchObject({ kind: "invalidated" });
      expect(await h.coord.checkResponseTimeout()).toMatchObject({ kind: "pending", key: { commandId: 202 } }); // B 槽位健在
      expect(h.dur.calls).toBe(6); // 不双追加
      h.dur.releaseHold(0); // 现在首槽=B
      expect(await pendingB).toMatchObject({ kind: "recorded", key: { commandId: 202 } });
    });
  });

  describe("S2-B3 失败侧所有权（正常更替后旧 reject 不关后继轮）", () => {
    it("A 正常收口→B 在飞→旧 A 超时 reject=invalidated；B 正常收口", async () => {
      const h = makeHarness();
      await h.coord.submitTurn(intent("i-1", 1), 101);
      h.dur.holdAt = 3;
      h.clock.iso = t(120_000);
      const pendingA = h.coord.checkResponseTimeout();
      await untilHeld(h.dur);
      expect((await h.coord.onRpcResponse(101, 1, true)).kind).toBe("accepted"); // 等待期 success 回绑→run-open
      expect((await h.coord.onSettledEvent({ generation: 1, commandId: 101 })).kind).toBe("settled"); // 调用 4 完成→登记清
      const lb = await h.coord.submitTurn(intent("i-2", 1), 202); // 正常更替（无 retire；epoch 不变）
      expect(lb).toMatchObject({ kind: "launched" });
      h.dur.rejectHold(); // 旧 A 的记录 append 失败
      expect(await pendingA).toMatchObject({ kind: "invalidated", key: { commandId: 101 } }); // B3：不关后继轮
      expect(h.audits).toContain("response-timeout-record-invalidated commandId=101 key-mismatch");
      expect(h.gate.getState()).toMatchObject({ kind: "in-flight", intentId: "i-2" }); // B 存活
      expect((await h.coord.onRpcResponse(202, 1, true)).kind).toBe("accepted");
      expect((await h.coord.onSettledEvent({ generation: 1, commandId: 202 })).kind).toBe("settled"); // B 正常收口
    });
  });

  describe("S2-Y1 无关代次退役无副作用", () => {
    it("A(gen2) 结算挂起→retire(gen1)=no-op→结算正常完成", async () => {
      const h = makeHarness();
      await h.coord.submitTurn(intent("i-1", 2), 101);
      await h.coord.onRpcResponse(101, 2, true); // run-open
      h.dur.holdAt = 3; // settled 行挂起（submit 2 次+settle 第 3 次；无超时记录行）
      const p = h.coord.onSettledEvent({ generation: 2, commandId: 101 });
      await untilHeld(h.dur);
      expect(h.coord.onGenerationRetired(1)).toEqual({ clearedCommands: 0, clearedEvents: 0 }); // 无关代次=no-op
      expect(h.audits).toContain("generation-retired generation=1 clearedCommands=0 clearedEvents=0 no-op");
      h.dur.releaseHold();
      expect(await p).toMatchObject({ kind: "settled" }); // 不被无关退役取消
      expect(h.coord.getState().command).toBeNull();
      expect(h.drained).toEqual([]);
    });
  });

  describe("S2-Y4 drain 回调契约（抛错隔离+审计）", () => {
    it("drain 回调抛错：不中断结算，审计 drain-callback-failed", async () => {
      const h = makeHarness({ onBufferDrain: () => { throw new Error("sink-down"); } });
      await h.coord.submitTurn(intent("i-1"), 101);
      h.coord.onPiEvent({ i: 1 }, 1);
      await h.coord.onSettledEvent({ generation: 1, commandId: 101 });
      expect((await h.coord.onRpcResponse(101, 1, true)).kind).toBe("accepted-and-settled");
      expect(h.audits).toContain("drain-callback-failed events=1");
      expect(h.coord.getState().command).toBeNull(); // 结算照常完成（回调责任归宿主）
      expect(h.gate.getState().kind).toBe("idle");
    });
  });

  describe("S2-C1 正常收口=槽位释放边界（挂起超时不占位新轮）", () => {
    it("A 挂起超时→success+settled 正常收口→B 超时可自行发起；双挂起旧 A finally 不动 B 槽", async () => {
      const h = makeHarness();
      await h.coord.submitTurn(intent("i-1"), 101); // 调用 1/2
      h.dur.holdAt = 3; // A 的 response-timeout 记录挂起
      h.clock.iso = t(120_000);
      const pendingA = h.coord.checkResponseTimeout(); // 调用 3 挂起
      await untilHeld(h.dur);
      expect((await h.coord.onRpcResponse(101, 1, true)).kind).toBe("accepted"); // 等待期 success 回绑→run-open
      expect((await h.coord.onSettledEvent({ generation: 1, commandId: 101 })).kind).toBe("settled"); // 调用 4：正常收口（C1：同步释放槽位）
      const lb = await h.coord.submitTurn(intent("i-2"), 202); // 调用 5/6：无 retire 更替，登记位已空
      expect(lb).toMatchObject({ kind: "launched" });
      h.dur.holdAt2 = 7; // B 的 response-timeout 记录也挂起（双挂起窗口）
      h.clock.iso = t(240_000);
      const pendingB = h.coord.checkResponseTimeout(); // 调用 7：槽位已释放→B 自行发起（修复前=pending(A) 永久占位）
      await untilCalls(h.dur, 7);
      h.dur.releaseHold(0); // 旧 A 完成：then 侧 key-mismatch=invalidated；finally 不清 B 槽
      expect(await pendingA).toMatchObject({ kind: "invalidated", key: { commandId: 101 } });
      expect(h.audits).toContain("response-timeout-invalidated commandId=101 key-mismatch"); // 成功侧：记录已在盘，旧登记不拥有新轮
      expect(h.coord.getState().command?.key).toMatchObject({ commandId: 202 }); // B 不动
      h.dur.releaseHold(0); // 现在首槽=B
      expect(await pendingB).toMatchObject({ kind: "recorded", key: { commandId: 202 } });
      expect(h.coord.getState().command?.phase).toBe("response-timed-out");
      expect(h.dur.lines.filter((l) => l.t === "response-timeout").map((l) => l.commandId)).toEqual([101, 202]);
    });

    it("bufferedSettled 合并式结算→recorded-and-settled 也释放槽位；B 超时可自行发起", async () => {
      const h = makeHarness();
      await h.coord.submitTurn(intent("i-1"), 101);
      h.dur.holdAt = 3;
      h.clock.iso = t(120_000);
      const pendingA = h.coord.checkResponseTimeout(); // 调用 3 挂起
      await untilHeld(h.dur);
      h.coord.onPiEvent({ i: 0 }, 1); // 缓冲 e0
      h.coord.onSettledEvent({ generation: 1, commandId: 101 }); // awaiting→bufferedSettled（不结算）
      h.dur.releaseHold(0); // A 超时记录完成→合并式结算：settled 行=调用 4→recorded-and-settled
      expect(await pendingA).toMatchObject({ kind: "recorded-and-settled", key: { commandId: 101 } });
      expect(h.drained).toEqual([[{ i: 0 }]]);
      expect(h.coord.getState().command).toBeNull();
      await h.coord.submitTurn(intent("i-2"), 202); // 调用 5/6
      h.clock.iso = t(240_000);
      const outB = await h.coord.checkResponseTimeout(); // 调用 7：槽位已释放，B 自行发起
      expect(outB).toMatchObject({ kind: "recorded", key: { commandId: 202 } });
    });
  });

  describe("S2-C3 许可交接窗口（send 返回后登记前失效）", () => {
    it("sending 完成微任务窗口 close→invalidated/post-send：不登记不 launched", async () => {
      const h = makeHarness();
      h.dur.holdAt = 2; // sending 行挂起
      const p = h.coord.submitTurn(intent("i-1"), 101);
      await untilHeld(h.dur);
      h.dur.releaseHold();
      queueMicrotask(() => {
        h.gate.close("manual"); // 插在 send 解析与协调器续跑之间
      });
      expect(await p).toEqual({ kind: "invalidated", stage: "post-send" });
      expect(h.coord.getState().command).toBeNull(); // 未登记
      expect(h.gate.getState()).toEqual({ kind: "closed", reason: "manual" });
      expect(h.audits.some((l) => l.startsWith("launch-invalidated-post-send intentId=i-1 gate="))).toBe(true);
    });

    it("close+reopen 后 B 在飞：旧 A 续跑=invalidated 不覆盖 B 登记", async () => {
      const h = makeHarness();
      h.dur.holdAt = 2;
      const pA = h.coord.submitTurn(intent("i-1"), 101);
      await untilHeld(h.dur);
      h.dur.releaseHold();
      let pB: Promise<LaunchOutcome> | undefined;
      queueMicrotask(() => {
        h.gate.close("manual");
        h.gate.reopen();
        pB = h.coord.submitTurn(intent("i-2"), 202); // 抢先提交 B（调用 3/4）
      });
      expect(await pA).toEqual({ kind: "invalidated", stage: "post-send" }); // 旧许可不复用：Gate 已属 B
      const outB = await pB!;
      expect(outB).toMatchObject({ kind: "launched", key: { commandId: 202 } });
      expect(h.coord.getState().command?.key).toMatchObject({ intentId: "i-2", commandId: 202 }); // 只登记 B
      expect(h.gate.getState()).toMatchObject({ kind: "in-flight", intentId: "i-2" });
      expect(h.audits.some((l) => l.startsWith("launch-invalidated-post-send intentId=i-1 gate="))).toBe(true);
    });
  });
});
