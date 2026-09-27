// A1b：useSyncExternalStore 订阅 SubscribeClient 会话详情快照——原生 React 手段，不引状态库。
// 快照→视图是纯派生（sessionDetailViewOf），组件四空态（loading/empty/error/auth-failed）+
// 流态（streaming/resync-needed/unsubscribed/stopped/closed）的判别唯一来源。
// B3 提交阶段身份门：sessionDetailViewOf(snap, targetFile) 在快照 file≠目标 file 时返回不含旧内容的
// loading/连接级视图（file prop 已切换而被动 effect 尚未重订、或 client 实例替换时，首次提交不泄漏旧文件事件）。
// C4：终局 closed 相位有内容→status="stopped"（冻结内容+受控横幅，绝不伪装 streaming）；恢复入口=上层
// 重选文件（当前版本无重建按钮，组件内如实标注）。
// 订阅生命周期：file 变更即订阅（挂载=用户打开详情的显式动作）、卸载/换目标即退订；
// 4409 续读终局不做自动重发——续读（resyncFromCursor）只由组件上的用户操作触发。

import { useEffect, useSyncExternalStore } from "react";
import type { HistoryEvent, LiveEvent, TurnState } from "@pi-agent-ui/protocol/src/contracts"; // 同 ws-client：绕开 barrel
import type { SessionDetailSnapshot, SubscribeClientSurface } from "./subscribe-client";

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
  readonly events: readonly HistoryEvent[];
  readonly liveEvents: readonly LiveEvent[];
  /** 分页加载在途（streaming 态下展示「加载更多历史」提示）。 */
  readonly paging: boolean;
  readonly statusSummary: StatusSummary | null;
  /** 错误态受控文案（status=error/auth-failed 时）。 */
  readonly errorMessage: string | null;
  /** 流上方横幅受控文案（4431 终局保留内容/4409 需续读等；与错误态文案分立）。 */
  readonly banner: string | null;
  /** resync-needed 态且持有游标=可发起续读。 */
  readonly canResync: boolean;
}

function turnStateText(turn: TurnState): string {
  switch (turn.state) {
    case "idle": return "空闲";
    case "dispatching": return "派发中";
    case "in-flight": return "执行中";
    case "settling": return "结算中";
    case "closed": return `回合已关闭（${turn.reason}）`;
  }
}

function processText(phase: "idle" | "running" | "stopping", ready: boolean): string {
  const label = phase === "idle" ? "进程空闲" : phase === "running" ? "进程运行中" : "进程停止中";
  return ready ? `${label}·就绪` : label;
}

/** 快照→视图派生（纯函数）：连接级优先于订阅相位；有内容终局保留内容+横幅（stopped，不伪装 streaming）。
 * targetFile（可选）：目标 file 身份门（B3）——快照 file≠目标（file prop 已切换/client 替换/已退订残留）时，
 * 连接级状态如实呈现而内容一律不透出；file=null 视为未选择（组件呈现「尚未选择会话」）。 */
export function sessionDetailViewOf(snap: SessionDetailSnapshot, targetFile?: string | null): SessionDetailView {
  if (targetFile !== undefined && snap.file !== targetFile) {
    let gated: DetailViewStatus;
    if (snap.connState === "error") gated = snap.errorKind === "auth-failed" ? "auth-failed" : "error";
    else if (snap.connState === "closed") gated = "closed";
    else gated = "loading"; // 含 ready：目标订阅尚未建立/在途——加载空视图（不依赖 effect 事后清理）
    return {
      status: gated,
      file: targetFile,
      events: [],
      liveEvents: [],
      paging: false,
      statusSummary: null,
      errorMessage: snap.connState === "error" ? snap.errorMessage : null,
      banner: null,
      canResync: false,
    };
  }
  let status: DetailViewStatus;
  if (snap.connState === "error") {
    status = snap.errorKind === "auth-failed" ? "auth-failed" : "error";
  } else if (snap.connState === "closed") {
    status = "closed";
  } else if (snap.connState !== "ready") {
    status = "loading";
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
  if (snap.phase === "resync-needed") banner = snap.streamNote;
  else if (snap.phase === "closed" && snap.connState === "ready" && (snap.events.length > 0 || snap.liveEvents.length > 0)) {
    banner = snap.streamNote ?? snap.errorMessage ?? "订阅已停止"; // C4：终局有内容→已停止/被替换受控横幅（4431/替换终局）
  }
  return {
    status,
    file: snap.file,
    events: snap.events,
    liveEvents: snap.liveEvents,
    paging: snap.connState === "ready" && snap.phase === "paging",
    statusSummary: snap.status === null ? null : {
      process: processText(snap.status.process.phase, snap.status.process.ready),
      turn: turnStateText(snap.status.turn),
    },
    // 空内容终局且无错误文案时（如被替换前无任何内容）：streamNote 受控提示走错误文案，不静默
    errorMessage: status === "error" && snap.phase === "closed" && snap.errorMessage === null ? snap.streamNote : snap.errorMessage,
    banner,
    canResync: snap.connState === "ready" && snap.phase === "resync-needed" && snap.cursor !== null,
  };
}

/** 订阅单文件会话详情：file 变更即（重新）订阅，卸载/换目标即退订；视图由快照纯派生。 */
export function useSessionDetail(client: SubscribeClientSurface, file: string | null): SessionDetailView {
  const snap = useSyncExternalStore(client.subscribe, client.getSnapshot);
  useEffect(() => {
    if (file === null) return;
    client.subscribeSession(file);
    return () => client.unsubscribeSession();
  }, [client, file]);
  // B3：以目标 file 做提交阶段身份门——file prop 切换后的首次提交即无旧文件内容（不依赖 effect 事后清理）
  return sessionDetailViewOf(snap, file);
}
