// c6 C5-07：recovery/sessions 纯投影装页。
import { describe, expect, it } from "vitest";
import { buildRecoveryFrame, buildSessionsFrame, packPage, estimateFrameBytes, type RecoveryIntentRow, type ServerFrame, type SessionSummaryDTO, type SanitizedText } from "@pi-agent-ui/protocol";

function row(id: string): RecoveryIntentRow { return { intentId: id, verdict: "settled", provisional: false }; }
function sum(file: string, rel: "full" | "partial" = "full"): SessionSummaryDTO {
  const title: SanitizedText = { text: `会话 ${file}`, truncated: false };
  return { sessionId: "s", file, title, lastActiveMs: null, entryCount: 1, sizeBytes: 100, hasRecoveryNotice: false, listReliability: rel };
}

describe("纯投影装页（c6 C5-07）", () => {
  it("packPage：双上限+前进保证（首条必装）+next/total/truncated", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ v: "x".repeat(10), i }));
    const r = packPage(items, 0, 500, 10, () => 60); // 信封 256+61=317→378→439→500（恰等不超）→第 5 条 561>500 停
    expect(r).not.toBeNull();
    expect(r!.page.items).toHaveLength(4); // 字节上限切断（每事件 60B+分隔 1B；恰等=不超）
    expect(r!.page.total).toBe(10);
    expect(r!.page.truncated).toBe(true);
    expect(r!.page.next).toEqual({ offset: 4 });
    const r2 = packPage(items, 4, 100_000, 3, () => 1); // 宽字节→条数上限 3
    expect(r2!.page.items).toHaveLength(3);
  });

  it("packPage：offset 域外→null（宿主 4409）；尾页 next=null+truncated=false", () => {
    const items = [1, 2, 3];
    expect(packPage(items, 99, 200, 10, () => 1)).toBeNull();
    const r = packPage(items, 0, 100_000, 10, () => 1);
    expect(r!.page.next).toBeNull();
    expect(r!.page.truncated).toBe(false);
    expect(r!.page.returned).toBe(3);
  });

  it("buildRecoveryFrame：单 offset 驱动三视图（C6-02）——perIntent 装页；unknown/resumable 从本页行派生；blocked 恒空表", () => {
    const perIntent = Array.from({ length: 600 }, (_, i) => row(`i-${i + 1}`));
    perIntent[1] = { intentId: "i-2", verdict: "unknown", provisional: true };
    const report = { evidenceHash: "a".repeat(64), resumeBlocked: true, diskBlocked: false, unknownEffect: ["i-2"], resumable: ["i-1"], perIntent };
    const f1 = buildRecoveryFrame("r-1", "f.jsonl", report, 0)! as unknown as { t: string; perIntent: { next: { offset: number } | null; total: number }; unknownEffect: { items: string[]; total: number; truncated: boolean }; resumable: { items: string[]; total: number } };
    expect(f1.t).toBe("recovery");
    expect(f1.perIntent.next).toEqual({ offset: 500 }); // recoveryPageSize=500 先到
    expect(f1.perIntent.total).toBe(600);
    expect(f1.unknownEffect.items).toEqual(["i-2"]); // 本页第 2 行 verdict=unknown → 派生视图含之
    expect(f1.unknownEffect.total).toBe(1); // total=全集权威计数
    expect(f1.unknownEffect.truncated).toBe(true); // 与 perIntent 同步
    expect(f1.resumable.items).toEqual([]); // resumeBlocked=true → resumable 恒空表（即使有 not-evaluated 行）
    const f2 = buildRecoveryFrame("r-2", "f.jsonl", report, 500)! as unknown as { perIntent: { items: RecoveryIntentRow[]; next: null }; unknownEffect: { items: string[]; total: number; truncated: boolean } };
    expect(f2.perIntent.items).toHaveLength(100);
    expect(f2.perIntent.next).toBeNull();
    expect(f2.unknownEffect.items).toEqual([]); // 末页无 unknown 行 → 派生空（total 仍=1）
    expect(f2.unknownEffect.total).toBe(1);
    expect(f2.unknownEffect.truncated).toBe(false);
  });

  it("buildRecoveryFrame：3000 意图×128 字符 ID 逐页有界（C6-02+GPT c7 精度：真实长 ID+UTF-8 字节断言）", () => {
    const longId = (i: number) => `i-${String(i + 1).padStart(4, "0")}-${"x".repeat(120)}`; // ≈128 字符/ID（GPT 探针口径）
    const perIntent = Array.from({ length: 3000 }, (_, i) =>
      i % 2 === 0 ? row(longId(i)) : { intentId: longId(i), verdict: "not-evaluated" as const, provisional: false });
    const resumable = perIntent.filter((r) => r.verdict === "not-evaluated").map((r) => r.intentId);
    const report = { evidenceHash: "a".repeat(64), resumeBlocked: false, diskBlocked: false, unknownEffect: [], resumable, perIntent };
    const seen: string[] = [];
    let off = 0;
    let pages = 0;
    while (off < 3000) {
      const f = buildRecoveryFrame(`r-${pages}`, "f.jsonl", report, off)! as unknown as { perIntent: { items: RecoveryIntentRow[]; next: { offset: number } | null }; resumable: { items: string[]; total: number }; [k: string]: unknown };
      pages += 1;
      seen.push(...f.resumable.items);
      expect(estimateFrameBytes(f as unknown as ServerFrame)).toBeLessThanOrEqual(200_000); // 整帧 UTF-8 实测有界（C6-02；旧实现 488,476B）
      if (f.perIntent.next === null) break;
      off = f.perIntent.next.offset;
    }
    expect(pages).toBe(6); // 128B ID×500 行≈95KB+派生 resumable≈33KB<200k → 恢复页上限=500 行/页（字节断言仍恒真；整表突破型由 M-c02 变异覆盖）
    expect(seen).toEqual(resumable); // 全量翻页后派生视图拼回全集（顺序=行序）
  });

  it("buildSessionsFrame：页级聚合（条目 partial→partial）+hasMore 续页+limit（C6-06）", () => {
    const sessions = Array.from({ length: 10 }, (_, i) => sum(`f${i}.jsonl`, i === 1 ? "partial" : "full"));
    const f1 = buildSessionsFrame("r-1", sessions, 0, 7, "full", 3, 1_200_000)! as unknown as { t: string; listReliability: string; hasMore: boolean; sessions: unknown[] };
    expect(f1.t).toBe("sessions");
    expect(f1.listReliability).toBe("partial"); // 页级聚合（本页含 partial 条目）
    expect(f1.sessions).toHaveLength(3); // limit=3 条数上限
    expect(f1.hasMore).toBe(true);
    const f2 = buildSessionsFrame("r-2", sessions, 3, 7, "full", 200, 1_200_000)! as unknown as { sessions: unknown[]; hasMore: boolean; listReliability: string };
    expect(f2.listReliability).toBe("full"); // 第二页无 partial 条目
    expect(f2.sessions).toHaveLength(7);
    expect(f2.hasMore).toBe(false);
  });

  it("buildSessionsFrame：目录级 partial 输入→页级 partial（C6-06 目录截断反例）+默认 limit 50+limit 钳位", () => {
    const sessions = Array.from({ length: 300 }, (_, i) => sum(`f${i}.jsonl`)); // 全 full 条目（GPT c7 精度：>200 才能证明上限）
    const f1 = buildSessionsFrame("r-1", sessions, 0, 7, "partial")! as unknown as { listReliability: string; sessions: unknown[]; hasMore: boolean };
    expect(f1.listReliability).toBe("partial"); // 条目全 full 但目录扫描截断 → 页级 partial（保守聚合）
    expect(f1.sessions).toHaveLength(50); // 默认 limit=50（非旧固定 200）
    expect(f1.hasMore).toBe(true);
    const f2 = buildSessionsFrame("r-2", sessions, 50, 7, "full", 999)! as unknown as { sessions: unknown[]; hasMore: boolean };
    expect(f2.sessions).toHaveLength(200); // 300 条输入 + limit=999 钳到 200（旧测试 80 条只到 30，证不了上限）
    expect(f2.hasMore).toBe(true);
    const f3 = buildSessionsFrame("r-3", sessions, 200, 7, "full", 999)! as unknown as { sessions: unknown[]; hasMore: boolean };
    expect(f3.sessions).toHaveLength(100); // 续页余量
    expect(f3.hasMore).toBe(false);
  });

  it("单条超预算→null（显式失败，宿主转错误帧）", () => {
    expect(buildRecoveryFrame("r", "f", { evidenceHash: "a".repeat(64), resumeBlocked: false, diskBlocked: false, unknownEffect: [], resumable: [], perIntent: [{ intentId: "i", verdict: "unknown", provisional: false }] }, 0, 100)).toBeNull();
    expect(buildSessionsFrame("r", [sum("f.jsonl")], 0, 1, "full", 50, 100)).toBeNull();
  });
});
