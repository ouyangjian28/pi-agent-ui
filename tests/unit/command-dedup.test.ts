// 通用命令去重表测试（TECH §3 ②契约：占位/缓存/不同参拒/崩溃闭环/24h 清除）
import { describe, expect, it } from "vitest";
import { CommandDedup } from "@pi-agent-ui/protocol";

const T0 = "2026-09-24T00:00:00Z";
const t = (h: number) => new Date(Date.parse(T0) + h * 3600 * 1000).toISOString();

describe("通用命令去重表（opId 幂等）", () => {
  it("首次受理=admitted 占位；应答 settle 后同键同参=cached 不重发", () => {
    const d = new CommandDedup();
    expect(d.admit("op-1", "argsA", T0)).toEqual({ kind: "admitted" });
    d.settle("op-1", { ok: true, payload: "cleared" });
    const r = d.admit("op-1", "argsA", T0); // 重试（应答丢失场景）
    expect(r).toEqual({ kind: "cached", result: { ok: true, payload: "cleared" } });
  });

  it("同键不同参=拒绝（非幂等重放，禁盲执行）", () => {
    const d = new CommandDedup();
    d.admit("op-1", "argsA", T0);
    expect(d.admit("op-1", "argsB", T0)).toEqual({ kind: "rejected-different-args" });
  });

  it("崩溃闭环：占位无结果（发送后崩溃）→恢复重放→admit=unknown-effect 不重发不受理", () => {
    const d = new CommandDedup();
    d.admit("op-1", "argsA", T0); // 占位
    // 崩溃：无 settle。重启后从耐久载体重放占位行
    const d2 = new CommandDedup();
    d2.replay([{ opId: "op-1", argsHash: "argsA", placedAt: T0, result: null }]);
    const r = d2.admit("op-1", "argsA", T0); // 用户/系统重试旧 opId
    expect(r).toEqual({ kind: "unknown-effect" }); // 不重发（呈现 unknown），不当作新请求
    // 新请求用新 opId=正常受理
    expect(d2.admit("op-2", "argsA", T0)).toEqual({ kind: "admitted" });
  });

  it("重启重放完整记录（占位+结果）→cached", () => {
    const d = new CommandDedup();
    d.replay([{ opId: "op-1", argsHash: "argsA", placedAt: T0, result: { ok: true } }]);
    expect(d.admit("op-1", "argsA", T0)).toEqual({ kind: "cached", result: { ok: true } });
  });

  it("滚动清除（r8-02+r8b：生命周期判据分离——最后消息时刻≠退出时刻；活跃不删/未知不删/退出满保留窗才删）", () => {
    const d = new CommandDedup();
    d.admit("op-old-1", "a", T0);
    d.settle("op-old-1", { ok: 1 });
    d.admit("op-old-2", "b", T0); // 占位无结果（unknown-effect 行）
    d.admit("op-new", "c", t(20)); // 20h 前
    expect(d.size()).toBe(3);

    // ①会话仍活跃：即使占位已过 25h 一律不删
    expect(d.sweep(t(25), { active: true, inactiveSince: T0 })).toBe(0); // r8c：携陈旧退出时刻仍不删=锁 active 优先级（非缺判据兜底）
    expect(d.size()).toBe(3);

    // ②生命周期未知（缺判据）=保守不删
    expect(d.sweep(t(25))).toBe(0);
    expect(d.sweep(t(25), { inactiveSince: "not-a-date" })).toBe(0); // 判据坏=不删

    // ③r8b 反例：最后消息 T0、退出时刻 T24，T25 sweep（退出仅 1h）→保留（旧接口会误删）
    expect(d.sweep(t(25), { inactiveSince: t(24) })).toBe(0);
    expect(d.get("op-old-1")).toBeDefined();

    // ④保留期内：缓存行=cached 不重发；占位行=unknown-effect 不重发不受理
    expect(d.admit("op-old-1", "a", t(25))).toEqual({ kind: "cached", result: { ok: 1 } });
    expect(d.admit("op-old-2", "b", t(25))).toEqual({ kind: "unknown-effect" });

    // ⑤退出满保留窗（T0 退出、T25 清）+占位过窗：T0 的两条删，20h 前的不动
    expect(d.sweep(t(25), { inactiveSince: T0 })).toBe(2);
    expect(d.get("op-old-1")).toBeUndefined();
    expect(d.get("op-old-2")).toBeUndefined();
    expect(d.get("op-new")).toBeDefined();
    // 清理后重用旧 opId=新占位（保留期已过，视为新意图）
    expect(d.admit("op-old-2", "b", t(25))).toEqual({ kind: "admitted" });
  });

  it("无占位的 settle=无操作（占位必须先行）", () => {
    const d = new CommandDedup();
    d.settle("ghost", { ok: true }); // 无占位
    expect(d.get("ghost")).toBeUndefined();
    expect(d.admit("ghost", "a", T0)).toEqual({ kind: "admitted" }); // 正常受理（无幽灵记录）
  });
});
