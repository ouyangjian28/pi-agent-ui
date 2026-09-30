// A1c 写输入组件（归属整改重写：本文件由 Kimi 亲手重写，DOM 结构/类名/文案与视觉基建批 475e071
// 之后的状态逐项保真——重写非返工）。
// 职责：受控文本域+发送/停止按钮+状态行+错误横幅+最近结果行。
//
// 保真清单（重写锚点，对应 write-client/use-write 契约）：
// ①受控文本（value/onChange），无 innerHTML/dangerouslySetInnerHTML；服务端自由文本（error.message）
//   不入 DOM——结果文案只做 kind 域内映射（launched 的 intentId/commandId、exit 的
//   code/signal 为服务端受类型域约束的进程事实，作为文本节点渲染）。
//   【M-OPS v1.4 政策更新】not-ready.cause/detail 是唯一例外：明文政策已显式裁决（docs/m-ops-design.md §4，
//   知情价值>泄露风险；推翻本文件旧政策「永不入 DOM」）——经 NotReadyBanner 呈现：cause 只作枚举键映射人话，
//   detail（服务端已 ≤500+strip）作纯文本节点（React 默认转义，永不 HTML 渲染）；
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

import React, { useEffect, useRef, useState } from "react";
import { useWrite } from "../ws/use-write";
import { NotReadyBanner } from "./not-ready-banner";
import { ModelPicker, type ModelSource } from "./model-picker";
import { effectiveModel, isSendableModel, MODEL_DEFAULT } from "../ws/draft-model";
import type { EditorSlot, SendResult } from "../ws/conversation-state";
import type { WriteClientSurface, WriteLastResult, WriteResumeResult } from "../ws/write-client";
import type { WriteResumeOutcomeDTO, WriteSendOutcomeDTO, WriteStopOutcomeDTO } from "@pi-agent-ui/protocol/src/contracts";

/** prompt 结果文案（kind 域内映射；not-ready 细节由 NotReadyBanner 呈现，此处只留一行摘要）。 */
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
    case "not-ready": return "未入队：会话未就绪（见下方启动失败红条）";
    case "identity-rejected": return `未入队：写面身份校验拒（${outcome.cause}）`; // r3c 契约枝（web 面补齐）
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

/** resume 结果文案（kind 域内映射；not-ready.cause=服务端自由文本，不渲染）。 */
function resumeOutcomeText(outcome: WriteResumeOutcomeDTO): string {
  switch (outcome.kind) {
    case "identity-rejected": {
      const cause = {
        "no-recovery-data": "该会话无恢复数据",
        "resume-blocked": "恢复面阻断，请先走修复面",
        "resume-not-authorized": "该意图未获重发授权",
        "generation-mismatch": "进程代次已变更",
      }[outcome.cause];
      return `恢复重发被拒：${cause}`;
    }
    case "execution-failed": return "恢复重发失败：原意图载荷不可用";
    case "launched": return `已重发入队（intentId=${outcome.intentId}）`;
    case "busy": return "未重发：写宿主忙";
    case "gate-rejected": return outcome.reason === "busy" ? "被写门拒绝：宿主忙" : "被写门拒绝：会话已关闭";
    case "gate-failed": return `写门失败（${outcome.stage === "enqueue" ? "入队" : "发送"}阶段）`;
    case "invalidated": {
      const stage = { "enqueue": "入队", "sending": "发送", "post-send": "发送后", "first-byte": "首字节前" }[outcome.stage];
      return `重发已作废（${stage}阶段）`;
    }
    case "no-process": return "未重发：无写进程";
    case "not-ready": return "未重发：会话未就绪";
  }
}

/** resume 最近结果行文案：成功分支走 outcome 映射；失败分支=write-client 受控文案。 */
function resumeResultText(result: WriteResumeResult): string {
  return result.ok ? resumeOutcomeText(result.outcome) : result.message;
}

/** 最近结果行文案：成功分支走 outcome 映射；失败分支=write-client 受控文案。 */
function lastResultText(result: WriteLastResult): string | null {
  if (result.ok) return result.kind === "prompt" ? promptOutcomeText(result.outcome) : stopOutcomeText(result.outcome);
  return result.message;
}

export interface ManagedEditor {
  readonly slot: EditorSlot | null;
  readonly source: ModelSource;
  readonly isNew: boolean;
  readonly onEdit: (text: string) => void;
  readonly onConfigure: (choice: string, freeText: string) => void;
  readonly onSend: (confirmed: boolean) => Promise<SendResult>;
  readonly onViewTarget: () => void;
  readonly onCancel: () => void;
}
export function WriteComposer({ client, file, editor }: { client: WriteClientSurface; file: string | null; editor?: ManagedEditor }) {
  const { view, send, stop, resume } = useWrite(client, file);
  const [localText, setText] = useState("");
  const text = editor ? (editor.slot?.text ?? "") : localText;
  const [sendResult, setSendResult] = useState<SendResult | null>(null);
  const result = editor ? (editor.slot?.result ?? null) : sendResult;
  // 恢复重发演示位（v1.1 最小面：手输 intentId+generation 默认 1；完整恢复面板不在本批）
  const [resumeIntentId, setResumeIntentId] = useState("");
  const [resumeGeneration, setResumeGeneration] = useState("1");
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

  const model = editor?.isNew ? effectiveModel(editor.slot?.modelChoice ?? MODEL_DEFAULT, editor.slot?.freeText ?? "") : undefined;
  const pending = editor ? (editor.slot?.operation?.pending === true && editor.slot.operation.client === client) : view.sending;
  const canSend = (editor?.isNew || file !== null) && view.ready && !pending && !view.stopping && text.trim().length > 0 && isSendableModel(model);
  const canStop = file !== null && view.ready && !view.stopping;
  const generationNum = Number(resumeGeneration);
  const canResume =
    file !== null && view.ready && !view.resuming && resumeIntentId.length > 0 && Number.isSafeInteger(generationNum) && generationNum >= 1;

  const phaseText =
    view.phase === "sending" ? "发送中…"
    : view.phase === "stopping" ? "停止中…"
    : view.phase === "resuming" ? "恢复重发中…"
    : view.phase === "error" ? "写连接异常"
    : editor?.isNew ? (view.ready ? "Enter 发送 · Shift+Enter 换行" : "连接中，可先写草稿")
    : file === null ? "未选择会话"
    : view.ready ? "可发送"
    : "写连接未就绪";

  const onChange = (value: string): void => {
    draftVersion.current += 1;
    if (editor) editor.onEdit(value); else setText(value);
  };

  const onSend = (): void => {
    // 发送时快照：本次发送对应的 client/file/草稿版本。ack 后仅当三者均未变（即文本域仍是
    // 本次发送的那份未编辑草稿、会话与连接身份未换）才清空；否则保留当前草稿（迟到 ack 不得
    // 吞掉用户在途新输入）。
    const sent = { client, file, version: draftVersion.current };
    lastSentRef.current = text; // P3-2（DS 审）：not-ready 落账时恢复草稿用（冷启动失败不吞输入）
    if (!canSend) return;
    const confirmed = result?.status === "unknown" ? window.confirm("上一条可能已受理。再次发送可能重复执行，确定再次发送吗？") : false;
    if (result?.status === "unknown" && !confirmed) return;
    if (editor) { void editor.onSend(confirmed); return; }
    void send(text).then((outcome) => {
      setSendResult(outcome);
      if (
        outcome.status === "launched" &&
        identityRef.current.client === sent.client &&
        identityRef.current.file === sent.file &&
        draftVersion.current === sent.version
      ) {
        setText(""); // 仅合法 ack 后清空（无乐观 UI）
      }
    });
  };

  // P3-2（DS 审）：not-ready 落账（resolve true=合法 ack 已清草稿）时恢复草稿——已存会话冷启动
  // 失败不应要求用户重打全文；恢复非用户编辑，不动 draftVersion（重试重发同文本与 NewSession 语义一致）。
  const lastSentRef = useRef("");
  const notReadyNow = view.notReady;
  useEffect(() => {
    if (!editor && notReadyNow !== null && text === "" && lastSentRef.current !== "") {
      setText(lastSentRef.current);
    }
  }, [notReadyNow, text, editor]);

  return (
    <section className="write-composer" aria-label={`写消息${file === null ? "" : `：${file}`}`}>
      {editor?.isNew && <ModelPicker source={editor.source} choice={editor.slot?.modelChoice ?? MODEL_DEFAULT} freeText={editor.slot?.freeText ?? ""} onConfigure={editor.onConfigure} />}
      <label>
        {editor?.isNew ? "首条消息" : "写入消息"}
        <textarea
          value={text}
          onChange={(event) => onChange(event.target.value)}
          aria-label={editor?.isNew ? "首条消息" : "写入消息内容"}
          rows={3}
          disabled={!editor && (file === null || !view.ready)}
          placeholder={editor?.isNew ? "想从哪里开始？" : "继续这段对话…"}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (canSend) { event.preventDefault(); onSend(); }
          }}
        />
      </label>
      <div className="write-actions">
        <button type="button" onClick={onSend} disabled={!canSend}>
          {editor?.isNew ? (pending ? "发送中…" : "发送并开始对话") : "发送"}
        </button>
        {editor?.isNew ? <button type="button" onClick={editor.onCancel}>返回列表</button> : null}
        <button type="button" onClick={() => void stop()} disabled={!canStop || editor?.isNew === true} hidden={editor?.isNew === true}>
          停止
        </button>
        <span role="status" aria-live="polite">
          {phaseText}
        </span>
      </div>
      {result?.status === "unknown" && <div className="send-unknown" role="alert"><p>{result.message}</p>{editor && <button type="button" onClick={editor.onViewTarget}>查看目标会话</button>}{pending && <p>原请求仍在途。请从顶部连接明细立即重连；重连不会自动补发。</p>}</div>}
      {result?.status === "rejected" && result.outcome.kind !== "not-ready" && <p className="banner" role="alert">{promptOutcomeText(result.outcome)}；草稿已保留，可显式重试。</p>}
      {editor && result?.status === "local" && <p className="banner" role="alert">{result.message}</p>}
      {editor && result?.status === "rejected" && result.outcome.kind === "not-ready" && <><NotReadyBanner info={{ cause: result.outcome.cause ?? null, detail: result.outcome.detail ?? null }} onRetry={canSend ? onSend : undefined} onSwitchModel={() => editor.onConfigure(editor.slot?.modelChoice ?? MODEL_DEFAULT, "")} />{model === undefined && <p role="note">重试将不指定模型；本会话此前绑定的模型设置不会被重置，以服务端实际为准</p>}</>}
      {!editor && view.errorMessage !== null && result?.status !== "unknown" ? (
        <p className="banner" role="alert">
          {view.errorMessage}
        </p>
      ) : null}
      {!editor && view.notReady !== null ? (
        <NotReadyBanner info={view.notReady} onRetry={canSend ? onSend : undefined} />
      ) : null}
      {!editor && view.lastResult !== null ? (
        <p role="status">{lastResultText(view.lastResult)}</p>
      ) : null}
      <details className="resume-demo" hidden={editor?.isNew === true}>
        <summary>高级诊断</summary>
        <div className="resume-fields">
          <label>
            意图标识
            <input
              type="text"
              value={resumeIntentId}
              onChange={(event) => setResumeIntentId(event.target.value)}
              aria-label="恢复重发意图标识"
              placeholder="如 i-1"
              disabled={file === null || !view.ready}
            />
          </label>
          <label>
            进程代次
            <input
              type="number"
              min={1}
              step={1}
              value={resumeGeneration}
              onChange={(event) => setResumeGeneration(event.target.value)}
              aria-label="恢复重发进程代次"
              disabled={file === null || !view.ready}
            />
          </label>
          <button
            type="button"
            onClick={() => void resume(resumeIntentId, generationNum)}
            disabled={!canResume}
          >
            恢复重发
          </button>
        </div>
        {view.resuming ? <p role="status">恢复重发中…</p> : null}
        {view.lastResumeResult !== null ? <p role="status">{resumeResultText(view.lastResumeResult)}</p> : null}
      </details>
    </section>
  );
}
