// A1c 写输入组件（归属整改重写：本文件由 Kimi 亲手重写，DOM 结构/类名/文案与视觉基建批 475e071
// 之后的状态逐项保真——重写非返工）。
// 职责：受控文本域+发送/停止按钮+状态行+错误横幅+最近结果行。
//
// 保真清单（重写锚点，对应 write-client/use-write 契约）：
// ①受控文本（value/onChange），无 innerHTML/dangerouslySetInnerHTML；服务端自由文本（error.message、
//   not-ready.cause）永不入 DOM——结果文案只做 kind 域内映射（launched 的 intentId/commandId、exit 的
//   code/signal 为服务端受类型域约束的进程事实，作为文本节点渲染）；
// ②禁用态三源：未选会话（file=null）/连接未就绪（!view.ready）/在途（sending∨stopping）；发送另有空文本
//   （text.length===0，与 write-client 本地预校验同口径）；停止在 sending 态保持可用——「发送后立即停止」
//   合法流（prompt×stop 按 requestId 分账并行）；
// ③无乐观 UI：按钮/状态只在 ack/error 结算后切态（view 由快照派生，快照只在结算时变更）；
// ④错误横幅 role="alert"（view.errorMessage 恒受控文案）；状态行 role="status" aria-live="polite"；
// ⑤无自动重试：错误后恢复=用户改文本/再点发送（瞬态错误随新尝试清除）；发送成功后清空文本域。
// K5-B1 草稿身份门：ack 后的清空只作用于「本次发送所对应的、未被后续编辑替换的草稿」——发送时快照
//   （client×file×草稿版本号），ack 回调里三者均未变才清空；版本号只认「是否发生过编辑」
//   （编辑后改回同文本=版本已变，不清空），不做字符串相等比较。在途编辑/换会话/换 client 后的旧 ack
//   一律不清空当前草稿。

import React, { useRef, useState } from "react";
import { useWrite } from "../ws/use-write";
import type { WriteClientSurface, WriteLastResult } from "../ws/write-client";
import type { WriteSendOutcomeDTO, WriteStopOutcomeDTO } from "@pi-agent-ui/protocol/src/contracts";

/** prompt 结果文案（kind 域内映射；not-ready.cause=服务端自由文本，不渲染）。 */
function promptOutcomeText(outcome: WriteSendOutcomeDTO): string {
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

/** stop 结果文案（kind 域内映射）。 */
function stopOutcomeText(outcome: WriteStopOutcomeDTO): string {
  switch (outcome.kind) {
    case "confirmed":
      return `已停止（exit code=${outcome.exit.code === null ? "无" : outcome.exit.code}${outcome.exit.signal === null ? "" : ` signal=${outcome.exit.signal}`}）`;
    case "deadline-exceeded": return "停止超时：进程未在期限内退出";
    case "no-process": return "无进程可停止";
    case "stopping": return "停止信号已发出，进程退出中";
  }
}

/** 最近结果行文案：成功分支走 outcome 映射；失败分支=write-client 受控文案。 */
function lastResultText(result: WriteLastResult): string | null {
  if (result.ok) return result.kind === "prompt" ? promptOutcomeText(result.outcome) : stopOutcomeText(result.outcome);
  return result.message;
}

export function WriteComposer({ client, file }: { client: WriteClientSurface; file: string | null }) {
  const { view, send, stop } = useWrite(client, file);
  const [text, setText] = useState("");
  // K5-B1 草稿身份门：draftVersion 每次编辑递增（含改回同文本）；identityRef 每次渲染刷新为当前
  // client/file（旧发送的迟到 ack 闭包读到的旧身份与之比对）。ref 而非 state：ack 回调需读最新值，
  // 且版本递增不应触发额外重渲染。
  const draftVersion = useRef(0);
  // 会话身份（file）变更即新草稿：render 期派生重置（React 官方模式，不依赖调用方 key）；
  // client 替换不重置（半写草稿跨连接保留，旧连接 ack 由 B1 身份门拒清）。
  const [draftFile, setDraftFile] = useState<string | null>(file);
  if (draftFile !== file) {
    setDraftFile(file);
    setText("");
    draftVersion.current += 1; // 旧发送闭包的版本比对同步失效（双保险）
  }
  const identityRef = useRef({ client, file });
  identityRef.current = { client, file };

  const canSend = file !== null && view.ready && !view.sending && !view.stopping && text.length > 0;
  const canStop = file !== null && view.ready && !view.stopping;

  const phaseText =
    view.phase === "sending" ? "发送中…"
    : view.phase === "stopping" ? "停止中…"
    : view.phase === "error" ? "写连接异常"
    : file === null ? "未选择会话"
    : view.ready ? "可发送"
    : "写连接未就绪";

  const onChange = (value: string): void => {
    draftVersion.current += 1; // 任何编辑（含改回同文本）都替换草稿身份
    setText(value);
  };

  const onSend = (): void => {
    // 发送时快照：本次发送对应的 client/file/草稿版本。ack 后仅当三者均未变（即文本域仍是
    // 本次发送的那份未编辑草稿、会话与连接身份未换）才清空；否则保留当前草稿（迟到 ack 不得
    // 吞掉用户在途新输入）。
    const sent = { client, file, version: draftVersion.current };
    void send(text).then((ok) => {
      if (
        ok &&
        identityRef.current.client === sent.client &&
        identityRef.current.file === sent.file &&
        draftVersion.current === sent.version
      ) {
        setText(""); // 仅合法 ack 后清空（无乐观 UI）
      }
    });
  };

  return (
    <section className="write-composer" aria-label={`写消息${file === null ? "" : `：${file}`}`}>
      <label>
        写入消息
        <textarea
          value={text}
          onChange={(event) => onChange(event.target.value)}
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
