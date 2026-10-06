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
// D2 直播正文面：LiveStreamView 流式渲染 v1.1 三形（final 权威/增量 rAF 批合/正文落历史即清本轮）；
// live-list 退为旁路面——只收 pi-progress/turn-state/process-note 三形，正文三形不再文本化占位。
// D3-F：旁路面增 ui-note（LiveEvent v1.2，按 notifyType 三级配色 class）；直播区附近挂 UiDialog 区
// （快照 uiRequests→四法对话框，答案经 client.answerUi 回 ui-answer 帧）。

import React from "react";
import { useSessionDetail } from "../ws/use-session-detail";
import type { SubscribeClientSurface } from "../ws/subscribe-client";
import { WriteComposer } from "./write-composer";
import { LiveStreamView } from "./live-stream";
import { UiDialog } from "./ui-dialog";
import type { WriteClientSurface } from "../ws/write-client";
import type { EntryBlock, EntryFrame, HistoryEvent, LiveEvent } from "@pi-agent-ui/protocol/src/contracts";

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

type MessageHistoryEvent = Extract<HistoryEvent, { readonly kind: "message" }>;

/** D4 批③：展开按钮触发口径（§4.4 P3-N8 裁决，三条件其一）——hasThinking（门开）/可见块数>0/预览被截断；
 *  toolCall-only/attachment-only 条目（无 textPreview）经 blockCount 条件也有入口。 */
function expandable(event: HistoryEvent): event is MessageHistoryEvent {
  return (
    event.kind === "message" &&
    (event.hasThinking === true || (event.blockCount ?? 0) > 0 || event.textPreview?.truncated === true)
  );
}

/** D4 批③：展开态（组件本地缓存值；key=entryId）。 */
type ExpansionState =
  | { readonly status: "loading" }
  | { readonly status: "ok"; readonly frame: EntryFrame }
  | { readonly status: "error"; readonly message: string };

function kbOf(bytes: number): string {
  return (bytes / 1024).toFixed(1);
}

/** 可见块字节估算（truncated 态文案用：text/thinking 正文+argsPreview 长度；rawBytes  truncated 帧 wire 级缺席不展示）。 */
function visibleBytesOf(blocks: readonly EntryBlock[]): number {
  let total = 0;
  for (const block of blocks) {
    if (block.kind === "text" || block.kind === "thinking") total += block.text.length;
    else if (block.kind === "toolCall") total += block.argsPreview.length;
  }
  return total;
}

/** 单块渲染：text 正文；thinking 折叠区默认收起（门开才有 thinking 块）；toolCall=toolName+argsPreview
 * （argsPreview 服务端已 denylist 净化，直接展示）；attachment 只显 id（不回原始内容）。 */
function EntryBlockView({ block }: { block: EntryBlock }) {
  switch (block.kind) {
    case "text":
      return (
        <p className="entry-text">
          {block.text}
          {block.truncatedAt !== undefined ? "…" : ""}
        </p>
      );
    case "thinking":
      return (
        <details className="entry-thinking">
          <summary>思考</summary>
          <p>
            {block.text}
            {block.truncatedAt !== undefined ? "…" : ""}
          </p>
        </details>
      );
    case "toolCall":
      return (
        <p className="entry-toolcall">
          <small>
            工具调用：{block.toolName ?? "（未知工具）"}
            {block.argsPreview ? `：${block.argsPreview}` : ""}
            {block.argsTruncated === true ? "…" : ""}
          </small>
        </p>
      );
    case "attachment":
      return (
        <p className="entry-attachment">
          <small>附件：{block.attachmentId}</small>
        </p>
      );
  }
}

/** 展开态渲染（§4.4）：blocks 逐块；truncated 态文案「已截断·可见 X KB / Y 块」+不可再放大；
 *  ok 态可显示 rawBytes（行无截断，规模无泄露面）。 */
function ExpandedEntry({ frame }: { frame: EntryFrame }) {
  return (
    <div className="entry-fulltext">
      {frame.state === "truncated" ? (
        <p className="entry-truncated" role="note">
          已截断·可见 {kbOf(visibleBytesOf(frame.blocks))} KB / {frame.blocks.length} 块
        </p>
      ) : frame.rawBytes !== undefined ? (
        <p className="entry-size">
          <small>全文 {kbOf(frame.rawBytes)} KB</small>
        </p>
      ) : null}
      {frame.blocks.map((block, index) => (
        <EntryBlockView key={index} block={block} />
      ))}
    </div>
  );
}

function HistoryRow({
  event,
  expansion = null,
  onExpand = null,
}: {
  event: HistoryEvent;
  /** D4 批③：本条目的展开态（null=未展开）。 */
  expansion?: ExpansionState | null;
  onExpand?: ((event: MessageHistoryEvent) => void) | null;
}) {
  const detail =
    event.kind === "message"
      ? `${ROLE_LABELS[event.role] ?? event.role}${event.final ? "·完结" : ""}${event.textPreview ? `：${event.textPreview.text}${event.textPreview.truncated ? "…" : ""}` : ""}`
      : event.kind === "turn-enqueued"
        ? event.preview.text + (event.preview.truncated ? "…" : "")
        : "";
  const chat = event.kind === "message" && (event.role === "user" || event.role === "assistant");
  return (
    <li className={chat ? `chat-message chat-${event.role}` : "activity-row"}>
      {chat ? <><small className="message-author">{event.role === "user" ? "你" : "pi"}</small>{expansion?.status !== "ok" && <p className="chat-preview">{event.textPreview?.text ?? "（附件或非文本内容）"}{event.textPreview?.truncated ? "…" : ""}</p>}</> : <><span className="row-title">#{event.seq} {KIND_LABELS[event.kind]}</span>{detail ? <small> {detail}</small> : null}</>}
      {expandable(event) && expansion === null && onExpand !== null ? (
        <button type="button" className="entry-expand" onClick={() => onExpand(event)}>
          展开
        </button>
      ) : null}
      {expansion?.status === "loading" ? (
        <button type="button" className="entry-expand" disabled>
          加载中…
        </button>
      ) : null}
      {expansion?.status === "error" ? (
        <span className="entry-error" role="alert">
          <small> {expansion.message}</small>
          {expandable(event) && onExpand !== null ? (
            <button type="button" className="entry-expand" onClick={() => onExpand(event)}>
              重试
            </button>
          ) : null}
        </span>
      ) : null}
      {expansion?.status === "ok" ? <ExpandedEntry frame={expansion.frame} /> : null}
    </li>
  );
}

/** 直播三形以外的旁路事件（进度/回合/进程 + D3 ui-note 即显通知）——正文三形由 LiveStreamView 流式渲染。 */
type SideLiveEvent = Exclude<
  LiveEvent,
  { readonly kind: "message-delta" } | { readonly kind: "message-part-end" } | { readonly kind: "message-final" }
>;

function isSideLiveEvent(event: LiveEvent): event is SideLiveEvent {
  return (
    event.kind === "pi-progress" || event.kind === "turn-state" || event.kind === "process-note" || event.kind === "ui-note"
  );
}

const NOTE_LABELS: Readonly<Record<"info" | "warning" | "error", string>> = {
  info: "通知",
  warning: "警告",
  error: "错误",
};

function liveEventText(event: SideLiveEvent): string {
  switch (event.kind) {
    case "pi-progress": return `进度 ${event.piType}（${event.note}）`;
    case "turn-state": return `回合状态：${event.turn.state}`;
    case "process-note": return `进程${event.phase === "running" ? "运行" : "停止"}通知`;
    case "ui-note": return `${NOTE_LABELS[event.notifyType]}：${event.message}`;
  }
}

/** ui-note 三级配色 class（info/warning/error）；其余旁路事件无附加 class。 */
function liveEventClass(event: SideLiveEvent): string | undefined {
  return event.kind === "ui-note" ? `live-note live-note-${event.notifyType}` : undefined;
}

export function SessionDetail({
  client,
  file,
  writeClient = null,
  title = null,
  managed = false,
}: {
  client: SubscribeClientSurface;
  file: string | null;
  /** 可选写面（A1c 挂点）：注入即挂写输入（独立写连接）；不注入=纯只读视图，既有调用点零改动。 */
  writeClient?: WriteClientSurface | null;
  /** M-UX 批1修复 P1-02：壳传入的同源标题（resolveTitle 唯一真值源；null=回退 file 显示，壳层未算出时）。 */
  title?: string | null;
  /** RealApp 单 owner 持有订阅与 composer，本组件只呈现。 */
  managed?: boolean;
}) {
  const view = useSessionDetail(client, file, !managed);
  const generationRef = React.useRef({ client, file, subscriptionId: view.subscriptionId });
  if (generationRef.current.client !== client || generationRef.current.file !== file || generationRef.current.subscriptionId !== view.subscriptionId) {
    generationRef.current = { client, file, subscriptionId: view.subscriptionId };
  }
  const generationKey = generationRef.current;
  // D4 批③：展开缓存（组件本地 state，key=entryId；§4.4 P3-N7——换 file/流终局一并清，
  // 与 subscribe-client entryRequests 清理同址精神：session 文件改写后不残留旧全文）。
  const [expansions, setExpansions] = React.useState<ReadonlyMap<string, ExpansionState>>(new Map());
  /** GLM 审批③ P3-2：当前 file 的同步镜像（promise 迟到回包丢弃判据——ref 随渲染换代无闭包冻结）。 */
  const fileRef = React.useRef(file);
  fileRef.current = file;
  React.useEffect(() => {
    setExpansions(new Map());
  }, [generationKey]);
  React.useEffect(() => {
    if (view.status === "stopped" || view.status === "resync-needed") setExpansions(new Map());
  }, [view.status]);
  const onExpand = React.useCallback(
    (event: MessageHistoryEvent) => {
      if (file === null) return;
      const entryId = event.entryId;
      setExpansions((prev) => new Map(prev).set(entryId, { status: "loading" }));
      void client.expandEntry(file, entryId).then((result) => {
        // GLM 审批③ P3-2 修复：换 file 后旧 promise 迟到回包不写入新 file 的缓存（旧 entryId 跨文件可重合，
        // 错位写入会把 A 文件的错误/全文显示在 B 文件同 id 条目上）。fileRef 随 [file] effect 同步换代。
        if (fileRef.current !== file || generationRef.current !== generationKey) return;
        setExpansions((prev) => {
          const next = new Map(prev);
          next.set(entryId, result.ok ? { status: "ok", frame: result.frame } : { status: "error", message: result.message });
          return next;
        });
      });
    },
    [client, file, generationKey],
  );
  // 槽位 1（A1c 写面稳定挂载）：仅注入 writeClient 且已选会话且视图∈{empty, streaming,
  // resync-needed, stopped} 时展示；loading/auth-failed/error/closed/unsubscribed 不展示（既有行为）。
  // key=file——同一槽位换会话强制新 composer 实例（旧草稿不泄入新会话）；同一会话内视图切换实例保留
  //（草稿/在途/结果态不丢）。
  const composerVisible =
    !managed && writeClient !== null && file !== null &&
    (view.status === "empty" || view.status === "streaming" || view.status === "resync-needed" || view.status === "stopped");
  const composer = composerVisible ? <WriteComposer key={file} client={writeClient} file={file} /> : null;

  // D3-F 扩展问答区（直播区附近的稳定槽位）：快照有活跃提问即堆叠渲染；答案经 client.answerUi 发
  // ui-answer 帧并本地移除。连接/订阅终局时客户端已清空 uiRequests，无需按视图态过滤。
  const dialog =
    view.uiRequests.length > 0 ? (
      <UiDialog requests={view.uiRequests} onAnswer={(requestId, answer) => client.answerUi(requestId, answer)} />
    ) : null;

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
        <p>正在尝试重新连接，也可从顶部连接明细立即重连。未决消息不会自动补发。</p>
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
        {/* P1-02 空态残余（GPT R2）：空会话同样显示统一会话标题，空态提示保留 */}
        <h2>{title ?? view.file ?? file}</h2>
        <p>空会话：该会话文件没有任何事件（空文件或刚创建）。</p>
      </div>
    );
  } else {
    // streaming / resync-needed / stopped：内容可见（直播追加区域 aria-live=polite 即时播报）
    body = (
      <>
        <header>
          <h2>{title ?? view.file ?? file}</h2>
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
          {view.events.filter((event) => event.kind === "message" && (event.role === "user" || event.role === "assistant")).map((event) => (
            <HistoryRow
              key={event.seq}
              event={event}
              expansion={event.kind === "message" ? (expansions.get(event.entryId) ?? null) : null}
              onExpand={onExpand}
            />
          ))}
        </ol>
        {view.paging ? (
          <p role="status" aria-busy="true">
            正在加载更多历史…
          </p>
        ) : null}
        <LiveStreamView liveEvents={view.liveEvents} historyEvents={view.events} generationKey={generationKey} />
        {view.responseTimeoutNotice && <p className="banner response-timeout-banner" role="alert">{view.responseTimeoutNotice}</p>}
        {view.events.some((event) => ["verdict-unknown", "journal-corrupt", "corrupt-entry"].includes(event.kind)) && <p className="banner" role="alert">历史存在结果未知或损坏记录，请查看活动详情核对；不要据此重复发送。</p>}
        {view.liveEvents.some((event) => event.kind === "ui-note" && event.notifyType !== "info") && <p className="banner" role="alert">有新的警告或错误通知，请查看活动详情。</p>}
        {(view.events.some((event) => event.kind !== "message" || (event.role !== "user" && event.role !== "assistant")) || view.liveEvents.some(isSideLiveEvent)) && <details className="activity-details"><summary>活动详情</summary>
          <ol className="activity-list" aria-label="活动事件">{view.events.filter((event) => event.kind !== "message" || (event.role !== "user" && event.role !== "assistant")).map((event) => <HistoryRow key={event.seq} event={event} expansion={event.kind === "message" ? expansions.get(event.entryId) ?? null : null} onExpand={onExpand} />)}</ol>
          {view.liveEvents.some(isSideLiveEvent) && <ul className="live-list" aria-live="polite" aria-label="直播事件">{view.liveEvents.filter(isSideLiveEvent).map((event, index) => <li key={index} className={liveEventClass(event)}>{liveEventText(event)}</li>)}</ul>}
        </details>}
      </>
    );
  }
  return (
    <section className="session-detail" aria-label="会话详情">
      {body}
      {dialog}
      {composer}
    </section>
  );
}
