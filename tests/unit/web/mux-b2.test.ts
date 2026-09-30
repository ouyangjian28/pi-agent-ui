// @vitest-environment jsdom
// M-UX 批2 D05（设计 v7）：get-roots 请求身份三件（递增 requestId+10s timer 捕获身份+force 替换）
// +挂载级总截止（页面等待域）+分域守卫（数据域 vs 页面等待域）。
// B4 断言五条（设计 v7 D09 表）：无 welcome 无 pending→t=10 仍 failed 可创建；成功不被剩余总
// timer 打回；M1 卸载后 R2 迟到回包入缓存；超时/force 后旧 R1 零覆盖；既有 t=10/t=11 断言保留
//（ws-client.test.ts v1.5 节五例不回归）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(cleanup);
import { fireEvent } from "@testing-library/react";
import { WsClient } from "../../../apps/web/src/ws/ws-client";

const WELCOME = { t: "welcome", serverBootId: "boot-1", serverBuildId: "b", protocolVersion: 1 } as const;
const ROOTS = ["/journal", "/home/yyj/ai"];

class FakeWebSocket implements WebSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: { readonly code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string): void { this.sent.push(data); }
  open(): void { this.readyState = 1; this.onopen?.(); }
  close(code = 1000): void { this.readyState = 3; this.onclose?.({ code }); }
  receive(frame: unknown): void { this.onmessage?.({ data: JSON.stringify(frame) }); }
  sentFrames(): unknown[] { return this.sent.map((s) => JSON.parse(s) as unknown); }
}

let ws: FakeWebSocket;
let client: WsClient;

beforeEach(() => {
  ws = new FakeWebSocket("ws://x");
  client = new WsClient("ws://x", "tok", () => ws);
  client.connect();
  ws.open();
  ws.receive(WELCOME);
});

afterEach(() => {
  client.close();
  vi.useRealTimers();
});

describe("M-UX 批2 D05 请求域：身份三件+超时/force 零覆盖", () => {
  it("递增 requestId：两次 force（failed 重发）→get-roots-1/get-roots-2；回帧按身份结算", () => {
    client.requestRoots();
    const r1 = (ws.sentFrames().at(-1) as { requestId: string }).requestId;
    expect(r1).toBe("get-roots-1");
    ws.receive({ t: "error", code: 4402, message: "m", retryable: false, requestId: r1 });
    expect(client.getSnapshot().roots.status).toBe("failed");
    client.requestRoots(); // failed 可重发（force）
    const r2 = (ws.sentFrames().at(-1) as { requestId: string }).requestId;
    expect(r2).toBe("get-roots-2");
    ws.receive({ t: "roots-list", requestId: r2, roots: ROOTS });
    expect(client.getSnapshot().roots.status).toBe("ok");
    expect(client.getSnapshot().roots.items).toEqual(ROOTS);
  });

  it("请求超时：10s 到点身份仍匹配→failed(timeout)；迟到 R1 roots-list 零覆盖", () => {
    vi.useFakeTimers();
    client.requestRoots();
    const r1 = (ws.sentFrames().at(-1) as { requestId: string }).requestId;
    expect(client.getSnapshot().roots.status).toBe("loading");
    vi.advanceTimersByTime(10_000);
    const r = client.getSnapshot().roots;
    expect(r.status).toBe("failed");
    expect(r.cause).toContain("timeout");
    // 迟到 R1 回包（旧身份）：不覆盖 failed 结算
    ws.receive({ t: "roots-list", requestId: r1, roots: ROOTS });
    expect(client.getSnapshot().roots.status).toBe("failed");
    expect(client.getSnapshot().roots.items).toEqual([]);
  });

  it("force 后旧 R1 零覆盖：超时 failed→重试发 R2→R1 迟到回包被身份核验拒", () => {
    vi.useFakeTimers();
    client.requestRoots();
    const r1 = (ws.sentFrames().at(-1) as { requestId: string }).requestId;
    vi.advanceTimersByTime(10_000);
    expect(client.getSnapshot().roots.status).toBe("failed");
    client.requestRoots(); // force：新身份 R2 立即生效
    const r2 = (ws.sentFrames().at(-1) as { requestId: string }).requestId;
    expect(r2).toBe("get-roots-2");
    expect(client.getSnapshot().roots.status).toBe("loading");
    ws.receive({ t: "roots-list", requestId: r1, roots: ["/evil"] }); // 旧 R1 迟到
    expect(client.getSnapshot().roots.status).toBe("loading"); // 零覆盖（仍 R2 在途）
    ws.receive({ t: "roots-list", requestId: r2, roots: ROOTS }); // R2 正常结算
    expect(client.getSnapshot().roots.status).toBe("ok");
    expect(client.getSnapshot().roots.items).toEqual(ROOTS);
  });

  it("成功取消所属 timer：R2 结算后再推进 10s 不打回 failed（timer 清理）", () => {
    vi.useFakeTimers();
    client.requestRoots();
    const r1 = (ws.sentFrames().at(-1) as { requestId: string }).requestId;
    ws.receive({ t: "roots-list", requestId: r1, roots: ROOTS });
    expect(client.getSnapshot().roots.status).toBe("ok");
    vi.advanceTimersByTime(20_000);
    expect(client.getSnapshot().roots.status).toBe("ok"); // 残留 timer 零副作用
  });
});

describe("M-UX 批2 D05 数据域：M1 卸载后迟到回包照常入缓存", () => {
  it("组件卸载（无消费者）后 roots-list 到达→WsClient 快照照常 ok（供下次挂载/列表用）", async () => {
    const { render } = await import("@testing-library/react");
    const React = (await import("react")).default;
    const { NewSession } = await import("../../../apps/web/src/components/new-session");
    vi.useFakeTimers();
    const listeners = new Set<() => void>();
    const snap: Record<string, unknown> = {
      state: "ready",
      models: { status: "ok", items: [], cause: null },
      roots: { status: "loading", items: [], journalRoot: null, cause: null },
    };
    snap.getSnapshot = () => snap;
    snap.subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
    const writeStub = {
      sendPrompt: () => Promise.resolve({ kind: "launched" }),
      getNotReady: () => null,
      subscribe: snap.subscribe as never,
      getSnapshot: () => ({ connState: "ready" }),
    };
    const el = React.createElement(NewSession, {
      wsClient: { requestModels: () => {}, requestRoots: () => {}, subscribe: snap.subscribe as never, getSnapshot: snap.getSnapshot as never },
      writeClient: writeStub as never,
      rootsHint: "x",
      onLaunched: () => {},
      onCancel: () => {},
    });
    const { unmount } = render(el);
    unmount(); // M1 卸载——页面等待域 timer 已清，但数据域（WsClient）不受影响
    // R2 迟到回包（组件已不在）：数据域照常入账
    client.requestRoots();
    const rid = (ws.sentFrames().at(-1) as { requestId: string }).requestId;
    ws.receive({ t: "roots-list", requestId: rid, roots: ROOTS });
    expect(client.getSnapshot().roots.status).toBe("ok");
    expect(client.getSnapshot().roots.items).toEqual(ROOTS);
  });
});

describe("M-UX 批2 D05 页面等待域：挂载总截止（B4）", () => {
  it("无 welcome 从未有 pending→t=10 仍超时出口（默认目录可创建）", async () => {
    vi.useFakeTimers();
    const { render, screen, act } = await import("@testing-library/react");
    const React = (await import("react")).default;
    const { NewSession } = await import("../../../apps/web/src/components/new-session");
    const listeners = new Set<() => void>();
    const snap: Record<string, unknown> = {
      state: "authenticating", // 无 welcome——请求从未发出
      models: { status: "idle", items: [], cause: null },
      roots: { status: "idle", items: [], journalRoot: null, cause: null },
    };
    snap.getSnapshot = () => snap;
    snap.subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
    const writeStub = {
      sendPrompt: () => Promise.resolve({ kind: "launched" }),
      getNotReady: () => null,
      subscribe: snap.subscribe as never,
      getSnapshot: () => ({ connState: "ready" }),
    };
    const el = React.createElement(NewSession, {
      wsClient: { requestModels: () => {}, requestRoots: () => {}, subscribe: snap.subscribe as never, getSnapshot: snap.getSnapshot as never },
      writeClient: writeStub as never,
      rootsHint: "x",
      onLaunched: () => {},
      onCancel: () => {},
    });
    render(el);
    expect(screen.getByText(/项目目录清单加载中/)).toBeTruthy(); // t<10 等待
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(screen.getByText(/拉取超时（10s）/)).toBeTruthy(); // t=10 超时出口
    expect(screen.queryByText(/项目目录清单加载中/)).toBeNull(); // 等待视图被替换
    // 默认目录常驻可创建：填首条消息后创建钮可点（roots 超时不阻塞创建）
    fireEvent.change(screen.getByRole("textbox", { name: "首条消息" }), { target: { value: "hi" } });
    const btn = screen.getByRole("button", { name: "创建会话" });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });

  it("请求成功不被剩余总 timer 打回：ok 到达→t=10 fire→仍 ok 视图（零动作）", async () => {
    vi.useFakeTimers();
    const { render, screen, act } = await import("@testing-library/react");
    const React = (await import("react")).default;
    const { NewSession } = await import("../../../apps/web/src/components/new-session");
    const listeners = new Set<() => void>();
    // 稳定引用快照：useSyncExternalStore 按引用比变化——更新时整体换对象，绝不每次 getSnapshot 造新对象
    let snapNow: Record<string, unknown> = {
      state: "ready",
      models: { status: "ok", items: [], cause: null },
      roots: { status: "loading", items: [], journalRoot: null, cause: null },
    };
    const snap: Record<string, unknown> = {};
    snap.getSnapshot = () => snapNow as never;
    snap.subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
    const writeStub = {
      sendPrompt: () => Promise.resolve({ kind: "launched" }),
      getNotReady: () => null,
      subscribe: snap.subscribe as never,
      getSnapshot: () => ({ connState: "ready" }),
    };
    const el = React.createElement(NewSession, {
      wsClient: { requestModels: () => {}, requestRoots: () => {}, subscribe: snap.subscribe as never, getSnapshot: snap.getSnapshot as never },
      writeClient: writeStub as never,
      rootsHint: "x",
      onLaunched: () => {},
      onCancel: () => {},
    });
    render(el);
    // 8s 时请求成功（ok）——总 timer 还剩 2s
    await act(async () => {
      vi.advanceTimersByTime(8_000);
      snapNow = { ...snapNow, roots: { status: "ok", items: ["/journal", "/home/yyj/ai"], journalRoot: "/journal", cause: null } };
      listeners.forEach((cb) => cb());
    });
    expect(screen.getByRole("combobox", { name: "项目目录" })).toBeTruthy(); // 选择器出现
    // 剩余总 timer fire：零动作——ok 不被打回
    await act(async () => { vi.advanceTimersByTime(2_000); });
    expect(screen.getByRole("combobox", { name: "项目目录" })).toBeTruthy();
    expect(screen.queryByText(/拉取超时/)).toBeNull();
  });
});
