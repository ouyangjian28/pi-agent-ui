import React from "react";
export function ConversationHeader({ title, isNew, onBack, onNew, canCreate, status }: { title: string; isNew: boolean; onBack: () => void; onNew: () => void; canCreate: boolean; status?: string | undefined }) {
  return <header className="conversation-header">
    <button type="button" className="back-to-list" aria-label="会话列表" onClick={onBack}>← <span>会话</span></button>
    <div className="conversation-heading"><h2 tabIndex={-1}>{title}</h2><small>{status ?? (isNew ? "选择待发模型，直接开始" : "会话模型以服务端实际为准")}</small></div>
    {!isNew && <button type="button" className="new-model-conversation" disabled={!canCreate} onClick={onNew}>换模型开新对话</button>}
  </header>;
}
