// A1a：useSyncExternalStore 订阅 WsClient 会话列表快照——原生 React 手段，不引状态库。
// 快照→视图是纯派生（sessionsViewOf），组件四空态的判别唯一来源。

import { useSyncExternalStore } from "react";
import type { SessionSummaryDTO } from "@pi-agent-ui/protocol/src/contracts"; // 同 ws-client：绕开 barrel 直引自包含模块
import type { SessionsSnapshot, WsClient } from "./ws-client";

export type SessionsViewStatus = "loading" | "ready" | "error" | "auth-failed" | "closed";

export interface SessionsView {
  readonly status: SessionsViewStatus;
  readonly sessions: readonly SessionSummaryDTO[];
  readonly total: number;
  readonly listVersion: number | null;
  readonly errorMessage: string | null;
}

/** 快照→视图派生（纯函数）：connecting/authenticating/ready 未收首帧=loading；ready 已收帧=ready。 */
export function sessionsViewOf(snap: SessionsSnapshot): SessionsView {
  const status: SessionsViewStatus =
    snap.state === "error"
      ? snap.errorKind === "auth-failed"
        ? "auth-failed"
        : "error"
      : snap.state === "closed"
        ? "closed"
        : snap.state === "ready" && snap.sessions !== null
          ? "ready"
          : "loading";
  return {
    status,
    sessions: snap.sessions ?? [],
    total: snap.total,
    listVersion: snap.listVersion,
    errorMessage: snap.errorMessage,
  };
}

/** 订阅客户端会话列表。client 只需具备 subscribe/getSnapshot（WsClient 同形即可，测试可存根）。 */
export function useSessions(client: Pick<WsClient, "subscribe" | "getSnapshot">): SessionsView {
  const snap = useSyncExternalStore(client.subscribe, client.getSnapshot);
  return sessionsViewOf(snap);
}
