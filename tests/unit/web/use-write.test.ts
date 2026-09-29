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
  return {
    connState: "ready",
    errorKind: null,
    errorMessage: null,
    inflight: [],
    lastResult: null,
    resumeState: { phase: "idle" },
    lastResumeResult: null,
    ...patch,
  };
}

/** 顶 WriteClientSurface 的存根：快照可推进；send 动作记入 calls，可注入拒绝。 */
class StubWriteClient {
  private readonly listeners = new Set<() => void>();
  readonly calls: string[] = [];
  rejectWith: WriteSendError | null = null;
  /** M-OPS：sendPrompt resolve 值可注入（默认 LAUNCHED；not-ready 面测试用）。 */
  resolveWith: unknown = LAUNCHED;
  private snap: WriteSnapshot = writeSnap({});
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly getSnapshot = (): WriteSnapshot => this.snap;
  sendPrompt(file: string, text: string, model?: string): Promise<unknown> {
    this.calls.push(`prompt:${file}:${text}:${model ?? "∅"}`);
    return this.rejectWith === null ? Promise.resolve(this.resolveWith) : Promise.reject(this.rejectWith);
  }
  sendStop(file: string): Promise<unknown> {
    this.calls.push(`stop:${file}`);
    return this.rejectWith === null ? Promise.resolve({ kind: "no-process" }) : Promise.reject(this.rejectWith);
  }
  resume(file: string, intentId: string, generation: number): Promise<unknown> {
    this.calls.push(`resume:${file}:${intentId}:${generation}`);
    return this.rejectWith === null ? Promise.resolve(LAUNCHED) : Promise.reject(this.rejectWith);
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
    uiRequests: [],
    ...patch,
  };
}

function msg(seq: number): HistoryEvent {
  return {
    seq,
    ts: null,
    generation: null,
    intentId: null,
    kind: "message",
    entryId: `e-${seq}`,
    role: "user",
    final: true,
    textPreview: { text: `消息 ${seq}`, truncated: false },
  };
}

// ---------------------------------------------------------------------------
// writeViewOf 纯派生
// ---------------------------------------------------------------------------

describe("writeViewOf 派生（纯函数）", () => {
  it("基础态机：无在途→idle；prompt 在途→sending；stop 在途→stopping（叠加时 stop 优先）；ready=connState", () => {
    expect(writeViewOf(writeSnap({}), "a.jsonl", null)).toMatchObject({
      phase: "idle",
      ready: true,
      sending: false,
      stopping: false,
    });
    expect(writeViewOf(writeSnap({ inflight: [{ file: "a.jsonl", kind: "prompt" }] }), "a.jsonl", null)).toMatchObject({
      phase: "sending",
      sending: true,
      stopping: false,
    });
    expect(writeViewOf(writeSnap({ inflight: [{ file: "a.jsonl", kind: "stop" }] }), "a.jsonl", null)).toMatchObject({
      phase: "stopping",
      stopping: true,
    });
    const both = writeViewOf(
      writeSnap({
        inflight: [
          { file: "a.jsonl", kind: "prompt" },
          { file: "a.jsonl", kind: "stop" },
        ],
      }),
      "a.jsonl",
      null,
    );
    expect(both.phase).toBe("stopping"); // 后发动作优先呈现
    expect(writeViewOf(writeSnap({ connState: "connecting" }), "a.jsonl", null)).toMatchObject({
      phase: "idle",
      ready: false,
    });
  });

  it("file 身份门：他 file 在途/结果不透出（identity gate）", () => {
    const view = writeViewOf(
      writeSnap({
        inflight: [{ file: "b.jsonl", kind: "prompt" }],
        lastResult: { ok: true, kind: "prompt", file: "b.jsonl", outcome: LAUNCHED },
      }),
      "a.jsonl",
      null,
    );
    expect(view.phase).toBe("idle");
    expect(view.lastResult).toBeNull();
    expect(
      writeViewOf(
        writeSnap({ lastResult: { ok: true, kind: "prompt", file: "a.jsonl", outcome: LAUNCHED } }),
        "a.jsonl",
        null,
      ).lastResult,
    ).not.toBeNull();
  });

  it("错误双源：连接级（硬）优先于在途/瞬态；瞬态（localError）只在无在途时呈 error", () => {
    expect(
      writeViewOf(
        writeSnap({ connState: "error", errorKind: "auth-failed", errorMessage: "认证失败（4401）" }),
        "a.jsonl",
        null,
      ),
    ).toMatchObject({ phase: "error", errorMessage: "认证失败（4401）", ready: false });
    expect(writeViewOf(writeSnap({}), "a.jsonl", "该会话已有发送中的消息").phase).toBe("error");
    expect(writeViewOf(writeSnap({ inflight: [{ file: "a.jsonl", kind: "stop" }] }), "a.jsonl", "旧错误").phase).toBe(
      "stopping",
    ); // 在途优先于瞬态
  });
});

// ---------------------------------------------------------------------------
// useWrite hook（存根客户端直测）
// ---------------------------------------------------------------------------

describe("useWrite hook", () => {
  /** 渲染探针：把最近一次视图+动作暴露到模块级变量（每次渲染刷新）。 */
  let probe: { view: WriteView; send: (text: string, model?: string) => Promise<boolean>; stop: () => Promise<boolean> } | null = null;
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

  it("M-OPS：send 透传可选 model（带 id→三参齐；缺省→undefined 不带模型）", async () => {
    const client = new StubWriteClient();
    render(React.createElement(Probe, { client, file: "a.jsonl" }));
    await act(async () => {
      expect(await probe!.send("hi", "openai/gpt-5.3")).toBe(true);
    });
    expect(client.calls).toEqual(["prompt:a.jsonl:hi:openai/gpt-5.3"]);
    await act(async () => {
      expect(await probe!.send("again")).toBe(true);
    });
    expect(client.calls).toEqual(["prompt:a.jsonl:hi:openai/gpt-5.3", "prompt:a.jsonl:again:∅"]);
  });

  it("M-OPS not-ready：ack 到达但启动失败→view.notReady 落账（cause+detail）；resolve 仍 true；新尝试清除", async () => {
    const client = new StubWriteClient();
    client.resolveWith = { kind: "not-ready", cause: "spawn-exited", detail: "Error: model \"nope\" not found" };
    render(React.createElement(Probe, { client, file: "a.jsonl" }));
    let ok = false;
    await act(async () => {
      ok = await probe!.send("hi");
    });
    expect(ok).toBe(true); // 合法 ack（非错误路径）
    expect(probe?.view.notReady).toEqual({ cause: "spawn-exited", detail: "Error: model \"nope\" not found" });
    expect(probe?.view.errorMessage).toBeNull(); // 不连坐错误面
    client.resolveWith = LAUNCHED;
    await act(async () => {
      await probe!.send("again");
    });
    expect(probe?.view.notReady).toBeNull(); // 新尝试清除瞬态 not-ready
  });

  it("M-OPS not-ready 身份门：换文件后旧文件的 not-ready 不透出；file=null 全隐", async () => {
    const client = new StubWriteClient();
    client.resolveWith = { kind: "not-ready", cause: "readiness-timeout" };
    const { rerender } = render(React.createElement(Probe, { client, file: "a.jsonl" }));
    await act(async () => {
      await probe!.send("hi");
    });
    expect(probe?.view.notReady?.cause).toBe("readiness-timeout");
    rerender(React.createElement(Probe, { client, file: "b.jsonl" }));
    expect(probe?.view.notReady).toBeNull(); // 他文件启动失败不污染当前会话
    rerender(React.createElement(Probe, { client, file: null }));
    expect(probe?.view.notReady).toBeNull(); // file=null 全隐
  });

  it("M-OPS not-ready 迟到门（P3-5 独立杀点）：后续动作推进序号后，旧 not-ready 回包不落账", async () => {
    // 挂起式存根：send 的 resolve 由测试驱动（模拟 write-ack 迟到）
    let resolver: ((v: unknown) => void) | null = null;
    class PendingStub extends StubWriteClient {
      sendPrompt(file: string, text: string): Promise<unknown> {
        this.calls.push(`prompt:${file}:${text}:∅`);
        return new Promise((res) => {
          resolver = res;
        });
      }
    }
    const client = new PendingStub();
    render(React.createElement(Probe, { client, file: "a.jsonl" }));
    let sendPromise: Promise<boolean> = Promise.resolve(false);
    await act(async () => {
      sendPromise = probe!.send("hi"); // seq=1 挂起
    });
    client.resolveWith = { kind: "no-process" };
    await act(async () => {
      await probe!.stop(); // seq=2：序号推进（stop 结算在前）
    });
    await act(async () => {
      resolver?.({ kind: "not-ready", cause: "spawn-failed" }); // seq=1 的迟到 not-ready
      await sendPromise;
    });
    expect(probe?.view.notReady).toBeNull(); // 迟到回包不落账（不覆盖新动作状态）
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
    expect(
      screen
        .getAllByRole("status")
        .map((n) => n.textContent)
        .join(),
    ).toContain("可发送");
    expect(
      screen
        .getAllByRole("status")
        .map((n) => n.textContent)
        .join(),
    ).toContain("已入队（intentId=i-1）");
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
      ws.receive({
        t: "write-stop-ack",
        requestId: "wr-s-1",
        file: "a.jsonl",
        outcome: { kind: "confirmed", exit: { code: 1, signal: "SIGTERM" } },
      });
    });
    expect(
      screen
        .getAllByRole("status")
        .map((n) => n.textContent)
        .join(),
    ).toContain("已停止");
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
    render(
      React.createElement(SessionDetail, {
        client: sub as unknown as SubscribeClientSurface,
        file: "a.jsonl",
        writeClient: client,
      }),
    );
    expect(screen.getByRole("button", { name: "发送" })).toBeTruthy();
    cleanup();

    sub.push(detailSnap({ phase: "live", events: [msg(1)] })); // 内容视图（streaming）
    render(
      React.createElement(SessionDetail, {
        client: sub as unknown as SubscribeClientSurface,
        file: "a.jsonl",
        writeClient: client,
      }),
    );
    expect(screen.getByRole("button", { name: "发送" })).toBeTruthy();
    cleanup();

    render(React.createElement(SessionDetail, { client: sub as unknown as SubscribeClientSurface, file: "a.jsonl" })); // 未注入
    expect(screen.queryByRole("button", { name: "发送" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// K5 修复批回归：B1 草稿身份门 / B2 composer 稳定挂载 / B3 瞬态错误身份门
// ---------------------------------------------------------------------------

/** 可控结算存根（B3 迟到失败面）：sendPrompt 不立即结算，由测试驱动 resolve/reject。 */
class DeferringStubClient extends StubWriteClient {
  readonly pending: Array<{ resolve: (value: unknown) => void; reject: (error: unknown) => void }> = [];
  override sendPrompt(file: string, text: string): Promise<unknown> {
    this.calls.push(`prompt:${file}:${text}`);
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
    });
  }
}

describe("K5 B1：草稿身份门（ack 清空仅限本次发送对应的未编辑草稿）", () => {
  it("同 file 在途编辑新草稿→旧 ack 到达：新草稿保留（不被吞）+结果文案照常呈现", async () => {
    const { client, ws } = writeHarness();
    render(React.createElement(WriteComposer, { client, file: "a.jsonl" }));
    const textarea = screen.getByLabelText("写入消息内容") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "sent A" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    fireEvent.change(textarea, { target: { value: "new unsent draft" } }); // 在途编辑：草稿已被替换
    await act(async () => {
      ws.receive({ t: "write-ack", requestId: "wr-p-1", file: "a.jsonl", outcome: LAUNCHED });
    });
    expect(textarea.value).toBe("new unsent draft"); // B1：ack 只清本次发送对应草稿，不吞在途新输入
    expect(
      screen
        .getAllByRole("status")
        .map((n) => n.textContent)
        .join(),
    ).toContain("已入队（intentId=i-1）");
  });

  it("在途改回同文本（A→B→A）=版本已替换：ack 不清空（版本边界，不做字符串比较）", async () => {
    const { client, ws } = writeHarness();
    render(React.createElement(WriteComposer, { client, file: "a.jsonl" }));
    const textarea = screen.getByLabelText("写入消息内容") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "A" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    fireEvent.change(textarea, { target: { value: "B" } });
    fireEvent.change(textarea, { target: { value: "A" } }); // 改回同文本：版本号已变
    await act(async () => {
      ws.receive({ t: "write-ack", requestId: "wr-p-1", file: "a.jsonl", outcome: LAUNCHED });
    });
    expect(textarea.value).toBe("A"); // 不清空：发生过编辑=草稿已替换（即便文本相等）
  });

  it("file A→B 后 A 的旧 ack：B 新会话草稿不受影响（key=file 换会话即新草稿）", async () => {
    const { client, ws } = writeHarness();
    const view = render(React.createElement(WriteComposer, { client, file: "a.jsonl" }));
    const textareaA = screen.getByLabelText("写入消息内容") as HTMLTextAreaElement;
    fireEvent.change(textareaA, { target: { value: "draft A" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" })); // A 在途
    view.rerender(React.createElement(WriteComposer, { client, file: "b.jsonl" }));
    const textareaB = screen.getByLabelText("写入消息内容") as HTMLTextAreaElement;
    expect(textareaB.value).toBe(""); // 换会话=新草稿（key=file）
    fireEvent.change(textareaB, { target: { value: "draft B" } });
    await act(async () => {
      ws.receive({ t: "write-ack", requestId: "wr-p-1", file: "a.jsonl", outcome: LAUNCHED }); // A 的迟到 ack
    });
    expect(textareaB.value).toBe("draft B"); // 旧会话 ack 不清 B 草稿
  });

  it("client 替换后旧连接的 ack：当前草稿保留（同 file 跨连接身份门）", async () => {
    const oldHarness = writeHarness();
    const view = render(React.createElement(WriteComposer, { client: oldHarness.client, file: "a.jsonl" }));
    const textarea = screen.getByLabelText("写入消息内容") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "draft A" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" })); // 在旧连接在途
    const fresh = writeHarness();
    view.rerender(React.createElement(WriteComposer, { client: fresh.client, file: "a.jsonl" }));
    await act(async () => {
      oldHarness.ws.receive({ t: "write-ack", requestId: "wr-p-1", file: "a.jsonl", outcome: LAUNCHED });
    });
    expect(textarea.value).toBe("draft A"); // 旧连接 ack 不清新连接会话草稿
  });
});

describe("K5 B2：composer 稳定挂载（空态↔内容态不丢草稿/在途/结果）", () => {
  it("空→内容（在途 prompt 期间首条事件到达）：同一 DOM 节点+草稿保留+在途禁用态一致+ack 后结果文案呈现", async () => {
    const sub = new StubSubscribeClient();
    sub.push(detailSnap({ phase: "live", events: [], liveEvents: [] })); // 空会话
    const { client: writeClient, ws } = writeHarness();
    render(
      React.createElement(SessionDetail, {
        client: sub as unknown as SubscribeClientSurface,
        file: "a.jsonl",
        writeClient,
      }),
    );
    const textarea = screen.getByLabelText("写入消息内容") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "在途草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true); // 在途
    sub.push(detailSnap({ phase: "live", events: [msg(1)], liveEvents: [] })); // 首条内容：空→streaming
    expect(screen.getByLabelText("写入消息内容")).toBe(textarea); // 同一 DOM 节点：未卸载重建
    expect(textarea.value).toBe("在途草稿"); // 草稿保留
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true); // 在途态一致（非仅按钮存在）
    await act(async () => {
      ws.receive({ t: "write-ack", requestId: "wr-p-1", file: "a.jsonl", outcome: LAUNCHED });
    });
    expect(textarea.value).toBe(""); // ack 清空（无在途编辑）
    expect(screen.getByText(/#1 消息/)).toBeTruthy(); // 内容呈现
    expect(
      screen
        .getAllByRole("status")
        .map((n) => n.textContent)
        .join(),
    ).toContain("已入队（intentId=i-1）");
  });

  it("内容→空回切：草稿保留（双向稳定）", () => {
    const sub = new StubSubscribeClient();
    sub.push(detailSnap({ phase: "live", events: [msg(1)], liveEvents: [] })); // 内容视图
    const { client: writeClient } = writeHarness();
    render(
      React.createElement(SessionDetail, {
        client: sub as unknown as SubscribeClientSurface,
        file: "a.jsonl",
        writeClient,
      }),
    );
    const textarea = screen.getByLabelText("写入消息内容") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "回切草稿" } });
    sub.push(detailSnap({ phase: "live", events: [], liveEvents: [] })); // 内容→空
    expect(screen.getByLabelText("写入消息内容")).toBe(textarea); // 未重建
    expect(textarea.value).toBe("回切草稿"); // 草稿保留
    expect(screen.getByRole("heading", { name: "空会话" })).toBeTruthy(); // 确已切到空态视图
  });

  it("换 file=新草稿（key=file）；loading/auth-failed/error/closed/unsubscribed 视图不挂 composer（既有行为）", () => {
    const sub = new StubSubscribeClient();
    sub.push(detailSnap({ phase: "live", events: [msg(1)], liveEvents: [] }));
    const { client: writeClient } = writeHarness();
    const view = render(
      React.createElement(SessionDetail, {
        client: sub as unknown as SubscribeClientSurface,
        file: "a.jsonl",
        writeClient,
      }),
    );
    const textareaA = screen.getByLabelText("写入消息内容") as HTMLTextAreaElement;
    fireEvent.change(textareaA, { target: { value: "A 草稿" } });
    sub.push(detailSnap({ file: "b.jsonl", phase: "live", events: [msg(1)], liveEvents: [] }));
    view.rerender(
      React.createElement(SessionDetail, {
        client: sub as unknown as SubscribeClientSurface,
        file: "b.jsonl",
        writeClient,
      }),
    );
    const textareaB = screen.getByLabelText("写入消息内容") as HTMLTextAreaElement;
    expect(textareaB).not.toBe(textareaA); // key=file：换会话新实例
    expect(textareaB.value).toBe(""); // 新草稿，旧草稿不泄漏
    sub.push(detailSnap({ file: "b.jsonl", connState: "connecting", phase: "idle" })); // loading
    expect(screen.queryByLabelText("写入消息内容")).toBeNull(); // loading 不挂 composer（既有行为）
    sub.push(detailSnap({ file: "b.jsonl", connState: "error", errorKind: "auth-failed", phase: "idle" }));
    expect(screen.queryByLabelText("写入消息内容")).toBeNull(); // auth-failed 同
  });
});

describe("K5 B3：瞬态错误身份门（client×file 绑定+动作序号迟到门）", () => {
  let probeB3: { view: WriteView; send: (text: string) => Promise<boolean> } | null = null;
  function ProbeB3({ client, file }: { client: StubWriteClient; file: string | null }): React.ReactElement {
    const { view, send } = useWrite(client, file);
    probeB3 = { view, send };
    return React.createElement("div");
  }

  it("A 失败→file=null：错误全隐（未选会话不呈现旧会话错误）", async () => {
    const client = new StubWriteClient();
    client.rejectWith = new WriteSendError("in-flight", "该会话已有发送中的消息，请等待结果");
    const view = render(React.createElement(ProbeB3, { client, file: "a.jsonl" }));
    await act(async () => {
      await probeB3!.send("hi");
    });
    expect(probeB3?.view.phase).toBe("error"); // A 会话内可见
    view.rerender(React.createElement(ProbeB3, { client, file: null }));
    expect(probeB3?.view.phase).toBe("idle"); // file=null：全隐
    expect(probeB3?.view.errorMessage).toBeNull();
  });

  it("A 失败→切 B 不污染；切回 A 错误重现（与 lastResult 的 file 身份门同语义）", async () => {
    const client = new StubWriteClient();
    client.rejectWith = new WriteSendError("in-flight", "该会话已有发送中的消息，请等待结果");
    const view = render(React.createElement(ProbeB3, { client, file: "a.jsonl" }));
    await act(async () => {
      await probeB3!.send("hi");
    });
    view.rerender(React.createElement(ProbeB3, { client, file: "b.jsonl" }));
    expect(probeB3?.view.phase).toBe("idle"); // B 会话不受 A 失败污染
    expect(probeB3?.view.errorMessage).toBeNull();
    view.rerender(React.createElement(ProbeB3, { client, file: "a.jsonl" }));
    expect(probeB3?.view.phase).toBe("error"); // 回 A：错误重现（属 A 身份）
  });

  it("client 替换：旧 client 的错误不透出到新 client", async () => {
    const oldClient = new StubWriteClient();
    oldClient.rejectWith = new WriteSendError("in-flight", "该会话已有发送中的消息，请等待结果");
    const view = render(React.createElement(ProbeB3, { client: oldClient, file: "a.jsonl" }));
    await act(async () => {
      await probeB3!.send("hi");
    });
    expect(probeB3?.view.phase).toBe("error");
    const freshClient = new StubWriteClient();
    view.rerender(React.createElement(ProbeB3, { client: freshClient, file: "a.jsonl" }));
    expect(probeB3?.view.phase).toBe("idle"); // 新连接无此错误
  });

  it("迟到失败：新动作发出后旧请求才失败→不落账（视图保持新动作态，旧失败不得覆盖）", async () => {
    const client = new DeferringStubClient();
    const view = render(React.createElement(ProbeB3, { client, file: "a.jsonl" }));
    await act(async () => {
      void probeB3!.send("A"); // 动作1：悬置
    });
    view.rerender(React.createElement(ProbeB3, { client, file: "b.jsonl" }));
    await act(async () => {
      void probeB3!.send("B"); // 动作2（最新）
    });
    await act(async () => {
      client.pending[1]!.resolve(LAUNCHED); // 动作2 成功结算
    });
    expect(probeB3?.view.phase).toBe("idle");
    await act(async () => {
      client.pending[0]!.reject(new WriteSendError("in-flight", "该会话已有发送中的消息，请等待结果")); // 动作1 迟到失败
    });
    expect(probeB3?.view.phase).toBe("idle"); // 未落账：不覆盖新动作后的状态
    expect(probeB3?.view.errorMessage).toBeNull();
    view.rerender(React.createElement(ProbeB3, { client, file: "a.jsonl" }));
    expect(probeB3?.view.phase).toBe("idle"); // 回 A 也不出现（根本未落账）
  });
});

// ---------------------------------------------------------------------------
// v1.1 resume 面：writeViewOf resuming 态机 + useWrite resume 动作 + composer 恢复重发演示位
// ---------------------------------------------------------------------------

describe("resume 面：writeViewOf resuming 派生", () => {
  it("resumeState resuming{files}→resuming 态；file 身份门：他 file 不透出；优先级在 sending/stopping 之后", () => {
    const resuming = writeSnap({ resumeState: { phase: "resuming", files: ["a.jsonl"] } });
    expect(writeViewOf(resuming, "a.jsonl", null)).toMatchObject({ phase: "resuming", resuming: true });
    expect(writeViewOf(resuming, "b.jsonl", null)).toMatchObject({ phase: "idle", resuming: false }); // 身份门
    expect(writeViewOf(resuming, null, null).resuming).toBe(false);
    // 优先级：连接级错误 > stopping > sending > resuming > 瞬态错误
    const withPrompt = writeSnap({
      resumeState: { phase: "resuming", files: ["a.jsonl"] },
      inflight: [{ file: "a.jsonl", kind: "prompt" }],
    });
    expect(writeViewOf(withPrompt, "a.jsonl", null)).toMatchObject({ phase: "sending", resuming: true });
    const withStop = writeSnap({
      resumeState: { phase: "resuming", files: ["a.jsonl"] },
      inflight: [{ file: "a.jsonl", kind: "stop" }],
    });
    expect(writeViewOf(withStop, "a.jsonl", null).phase).toBe("stopping");
    expect(writeViewOf(resuming, "a.jsonl", "旧错误").phase).toBe("resuming"); // 在途优先于瞬态
  });

  it("lastResumeResult file 身份门：本文件可见；他文件/file=null 不透出", () => {
    const snap = writeSnap({ lastResumeResult: { ok: true, file: "a.jsonl", outcome: LAUNCHED } });
    expect(writeViewOf(snap, "a.jsonl", null).lastResumeResult).toMatchObject({ ok: true, file: "a.jsonl" });
    expect(writeViewOf(snap, "b.jsonl", null).lastResumeResult).toBeNull();
    expect(writeViewOf(snap, null, null).lastResumeResult).toBeNull();
  });
});

describe("resume 面：useWrite resume 动作", () => {
  let probeResume: {
    view: WriteView;
    resume: (intentId: string, generation: number) => Promise<boolean>;
  } | null = null;
  function ProbeResume({ client, file }: { client: StubWriteClient; file: string | null }): React.ReactElement {
    const { view, resume } = useWrite(client, file);
    probeResume = { view, resume };
    return React.createElement("div");
  }

  it("成功=true 且帧参数透传（file/intentId/generation）；被拒→瞬态错误进视图（resolve false）；新尝试清除", async () => {
    const client = new StubWriteClient();
    render(React.createElement(ProbeResume, { client, file: "a.jsonl" }));
    let ok = false;
    await act(async () => {
      ok = await probeResume!.resume("i-1", 1);
    });
    expect(ok).toBe(true);
    expect(client.calls).toEqual(["resume:a.jsonl:i-1:1"]);
    client.rejectWith = new WriteSendError("server", "计算排队超时，可重试（4409）", 4409);
    await act(async () => {
      ok = await probeResume!.resume("i-1", 1);
    });
    expect(ok).toBe(false); // 恒不 reject
    expect(probeResume?.view.phase).toBe("error");
    expect(probeResume?.view.errorMessage).toBe("计算排队超时，可重试（4409）");
    client.rejectWith = null;
    await act(async () => {
      ok = await probeResume!.resume("i-2", 3);
    });
    expect(ok).toBe(true);
    expect(probeResume?.view.phase).toBe("idle"); // 新尝试清除瞬态错误
  });

  it("file=null：直接 false 且零调用", async () => {
    const client = new StubWriteClient();
    render(React.createElement(ProbeResume, { client, file: null }));
    let ok = true;
    await act(async () => {
      ok = await probeResume!.resume("i-1", 1);
    });
    expect(ok).toBe(false);
    expect(client.calls).toEqual([]);
  });

  it("快照推进 resumeState→视图切 resuming（真客户端快照语义）", () => {
    const client = new StubWriteClient();
    render(React.createElement(ProbeResume, { client, file: "a.jsonl" }));
    client.push(writeSnap({ resumeState: { phase: "resuming", files: ["a.jsonl"] } }));
    expect(probeResume?.view.phase).toBe("resuming");
    expect(probeResume?.view.resuming).toBe(true);
    client.push(
      writeSnap({
        resumeState: { phase: "idle" },
        lastResumeResult: { ok: false, file: "a.jsonl", message: "计算排队超时，可重试（4409）" },
      }),
    );
    expect(probeResume?.view.phase).toBe("idle");
    expect(probeResume?.view.lastResumeResult).toMatchObject({ ok: false, message: "计算排队超时，可重试（4409）" });
  });
});

describe("resume 面：composer 恢复重发演示位（真实链）", () => {
  it("手输 intentId+generation→resume 帧发出；ack 后结果文案呈现；resuming 期间按钮禁用", async () => {
    const { client, ws } = writeHarness();
    render(React.createElement(WriteComposer, { client, file: "a.jsonl" }));
    const resumeButton = () => screen.getByRole("button", { name: "恢复重发" }) as HTMLButtonElement;
    expect(resumeButton().disabled).toBe(true); // 空 intentId 不可发
    fireEvent.change(screen.getByLabelText("恢复重发意图标识"), { target: { value: "i-1" } });
    expect(resumeButton().disabled).toBe(false); // generation 默认 1
    fireEvent.change(screen.getByLabelText("恢复重发进程代次"), { target: { value: "2" } });
    fireEvent.click(resumeButton());
    expect(ws.sentFrames()[1]).toEqual({
      t: "resume",
      requestId: "wr-r-1",
      file: "a.jsonl",
      intentId: "i-1",
      generation: 2,
    });
    expect(resumeButton().disabled).toBe(true); // resuming 在途禁用
    expect(
      screen
        .getAllByRole("status")
        .map((n) => n.textContent)
        .join(),
    ).toContain("恢复重发中…");
    await act(async () => {
      ws.receive({
        t: "write-resume-ack",
        requestId: "wr-r-1",
        file: "a.jsonl",
        outcome: { kind: "launched", intentId: "i-9", commandId: 3 },
      });
    });
    expect(resumeButton().disabled).toBe(false);
    expect(
      screen
        .getAllByRole("status")
        .map((n) => n.textContent)
        .join(),
    ).toContain("已重发入队（intentId=i-9）");
  });

  it("identity-rejected 结果文案按 cause 映射；4409 排队超时走受控瞬态错误横幅（可重试）", async () => {
    const { client, ws } = writeHarness();
    render(React.createElement(WriteComposer, { client, file: "a.jsonl" }));
    fireEvent.change(screen.getByLabelText("恢复重发意图标识"), { target: { value: "i-1" } });
    fireEvent.click(screen.getByRole("button", { name: "恢复重发" }));
    await act(async () => {
      ws.receive({
        t: "write-resume-ack",
        requestId: "wr-r-1",
        file: "a.jsonl",
        outcome: { kind: "identity-rejected", cause: "resume-not-authorized" },
      });
    });
    expect(
      screen
        .getAllByRole("status")
        .map((n) => n.textContent)
        .join(),
    ).toContain("恢复重发被拒：该意图未获重发授权");
    // 再发→4409 排队超时：瞬态错误横幅（受控文案，可重试不锁死入口）
    fireEvent.click(screen.getByRole("button", { name: "恢复重发" }));
    expect(ws.sentFrames()[2]).toMatchObject({ t: "resume", requestId: "wr-r-2" });
    await act(async () => {
      ws.receive({
        t: "error",
        code: 4409,
        message: "compute gate queue timeout",
        retryable: true,
        requestId: "wr-r-2",
      });
    });
    expect(screen.getByRole("alert").textContent).toBe("计算排队超时，可重试（4409）");
    expect((screen.getByRole("button", { name: "恢复重发" }) as HTMLButtonElement).disabled).toBe(false); // 可重试
  });
});
