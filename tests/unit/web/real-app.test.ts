// @vitest-environment jsdom
// A1d 组合根 smoke：AppRoot 模式分叉（?demo=1=fixture 演示原样；缺省=真模式）+
// 真模式全链（假 socket 驱动：token 门→列表→点选→详情订阅→写面发送）+
// 连接状态条（三客户端可见）+断线自动重连（壳层退避重建三件套；认证失败不重连）。
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
    expect(screen.getByText(/空会话：该会话文件/)).toBeTruthy();
    // P1-02 壳接线杀点（GPT R2）：空态详情标题与列表同源（DTO 标题非 file 名）；摘除 real-app 传参此断言必红
    const detailHead = document.querySelector("section.session-detail h2");
    expect(detailHead?.textContent).toBe("搭建会话工作台");
    const textarea = screen.getByLabelText("写入消息内容") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(false);

    // 写面：输入→发送→写连接 prompt 帧→ack 后结果文案
    fireEvent.change(textarea, { target: { value: "你好写宿主" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    const promptFrame = FakeWebSocket.instances[2]!.sentFrames().find((f) => f.t === "prompt");
    expect(promptFrame).toBeDefined();
    expect(promptFrame!.file).toBe("a.jsonl"); // 已有会话写面：file=订阅目标（非新建 auto- 名）
    act(() => {
      FakeWebSocket.instances[2]!.receive({
        t: "write-ack",
        requestId: promptFrame!.requestId,
        file: "a.jsonl",
        outcome: { kind: "launched", intentId: "i-1", commandId: 7 },
      });
    });
    expect(FakeWebSocket.instances[2]!.sentFrames().filter((f) => f.t === "prompt")).toHaveLength(1);
    expect(document.querySelector('section.write-composer textarea')?.getAttribute("aria-label")).toBe("写入消息内容");
  });

  it("M-UX 批1 D02：新建 launched→onLaunched 自动补拉列表（接线杀点：摘除 real-app 补拉行此例必红）", async () => {
    window.history.replaceState(null, "", "/?token=smoke-token");
    render(React.createElement(AppRoot, { createSocket: factory }));
    handshakeAll();
    const listReq = FakeWebSocket.instances[0]!.sentFrames().find((f) => f.t === "list-sessions");
    act(() => {
      FakeWebSocket.instances[0]!.receive({
        t: "sessions", requestId: listReq!.requestId, sessions: [], total: 0, offset: 0,
        hasMore: false, listVersion: 1, listReliability: "full",
      });
    });
    // 打开新建表单（批3：无文件名输入框）→填首条消息→创建（file=auto- 自动生成）
    fireEvent.click(screen.getByRole("button", { name: "＋新对话" }));
    expect(screen.queryByLabelText("会话文件名")).toBeNull();
    fireEvent.change(screen.getByLabelText("首条消息"), { target: { value: "新会话第一条" } });
    fireEvent.click(screen.getByRole("button", { name: "发送并开始对话" }));
    const promptFrame = FakeWebSocket.instances[2]!.sentFrames().find((f) => f.t === "prompt");
    expect(promptFrame).toBeDefined();
    const listBefore = FakeWebSocket.instances[0]!.sentFrames().filter((f) => f.t === "list-sessions").length;
    await act(async () => {
      FakeWebSocket.instances[2]!.receive({
        t: "write-ack", requestId: promptFrame!.requestId, file: promptFrame!.file,
        outcome: { kind: "launched", intentId: "i-2", commandId: 8 },
      });
      await Promise.resolve(); // flush write-client resolve→then 链（onLaunched→requestSessions）
    });
    // onLaunched：壳收新会话视图+列表连接自动补拉（首 user 可能晚落盘；dirty 合并保证不丢）
    const listAfter = FakeWebSocket.instances[0]!.sentFrames().filter((f) => f.t === "list-sessions").length;
    expect(listAfter).toBe(listBefore + 1);

    // P1-02 缺席 DTO 派生回退（GPT R2）：补拉回空表（服务器未扫到新文件）→详情标题走
    // resolveTitle 对 file 派生（auto- 名→「N月N日 HH:mm（YYYY）」），不显示 .jsonl 原名。
    const repullReq = FakeWebSocket.instances[0]!.sentFrames().filter((f) => f.t === "list-sessions").slice(-1)[0]!;
    act(() => {
      FakeWebSocket.instances[0]!.receive({
        t: "sessions", requestId: repullReq.requestId, sessions: [], total: 0, offset: 0,
        hasMore: false, listVersion: 2, listReliability: "full",
      });
    });
    // 订阅面快照（空会话）→空态视图也显示派生标题
    const subReq2 = FakeWebSocket.instances[1]!.sentFrames().find((f) => f.t === "subscribe");
    act(() => {
      FakeWebSocket.instances[1]!.receive({
        t: "snapshot", requestId: subReq2!.requestId, subscriptionId: "sub-2", streamId: "stream-2",
        snapshotId: "snap-2", barrier: 0, status: STATUS, page: [], historyNext: null,
        liveFrom: { streamId: "stream-2", seq: 1 }, hasMore: false,
      });
    });
    const head2 = document.querySelector("section.session-detail h2");
    expect(head2?.textContent ?? "").toMatch(/^\d+月\d+日 \d{2}:\d{2}（\d{4}）$/);
    expect(head2?.textContent ?? "").not.toContain(".jsonl");
  });
});

describe("连接状态条：断开可见+自动重连", () => {
  it("订阅面断开→状态条示「已断开」+退避提示；计时到点=自动重建三件套；恢复后提示消失", async () => {
    vi.useFakeTimers();
    try {
      window.localStorage.setItem(TOKEN_STORAGE_KEY, "retry-token");
      render(React.createElement(AppRoot, { createSocket: factory }));
      handshakeAll();
      expect(screen.queryByRole("button", { name: "重新连接" })).toBeNull();

      act(() => FakeWebSocket.instances[1]!.serverClose(1006));
      expect(document.body.textContent).toContain("订阅：已断开");
      // 自动重连提示出现（第 1 次，约 1 秒后）
      expect(document.body.textContent).toContain("自动重连中");
      expect(screen.getByRole("button", { name: "立即重连" })).toBeTruthy();

      // 退避到点：旧三件套统一关闭（含仍开着的列表/写面），新三件套重建
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(FakeWebSocket.instances).toHaveLength(6);
      expect(FakeWebSocket.instances[0]!.closeCount).toBe(1);
      expect(FakeWebSocket.instances[2]!.closeCount).toBe(1);
      // 新连接处于连接中，未自动发任何业务帧（open 前静默）
      for (const ws of FakeWebSocket.instances.slice(3)) expect(ws.sent).toHaveLength(0);
      // 新三件套握手成功（全部 ready）→恢复：提示消失+按钮消失
      handshakeAll();
      expect(document.body.textContent).not.toContain("自动重连中");
      expect(screen.queryByRole("button", { name: "立即重连" })).toBeNull();
      // 恢复归零杀点：二次断线→退避从「第 1 次/约 1 秒」重新起算（attempts 恢复归零）
      act(() => FakeWebSocket.instances[5]!.serverClose(1006));
      expect(document.body.textContent).toContain("第 1 次");
      expect(document.body.textContent).toContain("约 1 秒后");
      expect(document.body.textContent).not.toContain("第 2 次");
    } finally {
      vi.useRealTimers();
    }
  });

  it("认证失败（4401）→不自动重连（无退避 timer）", async () => {
    vi.useFakeTimers();
    try {
      window.localStorage.setItem(TOKEN_STORAGE_KEY, "bad-token");
      render(React.createElement(AppRoot, { createSocket: factory }));
      // 列表面 open 后服务端拒：握手期 1008 关闭（§5.3 认证失败判定形态）
      act(() => {
        FakeWebSocket.instances[0]!.open();
        FakeWebSocket.instances[0]!.serverClose(1008);
      });
      expect(document.body.textContent).toContain("认证失败");
      expect(document.body.textContent).not.toContain("自动重连中");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(35_000);
      });
      // 认证失败不重连：35s（>30s 封顶）后零重建（timer 计数在 fake timers 下含 React scheduler
      // 环境噪音，不作断言面——行为面=实例数不变）
      expect(FakeWebSocket.instances).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("手动「立即重连」：不等待退避计时，直接重建", () => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, "retry-token");
    render(React.createElement(AppRoot, { createSocket: factory }));
    handshakeAll();
    act(() => FakeWebSocket.instances[2]!.serverClose(1006)); // 写面断
    const retry = screen.getByRole("button", { name: "立即重连" });
    fireEvent.click(retry);
    expect(FakeWebSocket.instances).toHaveLength(6); // 同 tick 重建
    expect(FakeWebSocket.instances.slice(3).every((ws) => ws.sent.length === 0)).toBe(true);
  });
});
