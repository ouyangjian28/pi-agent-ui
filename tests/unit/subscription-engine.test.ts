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
  for (let i = 1; i <= n; i++) idx.append("journal", `L${i}`, `L${i}`, hEv(i));
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

  it("③重复中间页→内容幂等+新 requestId（B01）", () => {
    const { eng } = makeEngine(450);
    const f1 = eng.startSnapshot("r-1")[0] as { snapshotId: string; historyNext: { streamId: string; seq: number } };
    const first = eng.handle({ kind: "page", requestId: "r-2", snapshotId: f1.snapshotId, historyNext: f1.historyNext })[0] as Record<string, unknown>;
    const again = eng.handle({ kind: "page", requestId: "r-3", snapshotId: f1.snapshotId, historyNext: f1.historyNext })[0] as Record<string, unknown>;
    // envelope 回显本次 requestId；页内容（除 requestId 外全字段）幂等
    expect(again["requestId"]).toBe("r-3");
    const { ["requestId"]: _a, ...rest } = again;
    const { ["requestId"]: _b, ...orig } = first;
    expect(rest).toEqual(orig);
  });

  it("④跳页（≠期待下页）→4409（C5-05：超前/乱序统一可重试）", () => {
    const { eng } = makeEngine(450);
    const f1 = eng.startSnapshot("r-1")[0] as { snapshotId: string };
    const bad = eng.handle({ kind: "page", requestId: "r-2", snapshotId: f1.snapshotId, historyNext: { streamId: "s-1", seq: 301 } });
    expect(bad[0]).toMatchObject({ t: "error", code: 4409 });
    // 期待未推进
    const ok2 = eng.handle({ kind: "page", requestId: "r-3", snapshotId: f1.snapshotId, historyNext: { streamId: "s-1", seq: 201 } });
    expect(ok2[0]).toMatchObject({ t: "snapshot" });
  });

  it("⑤末页后重复末页（60s 内）→内容幂等+新 requestId", () => {
    const { eng } = makeEngine(100);
    const f1 = eng.startSnapshot("r-1")[0] as { snapshotId: string };
    const last = eng.handle({ kind: "page", requestId: "r-2", snapshotId: f1.snapshotId, historyNext: { streamId: "s-1", seq: 1 } })[0] as Record<string, unknown>;
    expect(last["hasMore"]).toBe(false);
    const again = eng.handle({ kind: "page", requestId: "r-3", snapshotId: f1.snapshotId, historyNext: { streamId: "s-1", seq: 1 } })[0] as Record<string, unknown>;
    expect(again["requestId"]).toBe("r-3");
    const { ["requestId"]: _a, ...rest } = again;
    const { ["requestId"]: _b, ...orig } = last;
    expect(rest).toEqual(orig);
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
    idx.append("journal", "L101", "L101", hEv(101));
    eng.onHistoryAppend(hEv(101));
    idx.append("journal", "L102", "L102", hEv(102));
    eng.onHistoryAppend(hEv(102));
    const last = eng.handle({ kind: "page", requestId: "r-2", snapshotId: f1.snapshotId, historyNext: { streamId: "s-1", seq: 1 } });
    expect((last[0] as { hasMore: boolean }).hasMore).toBe(false);
    expect((last[0] as { liveFrom: { seq: number } }).liveFrom).toEqual({ streamId: "s-1", seq: 101 });
    // live 期实时事件
    eng.onLiveEvent({ kind: "pi-progress", piType: "message_update", note: "thinking" });
    const frames = eng.drain(16);
    // B03/R03：落盘事件回放走 history 帧（同源可合批）；live 事件走 live 帧，顺序在后
    expect(frames[0]).toMatchObject({ t: "events", origin: "history", refSeq: 102, events: [expect.objectContaining({ seq: 101 }), expect.objectContaining({ seq: 102 })] });
    expect(frames[1]).toMatchObject({ t: "events", origin: "live", liveSeq: 1 });
  });

  it("⑧快照期缓冲超限→4431+closed", () => {
    const { idx, eng } = makeEngine(450);
    const f1 = eng.startSnapshot("r-1")[0] as { snapshotId: string };
    // 停在 paging（未拉完页）期间追加超限事件（barrier=450，新事件 451..）
    for (let i = 451; i <= 451 + LIMITS.connQueueFrames; i++) {
      idx.append("journal", `L${i}`, `L${i}`, hEv(i));
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
    // 超量分批（B04）：20 条 live→每帧≤maxEventsPerLiveFrame(7)→三帧（7/7/6），liveSeq=9/16/22
    for (let i = 0; i < 20; i++) eng.onLiveEvent({ kind: "pi-progress", piType: "message_update", note: "thinking" });
    const p1 = eng.drain(16);
    expect(p1).toHaveLength(3);
    const lens = p1.map((f) => ((f as unknown) as { events: unknown[] }).events.length);
    const seqs = p1.map((f) => (f as { liveSeq: number }).liveSeq);
    expect(lens).toEqual([7, 7, 6]); // maxEventsPerLiveFrame 8→7（C5-03 严格小于+信封余量）
    expect(seqs).toEqual([9, 16, 22]); // 前文已交付 2 条 live（liveSeq=2 起点；7+7+6=20）
    expect(eng.drain(16)).toHaveLength(0);
  });

  it("⑭追平补页 H+1→空页 done 进 live（B01）；H=0 同", () => {
    const { eng } = makeEngine(100);
    const f1 = eng.startSnapshot("r-1")[0] as { snapshotId: string };
    const catchUp = eng.handle({ kind: "page", requestId: "r-2", snapshotId: f1.snapshotId, historyNext: { streamId: "s-1", seq: 101 } })[0] as Record<string, unknown>;
    expect(catchUp["t"]).toBe("snapshot");
    expect((catchUp["page"] as unknown[]).length).toBe(0);
    expect(catchUp["hasMore"]).toBe(false);
    expect(catchUp["liveFrom"]).toEqual({ streamId: "s-1", seq: 101 });
    expect(eng.state.phase).toBe("live");
    // 空流（H=0）：首页即空页，游标 1=H+1 域内
    const { eng: e0 } = makeEngine(0);
    const z = e0.startSnapshot("r-0")[0] as Record<string, unknown>;
    expect((z["page"] as unknown[]).length).toBe(0);
    expect(z["hasMore"]).toBe(false);
    expect(z["liveFrom"]).toEqual({ streamId: "s-1", seq: 1 });
    expect(e0.state.phase).toBe("live");
  });

  it("⑮缓存域完整游标：错流同 seq 不命中（B01）", () => {
    const { eng } = makeEngine(450);
    const f1 = eng.startSnapshot("r-1")[0] as { snapshotId: string; historyNext: { streamId: string; seq: number } };
    eng.handle({ kind: "page", requestId: "r-2", snapshotId: f1.snapshotId, historyNext: f1.historyNext }); // 已入缓存
    const wrong = eng.handle({ kind: "page", requestId: "r-3", snapshotId: f1.snapshotId, historyNext: { streamId: "s-other", seq: 201 } })[0] as Record<string, unknown>;
    expect(wrong["t"]).toBe("error");
    expect(wrong["code"]).toBe(4404);
  });

  it("⑯字节装页先于条数（B04）：预算切断+done 由实装决定", () => {
    const idx = new ReadIndex("s.jsonl", "s-1");
    for (let i = 1; i <= 5; i++) idx.append("journal", `L${i}`, `L${i}`, hEv(i));
    let idSeq = 0;
    const eng = new SubscriptionEngine({
      index: idx, status: () => fakeStatus(1), now: () => 0, newId: () => `id-${++idSeq}`,
      estimateEvent: () => 90_000, // 每事件 90k；信封 256+分隔+1 后两页 2 条=180,258≤200k（C5-03 整帧域）
    });
    const p1 = eng.startSnapshot("r-1")[0] as Record<string, unknown>;
    expect((p1["page"] as unknown[]).length).toBe(2);
    expect(p1["historyNext"]).toEqual({ streamId: "s-1", seq: 3 });
    expect(p1["hasMore"]).toBe(true);
    const p2 = eng.handle({ kind: "page", requestId: "r-2", snapshotId: p1["snapshotId"] as string, historyNext: { streamId: "s-1", seq: 3 } })[0] as Record<string, unknown>;
    expect((p2["page"] as unknown[]).length).toBe(2);
    const p3 = eng.handle({ kind: "page", requestId: "r-3", snapshotId: p1["snapshotId"] as string, historyNext: { streamId: "s-1", seq: 5 } })[0] as Record<string, unknown>;
    expect((p3["page"] as unknown[]).length).toBe(1);
    expect(p3["hasMore"]).toBe(false);
    expect(eng.state.phase).toBe("live");
  });

  it("⑰多页分页期间缓冲回放（B01 矩阵：真实双源分页③）", () => {
    const { idx, eng } = makeEngine(450);
    const f1 = eng.startSnapshot("r-1")[0] as { snapshotId: string; historyNext: { streamId: string; seq: number } };
    // 停在 paging（已读 1..200）期间两源追加
    idx.append("journal", "J451", "J451", hEv(451));
    eng.onHistoryAppend(hEv(451));
    idx.append("session", "off=9000", "off=9000", hEv(452));
    eng.onHistoryAppend(hEv(452));
    // 拉完剩余页
    let cur: { streamId: string; seq: number } | null = f1.historyNext;
    let guard = 0;
    while (cur !== null && guard++ < 10) {
      if (cur === null) break;
      const f = eng.handle({ kind: "page", requestId: `r-${guard}`, snapshotId: f1.snapshotId, historyNext: cur })[0] as { historyNext: { streamId: string; seq: number } | null };
      cur = f.historyNext;
    }
    expect(eng.state.phase).toBe("live");
    const frames = eng.drain(16);
    const hist = frames.find((f) => (f as { origin?: string }).origin === "history") as unknown as { events: { seq: number }[] };
    expect(hist.events.map((e) => e.seq)).toEqual([451, 452]); // 快照后落盘事件按编入序回放
  });

  it("⑱两页淘汰：第 3 页后重复第 1 页→4409（缓存窗口=最近 2 页；非期待=超前统一）", () => {
    const { eng } = makeEngine(450);
    const f1 = eng.startSnapshot("r-1")[0] as { snapshotId: string; historyNext: { streamId: string; seq: number } };
    const f2 = eng.handle({ kind: "page", requestId: "r-2", snapshotId: f1.snapshotId, historyNext: f1.historyNext })[0] as { historyNext: { streamId: string; seq: number } };
    eng.handle({ kind: "page", requestId: "r-3", snapshotId: f1.snapshotId, historyNext: f2.historyNext }); // 页3→缓存=[p2,p3]
    const stale = eng.handle({ kind: "page", requestId: "r-4", snapshotId: f1.snapshotId, historyNext: { streamId: "s-1", seq: 1 } })[0] as Record<string, unknown>;
    expect(stale["code"]).toBe(4409); // 页1 已淘汰且≠期待下页（C5-05 统一 4409）
    void f2;
  });

  it("⑲C5-03：单条事件即超页预算→显式失败（4431 关订阅，不静默大帧）", () => {
    const idx = new ReadIndex("s.jsonl", "s-1");
    for (let i = 1; i <= 3; i++) idx.append("journal", `L${i}`, `L${i}`, hEv(i));
    let idSeq = 0;
    const eng = new SubscriptionEngine({
      index: idx, status: () => fakeStatus(1), now: () => 0, newId: () => `id-${++idSeq}`,
      estimateEvent: () => LIMITS.pageFrameBudgetBytes + 1, // 单条即超整页预算
    });
    const r = eng.startSnapshot("r-1")[0] as Record<string, unknown>;
    expect(r["t"]).toBe("error");
    expect(r["code"]).toBe(4431);
    expect(r["retryable"]).toBe(true);
    expect(eng.state.phase).toBe("closed");
  });

  it("⑳C5-04：live 期积压双门——1025 帧 status→超 subscriptionBacklogMax→4431 关订阅", () => {
    const { eng } = makeEngine(100);
    eng.startSnapshot("r-1");
    for (let i = 0; i < LIMITS.subscriptionBacklogMax + 1; i++) eng.onStatus(fakeStatus(2));
    expect(eng.state.phase).toBe("closed"); // 第 1025 项触发（count>max）
    const out = eng.drain(16);
    expect(out[out.length - 1]).toMatchObject({ t: "error", code: 4431 });
  });

  it("㉑C5-04：paging 期编入序——历史追加/status/历史追加按到达序回放（跨队列不乱序）", () => {
    const { idx, eng } = makeEngine(450);
    const f1 = eng.startSnapshot("r-1")[0] as { snapshotId: string; historyNext: { streamId: string; seq: number } };
    eng.onHistoryAppend(hEv(451)); // paging 缓冲
    eng.onStatus(fakeStatus(2));   // paging 期 status 同入缓冲（C5-04）
    idx.append("journal", "J452", "J452", hEv(452));
    eng.onHistoryAppend(hEv(452));
    // 拉完剩余页→enterLive 回放按编入序
    let cur = f1.historyNext as { streamId: string; seq: number } | null;
    let guard = 0;
    while (cur !== null && guard++ < 10) {
      const f = eng.handle({ kind: "page", requestId: `r-${guard}`, snapshotId: f1.snapshotId, historyNext: cur })[0] as { historyNext: { streamId: string; seq: number } | null };
      cur = f.historyNext;
    }
    expect(eng.state.phase).toBe("live");
    const frames = eng.drain(16);
    // 451 → status(2) → 452（到达序；status 帧不再跨队列抢先）
    expect(frames.map((f) => f.t === "events" ? `ev:${((f as unknown) as { events: { seq: number }[] }).events[0]!.seq}` : "status")).toEqual(["ev:451", "status", "ev:452"]);
  });

  it("㉒C5-05：缓存幂等域含 status——重试不重调 status（statusVersion 随页冻结）", () => {
    const idx = new ReadIndex("s.jsonl", "s-1");
    for (let i = 1; i <= 450; i++) idx.append("journal", `L${i}`, `L${i}`, hEv(i));
    let idSeq = 0;
    let statusV = 1;
    const eng = new SubscriptionEngine({ index: idx, status: () => fakeStatus(statusV), now: () => 0, newId: () => `id-${++idSeq}` });
    const p1 = eng.startSnapshot("r-1")[0] as { status: SessionStatus; snapshotId: string; historyNext: { streamId: string; seq: number } };
    expect(p1.status.statusVersion).toBe(1);
    statusV = 9; // 外部状态已推进（未经过 onStatus 帧编入）
    const retry = eng.handle({ kind: "page", requestId: "r-2", snapshotId: p1.snapshotId, historyNext: { streamId: "s-1", seq: 1 } })[0] as { status: SessionStatus }; // 重试=重复第 1 页（缓存键 pageFrom.seq=1）
    expect(retry.status.statusVersion).toBe(1); // 幂等域冻结：重试回页生成时刻快照
  });

  it("㉓C5-05：末页宽限=固定期限（自页生成时刻；缓存重试不续命）", () => {
    const idx = new ReadIndex("s.jsonl", "s-1");
    for (let i = 1; i <= 100; i++) idx.append("journal", `L${i}`, `L${i}`, hEv(i));
    let idSeq = 0;
    let t = 0;
    const eng = new SubscriptionEngine({ index: idx, status: () => fakeStatus(1), now: () => t, newId: () => `id-${++idSeq}` });
    const done = eng.startSnapshot("r-1")[0] as unknown as { page: unknown[]; hasMore: boolean; snapshotId: string };
    expect(done.hasMore).toBe(false); // 单页即完→live（expectNext=null，宽限计时开始）
    t = LIMITS.snapshotTailGraceMs - 1_000;
    const ok = eng.handle({ kind: "page", requestId: "r-2", snapshotId: done.snapshotId, historyNext: { streamId: "s-1", seq: 101 } })[0] as { t: string };
    expect(ok.t).toBe("snapshot"); // 宽限内追平幂等
    t = LIMITS.snapshotTailGraceMs + 1_000; // 距页生成 >60s（重试未续命）
    const expired = eng.handle({ kind: "page", requestId: "r-3", snapshotId: done.snapshotId, historyNext: { streamId: "s-1", seq: 101 } })[0] as { t: string; code: number };
    expect(expired.t).toBe("error");
    expect(expired.code).toBe(4409);
  });
});
