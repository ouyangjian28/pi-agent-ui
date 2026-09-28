// A1b 会话详情组件（归属整改重写：Kimi 亲手重写，DOM 结构/视觉令牌类名/文案与视觉基建批 475e071
// 之后的状态逐项保真——重写非返工）。
// 只读渲染面：历史分页加载+直播追加+空态族（loading/empty/error/auth-failed/closed/unsubscribed）
// +流终局态（resync-needed/stopped）。纯文本渲染：textPreview.text 只作 React 文本节点，
// 无 innerHTML/dangerouslySetInnerHTML。
// 结构保真（K5-B2 稳定挂载）：根元素恒为 section.session-detail（根类型不随视图切换变化）；
// 根下槽位 0=视图体（空态族=div.empty，内容族=Fragment 包裹的 header/banner/history/paging/live），
// 槽位 1 恒为 composer（WriteComposer key=file）——空态↔内容态切换不卸载重建编辑器（草稿/在途保留）；
// 换会话=新 composer 实例（key=file，旧草稿不泄入新会话，属预期重置）。
// composer 展示面：注入 writeClient 且 file 非空且视图∈{empty, streaming, resync-needed, stopped}；
// loading/auth-failed/error/closed/unsubscribed 不展示（既有行为）。
// C4：stopped 终局诚实标注恢复入口=上层重选文件（当前版本无重建按钮，不做自动重发/自动重订）。

import React from "react";
import { useSessionDetail } from "../ws/use-session-detail";
import type { SubscribeClientSurface } from "../ws/subscribe-client";
import { WriteComposer } from "./write-composer";
import type { WriteClientSurface } from "../ws/write-client";
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
  "journal-repair": "日志修复",
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

function HistoryRow({ event }: { event: HistoryEvent }) {
  const detail =
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
      {detail ? <small> {detail}</small> : null}
    </li>
  );
}

function liveEventText(event: LiveEvent): string {
  switch (event.kind) {
    case "pi-progress": return `进度 ${event.piType}（${event.note}）`;
    case "turn-state": return `回合状态：${event.turn.state}`;
    case "process-note": return `进程${event.phase === "running" ? "运行" : "停止"}通知`;
    // D1 直播三形（v1.1）：文本化占位——D2 渲染批替换为真流式正文渲染
    case "message-delta": return `［${event.part === "text" ? "正文" : "思考"}增量］${event.delta}`;
    case "message-part-end": return `［${event.part === "text" ? "正文" : "思考"}段尾］`;
    case "message-final": return `［助手全文］${event.text}`;
  }
}

export function SessionDetail({
  client,
  file,
  writeClient = null,
}: {
  client: SubscribeClientSurface;
  file: string | null;
  /** 可选写面（A1c 挂点）：注入即挂写输入（独立写连接）；不注入=纯只读视图，既有调用点零改动。 */
  writeClient?: WriteClientSurface | null;
}) {
  const view = useSessionDetail(client, file);
  // 槽位 1（A1c 写面稳定挂载）：仅注入 writeClient 且已选会话且视图∈{empty, streaming,
  // resync-needed, stopped} 时展示；loading/auth-failed/error/closed/unsubscribed 不展示（既有行为）。
  // key=file——同一槽位换会话强制新 composer 实例（旧草稿不泄入新会话）；同一会话内视图切换实例保留
  //（草稿/在途/结果态不丢）。
  const composerVisible =
    writeClient !== null && file !== null &&
    (view.status === "empty" || view.status === "streaming" || view.status === "resync-needed" || view.status === "stopped");
  const composer = composerVisible ? <WriteComposer key={file} client={writeClient} file={file} /> : null;

  // 槽位 0（视图体）：空态族=div.empty（role/aria 语义保留）；内容族=Fragment 包裹的既有结构。
  let body: React.ReactNode;
  if (view.status === "loading") {
    body = (
      <div className="empty" role="status" aria-busy="true">
        <h2>正在加载会话详情…</h2>
        <p>{file === null ? "尚未选择会话。" : `正在连接并订阅 ${file}。`}</p>
      </div>
    );
  } else if (view.status === "auth-failed") {
    body = (
      <div className="empty" role="alert">
        <h2>认证失败</h2>
        <p>{view.errorMessage ?? "服务拒绝了访问令牌（4401）。请检查令牌后刷新页面重试。"}</p>
      </div>
    );
  } else if (view.status === "error") {
    body = (
      <div className="empty" role="alert">
        <h2>会话详情加载失败</h2>
        <p>{view.errorMessage ?? "服务返回了错误。"}</p>
      </div>
    );
  } else if (view.status === "closed") {
    body = (
      <div className="empty" role="alert">
        <h2>连接已关闭</h2>
        <p>与服务的连接已断开，且当前版本不自动重连。刷新页面可重新连接。</p>
      </div>
    );
  } else if (view.status === "unsubscribed") {
    body = (
      <div className="empty" role="status">
        <h2>未订阅会话</h2>
        <p>当前没有活动的会话订阅。</p>
      </div>
    );
  } else if (view.status === "empty") {
    body = (
      <div className="empty">
        <h2>空会话</h2>
        <p>该会话文件没有任何事件（空文件或刚创建）。</p>
      </div>
    );
  } else {
    // streaming / resync-needed / stopped：内容可见（直播追加区域 aria-live=polite 即时播报）
    body = (
      <>
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
            ) : view.status === "stopped" ? (
              <>
                {" "}内容已冻结（终局）——当前版本无重建按钮；如需继续读取，请重新选择会话文件。
              </>
            ) : null}
          </p>
        ) : null}
        <ol className="history-list" aria-label="历史事件">
          {view.events.map((event) => (
            <HistoryRow key={event.seq} event={event} />
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
              <li key={index}>{liveEventText(event)}</li>
            ))}
          </ul>
        ) : null}
      </>
    );
  }
  return (
    <section className="session-detail" aria-label="会话详情">
      {body}
      {composer}
    </section>
  );
}
