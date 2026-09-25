// c6 C5-07：recovery/sessions 纯投影装页。
import { describe, expect, it } from "vitest";
import { buildRecoveryFrame, buildSessionsFrame, packPage, type RecoveryIntentRow, type SessionSummaryDTO, type SanitizedText } from "@pi-agent-ui/protocol";

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

  it("buildRecoveryFrame：perIntent 按 offset 装页驱动；unknown/resumable 恒整表", () => {
    const perIntent = Array.from({ length: 600 }, (_, i) => row(`i-${i + 1}`));
    const report = { evidenceHash: "a".repeat(64), resumeBlocked: true, diskBlocked: false, unknownEffect: ["i-2"], resumable: [], perIntent };
    const f1 = buildRecoveryFrame("r-1", "f.jsonl", report, 0)! as unknown as { t: string; perIntent: { next: { offset: number } | null; total: number }; unknownEffect: { items: string[] } };
    expect(f1.t).toBe("recovery");
    expect(f1.perIntent.next).toEqual({ offset: 500 }); // recoveryPageSize=500 先到
    expect(f1.perIntent.total).toBe(600);
    expect(f1.unknownEffect.items).toEqual(["i-2"]);
    const f2 = buildRecoveryFrame("r-2", "f.jsonl", report, 500)! as unknown as { perIntent: { items: RecoveryIntentRow[]; next: null } };
    expect(f2.perIntent.items).toHaveLength(100);
    expect(f2.perIntent.next).toBeNull();
  });

  it("buildSessionsFrame：页级 listReliability（本页含 partial→partial）；hasMore 偏移续页", () => {
    const sessions = Array.from({ length: 10 }, (_, i) => sum(`f${i}.jsonl`, i === 1 ? "partial" : "full"));
    const f1 = buildSessionsFrame("r-1", sessions, 0, 7, 1_200)! as unknown as { t: string; listReliability: string; hasMore: boolean; sessions: unknown[] };
    expect(f1.t).toBe("sessions");
    expect(f1.listReliability).toBe("partial"); // 页级聚合（本页含 partial 条目）
    expect(f1.hasMore).toBe(true); // 字节预算切断（1,200B<全量）
    expect(f1.sessions.length).toBeGreaterThanOrEqual(1);
    expect(f1.sessions.length).toBeLessThan(10);
    const offset2 = f1.sessions.length;
    const f2 = buildSessionsFrame("r-2", sessions, offset2, 7, 100_000)! as unknown as { sessions: unknown[]; hasMore: boolean; listReliability: string };
    expect(f2.listReliability).toBe("full"); // 第二页无 partial 条目（条目 1 已被首页消费）
    expect(f2.sessions).toHaveLength(10 - offset2);
    expect(f2.hasMore).toBe(false);
  });

  it("单条超预算→null（显式失败，宿主转错误帧）", () => {
    expect(buildRecoveryFrame("r", "f", { evidenceHash: "a".repeat(64), resumeBlocked: false, diskBlocked: false, unknownEffect: [], resumable: [], perIntent: [{ intentId: "i", verdict: "unknown", provisional: false }] }, 0, 100)).toBeNull();
    expect(buildSessionsFrame("r", [sum("f.jsonl")], 0, 1, 100)).toBeNull();
  });
});
