// D4 全文读面装帧（docs/d4-fulltext-design.md §4.1b 两段式实测版，v5.1 冻结）。
// 纯函数：输入=已净化的全文块（entryBlocksOf 产物）+身份/规模参数，输出=EntryFrame 或显式 oversized。
// 预算两段式（同装页器先例 subscription-engine.ts:217/:228-250）：
//  1) 粗估快筛——按块序装入，块内容可用=singleEventBytes-(envelopeOverheadBytes 256+entry 专属 1_792)
//     =30_720 编码前字节；整块放得下→入；放不下且非空→按剩余量 UTF-8 安全预截；其后块暂不计入。
//  2) 终判整帧实测——estimateFrameBytes（JSON 编码后字节）>singleEventBytes 时对末块再切片
//     （UTF-8 安全预截）重测至收敛；其后块省略并计数。末块切到空仍超=显式失败
//     （改发 4414 oversized，照抄先例 :241-245/projection-frames.ts:31）——成功帧只余 ok/truncated 两态。
// 上界承诺：终判后帧 ≤ singleEventBytes 恒成立（JSON 转义膨胀由终判+单调收敛吸收）。
// rawBytes 仅 ok 态携带；truncated 帧线上不携带该字段（wire 级缺席，P2-N1' 裁决）。
// truncatedAt=块内 UTF-16 代码单元切位（与 SESSION_PREVIEW_LIMIT 同口径；代理对不切断由安全预截保证）。
import { estimateFrameBytes, LIMITS, type EntryBlock, type EntryFrame } from "./contracts.ts";

/** entry 帧信封预留=envelopeOverheadBytes(256)+entry 专属开销预留(1_792)——块内容预算
 *  =singleEventBytes-本值=30_720 编码前字节（§4.1b 粗估段）。 */
export const ENTRY_FRAME_ENVELOPE_RESERVE_BYTES = 2_048;

/** argsPreview 编码后字节上限（§4.1b：计入同一预算；截断置 argsTruncated:true）。 */
export const ENTRY_ARGS_PREVIEW_MAX_BYTES = 512;

// ---------------------------------------------------------------------
// UTF-8 字节帮手（浏览器安全：TextEncoder；与 live-aggregator.ts sliceByBytes 同纪律——
// 不切断多字节序列与代理对，切位=代码单元）。
// ---------------------------------------------------------------------
let enc: TextEncoder | null = null;
function encoder(): TextEncoder {
  if (enc === null) enc = new TextEncoder();
  return enc;
}

/** UTF-8 字节数（无 Buffer 依赖——协议包需浏览器侧可用）。 */
export function byteLenUtf8(s: string): number {
  return encoder().encode(s).byteLength;
}

/** UTF-8 安全预截：返回最长前缀（代码单元切位，不切多字节序列/代理对）使字节 ≤ maxBytes。
 *  truncated=实际切过（字节预算未容纳全文）。 */
export function sliceUtf8Safe(s: string, maxBytes: number): { text: string; truncated: boolean } {
  if (maxBytes < 0) return { text: "", truncated: s.length > 0 };
  const full = byteLenUtf8(s);
  if (full <= maxBytes) return { text: s, truncated: false };
  // 二分代码单元切位：找最大 c 使 slice(0,c) 字节 ≤ maxBytes。
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (byteLenUtf8(s.slice(0, mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  // lo=最大安全切位。字节上界≤maxBytes 已保证；lo===0 且 maxBytes<首码位字节→空串（truncated 仍真）。
  return { text: s.slice(0, lo), truncated: true };
}

/** 编码后字节截断（argsPreview 专用）：超限则切至 ≤maxBytes（安全预截同纪律）。 */
export function capEncodedBytes(s: string, maxBytes: number): { text: string; truncated: boolean } {
  return sliceUtf8Safe(s, maxBytes);
}

// ---------------------------------------------------------------------
// 装帧
// ---------------------------------------------------------------------

/** 块内容编码前字节（粗估账：text/thinking=正文；toolCall=argsPreview；attachment=无变量内容记 0）。 */
function blockBytes(b: EntryBlock): number {
  switch (b.kind) {
    case "text":
    case "thinking":
      return byteLenUtf8(b.text);
    case "toolCall":
      return byteLenUtf8(b.argsPreview);
    case "attachment":
      return 0;
  }
}

interface SliceableState {
  /** 保留代码单元数（Infinity=全文）。 */
  kept: number;
}

interface AssembleInput {
  readonly requestId: string;
  readonly entryId: string;
  readonly digest: string;
  readonly blocks: readonly EntryBlock[];
  readonly stopReason?: "stop" | "length" | "aborted" | "toolUse";
  /** 全行字节数（§4.5b：对全行含隐藏 thinking；仅 ok 态入帧）。 */
  readonly rawBytes: number;
}

export type AssembleEntryResult = { readonly frame: EntryFrame } | { readonly oversized: true };

function renderBlock(b: EntryBlock, st: SliceableState): EntryBlock {
  if ((b.kind === "text" || b.kind === "thinking") && st.kept !== Infinity) {
    const cut = Math.min(st.kept, b.text.length);
    return { kind: b.kind, text: b.text.slice(0, cut), truncatedAt: cut };
  }
  return b;
}

/** 两段式装帧。返回 frame（state=ok|truncated）或 {oversized:true}（末块切空仍超——4414 专用）。 */
export function assembleEntryFrame(input: AssembleInput): AssembleEntryResult {
  const budget = LIMITS.singleEventBytes - ENTRY_FRAME_ENVELOPE_RESERVE_BYTES; // 30_720 编码前字节
  const n = input.blocks.length;

  // 段1：粗估快筛（按块序；先到先装；放不下→安全预截至剩余量；其后块全部省略）。
  const state: SliceableState[] = [];
  let used = 0;
  let firstOmitted = n; // 其后块全省略
  for (let i = 0; i < n; i++) {
    const b = input.blocks[i] as EntryBlock;
    const need = blockBytes(b);
    if (need <= budget - used) {
      state.push({ kept: Infinity });
      used += need;
      continue;
    }
    if (b.kind === "text" || b.kind === "thinking") {
      const { text } = sliceUtf8Safe(b.text, budget - used);
      state.push({ kept: text.length });
    } else {
      firstOmitted = i; // 不可预截（attachment 无变量内容/toolCall 已限 512）——本块起省略
    }
    break;
  }

  // 段2：终判整帧实测+末块再切片（每轮保留代码单元严格递减→必终止；下界=空串）。
  for (;;) {
    const keptCount = state.length;
    const omitted = n - keptCount;
    const truncated = omitted > 0 || state.some((s, i) => {
      const b = input.blocks[i] as EntryBlock;
      return (b.kind === "text" || b.kind === "thinking") && s.kept !== Infinity;
    });
    const blocks = input.blocks.slice(0, keptCount).map((b, i) => renderBlock(b, state[i] as SliceableState));
    const frame: EntryFrame = {
      t: "entry",
      requestId: input.requestId,
      entryId: input.entryId,
      source: "session",
      digest: input.digest,
      state: truncated ? "truncated" : "ok",
      blocks,
      ...(input.stopReason !== undefined ? { stopReason: input.stopReason } : {}),
      ...(truncated ? {} : { rawBytes: input.rawBytes }),
      ...(n > 0 ? { totalBlockCount: n } : {}),
    };
    if (estimateFrameBytes(frame) <= LIMITS.singleEventBytes) return { frame };

    // 超限：找最后一个可再切的 text/thinking 块（保留>0）。
    let idx = -1;
    for (let i = keptCount - 1; i >= 0; i--) {
      const b = input.blocks[i] as EntryBlock;
      const s = state[i] as SliceableState;
      if ((b.kind === "text" || b.kind === "thinking") && s.kept > 0) { idx = i; break; }
    }
    if (idx === -1) return { oversized: true }; // 末块切空仍超=显式失败（4414 oversized）
    const s = state[idx] as SliceableState;
    const cur = s.kept === Infinity ? (input.blocks[idx] as Extract<EntryBlock, { kind: "text" | "thinking" }>).text.length : s.kept;
    s.kept = cur > 1 ? Math.floor(cur / 2) : 0; // 严格递减（>1→半；1→0）
  }
}
