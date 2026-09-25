// journal 账本行类型（TECH §5.5 交付语义分层 + §5.6 账本行 schema 扩展）
// journal=append-only+逐行 fsync，永不 rename。

import type { AttachmentId, EntryIdentity, IntentId, IntentKind, IntentMatchKey, SessionId } from "./identity.ts";

/** 附件明细（enqueue 行携带原始 hash 前缀；匹配用多重集身份由 identity.ts 派生）。 */
export interface EnqueuePayload {
  readonly kind: IntentKind;
  readonly rawText: string;
  readonly attachments: readonly AttachmentId[];
  readonly sentAt: string; // ISO8601
}

/** 账本行类型判别（三标记制：written→sending→stdin 首字节；自动补发唯一判据=sending 标记不存在）。 */
export type JournalLine =
  | {
      readonly t: "enqueue";
      readonly intentId: IntentId;
      readonly sessionId: SessionId;
      readonly generation: number;
      readonly leafId: string;
      readonly matchKey: IntentMatchKey;
      readonly payload: EnqueuePayload;
    } // ≡written 行（同一硬序第一写）
  | { readonly t: "sending"; readonly intentId: IntentId } // 发送通道开栓（fsync 先于 stdin 首字节，机械硬序）
  | { readonly t: "engaged"; readonly intentId: IntentId } // 呈现增强证据（永不作处置依据）
  | {
      readonly t: "consumed";
      readonly intentId: IntentId;
      readonly anchorEntryId: string;
      readonly intervalEnd: EntryIdentity;
    } // 一行双字段：消费锚（append-only 不改写）+区间终点（新行承载）
  | { readonly t: "clear"; readonly sessionId: SessionId; readonly cleared: readonly IntentId[] } // clear_queue 响应到达时写被清清单（层2 逐意图身份）
  | { readonly t: "cancelled"; readonly intentId: IntentId } // 执行侧取消终态（身份确定且已 written；由 clear 行分派落）
  | { readonly t: "delivered"; readonly intentId: IntentId }
  | { readonly t: "settled"; readonly intentId: IntentId }
  | { readonly t: "unknown"; readonly intentId: IntentId; readonly reason: string } // 终裁 unknown（含归组原因）
  | {
      /** 超时未结算发送记录（TECH §169④ 事件归属屏障：响应超时=先耐久本行，再移出在途集合；此后晚到 success 不回绑不开 run；晚到 settled 到达由 settled 行结算本记录）。 */
      readonly t: "response-timeout";
      readonly intentId: IntentId;
      readonly generation: number;
      readonly commandId: number;
    };

/** 意图恢复视图（对账算法输入：由 journal 行重放聚合）。 */
export interface IntentRecord {
  readonly intentId: IntentId;
  readonly sessionId: SessionId;
  readonly generation: number;
  readonly matchKey: IntentMatchKey;
  readonly payload: EnqueuePayload;
  readonly sending: boolean; // sending 行存在（撕裂行按存在处理）
  readonly consumed: ConsumedEvidence | null; // 最新有效 consumed 行（锚=最早，终点=最新；撕裂整行拒收）
  readonly cancelled: boolean;
  readonly lastVerdict: "delivered" | "settled" | "unknown" | null; // 三审①：终态行重放保留——clear 分派须保留原判不得改写
  /** §169④ 超时未结算发送记录行在（恢复消费：true+lastVerdict=null→效果未知呈现；settled 行到达则终态由其承载）。重放恒置位；手写记录缺省=未记录。 */
  readonly responseTimeoutRecorded?: boolean;
}

/** 消费证据（重放重建）：锚 append-only 保留，区间终点按最新重算承载。 */
export interface ConsumedEvidence {
  readonly anchorEntryId: string;
  readonly intervalEnd: EntryIdentity;
}

/** 从 journal 行流重建意图视图（含跨历史日文件聚合：按会话身份+intentId 聚合，行序=文件序）。 */
export function replayIntents(lines: readonly JournalLine[], sessionId: SessionId): Map<IntentId, IntentRecord> {
  const byId = new Map<IntentId, IntentRecord>();
  const enqueueOrder: IntentId[] = [];
  for (const line of lines) {
    if (line.t === "enqueue") {
      if (line.sessionId !== sessionId) continue;
      byId.set(line.intentId, {
        intentId: line.intentId,
        sessionId: line.sessionId,
        generation: line.generation,
        matchKey: line.matchKey,
        payload: line.payload,
        sending: false,
        consumed: null,
        cancelled: false,
        lastVerdict: null,
        responseTimeoutRecorded: false,
      });
      enqueueOrder.push(line.intentId);
      continue;
    }
    // clear 行（二审 R2-04：重放不可达修——clear_queue 响应行直接分派 cancelled，非预填布尔）
    if (line.t === "clear") {
      if (line.sessionId !== sessionId) continue;
      for (const cid of line.cleared) {
        const rec = byId.get(cid);
        if (rec) byId.set(cid, { ...rec, cancelled: true });
      }
      continue;
    }
    const rec = byId.get((line as { intentId?: IntentId }).intentId ?? "");
    if (!rec) continue;
    switch (line.t) {
      case "sending":
        byId.set(rec.intentId, { ...rec, sending: true });
        break;
      case "consumed":
        // 双字段：锚=历史事实保留（首行）；终点=最新行承载（扩展/重算）
        byId.set(rec.intentId, {
          ...rec,
          consumed: rec.consumed
            ? { anchorEntryId: rec.consumed.anchorEntryId, intervalEnd: line.intervalEnd }
            : { anchorEntryId: line.anchorEntryId, intervalEnd: line.intervalEnd },
        });
        break;
      case "cancelled":
        byId.set(rec.intentId, { ...rec, cancelled: true });
        break;
      case "delivered":
      case "settled":
        byId.set(rec.intentId, { ...rec, lastVerdict: line.t });
        break;
      case "unknown":
        byId.set(rec.intentId, { ...rec, lastVerdict: "unknown" });
        break;
      case "response-timeout":
        // 观测记录行（§169④）：不改变终态——终态仍由 settled/unknown 行承载；
        // 恢复消费判据=record.responseTimeoutRecorded && lastVerdict===null →「效果未知」呈现
        byId.set(rec.intentId, { ...rec, responseTimeoutRecorded: true });
        break;
      default:
        break; // consumed/sending/cancelled 已在上方处理
    }
  }
  return byId;
}
