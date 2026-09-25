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

  it("滚动清除（r8-02：会话活跃期+24h 双条件；活跃超 24h 不删，退出活跃期满 24h 才删）", () => {
    const d = new CommandDedup();
    d.admit("op-old-1", "a", T0);
    d.settle("op-old-1", { ok: 1 });
    d.admit("op-old-2", "b", T0);
    d.admit("op-new", "c", t(20)); // 20h 前
    expect(d.size()).toBe(3);

    // 会话 1h 前活跃：占位虽过 25h 仍不删（活跃期保护）
    expect(d.sweep(t(25), { sessionLastActiveAt: t(24) })).toBe(0);
    expect(d.get("op-old-1")).toBeDefined();
    // 清理前旧 op 不重新 admitted（仍在表内=unknown/cached）
    expect(d.admit("op-old-1", "a", T0)).toEqual({ kind: "cached", result: { ok: 1 } });

    // 未提供活跃时刻=保守不删（逼调用方显式表态）
    expect(d.sweep(t(25))).toBe(0);

    // 会话退出活跃期满 25h：T0 的两条删（占位与缓存行都清），20h 前的不动
    expect(d.sweep(t(25), { sessionLastActiveAt: T0 })).toBe(2);
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
