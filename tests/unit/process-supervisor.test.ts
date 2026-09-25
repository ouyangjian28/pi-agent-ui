// 进程代次监管器测试（切片 3：进程代次与交接隔离；TECH §136/§169④/§4 语义权威）
// 反例集=s3 设计 12 条：正常序/首字节窗口失效（受控）/背压窗口换代零串扰/旧代次事件丢弃/
// stopping 期仍路由/串行化交接/宽限升级 SIGKILL/截止失败+晚到收口/意外退出/retire 前置/ spawn 失败回滚/重复 exit 幂等。
// 纯逻辑注入：FakeProcessHost（受控进程）+FakeSleep（受控宽限）+真协调器/网关+FakeDurability。
import { describe, expect, it } from "vitest";
import type { JournalLine, ProcessSpawnHandlers, SupervisorCoordinatorPort } from "@pi-agent-ui/protocol";
import { DispatchCoordinator, ProcessSupervisor, TurnGate } from "@pi-agent-ui/protocol";
import type { TurnIntentInput } from "@pi-agent-ui/protocol";

const T0 = "2026-09-25T00:00:00Z";

/** 受控耐久端口（与 dispatch-coordinator.test 同构）。 */
class FakeDurability {
  readonly lines: JournalLine[] = [];
  failAt = -1;
  failMode: "before" | "after" = "before";
  failError = new Error("fsync-eio");
  holdAt = -1;
  holdAt2 = -1;
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

/** 受控进程宿主：exit 必须由测试显式投递（退出确认=唯一死亡证据）。 */
interface FakeProc {
  readonly handle: { readonly id: string };
  readonly handlers: ProcessSpawnHandlers;
  readonly stopSignals: string[];
  readonly writes: string[];
  readonly writeResolvers: Array<() => void>;
}

class FakeProcessHost {
  readonly procs: FakeProc[] = [];
  spawnFail = false;
  holdWrites = false;

  spawn(args: readonly string[], handlers: ProcessSpawnHandlers): { readonly id: string } {
    if (this.spawnFail) throw new Error("spawn-enofile");
    void args;
    const handle = { id: `p${this.procs.length + 1}` };
    this.procs.push({ handle, handlers, stopSignals: [], writes: [], writeResolvers: [] });
    return handle;
  }

  async writeStdin(h: { readonly id: string }, text: string): Promise<void> {
    const p = this.proc(h);
    p.writes.push(text);
    if (this.holdWrites) await new Promise<void>((r) => p.writeResolvers.push(r));
  }

  stop(h: { readonly id: string }, signal: "SIGTERM" | "SIGKILL"): void {
    this.proc(h).stopSignals.push(signal);
  }

  proc(h: { readonly id: string }): FakeProc {
    const p = this.procs.find((q) => q.handle.id === h.id);
    if (!p) throw new Error(`unknown handle ${h.id}`);
    return p;
  }

  deliverEvent(p: FakeProc, ev: unknown): void {
    p.handlers.onEvent(ev);
  }

  deliverExit(p: FakeProc, code: number | null, signal: string | null): void {
    p.handlers.onExit(code, signal);
  }

  releaseWrites(p: FakeProc): void {
    for (const r of p.writeResolvers.splice(0)) r();
  }
}

/** 受控睡眠：sleep 挂起直到 wake()（一次醒掉当前全部挂起，串行用法够用）。 */
class FakeSleep {
  private pending: Array<() => void> = [];

  sleep(_ms: number): Promise<void> {
    void _ms;
    return new Promise<void>((resolve) => {
      this.pending.push(resolve);
    });
  }

  async wake(): Promise<void> {
    const ps = this.pending.splice(0);
    for (const p of ps) p();
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  }
}

const intent = (id: string): Omit<TurnIntentInput, "generation"> => ({
  intentId: id,
  sessionId: "s-1",
  leafId: `leaf-${id}`,
  matchKey: { textHash: "ab12cd34", attachmentIdentity: "", ordinal: 0 },
  payload: { kind: "prompt", rawText: "你好", attachments: [], sentAt: T0 },
});

interface Harness {
  sup: ProcessSupervisor;
  coord: DispatchCoordinator;
  gate: TurnGate;
  dur: FakeDurability;
  host: FakeProcessHost;
  sleep: FakeSleep;
  audits: string[];
  routed: Array<{ ev: unknown; generation: number }>;
}

function makeHarness(): Harness {
  const dur = new FakeDurability();
  const audits: string[] = [];
  const routed: Array<{ ev: unknown; generation: number }> = [];
  const drained: unknown[][] = [];
  const gate = new TurnGate({ durability: dur, now: () => T0, turnTimeoutMs: 30 * 60 * 1000 });
  const coord = new DispatchCoordinator({
    gate,
    durability: dur,
    now: () => T0,
    responseTimeoutMs: 60_000,
    maxBufferedEvents: 4,
    audit: (l) => audits.push(l),
    onBufferDrain: (evs) => drained.push([...evs]),
  });
  const host = new FakeProcessHost();
  const sleep = new FakeSleep();
  const sup = new ProcessSupervisor({
    host,
    coordinator: coord,
    gate,
    onProcessEvent: (ev, generation) => routed.push({ ev, generation }),
    now: () => T0,
    sleep: (ms) => sleep.sleep(ms),
    graceMs: 2_000,
    exitDeadlineMs: 5_000,
    audit: (l) => audits.push(l),
  });
  return { sup, coord, gate, dur, host, sleep, audits, routed };
}

const until = async (pred: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 200 && !pred(); i += 1) await Promise.resolve();
  if (!pred()) throw new Error(`timeout waiting: ${what}`);
};

describe("进程代次监管器（ProcessSupervisor，切片3）", () => {
  it("正常序两轮：spawn→submit→首字节写→事件路由带代次→收口→第二轮同进程；idle 时 submit/retire=no-process", async () => {
    const h = makeHarness();
    expect(await h.sup.submitTurn(intent("i-0"), 100, "x\n")).toEqual({ kind: "no-process" });
    expect(await h.sup.retireCurrent()).toEqual({ kind: "no-process" });
    expect(h.sup.spawnNext(["pi", "--mode", "json"])).toEqual({ kind: "spawned", generation: 1 });
    const a = await h.sup.submitTurn(intent("i-1"), 101, "hello\n");
    expect(a).toEqual({ kind: "launched", key: { intentId: "i-1", commandId: 101, generation: 1 } });
    expect(h.host.proc(h.host.procs[0]!.handle).writes).toEqual(["hello\n"]);
    expect((await h.coord.onRpcResponse(101, 1, true)).kind).toBe("accepted");
    h.host.deliverEvent(h.host.procs[0]!, { type: "message_start" });
    expect(h.routed).toEqual([{ ev: { type: "message_start" }, generation: 1 }]);
    expect((await h.coord.onSettledEvent({ generation: 1, commandId: 101 })).kind).toBe("settled");
    expect(h.gate.getState().kind).toBe("idle");
    const b = await h.sup.submitTurn(intent("i-2"), 102, "again\n");
    expect(b.kind).toBe("launched");
    expect(h.host.proc(h.host.procs[0]!.handle).writes).toEqual(["hello\n", "again\n"]);
    expect(h.audits.some((l) => l.includes("stdin-written") && l.includes("commandId=101"))).toBe(true);
    expect(h.audits.some((l) => l.includes("stdin-written") && l.includes("commandId=102"))).toBe(true);
    await h.coord.onRpcResponse(102, 1, true);
    await h.coord.onSettledEvent({ generation: 1, commandId: 102 });
  });

  it("首字节窗口失效（受控替身）：协调器返 launched 但进程已退役→不写 stdin+审计（防御深度）", async () => {
    const dur = new FakeDurability();
    const audits: string[] = [];
    const host = new FakeProcessHost();
    const sleep = new FakeSleep();
    const gate = new TurnGate({ durability: dur, now: () => T0, turnTimeoutMs: 30 * 60 * 1000 });
    const retiredGens: number[] = [];
    // 受控替身：submitTurn 挂起，等世界变化后再返 launched（制造 launched→首字节窗口）
    let resolveSubmit: ((r: { kind: "launched"; key: { intentId: string; commandId: number; generation: number } }) => void) | null = null;
    const stub: SupervisorCoordinatorPort = {
      submitTurn: () =>
        new Promise((resolve) => {
          resolveSubmit = resolve;
        }) as never,
      onGenerationRetired: (g) => {
        retiredGens.push(g);
        return { clearedCommands: 1, clearedEvents: 0 };
      },
      getState: () => ({
        command: { key: { intentId: "i-1", commandId: 101, generation: 1 } },
      }),
    };
    const sup = new ProcessSupervisor({
      host,
      coordinator: stub,
      gate,
      now: () => T0,
      sleep: (ms) => sleep.sleep(ms),
      audit: (l) => audits.push(l),
    });
    expect(sup.spawnNext([])).toEqual({ kind: "spawned", generation: 1 });
    const p = sup.submitTurn(intent("i-1"), 101, "hello\n");
    await until(() => resolveSubmit !== null, "submit held");
    host.deliverExit(host.procs[0]!, 1, "SIGHUP"); // 意外退出：代次退役→idle
    expect(sup.getState().phase).toBe("idle");
    resolveSubmit!({ kind: "launched", key: { intentId: "i-1", commandId: 101, generation: 1 } });
    expect(await p).toEqual({ kind: "invalidated", stage: "first-byte" });
    expect(host.proc(host.procs[0]!.handle).writes).toEqual([]); // 首字节未写
    expect(audits.some((l) => l.includes("stdin-send-invalidated"))).toBe(true);
    expect(retiredGens).toEqual([1]);
  });

  it("背压窗口换代零串扰：写挂起期间意外退出→换代→写续体只及旧 handle，新轮写新 handle", async () => {
    const h = makeHarness();
    h.host.holdWrites = true;
    expect(h.sup.spawnNext([]).kind).toBe("spawned");
    const pa = h.sup.submitTurn(intent("i-1"), 101, "a\n");
    await until(() => h.host.proc(h.host.procs[0]!.handle).writes.length === 1, "A write started");
    h.host.deliverExit(h.host.procs[0]!, 1, "SIGHUP"); // 写挂起中进程死：退役→idle
    expect(h.gate.getState()).toMatchObject({ kind: "closed", reason: "generation-retired" });
    h.gate.reopen(); // 屏障解除=宿主手续
    expect(h.sup.spawnNext([])).toEqual({ kind: "spawned", generation: 2 });
    const pb = h.sup.submitTurn(intent("i-2"), 102, "b\n");
    await until(() => h.host.proc(h.host.procs[1]!.handle).writes.length === 1, "B write started");
    h.host.releaseWrites(h.host.procs[0]!); // 旧写续体完成
    h.host.holdWrites = false;
    h.host.releaseWrites(h.host.procs[1]!); // 新写也放行
    expect((await pa).kind).toBe("launched");
    expect((await pb).kind).toBe("launched");
    expect(h.host.proc(h.host.procs[0]!.handle).writes).toEqual(["a\n"]); // 旧 handle 只有 A
    expect(h.host.proc(h.host.procs[1]!.handle).writes).toEqual(["b\n"]); // 新 handle 只有 B
    expect(h.audits.some((l) => l.includes("stdin-written-stale") && l.includes("commandId=101"))).toBe(true);
    expect(h.audits.some((l) => l.includes("stdin-written") && l.includes("commandId=102"))).toBe(true);
  });

  it("旧代次事件丢弃：退役代次 handle 的事件丢弃+审计；新代次正常路由", async () => {
    const h = makeHarness();
    h.sup.spawnNext([]);
    h.host.deliverExit(h.host.procs[0]!, 0, null);
    h.gate.reopen();
    h.sup.spawnNext([]);
    h.host.deliverEvent(h.host.procs[0]!, { type: "message_start" }); // 旧 handle 迟到事件
    h.host.deliverEvent(h.host.procs[1]!, { type: "message_update" });
    expect(h.routed).toEqual([{ ev: { type: "message_update" }, generation: 2 }]);
    expect(h.audits.some((l) => l.includes("process-event-dropped generation=1"))).toBe(true);
  });

  it("stopping 期仍路由：SIGTERM 宽限内晚到事件=旧轮最后事实，不丢；确认后丢弃", async () => {
    const h = makeHarness();
    h.sup.spawnNext([]);
    await h.sup.submitTurn(intent("i-1"), 101, "a\n");
    const pr = h.sup.retireCurrent();
    await until(() => h.host.proc(h.host.procs[0]!.handle).stopSignals.includes("SIGTERM"), "SIGTERM");
    h.host.deliverEvent(h.host.procs[0]!, { type: "settled-ish" }); // 宽限内晚到
    expect(h.routed).toEqual([{ ev: { type: "settled-ish" }, generation: 1 }]);
    h.host.deliverExit(h.host.procs[0]!, 0, null);
    expect(await pr).toEqual({ kind: "confirmed", exit: { code: 0, signal: null } });
    h.host.deliverEvent(h.host.procs[0]!, { type: "late" }); // 退役后
    expect(h.routed.length).toBe(1);
    expect(h.audits.some((l) => l.includes("process-event-dropped generation=1"))).toBe(true);
  });

  it("串行化交接：stopping 中 spawnNext 拒；退出确认→协调器清登记+gate 关→idle 后可 spawn 新代次", async () => {
    const h = makeHarness();
    h.sup.spawnNext([]);
    await h.sup.submitTurn(intent("i-1"), 101, "a\n"); // 登记在飞（awaiting-response）
    const pr = h.sup.retireCurrent();
    await until(() => h.host.proc(h.host.procs[0]!.handle).stopSignals.includes("SIGTERM"), "SIGTERM");
    expect(h.sup.spawnNext([])).toEqual({ kind: "rejected", reason: "not-idle" });
    h.host.deliverExit(h.host.procs[0]!, 0, null);
    expect(await pr).toEqual({ kind: "confirmed", exit: { code: 0, signal: null } });
    expect(h.gate.getState()).toEqual({ kind: "closed", reason: "generation-retired" });
    expect(h.coord.getState().command).toBeNull(); // 登记已清
    expect(h.sup.getState().phase).toBe("idle");
    expect(await h.sup.submitTurn(intent("i-9"), 109, "x\n")).toEqual({ kind: "no-process" });
    h.gate.reopen();
    expect(h.sup.spawnNext([])).toEqual({ kind: "spawned", generation: 2 });
    expect((await h.sup.submitTurn(intent("i-2"), 102, "b\n")).kind).toBe("launched");
    expect(h.host.proc(h.host.procs[1]!.handle).writes).toEqual(["b\n"]);
  });

  it("宽限升级 SIGKILL：SIGTERM 无响应→grace 醒→SIGKILL→exit 确认", async () => {
    const h = makeHarness();
    h.sup.spawnNext([]);
    const pr = h.sup.retireCurrent();
    await until(() => h.host.proc(h.host.procs[0]!.handle).stopSignals.includes("SIGTERM"), "SIGTERM");
    await h.sleep.wake(); // 宽限过，无 exit
    await until(() => h.host.proc(h.host.procs[0]!.handle).stopSignals.includes("SIGKILL"), "SIGKILL");
    h.host.deliverExit(h.host.procs[0]!, null, "SIGKILL");
    expect(await pr).toEqual({ kind: "confirmed", exit: { code: null, signal: "SIGKILL" } });
    expect(h.host.proc(h.host.procs[0]!.handle).stopSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("截止失败+晚到收口：deadline-exceeded 保持 stopping；晚到 exit 自动退役→idle→可 spawn", async () => {
    const h = makeHarness();
    h.sup.spawnNext([]);
    await h.sup.submitTurn(intent("i-1"), 101, "a\n");
    const pr = h.sup.retireCurrent();
    await until(() => h.host.proc(h.host.procs[0]!.handle).stopSignals.includes("SIGTERM"), "SIGTERM");
    await h.sleep.wake(); // 宽限过
    await until(() => h.host.proc(h.host.procs[0]!.handle).stopSignals.includes("SIGKILL"), "SIGKILL");
    await h.sleep.wake(); // 截止过
    expect(await pr).toEqual({ kind: "deadline-exceeded" });
    expect(h.sup.getState().phase).toBe("stopping");
    expect(h.sup.spawnNext([])).toEqual({ kind: "rejected", reason: "not-idle" });
    h.host.deliverExit(h.host.procs[0]!, null, "SIGKILL"); // 晚到收口
    expect(h.sup.getState().phase).toBe("idle");
    expect(h.audits.some((l) => l.includes("process-retired-late generation=1"))).toBe(true);
    expect(h.audits.some((l) => l.includes("process-retire-deadline-exceeded generation=1"))).toBe(true);
    h.gate.reopen();
    expect(h.sup.spawnNext([]).kind).toBe("spawned");
  });

  it("意外退出：running 中 exit→代次退役+gate 关+登记清→idle；reopen 后新轮可跑", async () => {
    const h = makeHarness();
    h.sup.spawnNext([]);
    await h.sup.submitTurn(intent("i-1"), 101, "a\n");
    h.host.deliverExit(h.host.procs[0]!, 1, "SIGKILL");
    expect(h.gate.getState()).toEqual({ kind: "closed", reason: "generation-retired" });
    expect(h.coord.getState().command).toBeNull();
    expect(h.sup.getState()).toEqual({ phase: "idle", generation: null, retired: false });
    expect(
      h.audits.some(
        (l) =>
          l.includes("generation-retired reason=unexpected-exit generation=1 clearedCommands=1") &&
          l.includes("gateClosed=true"),
      ),
    ).toBe(true);
    h.gate.reopen();
    h.sup.spawnNext([]);
    expect((await h.sup.submitTurn(intent("i-2"), 102, "b\n")).kind).toBe("launched");
  });

  it("retire 前置/重入：idle=no-process；交接中重入=stopping", async () => {
    const h = makeHarness();
    h.sup.spawnNext([]);
    const pr = h.sup.retireCurrent();
    await until(() => h.host.proc(h.host.procs[0]!.handle).stopSignals.includes("SIGTERM"), "SIGTERM");
    expect(await h.sup.retireCurrent()).toEqual({ kind: "stopping" });
    h.host.deliverExit(h.host.procs[0]!, 0, null);
    expect((await pr).kind).toBe("confirmed");
    expect(await h.sup.retireCurrent()).toEqual({ kind: "no-process" });
  });

  it("spawn 失败回滚：spawn 抛错→idle 保持可重试", () => {
    const h = makeHarness();
    h.host.spawnFail = true;
    expect(h.sup.spawnNext([]).kind).toBe("spawn-failed");
    expect(h.sup.getState()).toEqual({ phase: "idle", generation: null, retired: false });
    expect(h.audits.some((l) => l.includes("process-spawn-failed generation=1"))).toBe(true);
    h.host.spawnFail = false;
    expect(h.sup.spawnNext([])).toEqual({ kind: "spawned", generation: 2 });
  });

  it("重复 exit 幂等：第二次 exit 只审计，不重复退役（onGenerationRetired 恰一次）", async () => {
    const h = makeHarness();
    h.sup.spawnNext([]);
    await h.sup.submitTurn(intent("i-1"), 101, "a\n");
    h.host.deliverExit(h.host.procs[0]!, 0, null);
    h.host.deliverExit(h.host.procs[0]!, 0, null); // 重复
    expect(h.audits.filter((l) => l.includes("process-exit-duplicate generation=1")).length).toBe(1);
    expect(h.audits.filter((l) => l.includes("generation-retired reason=")).length).toBe(1);
    expect(h.dur.calls).toBeGreaterThan(0);
  });
});
