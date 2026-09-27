// @vitest-environment jsdom
// A1c 写 hook+组件+集成测试：writeViewOf 纯派生（态机/ready/lastResult file 身份门/错误双源优先级）+
// useWrite 行为（send 拒绝→瞬态错误视图、快照在途→sending/stopping、卸载不发 stop）+
// WriteComposer 真实链（WriteClient+假 socket：禁用态三源/受控文本/发送→ack 清空/超限本地拒横幅/停止流/
// 结果文案 kind 域映射）+SessionDetail 集成（注入 writeClient 即挂写面：空会话与内容视图；未注入=零改动）。
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WriteComposer } from "../../../apps/web/src/components/write-composer";
import { SessionDetail } from "../../../apps/web/src/components/session-detail";
import { writeViewOf, useWrite, type WriteView } from "../../../apps/web/src/ws/use-write";
import {
  WriteClient,
  WriteSendError,
  type WebSocketLike,
  type WriteSnapshot,
} from "../../../apps/web/src/ws/write-client";
import type { SessionDetailSnapshot, SubscribeClientSurface } from "../../../apps/web/src/ws/subscribe-client";
import type { HistoryEvent } from "@pi-agent-ui/protocol/src/contracts";

afterEach(cleanup);

// ---------------------------------------------------------------------------
// 造假面：socket（WriteClient 注入）+StubWriteClient（hook 直测）+Stub 订阅面（SessionDetail 集成）
// ---------------------------------------------------------------------------

class FakeWebSocket implements WebSocketLike {
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

const WELCOME = { t: "welcome", serverBootId: "boot-1", serverBuildId: "build-test", protocolVersion: 1 } as const;
const LAUNCHED = { kind: "launched", intentId: "i-1", commandId: 7 } as const;

/** 真实 WriteClient+假 socket，握手完即 ready。 */
function writeHarness(file = "a.jsonl"): { client: WriteClient; ws: FakeWebSocket } {
  const client = new WriteClient("ws://127.0.0.1:9001/ws", "test-token", (url) => new FakeWebSocket(url));
  client.connect();
  const ws = (client as unknown as { socket: FakeWebSocket }).socket; // 工厂闭包唯一实例
  ws.open();
  ws.receive(WELCOME);
  return { client, ws, file } as unknown as { client: WriteClient; ws: FakeWebSocket; file: string };
}

function writeSnap(patch: Partial<WriteSnapshot>): WriteSnapshot {
  return { connState: "ready", errorKind: null, errorMessage: null, inflight: [], lastResult: null, ...patch };
}

/** 顶 WriteClientSurface 的存根：快照可推进；send 动作记入 calls，可注入拒绝。 */
class StubWriteClient {
  private readonly listeners = new Set<() => void>();
  readonly calls: string[] = [];
  rejectWith: WriteSendError | null = null;
  private snap: WriteSnapshot = writeSnap({});
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly getSnapshot = (): WriteSnapshot => this.snap;
  sendPrompt(file: string, text: string): Promise<unknown> {
    this.calls.push(`prompt:${file}:${text}`);
    return this.rejectWith === null ? Promise.resolve(LAUNCHED) : Promise.reject(this.rejectWith);
  }
  sendStop(file: string): Promise<unknown> {
    this.calls.push(`stop:${file}`);
    return this.rejectWith === null ? Promise.resolve({ kind: "no-process" }) : Promise.reject(this.rejectWith);
  }
  push(next: WriteSnapshot): void {
    this.snap = next;
    act(() => {
      for (const listener of this.listeners) listener();
    });
  }
}

/** 订阅面存根（SessionDetail 集成用；同 use-session-detail.test 惯例的极简版）。 */
class StubSubscribeClient {
  private readonly listeners = new Set<() => void>();
  constructor(private snap: SessionDetailSnapshot) {}
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly getSnapshot = (): SessionDetailSnapshot => this.snap;
  subscribeSession(): void {}
  unsubscribeSession(): void {}
  resyncFromCursor(): void {}
  push(next: SessionDetailSnapshot): void {
    this.snap = next;
    act(() => {
      for (const listener of this.listeners) listener();
    });
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

function msg(seq: number): HistoryEvent {
  return { seq, ts: null, generation: null, intentId: null, kind: "message", entryId: `e-${seq}`, role: "user", final: true, textPreview: { text: `消息 ${seq}`, truncated: false } };
}

// ---------------------------------------------------------------------------
// writeViewOf 纯派生
// ---------------------------------------------------------------------------

describe("writeViewOf 派生（纯函数）", () => {
  it("基础态机：无在途→idle；prompt 在途→sending；stop 在途→stopping（叠加时 stop 优先）；ready=connState", () => {
    expect(writeViewOf(writeSnap({}), "a.jsonl", null)).toMatchObject({ phase: "idle", ready: true, sending: false, stopping: false });
    expect(writeViewOf(writeSnap({ inflight: [{ file: "a.jsonl", kind: "prompt" }] }), "a.jsonl", null)).toMatchObject({ phase: "sending", sending: true, stopping: false });
    expect(writeViewOf(writeSnap({ inflight: [{ file: "a.jsonl", kind: "stop" }] }), "a.jsonl", null)).toMatchObject({ phase: "stopping", stopping: true });
    const both = writeViewOf(writeSnap({ inflight: [{ file: "a.jsonl", kind: "prompt" }, { file: "a.jsonl", kind: "stop" }] }), "a.jsonl", null);
    expect(both.phase).toBe("stopping"); // 后发动作优先呈现
    expect(writeViewOf(writeSnap({ connState: "connecting" }), "a.jsonl", null)).toMatchObject({ phase: "idle", ready: false });
  });

  it("file 身份门：他 file 在途/结果不透出（identity gate）", () => {
    const view = writeViewOf(writeSnap({ inflight: [{ file: "b.jsonl", kind: "prompt" }], lastResult: { ok: true, kind: "prompt", file: "b.jsonl", outcome: LAUNCHED } }), "a.jsonl", null);
    expect(view.phase).toBe("idle");
    expect(view.lastResult).toBeNull();
    expect(writeViewOf(writeSnap({ lastResult: { ok: true, kind: "prompt", file: "a.jsonl", outcome: LAUNCHED } }), "a.jsonl", null).lastResult).not.toBeNull();
  });

  it("错误双源：连接级（硬）优先于在途/瞬态；瞬态（localError）只在无在途时呈 error", () => {
    expect(writeViewOf(writeSnap({ connState: "error", errorKind: "auth-failed", errorMessage: "认证失败（4401）" }), "a.jsonl", null)).toMatchObject({ phase: "error", errorMessage: "认证失败（4401）", ready: false });
    expect(writeViewOf(writeSnap({}), "a.jsonl", "该会话已有发送中的消息").phase).toBe("error");
    expect(writeViewOf(writeSnap({ inflight: [{ file: "a.jsonl", kind: "stop" }] }), "a.jsonl", "旧错误").phase).toBe("stopping"); // 在途优先于瞬态
  });
});

// ---------------------------------------------------------------------------
// useWrite hook（存根客户端直测）
// ---------------------------------------------------------------------------

describe("useWrite hook", () => {
  /** 渲染探针：把最近一次视图+动作暴露到模块级变量（每次渲染刷新）。 */
  let probe: { view: WriteView; send: (text: string) => Promise<boolean>; stop: () => Promise<boolean> } | null = null;
  function Probe({ client, file }: { client: StubWriteClient; file: string | null }): React.ReactElement {
    const { view, send, stop } = useWrite(client, file);
    probe = { view, send, stop };
    return React.createElement("div");
  }

  it("send 被拒→瞬态错误进视图（受控文案，resolve false 不拒绝）；新尝试清除", async () => {
    const client = new StubWriteClient();
    render(React.createElement(Probe, { client, file: "a.jsonl" }));
    expect(probe?.view.phase).toBe("idle");
    client.rejectWith = new WriteSendError("in-flight", "该会话已有发送中的消息，请等待结果");
    let ok = true;
    await act(async () => {
      ok = await probe!.send("hi");
    });
    expect(ok).toBe(false); // 恒不 reject：失败 resolve false
    expect(probe?.view.phase).toBe("error");
    expect(probe?.view.errorMessage).toContain("发送中的消息");
    client.rejectWith = null;
    await act(async () => {
      ok = await probe!.send("again");
    });
    expect(ok).toBe(true);
    expect(probe?.view.phase).toBe("idle"); // 新尝试清除瞬态错误
  });

  it("快照在途推进→视图随快照切 sending；卸载不发 stop（无服务端副作用）", () => {
    const client = new StubWriteClient();
    const { unmount } = render(React.createElement(Probe, { client, file: "a.jsonl" }));
    client.push(writeSnap({ inflight: [{ file: "a.jsonl", kind: "prompt" }] }));
    expect(probe?.view.phase).toBe("sending");
    expect(probe?.view.sending).toBe(true);
    unmount(); // 卸载：不清服务端状态（停止只由用户显式触发）
    expect(client.calls).toEqual([]); // 无任何自动 stop 调用
  });
});

// ---------------------------------------------------------------------------
// WriteComposer 组件（真实链：WriteClient+假 socket）
// ---------------------------------------------------------------------------

describe("WriteComposer 组件（真实链）", () => {
  it("禁用态三源：未选会话（file=null）/连接未就绪（!ready）/在途；发送另需非空文本", async () => {
    const { client, ws } = writeHarness();
    render(React.createElement(WriteComposer, { client, file: null }));
    const textarea = screen.getByLabelText("写入消息内容") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true); // 未选会话
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "停止" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("未选择会话");
    cleanup();

    const { client: c2, ws: ws2 } = (() => {
      const client = new WriteClient("ws://x/ws", "t", (url) => new FakeWebSocket(url));
      client.connect();
      const ws = (client as unknown as { socket: FakeWebSocket }).socket;
      return { client, ws };
    })();
    render(React.createElement(WriteComposer, { client: c2, file: "a.jsonl" }));
    expect((screen.getByLabelText("写入消息内容") as HTMLTextAreaElement).disabled).toBe(true); // 未握手
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true);
    act(() => {
      ws2.open();
      ws2.receive(WELCOME);
    });
    expect((screen.getByLabelText("写入消息内容") as HTMLTextAreaElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true); // 空文本
    expect((screen.getByRole("button", { name: "停止" }) as HTMLButtonElement).disabled).toBe(false);
    void c2;
    void ws;
  });

  it("发送流：输入→点击→prompt 帧发出；ack 前文本保留+发送中态；ack 后清空+结果文案（intentId）", async () => {
    const { client, ws } = writeHarness();
    render(React.createElement(WriteComposer, { client, file: "a.jsonl" }));
    const textarea = screen.getByLabelText("写入消息内容") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "你好写宿主" } });
    expect(textarea.value).toBe("你好写宿主"); // 受控文本
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(ws.sentFrames()[1]).toEqual({ t: "prompt", requestId: "wr-p-1", file: "a.jsonl", text: "你好写宿主" });
    expect(textarea.value).toBe("你好写宿主"); // 无乐观清空
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true); // 在途
    expect((screen.getByRole("button", { name: "停止" }) as HTMLButtonElement).disabled).toBe(false); // 发送后立即停止合法流
    await act(async () => {
      ws.receive({ t: "write-ack", requestId: "wr-p-1", file: "a.jsonl", outcome: LAUNCHED });
    });
    expect(textarea.value).toBe(""); // ack 后清空
    expect(screen.getAllByRole("status").map((n) => n.textContent).join()).toContain("可发送");
    expect(screen.getAllByRole("status").map((n) => n.textContent).join()).toContain("已入队（intentId=i-1）");
  });

  it("错误横幅：超 64KiB 本地拒（零帧）→role=alert 受控文案；文本保留可改后重试", async () => {
    const { client, ws } = writeHarness();
    render(React.createElement(WriteComposer, { client, file: "a.jsonl" }));
    const textarea = screen.getByLabelText("写入消息内容") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "a".repeat(65_537) } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "发送" }));
    });
    expect(ws.sent.length).toBe(1); // 仅 hello：本地拒零帧
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("64KiB");
    expect(textarea.value).toHaveLength(65_537); // 文本保留
    fireEvent.change(textarea, { target: { value: "短消息" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "发送" }));
    });
    expect(screen.queryByRole("alert")).toBeNull(); // 新尝试清除瞬态错误
    expect(ws.sentFrames()[1]).toMatchObject({ t: "prompt", file: "a.jsonl", text: "短消息" });
  });

  it("停止流：点击停止→stop 帧→write-stop-ack（confirmed exit）结果文案", async () => {
    const { client, ws } = writeHarness();
    render(React.createElement(WriteComposer, { client, file: "a.jsonl" }));
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(ws.sentFrames()[1]).toEqual({ t: "stop", requestId: "wr-s-1", file: "a.jsonl" });
    expect((screen.getByRole("button", { name: "停止" }) as HTMLButtonElement).disabled).toBe(true); // 停止在途
    await act(async () => {
      ws.receive({ t: "write-stop-ack", requestId: "wr-s-1", file: "a.jsonl", outcome: { kind: "confirmed", exit: { code: 1, signal: "SIGTERM" } } });
    });
    expect(screen.getAllByRole("status").map((n) => n.textContent).join()).toContain("已停止");
    expect((screen.getByRole("button", { name: "停止" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SessionDetail 集成
// ---------------------------------------------------------------------------

describe("SessionDetail 集成写面", () => {
  it("注入 writeClient：空会话与内容视图均挂 composer（选中会话即可用）；未注入=零改动", () => {
    const sub = new StubSubscribeClient();
    sub.push(detailSnap({ phase: "live", events: [] })); // 空会话
    const { client } = writeHarness();
    render(React.createElement(SessionDetail, { client: sub as unknown as SubscribeClientSurface, file: "a.jsonl", writeClient: client }));
    expect(screen.getByRole("button", { name: "发送" })).toBeTruthy();
    cleanup();

    sub.push(detailSnap({ phase: "live", events: [msg(1)] })); // 内容视图（streaming）
    render(React.createElement(SessionDetail, { client: sub as unknown as SubscribeClientSurface, file: "a.jsonl", writeClient: client }));
    expect(screen.getByRole("button", { name: "发送" })).toBeTruthy();
    cleanup();

    render(React.createElement(SessionDetail, { client: sub as unknown as SubscribeClientSurface, file: "a.jsonl" })); // 未注入
    expect(screen.queryByRole("button", { name: "发送" })).toBeNull();
  });
});
