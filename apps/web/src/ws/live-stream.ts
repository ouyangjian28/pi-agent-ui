// D2 直播正文组装器（纯逻辑零依赖，组件面=components/live-stream.tsx）。
// 职责：把 LiveEvent v1.1 直播三形（message-delta/message-part-end/message-final）装配成可渲染文本。
// 渲染态机按 D1 契约事实设计（docs/ws-ui-contracts-v1.md §3.4 + K3 r2 审报⑤节）：
// ①final 权威，delta 可零帧——「无 delta 直接 final」是合法路径，finalText 非空即取代增量拼接；
// ②part-end 不保证到达也不保证唯一——只作幂等闭合标记，缺锚不影响渲染（final/下一段自闭合）；
// ③预算触发=正常路径——「delta 骤停+final 到达」即普通 final 替换，无错误态；
// ④liveSeq 可回退（重订阅重置）——数组级重置检测在组件面（长度回退即整体重来），本层无序号概念；
// ⑤message-delta 无轮次身份——「final 后再来 delta」按新一轮处理（整体重置后重新累积），
//   本轮/上轮归属 UI 不做（后续立项）。
// 性能：applyLiveEvent 只改可变状态（O(1) 摊还），拼接发生在 liveTextOf/thinkingTextOf 取值时——
// 调用方（组件 rAF 批处理）保证每帧至多取一次，千级 delta 不触发逐事件渲染。

import type { LiveEvent } from "@pi-agent-ui/protocol/src/contracts"; // 绕开 barrel（同 subscribe-client）

/** 单一内容段（按 (part, contentIndex) 分立；text 与 thinking 各一列）。 */
export interface LiveStreamPart {
  readonly contentIndex: number;
  /** 已累积增量文本（mutable：追加在原地，避免逐事件分配新串）。 */
  text: string;
  /** part-end 闭合锚（幂等记录；渲染不依赖——缺锚由 final/下一段自闭合，事实②）。 */
  closed: boolean;
}

export interface LiveStreamState {
  /** 正文段列，contentIndex 升序。 */
  readonly textParts: LiveStreamPart[];
  /** 思考段列，contentIndex 升序（服务端缺省不透，通常为空——折叠区留槽可空设计）。 */
  readonly thinkingParts: LiveStreamPart[];
  /** message-final 终局全文（权威）：非 null 即取代增量拼接（窗内残留可能缺尾，整体作废）。 */
  finalText: string | null;
}

export function createLiveStreamState(): LiveStreamState {
  return { textParts: [], thinkingParts: [], finalText: null };
}

/** 取/建 contentIndex 对应段（升序维持：常态追加尾部，乱序到达防御性插入）。 */
function partOf(parts: LiveStreamPart[], contentIndex: number): LiveStreamPart {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p === undefined) break;
    if (p.contentIndex === contentIndex) return p;
    if (p.contentIndex < contentIndex) {
      const created: LiveStreamPart = { contentIndex, text: "", closed: false };
      parts.splice(i + 1, 0, created);
      return created;
    }
  }
  const created: LiveStreamPart = { contentIndex, text: "", closed: false };
  parts.unshift(created);
  return created;
}

/** 整体清空（turn 边界：正文落历史后调用；或组件面检测到直播数组重置）。 */
export function clearLiveStream(state: LiveStreamState): void {
  state.textParts.length = 0;
  state.thinkingParts.length = 0;
  state.finalText = null;
}

/**
 * 应用一条 LiveEvent。非直播三形（pi-progress/turn-state/process-note）与正文面无关，忽略。
 * 幂等口径：空 delta 忽略；part-end 重复/对未知段到达均安全；final 可重复（同值覆盖）。
 */
export function applyLiveEvent(state: LiveStreamState, event: LiveEvent): void {
  switch (event.kind) {
    case "message-delta": {
      if (event.delta === "") return; // 空增量幂等吸收
      // 事实⑤：final 后再来 delta=新一轮开始（无轮次身份，只能以此划界）——整体重置再累积
      if (state.finalText !== null) clearLiveStream(state);
      const parts = event.part === "text" ? state.textParts : state.thinkingParts;
      partOf(parts, event.contentIndex).text += event.delta;
      return;
    }
    case "message-part-end": {
      // 事实②：闭合锚幂等——重复打标无害；缺失不影响渲染；对未知段到达=无操作（不建档，防空段占位）
      const parts = event.part === "text" ? state.textParts : state.thinkingParts;
      const p = parts.find((x) => x.contentIndex === event.contentIndex);
      if (p !== undefined) p.closed = true;
      return;
    }
    case "message-final": {
      // 事实①③：终局全文权威——增量残留（窗内缺尾/预算骤停）整体作废
      state.textParts.length = 0;
      state.finalText = event.text;
      return;
    }
    default:
      return; // pi-progress / turn-state / process-note：正文面不消费
  }
}

/** 当前可渲染正文：final 权威优先；否则按 contentIndex 升序拼接增量（段间换行）。 */
export function liveTextOf(state: LiveStreamState): string {
  if (state.finalText !== null) return state.finalText;
  return state.textParts.map((p) => p.text).join("\n");
}

/** 当前可渲染思考流（缺省不渲染——组件折叠区开关默认关；内容可为空）。 */
export function thinkingTextOf(state: LiveStreamState): string {
  return state.thinkingParts.map((p) => p.text).join("\n");
}

/** 是否有任何可展示内容（空态整体不渲染，不占位）。 */
export function liveStreamEmpty(state: LiveStreamState): boolean {
  return liveTextOf(state) === "" && thinkingTextOf(state) === "";
}
