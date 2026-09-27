// A1b：useSyncExternalStore 订阅 SubscribeClient 会话详情快照——原生 React 手段，不引状态库。
// 快照→视图是纯派生（sessionDetailViewOf），组件四空态（loading/empty/error/auth-failed）+
// 流态（streaming/resync-needed/unsubscribed/closed）的判别唯一来源。
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

/** 快照→视图派生（纯函数）：连接级优先于订阅相位；有内容终局保留内容+横幅。 */
export function sessionDetailViewOf(snap: SessionDetailSnapshot): SessionDetailView {
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
      case "closed": status = hasContent ? "streaming" : "error"; break;
    }
  }
  let banner: string | null = null;
  if (snap.phase === "resync-needed") banner = snap.streamNote;
  else if (snap.phase === "closed" && snap.connState === "ready" && snap.errorKind === "stream-terminal" && (snap.events.length > 0 || snap.liveEvents.length > 0)) {
    banner = snap.errorMessage; // 4431 终局：内容保留+受控横幅（无内容则走 error 态文案）
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
    errorMessage: snap.errorMessage,
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
  return sessionDetailViewOf(snap);
}
