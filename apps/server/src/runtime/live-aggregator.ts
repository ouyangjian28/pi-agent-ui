// D1 直播面聚合器（docs/d1-live-stream-design.md）：pi 进程事件→LiveEvent 流。
// 职责三段：①过滤（disp!=="delivered" 不广播=未记账轮次不外泄；thinking 缺省不透；
// final 只透 assistant——system 事件含全工具清单不外泄，user 已知无价值）②节流（同 (part,
// contentIndex) 增量窗内合并；窗到/8KiB 上限/part-end/final 即时 flush）③预算（单帧 ≤8KiB
// 超长切分；单 turn 广播总量 2MiB 软上限——超限停 delta 只发 final，防失控输出刷爆慢订阅）。
// 归属：per-file 实例（composition 持有；turn 边界事件（agent_settled）自动清窗）。
// 背压不在本层：出口=engine.onLiveEvent（pushBacklog 超限→4431 关订阅，既有语义）。

import type { LiveEvent } from "@pi-agent-ui/protocol";

/** 本层产出的三形（LiveEvent 子集；类型直取 protocol 契约，不自造同构形）。 */
export type LiveContentEvent = Extract<LiveEvent, { kind: "message-delta" | "message-part-end" | "message-final" }>;

export type LiveSink = (ev: LiveContentEvent) => void;

export interface LiveAggregatorOpts {
  /** 节流窗（毫秒；缺省 80）。窗内同段增量合并一帧；窗到 flush。 */
  readonly windowMs?: number;
  /** 单帧增量字节上限（缺省 8192）。超长 delta 切分多帧（帧序=切段序，前端按序拼接）。 */
  readonly maxChunkBytes?: number;
  /** 单 turn 广播总字节软上限（缺省 2MiB）。超限停 delta（final 仍发）。 */
  readonly turnBudgetBytes?: number;
  /** thinking 段透传开关（缺省 false：保守不透）。 */
  readonly thinkingVisible?: boolean;
  /** 延迟调度（缺省 setTimeout）——测试注入驱动节流窗。 */
  readonly schedule?: (fn: () => void, ms: number) => () => void;
}

const DEFAULT_WINDOW_MS = 80;
const DEFAULT_MAX_CHUNK = 8192;
const DEFAULT_TURN_BUDGET = 2 * 1024 * 1024;

interface PiAssistantMessageEvent {
  readonly type?: unknown;
  readonly contentIndex?: unknown;
  readonly delta?: unknown;
}

interface PiEvent {
  readonly type?: unknown;
  readonly message?: { readonly role?: unknown; readonly content?: unknown } | null;
  readonly assistantMessageEvent?: PiAssistantMessageEvent | null;
}

/** message_end 全文提取：content 为 string 直取；数组取 type==="text" 段拼接
 *  （与 e2e assistantBodyText 同规——thinking 段不并入）。其余形→null。 */
export function assistantFinalText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  let out = "";
  for (const seg of content) {
    if (typeof seg === "object" && seg !== null && (seg as { type?: unknown }).type === "text"
        && typeof (seg as { text?: unknown }).text === "string") {
      out += (seg as { text: string }).text;
    }
  }
  return out;
}

/** D1 disposition 门（docs/d1-live-stream-design.md §5）：buffered/delivered 均广播
 *（buffered=response 未回绑的正常回复期，记账行已在 enqueue 时落）；dropped-stale-generation
 *（旧代事件——新写者已接管）/overflow-closed（gate 溢出已弃）不广播。 */
export function shouldBroadcastLive(disposition: string): boolean {
  return disposition !== "dropped-stale-generation" && disposition !== "overflow-closed";
}

export class LiveAggregator {
  private readonly windowMs: number;
  private readonly maxChunk: number;
  private readonly turnBudget: number;
  private readonly thinkingVisible: boolean;
  private readonly schedule: (fn: () => void, ms: number) => () => void;

  /** 窗内累积（键=part:contentIndex）。pending 尾帧可能超 maxChunk（flush 时切分）。 */
  private readonly pending = new Map<string, { part: "text" | "thinking"; contentIndex: number; text: string }>();
  private timer: (() => void) | null = null;
  private turnBytes = 0;
  private overBudget = false;

  constructor(opts: LiveAggregatorOpts = {}) {
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxChunk = opts.maxChunkBytes ?? DEFAULT_MAX_CHUNK;
    this.turnBudget = opts.turnBudgetBytes ?? DEFAULT_TURN_BUDGET;
    this.thinkingVisible = opts.thinkingVisible ?? false;
    this.schedule = opts.schedule ?? ((fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); });
  }

  /** pi 事件入口（调用方已保证 disposition==="delivered"）。返回=false 表事件面不可识别（忽略）。 */
  onPiEvent(ev: unknown, sink: LiveSink): boolean {
    const e = ev as PiEvent;
    switch (e.type) {
      case "agent_start": case "turn_start": case "agent_end": case "turn_end":
        return true; // 边界观测：turn_end 后由调用方 flush（onTurnEnd）
      case "agent_settled":
        this.flush(sink, "all"); // turn 收尾：已收增量不丢+每段补 part-end（异常流无 message_end）
        return true;
      case "message_start":
        return true;
      case "message_update": {
        const a = e.assistantMessageEvent;
        if (a === null || typeof a !== "object") return false;
        switch (a.type) {
          case "thinking_start": case "text_start": return true;
          case "thinking_end": {
            // 段闭锚：即时 flush 全窗 delta（可见段才发 part-end——thinking_end 在不可见时无帧）
            this.flush(sink, this.thinkingVisible ? { part: "thinking", contentIndex: typeof a.contentIndex === "number" ? a.contentIndex : 0 } : null);
            return true;
          }
          case "text_end": {
            this.flush(sink, { part: "text", contentIndex: typeof a.contentIndex === "number" ? a.contentIndex : 0 });
            return true;
          }
          case "thinking_delta": {
            if (!this.thinkingVisible || typeof a.delta !== "string") return true;
            this.pushDelta("thinking", a.contentIndex, a.delta, sink);
            return true;
          }
          case "text_delta": {
            if (typeof a.delta !== "string") return true;
            this.pushDelta("text", a.contentIndex, a.delta, sink);
            return true;
          }
          default:
            return false; // 未知 assistantMessageEvent（tool 等）→摘要面（pi-progress）职责，本层忽略
        }
      }
      case "message_end": {
        const m = e.message;
        if (m === null || typeof m !== "object" || m.role !== "assistant") return true; // user/system 不透
        const text = assistantFinalText(m.content);
        if (text === null) return true;
        this.dropPending(); // 窗内残留丢弃（终局全文为权威，避免前缀重复）
        this.emit(sink, { kind: "message-final", role: "assistant", text });
        return true;
      }
      case "extension_ui_request": case "response":
        return false; // 非会话内容面
      default:
        return false;
    }
  }

  /** turn 收口（turn_end/agent_settled 后调用）：清窗。 */
  onTurnEnd(sink: LiveSink): void {
    this.flush(sink, "all");
  }

  private pushDelta(part: "text" | "thinking", contentIndex: unknown, delta: string, sink: LiveSink): void {
    if (this.overBudget) return; // 超限停 delta（final 仍发）
    const idx = typeof contentIndex === "number" ? contentIndex : 0;
    const key = `${part}:${idx}`;
    const cur = this.pending.get(key);
    if (cur !== undefined) cur.text += delta;
    else this.pending.set(key, { part, contentIndex: idx, text: delta });
    // 预算=入窗即计（不等 flush）：超限→窗内已收（含触发条）全发后停后续（final 仍发）
    this.turnBytes += delta.length;
    if (this.turnBytes > this.turnBudget) {
      this.overBudget = true;
      this.flush(sink, "all");
      return;
    }
    if (cur === undefined) this.armWindow(sink); // 首段增量开窗
  }

  private armWindow(sink: LiveSink): void {
    if (this.timer !== null) return;
    this.timer = this.schedule(() => {
      this.timer = null;
      this.flush(sink, null);
    }, this.windowMs);
  }

  /** 丢弃窗内残留（final 权威到达）。 */
  private dropPending(): void {
    if (this.timer !== null) { this.timer(); this.timer = null; }
    this.pending.clear();
  }

  /** 清窗发射：同段合并文本按 maxChunk 切分多帧。partEnd=null 只发 delta（节流窗到）；
   *  对象=该段闭（delta 后补该段 part-end，窗内其它段不动）；"all"=每段补 part-end（turn 异常收尾）。
   *  预算在 emit 累计（字节=入窗即计），超限停 delta。 */
  private flush(sink: LiveSink, partEnd: { part: "text" | "thinking"; contentIndex: number } | "all" | null): void {
    if (this.timer !== null) { this.timer(); this.timer = null; }
    if (this.pending.size === 0) {
      if (partEnd !== null && partEnd !== "all") this.emit(sink, { kind: "message-part-end", part: partEnd.part, contentIndex: partEnd.contentIndex });
      return;
    }
    const items = [...this.pending.entries()].sort((a, b) => a[1].part.localeCompare(b[1].part) || a[1].contentIndex - b[1].contentIndex);
    this.pending.clear();
    for (const [, it] of items) {
      let rest = it.text;
      while (rest.length > 0) {
        const take = rest.length <= this.maxChunk ? rest : rest.slice(0, this.maxChunk);
        rest = rest.length <= this.maxChunk ? "" : rest.slice(this.maxChunk);
        this.emit(sink, { kind: "message-delta", part: it.part, contentIndex: it.contentIndex, delta: take });
        // overBudget 不中断本次 flush（语义=停后续入窗；已触发发射完整送出）
      }
      if (partEnd === "all" || (partEnd !== null && partEnd.part === it.part && partEnd.contentIndex === it.contentIndex)) {
        this.emit(sink, { kind: "message-part-end", part: it.part, contentIndex: it.contentIndex });
      }
    }
    // 段闭但窗内无该段（delta 已被此前 flush 清走）：仍补 part-end（闭段信号不丢）
    if (partEnd !== null && partEnd !== "all") {
      const seen = items.some(([, it]) => it.part === partEnd.part && it.contentIndex === partEnd.contentIndex);
      if (!seen) this.emit(sink, { kind: "message-part-end", part: partEnd.part, contentIndex: partEnd.contentIndex });
    }
  }

  private emit(sink: LiveSink, ev: LiveContentEvent): void {
    sink(ev); // 预算已入窗即计（pushDelta）；emit 纯发射
  }
}
