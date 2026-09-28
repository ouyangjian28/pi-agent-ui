// D3-F 扩展问答对话框组件（契约 v1.2，docs/d3-ui-passthrough-design.md §3）：消费快照 uiRequests，
// 渲染 pi 进程内扩展的四种对话族提问（select/confirm/input/editor），收集答案经 onAnswer 回传
// （subscribe-client.answerUi 发 ui-answer 帧并本地移除）。
// 口径：
// ①取消按钮=任何方法都可发 cancelled:true（用户放弃）；
// ②timeoutMs 仅展示「X 秒内未答将自动取消」提示——不自动作答、不倒计时、不撤框（撤框只听 ui-closed）；
// ③多个活跃提问简单堆叠（key=requestId，新提问=新实例，draft 不串题）；
// ④纯受控文本渲染（React 文本节点），样式沿用 .session-detail 令牌/类名惯例，不引新依赖。
import React, { useState } from "react";
import type { UiAnswer, UiRequest } from "../ws/subscribe-client";

const METHOD_TITLES: Readonly<Record<UiRequest["method"], string>> = {
  select: "请选择一项",
  confirm: "请确认",
  input: "请输入",
  editor: "请编辑内容",
};

/** timeoutMs→提示文案（秒级向上取整；仅提示，无任何自动行为）。 */
function timeoutHint(timeoutMs: number | undefined): string | null {
  if (timeoutMs === undefined) return null;
  return `${Math.ceil(timeoutMs / 1000)} 秒内未答将自动取消`;
}

function UiDialogItem({
  request,
  onAnswer,
}: {
  readonly request: UiRequest;
  readonly onAnswer: (requestId: string, answer: UiAnswer) => void;
}) {
  // editor 预填 prefill 为初稿；input 初稿为空。key=requestId 保证换题即新实例（初稿不串题）
  const [draft, setDraft] = useState(request.method === "editor" ? (request.prefill ?? "") : "");
  const answer = (a: UiAnswer): void => onAnswer(request.requestId, a);
  const hint = timeoutHint(request.timeoutMs);

  let body: React.ReactNode;
  switch (request.method) {
    case "select":
      body = (
        <ul className="ui-dialog-options">
          {(request.options ?? []).map((option) => (
            <li key={option}>
              <button type="button" onClick={() => answer({ value: option })}>
                {option}
              </button>
            </li>
          ))}
        </ul>
      );
      break;
    case "confirm":
      body = (
        <>
          {request.message !== undefined ? <p className="ui-dialog-message">{request.message}</p> : null}
          <div className="ui-dialog-actions">
            <button type="button" onClick={() => answer({ confirmed: true })}>
              确认
            </button>
            <button type="button" onClick={() => answer({ confirmed: false })}>
              否
            </button>
          </div>
        </>
      );
      break;
    case "input":
      body = (
        <div className="ui-dialog-actions">
          <input
            type="text"
            value={draft}
            placeholder={request.placeholder ?? ""}
            aria-label="回答输入"
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="button" onClick={() => answer({ value: draft })}>
            提交
          </button>
        </div>
      );
      break;
    case "editor":
      body = (
        <div className="ui-dialog-actions">
          <textarea
            value={draft}
            rows={6}
            aria-label="回答编辑"
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="button" onClick={() => answer({ value: draft })}>
            提交
          </button>
        </div>
      );
      break;
  }

  return (
    <div className="ui-dialog" role="dialog" aria-label={request.title ?? METHOD_TITLES[request.method]}>
      <h3>{request.title ?? METHOD_TITLES[request.method]}</h3>
      {body}
      <div className="ui-dialog-footer">
        {hint !== null ? <small className="ui-dialog-timeout">{hint}</small> : null}
        <button type="button" className="ui-dialog-cancel" onClick={() => answer({ cancelled: true })}>
          取消
        </button>
      </div>
    </div>
  );
}

/** 活跃提问堆叠区：无提问整体不渲染（不占位）。 */
export function UiDialog({
  requests,
  onAnswer,
}: {
  readonly requests: readonly UiRequest[];
  readonly onAnswer: (requestId: string, answer: UiAnswer) => void;
}) {
  if (requests.length === 0) return null;
  return (
    <div className="ui-dialog-stack" aria-label="扩展提问">
      {requests.map((request) => (
        <UiDialogItem key={request.requestId} request={request} onAnswer={onAnswer} />
      ))}
    </div>
  );
}
