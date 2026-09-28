// D2 直播正文渲染组件：消费 LiveEvent v1.1 三形（组装态机=../ws/live-stream.ts 纯逻辑）。
// 性能面（任务③）：增量只进可变 ref（applyLiveEvent O(1) 摊还），显示态经 rAF 批处理提交——
// 一帧至多一次 setState，千级 delta 不逐事件渲染。
// 重置检测（事实④ liveSeq 可回退）：liveEvents 数组缩短（重订阅/换流重建）即整体清零从头处理；
// 同长度替换不检测（subscribe-client 保证 append-only 扩展/缩短重置两形）。
// 历史衔接（任务②）：history 出现 assistant message 行=本轮正文已移交历史区，清直播缓冲防重复显示；
// 同一提交批内先处理 history 再处理 live（因果序：历史落行先于下一轮 delta）。
// thinking 缺省不渲染：折叠区留槽可空（有内容才出开关），开关默认关。
import React, { useEffect, useRef, useState } from "react";
import type { HistoryEvent, LiveEvent } from "@pi-agent-ui/protocol/src/contracts"; // 绕开 barrel（同 subscribe-client）
import {
  applyLiveEvent,
  clearLiveStream,
  createLiveStreamState,
  liveStreamEmpty,
  liveTextOf,
  thinkingTextOf,
  type LiveStreamState,
} from "../ws/live-stream";

interface DisplayState {
  readonly text: string;
  readonly thinking: string;
}

const EMPTY_DISPLAY: DisplayState = { text: "", thinking: "" };

// rAF 批处理调度：jsdom/测试环境无 rAF 时回退宏任务（同帧合并语义不变）
const scheduleFrame: (cb: () => void) => number =
  typeof requestAnimationFrame === "function"
    ? (cb) => requestAnimationFrame(cb)
    : (cb) => Number(setTimeout(cb, 0)); // Number 归一：DOM 返回 number / Node 类型渗入时返回 Timeout 对象，两域安全
const cancelFrame: (id: number) => void =
  typeof cancelAnimationFrame === "function" ? (id) => cancelAnimationFrame(id) : (id) => clearTimeout(id);

export function LiveStreamView({
  liveEvents,
  historyEvents,
}: {
  readonly liveEvents: readonly LiveEvent[];
  readonly historyEvents: readonly HistoryEvent[];
}) {
  const stateRef = useRef<LiveStreamState | null>(null);
  const liveCountRef = useRef(0);
  const histCountRef = useRef(0);
  const frameRef = useRef<number | null>(null);
  const pendingRef = useRef<DisplayState | null>(null);
  const [display, setDisplay] = useState<DisplayState>(EMPTY_DISPLAY);
  const [showThinking, setShowThinking] = useState(false);

  if (stateRef.current === null) stateRef.current = createLiveStreamState();

  useEffect(() => {
    const state = stateRef.current;
    if (state === null) return;
    // 直播面重置（事实④：重订阅/换流后数组重建、liveSeq 回退）——缩短即整体重来
    if (liveEvents.length < liveCountRef.current) {
      clearLiveStream(state);
      liveCountRef.current = 0;
    }
    if (historyEvents.length < histCountRef.current) histCountRef.current = 0;
    // 历史衔接（任务②）：assistant 正文落历史 → 直播缓冲清空本轮，防重复显示
    for (let i = histCountRef.current; i < historyEvents.length; i++) {
      const ev = historyEvents[i];
      if (ev !== undefined && ev.kind === "message" && ev.role === "assistant") clearLiveStream(state);
    }
    histCountRef.current = historyEvents.length;
    // 增量合并：只处理新增帧（ref 累积，不逐帧 setState）
    for (let i = liveCountRef.current; i < liveEvents.length; i++) {
      const ev = liveEvents[i];
      if (ev !== undefined) applyLiveEvent(state, ev);
    }
    liveCountRef.current = liveEvents.length;
    // rAF 批处理提交：一帧至多一次 setState；同值不提交（引用保持，下游不重渲）
    pendingRef.current = { text: liveTextOf(state), thinking: thinkingTextOf(state) };
    if (frameRef.current === null) {
      frameRef.current = scheduleFrame(() => {
        frameRef.current = null;
        const pending = pendingRef.current;
        if (pending === null) return;
        pendingRef.current = null;
        setDisplay((prev) => (prev.text === pending.text && prev.thinking === pending.thinking ? prev : pending));
      });
    }
  }, [liveEvents, historyEvents]);

  // 卸载取消化待提交帧
  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelFrame(frameRef.current);
    },
    [],
  );

  if (display.text === "" && display.thinking === "") return null;
  return (
    <div className="live-stream" aria-live="polite" aria-label="直播正文">
      {display.text !== "" ? <p className="live-stream-text">{display.text}</p> : null}
      {display.thinking !== "" ? (
        <div className="live-stream-thinking">
          <button type="button" aria-expanded={showThinking} onClick={() => setShowThinking((v) => !v)}>
            思考过程
          </button>
          {showThinking ? <p className="live-stream-thinking-body">{display.thinking}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

export { liveStreamEmpty };
