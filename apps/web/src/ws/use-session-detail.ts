// A1b 详情订阅 hook（归属整改重写：Kimi 亲手重写，语义对照契约与 K3 审报逐项保真）。
// 结构：useSyncExternalStore 订阅 SubscribeClient 快照（原生 React 手段，不引状态库）→纯派生
// sessionDetailViewOf(snap, targetFile) 是唯一视图判别来源（组件空态族+流态全靠它）。
// 保真锚点：
// ①连接级优先于订阅相位（connecting/authenticating→loading；closed→closed；error 按 errorKind 细分）；
// ②K3-C 提交期身份门（B3）：快照 file≠目标 file 时，门控视图返回不含旧内容的 loading/连接级视图——
//   file prop 切换、client 实例替换的首次提交不泄漏旧文件事件（不依赖被动 effect 事后清理）；
// ③C4 终局诚实：closed 相位有内容→stopped（冻结内容+受控横幅，绝不伪装 streaming）；
//   无内容→error（errorMessage 缺失时回退 streamNote，受控提示不丢）；
// ④续读无自动重发：resync-needed 只呈现入口（canResync），resyncFromCursor 由组件用户操作触发；
// ⑤订阅生命周期：file 变更即（重新）订阅（挂载=用户打开详情的显式动作），卸载/换目标即退订。

import { useEffect, useSyncExternalStore } from "react";
import type { HistoryEvent, LiveEvent, TurnState } from "@pi-agent-ui/protocol/src/contracts"; // 绕开 barrel（同 subscribe-client）
import type { SessionDetailSnapshot, SubscribeClientSurface, UiRequest } from "./subscribe-client";

export type DetailViewStatus =
  | "loading" // 连接/握手/首订阅在途，或分页中尚无任何内容
  | "streaming" // 分页加载中或直播追加中（内容已可见）
  | "empty" // 订阅成功但空会话文件（H=0：无历史事件亦无直播事件）
  | "resync-needed" // 4409 续读终局：内容保留，等待用户显式续读
  | "stopped" // 订阅终局（4431/被替换等 closed 相位）且内容保留：冻结历史+受控横幅（不伪装 streaming）
  | "unsubscribed" // 已退订（无活动流）
  | "error" // 订阅请求失败/连接级非认证错误（受控文案）
  | "auth-failed" // 认证失败（4401）
  | "closed"; // 连接已关闭（无自动重连）

export interface StatusSummary {
  readonly process: string;
  readonly turn: string;
}

export interface SessionDetailView {
  readonly status: DetailViewStatus;
  readonly file: string | null;
  readonly subscriptionId: string | null;
  readonly events: readonly HistoryEvent[];
  readonly liveEvents: readonly LiveEvent[];
  /** 分页加载在途（streaming 态下展示「加载更多历史」提示）。 */
  readonly paging: boolean;
  readonly statusSummary: StatusSummary | null;
  /** 当前会话/进程代次/在途意图的保守超时提示；不修改协议状态或传输健康。 */
  readonly responseTimeoutNotice: string | null;
  /** 错误态受控文案（status=error/auth-failed 时）。 */
  readonly errorMessage: string | null;
  /** 流上方横幅受控文案（4431 终局保留内容/4409 需续读等；与错误态文案分立）。 */
  readonly banner: string | null;
  /** resync-needed 态且持有游标=可发起续读。 */
  readonly canResync: boolean;
  /** D3 活跃扩展提问（身份门内才透出；组件挂 UiDialog 区）。 */
  readonly uiRequests: readonly UiRequest[];
}

function turnText(turn: TurnState): string {
  switch (turn.state) {
    case "idle": return "空闲";
    case "dispatching": return "派发中";
    case "in-flight": return "执行中";
    case "settling": return "结算中";
    case "closed": return `回合已关闭（${turn.reason}）`;
  }
}

function processSummaryText(phase: "idle" | "running" | "stopping", ready: boolean): string {
  const label = phase === "idle" ? "进程空闲" : phase === "running" ? "进程运行中" : "进程停止中";
  return ready ? `${label}·就绪` : label;
}

/** F1：只消费当前在途意图的已有超时事实，不把超时解释为执行失败。 */
function responseTimeoutNoticeOf(snap: SessionDetailSnapshot): string | null {
  const turn = snap.status?.turn;
  if (!turn || !("intentId" in turn)) return null;
  const timeout = snap.events.findLast((event) => event.kind === "response-timeout" &&
    event.intentId === turn.intentId && event.generation === snap.status?.process.generation);
  return timeout ? "响应超时，本次结果尚未确认。请查看活动详情核对；不会自动重发。" : null;
}

/** 连接级状态→视图态（身份门内外共用；error 按 errorKind 细分 auth-failed）。 */
function connLevelStatus(snap: SessionDetailSnapshot): DetailViewStatus {
  if (snap.connState === "error") return snap.errorKind === "auth-failed" ? "auth-failed" : "error";
  if (snap.connState === "closed") return "closed";
  return "loading"; // connecting/authenticating/ready 但目标订阅未建立——加载空视图
}

/** 快照→视图派生（纯函数）。连接级优先于订阅相位；有内容终局保留内容+横幅（stopped，不伪装 streaming）。
 * targetFile（可选，保真②身份门）：快照 file≠目标（file prop 已切换/client 替换/已退订残留）时，
 * 连接级状态如实呈现而内容一律不透出；targetFile=null 视为未选择（组件呈现「尚未选择会话」）。 */
export function sessionDetailViewOf(snap: SessionDetailSnapshot, targetFile?: string | null): SessionDetailView {
  if (targetFile !== undefined && snap.file !== targetFile) {
    const status = connLevelStatus(snap); // 含 ready：目标订阅尚未建立/在途——loading
    return {
      status,
      file: targetFile,
      subscriptionId: null,
      events: [],
      liveEvents: [],
      paging: false,
      statusSummary: null,
      responseTimeoutNotice: null,
      errorMessage: snap.connState === "error" ? snap.errorMessage : null,
      banner: null,
      canResync: false,
      uiRequests: [], // 身份门外不透出提问（旧 file 的对话框不得泄入新会话）
    };
  }
  let status: DetailViewStatus;
  if (snap.connState !== "ready") {
    status = connLevelStatus(snap); // 连接级优先（含 error/closed）
  } else if (snap.errorKind === "subscribe-failed") {
    status = "error";
  } else {
    const hasContent = snap.events.length > 0 || snap.liveEvents.length > 0;
    switch (snap.phase) {
      case "idle": status = "unsubscribed"; break;
      case "subscribing": status = "loading"; break;
      case "paging": status = hasContent ? "streaming" : "loading"; break;
      case "live": status = hasContent ? "streaming" : "empty"; break;
      case "resync-needed": status = "resync-needed"; break;
      case "closed": status = hasContent ? "stopped" : "error"; break; // C4：有内容终局=冻结展示，不再伪装 streaming
    }
  }
  let banner: string | null = null;
  if (snap.phase === "resync-needed") {
    banner = snap.streamNote;
  } else if (snap.phase === "closed" && snap.connState === "ready" && (snap.events.length > 0 || snap.liveEvents.length > 0)) {
    banner = snap.streamNote ?? snap.errorMessage ?? "订阅已停止"; // C4：终局有内容→已停止/被替换受控横幅（4431/替换终局）
  }
  const responseTimeoutNotice = responseTimeoutNoticeOf(snap);
  return {
    status,
    file: snap.file,
    subscriptionId: snap.subscriptionId,
    events: snap.events,
    liveEvents: snap.liveEvents,
    paging: snap.connState === "ready" && snap.phase === "paging",
    statusSummary: snap.status === null ? null : {
      process: processSummaryText(snap.status.process.phase, snap.status.process.ready),
      turn: responseTimeoutNotice ? "响应超时 · 结果待核对" : turnText(snap.status.turn),
    },
    responseTimeoutNotice,
    // 空内容终局且无错误文案时（如被替换前无任何内容）：streamNote 受控提示走错误文案，不静默
    errorMessage: status === "error" && snap.phase === "closed" && snap.errorMessage === null ? snap.streamNote : snap.errorMessage,
    banner,
    canResync: snap.connState === "ready" && snap.phase === "resync-needed" && snap.cursor !== null,
    uiRequests: snap.uiRequests,
  };
}

/** 订阅单文件会话详情：file 变更即（重新）订阅，卸载/换目标即退订；视图由快照纯派生（保真②⑤）。 */
export function useSessionDetail(client: SubscribeClientSurface, file: string | null, ownSubscription = true): SessionDetailView {
  const snap = useSyncExternalStore(client.subscribe, client.getSnapshot);
  useEffect(() => {
    if (!ownSubscription || file === null) return;
    client.subscribeSession(file);
    return () => client.unsubscribeSession();
  }, [client, file, ownSubscription]);
  // 身份门以目标 file 在提交阶段复核——file prop 切换后的首次提交即无旧文件内容（不依赖 effect 事后清理）
  return sessionDetailViewOf(snap, file);
}
