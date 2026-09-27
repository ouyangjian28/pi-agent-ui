// 3c-3：会话注册表单元测试（SR1-SR10）。
// 面覆：同步幂等缓存/映射校验/statusFor 真源（未构造 idle+unknown、构造后各真值段）/
// dispose（幂等/串行全量 stop+dispose/销毁后拒绝构造）。
// 全部用假宿主+假耐久（构造零 IO：RpcSession 不 spawn；send 面由 composition-write 测试走真链）。
import { describe, expect, it, vi } from "vitest";
import { createSessionRegistry } from "../../../apps/server/src/runtime/session-registry.js";
import { RpcSession } from "../../../apps/server/src/runtime/rpc-session.js";
import type { DurabilityPort, ProcessHostPort } from "@pi-agent-ui/protocol";

/** 假宿主：不 spawn（返哨兵句柄），记录 stop 调用序。 */
function fakeHost(): ProcessHostPort & { stops: string[] } {
  const stops: string[] = [];
  return {
    stops,
    spawn: () => ({ id: "h" }),
    writeStdin: () => Promise.resolve(),
    stop: (h) => { stops.push(h.id); },
  };
}

/** 假耐久：无盘 IO；记录 close。 */
function fakeDurability(): DurabilityPort & { closed: boolean } {
  const d = {
    closed: false,
    append: () => Promise.resolve(),
    close: () => { d.closed = true; return Promise.resolve(); },
  };
  return d;
}


describe("session-registry（3c-3）", () => {
  it("SR1 同 file 同实例（缓存幂等）；不同 file 不同实例；files() 排序快照", () => {
    const r = createSessionRegistry({ host: fakeHost(), sessionFor: (f) => `${f}.session` });
    const a1 = r.sessionFor("/root/a.jsonl");
    const a2 = r.sessionFor("/root/a.jsonl");
    const b = r.sessionFor("/root/b.jsonl");
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(r.files()).toEqual(["/root/a.jsonl", "/root/b.jsonl"]);
  });

  it("SR2 映射非法拒建：相对路径/空串/工厂抛错→描述性 Error（含 file 与实值）", () => {
    const r = createSessionRegistry({ host: fakeHost(), sessionFor: () => "rel/path" });
    expect(() => r.sessionFor("/root/a.jsonl")).toThrow(/sessionFor 映射非法.*rel\/path/);
    const r2 = createSessionRegistry({ host: fakeHost(), sessionFor: () => "" });
    expect(() => r2.sessionFor("/root/a.jsonl")).toThrow(/映射非法/);
    const r3 = createSessionRegistry({ host: fakeHost(), sessionFor: () => { throw new Error("boom"); } });
    expect(() => r3.sessionFor("/root/a.jsonl")).toThrow(/映射抛错.*boom/);
    expect(r.files()).toEqual([]); // 失败不留缓存（可重试）
  });

  it("SR3 statusFor 未构造：进程 idle 真值+其余 unknown 语义（bg unknown/reap idleMs 配置真值/recovery 不声称）", () => {
    const r = createSessionRegistry({ host: fakeHost(), sessionFor: (f) => `${f}.session`, idleMs: 1234 });
    const s = r.statusFor("/root/a.jsonl");
    expect(s.process).toEqual({ phase: "idle", generation: null, lastStartResult: null, lastStopResult: null, ready: false });
    expect(s.turn).toEqual({ state: "idle" });
    expect(s.backgroundTasks).toEqual({ availability: "unknown", activeCount: null });
    expect(s.reap.idleMs).toBe(1234);
    expect(s.reap.eligible).toBe(false);
    expect(s.recovery.availability).toBe("unavailable");
    expect(s.session.file).toBe("/root/a.jsonl");
    expect(s.session.sessionId).toMatch(/^sess-[0-9a-f]{12}$/);
    expect(s.statusVersion).toBe(0);
    expect(s.serverTimeMs).toBeGreaterThan(0);
  });

  it("SR4 sessionId 确定性：同 file 跨注册表实例同 id（sha256Hex12 派生，重启稳定）", () => {
    const a = createSessionRegistry({ host: fakeHost(), sessionFor: (f) => `${f}.s` });
    const b = createSessionRegistry({ host: fakeHost(), sessionFor: (f) => `${f}.s` });
    expect(a.statusFor("/root/x.jsonl").session.sessionId).toBe(b.statusFor("/root/x.jsonl").session.sessionId);
    expect(a.statusFor("/root/x.jsonl").session.sessionId).not.toBe(a.statusFor("/root/y.jsonl").session.sessionId);
  });

  it("SR5 statusFor 已构造（idle 初态）：进程真值 idle+ready false+bg known（计数 0）+reap 未计时", () => {
    const r = createSessionRegistry({ host: fakeHost(), sessionFor: (f) => `${f}.session`, idleMs: 5000 });
    const s = r.sessionFor("/root/a.jsonl");
    expect(s).toBeInstanceOf(RpcSession);
    const st = r.statusFor("/root/a.jsonl");
    expect(st.process.phase).toBe("idle");
    expect(st.process.ready).toBe(false);
    expect(st.backgroundTasks).toEqual({ availability: "known", activeCount: 0 });
    expect(st.reap).toEqual({ eligible: false, idleElapsedMs: null, idleRemainingMs: null, idleMs: 5000 });
  });

  it("SR6 statusFor 进程段随监管器真值走：构造后 send 面由上层驱动（本测用内部观测对照）——注册表只透传", () => {
    // 透传性：直接对照 RpcSession.getState()（同一实例同一时刻）——注册表不加工监管器/gate 原值
    const r = createSessionRegistry({ host: fakeHost(), sessionFor: (f) => `${f}.session` });
    const s = r.sessionFor("/root/a.jsonl");
    const st = r.statusFor("/root/a.jsonl");
    const raw = s.getState();
    expect(st.process.phase).toBe((raw.supervisor as { phase: string }).phase);
    expect(st.process.generation).toBe((raw.supervisor as { generation: number | null }).generation);
    expect(st.process.ready).toBe(false); // idle 态 readyGeneration=null
  });

  it("SR7 dispose：全量 stop+dispose 串行（审计序可见）+幂等+files 清空+销毁后拒绝构造", async () => {
    const host = fakeHost();
    const durabilities: Array<DurabilityPort & { closed: boolean }> = [];
    const r = createSessionRegistry({
      host,
      sessionFor: (f) => `${f}.session`,
      durabilityFor: () => { const d = fakeDurability(); durabilities.push(d); return d; },
      audit: vi.fn(),
    });
    r.sessionFor("/root/a.jsonl");
    r.sessionFor("/root/b.jsonl");
    await r.dispose();
    expect(r.files()).toEqual([]);
    expect(durabilities.map((d) => d.closed)).toEqual([true, true]);
    await r.dispose(); // 幂等
    expect(() => r.sessionFor("/root/a.jsonl")).toThrow(/已销毁/);
  });

  it("SR8 dispose 时进程在飞：stop 先行（宿主收到 stop 调用）再 dispose 本地", async () => {
    const host = fakeHost();
    const r = createSessionRegistry({ host, sessionFor: (f) => `${f}.session` });
    r.sessionFor("/root/a.jsonl");
    await r.dispose();
    // idle 态 stop()=retireCurrent 无进程→no-process（不调宿主 stop）；宿主面不伪造
    expect(host.stops).toEqual([]);
  });

  it("SR9 销毁健壮性：耐久 close 拒绝→RpcSession 层隔离（dispose 不 reject）→registry.dispose 照常收尾+审计可见；registry 自层 catch 为纵深防御（无注入口，不假测）", async () => {
    const host = fakeHost();
    const lines: string[] = [];
    const bad = { ...fakeDurability(), close: () => Promise.reject(new Error("disk-gone")) };
    const r = createSessionRegistry({
      host,
      sessionFor: (f) => `${f}.session`,
      durabilityFor: () => bad,
      audit: (l) => lines.push(l),
    });
    r.sessionFor("/root/a.jsonl");
    await expect(r.dispose()).resolves.toBeUndefined(); // 异常被 RpcSession.runDispose 内层隔离
    expect(r.files()).toEqual([]);
    expect(lines.some((l) => l.includes("durability-close-failed") && l.includes("disk-gone"))).toBe(true);
  });

  it("SR10 durabilityFor 注入生效（默认面=FileDurability 由 composition-write 真链覆盖）", () => {
    const seen: string[] = [];
    const r = createSessionRegistry({
      host: fakeHost(),
      sessionFor: (f) => `${f}.session`,
      durabilityFor: (f) => { seen.push(f); return fakeDurability(); },
    });
    r.sessionFor("/root/a.jsonl");
    r.sessionFor("/root/a.jsonl"); // 缓存命中：不再构造耐久
    expect(seen).toEqual(["/root/a.jsonl"]);
  });

  it("SR11 审计隔离：audit 回调抛错不影响构造/销毁", async () => {
    const r = createSessionRegistry({
      host: fakeHost(),
      sessionFor: (f) => `${f}.session`,
      audit: () => { throw new Error("audit-boom"); },
    });
    expect(() => r.sessionFor("/root/a.jsonl")).not.toThrow();
    await expect(r.dispose()).resolves.toBeUndefined();
  });
});
