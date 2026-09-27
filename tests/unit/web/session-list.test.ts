// @vitest-environment jsdom
// A1a 会话列表组件测试：四空态（loading/empty/error/auth-failed）+列表渲染+快照推进重渲染
// （useSyncExternalStore 订阅链）+R2 端到端链（真实 WsClient→组件 DOM：受控错误文案不泄漏远端反射文本）。
// 存根测试用 StubClient（快照由测试推进）；R2 链路测试用真实 WsClient+注入式假 socket，不起真网络。
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { SessionList } from "../../../apps/web/src/components/session-list";
import { WsClient, type SessionsSnapshot, type WebSocketLike } from "../../../apps/web/src/ws/ws-client";

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

/** R2 DOM 链路用的最小假 socket（仅本文件；与 ws-client.test.ts 的 FakeWebSocket 相互独立）。 */
class MiniFakeSocket implements WebSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: { readonly code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  // ---- 测试驱动面 ----
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
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

const mount = (client: Pick<WsClient, "subscribe" | "getSnapshot">) =>
  render(React.createElement(SessionList, { client }));

afterEach(cleanup);

describe("SessionList 四空态与列表渲染", () => {
  it("loading：connecting/authenticating/ready 未收首帧三态逐一实测均呈加载态", () => {
    const loadingSnaps = [
      snapOf({ state: "connecting" }),
      snapOf({ state: "authenticating" }),
      snapOf({ state: "ready", sessions: null }),
    ];
    for (const snap of loadingSnaps) {
      const view = mount(new StubClient(snap));
      const status = screen.getByRole("status");
      expect(status.getAttribute("aria-busy")).toBe("true");
      expect(status.textContent).toContain("正在加载会话");
      view.unmount();
    }
  });

  it("empty：ready 且空列表→空态", () => {
    mount(new StubClient(snapOf({ state: "ready", sessions: [] })));
    expect(screen.getByRole("heading", { name: "还没有会话" })).toBeTruthy();
  });

  it("error：列表请求失败→错误提示（role=alert）", () => {
    mount(new StubClient(snapOf({ state: "error", errorKind: "list-failed", errorMessage: "请求游标或状态已过期（4409）" })));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("会话列表加载失败");
    expect(alert.textContent).toContain("4409");
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

describe("R2 真实客户端→组件 DOM 链：受控错误文案不泄漏远端反射文本", () => {
  const SENTINEL = "review-token-sentinel";
  const WELCOME = { t: "welcome", serverBootId: "boot-1", serverBuildId: "build-test", protocolVersion: 1 } as const;

  function setupReal(): { client: WsClient; ws: MiniFakeSocket } {
    const ws = new MiniFakeSocket("ws://127.0.0.1:9001/ws");
    const client = new WsClient("ws://127.0.0.1:9001/ws", SENTINEL, () => ws);
    client.connect();
    return { client, ws };
  }

  it("列表错误链：4409 反射 token 的 error→DOM 呈受控文案；DOM 与快照序列化均不含 token", () => {
    const { client, ws } = setupReal();
    mount(client); // 初始 loading
    act(() => {
      ws.open();
      ws.receive(WELCOME);
    });
    const requestId = (JSON.parse(ws.sent[1]!) as { requestId: string }).requestId;
    act(() => {
      ws.receive({ t: "error", code: 4409, requestId, message: `request rejected: ${SENTINEL}`, retryable: true });
    });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("会话列表加载失败");
    expect(alert.textContent).toContain("4409");
    expect(document.body.textContent ?? "").not.toContain(SENTINEL);
    expect(JSON.stringify(client.getSnapshot())).not.toContain(SENTINEL);
  });

  it("认证失败链：4401 反射 token→固定认证提示；DOM 与快照序列化均不含 token", () => {
    const { client, ws } = setupReal();
    mount(client);
    act(() => {
      ws.open();
      ws.receive({ t: "error", code: 4401, message: `未认证或令牌无效: ${SENTINEL}`, retryable: false });
    });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("认证失败");
    expect(alert.textContent).not.toContain(SENTINEL);
    expect(document.body.textContent ?? "").not.toContain(SENTINEL);
    expect(JSON.stringify(client.getSnapshot())).not.toContain(SENTINEL);
  });
});
