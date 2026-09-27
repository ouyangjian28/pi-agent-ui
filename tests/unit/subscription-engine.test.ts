// ②WS/UI 契约准备包：订阅引擎 13 时序（契约 v1.2 §3.6/§3.7；纯逻辑+假时钟）。
import { describe, expect, it } from "vitest";
import { LIMITS, ReadIndex, SubscriptionEngine, estimateFrameBytes, type HistoryEvent, type SessionStatus } from "@pi-agent-ui/protocol";

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

describe("c7 回归（C6-01..05）", () => {
  it("C6-01：真实 500 中文×450 条——整帧实测装页（每页 ≤pageFrameBudgetBytes，无事件丢失/重复）", () => {
    const idx = new ReadIndex("s.jsonl", "s-1");
    const cn = "忆".repeat(500); // 500 中文≈1,500B UTF-8；GPT 探针口径
    for (let i = 1; i <= 450; i++) {
      idx.append("journal", `L${i}`, `L${i}`, { kind: "message", seq: i, ts: null, generation: null, intentId: null, entryId: `e-${i}`, role: "user", textPreview: { text: cn, truncated: false }, final: true } as HistoryEvent);
    }
    let idSeq = 0;
    const statusV = 1;
    const eng = new SubscriptionEngine({ index: idx, status: () => fakeStatus(statusV), now: () => 0, newId: () => `id-${++idSeq}` });
    const seen: number[] = [];
    let pages = 0;
    let cur: { streamId: string; seq: number } | null = null;
    let snapId = "";
    for (;;) {
      const f = (cur === null ? eng.startSnapshot("r-1") : eng.handle({ kind: "page", requestId: `r-${pages + 1}`, snapshotId: snapId, historyNext: cur }))[0] as Record<string, unknown>;
      if (snapId === "") snapId = f["snapshotId"] as string;
      if (f["t"] === "error") throw new Error("unexpected error");
      const frame = f as unknown as import("@pi-agent-ui/protocol").ServerFrame;
      const bytes = estimateFrameBytes(frame); // UTF-8 实测
      expect(bytes).toBeLessThanOrEqual(LIMITS.pageFrameBudgetBytes); // 每页整帧有界（旧实现 200,462B 击穿）
      const page = f["page"] as { seq: number }[];
      seen.push(...page.map((e) => e.seq));
      pages += 1;
      const next = f["historyNext"] as { streamId: string; seq: number } | null;
      if (next === null) break;
      cur = next;
    }
    expect(pages).toBeGreaterThan(3); // 字节驱动多页（非条数上限 200 一页到顶）
    expect(seen).toEqual(Array.from({ length: 450 }, (_, i) => i + 1)); // 不丢不重，序连续
  });

  it("C6-04：稳态队列不误杀——2000 轮恒留 1 项待发（GPT 口径：队列永不全空）+drain(1) 恒 live", () => {
    const { eng } = makeEngine(2);
    eng.startSnapshot("r-1"); // H=2 → 首页即 done 进 live
    eng.drain(1);
    eng.onStatus(fakeStatus(1));
    eng.onStatus(fakeStatus(2)); // 预留 2 项：drain(1) 后仍剩 1——队列永不全空
    eng.drain(1);
    for (let i = 0; i < 2000; i++) {
      eng.onStatus(fakeStatus(3 + i));
      const out = eng.drain(1);
      expect(out).toHaveLength(1); // 每轮恰发 1 帧（旧实现第 429 轮起 backlogBytes 误关=累计流量）
      expect(eng.state.phase).toBe("live");
    }
  });

  it("C6-05：空流 H=0 首页=空 done 页；重试走缓存（statusVersion 冻结，不漂移）", () => {
    const idx = new ReadIndex("s.jsonl", "s-1"); // 空
    let idSeq = 0;
    let statusV = 1;
    const eng = new SubscriptionEngine({ index: idx, status: () => fakeStatus(statusV), now: () => 0, newId: () => `id-${++idSeq}` });
    const f1 = eng.startSnapshot("r-1")[0] as Record<string, unknown>;
    expect(f1["t"]).toBe("snapshot");
    expect(f1["page"]).toEqual([]);
    expect(f1["liveFrom"]).toEqual({ streamId: "s-1", seq: 1 });
    statusV = 9; // 外部状态推进
    const f2 = eng.handle({ kind: "page", requestId: "r-2", snapshotId: f1["snapshotId"] as string, historyNext: { streamId: f1["streamId"] as string, seq: 1 } })[0] as Record<string, unknown>;
    expect(f2["t"]).toBe("snapshot");
    expect((f2["status"] as { statusVersion: number }).statusVersion).toBe(1); // 冻结于页生成时刻（旧实现直调 status=9）
    expect(f2["page"]).toEqual([]);
  });
});

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
    // c6 C5-05（GPT 实测反例）：paging 期跳 H+1→4409（121..450 不得被空页吞掉进 live）
    const { eng: e450 } = makeEngine(450);
    const p1 = e450.startSnapshot("r-1")[0] as unknown as { snapshotId: string; historyNext: { streamId: string; seq: number } };
    expect(p1.historyNext.seq).toBe(201);
    const jump = e450.handle({ kind: "page", requestId: "r-2", snapshotId: p1.snapshotId, historyNext: { streamId: "s-1", seq: 451 } })[0] as Record<string, unknown>;
    expect(jump["t"]).toBe("error");
    expect(jump["code"]).toBe(4409);
    expect(e450.state.phase).toBe("paging"); // 未被空页推进到 live
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

  it("⑲C5-03/C6-01：整帧实测超页预算→退末条收缩；首条即超→显式失败（4431，retryable=false）", () => {
    const idx = new ReadIndex("s.jsonl", "s-1");
    for (let i = 1; i <= 3; i++) idx.append("journal", `L${i}`, `L${i}`, hEv(i));
    // 收缩路径：两事件帧超、单事件帧过 → 退一条后成页（expectNext=2，继续分页）
    let idSeq = 0;
    const eng = new SubscriptionEngine({
      index: idx, status: () => fakeStatus(1), now: () => 0, newId: () => `id-${++idSeq}`,
      estimateFrame: (f) => (f as { t: string; page?: unknown[] }).t === "snapshot" && ((f as { page?: unknown[] }).page?.length ?? 0) >= 2 ? LIMITS.pageFrameBudgetBytes + 1 : 64,
    });
    const r1 = eng.startSnapshot("r-1")[0] as Record<string, unknown>;
    expect(r1["t"]).toBe("snapshot");
    expect((r1["page"] as unknown[]).length).toBe(1); // 末条被终判退回
    expect(eng.state.phase).toBe("paging");
    // 退条后期待下页=2：续页请求 seq=2 正常受页（证明 expectNext 由实装末位决定）
    const r1b = eng.handle({ kind: "page", requestId: "r-2", snapshotId: r1["snapshotId"] as string, historyNext: { streamId: r1["streamId"] as string, seq: 2 } })[0] as Record<string, unknown>;
    expect(r1b["t"]).toBe("snapshot");
    expect((r1b["page"] as unknown[]).length).toBe(1);
    // 首条即超：单事件帧仍超 → 4431 关订阅（不静默大帧）
    const eng2 = new SubscriptionEngine({
      index: idx, status: () => fakeStatus(1), now: () => 0, newId: () => `id-${++idSeq}`,
      estimateFrame: (f) => (f as { t: string; page?: unknown[] }).t === "snapshot" && ((f as { page?: unknown[] }).page?.length ?? 0) >= 1 ? LIMITS.pageFrameBudgetBytes + 1 : 64,
    });
    const r2 = eng2.startSnapshot("r-1")[0] as Record<string, unknown>;
    expect(r2["t"]).toBe("error");
    expect(r2["code"]).toBe(4431);
    expect(r2["retryable"]).toBe(false); // c7 C6-04：4431 统一 retryable=false（订阅已亡，恢复=重新订阅）
    // 注：本帧出自 servePage 请求级出口（:244，携页请求 requestId）——非 drain 出口；drain 出口信封见下例 ⑲b
    expect(eng2.state.phase).toBe("closed");
  });

  it("⑲b K4-发现1：drain 出口整帧超预算 4431=流终局信封（subscriptionId 指认+requestId 空）", () => {
    const idx = new ReadIndex("f.jsonl", "s");
    for (let i = 1; i <= 1; i++) idx.append("journal", `L${i}`, `L${i}`, hEv(i));
    let idSeq = 0;
    let poison = false;
    const eng = new SubscriptionEngine({ index: idx, status: () => fakeStatus(1), now: () => 0, newId: () => `id-${++idSeq}`,
      estimateFrame: (f) => {
        if (poison && f.t === "events") return LIMITS.frameMaxBytes + 1;
        return 64;
      } });
    eng.startSnapshot("r-1");
    eng.drain(4); // 首页（快照帧 64B 不受毒）→live
    poison = true; // live 期后续 events 帧全部「超帧预算」
    idx.append("journal", `L2`, `L2`, hEv(2));
    eng.onHistoryAppend(hEv(2));
    const out = eng.drain(16);
    const last = out[out.length - 1] as Record<string, unknown>;
    expect(last["t"]).toBe("error");
    expect(last["code"]).toBe(4431);
    expect(last["subscriptionId"]).toBe(eng.subscriptionId);
    expect(last["requestId"]).toBe("");
    expect(eng.state.phase).toBe("closed");
  });

  it("⑳C5-04：live 期积压双门——1025 帧 status→超 subscriptionBacklogMax→4431 关订阅", () => {
    const { eng } = makeEngine(100);
    eng.startSnapshot("r-1");
    for (let i = 0; i < LIMITS.subscriptionBacklogMax + 1; i++) eng.onStatus(fakeStatus(2));
    expect(eng.state.phase).toBe("closed"); // 第 1025 项触发（count>max）
    const out = eng.drain(16);
    expect(out[out.length - 1]).toMatchObject({ t: "error", code: 4431 });
    // K3-B1：引擎终局帧也带结构化身份（客户端可路由到具体流，不靠 message 文本解析）
    expect((out[out.length - 1] as { subscriptionId?: string }).subscriptionId).toBe(eng.subscriptionId);
    expect((out[out.length - 1] as { requestId?: string }).requestId).toBe("");
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
    // 双路重试：缓存命中（seq=1=页首）在宽限内成功
    const ok = eng.handle({ kind: "page", requestId: "r-2", snapshotId: done.snapshotId, historyNext: { streamId: "s-1", seq: 1 } })[0] as { t: string };
    expect(ok.t).toBe("snapshot"); // 宽限内缓存重发（非追平分支）
    t = LIMITS.snapshotTailGraceMs + 1_000; // 距页生成 >60s（缓存重试未续命——固定期限）
    const expired = eng.handle({ kind: "page", requestId: "r-3", snapshotId: done.snapshotId, historyNext: { streamId: "s-1", seq: 1 } })[0] as { t: string; code: number };
    expect(expired.t).toBe("error");
    expect(expired.code).toBe(4409);
  });
});

describe("c8 回归（R1/R2：缓存信封预算+失败清理）", () => {
  it("R1：缓存重发不因合法 requestId 变长击穿页预算（GPT c9 反例原样固化：119×500 中文+末条 325；assistant role）", () => {
    // GPT c9 独立探针口径：role=assistant、entryId=e1..e120、id-1/id-2 工厂、末条 325 中文（≤500 预览配额）。
    // 未修实现：首页 120 事件=199,938B，64B requestId 重试=200,001B 击穿；worst 信封终判退末条→119 事件。
    const idx = new ReadIndex("f.jsonl", "s");
    const cn = "忆".repeat(500);
    const ev = (i: number, text: string): HistoryEvent => ({ kind: "message", seq: i, ts: null, generation: null, intentId: null, entryId: `e${i}`, role: "assistant", textPreview: { text, truncated: false }, final: true } as HistoryEvent);
    for (let i = 1; i <= 119; i++) idx.append("journal", `L${i}`, `L${i}`, ev(i, cn));
    idx.append("journal", "L120", "L120", ev(120, "忆".repeat(325)));
    let idSeq = 0;
    const eng = new SubscriptionEngine({ index: idx, status: () => fakeStatus(1), now: () => 0, newId: () => `id-${++idSeq}` });
    const first = eng.startSnapshot("r")[0] as unknown as import("@pi-agent-ui/protocol").ServerFrame & { page: { seq: number }[]; snapshotId: string; historyNext: { streamId: string; seq: number } | null };
    expect(first.t).toBe("snapshot");
    expect(first.page).toHaveLength(119); // worst 信封使末条退到第 2 页（未修实现贪心装满 120→重试击穿）
    expect(estimateFrameBytes(first)).toBeLessThanOrEqual(LIMITS.pageFrameBudgetBytes);
    expect(estimateFrameBytes(first)).toBeGreaterThan(190_000); // 真实大页（GPT 实测 198,796B）
    // 任何合法 requestId（≤64B）重发不超预算（含信封最坏替换）
    const firstWorst = { ...first, requestId: "r".repeat(64) } as unknown as import("@pi-agent-ui/protocol").ServerFrame;
    expect(estimateFrameBytes(firstWorst)).toBeLessThanOrEqual(LIMITS.pageFrameBudgetBytes);
    // 缓存重发（合法 64 字符 requestId）：仍是 snapshot 帧、≤预算、除 requestId 外完全相等
    const retry = eng.handle({ kind: "page", requestId: "r".repeat(64), snapshotId: first.snapshotId, historyNext: { streamId: "s", seq: 1 } })[0] as unknown as import("@pi-agent-ui/protocol").ServerFrame & { page: { seq: number }[] };
    expect(retry.t).toBe("snapshot");
    expect(estimateFrameBytes(retry)).toBeLessThanOrEqual(LIMITS.pageFrameBudgetBytes);
    const { requestId: _a, ...firstRest } = first as { requestId?: string };
    const { requestId: _b, ...retryRest } = retry as { requestId?: string };
    expect(retryRest).toEqual(firstRest);
    // 续页拼回全集（退掉的末条在第 2 页；不丢不重）
    expect(first.historyNext).not.toBeNull();
    const p2 = eng.handle({ kind: "page", requestId: "r2", snapshotId: first.snapshotId, historyNext: first.historyNext! })[0] as unknown as import("@pi-agent-ui/protocol").ServerFrame & { page: { seq: number }[]; historyNext: { streamId: string; seq: number } | null };
    expect(p2.page.map((e) => e.seq)).toEqual([120]);
    expect(p2.historyNext).toBeNull();
  });

  it("R1b：缓存重发防御终判（故障注入：缓存生成后 snapshot 帧超预算→唯一 4431+closed+无残留）", () => {
    // 防御故障注入（非默认估算器自然发生）：首页真实计量装页；缓存生成后 estimator 对 snapshot 帧返回 200,001B。
    const idx = new ReadIndex("f.jsonl", "s");
    for (let i = 1; i <= 3; i++) idx.append("journal", `L${i}`, `L${i}`, hEv(i));
    let idSeq = 0;
    let poison = false;
    const eng = new SubscriptionEngine({ index: idx, status: () => fakeStatus(1), now: () => 0, newId: () => `id-${++idSeq}`,
      estimateFrame: (f) => {
        if (poison && f.t === "snapshot") return LIMITS.pageFrameBudgetBytes + 1;
        return estimateFrameBytes(f);
      } });
    const first = eng.startSnapshot("r-1")[0] as { snapshotId: string; historyNext: null };
    expect(first.historyNext).toBeNull(); // H=3 单页 done → live
    eng.drain(1);
    poison = true; // 缓存已生成：重试帧「超预算」
    const out = eng.handle({ kind: "page", requestId: "r".repeat(64), snapshotId: first.snapshotId, historyNext: { streamId: "s", seq: 1 } });
    expect(out).toHaveLength(1);
    expect(out[0]!.t).toBe("error");
    expect((out[0] as { code: number }).code).toBe(4431);
    expect((out[0] as { retryable: boolean }).retryable).toBe(false);
    expect(eng.state.phase).toBe("closed");
    expect(eng.state.buffered).toBe(0);
    expect(eng.drain()).toEqual([]); // 无复活
  });

  it("R2：live 冲批失败→丢弃已取出 status（closed 队列不复活；二次 drain 空；错误恰一份）", () => {
    const idx = new ReadIndex("s.jsonl", "s-1");
    for (let i = 1; i <= 2; i++) idx.append("journal", `L${i}`, `L${i}`, hEv(i));
    let idSeq = 0;
    // 估算器仅对 live origin events 帧返回 300000（GPT 探针口径）
    const eng = new SubscriptionEngine({ index: idx, status: () => fakeStatus(1), now: () => 0, newId: () => `id-${++idSeq}`,
      estimateFrame: (f) => {
        const fr = f as unknown as { t: string; origin?: string };
        if (fr.t === "events" && fr.origin === "live") return 300_000;
        return estimateFrameBytes(f);
      } });
    const snap = eng.startSnapshot("r-1")[0] as { snapshotId: string; historyNext: { streamId: string; seq: number } | null };
    expect(snap.historyNext).toBeNull(); // H=2 单页 done
    eng.drain(1);
    eng.onLiveEvent({ kind: "process-note", phase: "running" });
    eng.onStatus(fakeStatus(9)); // 帧项排在 live 项后
    const out1 = eng.drain();
    expect(out1).toHaveLength(1); // 恰一份错误
    expect(out1[0]!.t).toBe("error");
    expect((out1[0] as { code: number }).code).toBe(4431);
    expect((out1[0] as { retryable: boolean }).retryable).toBe(false);
    expect(eng.state.phase).toBe("closed");
    const out2 = eng.drain(); // 旧实现：resurrected status 在此交付
    expect(out2).toEqual([]); // R2：closed 后无残留普通帧
  });

  it("R2：history 冲批失败同样不残留（origin 切换路径）", () => {
    const idx = new ReadIndex("s.jsonl", "s-1");
    for (let i = 1; i <= 2; i++) idx.append("journal", `L${i}`, `L${i}`, hEv(i));
    let idSeq = 0;
    const eng = new SubscriptionEngine({ index: idx, status: () => fakeStatus(1), now: () => 0, newId: () => `id-${++idSeq}`,
      estimateFrame: (f) => {
        const fr = f as unknown as { t: string; origin?: string };
        if (fr.t === "events" && fr.origin === "history") return 300_000;
        return estimateFrameBytes(f);
      } });
    const snap = eng.startSnapshot("r-1")[0] as { snapshotId: string };
    void snap;
    eng.drain(1);
    eng.onHistoryAppend({ kind: "message", seq: 3, ts: null, generation: null, intentId: null, entryId: "e-3", role: "user", textPreview: { text: "x", truncated: false }, final: true } as HistoryEvent);
    eng.onStatus(fakeStatus(9));
    const out1 = eng.drain();
    expect(out1).toHaveLength(1);
    expect(out1[0]!.t).toBe("error");
    const out2 = eng.drain();
    expect(out2).toEqual([]);
    expect(eng.state.phase).toBe("closed");
  });
});

describe("3b3-fix8 F8-1：页提交资格统一终检（GPT fix7 P8/P9/P10/P11）", () => {
  // 引擎直测：估算器/时钟=公开 SubscriptionEngineDeps 注入面（网关不转传估算器——P8/P9 属引擎端口反例）。
  const mkEng = (
    n: number,
    deps: { estimateFrame?: (f: import("@pi-agent-ui/protocol").ServerFrame) => number; estimateEvent?: (e: HistoryEvent) => number; now?: () => number } = {},
  ) => {
    const idx = new ReadIndex("f.jsonl", "s-1");
    for (let i = 1; i <= n; i++) idx.append("journal", `L${i}`, `L${i}`, hEv(i));
    let idSeq = 0;
    const eng = new SubscriptionEngine({ index: idx, status: () => fakeStatus(1), now: () => 0, newId: () => `id-${++idSeq}`, ...deps });
    return { idx, eng };
  };
  const errOf = (frames: unknown[]) => frames.map((f) => f as { t: string; code?: number; requestId?: string });
  const S = (f: unknown) => f as { t: string; snapshotId: string; historyNext: { streamId: string; seq: number } | null };

  it("F8/P-PAGE-EST-EVENT 续页填装 estimateEvent 关引擎→4404：不出退役页、closed 不被改写", () => {
    let armed = false;
    const { eng } = mkEng(201, { estimateEvent: () => { if (armed) { armed = false; eng.close(4431, "宿主重入", false); } return 8; } });
    const f1 = S(eng.startSnapshot("r-1")[0]);
    expect(f1.t).toBe("snapshot");
    expect(f1.historyNext).toEqual({ streamId: "s-1", seq: 201 });
    armed = true; // 下一页填装（estimateEvent）时关闭
    const out = errOf(eng.handle({ kind: "page", requestId: "r-2", snapshotId: f1.snapshotId, historyNext: f1.historyNext! }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ t: "error", code: 4404, requestId: "r-2" }); // 入口同语义拒
    expect(eng.state.phase).toBe("closed"); // 不复活（旧代码：expectNext/rememberPage 照写+返回退役快照）
    // 重发同请求：closed 入口 4404（无缓存页可命中）
    const again = errOf(eng.handle({ kind: "page", requestId: "r-3", snapshotId: f1.snapshotId, historyNext: f1.historyNext! }));
    expect(again[0]).toMatchObject({ t: "error", code: 4404 });
  });

  it("F8/P-PAGE-EST-FRAME 续页终判 estimateFrame 关引擎→4404（与 estimateEvent 分立——两端口独立杀伤）", () => {
    let armed = false;
    const { eng } = mkEng(201, { estimateFrame: () => { if (armed) { armed = false; eng.close(4431, "宿主重入", false); } return 64; } });
    const f1 = S(eng.startSnapshot("r-1")[0]);
    expect(f1.t).toBe("snapshot"); // 首页正常（未 armed；旧写法 armed=true 会让本例退化为入口拒绝假绿）
    armed = true; // 下一页终判（estimateFrame）时关闭
    const out = errOf(eng.handle({ kind: "page", requestId: "r-2", snapshotId: f1.snapshotId, historyNext: f1.historyNext! }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ t: "error", code: 4404, requestId: "r-2" });
    expect(eng.state.phase).toBe("closed");
  });

  it("F8/P-PAGE-NONFINAL 非末页（done=false）估算器关引擎→4404：else-paging 复活路径死（GPT fix7 P9 输入二）", () => {
    let armed = false;
    const { eng } = mkEng(401, { estimateEvent: () => { if (armed) { armed = false; eng.close(4431, "宿主重入", false); } return 8; } });
    const f1 = S(eng.startSnapshot("r-1")[0]);
    expect(f1.historyNext).toEqual({ streamId: "s-1", seq: 201 });
    armed = true; // 第 2 页（201..400 非末页）填装时关闭
    const out = errOf(eng.handle({ kind: "page", requestId: "r-2", snapshotId: f1.snapshotId, historyNext: f1.historyNext! }));
    expect(out[0]).toMatchObject({ t: "error", code: 4404, requestId: "r-2" });
    expect(out.every((f) => f.t !== "snapshot")).toBe(true);
    expect(eng.state.phase).toBe("closed"); // 旧代码：else this.phase="paging" 直接复活（不经 enterLive，门挡不住）
  });

  it("F8/P-H1-EST H+1 追平补页 estimateFrame 关引擎→4404：不 rememberPage 空页、不返回退役空页（GPT fix7 P8）", () => {
    let armed = false;
    const { eng } = mkEng(3, { estimateFrame: () => { if (armed) { armed = false; eng.close(4431, "宿主重入", false); } return 64; } });
    const f1 = S(eng.startSnapshot("r-1")[0]);
    expect(f1.t).toBe("snapshot");
    expect(f1.historyNext).toBeNull(); // 3 行单页 done→live
    armed = true; // H+1 空页终判（estimateFrame）时关闭
    const out = errOf(eng.handle({ kind: "page", requestId: "r-2", snapshotId: f1.snapshotId, historyNext: { streamId: "s-1", seq: 4 } }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ t: "error", code: 4404, requestId: "r-2" });
    expect(eng.state.phase).toBe("closed");
    // 缓存未复填直证（GPT fix8 §Y9-2：重发 4404 来自 closed 入口拒，不能独立证缓存空——以缓存长度为准）
    expect((eng as unknown as { recentPages: unknown[] })["recentPages"]).toHaveLength(0);
    const again = errOf(eng.handle({ kind: "page", requestId: "r-3", snapshotId: f1.snapshotId, historyNext: { streamId: "s-1", seq: 4 } }));
    expect(again[0]).toMatchObject({ t: "error", code: 4404 }); // 入口同语义（与缓存证据互补，不单独归因）
  });

  it("F8/P-CACHED-EST 缓存重发 estimateFrame 关引擎→4404：不返回退役缓存页（GPT fix7 P11——本分支此前无任何 closed 检查）", () => {
    let armed = false;
    const { eng } = mkEng(201, { estimateFrame: () => { if (armed) { armed = false; eng.close(4431, "宿主重入", false); } return 64; } });
    const f1 = S(eng.startSnapshot("r-1")[0]);
    expect(f1.t).toBe("snapshot");
    const f2 = S(eng.handle({ kind: "page", requestId: "r-2", snapshotId: f1.snapshotId, historyNext: f1.historyNext! })[0]);
    expect(f2.t).toBe("snapshot"); // 第 2 页正常（此时尚未 armed）
    armed = true; // 缓存重发终判（estimateFrame）时关闭
    const out = errOf(eng.handle({ kind: "page", requestId: "r-4", snapshotId: f1.snapshotId, historyNext: f1.historyNext! })); // 缓存重发第 2 页
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ t: "error", code: 4404, requestId: "r-4" }); // 旧代码：返回退役缓存 f2
    expect(eng.state.phase).toBe("closed");
  });

  // F9-1（fix9，GPT fix8 B9-1/P8/P9/P10）：预算失败早退口不得抢盖 closed——估帧回调返回后先验 closed 再解读预算结果。
  // 对照（未关闭且真超限→4431）：既有用例⑲（"首条即超→显式失败"）+ 本组 F9/P-BUDGET-NOCLOSE。
  const B = LIMITS.pageFrameBudgetBytes;

  it("F9/P-BUDGET-CACHED 缓存重发估帧回调关引擎+返回超限→4404 非 4431（GPT fix8 P8）", () => {
    let armed = false;
    const { eng } = mkEng(201, { estimateFrame: () => { if (armed) { armed = false; eng.close(4431, "宿主重入", false); return B + 1; } return 64; } });
    const f1 = S(eng.startSnapshot("r-1")[0]);
    S(eng.handle({ kind: "page", requestId: "r-2", snapshotId: f1.snapshotId, historyNext: f1.historyNext! })[0]); // 页 2 完成并缓存（estimator=64）
    armed = true; // 缓存重发：estimator=关引擎+超限
    const res = errOf(eng.handle({ kind: "page", requestId: "r-3", snapshotId: f1.snapshotId, historyNext: f1.historyNext! }));
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ t: "error", code: 4404, requestId: "r-3" }); // 旧代码：4431 抢盖（估帧超限即 close+4431，终检不可达）
    expect(eng.state.phase).toBe("closed");
    expect(res.some((f) => f.t === "snapshot")).toBe(false);
  });

  it("F9/P-BUDGET-H1 H+1 估帧回调关引擎+返回超限→4404 非 4431（GPT fix8 P9）", () => {
    let armed = false;
    const { eng } = mkEng(3, { estimateFrame: () => { if (armed) { armed = false; eng.close(4431, "宿主重入", false); return B + 1; } return 64; } });
    const f1 = S(eng.startSnapshot("r-1")[0]); // 3 行单页 done→live
    armed = true; // H+1 空页估帧终判回调=关引擎+超限
    const res = errOf(eng.handle({ kind: "page", requestId: "h1-1", snapshotId: f1.snapshotId, historyNext: { streamId: "s-1", seq: 4 } }));
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ t: "error", code: 4404, requestId: "h1-1" }); // 旧代码：4431 抢盖
    expect(eng.state.phase).toBe("closed");
  });

  it("F9/P-BUDGET-PAGE-SHRINK 续页终判持续超限且首轮关引擎→4404 非 4431（GPT fix8 P10 输入A：退空口）", () => {
    let armed = false;
    const { eng } = mkEng(201, { estimateFrame: () => { if (armed) { if (!eng.state || (eng.state.phase as string) !== "closed") eng.close(4431, "宿主重入", false); return B + 1; } return 64; } });
    const f1 = S(eng.startSnapshot("r-1")[0]);
    armed = true; // 第 2 页 1 条：基线=终判首轮（关引擎）即被 F9-1 先验拒 4404；删门旧态=退条→次轮仍超限→events 退空→4431（fix10 注释勘正：区分基线首轮拒绝与旧态退空）
    const res = errOf(eng.handle({ kind: "page", requestId: "r-2", snapshotId: f1.snapshotId, historyNext: f1.historyNext! }));
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ t: "error", code: 4404, requestId: "r-2" });
    expect(eng.state.phase).toBe("closed");
  });

  it("F9/P-BUDGET-PAGE-EMPTY 续页首轮关+超限、次轮通过→退空判定口 4404 非 4431（GPT fix8 P10 输入B）", () => {
    let step = 0; // 0=基线64；1=关+超限（仅一次）；2=通过64；3=超限（持续）
    const { eng } = mkEng(201, { estimateFrame: () => { if (step === 1) { step = 2; eng.close(4431, "宿主重入", false); return B + 1; } return step === 3 ? B + 1 : 64; } });
    const f1 = S(eng.startSnapshot("r-1")[0]); // 调用=64（step0）
    step = 1; // 第 2 页终判首轮：基线=F9-1 先验首轮即拒 4404；删门旧态=退条后次轮 64 通过（events 已空）→落退空判定口 4431
    const res = errOf(eng.handle({ kind: "page", requestId: "r-2", snapshotId: f1.snapshotId, historyNext: f1.historyNext! }));
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ t: "error", code: 4404, requestId: "r-2" }); // 旧代码：4431（退空口）
    expect(eng.state.phase).toBe("closed");
  });

  it("F10/P-BUDGET-NAN 对照：估算器返回 NaN（未关闭）→退空→4431（旧成功谓词语义保留，GPT fix9 Y10-3）", () => {
    let armed = false;
    const { eng } = mkEng(201, { estimateFrame: () => (armed ? Number.NaN : 64) }); // NaN=不受控注入端口行为（默认估算器不产生）
    const f1 = S(eng.startSnapshot("r-1")[0]);
    armed = true; // 第 2 页终判 NaN：NaN<=B 不成立→退条→退空→4431（fix8 语义；fix9 首版 over=NaN>B=false 会误受帧，fix10 勘正）
    const res = errOf(eng.handle({ kind: "page", requestId: "r-2", snapshotId: f1.snapshotId, historyNext: f1.historyNext! }));
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ t: "error", code: 4431, retryable: false, requestId: "r-2" });
    expect(eng.state.phase).toBe("closed");
  });

  it("F9/P-BUDGET-NOCLOSE 对照：未关闭且真超限→4431（预算失败语义保留，不因 F9-1 一律 4404）", () => {
    let armed = false;
    const { eng } = mkEng(201, { estimateFrame: () => (armed ? B + 1 : 64) }); // 无关闭，仅续页起超限
    const f1 = S(eng.startSnapshot("r-1")[0]);
    armed = true;
    const res = errOf(eng.handle({ kind: "page", requestId: "r-2", snapshotId: f1.snapshotId, historyNext: f1.historyNext! }));
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ t: "error", code: 4431, retryable: false, requestId: "r-2" });
    expect(eng.state.phase).toBe("closed"); // 4431 仍关订阅（语义不变）
  });

  it("F8/P-PAGE-NOW-ENGINE 续页提交尾 lastPageAt=now() 关引擎→4404：GPT fix7 P10 引擎序列（装页/终判毕→时钟窗失效）", () => {
    let armed = false;
    const { eng } = mkEng(201, { now: () => { if (armed) { armed = false; eng.close(4431, "宿主重入", false); } return 0; } });
    const f1 = S(eng.startSnapshot("r-1")[0]);
    expect(f1.t).toBe("snapshot");
    expect(f1.historyNext).toEqual({ streamId: "s-1", seq: 201 });
    armed = true; // 下一 now() 调用=第 2 页提交尾 lastPageAt（引擎直测面无其它时钟调用点）
    const out = errOf(eng.handle({ kind: "page", requestId: "r-2", snapshotId: f1.snapshotId, historyNext: f1.historyNext! }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ t: "error", code: 4404, requestId: "r-2" }); // 旧代码：时钟窗关引擎后照写 expectNext/缓存并返回退役第 2 页
    expect(eng.state.phase).toBe("closed");
  });

  it("F8/P-GRACE-NOW 末页宽限检查内 now 关引擎→4404：宽限窗同样终检（GPT fix7 P10 同型入口）", () => {
    let armed = false;
    const { eng } = mkEng(3, { now: () => { if (armed) { armed = false; eng.close(4431, "宿主重入", false); } return 0; } });
    const f1 = S(eng.startSnapshot("r-1")[0]);
    expect(f1.t).toBe("snapshot");
    expect(f1.historyNext).toBeNull(); // live、expectNext=null → 后续请求走末页宽限
    armed = true; // 宽限检查 now() 调用时关闭
    const out = errOf(eng.handle({ kind: "page", requestId: "r-2", snapshotId: f1.snapshotId, historyNext: { streamId: "s-1", seq: 1 } }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ t: "error", code: 4404, requestId: "r-2" }); // 旧代码（删门后）：close 已清 recentPages→缓存未命中→落状态门 4409（游标不符）；4404 优先于 4409，且非"退役首页"
    expect(eng.state.phase).toBe("closed");
  });
});
