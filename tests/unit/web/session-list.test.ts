// @vitest-environment jsdom
// A1a 会话列表组件测试：四空态（loading/empty/error/auth-failed）各一断言+
// 列表渲染+快照推进重渲染（useSyncExternalStore 订阅链）。客户端用同形存根顶替，不起真连接。
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { SessionList } from "../../../apps/web/src/components/session-list";
import type { SessionsSnapshot } from "../../../apps/web/src/ws/ws-client";

/** 顶真 WsClient 的存根：subscribe/getSnapshot 同形，快照由测试推进。 */
class StubClient {
  private readonly listeners = new Set<() => void>();
  constructor(private snap: SessionsSnapshot) {}
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly getSnapshot = (): SessionsSnapshot => this.snap;
  push(next: SessionsSnapshot): void {
    this.snap = next;
    act(() => {
      for (const listener of this.listeners) listener();
    });
  }
}

function snapOf(patch: Partial<SessionsSnapshot>): SessionsSnapshot {
  return {
    state: "connecting",
    errorKind: null,
    errorMessage: null,
    sessions: null,
    total: 0,
    listVersion: null,
    ...patch,
  };
}

const mount = (client: StubClient) => render(React.createElement(SessionList, { client }));

afterEach(cleanup);

describe("SessionList 四空态与列表渲染", () => {
  it("loading：connecting/authenticating/ready 未收首帧均呈加载态", () => {
    mount(new StubClient(snapOf({ state: "authenticating" })));
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(status.textContent).toContain("正在加载会话");
  });

  it("empty：ready 且空列表→空态", () => {
    mount(new StubClient(snapOf({ state: "ready", sessions: [] })));
    expect(screen.getByRole("heading", { name: "还没有会话" })).toBeTruthy();
  });

  it("error：列表请求失败→错误提示（role=alert）", () => {
    mount(new StubClient(snapOf({ state: "error", errorKind: "list-failed", errorMessage: "游标过期" })));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("会话列表加载失败");
    expect(alert.textContent).toContain("游标过期");
  });

  it("auth-failed：welcome 前 4401→认证失败提示", () => {
    mount(new StubClient(snapOf({ state: "error", errorKind: "auth-failed" })));
    expect(screen.getByRole("alert").textContent).toContain("认证失败");
  });

  it("closed：连接关闭终态提示，且不声称自动重连", () => {
    mount(new StubClient(snapOf({ state: "closed" })));
    expect(screen.getByRole("alert").textContent).toContain("连接已关闭");
  });

  it("ready：渲染会话条目（纯文本；截断标题补省略号）", () => {
    const dto = {
      sessionId: "s-1",
      file: "a.jsonl",
      title: { text: "搭建会话工作台", truncated: true },
      lastActiveMs: 1_730_000_000_000,
      entryCount: 12,
      sizeBytes: 3456,
      hasRecoveryNotice: false,
      listReliability: "full" as const,
    };
    mount(new StubClient(snapOf({ state: "ready", sessions: [dto], total: 1, listVersion: 3 })));
    expect(screen.getByText("搭建会话工作台…")).toBeTruthy();
    expect(screen.getByText(/a\.jsonl · 12 条/)).toBeTruthy();
  });

  it("快照推进驱动重渲染（loading→ready 空列表）", () => {
    const client = new StubClient(snapOf({ state: "authenticating" }));
    mount(client);
    expect(screen.getByRole("status")).toBeTruthy();
    client.push(snapOf({ state: "ready", sessions: [] }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("heading", { name: "还没有会话" })).toBeTruthy();
  });
});
