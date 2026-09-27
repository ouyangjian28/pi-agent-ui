// A1a 会话列表组件：四空态 loading/empty/error/auth-failed（closed 终态同走提示面）。
// 纯文本渲染：SanitizedText.text 只作 React 文本节点，无 innerHTML/dangerouslySetInnerHTML；
// 只读面——不渲染任何写操作入口，也不发送任何帧（发帧全在 WsClient）。

import React from "react";
import { useSessions } from "../ws/use-sessions";
import type { WsClient } from "../ws/ws-client";

export function SessionList({
  client,
  selectedFile = null,
  onSelect,
}: {
  client: Pick<WsClient, "subscribe" | "getSnapshot">;
  /** A1d 组合根选择面：提供 onSelect 即把条目渲染为按钮（aria-current 标记选中）；缺省=纯展示（既有行为零改动）。 */
  selectedFile?: string | null;
  onSelect?: (file: string) => void;
}) {
  const view = useSessions(client);
  if (view.status === "loading") {
    return (
      <div className="empty" role="status" aria-busy="true">
        <h2>正在加载会话…</h2>
        <p>正在连接服务并拉取会话列表。</p>
      </div>
    );
  }
  if (view.status === "auth-failed") {
    return (
      <div className="empty" role="alert">
        <h2>认证失败</h2>
        <p>服务拒绝了访问令牌（4401）。请检查令牌后刷新页面重试。</p>
      </div>
    );
  }
  if (view.status === "error") {
    return (
      <div className="empty" role="alert">
        <h2>会话列表加载失败</h2>
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
  if (view.sessions.length === 0) {
    return (
      <div className="empty">
        <h2>还没有会话</h2>
        <p>服务端会话目录为空。</p>
      </div>
    );
  }
  return (
    <ul className="session-list" aria-label="会话列表">
      {view.sessions.map((session) => {
        const title = (
          <>
            <span className="row-title">
              {session.title.text}
              {session.title.truncated ? "…" : ""}
            </span>
            <small>
              {session.file} · {session.entryCount} 条
            </small>
          </>
        );
        return (
          <li key={session.file}>
            {onSelect ? (
              <button
                type="button"
                aria-current={selectedFile === session.file ? "page" : undefined}
                onClick={() => onSelect(session.file)}
              >
                {title}
              </button>
            ) : (
              title
            )}
          </li>
        );
      })}
    </ul>
  );
}
