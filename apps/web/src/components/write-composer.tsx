// A1c 写输入组件：受控文本域+发送/停止按钮+状态行+错误横幅。
// 红线（对应 write-client/use-write 契约）：
// ①受控文本（value/onChange），无 innerHTML/dangerouslySetInnerHTML；服务端自由文本（error.message、
//   not-ready.cause）永不入 DOM——结果文案只做 kind 域内映射（launched 的 intentId/commandId、exit 的
//   code/signal 为服务端受类型域约束的进程事实，作为文本节点渲染）；
// ②禁用态三源：未选会话（file=null）/连接未就绪（!view.ready）/在途（sending∨stopping）；发送另有空文本
//   （text.length===0，与 write-client 本地预校验同口径）；停止在 sending 态保持可用——「发送后立即停止」
//   合法流（prompt×stop 按 requestId 分账并行）；
// ③无乐观 UI：按钮/状态只在 ack/error 结算后切态（view 由快照派生，快照只在结算时变更）；
// ④错误横幅 role="alert"（view.errorMessage 恒受控文案）；状态行 role="status" aria-live="polite"；
// ⑤无自动重试：错误后恢复=用户改文本/再点发送（瞬态错误随新尝试清除）；发送成功后清空文本域。

import React, { useState } from "react";
import { useWrite } from "../ws/use-write";
import type { WriteClientSurface, WriteLastResult } from "../ws/write-client";
import type { WriteSendOutcomeDTO, WriteStopOutcomeDTO } from "@pi-agent-ui/protocol/src/contracts";

/** prompt 结果文案（kind 域内映射；not-ready.cause=服务端自由文本，不渲染）。 */
function sendOutcomeText(outcome: WriteSendOutcomeDTO): string {
  switch (outcome.kind) {
    case "launched": return `已入队（intentId=${outcome.intentId}）`;
    case "busy": return "未入队：写宿主忙";
    case "gate-rejected": return outcome.reason === "busy" ? "被写门拒绝：宿主忙" : "被写门拒绝：会话已关闭";
    case "gate-failed": return `写门失败（${outcome.stage === "enqueue" ? "入队" : "发送"}阶段）`;
    case "invalidated": {
      const stage = { "enqueue": "入队", "sending": "发送", "post-send": "发送后", "first-byte": "首字节前" }[outcome.stage];
      return `消息已作废（${stage}阶段）`;
    }
    case "no-process": return "未入队：无写进程";
    case "not-ready": return "未入队：会话未就绪";
  }
}

/** stop 结果文案。 */
function stopOutcomeText(outcome: WriteStopOutcomeDTO): string {
  switch (outcome.kind) {
    case "confirmed":
      return `已停止（exit code=${outcome.exit.code === null ? "无" : outcome.exit.code}${outcome.exit.signal === null ? "" : ` signal=${outcome.exit.signal}`}）`;
    case "deadline-exceeded": return "停止超时：进程未在期限内退出";
    case "no-process": return "无进程可停止";
    case "stopping": return "停止信号已发出，进程退出中";
  }
}

function lastResultText(result: WriteLastResult): string | null {
  if (result.ok) return result.kind === "prompt" ? sendOutcomeText(result.outcome) : stopOutcomeText(result.outcome);
  return result.message; // 失败分支：write-client 受控文案
}

export function WriteComposer({ client, file }: { client: WriteClientSurface; file: string | null }) {
  const { view, send, stop } = useWrite(client, file);
  const [text, setText] = useState("");

  const canSend = file !== null && view.ready && !view.sending && !view.stopping && text.length > 0;
  const canStop = file !== null && view.ready && !view.stopping;

  const phaseText =
    view.phase === "sending" ? "发送中…"
    : view.phase === "stopping" ? "停止中…"
    : view.phase === "error" ? "写连接异常"
    : file === null ? "未选择会话"
    : view.ready ? "可发送"
    : "写连接未就绪";

  const onSend = (): void => {
    void send(text).then((ok) => {
      if (ok) setText(""); // 仅合法 ack 后清空（无乐观 UI）
    });
  };

  return (
    <section className="write-composer" aria-label={`写消息${file === null ? "" : `：${file}`}`}>
      <label>
        写入消息
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          aria-label="写入消息内容"
          rows={3}
          disabled={file === null || !view.ready}
          placeholder={file === null ? "先选择会话" : "输入要发送给写宿主的消息"}
        />
      </label>
      <div className="write-actions">
        <button type="button" onClick={onSend} disabled={!canSend}>
          发送
        </button>
        <button type="button" onClick={() => void stop()} disabled={!canStop}>
          停止
        </button>
        <span role="status" aria-live="polite">
          {phaseText}
        </span>
      </div>
      {view.errorMessage !== null ? (
        <p className="banner" role="alert">
          {view.errorMessage}
        </p>
      ) : null}
      {view.lastResult !== null ? (
        <p role="status">{lastResultText(view.lastResult)}</p>
      ) : null}
    </section>
  );
}
