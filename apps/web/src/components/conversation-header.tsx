import React from "react";
export function ConversationHeader({
  title,
  isNew,
  onBack,
  onNew,
  canCreate,
  status,
  actions,
}: {
  title: string;
  isNew: boolean;
  onBack: () => void;
  onNew: () => void;
  canCreate: boolean;
  status?: string | undefined;
  actions?: React.ReactNode;
}) {
  return (
    <header className="conversation-header">
      <button type="button" className="back-to-list" aria-label="会话列表" onClick={onBack}>
        ← <span>会话</span>
      </button>
      <div className="conversation-heading">
        <h2 tabIndex={-1}>{title}</h2>
        <small>{status ?? (isNew ? "选择待发模型，直接开始" : "会话模型以服务端实际为准")}</small>
      </div>
      {!isNew && (
        <button
          type="button"
          className="new-model-conversation"
          aria-label="换模型开新对话"
          disabled={!canCreate}
          onClick={onNew}
        >
          <span className="model-new-full">换模型开新对话</span>
          <span className="model-new-short" aria-hidden="true">
            换模型
          </span>
        </button>
      )}
      {actions && <div className="conversation-tools">{actions}</div>}
    </header>
  );
}
