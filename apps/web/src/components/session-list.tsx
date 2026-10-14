// R1：四互斥自然日组；分页/partial/恢复提示可发现；传输空态不降级。
import React, { useEffect, useState } from "react";
import { useSessions } from "../ws/use-sessions";
import { resolveTitle } from "../ws/resolve-title";
import { groupSessions } from "../ws/session-groups";
import type { WsClient } from "../ws/ws-client";
export function SessionList({ client, selectedFile = null, onSelect }: {
  client: Pick<WsClient, "subscribe" | "getSnapshot" | "requestSessions"> & Partial<Pick<WsClient, "requestMoreSessions">>;
  selectedFile?: string | null;
  onSelect?: (file: string) => void;
}) {
  const view = useSessions(client);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const current = new Date();
    const tomorrow = new Date(current.getFullYear(), current.getMonth(), current.getDate() + 1);
    const timer = setTimeout(() => setNow(new Date()), Math.max(1, tomorrow.getTime() - current.getTime()));
    const visible = () => { if (document.visibilityState === "visible") setNow(new Date()); };
    document.addEventListener("visibilitychange", visible);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", visible); };
  }, [now]);
  if (view.status === "ready") return <section className="session-list-region" aria-label="会话列表区">
    {view.sessions.length === 0 ? <div className="empty"><h2>还没有会话</h2><p>点「＋新对话」开始，或从这里继续历史会话。</p></div> :
      <ul className="session-list" aria-label="会话列表">{groupSessions(view.sessions, now).filter((group) => group.sessions.length).map((group) =>
        <li className="session-group" key={group.label}><h3>{group.label}</h3><ul>{group.sessions.map((session) => {
          const title = <><span className="row-title">{resolveTitle(session)}</span><small>{session.entryCount} 条消息{session.hasRecoveryNotice ? " · 需要核对" : ""}{session.listReliability === "partial" ? " · 信息不完整" : ""}</small></>;
          return <li key={session.file}>{onSelect ? <button type="button" aria-current={selectedFile === session.file ? "page" : undefined} onClick={() => onSelect(session.file)}>{title}</button> : title}</li>;
        })}</ul></li>
      )}</ul>}
    <div className="list-pagination"><small>已载 {view.sessions.length} / 共 {view.total}</small>{view.partial && <p role="note">列表信息不完整，可能还有未列出的会话。</p>}{view.pageError && <p role="alert">{view.pageError}</p>}
      {view.hasMore && <button type="button" disabled={view.paging} onClick={() => client.requestMoreSessions?.()}>{view.paging ? "加载中…" : view.pageError ? "重试加载更多" : "加载更多"}</button>}
    </div>
  </section>;
  if (view.status === "loading") return <div className="empty" role="status" aria-busy="true"><h2>正在加载会话…</h2><p>正在连接服务并拉取会话列表。</p></div>;
  if (view.status === "auth-failed") return <div className="empty" role="alert"><h2>认证失败</h2><p>服务拒绝了访问令牌（4401）。请检查令牌后重新输入。</p></div>;
  if (view.status === "error") return <div className="empty" role="alert"><h2>会话列表加载失败</h2><p>{view.errorMessage ?? "服务返回了错误。"}</p></div>;
  if (view.status === "closed") return <div className="empty" role="alert"><h2>连接已关闭</h2><p>正在尝试重新连接，也可从顶部连接明细立即重连。</p></div>;
  return null;
}
