// ②WS/UI 契约准备包：订阅引擎 13 时序（契约 v1.2 §3.6/§3.7；纯逻辑+假时钟）。
import { describe, expect, it } from "vitest";
import { LIMITS, ReadIndex, SubscriptionEngine, type HistoryEvent, type SessionStatus } from "@pi-agent-ui/protocol";

function hEv(seq: number): HistoryEvent { return { kind: "sending", seq, ts: null, generation: null, intentId: null }; }

function fakeStatus(v: number): SessionStatus {
  return {
    session: { sessionId: "s", file: "s.jsonl", adapterSessionId: null },
    process: { phase: "idle", generation: null, lastStartResult: null, lastStopResult: null, ready: false },
    turn: { state: "idle" },
    backgroundTasks: { availability: "known", activeCount: 0 },
    reap: { eligible: true, idleElapsedMs: 0, idleRemainingMs: null, idleMs: 30 * 60_000 },
    recovery: { availability: "available", resumeBlocked: false, diskBlocked: false, unknownEffectCount: 0, unattributableFragments: 0, intentsCount: 0, settledCount: 0, evidenceHash: null },
    statusVersion: v, serverTimeMs: 0,
  };
}

function makeEngine(n: number, now = 0) {
  const idx = new ReadIndex("s.jsonl", "s-1");
  for (let i = 1; i <= n; i++) idx.append("journal", `L${i}`, hEv(i));
  let idSeq = 0;
  const eng = new SubscriptionEngine({ index: idx, status: () => fakeStatus(1), now: () => now, newId: () => `id-${++idSeq}` });
  return { idx, eng, tick: (t: number) => { now = t; } };
}

describe("订阅引擎 13 时序", () => {
  it("①正常快照三页→live（首页→续页→末页）", () => {
    const { idx, eng } = makeEngine(450);
    const f1 = eng.startSnapshot("r-1")[0] as Extract<ReturnType<SubscriptionEngine["startSnapshot"]>[number], { t: "snapshot" }>;
    expect(f1.barrier).toBe(450);
    expect(f1.page).toHaveLength(200);
    expect(f1.historyNext).toEqual({ streamId: "s-1", seq: 201 });
    expect(f1.liveFrom).toBeNull();
    expect(f1.hasMore).toBe(true);
    const f2 = eng.handle({ kind: "page", requestId: "r-2", snapshotId: f1.snapshotId, historyNext: f1.historyNext! })[0] as typeof f1;
    expect(f2.page).toHaveLength(200);
    expect(f2.historyNext).toEqual({ streamId: "s-1", seq: 401 });
    const f3 = eng.handle({ kind: "page", requestId: "r-3", snapshotId: f2.snapshotId, historyNext: f2.historyNext! })[0] as typeof f1;
    expect(f3.page).toHaveLength(50);
    expect(f3.historyNext).toBeNull();
    expect(f3.liveFrom).toEqual({ streamId: "s-1", seq: 451 });
    expect(f3.hasMore).toBe(false);
    expect(eng.state.phase).toBe("live");
    expect(idx.waterMark).toBe(450);
  });

  it("②重复首页请求→幂等重发同帧", () => {
    const { eng } = makeEngine(450);
    const f1 = eng.startSnapshot("r-1");
    const again = eng.handle({ kind: "page", requestId: "r-2", snapshotId: (f1[0] as { snapshotId: string }).snapshotId, historyNext: { streamId: "s-1", seq: 1 } });
    // 注：首页以 seq=1 重试须命中缓存（最近 2 页含首页）
    expect(again).toHaveLength(1);
    expect(((again[0] as unknown) as { page: unknown[] }).page).toHaveLength(200);
  });

  it("③重复中间页→幂等重发", () => {
    const { eng } = makeEngine(450);
    const f1 = eng.startSnapshot("r-1")[0] as { snapshotId: string; historyNext: { streamId: string; seq: number } };
    const first = eng.handle({ kind: "page", requestId: "r-2", snapshotId: f1.snapshotId, historyNext: f1.historyNext });
    const again = eng.handle({ kind: "page", requestId: "r-3", snapshotId: f1.snapshotId, historyNext: f1.historyNext });
    expect(JSON.stringify(again[0])).toBe(JSON.stringify(first[0]));
  });

  it("④跳页（≠期待下页）→4404", () => {
    const { eng } = makeEngine(450);
    const f1 = eng.startSnapshot("r-1")[0] as { snapshotId: string };
    const bad = eng.handle({ kind: "page", requestId: "r-2", snapshotId: f1.snapshotId, historyNext: { streamId: "s-1", seq: 301 } });
    expect(bad[0]).toMatchObject({ t: "error", code: 4404 });
    // 期待未推进
    const ok2 = eng.handle({ kind: "page", requestId: "r-3", snapshotId: f1.snapshotId, historyNext: { streamId: "s-1", seq: 201 } });
    expect(ok2[0]).toMatchObject({ t: "snapshot" });
  });

  it("⑤末页后重复末页（60s 内）→幂等", () => {
    const { eng } = makeEngine(100);
    const f1 = eng.startSnapshot("r-1")[0] as { snapshotId: string };
    const last = eng.handle({ kind: "page", requestId: "r-2", snapshotId: f1.snapshotId, historyNext: { streamId: "s-1", seq: 1 } });
    expect((last[0] as { hasMore: boolean }).hasMore).toBe(false);
    const again = eng.handle({ kind: "page", requestId: "r-3", snapshotId: f1.snapshotId, historyNext: { streamId: "s-1", seq: 1 } });
    expect(JSON.stringify(again[0])).toBe(JSON.stringify(last[0]));
  });

  it("⑥末页宽限过期→4409（retryable）", () => {
    const h = makeEngine(100, 0);
    const f1 = h.eng.startSnapshot("r-1")[0] as { snapshotId: string };
    h.eng.handle({ kind: "page", requestId: "r-2", snapshotId: f1.snapshotId, historyNext: { streamId: "s-1", seq: 1 } });
    h.tick(LIMITS.snapshotTailGraceMs + 1);
    const stale = h.eng.handle({ kind: "page", requestId: "r-3", snapshotId: f1.snapshotId, historyNext: { streamId: "s-1", seq: 1 } });
    expect(stale[0]).toMatchObject({ t: "error", code: 4409, retryable: true });
  });

  it("⑦快照期事件缓冲→末页后回放（history 先于 live）", () => {
    const { idx, eng } = makeEngine(100);
    const f1 = eng.startSnapshot("r-1")[0] as { snapshotId: string };
    // H 后追加（快照期）
    idx.append("journal", "L101", hEv(101));
    eng.onHistoryAppend(hEv(101));
    idx.append("journal", "L102", hEv(102));
    eng.onHistoryAppend(hEv(102));
    const last = eng.handle({ kind: "page", requestId: "r-2", snapshotId: f1.snapshotId, historyNext: { streamId: "s-1", seq: 1 } });
    expect((last[0] as { hasMore: boolean }).hasMore).toBe(false);
    expect((last[0] as { liveFrom: { seq: number } }).liveFrom).toEqual({ streamId: "s-1", seq: 101 });
    // live 期实时事件
    eng.onLiveEvent({ kind: "pi-progress", piType: "message_update", note: "thinking" });
    const frames = eng.drain(16);
    expect(frames[0]).toMatchObject({ t: "events", origin: "history", refSeq: 101, events: [expect.objectContaining({ seq: 101 })] });
    expect(frames[1]).toMatchObject({ t: "events", origin: "history", refSeq: 102 });
    expect(frames[2]).toMatchObject({ t: "events", origin: "live", liveSeq: 1 });
  });

  it("⑧快照期缓冲超限→4431+closed", () => {
    const { idx, eng } = makeEngine(450);
    const f1 = eng.startSnapshot("r-1")[0] as { snapshotId: string };
    // 停在 paging（未拉完页）期间追加超限事件（barrier=450，新事件 451..）
    for (let i = 451; i <= 451 + LIMITS.connQueueFrames; i++) {
      idx.append("journal", `L${i}`, hEv(i));
      eng.onHistoryAppend(hEv(i));
    }
    const frames = eng.drain(16);
    expect(frames.some((f) => (f as { t: string; code?: number }).t === "error" && (f as { code: number }).code === 4431)).toBe(true);
    expect(eng.state.phase).toBe("closed");
    expect(eng.handle({ kind: "page", requestId: "r-9", snapshotId: f1.snapshotId, historyNext: { streamId: "s-1", seq: 201 } })[0]).toMatchObject({ code: 4404 });
  });

  it("⑨游标重同步（中段）→补齐→live", () => {
    const { eng } = makeEngine(100);
    // 客户端游标=51（已读 1..50）；服务端水位 100——resync 从 51 补齐到 100
    const frames = eng.startResync("r-1", { streamId: "s-1", seq: 51 });
    const f1 = frames[0] as unknown as { page: unknown[]; hasMore: boolean };
    expect(f1.page).toHaveLength(50);
    expect(f1.hasMore).toBe(false);
    expect(eng.state.phase).toBe("live");
  });

  it("⑩游标超前→4409", () => {
    const { eng } = makeEngine(100);
    const frames = eng.startResync("r-1", { streamId: "s-1", seq: 150 });
    expect(frames[0]).toMatchObject({ t: "error", code: 4409 });
  });

  it("⑪旧 snapshotId 续页→4404", () => {
    const { eng } = makeEngine(100);
    eng.startSnapshot("r-1");
    const bad = eng.handle({ kind: "page", requestId: "r-2", snapshotId: "other", historyNext: { streamId: "s-1", seq: 1 } });
    expect(bad[0]).toMatchObject({ t: "error", code: 4404 });
  });

  it("⑫closed 后 handle→4404", () => {
    const { eng } = makeEngine(100);
    const f1 = eng.startSnapshot("r-1")[0] as { snapshotId: string };
    eng.close();
    expect(eng.handle({ kind: "page", requestId: "r-2", snapshotId: f1.snapshotId, historyNext: { streamId: "s-1", seq: 1 } })[0]).toMatchObject({ code: 4404 });
    expect(eng.drain()).toHaveLength(0);
  });

  it("⑬live 期：status/history/live 帧交织（drain 分批≤16）", () => {
    const { eng } = makeEngine(100);
    const f1 = eng.startSnapshot("r-1")[0] as { snapshotId: string };
    eng.handle({ kind: "page", requestId: "r-2", snapshotId: f1.snapshotId, historyNext: { streamId: "s-1", seq: 1 } });
    expect(eng.state.phase).toBe("live");
    eng.onStatus(fakeStatus(2));
    eng.onHistoryAppend(hEv(101));
    eng.onLiveEvent({ kind: "turn-state", statusVersion: 2, turn: { state: "in-flight", intentId: "i-1" } });
    eng.onLiveEvent({ kind: "pi-progress", piType: "message_update", note: "thinking" });
    eng.onStatus(fakeStatus(3));
    const b1 = eng.drain(2);
    expect(b1).toHaveLength(2);
    expect(b1[0]).toMatchObject({ t: "status" });
    expect(b1[1]).toMatchObject({ t: "events", origin: "history", refSeq: 101 });
    const b2 = eng.drain(3);
    expect(b2[0]).toMatchObject({ t: "events", origin: "live", liveSeq: 2 });
    expect(b2[1]).toMatchObject({ t: "status", status: { statusVersion: 3 } });
    // 再 drain 空
    expect(eng.drain(16)).toHaveLength(0);
    // 超量分批：20 条 live→两批（帧1=16 事件 liveSeq=18；帧2=4 事件 liveSeq=22）
    for (let i = 0; i < 20; i++) eng.onLiveEvent({ kind: "pi-progress", piType: "message_update", note: "thinking" });
    const p1 = eng.drain(16);
    expect(p1).toHaveLength(2);
    expect(((p1[0] as unknown) as { events: unknown[]; liveSeq: number }).events).toHaveLength(16);
    expect((p1[0] as { liveSeq: number }).liveSeq).toBe(18);
    expect(((p1[1] as unknown) as { events: unknown[]; liveSeq: number }).events).toHaveLength(4);
    expect((p1[1] as { liveSeq: number }).liveSeq).toBe(22);
    expect(eng.drain(16)).toHaveLength(0);
  });
});
