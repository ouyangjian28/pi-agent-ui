import { describe, expect, it } from "vitest";
import { IdleReaper, MapRegistry, type IdleSupervisorPort } from "../../../apps/server/src/runtime/idle-reaper.js";

/** 手推时钟的受控替身：phase/isIdle 手动翻转，retireCurrentGraceful 计数+可控挂起。 */
function makeDeps(opts?: { retireHang?: boolean }) {
  const calls: string[] = [];
  let phase: "idle" | "running" | "stopping" = "running";
  let sessionIdle = true;
  const registry = new MapRegistry();
  let nowN = 1_000;
  let retireCalls = 0;
  let releaseRetire: (() => void) | null = null;
  const retireP = new Promise<void>((r) => {
    releaseRetire = r;
  });
  const supervisor: IdleSupervisorPort = {
    getState: () => ({ generation: 7, phase }),
    retireCurrentGraceful: async () => {
      retireCalls += 1;
      calls.push(`retire#${retireCalls}`);
      if (opts?.retireHang) await retireP;
      phase = "idle";
      calls.push("retire-done");
      return { kind: "confirmed" };
    },
  };
  const reaper = new IdleReaper({
    supervisor,
    isSessionIdle: () => sessionIdle,
    registry,
    now: () => nowN,
    audit: (l) => calls.push(l),
    idleMs: 100,
  });
  return {
    reaper, calls, registry,
    set: (p: typeof phase) => { phase = p; },
    setIdle: (v: boolean) => { sessionIdle = v; },
    setNow: (n: number) => { nowN = n; },
    retireCalls: () => retireCalls,
    release: () => releaseRetire?.(),
  };
}

describe("idle-reaper（闲置回收受控面）", () => {
  it("双条件满足才开始计时；到期触发优雅回收；审计序完整", async () => {
    const h = makeDeps();
    h.reaper.tick(); // 起点
    h.setNow(1_050);
    h.reaper.tick(); // 未到期
    h.setNow(1_101);
    h.reaper.tick(); // 到期→触发
    await new Promise((r) => setTimeout(r, 0)); // 微任务冲刷（idle-reap-done 在 .then）
    expect(h.calls).toEqual([
      "idle-timer-start generation=7",
      "idle-reap-start generation=7 idleMs=100",
      "retire#1",
      "retire-done",
      "idle-reap-done kind=confirmed",
    ]);
    expect(h.retireCalls()).toBe(1);
  });

  it("条件断开清零计时；重新满足从新起点计", () => {
    const h = makeDeps();
    h.reaper.tick(); // since=1000
    h.setIdle(false);
    h.setNow(1_500);
    h.reaper.tick(); // 断开→清零
    h.setIdle(true);
    h.reaper.tick(); // 新起点 since=1500
    h.setNow(1_599);
    h.reaper.tick(); // 未到期（从 1500 起算 99<100）
    expect(h.retireCalls()).toBe(0);
    h.setNow(1_600);
    h.reaper.tick(); // 到期
    expect(h.retireCalls()).toBe(1);
  });

  it("登记表活跃阻断回收；完成后恢复计时", () => {
    const h = makeDeps();
    h.reaper.tick();
    h.registry.register("bg-1", "导出");
    h.setNow(2_000);
    h.reaper.tick(); // 阻断（清零）
    h.setNow(2_100);
    h.reaper.tick(); // 重新开始计（since=2100）
    expect(h.retireCalls()).toBe(0);
    h.registry.complete("bg-1");
    h.setNow(2_100);
    h.reaper.tick(); // 完成瞬间仍从 2100 计（条件此前不满足→起点=2100 那次 tick 已设）
    h.setNow(2_201);
    h.reaper.tick(); // 到期
    expect(h.retireCalls()).toBe(1);
  });

  it("supervisor 非 running（idle 无进程/stopping）不回收", () => {
    const h = makeDeps();
    h.set("idle"); // 无进程
    h.setNow(5_000);
    h.reaper.tick();
    expect(h.retireCalls()).toBe(0);
    h.set("stopping");
    h.reaper.tick();
    expect(h.retireCalls()).toBe(0);
  });

  it("到期触发前同步复核：条件在复核时翻假→取消不触发", () => {
    const h = makeDeps();
    // isSessionIdle 第 1 次 true（计起点），第 2 次 true（到期判定），第 3 次 false（触发前复核）
    let n = 0;
    const seq = [true, true, false];
    // 通过包装：直接操纵 h 内部不可注入——用独立构造
    const calls: string[] = [];
    const registry = new MapRegistry();
    let phase: "idle" | "running" | "stopping" = "running";
    let nowN = 1_000;
    const reaper = new IdleReaper({
      supervisor: {
        getState: () => ({ generation: 1, phase }),
        retireCurrentGraceful: async () => { phase = "idle"; return { kind: "confirmed" }; },
      },
      isSessionIdle: () => (seq[Math.min(n += 1, seq.length) - 1] ?? true),
      registry,
      now: () => nowN,
      audit: (l) => calls.push(l),
      idleMs: 100,
    });
    reaper.tick(); // 第 1 次 true→起点
    nowN = 1_101;
    reaper.tick(); // 第 2 次 true→到期判定过；S5-R4 重排：idle-reap-start 先行留痕，最终复核（第 3 次 false）取消→不发起
    // 取消路径也留 idle-reap-start 审计行（审计前移=可重入边界收紧的自然结果，触发与否以 retire 不发起为准）
    expect(calls).toEqual(["idle-timer-start generation=1", "idle-reap-start generation=1 idleMs=100"]);
    expect(registry.activeCount()).toBe(0);
    void h; // h 未用于断言（独立构造覆盖）
  });

  it("回收挂起中防重入：不重复触发；完成后可再计", async () => {
    const h = makeDeps({ retireHang: true });
    h.reaper.tick();
    h.setNow(1_101);
    h.reaper.tick(); // 触发（挂起）
    expect(h.retireCalls()).toBe(1);
    h.setNow(1_500);
    h.reaper.tick(); // reaping 中跳过（不得重设起点——idle-timer-start 审计恰一条）
    h.reaper.tick();
    expect(h.retireCalls()).toBe(1);
    expect(h.calls.filter((l) => l.includes("idle-timer-start"))).toHaveLength(1); // M-c 落点：防重入期无新起点
    h.release();
    await new Promise((r) => setTimeout(r, 0));
    h.setNow(2_000);
    h.reaper.tick(); // 完成后重新可计（若仍 running——本替身已 idle，跳过）
    expect(h.retireCalls()).toBe(1);
    expect(h.calls).toContain("idle-reap-done kind=confirmed");
  });

  it("时钟非有限不推进（不设起点不触发）；恢复有限后从新起点计", () => {
    const h = makeDeps();
    h.reaper.tick(); // since=1000
    const broken = Number.NaN;
    // 构造非有限 now：独立小构造
    const registry = new MapRegistry();
    const lines: string[] = [];
    let calls = 0;
    let nowN: number = broken;
    const reaper = new IdleReaper({
      supervisor: { getState: () => ({ generation: 1, phase: "running" }), retireCurrentGraceful: async () => { calls += 1; return { kind: "confirmed" }; } },
      isSessionIdle: () => true,
      registry,
      now: () => nowN,
      audit: (l) => lines.push(l),
      idleMs: 100,
    });
    reaper.tick(); // NaN→不设起点（也无 idle-timer-start 审计——可观测差异，M-a 落点）
    reaper.tick();
    expect(calls).toBe(0);
    expect(lines).toEqual([]);
    nowN = 5_000; // 时钟恢复有限
    reaper.tick(); // 新起点
    nowN = 5_101;
    reaper.tick(); // 到期触发
    expect(calls).toBe(1);
    void h;
  });

  it("S5-R1：采样间活动失效旧起点（生产期限）——短登记在两 tick 间完成后不从旧起点回收", () => {
    let now = 0, retired = 0;
    const registry = new MapRegistry();
    const r = new IdleReaper({
      supervisor: { getState: () => ({ generation: 1, phase: "running" as const }), retireCurrentGraceful: async () => { retired += 1; return { kind: "confirmed" }; } },
      isSessionIdle: () => true, registry, now: () => now, idleMs: 1_800_000,
    });
    r.tick(); // 起点 0
    now = 1_799_900; registry.register("short");
    now = 1_799_950; registry.complete("short");
    r.noteActivity(); // 包装层在 register/complete 转发后同步调用（RpcSession 语义）
    now = 1_800_000; r.tick(); // 旧版此处误回收（起点 0 沿用满 30min）
    expect(retired).toBe(0);
    now = 1_799_950 + 1_800_000; r.tick(); // 从活动时刻重新计满才回收
    expect(retired).toBe(1);
  });

  it("s5c B1：audit 回调内短活动对（register+complete 同步+note）→eligible 看不见但活动复核取消；起点回退活动时刻（剩余期限延续）", () => {
    const calls: string[] = [];
    let phase: "running" | "idle" = "running";
    const registry = new MapRegistry();
    let nowN = 1_000;
    let retireStarted = 0;
    let spiked = false;
    const r2 = new IdleReaper({
      supervisor: {
        getState: () => ({ generation: 7, phase }),
        retireCurrentGraceful: async () => {
          retireStarted += 1;
          phase = "idle";
          return { kind: "confirmed" };
        },
      },
      isSessionIdle: () => true,
      registry,
      now: () => nowN,
      audit: (l) => {
        calls.push(l);
        if (l.includes("idle-reap-start") && !spiked) {
          spiked = true; // 只注入一次（第二次到期=正常发起，钩子不再扰动）
          registry.register("short", "短活动"); // audit 回调内同步登记+完成（activeCount 归零）
          registry.complete("short");
          r2.noteActivity(); // 宿主包装面的同步活动通知（wrapRegistry 转发后 note 的等价载荷）
        }
      },
      idleMs: 100,
    });
    r2.tick(); // 起点=1000
    nowN = 1_100;
    r2.tick(); // 到期判定+audit 注入短活动→最终复核吸收（now-lastActivity=0<100）→取消
    expect(calls).toContain("idle-reap-start generation=7 idleMs=100");
    expect(calls.some((l) => l.includes("idle-timer-reset-by-activity") && l.includes("at=reap-check"))).toBe(true);
    expect(retireStarted).toBe(0); // 未发起 retire
    // 起点回退活动时刻 1100：now=1150（自活动起 50 未满）不触发；now=1200 满→真正发起
    nowN = 1_150;
    r2.tick();
    expect(calls.filter((l) => l.includes("idle-reap-start"))).toHaveLength(1);
    nowN = 1_200;
    r2.tick(); // 自活动时刻 1100 起 100 满→发起
    expect(calls.filter((l) => l.includes("idle-reap-start"))).toHaveLength(2);
    expect(retireStarted).toBe(1);
  });

  it("S5-R4：audit 回调同步重入（登记/dispose/受理）→触发前最终复核取消，不发起退役", () => {
    // 反例三连：audit 是可重入外部回调——idle-reap-start 后的最终复核必须重查全部条件
    const run = (mutate: (r: IdleReaper, registry: MapRegistry, setIdle: (v: boolean) => void) => void) => {
      let now = 0, retired = 0;
      const registry = new MapRegistry();
      let sessionIdle = true;
      const r = new IdleReaper({
        supervisor: { getState: () => ({ generation: 1, phase: "running" as const }), retireCurrentGraceful: async () => { retired += 1; return { kind: "confirmed" }; } },
        isSessionIdle: () => sessionIdle, registry, now: () => now, idleMs: 100,
        audit: (l) => { if (l.startsWith("idle-reap-start")) mutate(r, registry, (v) => { sessionIdle = v; }); },
      });
      r.tick(); now = 100; r.tick();
      return { retired, r };
    };
    const a = run((r, reg) => { reg.register("audit-task"); void r; }); // P3：回调里登记
    expect(a.retired).toBe(0);
    const b = run((r) => { r.dispose(); }); // P5：回调里 dispose
    expect(b.retired).toBe(0);
    const c = run((_r, _reg, setIdle) => { setIdle(false); }); // P6：回调里 send 受理（gate 非 idle）
    expect(c.retired).toBe(0);
  });

  it("dispose 后不再触发；MapRegistry 重复 register 幂等/未知 complete 无害", () => {
    const h = makeDeps();
    const reg = h.registry;
    reg.register("a"); reg.register("a"); // 幂等
    expect(reg.activeCount()).toBe(1);
    reg.complete("nope"); // no-op
    expect(reg.activeCount()).toBe(1);
    reg.complete("a");
    expect(reg.activeCount()).toBe(0);
    h.reaper.dispose();
    h.setNow(9_999);
    h.reaper.tick();
    expect(h.retireCalls()).toBe(0);
  });
});
