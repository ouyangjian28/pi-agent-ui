// W1/W1a/W1b 写权管理器测试行（TECH §6 终审修订：查看≠接管/默认转接/串行化交接/确认截止）
import { describe, expect, it } from "vitest";
import { WriterAuthority, type ProcessOps } from "@pi-agent-ui/protocol";

function fakeOps(sigLog: string[] = [], exitedSessions = new Set<string>()): ProcessOps {
  return {
    signal: (sid, sig) => sigLog.push(`${sid}:${sig}`),
    exited: (sid) => exitedSessions.has(sid),
  };
}

describe("W1 双 tab 写权代次（让位广播）", () => {
  it("A 接管后 B 接管：代次+1，A 旧代次提交被拒（stale-epoch）", () => {
    const auth = new WriterAuthority(fakeOps());
    const a = auth.requestWriter("s1", "connA", true); // A 接管（写者进程存活=转接）
    expect(a.kind).toBe("attached");
    expect(a.state.epoch).toBe(1);
    expect(a.state.holder).toBe("connA");

    // A 持有期提交 ok
    expect(auth.submit("s1", "connA", 1)).toEqual({ kind: "ok", epoch: 1 });

    // B 接管：代次 2，yield 广播给 A
    const b = auth.requestWriter("s1", "connB", true);
    expect(b.state.epoch).toBe(2);
    expect(b.state.holder).toBe("connB");
    const events = auth.yieldEvents();
    expect(events.some((e) => e.type === "yield" && e.holder === "connA" && e.toEpoch === 2)).toBe(true); // 让位事件广播

    // W1 断言：A 旧代次提交被拒
    const r = auth.submit("s1", "connA", 1);
    expect(r).toEqual({ kind: "rejected", reason: "stale-epoch", currentEpoch: 2 });
    // B 新代次提交 ok
    expect(auth.submit("s1", "connB", 2)).toEqual({ kind: "ok", epoch: 2 });
  });

  it("非持有者提交被拒（not-holder）", () => {
    const auth = new WriterAuthority(fakeOps());
    auth.requestWriter("s1", "connA", false);
    expect(auth.submit("s1", "connB", 1)).toEqual({ kind: "rejected", reason: "not-holder", currentEpoch: 1 });
  });
});

describe("W1a A 在飞+B 输入接管（默认转接现有进程，无双写者）", () => {
  it("写者进程存活：转接（代次+1 进程不动）——signal 未被调用=无 spawn/无停进程", () => {
    const sigLog: string[] = [];
    const auth = new WriterAuthority(fakeOps(sigLog));
    const r = auth.requestWriter("s1", "connB", true); // B 输入接管，A 的轮在飞（进程活着）
    expect(r.kind).toBe("attached"); // 默认接管=转接
    expect(r.state.epoch).toBe(1);
    expect(sigLog).toHaveLength(0); // 不 SIGTERM 不 SIGKILL——进程不动，无双写者
  });
});

describe("W1b SIGKILL 后仍未退出（确认截止→失败冻结→核验转正）", () => {
  it("全链：startHandoff→SIGTERM→宽限过→SIGKILL→截止到→frozen（不开新写者）→核验→complete", () => {
    const sigLog: string[] = [];
    const auth = new WriterAuthority(fakeOps(sigLog), 3000, 10_000);
    // 僵死场景：老写者不退出（exited 恒 false）
    const h = auth.startHandoff("s1");
    expect(h.kind).toBe("handoff-started");
    expect(h.state.phase).toBe("terminating");
    expect(sigLog).toEqual(["s1:SIGTERM"]);

    // 宽限到点仍存活→SIGKILL
    const k = auth.killOldWriter("s1");
    expect(k.phase).toBe("killed");
    expect(sigLog).toEqual(["s1:SIGTERM", "s1:SIGKILL"]);

    // 仍未退出→确认截止 10s 到→接管失败冻结（不开新写者）
    const f = auth.deadlineReached("s1");
    expect(f.phase).toBe("frozen");
    expect(f.busy).toBe(true);

    // 冻结期新接管被拒
    const r = auth.requestWriter("s1", "connC", true);
    expect(r.kind).toBe("rejected");
    expect(r.reason).toContain("frozen");

    // 后台核验通过（waitpid//proc 消失）→ 转可接管
    const v = auth.verifyRecovered("s1");
    expect(v.phase).toBe("complete");
    expect(v.busy).toBe(false);
    // 核验后新接管成功
    const r2 = auth.requestWriter("s1", "connC", false);
    expect(r2.kind).toBe("attached");
    expect(r2.state.holder).toBe("connC");
  });

  it("退出确认在截止前到达→complete 可 spawn（正常交接路径）", () => {
    const sigLog: string[] = [];
    const exited = new Set<string>();
    const auth = new WriterAuthority(fakeOps(sigLog, exited), 3000, 10_000);
    auth.startHandoff("s1");
    auth.killOldWriter("s1");
    exited.add("s1"); // SIGKILL 后退出确认到达（exited 由注入 ops 持有——本用例即断言该事实）
    const c = auth.confirmExit("s1");
    expect(c.phase).toBe("complete");
    expect(c.busy).toBe(false);
  });
});

describe("释放与冻结期命令门", () => {
  it("持有者断连释放后：无持有者提交被拒", () => {
    const auth = new WriterAuthority(fakeOps());
    auth.requestWriter("s1", "connA", false);
    auth.release("s1", "connA");
    expect(auth.submit("s1", "connA", 1)).toEqual({ kind: "rejected", reason: "not-holder", currentEpoch: 1 });
  });

  it("非持有者 release=无操作（不误清他人写权）", () => {
    const auth = new WriterAuthority(fakeOps());
    auth.requestWriter("s1", "connA", false);
    auth.release("s1", "connB"); // B 不是持有者
    const r = auth.submit("s1", "connA", 1);
    expect(r).toEqual({ kind: "ok", epoch: 1 }); // A 仍持有
  });

  it("frozen 期一切提交被拒（frozen）", () => {
    const sigLog: string[] = [];
    const auth = new WriterAuthority(fakeOps(sigLog), 3000, 10_000);
    auth.requestWriter("s1", "connA", false);
    auth.startHandoff("s1");
    auth.deadlineReached("s1");
    expect(auth.submit("s1", "connA", 1)).toEqual({ kind: "rejected", reason: "frozen", currentEpoch: 1 });
  });
});

describe("r8-01 交接期提交门（terminating/killed/complete 拒新提交）", () => {
  it("从真实持有状态进交接：逐阶段断言旧持有者新提交被拒；默认转接不影响既有轮（本模块不拦在飞轮）", () => {
    const sigLog: string[] = [];
    const auth = new WriterAuthority(fakeOps(sigLog), 3000, 10_000);
    auth.requestWriter("s1", "connA", true); // A 真实持有 epoch=1
    expect(auth.submit("s1", "connA", 1).kind).toBe("ok");

    // terminating：正在停旧写者 → 新提交门关闭
    auth.startHandoff("s1");
    expect(auth.submit("s1", "connA", 1)).toEqual({ kind: "rejected", reason: "handoff", currentEpoch: 1 });

    // killed：SIGKILL 已发仍拒
    auth.killOldWriter("s1");
    expect(auth.submit("s1", "connA", 1)).toEqual({ kind: "rejected", reason: "handoff", currentEpoch: 1 });

    // complete：退出确认到达，持有者清空 → 旧页面按 not-holder 拒（资格不自动延续）
    const c = auth.confirmExit("s1");
    expect(c.holder).toBeNull();
    expect(auth.submit("s1", "connA", 1)).toEqual({ kind: "rejected", reason: "not-holder", currentEpoch: 1 });

    // 新页面重新申请 → 附着成功，代次+1
    const n = auth.requestWriter("s1", "connB", false);
    expect(n.kind).toBe("attached");
    expect(n.state.epoch).toBe(2);
    expect(auth.submit("s1", "connB", 2)).toEqual({ kind: "ok", epoch: 2 });
  });

  it("W1b 冻结转正路径：verifyRecovered 后旧页面提交仍拒（holder 已清）", () => {
    const auth = new WriterAuthority(fakeOps(), 3000, 10_000);
    auth.requestWriter("s1", "connA", false);
    auth.startHandoff("s1");
    auth.deadlineReached("s1"); // frozen
    const v = auth.verifyRecovered("s1");
    expect(v.phase).toBe("complete");
    expect(v.holder).toBeNull();
    expect(auth.submit("s1", "connA", 1)).toEqual({ kind: "rejected", reason: "not-holder", currentEpoch: 1 });
  });

  it("默认转接（无交接）提交门不受影响：B 接管后 B 即刻可提交（W1a 进程不动路径）", () => {
    const sigLog: string[] = [];
    const auth = new WriterAuthority(fakeOps(sigLog));
    auth.requestWriter("s1", "connA", true);
    auth.requestWriter("s1", "connB", true); // 转接：phase 仍 idle
    expect(auth.submit("s1", "connB", 2)).toEqual({ kind: "ok", epoch: 2 });
    expect(sigLog).toHaveLength(0); // 无信号=无交接，门不应误关
  });
});
