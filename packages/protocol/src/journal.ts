// journal 账本行类型（TECH §5.5 交付语义分层 + §5.6 账本行 schema 扩展）
// journal=append-only+逐行 fsync，永不 rename。

import type { AttachmentId, EntryIdentity, IntentId, IntentKind, IntentMatchKey, SessionId } from "./identity.ts";
import type { ComposerPromptSnapshot } from "./composer-input.ts";

/** 附件明细（enqueue 行携带原始 hash 前缀；匹配用多重集身份由 identity.ts 派生）。 */
export interface EnqueuePayload {
  readonly kind: IntentKind;
  readonly rawText: string;
  readonly attachments: readonly AttachmentId[];
  readonly sentAt: string; // ISO8601
  readonly composer?: ComposerPromptSnapshot; // prompt-configured的有界原配置/附件快照，不包含base64或凭据。
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
    }
  | RepairLine // P0-1a 修复留痕（无 intentId；重放聚合不参与，报告侧作持久修复事实呈现）
  | AdjudicateLine // P0-1b 裁决留痕（宿主人工裁决；重放聚合不参与，报告侧作持久裁决事实参与配对解锁）
  | WriterOathLine; // P0-3 写权宣誓（无 intentId；重放聚合不参与，报告侧呈现当前写者+代次异常）

/** P0-3 写权宣誓行（journal 写权代次）：server 启动恢复后、开放写面前的持久宣誓。
 *  身份=epoch（单调 +1）+bootId（server 启动身份，读写面统一概念）。
 *  不变式：INV-1 任何业务行之前必有 writer 行（行归属=最近前置 writer 行 epoch）；
 *  INV-2 epoch 严格递增；INV-3 同 epoch 不现两 bootId（违反=脑裂已发生，读面呈现）。 */
export interface WriterOathLine {
  readonly t: "writer";
  /** journal 写权代次（首次宣誓=1；旧写者读到 ≥ 自身 epoch 的异已宣誓即冻结写面）。 */
  readonly epoch: number;
  /** server 启动身份（UUID；一次启动一个身份）。 */
  readonly bootId: string;
  /** 宣誓时刻（ISO8601；展示用，不参与判据）。 */
  readonly at: string;
}

export const JOURNAL_CONTRACT_VERSION = 3; // v3=P0-3 加 writer 行（先例：v2=P0-1a RepairLine）；legacy v2 盘面兼容读，恢复时补宣誓转 v3 域

/** journal 行序列化单一来源（P0-2/P02-D1）：实写格式与字节记账（守卫 noteAppended）必须同源，
 *  各自实现会漂移（记账错=守卫假阳性冻结/假阴性放行）。FileDurability 实写与 GuardedJournalWriter
 *  记账同用本函数。 */
export function serializeJournalLine(line: JournalLine): Buffer {
  return Buffer.from(`${JSON.stringify(line)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// P0-3 写权代次扫描（纯逻辑；读面呈现/恢复/写前守卫共用）
// ---------------------------------------------------------------------------

export type WriterAnomaly =
  | { readonly kind: "epoch-non-monotonic"; readonly epoch: number } // INV-2
  | { readonly kind: "same-epoch-two-boots"; readonly epoch: number }; // INV-3（脑裂已发生的证据呈现）

export interface WriterEpochScan {
  /** 最高 writer epoch（无任何 writer 行=null：legacy v2 盘面，恢复时补宣誓 epoch=1）。 */
  readonly maxEpoch: number | null;
  readonly latestBootId: string | null;
  readonly anomalies: readonly WriterAnomaly[];
  /** INV-1 呈现：首个业务行（有 intentId 的行）出现在首个 writer 行之前（或全无 writer 行）——legacy 段，非错误。 */
  readonly legacyHead: boolean;
}

/** journal 行流 → writer 代次状态（不变量机检：违反=呈现不崩溃）。 */
export function scanWriterEpoch(lines: readonly JournalLine[]): WriterEpochScan {
  let maxEpoch: number | null = null;
  let latestBootId: string | null = null;
  const anomalies: WriterAnomaly[] = [];
  const seenBootIds = new Map<number, string>(); // epoch → 首见 bootId（INV-3 检测）
  let firstWriterIdx: number | null = null;
  let firstBusinessIdx: number | null = null;
  lines.forEach((line, i) => {
    if (line.t === "writer") {
      if (firstWriterIdx === null) firstWriterIdx = i;
      if (maxEpoch !== null && line.epoch <= maxEpoch) {
        anomalies.push({ kind: "epoch-non-monotonic", epoch: line.epoch });
      }
      if (line.epoch > (maxEpoch ?? 0)) {
        maxEpoch = line.epoch;
        latestBootId = line.bootId;
      }
      const seen = seenBootIds.get(line.epoch);
      if (seen === undefined) seenBootIds.set(line.epoch, line.bootId);
      else if (seen !== line.bootId) anomalies.push({ kind: "same-epoch-two-boots", epoch: line.epoch });
      return;
    }
    // 业务行=有 intentId 的行（repair/adjudicate=宿主工具行，独立信任域，不计 INV-1）
    if ("intentId" in line && firstBusinessIdx === null) firstBusinessIdx = i;
  });
  const legacyHead = firstBusinessIdx !== null && (firstWriterIdx === null || firstBusinessIdx < firstWriterIdx);
  return { maxEpoch, latestBootId, anomalies, legacyHead };
}

/** P0-1a 修复留痕行（P0 冻结序①）：宿主显式撕裂尾截断修复的持久记录。
 *  位置+字节边界+buildId+契约版本绑定——修复时 byteStart..byteEnd 段已物理移除，
 *  本行紧随保留前缀之后追加（读面事实：本行自身起始偏移=byteStart）。
 *  证据链语义：本行是锚点合法转移面（截尾后锚点由修复工具按新盘面重写，
 *  转移合法性=修复时旧锚前缀哈希校验通过+removedSha256 复核；见 repair-tail.ts）。 */
export interface RepairLine {
  readonly t: "repair";
  readonly reason: "torn-tail";
  /** 保留前缀长度（=移除段起点；=本行自身在文件中的字节偏移）。 */
  readonly byteStart: number;
  /** 移除段终点（修复时 EOF）。 */
  readonly byteEnd: number;
  /** 移除段 sha256（hex；审计身份——修复后段已不在盘，摘要先行留存）。 */
  readonly removedSha256: string;
  /** 执行修复的宿主构建身份（非空串）。 */
  readonly buildId: string;
  /** 写入时 journal 契约版本（=JOURNAL_CONTRACT_VERSION）。 */
  readonly contractVersion: number;
  readonly at: string; // ISO8601
  /** r7（GPT r6 P1-r6-1）：修复时对移除尾段做受限结构扫描的归因留痕——顶层唯一身份可证时
   *  记该 id；不可归因（none/conflict）显式记 null。作用：①写面结构一致门（fragment 裁决
   *  归因须与之一致，矛盾裁决拒落盘）②读面影响域并入（冷捕获丢 raw 后结构归因不失忆）。
   *  缺省=存量行（r7 前无此字段）：不做强一致校验、不并入影响域，未归因事务阻断门兜底。
   *  字段序放最尾：旧形态行=新形态行的严格前缀（崩溃部分行残局的前缀判定跨版本兼容）。 */
  readonly fragIntentId?: IntentId | null;
}

/** P0-1b 裁决留痕行（P0 冻结序②）：宿主人工裁决的持久记录——重启不重问。
 *  两种裁决对象均锢在修复事务四元组（与 RepairFact 同构：removedSha256+byteStart+byteEnd+at
 *  ——旧裁决不作用于新事务；v2 身份模型）。fragment=四元组+归因目标 intentId（归因终局：
 *  abandon 排除重发/resend 授权重发——授权作用域锢在其四元组证据链，见读面 resendCovers）；
 *  repair=四元组本身（解锁阻断线只看配对存在；verdict 记录宿主决定本身）。
 *  verdict=resend/abandon；幂等：同 subject+verdict 重复落行由读面配对去重（R3）。 */
export interface AdjudicateLine {
  readonly t: "adjudicate";
  // v2 身份模型（GPT r1 B1/B3/B5）：两种 subject 都锢在修复事务四元组（与 repair 行同构）。
  // fragment=四元组+归因目标 intentId（归因终局：abandon 排除重发/resend 授权重发）；
  // repair=纯四元组（只解修复阴影，无归因语义）。raw 全文不进裁决行（撕裂字节重编码 SHA
  // 不可复原 P7；同内容新事务误解锁 P3；膨胀 L2）——原字节证据由 repair 行 removedSha256 持有。
  readonly subject:
    | {
        readonly kind: "fragment";
        readonly removedSha256: string;
        readonly byteStart: number;
        readonly byteEnd: number;
        /** 目标修复事务 startedAt（与 repair 行/RepairFact.at 同源）。 */
        readonly at: string;
        /** 归因目标：裁决绑定的意图（不可静默更换——同事务换目标=conflicting-verdict）。 */
        readonly intentId: IntentId;
      }
    | {
        readonly kind: "repair";
        readonly removedSha256: string;
        readonly byteStart: number;
        readonly byteEnd: number;
        /** 目标修复事务 startedAt（与 repair 行/RepairFact.at 同源）。 */
        readonly at: string;
      };
  readonly verdict: "resend" | "abandon";
  /** 裁决操作者（宿主记名；单机单宿主信任域，非审计链签名）。 */
  readonly operator: string;
  readonly buildId: string;
  readonly contractVersion: number;
  readonly at: string; // ISO8601
}

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
      case "repair": break; // P0-1a：修复留痕行无 intentId，聚合面显式无操作（GPT r1 B6/L1：真实 case，非注释宣称）
      case "adjudicate": break; // P0-1b：裁决留痕行无顶层 intentId，聚合面无操作（报告侧由 buildRecoverReport 派生配对）
      case "writer": break; // P0-3：写权宣誓行无 intentId，聚合面无操作（报告侧由 buildRecoverReport 呈现写者/代次异常）
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
