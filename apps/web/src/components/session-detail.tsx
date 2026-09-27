// A1b 会话详情组件：只读流消费面——历史分页加载+直播追加+四空态（loading/empty/error/auth-failed）
// + 流终局态（resync-needed/unsubscribed/closed）。纯文本渲染：textPreview.text 只作 React 文本节点，
// 无 innerHTML/dangerouslySetInnerHTML。只读面：唯一动作=4409 终局后的用户显式「续读」（resyncFromCursor，
// subscribe 家族读帧）；无任何写操作入口（prompt/stop 不在本面）。

import React from "react";
import { useSessionDetail } from "../ws/use-session-detail";
import type { SubscribeClientSurface } from "../ws/subscribe-client";
import type { HistoryEvent, LiveEvent } from "@pi-agent-ui/protocol/src/contracts";

const KIND_LABELS: Readonly<Record<HistoryEvent["kind"], string>> = {
  "turn-enqueued": "回合入队",
  "turn-engaged": "回合开始",
  "turn-consumed": "回合消费",
  "turn-cancelled": "回合取消",
  sending: "发送中",
  "response-timeout": "响应超时",
  clear: "清屏",
  "corrupt-entry": "损坏条目",
  "journal-corrupt": "日志损坏",
  "verdict-delivered": "判定已投递",
  "verdict-settled": "判定已落定",
  "verdict-unknown": "判定未知",
  "unknown-line": "未知行",
  message: "消息",
};

const ROLE_LABELS: Readonly<Record<string, string>> = {
  user: "用户",
  assistant: "助手",
  toolCall: "工具调用",
  toolResult: "工具结果",
  system: "系统",
};

function HistoryItem({ event }: { event: HistoryEvent }) {
  const extra =
    event.kind === "message"
      ? `${ROLE_LABELS[event.role] ?? event.role}${event.final ? "·完结" : ""}${event.textPreview ? `：${event.textPreview.text}${event.textPreview.truncated ? "…" : ""}` : ""}`
      : event.kind === "turn-enqueued"
        ? event.preview.text + (event.preview.truncated ? "…" : "")
        : "";
  return (
    <li>
      <span className="row-title">
        #{event.seq} {KIND_LABELS[event.kind]}
      </span>
      {extra ? <small> {extra}</small> : null}
    </li>
  );
}

function liveText(event: LiveEvent): string {
  switch (event.kind) {
    case "pi-progress": return `进度 ${event.piType}（${event.note}）`;
    case "turn-state": return `回合状态：${event.turn.state}`;
    case "process-note": return `进程${event.phase === "running" ? "运行" : "停止"}通知`;
  }
}

export function SessionDetail({ client, file }: { client: SubscribeClientSurface; file: string | null }) {
  const view = useSessionDetail(client, file);
  if (view.status === "loading") {
    return (
      <div className="empty" role="status" aria-busy="true">
        <h2>正在加载会话详情…</h2>
        <p>{file === null ? "尚未选择会话。" : `正在连接并订阅 ${file}。`}</p>
      </div>
    );
  }
  if (view.status === "auth-failed") {
    return (
      <div className="empty" role="alert">
        <h2>认证失败</h2>
        <p>{view.errorMessage ?? "服务拒绝了访问令牌（4401）。请检查令牌后刷新页面重试。"}</p>
      </div>
    );
  }
  if (view.status === "error") {
    return (
      <div className="empty" role="alert">
        <h2>会话详情加载失败</h2>
        <p>{view.errorMessage ?? "服务返回了错误。"}</p>
      </div>
    );
  }
  if (view.status === "closed") {
    return (
      <div className="empty" role="alert">
        <h2>连接已关闭</h2>
        <p>与服务的连接已断开，且当前版本不自动重连。刷新页面可重新连接。</p>
      </div>
    );
  }
  if (view.status === "unsubscribed") {
    return (
      <div className="empty" role="status">
        <h2>未订阅会话</h2>
        <p>当前没有活动的会话订阅。</p>
      </div>
    );
  }
  if (view.status === "empty") {
    return (
      <div className="empty">
        <h2>空会话</h2>
        <p>该会话文件没有任何事件（空文件或刚创建）。</p>
      </div>
    );
  }
  // streaming / resync-needed：内容可见（直播追加区域 aria-live=polite 即时播报）
  return (
    <section className="session-detail" aria-label="会话详情">
      <header>
        <h2>{view.file ?? file}</h2>
        {view.statusSummary ? (
          <small>
            {view.statusSummary.process} · {view.statusSummary.turn}
          </small>
        ) : null}
      </header>
      {view.banner ? (
        <p className="banner" role="status">
          {view.banner}
          {view.canResync ? (
            <>
              {" "}
              <button type="button" onClick={() => client.resyncFromCursor()}>
                继续读取
              </button>
            </>
          ) : null}
        </p>
      ) : null}
      <ol className="history-list" aria-label="历史事件">
        {view.events.map((event) => (
          <HistoryItem key={event.seq} event={event} />
        ))}
      </ol>
      {view.paging ? (
        <p role="status" aria-busy="true">
          正在加载更多历史…
        </p>
      ) : null}
      {view.liveEvents.length > 0 ? (
        <ul className="live-list" aria-live="polite" aria-label="直播事件">
          {view.liveEvents.map((event, index) => (
            <li key={index}>{liveText(event)}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
