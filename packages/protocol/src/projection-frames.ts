// ②WS/UI 纯投影装页（c6 C5-07 + c7 C6-02/C6-06：recovery/sessions 帧的字节装页纯函数；每次前进不空页）。
//
// 规则（契约 §4/§5.7 对齐）：
// - 装页=字节（帧预算−真实信封）+条数双上限，**终判=整帧序列化实测**（C6-01 同型：贪心粗估装满→
//   整帧 estJson 终判→超限退末条重测；首条即超→null 宿主转 4431，不静默截断）。
// - get-recovery（C6-02）：**单 offset 驱动三视图**——perIntent 装页；unknownEffect/resumable 从
//   **本页行**按 verdict 派生（unknown→unknownEffect；not-evaluated→resumable；blocked 恒空表），
//   total=全集权威计数，truncated/next 与 perIntent 同步。任何一页帧大小都有界。
// - sessions 帧（C6-06）：limit 参数（默认 50、上限 200）+dirReliability 目录级输入（"full"|"partial"；
//   页级=目录与条目保守聚合：任一 partial→partial）。装页仍在完整列表坐标系（total=全集）。
import { LIMITS } from "./contracts.ts";
import type {
  AvailableRecovery, PageOf, RecoveryBlockReason, RecoveryIntentRow, ServerFrame, SessionSummaryDTO,
} from "./contracts.ts";

/** 通用装页：从 offset 起装入 items，双上限；首条必装；单条超限→null。 */
export function packPage<T>(
  items: readonly T[],
  offset: number,
  budgetBytes: number,
  maxCount: number,
  estimate: (item: T) => number,
): { page: PageOf<T>; nextOffset: number; itemBytes: number[] } | null {
  if (offset < 0 || offset > items.length) return null; // 域外（宿主转 4409）
  const out: T[] = [];
  let bytes = LIMITS.envelopeOverheadBytes;
  const itemBytes: number[] = [];
  for (let i = offset; i < items.length && out.length < maxCount; i++) {
    const b = estimate(items[i]!) + 1;
    if (out.length > 0 && bytes + b > budgetBytes) break;
    if (out.length === 0 && bytes + b > budgetBytes) return null; // 单条装不进（首条必装失败）→显式失败
    out.push(items[i]!); bytes += b; itemBytes.push(b);
  }
  const end = offset + out.length;
  return {
    page: { items: out, total: items.length, returned: out.length, truncated: end < items.length, next: end < items.length ? { offset: end } : null },
    nextOffset: end,
    itemBytes,
  };
}

export interface RecoveryReportLike {
  readonly evidenceHash: string;
  readonly resumeBlocked: boolean;
  readonly diskBlocked: boolean;
  readonly unknownEffect: readonly string[];
  readonly resumable: readonly string[];
  readonly perIntent: readonly RecoveryIntentRow[];
  readonly blockedReasons?: readonly RecoveryBlockReason[];
}

export function estJson(v: unknown): number {
  try { return new TextEncoder().encode(JSON.stringify(v)).length; } catch { return LIMITS.frameMaxBytes + 1; }
}

/** get-recovery 投影帧（available 分支；C6-02 单 offset 派生三视图）。
 *  估算函数把派生视图的 ID 开销计入行预算（unknown/not-evaluated 行各多一份 ID 序列化），
 *  整帧终判再退末条循环重测，保证任何页实测 ≤budgetBytes。 */
export function buildRecoveryFrame(
  requestId: string, file: string, report: RecoveryReportLike, offset: number,
  budgetBytes: number = LIMITS.frameMaxBytes,
): ServerFrame | null {
  if (offset < 0 || offset > report.perIntent.length) return null; // 域外
  // 行级粗估并入终判循环：首版直接从 recoveryPageSize 条起按整帧实测收缩（派生视图开销随整帧计入）
  const derive = (rows: readonly RecoveryIntentRow[], verdict: RecoveryIntentRow["verdict"]): string[] => {
    if (verdict === "not-evaluated" && report.resumeBlocked) return []; // blocked 恒空表
    return rows.filter((r) => r.verdict === verdict).map((r) => r.intentId);
  };
  // 终判循环：粗估装满→整帧实测→超限退末条（首条即超→null）
  for (let end = Math.min(report.perIntent.length, offset + LIMITS.recoveryPageSize); ; ) {
    const rows = report.perIntent.slice(offset, end);
    const truncated = end < report.perIntent.length;
    const next = truncated ? { offset: end } : null;
    const view = <T,>(items: T[], total: number): PageOf<T> =>
      ({ items, total, returned: items.length, truncated, next });
    const frame: AvailableRecovery = {
      availability: "available",
      evidenceHash: report.evidenceHash,
      resumeBlocked: report.resumeBlocked,
      diskBlocked: report.diskBlocked,
      blockedReasons: report.blockedReasons ?? [],
      unknownEffect: view(derive(rows, "unknown"), report.unknownEffect.length),
      resumable: view(derive(rows, "not-evaluated"), report.resumable.length),
      perIntent: view(rows, report.perIntent.length),
    };
    const f: ServerFrame = { t: "recovery", requestId, file, ...frame };
    if (estJson(f) <= budgetBytes || rows.length <= 1) {
      return estJson(f) <= budgetBytes ? f : null; // 单行即超→null（宿主转 4431）
    }
    end -= 1; // 退末条重测
    if (end <= offset) return null;
  }
}

/** list-sessions 投影帧（C6-06：limit 参数+目录级可靠性聚合；字节+条数装页+整帧终判同上）。 */
export function buildSessionsFrame(
  requestId: string, sessions: readonly SessionSummaryDTO[], offset: number, listVersion: number,
  dirReliability: "full" | "partial" = "full",
  limit: number = LIMITS.listPageSizeDefault,
  budgetBytes: number = LIMITS.frameMaxBytes,
): ServerFrame | null {
  const n = Math.max(1, Math.min(LIMITS.listPageSizeMax, Math.floor(limit)));
  if (offset < 0 || offset > sessions.length) return null;
  for (let end = Math.min(sessions.length, offset + n); ; ) {
    const items = sessions.slice(offset, end);
    const truncated = end < sessions.length;
    const reliability = dirReliability === "partial" || items.some((s) => s.listReliability === "partial") ? "partial" : "full";
    const f: ServerFrame = {
      t: "sessions", requestId, sessions: items, total: sessions.length,
      offset, hasMore: truncated, listVersion, listReliability: reliability,
    };
    if (estJson(f) <= budgetBytes || items.length <= 1) {
      return estJson(f) <= budgetBytes ? f : null;
    }
    end -= 1;
    if (end <= offset) return null;
  }
}
