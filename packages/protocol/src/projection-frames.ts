// ②WS/UI 纯投影装页（c6 C5-07：recovery/sessions 帧的字节装页纯函数；每次前进不空页）。
//
// 规则（契约 §4/§5.7 对齐）：
// - 装页=字节（frameMaxBytes−信封预留）+条数（pageMaxEvents/recoveryPageSize/listPageSizeMax）双上限；
//   首条必装保前进；单条装不进→返回 null（宿主转 4431 错误帧，不静默截断）。
// - get-recovery 单 offset 驱动 perIntent 分页；unknownEffect/resumable 恒整表（自然有界：
//   意图数上限），truncated=false；三 PageOf 的 next 只有 perIntent 可非空。
// - sessions 帧：字节+条数装页+hasMore；listReliability=页级（本页含任一 partial 条目→partial）。
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

function estJson(v: unknown): number {
  try { return new TextEncoder().encode(JSON.stringify(v)).length; } catch { return LIMITS.frameMaxBytes + 1; }
}

/** get-recovery 投影帧（available 分支）：perIntent 按 offset 字节装页；
 *  unknownEffect/resumable 恒整表（自然有界，truncated=false，next=null）。 */
export function buildRecoveryFrame(
  requestId: string, file: string, report: RecoveryReportLike, offset: number,
  budgetBytes: number = LIMITS.frameMaxBytes,
): ServerFrame | null {
  const packed = packPage(report.perIntent, offset, budgetBytes, LIMITS.recoveryPageSize, estJson);
  if (packed === null) return null; // 单行装不进→宿主转错误帧
  const whole = <T,>(items: readonly T[]): PageOf<T> => ({ items, total: items.length, returned: items.length, truncated: false, next: null });
  const frame: AvailableRecovery = {
    availability: "available",
    evidenceHash: report.evidenceHash,
    resumeBlocked: report.resumeBlocked,
    diskBlocked: report.diskBlocked,
    blockedReasons: report.blockedReasons ?? [],
    unknownEffect: whole(report.unknownEffect),
    resumable: whole(report.resumable),
    perIntent: packed.page,
  };
  return { t: "recovery", requestId, file, ...frame };
}

/** list-sessions 投影帧：sessions 按 offset 字节+条数装页；listReliability=页级。 */
export function buildSessionsFrame(
  requestId: string, sessions: readonly SessionSummaryDTO[], offset: number, listVersion: number,
  budgetBytes: number = LIMITS.frameMaxBytes,
): ServerFrame | null {
  const packed = packPage(sessions, offset, budgetBytes, LIMITS.listPageSizeMax, estJson);
  if (packed === null) return null;
  const reliability = packed.page.items.some((s) => s.listReliability === "partial") ? "partial" : "full";
  return {
    t: "sessions", requestId, sessions: packed.page.items, total: sessions.length,
    offset, hasMore: packed.page.truncated, listVersion, listReliability: reliability,
  };
}
