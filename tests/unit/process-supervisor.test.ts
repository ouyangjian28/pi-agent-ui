// 进程代次监管器测试（切片 3：进程代次与交接隔离；TECH §136/§169④/§4 语义权威）
// 反例集=s3 设计 12 条（正常序/首字节窗口失效（受控）/背压窗口换代零串扰/旧代次事件丢弃/
// stopping 期仍路由/串行化交接/宽限升级 SIGKILL/截止失败+晚到收口/意外退出/retire 前置/
// spawn 失败回滚/重复 exit 幂等）+s3 审读修复组（S3-01 双收口/S3-02 dispatching/settling 窗口/
// S3-03 Gate 许可/S3-04 预算截断+晚醒不重置/黄项：stderr 过滤/spawn 同步退出/审计隔离/写拒绝）。
// 纯逻辑注入：FakeProcessHost（受控进程）+FakeSleep（虚拟时钟：advance 推进+requests 记录预算）
// +真协调器/网关+FakeDurability。
import { describe, expect, it, vi } from "vitest";
import type { JournalLine, LaunchOutcome, ProcessSpawnHandlers, SupervisorCoordinatorPort, TrackedCommand } from "@pi-agent-ui/protocol";
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
  readonly writeWaiters: Array<{ resolve: () => void; reject: (e: unknown) => void }>;
}

class FakeProcessHost {
  readonly procs: FakeProc[] = [];
  spawnFail = false;
  holdWrites = false;
  spawnSyncExit: { code: number | null; signal: string | null } | null = null;

  spawn(args: readonly string[], handlers: ProcessSpawnHandlers): { readonly id: string } {
    if (this.spawnFail) throw new Error("spawn-enofile");
    void args;
    const handle = { id: `p${this.procs.length + 1}` };
    const p: FakeProc = { handle, handlers, stopSignals: [], writes: [], writeWaiters: [] };
    this.procs.push(p);
    if (this.spawnSyncExit) handlers.onExit(this.spawnSyncExit.code, this.spawnSyncExit.signal); // spawn 内同步退出
    return handle;
  }

  async writeStdin(h: { readonly id: string }, text: string): Promise<void> {
    const p = this.proc(h);
    p.writes.push(text);
    if (this.holdWrites) await new Promise<void>((resolve, reject) => p.writeWaiters.push({ resolve, reject }));
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

  deliverStderr(p: FakeProc, text: string): void {
    p.handlers.onStderr(text);
  }

  deliverExit(p: FakeProc, code: number | null, signal: string | null): void {
    p.handlers.onExit(code, signal);
  }

  releaseWrites(p: FakeProc): void {
    for (const w of p.writeWaiters.splice(0)) w.resolve();
  }

  rejectWrites(p: FakeProc, err: unknown): void {
    for (const w of p.writeWaiters.splice(0)) w.reject(err);
  }
}

/** 受控睡眠+虚拟单调时钟：advance(to) 推进时钟并唤醒到期 sleep；requests 记录每次请求量（预算断言用）。 */
class FakeSleep {
  readonly requests: number[] = [];
  private pending: Array<{ fireAt: number; resolve: () => void }> = [];
  private ms = 0;

  sleep(ms: number): Promise<void> {
    this.requests.push(ms);
    return new Promise<void>((resolve) => {
      this.pending.push({ fireAt: this.ms + ms, resolve });
    });
  }

  advance(to: number): void {
    this.ms = Math.max(this.ms, to);
    const due = this.pending.filter((p) => p.fireAt <= this.ms);
    for (const p of due) {
      this.pending.splice(this.pending.indexOf(p), 1);
      p.resolve();
    }
  }

  now(): number {
    return this.ms;
  }
}

const intent = (id: string): Omit<TurnIntentInput, "generation"> => ({
  intentId: id,
  sessionId: "s-1",
  leafId: `leaf-${id}`,
  matchKey: { textHash: "ab12cd34", attachmentIdentity: "", ordinal: 0 },
  payload: { kind: "prompt", rawText: "你好", attachments: [], sentAt: T0 },
});

interface HarnessOpts {
  graceMs?: number;
  exitDeadlineMs?: number;
  onStderr?: (text: string, generation: number) => void;
  auditThrows?: boolean;
  /** 包装协调器（制造登记后/首字节前的排队微任务窗口）。 */
  wrapCoord?: (c: DispatchCoordinator, gate: TurnGate) => SupervisorCoordinatorPort;
  /** 覆盖预算时钟（S3B-01：非单调/NaN 替身）。 */
  nowMs?: () => number;
  /** 用默认时钟（不注入 nowMs，S3B-01 默认分支）。 */
  useDefaultNowMs?: boolean;
}

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

function makeHarness(opts: HarnessOpts = {}): Harness {
  const dur = new FakeDurability();
  const audits: string[] = [];
  const routed: Array<{ ev: unknown; generation: number }> = [];
  const drained: unknown[][] = [];
  const auditFn = (l: string): void => {
    if (opts.auditThrows) throw new Error("audit-down");
    audits.push(l);
  };
  const gate = new TurnGate({ durability: dur, now: () => T0, turnTimeoutMs: 30 * 60 * 1000 });
  const coord = new DispatchCoordinator({
    gate,
    durability: dur,
    now: () => T0,
    responseTimeoutMs: 60_000,
    maxBufferedEvents: 4,
    audit: auditFn,
    onBufferDrain: (evs) => drained.push([...evs]),
  });
  const host = new FakeProcessHost();
  const sleep = new FakeSleep();
  const sup = new ProcessSupervisor({
    host,
    coordinator: opts.wrapCoord ? opts.wrapCoord(coord, gate) : coord,
    gate,
    onProcessEvent: (ev, generation) => routed.push({ ev, generation }),
    ...(opts.onStderr ? { onStderr: opts.onStderr } : {}),
    now: () => T0,
    sleep: (ms) => sleep.sleep(ms),
    ...(opts.nowMs ? { nowMs: opts.nowMs } : opts.useDefaultNowMs ? {} : { nowMs: () => sleep.now() }),
    graceMs: opts.graceMs ?? 2_000,
    exitDeadlineMs: opts.exitDeadlineMs ?? 5_000,
    audit: auditFn,
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
    let resolveSubmit: ((r: LaunchOutcome) => void) | null = null;
    const stub: SupervisorCoordinatorPort = {
      submitTurn: () =>
        new Promise<LaunchOutcome>((resolve) => {
          resolveSubmit = resolve;
        }),
      onGenerationRetired: (g) => {
        retiredGens.push(g);
        return { clearedCommands: 1, clearedEvents: 0 };
      },
      getState: () => ({
        command: { key: { intentId: "i-1", commandId: 101, generation: 1 } } as TrackedCommand,
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
    h.sleep.advance(2_000); // 宽限到点，无 exit
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
    h.sleep.advance(2_000); // 宽限到点
    await until(() => h.host.proc(h.host.procs[0]!.handle).stopSignals.includes("SIGKILL"), "SIGKILL");
    h.sleep.advance(5_000); // 总截止到点
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

  it("S3-01 双收口不覆盖新代次：宽限内 onExit 先收口→B 抢先接管→retire 续体幂等不清 B", async () => {
    const h = makeHarness();
    h.sup.spawnNext([]);
    await h.sup.submitTurn(intent("i-1"), 101, "a\n");
    const pr = h.sup.retireCurrent();
    await until(() => h.host.proc(h.host.procs[0]!.handle).stopSignals.includes("SIGTERM"), "SIGTERM");
    h.host.deliverExit(h.host.procs[0]!, 0, null); // 宽限内退出：onExit 立即收口→idle
    expect(h.sup.getState().phase).toBe("idle");
    expect(h.sup.spawnNext([])).toEqual({ kind: "spawned", generation: 2 }); // B 抢先接管
    expect(await pr).toEqual({ kind: "confirmed", exit: { code: 0, signal: null } }); // 旧续体醒
    expect(h.sup.getState()).toEqual({ phase: "running", generation: 2, retired: false });
    expect(h.audits.filter((l) => l.includes("generation-retired reason=")).length).toBe(1); // 恰一次退役
    h.host.deliverEvent(h.host.procs[1]!, { type: "ev-b" });
    expect(h.routed.at(-1)).toEqual({ ev: { type: "ev-b" }, generation: 2 }); // B 存活且可路由
  });

  it("S3-02a dispatching 窗口：硬序 fsync 挂起中意外退出→gate 关闭→旧 submit 续体 invalidated 不写；新代次可跑", async () => {
    const h = makeHarness();
    h.dur.holdAt = 1; // intent 行 fsync 挂起（gate=dispatching）
    h.sup.spawnNext([]);
    const pa = h.sup.submitTurn(intent("i-1"), 101, "a\n");
    await until(() => h.dur.isHeld(), "enqueue held");
    expect(h.gate.getState().kind).toBe("dispatching");
    h.host.deliverExit(h.host.procs[0]!, 1, "SIGKILL");
    expect(h.gate.getState()).toEqual({ kind: "closed", reason: "generation-retired" }); // 不再漏 dispatching
    h.dur.releaseHold(0);
    expect((await pa).kind).toBe("invalidated"); // 旧 submit 续体：不 send 不登记
    expect(h.host.proc(h.host.procs[0]!.handle).writes).toEqual([]);
    expect(h.coord.getState().command).toBeNull();
    h.gate.reopen();
    expect(h.sup.spawnNext([])).toEqual({ kind: "spawned", generation: 2 });
    expect((await h.sup.submitTurn(intent("i-2"), 102, "b\n")).kind).toBe("launched");
    expect(h.host.proc(h.host.procs[1]!.handle).writes).toEqual(["b\n"]);
  });

  it("S3-02b settling 窗口：终态行 fsync 挂起中意外退出→gate 关闭→旧 settled 续体失效 held；B 登记不受污染", async () => {
    const h = makeHarness();
    h.sup.spawnNext([]);
    expect((await h.sup.submitTurn(intent("i-1"), 101, "a\n")).kind).toBe("launched");
    await h.coord.onRpcResponse(101, 1, true); // in-flight accepted
    h.dur.holdAt = 3; // 第 3 次 append=settled 行
    const pset = h.coord.onSettledEvent({ generation: 1, commandId: 101 });
    await until(() => h.dur.isHeld(), "settled append held");
    expect(h.gate.getState().kind).toBe("settling");
    h.host.deliverExit(h.host.procs[0]!, 0, null);
    expect(h.gate.getState()).toEqual({ kind: "closed", reason: "generation-retired" }); // 不再漏 settling
    h.gate.reopen();
    expect(h.sup.spawnNext([])).toEqual({ kind: "spawned", generation: 2 });
    expect((await h.sup.submitTurn(intent("i-2"), 102, "b\n")).kind).toBe("launched");
    h.dur.releaseHold(0); // 旧 settled 续体醒来
    expect(await pset).toMatchObject({ kind: "invalidated", key: { intentId: "i-1", commandId: 101, generation: 1 } }); // 旧续体失效
    expect(h.coord.getState().command?.key.intentId).toBe("i-2"); // B 登记未被旧续体污染
    expect(h.gate.getState()).toMatchObject({ kind: "in-flight", intentId: "i-2" }); // 屏障仍在 B 轮
  });

  it("S3-03 Gate 许可复核：协调器登记后首字节前 gate 被关（排队微任务窗口）→invalidated 不写", async () => {
    const h = makeHarness({
      wrapCoord: (c, g) => ({
        submitTurn: (i, cid) =>
          c.submitTurn(i, cid).then((r) => {
            if (r.kind === "launched") g.close("manual"); // 同一 promise 链上先于监管器续体执行
            return r;
          }),
        onGenerationRetired: (gen) => c.onGenerationRetired(gen),
        getState: () => c.getState(),
        abandonHeld: (reason) => c.abandonHeld(reason),
      }),
    });
    h.sup.spawnNext([]);
    const pa = h.sup.submitTurn(intent("i-1"), 101, "a\n");
    expect(await pa).toEqual({ kind: "invalidated", stage: "first-byte" });
    expect(h.host.proc(h.host.procs[0]!.handle).writes).toEqual([]);
    expect(h.audits.some((l) => l.includes("stdin-send-invalidated") && l.includes("gate=closed"))).toBe(true);
  });

  it("S3-04a 预算截断：grace>deadline 时宽限被钳到总预算，第二段只探查 1ms（requests=[1000,1]，先断言再收口）", async () => {
    const h = makeHarness({ graceMs: 2_000, exitDeadlineMs: 1_000 });
    h.sup.spawnNext([]);
    const pr = h.sup.retireCurrent();
    await until(() => h.host.proc(h.host.procs[0]!.handle).stopSignals.includes("SIGTERM"), "SIGTERM");
    h.sleep.advance(1_000); // 截断后的宽限到点（绝对时刻）
    await until(() => h.sleep.requests.length === 2, "第二段预算已请求");
    expect(h.sleep.requests).toEqual([1_000, 1]); // 不睡满 grace，不重置预算
    h.sleep.advance(1_001); // 第二段探查 1ms 到点
    expect(await pr).toEqual({ kind: "deadline-exceeded" });
  });

  it("S3-04b 晚醒不重置预算：宽限期睡过头（超量推进）→第二段只睡剩余量 1ms（先断言再收口）", async () => {
    const h = makeHarness(); // grace 2000 / deadline 5000
    h.sup.spawnNext([]);
    const pr = h.sup.retireCurrent();
    await until(() => h.host.proc(h.host.procs[0]!.handle).stopSignals.includes("SIGTERM"), "SIGTERM");
    h.sleep.advance(5_000); // 计时器晚醒：一次跨过总预算终点（绝对时刻）
    await until(() => h.sleep.requests.length === 2, "第二段预算已请求");
    expect(h.sleep.requests).toEqual([2_000, 1]); // 第二段=max(5000-5000,1)=1，非全新 3000
    h.sleep.advance(5_001); // 第二段探查 1ms 到点
    expect(await pr).toEqual({ kind: "deadline-exceeded" });
  });

  it("S3B-01 默认时钟=单调 performance.now：不注入 nowMs 也能完整走一轮交接", async () => {
    const h = makeHarness({ useDefaultNowMs: true });
    h.sup.spawnNext([]);
    expect((await h.sup.submitTurn(intent("i-1"), 101, "a\n")).kind).toBe("launched");
    const pr = h.sup.retireCurrent();
    await until(() => h.host.proc(h.host.procs[0]!.handle).stopSignals.includes("SIGTERM"), "SIGTERM");
    h.host.deliverExit(h.host.procs[0]!, 0, null); // 宽限内退出，不等时钟
    expect(await pr).toEqual({ kind: "confirmed", exit: { code: 0, signal: null } });
    expect(h.sup.getState().phase).toBe("idle");
  });

  it("S3B-01 时钟回拨不扩大预算：nowMs 从 10000 跳回 -50000，第二段仍按钳位剩余=5000（非 65000）", async () => {
    const vals = [10_000, -50_000, -50_000];
    const h = makeHarness({ nowMs: () => vals.shift() ?? -50_000 }); // grace 2000 / deadline 5000
    h.sup.spawnNext([]);
    const pr = h.sup.retireCurrent(); // startMs=10000；graceEnd=12000；deadlineEnd=15000
    await until(() => h.host.proc(h.host.procs[0]!.handle).stopSignals.includes("SIGTERM"), "SIGTERM");
    h.sleep.advance(2_000); // 宽限到点（虚拟睡眠）
    await until(() => h.sleep.requests.length === 2, "第二段预算已请求");
    expect(h.sleep.requests).toEqual([2_000, 5_000]); // 回拨被钳到 startMs：15000-10000=5000
    h.sleep.advance(7_000); // 第二段自虚拟 2000 起算→7000 到点（总虚拟等待=2000+5000 不放大）
    expect((await pr).kind).toBe("deadline-exceeded");
  });

  it("S3B-01 非有限时钟按 0 对待：NaN 时钟不产生 NaN/Infinity 预算", async () => {
    const h = makeHarness({ nowMs: () => Number.NaN });
    h.sup.spawnNext([]);
    const pr = h.sup.retireCurrent();
    await until(() => h.host.proc(h.host.procs[0]!.handle).stopSignals.includes("SIGTERM"), "SIGTERM");
    h.sleep.advance(2_000);
    await until(() => h.sleep.requests.length === 2, "第二段预算已请求");
    expect(h.sleep.requests).toEqual([2_000, 5_000]); // 非有限→0→正常预算，非 NaN
    h.sleep.advance(7_000); // 2000+5000 到点
    expect((await pr).kind).toBe("deadline-exceeded");
  });

  it("S3B-02 A 宽限内收口后 B 立即退役不被 A 旧续体挡：retireInFlight 按代次隔离", async () => {
    const h = makeHarness();
    h.sup.spawnNext([]);
    const prA = h.sup.retireCurrent();
    await until(() => h.host.proc(h.host.procs[0]!.handle).stopSignals.includes("SIGTERM"), "A SIGTERM");
    h.host.deliverExit(h.host.procs[0]!, 0, null); // A 宽限内退出：onExit 收口→idle（A 续体待恢复）
    h.gate.reopen();
    expect(h.sup.spawnNext([])).toEqual({ kind: "spawned", generation: 2 }); // B 接管
    const prB = h.sup.retireCurrent(); // 旧全局布尔会被 A 未跑完的续体挡成 stopping
    await until(() => h.host.proc(h.host.procs[1]!.handle).stopSignals.includes("SIGTERM"), "B SIGTERM");
    expect((await prA).kind).toBe("confirmed"); // A 旧续体恢复：只收口自己，不碰 B
    h.host.deliverExit(h.host.procs[1]!, 0, null);
    expect((await prB).kind).toBe("confirmed");
    expect(h.sup.getState().phase).toBe("idle");
    expect(h.audits.filter((l) => l.includes("process-supervisor generation-retired")).length).toBe(2); // 两代各恰一次
  });

  it("S3B-02 A 旧 finally 不清 B 槽位：B 挂起期间 A 续体收尾，B/第三代次仍各自独立退役", async () => {
    const h = makeHarness();
    h.sup.spawnNext([]);
    const prA = h.sup.retireCurrent();
    await until(() => h.host.proc(h.host.procs[0]!.handle).stopSignals.includes("SIGTERM"), "A SIGTERM");
    h.host.deliverExit(h.host.procs[0]!, 0, null);
    h.gate.reopen();
    h.sup.spawnNext([]);
    const prB = h.sup.retireCurrent();
    await until(() => h.host.proc(h.host.procs[1]!.handle).stopSignals.includes("SIGTERM"), "B SIGTERM");
    await prA; // A 旧续体 finally 在 B 挂起期间执行
    h.host.deliverExit(h.host.procs[1]!, 0, null);
    expect((await prB).kind).toBe("confirmed");
    // S3C：B 槽位未被 A 旧 finally 误清→B 退出是正常 handover，非 late（窄变异：finally 清 current 槽→B 被误标 late）
    expect(h.audits.some((l) => l.includes("process-retired-late"))).toBe(false);
    h.gate.reopen();
    h.sup.spawnNext([]);
    const prC = h.sup.retireCurrent();
    await until(() => h.host.proc(h.host.procs[2]!.handle).stopSignals.includes("SIGTERM"), "C SIGTERM");
    h.host.deliverExit(h.host.procs[2]!, 0, null);
    expect((await prC).kind).toBe("confirmed"); // 按代次隔离后各代独立，无双写
  });

  it("S3C-01 默认时钟选用单调源：performance.now 被调用且 Date.now 未被读取", async () => {
    const pSpy = vi.spyOn(performance, "now").mockImplementation(() => 10_000); // 单调源固定 10000
    const dSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("Date.now 被读取：默认分支应选单调源");
    });
    try {
      const h = makeHarness({ useDefaultNowMs: true });
      h.sup.spawnNext([]);
      const pr = h.sup.retireCurrent(); // startMs=10000（performance）
      await until(() => h.host.proc(h.host.procs[0]!.handle).stopSignals.includes("SIGTERM"), "SIGTERM");
      h.sleep.advance(2_000); // 宽限到点（虚拟睡眠）
      await until(() => h.sleep.requests.length === 2, "第二段预算已请求");
      expect(h.sleep.requests).toEqual([2_000, 5_000]); // 单调源固定→剩余=全额预算
      expect(pSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
      h.sleep.advance(7_000);
      expect((await pr).kind).toBe("deadline-exceeded");
    } finally {
      pSpy.mockRestore();
      dSpy.mockRestore();
    }
  });

  it("stderr 按代次过滤：当前带 generation 转发；退役/非当前丢弃+审计", async () => {
    const stderr: Array<[string, number]> = [];
    const h = makeHarness({ onStderr: (t, g) => stderr.push([t, g]) });
    h.sup.spawnNext([]);
    h.host.deliverStderr(h.host.procs[0]!, "boom");
    h.host.deliverExit(h.host.procs[0]!, 0, null);
    h.gate.reopen();
    expect(h.sup.spawnNext([])).toEqual({ kind: "spawned", generation: 2 });
    h.host.deliverStderr(h.host.procs[0]!, "stale"); // 旧代次
    h.host.deliverStderr(h.host.procs[1]!, "ok");
    expect(stderr).toEqual([
      ["boom", 1],
      ["ok", 2],
    ]);
    expect(h.audits.some((l) => l.includes("process-stderr-dropped generation=1"))).toBe(true);
  });

  it("spawn 同步退出：onExit 在 spawn 内冒出→spawn-exited 结果+已收口 idle+恰一次退役，可重试", () => {
    const h = makeHarness();
    h.host.spawnSyncExit = { code: 0, signal: null };
    expect(h.sup.spawnNext([])).toEqual({ kind: "spawn-exited", generation: 1, exit: { code: 0, signal: null } });
    expect(h.sup.getState()).toEqual({ phase: "idle", generation: null, retired: false });
    expect(h.audits.some((l) => l.includes("process-spawn-exited-sync generation=1"))).toBe(true);
    expect(h.audits.filter((l) => l.includes("generation-retired reason=")).length).toBe(1);
    h.host.spawnSyncExit = null;
    expect(h.sup.spawnNext([])).toEqual({ kind: "spawned", generation: 2 });
  });

  it("审计钩子抛错被隔离：机制不受影响（submit/retire 照常完成）", async () => {
    const h = makeHarness({ auditThrows: true });
    h.sup.spawnNext([]);
    expect((await h.sup.submitTurn(intent("i-1"), 101, "a\n")).kind).toBe("launched"); // 含多条审计
    const pr = h.sup.retireCurrent();
    await until(() => h.host.proc(h.host.procs[0]!.handle).stopSignals.includes("SIGTERM"), "SIGTERM");
    h.host.deliverExit(h.host.procs[0]!, 0, null);
    expect(await pr).toEqual({ kind: "confirmed", exit: { code: 0, signal: null } });
    expect(h.sup.getState().phase).toBe("idle");
  });

  it("写拒绝透传且不毁监管器：EPIPE→submitTurn 拒绝→换代→新轮正常", async () => {
    const h = makeHarness();
    h.host.holdWrites = true;
    h.sup.spawnNext([]);
    const pa = h.sup.submitTurn(intent("i-1"), 101, "a\n");
    await until(() => h.host.proc(h.host.procs[0]!.handle).writes.length === 1, "A write started");
    h.host.rejectWrites(h.host.procs[0]!, new Error("EPIPE"));
    await expect(pa).rejects.toThrow("EPIPE");
    const pr = h.sup.retireCurrent();
    await until(() => h.host.proc(h.host.procs[0]!.handle).stopSignals.includes("SIGTERM"), "SIGTERM");
    h.host.deliverExit(h.host.procs[0]!, 0, null);
    expect((await pr).kind).toBe("confirmed");
    h.gate.reopen();
    h.host.holdWrites = false;
    expect(h.sup.spawnNext([])).toEqual({ kind: "spawned", generation: 2 });
    expect((await h.sup.submitTurn(intent("i-2"), 102, "b\n")).kind).toBe("launched");
  });
});
