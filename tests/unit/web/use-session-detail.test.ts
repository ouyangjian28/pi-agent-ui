// @vitest-environment jsdom
// A1b 详情 hook+组件测试：视图派生（sessionDetailViewOf 纯函数）+SessionDetail 四空态（loading/empty/
// error/auth-failed）+流态渲染（历史分页提示/直播追加 aria-live/4431 终局横幅保内容/4409 续读按钮）+
// hook 生命周期（挂载即订阅、卸载即退订、file 变更即换订）+真实链（SubscribeClient→DOM：受控文案不泄漏
// token、直播帧去重不重复渲染、用户点击「继续读取」才发续读帧——无自动重发）。存根=StubClient；
// 真实链=注入式假 socket，不起真网络。
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SessionDetail } from "../../../apps/web/src/components/session-detail";
import { sessionDetailViewOf, useSessionDetail } from "../../../apps/web/src/ws/use-session-detail";
import {
  SubscribeClient,
  type SessionDetailSnapshot,
  type SubscribeClientSurface,
  type WebSocketLike,
} from "../../../apps/web/src/ws/subscribe-client";
import type { HistoryEvent, LiveEvent } from "@pi-agent-ui/protocol/src/contracts";

/** 顶 SubscribeClientSurface 的存根：快照由测试推进；订阅动作记入 calls 断言生命周期。 */
class StubClient {
  private readonly listeners = new Set<() => void>();
  readonly calls: string[] = [];
  constructor(private snap: SessionDetailSnapshot) {}
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly getSnapshot = (): SessionDetailSnapshot => this.snap;
  subscribeSession(file: string): void {
    this.calls.push(`subscribe:${file}`);
  }
  unsubscribeSession(): void {
    this.calls.push("unsubscribe");
  }
  resyncFromCursor(): void {
    this.calls.push("resync");
  }
  push(next: SessionDetailSnapshot): void {
    this.snap = next;
    act(() => {
      for (const listener of this.listeners) listener();
    });
  }
}

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
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  sentFrames(): unknown[] {
    return this.sent.map((s) => JSON.parse(s) as unknown);
  }
}

function detailSnap(patch: Partial<SessionDetailSnapshot>): SessionDetailSnapshot {
  return {
    connState: "ready",
    errorKind: null,
    errorMessage: null,
    streamNote: null,
    file: "a.jsonl",
    phase: "live",
    subscriptionId: "sub-1",
    events: [],
    liveEvents: [],
    status: null,
    cursor: null,
    ...patch,
  };
}

function msg(seq: number, text = `消息 ${seq}`): HistoryEvent {
  return { seq, ts: null, generation: null, intentId: null, kind: "message", entryId: `e-${seq}`, role: "user", final: true, textPreview: { text, truncated: false } };
}

const progress: LiveEvent = { kind: "pi-progress", piType: "message_update", note: "thinking" };

const STATUS = {
  session: { sessionId: "s-1", file: "a.jsonl", adapterSessionId: null },
  process: { phase: "running" as const, generation: 1, lastStartResult: null, lastStopResult: null, ready: true },
  turn: { state: "idle" as const },
  backgroundTasks: { availability: "known" as const, activeCount: null },
  reap: { eligible: false, idleElapsedMs: null, idleRemainingMs: null, idleMs: 0 },
  recovery: { availability: "available" as const, resumeBlocked: null, diskBlocked: null, unknownEffectCount: null, unattributableFragments: null, intentsCount: null, settledCount: null, evidenceHash: null },
  statusVersion: 3,
  serverTimeMs: 1_730_000_000_000,
};

const mount = (client: SubscribeClientSurface, file: string | null = "a.jsonl") =>
  render(React.createElement(SessionDetail, { client, file }));

afterEach(cleanup);

describe("sessionDetailViewOf 派生（纯函数）", () => {
  it("连接级优先：connecting/authenticating→loading；closed→closed；error 细分 auth-failed/error", () => {
    expect(sessionDetailViewOf(detailSnap({ connState: "connecting", phase: "idle" })).status).toBe("loading");
    expect(sessionDetailViewOf(detailSnap({ connState: "authenticating", phase: "subscribing" })).status).toBe("loading");
    expect(sessionDetailViewOf(detailSnap({ connState: "closed", phase: "live", events: [msg(1)] })).status).toBe("closed");
    expect(sessionDetailViewOf(detailSnap({ connState: "error", errorKind: "auth-failed" })).status).toBe("auth-failed");
    expect(sessionDetailViewOf(detailSnap({ connState: "error", errorKind: "transport" })).status).toBe("error");
  });

  it("ready 后按订阅相位：idle→unsubscribed；subscribing→loading；paging 无内容→loading；live 空内容→empty；live 有内容→streaming；resync-needed 保留内容", () => {
    expect(sessionDetailViewOf(detailSnap({ phase: "idle" })).status).toBe("unsubscribed");
    expect(sessionDetailViewOf(detailSnap({ phase: "subscribing" })).status).toBe("loading");
    expect(sessionDetailViewOf(detailSnap({ phase: "paging", events: [] })).status).toBe("loading");
    expect(sessionDetailViewOf(detailSnap({ phase: "paging", events: [msg(1)] })).status).toBe("streaming");
    expect(sessionDetailViewOf(detailSnap({ phase: "live", events: [] })).status).toBe("empty");
    expect(sessionDetailViewOf(detailSnap({ phase: "live", events: [msg(1)] })).status).toBe("streaming");
    const resync = sessionDetailViewOf(detailSnap({ phase: "resync-needed", events: [msg(1)], cursor: { streamId: "s", seq: 2 } }));
    expect(resync.status).toBe("resync-needed");
    expect(resync.canResync).toBe(true);
    expect(resync.paging).toBe(false);
  });

  it("4431 终局（stream-terminal）：有内容→streaming+横幅受控文案；无内容→error；事件数组引用透传（身份比较）", () => {
    const events = [msg(1)] as const;
    const withContent = sessionDetailViewOf(detailSnap({ phase: "closed", errorKind: "stream-terminal", errorMessage: "服务端出帧预算超限（4431）", events }));
    expect(withContent.status).toBe("streaming");
    expect(withContent.banner).toContain("4431");
    expect(withContent.events).toBe(events); // 引用透传，不复制
    const noContent = sessionDetailViewOf(detailSnap({ phase: "closed", errorKind: "stream-terminal", errorMessage: "服务端出帧预算超限（4431）", events: [] }));
    expect(noContent.status).toBe("error");
    expect(noContent.banner).toBeNull();
  });

  it("status 摘要派生：process/turn 文案化；paging 提示位", () => {
    const view = sessionDetailViewOf(detailSnap({ phase: "paging", events: [msg(1)], status: STATUS }));
    expect(view.statusSummary).toEqual({ process: "进程运行中·就绪", turn: "空闲" });
    expect(view.paging).toBe(true);
  });
});

describe("SessionDetail 四空态（StubClient 推进快照）", () => {
  it("loading：连接/首订阅在途→加载态（role=status + aria-busy）", () => {
    mount(new StubClient(detailSnap({ connState: "connecting", phase: "idle" })));
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(status.textContent).toContain("正在加载会话详情");
  });

  it("empty：订阅成功但空会话文件（live 相位无内容）→空态提示", () => {
    mount(new StubClient(detailSnap({ phase: "live", events: [], liveEvents: [] })));
    expect(screen.getByRole("heading", { name: "空会话" })).toBeTruthy();
    expect(screen.getByText(/没有任何事件/)).toBeTruthy();
  });

  it("error：订阅失败→受控文案（role=alert）；connState error 非 auth 细分同走错误面", () => {
    mount(new StubClient(detailSnap({ connState: "error", errorKind: "subscribe-failed", phase: "closed", errorMessage: "会话不存在或不可读（4402）" })));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("会话详情加载失败");
    expect(alert.textContent).toContain("4402");
    mount(new StubClient(detailSnap({ connState: "error", errorKind: "transport", phase: "idle", errorMessage: "连接创建失败：无法建立 WebSocket 连接" })));
    expect(screen.getAllByRole("alert").length).toBeGreaterThan(0); // 同走错误面
  });

  it("auth-failed：认证失败固定提示（role=alert）", () => {
    mount(new StubClient(detailSnap({ connState: "error", errorKind: "auth-failed", errorMessage: "认证失败：令牌无效或未认证（4401）" })));
    expect(screen.getByRole("alert").textContent).toContain("认证失败");
  });

  it("快照推进驱动重渲染（loading→streaming）：历史条目+分页提示出现", () => {
    const client = new StubClient(detailSnap({ connState: "authenticating", phase: "idle", file: null }));
    mount(client);
    expect(screen.getByRole("status")).toBeTruthy();
    client.push(detailSnap({ connState: "ready", phase: "paging", events: [msg(1)], status: STATUS }));
    expect(screen.getByText(/#1 消息/)).toBeTruthy();
    expect(screen.getByText("正在加载更多历史…")).toBeTruthy();
  });
});

describe("SessionDetail 流态渲染（StubClient）", () => {
  it("直播事件列表 aria-live=polite；状态摘要与文件名呈现", () => {
    mount(new StubClient(detailSnap({ events: [msg(1)], liveEvents: [progress], status: STATUS })));
    const live = screen.getByLabelText("直播事件");
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.textContent).toContain("进度 message_update");
    expect(screen.getByText("a.jsonl")).toBeTruthy();
    expect(screen.getByText(/进程运行中·就绪 · 空闲/)).toBeTruthy();
  });

  it("4431 终局：内容保留+横幅（含码）且无「继续读取」按钮（终局不可续）", () => {
    mount(new StubClient(detailSnap({ phase: "closed", errorKind: "stream-terminal", errorMessage: "服务端出帧预算超限（4431）", events: [msg(1)] })));
    expect(screen.getByText(/#1 消息/)).toBeTruthy(); // 内容保留
    expect(screen.getByRole("status").textContent).toContain("4431");
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("useSessionDetail 生命周期（StubClient 记录动作）", () => {
  it("挂载即订阅该 file；卸载即退订；file 变更=退旧订新（effect 清理链）", () => {
    const client = new StubClient(detailSnap({ connState: "ready", phase: "idle", file: null }));
    const view = mount(client, "a.jsonl");
    expect(client.calls).toEqual(["subscribe:a.jsonl"]);
    view.rerender(React.createElement(SessionDetail, { client, file: "b.jsonl" }));
    expect(client.calls).toEqual(["subscribe:a.jsonl", "unsubscribe", "subscribe:b.jsonl"]);
    view.unmount();
    expect(client.calls).toEqual(["subscribe:a.jsonl", "unsubscribe", "subscribe:b.jsonl", "unsubscribe"]);
  });
});

describe("真实链：SubscribeClient→SessionDetail DOM", () => {
  const SENTINEL = "review-token-sentinel";
  const WELCOME = { t: "welcome", serverBootId: "boot-1", serverBuildId: "build-test", protocolVersion: 1 } as const;

  function setupReal(): { client: SubscribeClient; ws: MiniFakeSocket } {
    const ws = new MiniFakeSocket("ws://127.0.0.1:9001/ws");
    const client = new SubscribeClient("ws://127.0.0.1:9001/ws", "test-token", () => ws);
    client.connect();
    return { client, ws };
  }

  /** 走到 live 相位：握手→挂载自动订阅→页1(hasMore)→页2(末页)。 */
  function liveReal(): { client: SubscribeClient; ws: MiniFakeSocket; subscriptionId: string } {
    const { client, ws } = setupReal();
    mount(client);
    act(() => {
      ws.open();
      ws.receive(WELCOME);
    });
    const initRequestId = (ws.sentFrames()[1] as { requestId: string }).requestId;
    act(() => {
      ws.receive({
        t: "snapshot",
        requestId: initRequestId,
        subscriptionId: "sub-1",
        streamId: "stream-1",
        snapshotId: "snap-1",
        barrier: 0,
        status: STATUS,
        page: [msg(1)],
        historyNext: { streamId: "stream-1", seq: 2 },
        liveFrom: null,
        hasMore: true,
      });
    });
    const pageRequestId = (ws.sentFrames()[2] as { requestId: string }).requestId;
    act(() => {
      ws.receive({
        t: "snapshot",
        requestId: pageRequestId,
        subscriptionId: "sub-1",
        streamId: "stream-1",
        snapshotId: "snap-1",
        barrier: 0,
        status: STATUS,
        page: [msg(2), msg(3)],
        historyNext: null,
        liveFrom: { streamId: "stream-1", seq: 4 },
        hasMore: false,
      });
    });
    return { client, ws, subscriptionId: "sub-1" };
  }

  it("全链：loading→分页（加载提示）→末页直播追加→重复直播帧不重复渲染→历史与直播并列呈现", () => {
    const { ws, subscriptionId } = liveReal();
    // 末页后 live：分页提示消失
    expect(screen.queryByText("正在加载更多历史…")).toBeNull();
    expect(screen.getByText(/#1 消息/)).toBeTruthy();
    expect(screen.getByText(/#3 消息/)).toBeTruthy();
    act(() => {
      ws.receive({ t: "events", subscriptionId, origin: "live", liveSeq: 1, refSeq: null, events: [progress] });
    });
    expect(screen.getByText(/进度 message_update/)).toBeTruthy();
    const liBefore = screen.getByLabelText("直播事件").children.length;
    act(() => {
      ws.receive({ t: "events", subscriptionId, origin: "live", liveSeq: 1, refSeq: null, events: [progress] }); // 重复帧号
    });
    expect(screen.getByLabelText("直播事件").children.length).toBe(liBefore); // 去重：不重复渲染
    act(() => {
      ws.receive({ t: "events", subscriptionId, origin: "history", refSeq: 4, events: [msg(4), msg(4)] }); // 帧内重复 seq
    });
    expect(screen.getByText(/#4 消息/)).toBeTruthy();
    expect(screen.getByLabelText("历史事件").children.length).toBe(4); // 1+2+3+4（重复吸收）
  });

  it("空会话文件链：H=0 末页（page=[] + liveFrom）→空态", () => {
    const { client, ws } = setupReal();
    mount(client);
    act(() => {
      ws.open();
      ws.receive(WELCOME);
    });
    const requestId = (ws.sentFrames()[1] as { requestId: string }).requestId;
    act(() => {
      ws.receive({
        t: "snapshot",
        requestId,
        subscriptionId: "sub-e",
        streamId: "stream-e",
        snapshotId: "snap-e",
        barrier: 0,
        status: STATUS,
        page: [],
        historyNext: null,
        liveFrom: { streamId: "stream-e", seq: 1 },
        hasMore: false,
      });
    });
    expect(screen.getByRole("heading", { name: "空会话" })).toBeTruthy();
  });

  it("订阅错误链：4402 反射 token→DOM 呈受控文案；DOM 与快照序列化均不含 token", () => {
    const { client, ws } = setupReal();
    mount(client);
    act(() => {
      ws.open();
      ws.receive(WELCOME);
    });
    const requestId = (ws.sentFrames()[1] as { requestId: string }).requestId;
    act(() => {
      ws.receive({ t: "error", code: 4402, requestId, message: `session not found: ${SENTINEL}`, retryable: false });
    });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("会话详情加载失败");
    expect(alert.textContent).toContain("4402");
    expect(document.body.textContent ?? "").not.toContain(SENTINEL);
    expect(JSON.stringify(client.getSnapshot())).not.toContain(SENTINEL);
  });

  it("认证失败链：握手期 4401 反射 token→固定认证提示；DOM 不含 token", () => {
    const real = setupReal();
    mount(real.client);
    act(() => {
      real.ws.open();
      real.ws.receive({ t: "error", code: 4401, message: `bad token ${SENTINEL}`, retryable: false });
    });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("认证失败");
    expect(document.body.textContent ?? "").not.toContain(SENTINEL);
  });

  it("4431 终局链：直播中收到 4431→内容保留+横幅受控文案（无续读按钮）", () => {
    const { ws, subscriptionId } = liveReal();
    act(() => {
      ws.receive({ t: "error", code: 4431, subscriptionId, message: `budget ${SENTINEL}`, retryable: false });
    });
    expect(screen.getByText(/#3 消息/)).toBeTruthy();
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("4431");
    expect(banner.textContent).not.toContain(SENTINEL);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("4409 续读链：server-side-gap→横幅+「继续读取」；点击才发续读帧（cursor=末页 liveFrom 透传）；无自动重发", () => {
    const { ws, subscriptionId } = liveReal();
    const sentBefore = ws.sentFrames().length;
    act(() => {
      ws.receive({ t: "resync-required", subscriptionId, reason: "server-side-gap" });
    });
    expect(ws.sentFrames().length).toBe(sentBefore); // 无自动重发
    expect(screen.getByRole("status").textContent).toContain("重新同步");
    expect(screen.getByText(/#3 消息/)).toBeTruthy(); // 内容保留
    fireEvent.click(screen.getByRole("button", { name: "继续读取" }));
    expect(ws.sentFrames().at(-1)).toEqual({
      t: "subscribe",
      requestId: expect.stringMatching(/^[\w-]{1,64}$/),
      file: "a.jsonl",
      cursor: { streamId: "stream-1", seq: 4 },
    });
  });

  it("卸载即退订链：unmount 后发出 unsubscribe 帧", () => {
    const { client, ws, subscriptionId } = liveReal();
    const sentBefore = ws.sentFrames().length;
    cleanup();
    expect(client.getSnapshot().phase).toBe("idle");
    expect(ws.sentFrames().length).toBe(sentBefore + 1);
    expect(ws.sentFrames().at(-1)).toEqual({ t: "unsubscribe", requestId: expect.any(String), subscriptionId });
  });
});
