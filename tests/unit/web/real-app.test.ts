// @vitest-environment jsdom
// A1d 组合根 smoke：AppRoot 模式分叉（?demo=1=fixture 演示原样；缺省=真模式）+
// 真模式全链（假 socket 驱动：token 门→列表→点选→详情订阅→写面发送）+
// 连接状态条（三客户端可见）+断开「重新连接」=重建三件套（不自动重连）。
// 注入式假 socket，不起真网络。
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AppRoot, isDemoMode } from "../../../apps/web/src/app-root";
import { TOKEN_STORAGE_KEY } from "../../../apps/web/src/components/token-gate";
import type { WebSocketLike } from "../../../apps/web/src/ws/ws-client";

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];
  static reset(): void {
    FakeWebSocket.instances = [];
  }
  readyState = 0;
  readonly sent: string[] = [];
  closeCount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: { readonly code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code = 1000): void {
    this.readyState = 3;
    this.closeCount++;
    this.onclose?.({ code });
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  serverClose(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  sentFrames(): { t?: string; requestId?: string; file?: string; token?: string }[] {
    return this.sent.map((s) => JSON.parse(s) as { t?: string; requestId?: string; file?: string; token?: string });
  }
}

const factory = (url: string) => new FakeWebSocket(url);

const WELCOME = { t: "welcome", serverBootId: "boot-1", serverBuildId: "build-test", protocolVersion: 1 } as const;

const VALID_DTO = {
  sessionId: "s-1",
  file: "a.jsonl",
  title: { text: "搭建会话工作台", truncated: false },
  lastActiveMs: 1_730_000_000_000,
  entryCount: 12,
  sizeBytes: 3456,
  hasRecoveryNotice: false,
  listReliability: "full",
} as const;

const STATUS = {
  session: { sessionId: "s-1", file: "a.jsonl", adapterSessionId: null },
  process: { phase: "running" as const, generation: 1, lastStartResult: null, lastStopResult: null, ready: true },
  turn: { state: "in-flight" as const, intentId: "i-1" },
  backgroundTasks: { availability: "known" as const, activeCount: null },
  reap: { eligible: false, idleElapsedMs: null, idleRemainingMs: null, idleMs: 0 },
  recovery: {
    availability: "available" as const,
    resumeBlocked: null,
    diskBlocked: null,
    unknownEffectCount: null,
    unattributableFragments: null,
    intentsCount: null,
    settledCount: null,
    evidenceHash: null,
  },
  statusVersion: 3,
  serverTimeMs: 1_730_000_000_000,
};

beforeEach(() => {
  FakeWebSocket.reset();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

/** 三面握手：open+welcome→三客户端全 ready（列表面随后发 list-sessions）。 */
function handshakeAll(): void {
  act(() => {
    for (const ws of FakeWebSocket.instances) {
      ws.open();
      ws.receive(WELCOME);
    }
  });
}

describe("AppRoot 模式分叉", () => {
  it("isDemoMode：仅 ?demo=1 为真", () => {
    expect(isDemoMode("?demo=1")).toBe(true);
    expect(isDemoMode("?demo=0")).toBe(false);
    expect(isDemoMode("")).toBe(false);
    expect(isDemoMode("?server=ws://x:1&demo=1")).toBe(true);
  });

  it("?demo=1 → fixture 演示原样渲染，不建任何真连接", () => {
    window.history.replaceState(null, "", "/?demo=1");
    render(React.createElement(AppRoot, { createSocket: factory }));
    expect(screen.getByText("只读演示 · 未连接服务")).toBeTruthy();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("无 ?demo=1 → 真模式（token 门先行：无令牌=输入面）", () => {
    render(React.createElement(AppRoot, { createSocket: factory }));
    expect(screen.getByLabelText("访问令牌")).toBeTruthy();
    expect(screen.queryByText("只读演示 · 未连接服务")).toBeNull();
  });
});

describe("真模式 smoke：token 门→列表→详情→写面", () => {
  it("URL token 进门→三件套握手→列表渲染→点选订阅→快照到达→写面发送全链", () => {
    window.history.replaceState(null, "", "/?token=smoke-token");
    render(React.createElement(AppRoot, { createSocket: factory }));
    // token 门通过：三件套已建、地址栏已清 token
    expect(FakeWebSocket.instances).toHaveLength(3);
    expect(window.location.search).not.toContain("smoke-token");

    handshakeAll();
    // 状态条：三客户端均「已连接」（aria-live 受控文案）
    expect(document.body.textContent).toContain("列表：已连接");
    expect(document.body.textContent).toContain("订阅：已连接");
    expect(document.body.textContent).toContain("写：已连接");

    // 列表面：回 list-sessions
    const listReq = FakeWebSocket.instances[0]!.sentFrames().find((f) => f.t === "list-sessions");
    act(() => {
      FakeWebSocket.instances[0]!.receive({
        t: "sessions",
        requestId: listReq!.requestId,
        sessions: [VALID_DTO],
        total: 1,
        offset: 0,
        hasMore: false,
        listVersion: 1,
        listReliability: "full",
      });
    });
    const item = screen.getByRole("button", { name: /搭建会话工作台/ });
    expect(item.getAttribute("aria-current")).toBeNull();

    // 点选 → 订阅面发 subscribe
    fireEvent.click(item);
    const subReq = FakeWebSocket.instances[1]!.sentFrames().find((f) => f.t === "subscribe");
    expect(subReq).toBeDefined();
    expect(subReq!.file).toBe("a.jsonl");
    expect(screen.getByRole("button", { name: /搭建会话工作台/ }).getAttribute("aria-current")).toBe("page");

    // 末页快照（空流：liveFrom 首游标、hasMore=false）→空会话面+写面出现
    act(() => {
      FakeWebSocket.instances[1]!.receive({
        t: "snapshot",
        requestId: subReq!.requestId,
        subscriptionId: "sub-1",
        streamId: "stream-1",
        snapshotId: "snap-1",
        barrier: 0,
        status: STATUS,
        page: [],
        historyNext: null,
        liveFrom: { streamId: "stream-1", seq: 1 },
        hasMore: false,
      });
    });
    expect(screen.getByText("空会话")).toBeTruthy();
    const textarea = screen.getByLabelText("写入消息内容") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(false);

    // 写面：输入→发送→写连接 prompt 帧→ack 后结果文案
    fireEvent.change(textarea, { target: { value: "你好写宿主" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    const promptFrame = FakeWebSocket.instances[2]!.sentFrames().find((f) => f.t === "prompt");
    expect(promptFrame).toBeDefined();
    expect(promptFrame!.file).toBe("a.jsonl");
    act(() => {
      FakeWebSocket.instances[2]!.receive({
        t: "write-ack",
        requestId: promptFrame!.requestId,
        file: "a.jsonl",
        outcome: { kind: "launched", intentId: "i-1", commandId: 7 },
      });
    });
    expect(document.body.textContent).toContain("已入队（intentId=i-1）");
  });
});

describe("连接状态条：断开可见+手动重连", () => {
  it("订阅面断开→状态条示「已断开」+「重新连接」按钮；点击=重建三件套（旧面已关，无自动重连）", () => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, "retry-token");
    render(React.createElement(AppRoot, { createSocket: factory }));
    handshakeAll();
    expect(screen.queryByRole("button", { name: "重新连接" })).toBeNull();

    act(() => FakeWebSocket.instances[1]!.serverClose(1006));
    expect(document.body.textContent).toContain("订阅：已断开");
    const retry = screen.getByRole("button", { name: "重新连接" });

    fireEvent.click(retry);
    // 旧三件套统一关闭（含仍开着的列表/写面），新三件套重建
    expect(FakeWebSocket.instances).toHaveLength(6);
    expect(FakeWebSocket.instances[0]!.closeCount).toBe(1);
    expect(FakeWebSocket.instances[2]!.closeCount).toBe(1);
    // 新连接处于连接中，未自动发任何业务帧
    for (const ws of FakeWebSocket.instances.slice(3)) expect(ws.sent).toHaveLength(0);
  });
});
