// 3c-3：会话注册表单元测试（SR1-SR14）。
// 面覆：同步幂等缓存/映射校验/statusFor 真源（未构造 idle+unknown、构造后各真值段）/
// dispose（幂等/串行全量 stop+dispose/销毁后拒绝构造/20轮F3 并发共享/20b B1 同步重入）。
// 全部用假宿主+假耐久（构造零 IO：RpcSession 不 spawn；send 面由 composition-write 测试走真链）。
// SR7 审计面=vi.fn() 记录，仅断审计被调用（调用序断言在 SR8/CW 系，不在本用例）。
import { describe, expect, it, vi } from "vitest";
import { createSessionRegistry } from "../../../apps/server/src/runtime/session-registry.js";
import { RpcSession } from "../../../apps/server/src/runtime/rpc-session.js";
import type { DurabilityPort, ProcessHostPort } from "@pi-agent-ui/protocol";

/** 假宿主：不 spawn（返哨兵句柄），记录 stop 调用序。 */
function fakeHost(): ProcessHostPort & { stops: string[]; handlers: { onExit?: (code: number | null, signal: string | null) => void } | null } {
  const stops: string[] = [];
  const h: ProcessHostPort & { stops: string[]; handlers: { onExit?: (code: number | null, signal: string | null) => void } | null } = {
    stops,
    handlers: null,
    spawn: () => ({ id: "h" }),
    writeStdin: () => Promise.resolve(),
    stop: (hd) => { stops.push(hd.id); h.handlers?.onExit?.(null, "SIGTERM"); }, // 信号停→补发退出事件（retire 等待口径）
  };
  return h;
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

  it("SR7 dispose：全量 stop+dispose 串行（两耐久均收）+幂等+files 清空+销毁后拒绝构造（审计序断言不在本用例——头注）", async () => {
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

  it("SR8 dispose 时进程在飞（start 等待窗）：pending send 未决即 dispose→stop 先行真调宿主+优雅收尾完成", async () => {
    const host = fakeHost();
    host.spawn = (args, h) => { // 存 handlers：stop 时补发 exit 事件（假宿主无事件链→retire 会等退出）
      host.handlers = h;
      return { id: "h1" };
    };
    const r = createSessionRegistry({ host, sessionFor: (f) => `${f}.session`, readinessTimeoutMs: 10_000 });
    const s = r.sessionFor("/root/a.jsonl");
    const sent = s.send("in-flight prompt"); // 不等：驻留 start/readiness 等待窗
    await new Promise((res) => setTimeout(res, 50));
    await r.dispose(); // start-wait 中销毁
    expect(host.stops.length).toBeGreaterThanOrEqual(1); // stop 先行真调宿主（20轮勘正：旧版标题称在飞却从未 send）
    expect(r.files()).toEqual([]);
    await expect(sent).resolves.toMatchObject({ kind: expect.stringMatching(/not-ready|invalidated|gate-rejected/) });
  });
  it("SR8b idle 会话 stop 不伪造：未起轮→dispose 宿主零 stop 调用（原 SR8 断言保留为独立面）", async () => {
    const host = fakeHost();
    const r = createSessionRegistry({ host, sessionFor: (f) => `${f}.session` });
    r.sessionFor("/root/a.jsonl");
    await r.dispose();
    expect(host.stops).toEqual([]); // idle 态 stop()=retireCurrent 无进程→no-process（不调宿主 stop）
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

it("SR12（20轮F3）并发 dispose 共享收尾：受控挂起 close 放行前第二等待者不得完成；资源恰收一次；完成后重复调用仍成功", async () => {
  const host = fakeHost();
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => { release = r; });
  let closes = 0;
  const slow = { ...fakeDurability(), close: () => { closes += 1; return gate; } }; // 受控未决
  const r = createSessionRegistry({ host, sessionFor: (f) => `${f}.session`, durabilityFor: () => slow, audit: () => {} });
  r.sessionFor("/root/a.jsonl");
  const p1 = r.dispose();
  const p2 = r.dispose(); // 首个 stop/close 未完成即并发调用
  await new Promise((res) => setTimeout(res, 30)); // 给收尾链时间走到 close
  let done1 = false, done2 = false;
  void p1.then(() => { done1 = true; }); void p2.then(() => { done2 = true; });
  await new Promise((res) => setTimeout(res, 30));
  expect(done1).toBe(false); // 旧缺陷：p2 提前 resolve
  expect(done2).toBe(false);
  release!();
  await Promise.all([p1, p2]);
  expect(closes).toBe(1); // 恰收一次
  expect(r.files()).toEqual([]);
  await expect(r.dispose()).resolves.toBeUndefined(); // 完成后重复调用仍成功
  expect(() => r.sessionFor("/root/b.jsonl")).toThrow("已销毁"); // 销毁后拒建维持（message 原文断言）
});

it("SR13（20b B1）host.stop 同步重入 dispose：发布已先于外部回调——重入共享同一收尾，不提前完成/不提前 disposed 审计（受控信号驱动）", async () => {
  const host = fakeHost();
  host.spawn = (args, h) => { host.handlers = h; return { id: "h1" }; }; // 存 handlers：stop 时补发 exit（retire 等退出）
  const lines: string[] = [];
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => { release = r; });
  let closes = 0;
  const slow = { ...fakeDurability(), close: () => { closes += 1; return gate; } }; // 受控未决
  const holder: { r: ReturnType<typeof createSessionRegistry> | null } = { r: null };
  // 重入点：host.stop 同步回调里再 dispose（20b B1 的真实窗口：收尾循环正 await s.stop() 时）
  host.stop = (hd) => {
    host.stops.push(hd.id);
    reenteredP = holder.r?.dispose() ?? null; // 同步重入（旧缺陷：此时 disposeP 仍 null → 空表捷径提前完成+提前审计）
    host.handlers?.onExit?.(null, "SIGTERM");
  };
  const r = createSessionRegistry({ host, sessionFor: (f) => `${f}.session`, durabilityFor: () => slow, readinessTimeoutMs: 10_000, audit: (l) => lines.push(l) });
  holder.r = r;
  const sess = r.sessionFor("/root/a.jsonl");
  const sent = sess.send("in-flight"); // 起 start/readiness 等待窗（进程在飞：stop 链才会真调宿主）
  await new Promise((res) => setTimeout(res, 50));
  const p1 = r.dispose();
  let reenteredP: Promise<void> | null = null; // 重入调用返回的 Promise（旧缺陷下它会提前 resolve）
  let done1 = false;
  void p1.then(() => { done1 = true; });
  // 受控信号：等到重入点已发生（stop 已被调），close gate 仍挂——此刻旧缺陷会已出现提前 disposed 审计
  const t0 = Date.now();
  while (host.stops.length === 0) {
    if (Date.now() - t0 > 2000) throw new Error("SR13：重入点未到达（host.stop 未被调）");
    await new Promise((res) => setTimeout(res, 10));
  }
  expect(done1).toBe(false);
  expect(lines.filter((l) => l === "session-registry disposed")).toHaveLength(0); // 提前审计为零（旧缺陷在此处即已 1 次）
  expect(host.stops).toHaveLength(1); // 重入未驱动第二次 stop（未走空表捷径后另一轮全量）
  release!();
  await expect(p1).resolves.toBeUndefined();
  await expect(reenteredP!).resolves.toBeUndefined(); // 重入者与主收尾同终（共享同一收尾）
  expect(lines.filter((l) => l === "session-registry disposed")).toHaveLength(1); // 恰一次
  expect(closes).toBe(1);
  await expect(sent).resolves.toMatchObject({ kind: expect.stringMatching(/not-ready|invalidated|gate-rejected/) }); // 在飞 send 同 SR8 口径收口
});

it("SR14（20b B1）审计回调同步重入 dispose（含空表）：共享收尾/恰一次 disposed 审计/不无限递归", async () => {
  // 场景 A：有待收会话，dispose 循环中的 supervisor 级审计行内同步重入（真正的中逄重入，非仅末行）
  const host = fakeHost();
  const lines: string[] = [];
  let reentries = 0;
  const holder: { r: ReturnType<typeof createSessionRegistry> | null } = { r: null };
  const r = createSessionRegistry({
    host,
    sessionFor: (f) => `${f}.session`,
    durabilityFor: () => fakeDurability(),
    audit: (l) => {
      lines.push(l);
      if (l.startsWith("supervisor ") || l.startsWith("session-registry") || l === "session-registry disposed") {
        reentries += 1;
        void holder.r?.dispose(); // 审计行内同步重入（构造期无此类前缀行，不会误触提前销毁）
      }
    },
  });
  holder.r = r;
  r.sessionFor("/root/a.jsonl");
  await expect(r.dispose()).resolves.toBeUndefined();
  expect(lines.filter((l) => l === "session-registry disposed")).toHaveLength(1); // 不无限递归，恰一次
  expect(reentries).toBeGreaterThan(0); // 重入确实发生过（否则用例空转）
  // 场景 B：空表 dispose + 审计回调重入（重入时列表已空，不得另起收尾/不得双审计）
  const lines2: string[] = [];
  const holder2: { r: ReturnType<typeof createSessionRegistry> | null } = { r: null };
  const r2 = createSessionRegistry({ host: fakeHost(), sessionFor: (f) => `${f}.session`, audit: (l) => { lines2.push(l); void holder2.r?.dispose(); } });
  holder2.r = r2;
  await expect(r2.dispose()).resolves.toBeUndefined();
  expect(lines2.filter((l) => l === "session-registry disposed")).toHaveLength(1); // 空表+重入：仍恰一次
});
