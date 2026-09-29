// @vitest-environment jsdom
// A1b 详情 hook+组件测试（归属整改重写：Kimi 亲手重写；覆盖=旧版 25 例语义面逐条对照保留+新增；A1b 复审修复批固化观察者清理锁死探针）。
// 模式：StubClient（快照由测试推进）测纯派生与组件渲染；真实链=SubscribeClient+注入式假 socket（无真网络），
// act 驱动。覆盖：sessionDetailViewOf 派生全相（连接级优先/相位映射/C4 终局/B3 身份门）；组件空态族+流态渲染；
// hook 生命周期（挂载订阅/卸载退订/换 file 退旧订新）；真实链（受控文案不泄漏 token/幂等不重复渲染/
// 续读仅用户点击触发）；B3 提交期身份门时序（layout effect 记录每次提交）。
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
  readonly answers: Array<{ readonly requestId: string; readonly answer: unknown }> = [];
  answerUi(requestId: string, answer: unknown): void {
    this.calls.push(`answer:${requestId}`);
    this.answers.push({ requestId, answer });
  }
  // D4 批③：SubscribeClientSurface 增 expandEntry——存根默认返回不可用错误态（展开链专测=session-detail-expand.test.ts）
  expandEntry(): Promise<never> {
    this.calls.push("expandEntry");
    return Promise.reject(new Error("StubClient 未实现 expandEntry（请用 session-detail-expand.test.ts 的专用存根）"));
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
    uiRequests: [],
    ...patch,
  };
}

function msg(seq: number, text = `消息 ${seq}`): HistoryEvent {
  return {
    seq,
    ts: null,
    generation: null,
    intentId: null,
    kind: "message",
    entryId: `e-${seq}`,
    role: "user",
    final: true,
    textPreview: { text, truncated: false },
  };
}

const progress: LiveEvent = { kind: "pi-progress", piType: "message_update", note: "thinking" };

const STATUS = {
  session: { sessionId: "s-1", file: "a.jsonl", adapterSessionId: null },
  process: { phase: "running" as const, generation: 1, lastStartResult: null, lastStopResult: null, ready: true },
  turn: { state: "idle" as const },
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

const mount = (client: SubscribeClientSurface, file: string | null = "a.jsonl") =>
  render(React.createElement(SessionDetail, { client, file }));

afterEach(cleanup);

describe("sessionDetailViewOf 派生（纯函数）", () => {
  it("连接级优先：connecting/authenticating→loading；closed→closed；error 细分 auth-failed/error", () => {
    expect(sessionDetailViewOf(detailSnap({ connState: "connecting", phase: "idle" })).status).toBe("loading");
    expect(sessionDetailViewOf(detailSnap({ connState: "authenticating", phase: "subscribing" })).status).toBe(
      "loading",
    );
    expect(sessionDetailViewOf(detailSnap({ connState: "closed", phase: "live", events: [msg(1)] })).status).toBe(
      "closed",
    );
    expect(sessionDetailViewOf(detailSnap({ connState: "error", errorKind: "auth-failed" })).status).toBe(
      "auth-failed",
    );
    expect(sessionDetailViewOf(detailSnap({ connState: "error", errorKind: "transport" })).status).toBe("error");
  });

  it("ready 后按订阅相位：idle→unsubscribed；subscribing→loading；paging 无内容→loading；live 空内容→empty；live 有内容→streaming；resync-needed 保留内容", () => {
    expect(sessionDetailViewOf(detailSnap({ phase: "idle" })).status).toBe("unsubscribed");
    expect(sessionDetailViewOf(detailSnap({ phase: "subscribing" })).status).toBe("loading");
    expect(sessionDetailViewOf(detailSnap({ phase: "paging", events: [] })).status).toBe("loading");
    expect(sessionDetailViewOf(detailSnap({ phase: "paging", events: [msg(1)] })).status).toBe("streaming");
    expect(sessionDetailViewOf(detailSnap({ phase: "live", events: [] })).status).toBe("empty");
    expect(sessionDetailViewOf(detailSnap({ phase: "live", events: [msg(1)] })).status).toBe("streaming");
    const resync = sessionDetailViewOf(
      detailSnap({ phase: "resync-needed", events: [msg(1)], cursor: { streamId: "s", seq: 2 } }),
    );
    expect(resync.status).toBe("resync-needed");
    expect(resync.canResync).toBe(true);
    expect(resync.paging).toBe(false);
  });

  it("4431 终局（stream-terminal）：有内容→stopped（冻结流）+横幅受控文案；无内容→error；事件数组引用透传（身份比较）", () => {
    const events = [msg(1)] as const;
    const withContent = sessionDetailViewOf(
      detailSnap({ phase: "closed", errorKind: "stream-terminal", errorMessage: "服务端出帧预算超限（4431）", events }),
    );
    expect(withContent.status).toBe("stopped");
    expect(withContent.banner).toContain("4431");
    expect(withContent.events).toBe(events); // 引用透传，不复制
    const noContent = sessionDetailViewOf(
      detailSnap({
        phase: "closed",
        errorKind: "stream-terminal",
        errorMessage: "服务端出帧预算超限（4431）",
        events: [],
      }),
    );
    expect(noContent.status).toBe("error");
    expect(noContent.banner).toBeNull();
  });

  it("C4 终局受控提示：closed 有内容+streamNote→stopped，横幅=streamNote（不覆盖 errorMessage 优先级=streamNote 优先）；closed 无内容→error，errorMessage 回退 streamNote", () => {
    const view = sessionDetailViewOf(
      detailSnap({ phase: "closed", streamNote: "订阅已被新订阅替换，旧流已停止", events: [msg(1)] }),
    );
    expect(view.status).toBe("stopped");
    expect(view.banner).toContain("旧流已停止");
    expect(view.canResync).toBe(false);
    // streamNote 与 errorMessage 同场：横幅取 streamNote（优先级锁定，不被 errorMessage 覆盖）
    const both = sessionDetailViewOf(
      detailSnap({
        phase: "closed",
        errorMessage: "服务端出帧预算超限（4431）",
        streamNote: "订阅已被新订阅替换，旧流已停止",
        events: [msg(1)],
      }),
    );
    expect(both.status).toBe("stopped");
    expect(both.banner).toBe("订阅已被新订阅替换，旧流已停止");
    const empty = sessionDetailViewOf(
      detailSnap({ phase: "closed", streamNote: "订阅已被新订阅替换，旧流已停止", events: [], liveEvents: [] }),
    );
    expect(empty.status).toBe("error");
    expect(empty.errorMessage).toContain("旧流已停止"); // 受控提示不丢
    expect(empty.banner).toBeNull();
  });

  it("status 摘要派生：process/turn 文案化；paging 提示位", () => {
    const view = sessionDetailViewOf(detailSnap({ phase: "paging", events: [msg(1)], status: STATUS }));
    expect(view.statusSummary).toEqual({ process: "进程运行中·就绪", turn: "空闲" });
    expect(view.paging).toBe(true);
  });

  it("B3 身份门（纯函数面）：targetFile≠快照 file→内容不透出；连接级状态如实呈现（error/closed 不降级为 loading）；targetFile=null=未选择", () => {
    const stale = detailSnap({ file: "a.jsonl", phase: "live", events: [msg(1)], status: STATUS });
    const gated = sessionDetailViewOf(stale, "b.jsonl");
    expect(gated.status).toBe("loading");
    expect(gated.events).toHaveLength(0);
    expect(gated.statusSummary).toBeNull();
    expect(gated.file).toBe("b.jsonl");
    expect(gated.canResync).toBe(false);
    // 连接级如实呈现
    expect(
      sessionDetailViewOf(
        detailSnap({ file: "a.jsonl", connState: "error", errorKind: "auth-failed", errorMessage: "认证失败（4401）" }),
        "b.jsonl",
      ).status,
    ).toBe("auth-failed");
    expect(sessionDetailViewOf(detailSnap({ file: "a.jsonl", connState: "closed" }), "b.jsonl").status).toBe("closed");
    const noTarget = sessionDetailViewOf(stale, null);
    expect(noTarget.status).toBe("loading");
    expect(noTarget.file).toBeNull();
    expect(noTarget.events).toHaveLength(0);
  });

  it("resync-needed 无 cursor→canResync=false（无游标不可续读）", () => {
    const view = sessionDetailViewOf(
      detailSnap({
        phase: "resync-needed",
        events: [msg(1)],
        cursor: null,
        streamNote: "请求游标或状态已过期（4409）",
      }),
    );
    expect(view.status).toBe("resync-needed");
    expect(view.canResync).toBe(false);
    expect(view.banner).toContain("4409");
  });
});

describe("SessionDetail 空态族（StubClient 推进快照）", () => {
  it("loading：连接/首订阅在途→加载态（role=status + aria-busy）；file=null→「尚未选择会话」", () => {
    mount(new StubClient(detailSnap({ connState: "connecting", phase: "idle" })));
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(status.textContent).toContain("正在加载会话详情");
    cleanup();
    mount(new StubClient(detailSnap({ connState: "connecting", phase: "idle", file: null })), null);
    expect(screen.getByRole("status").textContent).toContain("尚未选择会话");
  });

  it("empty：订阅成功但空会话文件（live 相位无内容）→空态提示", () => {
    mount(new StubClient(detailSnap({ phase: "live", events: [], liveEvents: [] })));
    expect(screen.getByRole("heading", { name: "空会话" })).toBeTruthy();
    expect(screen.getByText(/没有任何事件/)).toBeTruthy();
  });

  it("error：订阅失败→受控文案（role=alert）；connState error 非 auth 细分同走错误面", () => {
    mount(
      new StubClient(
        detailSnap({
          connState: "error",
          errorKind: "subscribe-failed",
          phase: "closed",
          errorMessage: "会话不存在或不可读（4402）",
        }),
      ),
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("会话详情加载失败");
    expect(alert.textContent).toContain("4402");
    cleanup();
    mount(
      new StubClient(
        detailSnap({
          connState: "error",
          errorKind: "transport",
          phase: "idle",
          errorMessage: "连接创建失败：无法建立 WebSocket 连接",
        }),
      ),
    );
    expect(screen.getByRole("alert").textContent).toContain("连接创建失败");
  });

  it("auth-failed：认证失败固定提示（role=alert）", () => {
    mount(
      new StubClient(
        detailSnap({
          connState: "error",
          errorKind: "auth-failed",
          errorMessage: "认证失败：令牌无效或未认证（4401）",
        }),
      ),
    );
    expect(screen.getByRole("alert").textContent).toContain("认证失败");
  });

  it("closed/unsubscribed：连接关闭与未订阅各有独立提示面", () => {
    mount(new StubClient(detailSnap({ connState: "closed", phase: "live", events: [msg(1)] })));
    expect(screen.getByRole("alert").textContent).toContain("连接已关闭");
    cleanup();
    mount(new StubClient(detailSnap({ phase: "idle", file: "a.jsonl" })));
    expect(screen.getByRole("heading", { name: "未订阅会话" })).toBeTruthy();
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

  it("4431 终局：内容保留+横幅（含码）且无「继续读取」按钮（终局不可续）；诚实标注恢复入口=重选文件", () => {
    mount(
      new StubClient(
        detailSnap({
          phase: "closed",
          errorKind: "stream-terminal",
          errorMessage: "服务端出帧预算超限（4431）",
          events: [msg(1)],
        }),
      ),
    );
    expect(screen.getByText(/#1 消息/)).toBeTruthy(); // 内容保留
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("4431");
    expect(banner.textContent).toContain("重新选择会话文件"); // C4 诚实标注
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("resync-needed：横幅+「继续读取」按钮；点击调 client.resyncFromCursor（仅用户触发）", () => {
    const client = new StubClient(
      detailSnap({
        phase: "resync-needed",
        events: [msg(1)],
        cursor: { streamId: "s", seq: 2 },
        streamNote: "检测到服务端事件缺口，需要重新同步后继续",
      }),
    );
    mount(client);
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("重新同步");
    expect(client.calls.filter((c) => c === "resync")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "继续读取" }));
    expect(client.calls).toContain("resync");
  });
});

describe("D3-F 扩展问答（ui-note 旁路渲染 + UiDialog 区）", () => {
  const note = (notifyType: "info" | "warning" | "error", message: string): LiveEvent => ({
    kind: "ui-note",
    notifyType,
    message,
  });

  it("ui-note 按 notifyType 三级渲染到 live-list（class+文案分级）；其余旁路事件无附加 class", () => {
    mount(
      new StubClient(
        detailSnap({
          events: [msg(1)],
          liveEvents: [progress, note("info", "一切正常"), note("warning", "注意风险"), note("error", "出错了")],
        }),
      ),
    );
    const items = screen.getByLabelText("直播事件").querySelectorAll("li");
    expect(items).toHaveLength(4);
    expect(items[0]!.className).toBe(""); // pi-progress 无附加 class
    expect(items[1]!.className).toBe("live-note live-note-info");
    expect(items[1]!.textContent).toBe("通知：一切正常");
    expect(items[2]!.className).toBe("live-note live-note-warning");
    expect(items[2]!.textContent).toBe("警告：注意风险");
    expect(items[3]!.className).toBe("live-note live-note-error");
    expect(items[3]!.textContent).toBe("错误：出错了");
  });

  it("ui-note 不进直播正文区（append-only 旁路；正文三形缺省时 LiveStreamView 不挂载）", async () => {
    mount(new StubClient(detailSnap({ events: [msg(1)], liveEvents: [note("info", "仅通知")] })));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20)); // 让 rAF 批处理窗口过去（无正文可提交）
    });
    expect(screen.queryByLabelText("直播正文")).toBeNull();
    expect(screen.getByLabelText("直播事件").textContent).toContain("通知：仅通知");
  });

  it("快照有活跃提问即挂 UiDialog 区（无提问不占位）；作答经 client.answerUi 回传", () => {
    const client = new StubClient(
      detailSnap({
        events: [msg(1)],
        uiRequests: [
          { requestId: "ui-1", method: "select", title: "选哪个？", options: ["甲", "乙"] },
          { requestId: "ui-2", method: "confirm", message: "允许执行吗？" },
        ],
      }),
    );
    mount(client);
    const stack = screen.getByLabelText("扩展提问");
    expect(stack.querySelectorAll(".ui-dialog")).toHaveLength(2); // 多提问堆叠
    expect(screen.getByText("允许执行吗？")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "乙" }));
    expect(client.answers).toEqual([{ requestId: "ui-1", answer: { value: "乙" } }]);
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    expect(client.answers[1]).toEqual({ requestId: "ui-2", answer: { confirmed: true } });
  });

  it("身份门外不透出提问：快照 file≠目标 file 时 uiRequests 为空（旧提问不泄入新会话）", () => {
    const view = sessionDetailViewOf(
      detailSnap({ file: "old.jsonl", uiRequests: [{ requestId: "ui-1", method: "confirm" }] }),
      "a.jsonl",
    );
    expect(view.uiRequests).toEqual([]);
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

  it("file=null：不发起订阅；卸载也无退订动作", () => {
    const client = new StubClient(detailSnap({ connState: "ready", phase: "idle", file: null }));
    const view = mount(client, null);
    expect(client.calls).toHaveLength(0);
    view.unmount();
    expect(client.calls).toHaveLength(0);
  });
});

describe("真实链：SubscribeClient→SessionDetail DOM（假 socket 注入，无真网络）", () => {
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
        barrier: 3,
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
        barrier: 3,
        status: STATUS,
        page: [msg(2), msg(3)],
        historyNext: null,
        liveFrom: { streamId: "stream-1", seq: 4 },
        hasMore: false,
      });
    });
    return { client, ws, subscriptionId: "sub-1" };
  }

  it("全链：loading→分页（加载提示）→末页直播追加→重复直播帧不重复渲染→历史幂等去重→历史与直播并列呈现", () => {
    const { client, ws } = setupReal();
    mount(client);
    act(() => {
      ws.open();
      ws.receive(WELCOME);
    });
    // 中间态①：首页在途（subscribing 无内容）→loading 面
    expect(screen.getByRole("status").textContent).toContain("正在加载会话详情");
    const initRequestId = (ws.sentFrames()[1] as { requestId: string }).requestId;
    act(() => {
      ws.receive({
        t: "snapshot",
        requestId: initRequestId,
        subscriptionId: "sub-1",
        streamId: "stream-1",
        snapshotId: "snap-1",
        barrier: 3,
        status: STATUS,
        page: [msg(1)],
        historyNext: { streamId: "stream-1", seq: 2 },
        liveFrom: null,
        hasMore: true,
      });
    });
    // 中间态②：分页中首条内容已可见 + 分页加载提示在场（断言落在中间态而非末页后）
    expect(screen.getByText(/#1 消息/)).toBeTruthy();
    expect(screen.getByText("正在加载更多历史…")).toBeTruthy();
    const pageRequestId = (ws.sentFrames()[2] as { requestId: string }).requestId;
    act(() => {
      ws.receive({
        t: "snapshot",
        requestId: pageRequestId,
        subscriptionId: "sub-1",
        streamId: "stream-1",
        snapshotId: "snap-1",
        barrier: 3,
        status: STATUS,
        page: [msg(2), msg(3)],
        historyNext: null,
        liveFrom: { streamId: "stream-1", seq: 4 },
        hasMore: false,
      });
    });
    expect(screen.queryByText("正在加载更多历史…")).toBeNull(); // 末页后分页提示消失
    expect(screen.getByText(/#3 消息/)).toBeTruthy();
    const subscriptionId = "sub-1";
    act(() => {
      ws.receive({ t: "events", subscriptionId, origin: "live", liveSeq: 1, refSeq: null, events: [progress] });
    });
    expect(screen.getByText(/进度 message_update/)).toBeTruthy();
    const liBefore = screen.getByLabelText("直播事件").children.length;
    act(() => {
      ws.receive({ t: "events", subscriptionId, origin: "live", liveSeq: 1, refSeq: null, events: [progress] }); // 重复帧号
    });
    expect(screen.getByLabelText("直播事件").children.length).toBe(liBefore);
    act(() => {
      ws.receive({ t: "events", subscriptionId, origin: "history", refSeq: 4, events: [msg(4), msg(4)] }); // 帧内重复 seq
    });
    expect(screen.getByText(/#4 消息/)).toBeTruthy();
    expect(screen.getByLabelText("历史事件").children.length).toBe(4);
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

  it("4431 终局链：直播中收到 4431（drain 出口形态信封 subscriptionId+requestId 空串）→内容保留+横幅受控文案（无续读按钮）", () => {
    const { ws, subscriptionId } = liveReal();
    act(() => {
      ws.receive({
        t: "error",
        code: 4431,
        subscriptionId,
        requestId: "",
        message: `budget ${SENTINEL}`,
        retryable: false,
      });
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
    expect(screen.getByText(/#3 消息/)).toBeTruthy();
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

  it("观察者清理锁死（A1b 复审 N1 探针固化）：hook 卸载即移除 store listener——卸载后状态推进零触达；重挂后仅新实例在册（一次推进恰一份通知）", () => {
    const { client, ws } = setupReal();
    let notifications = 0;
    const surface: SubscribeClientSurface = {
      subscribe: (fn: () => void) =>
        client.subscribe(() => {
          notifications++;
          fn();
        }),
      getSnapshot: () => client.getSnapshot(),
      subscribeSession: (file: string) => client.subscribeSession(file),
      unsubscribeSession: () => client.unsubscribeSession(),
      resyncFromCursor: () => client.resyncFromCursor(),
    };
    function Probe(): null {
      useSessionDetail(surface, "a.jsonl");
      return null;
    }
    const first = render(React.createElement(Probe));
    act(() => {
      ws.open();
      ws.receive(WELCOME); // 握手→自动订阅：相位推进产生通知
    });
    expect(notifications).toBeGreaterThan(0);
    first.unmount();
    const afterUnmount = notifications;
    act(() => {
      client.subscribeSession("b.jsonl"); // 相位推进：已卸载实例的 listener 不得再被触达
    });
    expect(notifications).toBe(afterUnmount); // 删 listeners.delete 的窄变异在此转红
    const second = render(React.createElement(Probe));
    const beforeNext = notifications;
    act(() => {
      client.unsubscribeSession(); // 再推进：仅新实例在册→恰 +1 份通知（旧 listener 泄漏则 +2）
    });
    expect(notifications).toBe(beforeNext + 1);
    second.unmount();
  });

  it("C4 真实链：直播中 stream-replaced→视图=stopped（非 streaming），横幅含受控提示+恢复入口=重选文件（无重建按钮、无分页提示）", () => {
    const { ws, subscriptionId } = liveReal();
    act(() => {
      ws.receive({ t: "resync-required", subscriptionId, reason: "stream-replaced" });
    });
    expect(screen.getByText(/#3 消息/)).toBeTruthy(); // 内容保留（冻结）
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("旧流已停止");
    expect(banner.textContent).toContain("重新选择会话文件");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText("正在加载更多历史…")).toBeNull();
  });

  it("连接级终局链：live 中服务端断开（onclose 1006）→closed 视图（无自动重连、无续读按钮）", () => {
    const { ws } = liveReal();
    act(() => {
      ws.readyState = 3;
      ws.onclose?.({ code: 1006 });
    });
    expect(screen.getByRole("alert").textContent).toContain("连接已关闭");
    expect(screen.queryByRole("button", { name: "继续读取" })).toBeNull();
  });
});

describe("K3-C B3 提交期身份门（useLayoutEffect 记录每次提交的派生视图）", () => {
  /** 每次提交记录 `propFile|status|事件序号`：模拟派生层直接驱动的首帧渲染（layout effect 先于被动 effect）。 */
  function CommitLog(props: { client: SubscribeClientSurface; file: string | null; log: string[] }): null {
    const view = useSessionDetail(props.client, props.file);
    React.useLayoutEffect(() => {
      props.log.push(`${props.file ?? "<null>"}|${view.status}|${view.events.map((e) => e.seq).join(",")}`);
    });
    return null;
  }

  it("A→B 切换：首次提交即无旧文件内容（loading、零事件）——快照仍挂旧 file 时门持续生效；B 首页落地后呈现 B 内容", () => {
    const client = new StubClient(detailSnap({ file: "a.jsonl", phase: "live", events: [msg(1)] }));
    const log: string[] = [];
    const view = render(React.createElement(CommitLog, { client, file: "a.jsonl", log }));
    expect(log.at(-1)).toBe("a.jsonl|streaming|1");
    view.rerender(React.createElement(CommitLog, { client, file: "b.jsonl", log }));
    // 首次提交即门控：loading+零事件（被动 effect 的退订/换订发生在提交之后，不承担清理责任）
    expect(log.at(-1)).toBe("b.jsonl|loading|");
    // 迟到旧文件帧（快照仍是 a.jsonl 的流）：门持续生效，不回渗旧内容
    client.push(detailSnap({ file: "a.jsonl", phase: "live", events: [msg(1), msg(2)] }));
    expect(log.at(-1)).toBe("b.jsonl|loading|");
    // B 首页落地：正常呈现 B 内容
    client.push(detailSnap({ file: "b.jsonl", phase: "live", events: [msg(5)] }));
    expect(log.at(-1)).toBe("b.jsonl|streaming|5");
  });

  it("file=null 变体：prop 变为 null 后首提交即门控（loading、零事件）——无目标文件不继承旧快照内容", () => {
    const client = new StubClient(detailSnap({ file: "a.jsonl", phase: "live", events: [msg(1)] }));
    const log: string[] = [];
    const view = render(React.createElement(CommitLog, { client, file: "a.jsonl", log }));
    view.rerender(React.createElement(CommitLog, { client, file: null, log }));
    expect(log.at(-1)).toBe("<null>|loading|");
  });

  it("client 实例替换变体：换 client 后首提交即读新实例快照（旧实例门控不残留、退订被动 effect 补发）", () => {
    const clientA = new StubClient(detailSnap({ file: "a.jsonl", phase: "live", events: [msg(1)] }));
    const clientB = new StubClient(detailSnap({ file: "b.jsonl", phase: "live", events: [msg(7)] }));
    const log: string[] = [];
    const view = render(React.createElement(CommitLog, { client: clientA, file: "a.jsonl", log }));
    expect(log.at(-1)).toBe("a.jsonl|streaming|1");
    view.rerender(React.createElement(CommitLog, { client: clientB, file: "b.jsonl", log }));
    expect(log.at(-1)).toBe("b.jsonl|streaming|7"); // 首次提交即新实例视图，无 a.jsonl 残留
    expect(clientA.calls).toEqual(["subscribe:a.jsonl", "unsubscribe"]); // 旧实例清理链照常
  });
});
