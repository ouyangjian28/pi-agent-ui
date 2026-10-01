// R1 v6 §2.5：每个 final 独立定格，历史不提供覆盖证明，绝不自动删除。
// 收起仅视觉投影；唯一清理=订阅/file/client 世代更换。rAF 保留千级增量批处理。
import React, { useEffect, useRef, useState } from "react";
import type { HistoryEvent, LiveEvent } from "@pi-agent-ui/protocol/src/contracts";
import {
  applyLiveEvent,
  clearLiveStream,
  createLiveStreamState,
  liveStreamEmpty,
  liveTextOf,
  thinkingTextOf,
} from "../ws/live-stream";
interface FrozenReply {
  readonly id: number;
  readonly text: string;
  readonly thinking: string;
  readonly collapsed: boolean;
}
interface Display {
  readonly text: string;
  readonly thinking: string;
  readonly replies: readonly FrozenReply[];
}
const empty = (): Display => ({ text: "", thinking: "", replies: [] });
const schedule = (callback: () => void): ReturnType<typeof setTimeout> | number =>
  typeof requestAnimationFrame === "function" ? requestAnimationFrame(callback) : setTimeout(callback, 0);
const cancel = (id: ReturnType<typeof setTimeout> | number) => {
  if (typeof cancelAnimationFrame === "function" && typeof id === "number") cancelAnimationFrame(id);
  else clearTimeout(id);
};
export function LiveStreamView({
  liveEvents,
  historyEvents: _historyEvents,
  generationKey = null,
}: {
  readonly liveEvents: readonly LiveEvent[];
  readonly historyEvents: readonly HistoryEvent[];
  readonly generationKey?: unknown;
}) {
  const state = useRef(createLiveStreamState());
  const count = useRef(0);
  const prior = useRef<readonly LiveEvent[]>([]);
  const generation = useRef(generationKey);
  const frozen = useRef<FrozenReply[]>([]);
  const serial = useRef(0);
  const frame = useRef<ReturnType<typeof setTimeout> | number | null>(null);
  const pending = useRef<Display>(empty());
  const [display, setDisplay] = useState<Display>(empty());
  const [opened, setOpened] = useState<ReadonlySet<number>>(new Set());
  const [showThinking, setShowThinking] = useState(false);
  useEffect(() => {
    const replaced = count.current > 0 && liveEvents.length > 0 && prior.current[0] !== liveEvents[0];
    if (generation.current !== generationKey || liveEvents.length < count.current || replaced) {
      generation.current = generationKey;
      count.current = 0;
      clearLiveStream(state.current);
      frozen.current = [];
      serial.current = 0;
      setOpened(new Set());
      setShowThinking(false);
    }
    for (let i = count.current; i < liveEvents.length; i++) {
      const event = liveEvents[i];
      if (!event) continue;
      if (event.kind === "message-delta" && event.delta !== "" && state.current.finalText !== null) {
        frozen.current = frozen.current.map((reply) => ({ ...reply, collapsed: true }));
        clearLiveStream(state.current);
      }
      applyLiveEvent(state.current, event);
      if (event.kind === "message-final") {
        frozen.current.push({
          id: ++serial.current,
          text: event.text,
          thinking: thinkingTextOf(state.current),
          collapsed: true, // 完整副本保留，默认作为可展开的次级内容；不建立历史配对
        });
      }
    }
    count.current = liveEvents.length;
    prior.current = liveEvents;
    pending.current = {
      text: state.current.finalText === null ? liveTextOf(state.current) : "",
      thinking: state.current.finalText === null ? thinkingTextOf(state.current) : "",
      replies: [...frozen.current],
    };
    if (frame.current === null)
      frame.current = schedule(() => {
        frame.current = null;
        setDisplay(pending.current);
      });
  }, [liveEvents, generationKey]); // 历史数组/计数/正文相同均不是清理或配对依据
  useEffect(
    () => () => {
      if (frame.current !== null) cancel(frame.current);
    },
    [],
  );
  if (display.text === "" && display.thinking === "" && display.replies.length === 0) return null;
  return (
    <div className="live-stream" aria-live="off" aria-label="直播正文">
      <p className="sr-only" role="status" aria-live="polite">
        {display.text !== "" || display.thinking !== "" ? "正在生成回复。" : ""}
        {display.replies.length > 0 ? `已生成 ${display.replies.length} 条回复，归档状态待核对。` : ""}
      </p>
      {display.replies.map((reply) => {
        const expanded = !reply.collapsed || opened.has(reply.id);
        return (
          <article className="live-final retained-reply" key={reply.id}>
            <small className="message-author" title="未与历史记录做对应校验；保留独立来源，不代表二次回复。">实时回复副本 · 未确认入档关联</small>
            {reply.collapsed && (
              <button
                type="button"
                className="frozen-summary"
                aria-expanded={expanded}
                onClick={() =>
                  setOpened((old) => {
                    const next = new Set(old);
                    if (next.has(reply.id)) next.delete(reply.id);
                    else next.add(reply.id);
                    return next;
                  })
                }
              >
                已生成 · {reply.text.slice(0, 40) || "空正文"}
                {reply.text.length > 40 ? "…" : ""}
              </button>
            )}
              <div className="frozen-content" hidden={!expanded}>
                <p className="live-stream-text">{reply.text || "（空正文）"}</p>
                {reply.thinking && (
                  <details>
                    <summary>思考过程</summary>
                    <p>{reply.thinking}</p>
                  </details>
                )}
              </div>
          </article>
        );
      })}
      {display.text !== "" && (
        <article className="chat-message chat-assistant live-generating">
          <small className="message-author">pi · 生成中</small>
          <p className="live-stream-text">{display.text}</p>
        </article>
      )}
      {display.thinking !== "" && (
        <div className="live-stream-thinking">
          <button type="button" aria-expanded={showThinking} onClick={() => setShowThinking((value) => !value)}>
            思考过程
          </button>
          {showThinking && <p className="live-stream-thinking-body">{display.thinking}</p>}
        </div>
      )}
    </div>
  );
}
export { liveStreamEmpty };
