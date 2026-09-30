// @vitest-environment jsdom
// M-UX 批2 D05（设计 v7）：get-roots 请求身份三件（递增 requestId+10s timer 捕获身份+重试新身份替代旧请求）
// 批3 减法后：目录选择器/等待面整体退役（requestRoots 数据域保留）。
// B4 改批3 断言：零目录元素+零等待面+零超时出口；创建永不因 roots 阻塞。
// timer 打回；M1 卸载后 R2 迟到回包入缓存；超时/重试后旧 R1 零覆盖；既有 t=10/t=11 断言保留
//（ws-client.test.ts v1.5 节五例不回归）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

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

describe("M-UX 批2 D05 请求域：身份三件+超时/重试零覆盖", () => {
  it("递增 requestId：两次请求（failed 重发）→get-roots-1/get-roots-2；回帧按身份结算", () => {
    client.requestRoots();
    const r1 = (ws.sentFrames().at(-1) as { requestId: string }).requestId;
    expect(r1).toBe("get-roots-1");
    ws.receive({ t: "error", code: 4402, message: "m", retryable: false, requestId: r1 });
    expect(client.getSnapshot().roots.status).toBe("failed");
    client.requestRoots(); // failed 可重发（新身份替代旧请求）
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

  it("重试后旧 R1 零覆盖：超时 failed→重试发 R2→R1 迟到回包被身份核验拒", () => {
    vi.useFakeTimers();
    client.requestRoots();
    const r1 = (ws.sentFrames().at(-1) as { requestId: string }).requestId;
    vi.advanceTimersByTime(10_000);
    expect(client.getSnapshot().roots.status).toBe("failed");
    client.requestRoots(); // 重试：新身份 R2 立即生效
    const r2 = (ws.sentFrames().at(-1) as { requestId: string }).requestId;
    expect(r2).toBe("get-roots-2");
    expect(client.getSnapshot().roots.status).toBe("loading");
    ws.receive({ t: "roots-list", requestId: r1, roots: ["/evil"] }); // 旧 R1 迟到
    expect(client.getSnapshot().roots.status).toBe("loading"); // 零覆盖（仍 R2 在途）
    ws.receive({ t: "roots-list", requestId: r2, roots: ROOTS }); // R2 正常结算
    expect(client.getSnapshot().roots.status).toBe("ok");
    expect(client.getSnapshot().roots.items).toEqual(ROOTS);
  });

  it("成功取消所属 timer：结算当下物理清零（R2-P1-01 口径：pending 门兜底≠物理清理）", () => {
    vi.useFakeTimers();
    client.requestRoots();
    const r1 = (ws.sentFrames().at(-1) as { requestId: string }).requestId;
    expect(vi.getTimerCount()).toBe(1); // 在途恰一个 timer
    ws.receive({ t: "roots-list", requestId: r1, roots: ROOTS });
    expect(client.getSnapshot().roots.status).toBe("ok");
    expect(vi.getTimerCount()).toBe(0); // 成功结算物理撤销（非 pending 门拦截）
    vi.advanceTimersByTime(20_000);
    expect(client.getSnapshot().roots.status).toBe("ok"); // 残留 timer 零副作用（双保险）
  });
});

describe("M-UX 批2 D05 数据域：M1 卸载后迟到回包照常入缓存（R2-P1-01：真 client 接线，非脱节 stub）", () => {
  it("组件挂载真发 get-roots→卸载→迟到回包入 WsClient 缓存→重挂不重发", async () => {
    const { render } = await import("@testing-library/react");
    const React = (await import("react")).default;
    const { NewSession } = await import("../../../apps/web/src/components/new-session");
    vi.useFakeTimers();
    const writeStub = {
      sendPrompt: () => Promise.resolve({ kind: "launched" }),
      getNotReady: () => null,
      subscribe: client.subscribe as never,
      getSnapshot: () => ({ connState: "ready" }),
    };
    const mk = () => React.createElement(NewSession, {
      wsClient: client, // 真 WsClient：挂载 effect 真发 get-roots（写连接 ready 即发）
      writeClient: writeStub as never,
      onLaunched: () => {},
      onCancel: () => {},
    });
    const r1 = render(mk()); // 挂载：effect 真发 get-roots-1（此 client 已 welcome/ready）
    await act(async () => { await Promise.resolve(); });
    const rid = (ws.sentFrames().findLast((f) => (f as { t: string }).t === "get-roots") as { requestId: string }).requestId;
    expect(rid).toMatch(/^get-roots-\d+$/); // 组件自己发的（非测试驱动）
    r1.unmount(); // 卸载：消费者离开，数据域（WsClient）不受影响
    ws.receive({ t: "roots-list", requestId: rid, roots: ROOTS }); // 迟到回包（组件已不在）
    expect(client.getSnapshot().roots.status).toBe("ok"); // 照常入账（下次挂载可用）
    expect(client.getSnapshot().roots.items).toEqual(ROOTS);
    const before = ws.sentFrames().length;
    const r2 = render(mk()); // 重挂：ok 幂等门→不重发
    await act(async () => { await Promise.resolve(); });
    expect(ws.sentFrames().length).toBe(before); // 零新请求
    r2.unmount();
  });
});;

describe("批3 D05 页面等待域退役：目录减法（B4 改造）", () => {
  it("roots 永不回包：页面无任何等待面/超时出口——用户无感，直接可创建（默认目录）", async () => {
    vi.useFakeTimers();
    const { render, screen, act } = await import("@testing-library/react");
    const React = (await import("react")).default;
    const { NewSession } = await import("../../../apps/web/src/components/new-session");
    const listeners = new Set<() => void>();
    const snap: Record<string, unknown> = {
      state: "authenticating", // 无 welcome——请求从未发出（旧 B4 场景：曾挂 10s 总截止+超时出口）
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
      onLaunched: () => {},
      onCancel: () => {},
    });
    render(el);
    expect(screen.queryByLabelText("项目目录")).toBeNull(); // 零目录元素（批3）
    expect(screen.queryByText(/项目目录清单加载中|拉取超时/)).toBeNull(); // 无等待面无超时出口
    await act(async () => { vi.advanceTimersByTime(60_000); }); // 任意久：永不出现目录等待/超时
    expect(screen.queryByLabelText("项目目录")).toBeNull();
    expect(screen.queryByText(/拉取超时/)).toBeNull();
    // 直接可创建：填首条消息→钮可点（roots 状态完全不阻塞）
    fireEvent.change(screen.getByRole("textbox", { name: "首条消息" }), { target: { value: "hi" } });
    const btn = screen.getByRole("button", { name: "创建会话" });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });

  it("roots 中途 ok 到达：页面零反应（目录域状态不冒泡到 UI）；requestRoots 数据域保留", async () => {
    vi.useFakeTimers();
    const { render, screen, act } = await import("@testing-library/react");
    const React = (await import("react")).default;
    const { NewSession } = await import("../../../apps/web/src/components/new-session");
    const listeners = new Set<() => void>();
    let snapNow: Record<string, unknown> = {
      state: "ready",
      models: { status: "ok", items: [], cause: null },
      roots: { status: "loading", items: [], journalRoot: null, cause: null },
    };
    const snap: Record<string, unknown> = {};
    snap.getSnapshot = () => snapNow as never;
    snap.subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
    let rootsCalls = 0;
    const writeStub = {
      sendPrompt: () => Promise.resolve({ kind: "launched" }),
      getNotReady: () => null,
      subscribe: snap.subscribe as never,
      getSnapshot: () => ({ connState: "ready" }),
    };
    const el = React.createElement(NewSession, {
      wsClient: { requestModels: () => {}, requestRoots: () => { rootsCalls++; }, subscribe: snap.subscribe as never, getSnapshot: snap.getSnapshot as never },
      writeClient: writeStub as never,
      onLaunched: () => {},
      onCancel: () => {},
    });
    render(el);
    expect(rootsCalls).toBeGreaterThanOrEqual(1); // 数据域保留（兼容；UI 无目录消费面）
    await act(async () => {
      vi.advanceTimersByTime(8_000);
      snapNow = { ...snapNow, roots: { status: "ok", items: ["/journal", "/home/yyj/ai"], journalRoot: "/journal", cause: null } };
      listeners.forEach((cb) => cb());
    });
    expect(screen.queryByLabelText("项目目录")).toBeNull(); // ok 到达：不出现选择器（批3 砍渲染）
    await act(async () => { vi.advanceTimersByTime(2_000); });
    expect(screen.queryByLabelText("项目目录")).toBeNull();
    expect(screen.queryByText(/拉取超时/)).toBeNull();
  });
});

// ---------- M-UX 批2b D04：模型选择域守卫（B3 五断言，设计 v4 D04 定案） ----------
// 域分离：modelChoice(已确认选择)+freeText(草稿)（批2r2 已删意图门 userTouchedModel/转移锚 lastNonCustom 死状态）。
// 持久化过滤：select 只写 __default__ 或过完整 modelPattern 的拼合值；清单项校验=完整正则禁选。
async function renderNewSession(
  listeners: Set<() => void>,
  getSnap: () => unknown,
  sendPromptImpl: (f: string, t: string, model: string | undefined) => Promise<{ kind: string; cause?: string; detail?: string }> = () => Promise.resolve({ kind: "launched" }),
): Promise<{ fireEvent: typeof import("@testing-library/react").fireEvent; screen: typeof import("@testing-library/react").screen; act: typeof import("@testing-library/react").act; unmount: () => void }> {
  const React = (await import("react")).default;
  const rtl = await import("@testing-library/react");
  const { NewSession } = await import("../../../apps/web/src/components/new-session");
  const writeStub = {
    sendPrompt: sendPromptImpl,
    getNotReady: () => null,
    subscribe: (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    getSnapshot: () => ({ connState: "ready" }),
  };
  const wsStub = {
    requestModels: () => {},
    requestRoots: () => {},
    subscribe: (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    getSnapshot: getSnap,
  };
  const el = React.createElement(NewSession, {
    wsClient: wsStub as never,
    writeClient: writeStub as never,
    onLaunched: () => {},
    onCancel: () => {},
  });
  const r = rtl.render(el);
  return { fireEvent: rtl.fireEvent, screen: rtl.screen, act: rtl.act, unmount: r.unmount };
}

describe("M-UX 批2b D04 模型选择域守卫（B3）", () => {
  it("B3-1 初次非法编辑意图冻结：草稿保留+非法提示+清单到达不清草稿", async () => {
    const listeners = new Set<() => void>();
    let modelsNow: Record<string, unknown> = { status: "idle", items: [], cause: null };
    let snapNow: Record<string, unknown> = { state: "ready", models: modelsNow, roots: { status: "ok", items: ["/r", "/home/yyj/ai"], journalRoot: null, cause: null } };
    const { fireEvent, screen, act } = await renderNewSession(listeners, () => snapNow);
    fireEvent.change(screen.getByRole("textbox", { name: "模型 id 直达" }), { target: { value: "!!!非法!!!" } });
    expect(screen.getByText("模型标识非法")).toBeTruthy(); // 非法即时提示
    expect(screen.getByText(/自定义：!!!非法!!!/)).toBeTruthy(); // 意图冻结：草稿不被冲掉
    // 清单到达（ok）：用户草稿仍保留（意图门）
    modelsNow = { status: "ok", items: [{ provider: "p", id: "m1", context: "8k" }], cause: null };
    snapNow = { ...snapNow, models: modelsNow };
    await act(async () => {
      listeners.forEach((cb) => cb());
      await Promise.resolve();
    });
    // P2-03（GPT 批2审）：先证新清单确已渲染（p / m1 option 在视图），再核草稿冻结——
    // 无 act 的同步断言可能只断到更新前 DOM，证明不了「清单到达后」语义。
    expect(screen.getByText(/p \/ m1/)).toBeTruthy();
    expect(screen.getByText(/自定义：!!!非法!!!/)).toBeTruthy();
    // 清空草稿：回已确认选择（默认），非 custom 态清空不动 activeSelection
    fireEvent.change(screen.getByRole("textbox", { name: "模型 id 直达" }), { target: { value: "" } });
    expect(screen.queryByText(/自定义/)).toBeNull();
    expect((screen.getByRole("combobox", { name: "模型选择" }) as HTMLSelectElement).value).toBe("__default__");
  });

  it("B3-2 custom 内编辑不覆盖锚：X→Y→清空回转移前选择（非 X 非 Y）", async () => {
    const listeners = new Set<() => void>();
    const models: Record<string, unknown> = { status: "ok", items: [{ provider: "p", id: "B" }], cause: null };
    let snapNow: Record<string, unknown> = { state: "ready", models, roots: { status: "ok", items: ["/r", "/home/yyj/ai"], journalRoot: null, cause: null } };
    const { fireEvent, screen } = await renderNewSession(listeners, () => snapNow);
    // 先 select B（已确认选择）
    fireEvent.change(screen.getByRole("combobox", { name: "模型选择" }), { target: { value: "p/B" } });
    expect((screen.getByRole("combobox", { name: "模型选择" }) as HTMLSelectElement).value).toBe("p/B");
    // 进 custom（转移锚=B）→编辑 X→Y
    const ta = screen.getByRole("textbox", { name: "模型 id 直达" });
    fireEvent.change(ta, { target: { value: "x/y" } });
    fireEvent.change(ta, { target: { value: "x/yy" } });
    expect(screen.getByText(/自定义：x\/yy/)).toBeTruthy();
    // 清空：回转移前选择 B（非 X 非 Y）
    fireEvent.change(ta, { target: { value: "" } });
    expect((screen.getByRole("combobox", { name: "模型选择" }) as HTMLSelectElement).value).toBe("p/B");
  });

  it("B3-3 custom→B→清空仍 B：已确认选择不被草稿生命周期扰动", async () => {
    const listeners = new Set<() => void>();
    const models: Record<string, unknown> = { status: "ok", items: [{ provider: "p", id: "B" }], cause: null };
    let snapNow: Record<string, unknown> = { state: "ready", models, roots: { status: "ok", items: ["/r", "/home/yyj/ai"], journalRoot: null, cause: null } };
    const { fireEvent, screen } = await renderNewSession(listeners, () => snapNow);
    const ta = screen.getByRole("textbox", { name: "模型 id 直达" });
    fireEvent.change(ta, { target: { value: "c/d" } }); // custom
    fireEvent.change(screen.getByRole("combobox", { name: "模型选择" }), { target: { value: "p/B" } }); // 显式切回 B
    fireEvent.change(ta, { target: { value: "" } }); // 清空（本已空）→无操作
    expect((screen.getByRole("combobox", { name: "模型选择" }) as HTMLSelectElement).value).toBe("p/B");
  });

  it("B3-4 modelPattern 全正则禁选：拼合值不过正则的清单项 disabled+标不可用", async () => {
    const listeners = new Set<() => void>();
    // provider 含空格+感叹号→拼合值 "Bad Prov!/m1" 不过 ^[\w./:-]{1,128}$
    const models: Record<string, unknown> = { status: "ok", items: [{ provider: "Bad Prov!", id: "m1" }, { provider: "p", id: "ok1" }], cause: null };
    let snapNow: Record<string, unknown> = { state: "ready", models, roots: { status: "ok", items: ["/r", "/home/yyj/ai"], journalRoot: null, cause: null } };
    const { screen } = await renderNewSession(listeners, () => snapNow);
    const sel = screen.getByRole("combobox", { name: "模型选择" }) as HTMLSelectElement;
    const optBad = Array.from(sel.options).find((o) => o.value === "Bad Prov!/m1");
    const optOk = Array.from(sel.options).find((o) => o.value === "p/ok1");
    expect(optBad?.disabled).toBe(true);
    expect(optBad?.textContent).toContain("不可用");
    expect(optOk?.disabled).toBe(false);
    expect(optOk?.textContent).not.toContain("不可用");
  });

  it("B3-5 默认重试不声称显示实际模型：not-ready 默认态说明文案", async () => {
    const listeners = new Set<() => void>();
    const models: Record<string, unknown> = { status: "ok", items: [{ provider: "p", id: "ok1" }], cause: null };
    const snapNow: Record<string, unknown> = { state: "ready", models, roots: { status: "ok", items: ["/r", "/home/yyj/ai"], journalRoot: null, cause: null } };
    let sentModel: string | undefined = "__unset__";
    const act = (await import("@testing-library/react")).act;
    const { fireEvent, screen } = await renderNewSession(listeners, () => snapNow, (_f, _t, model) => {
      sentModel = model;
      return Promise.resolve({ kind: "not-ready", cause: "spawn", detail: "boom" });
    });
    // 默认态（不选模型）填首条消息→创建→not-ready
    fireEvent.change(screen.getByRole("textbox", { name: "首条消息" }), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "创建会话" }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(sentModel).toBeUndefined(); // 发送未指定模型
    const note = screen.getByRole("note");
    expect(note.textContent).toContain("不指定模型");
    expect(note.textContent).toContain("不会被重置");
    // 选模型后重试 not-ready：默认说明不出现（不声称实际模型）
    fireEvent.change(screen.getByRole("combobox", { name: "模型选择" }), { target: { value: "p/ok1" } });
    sentModel = "__unset__";
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(sentModel).toBe("p/ok1");
    expect(screen.queryByRole("note")).toBeNull();
  });
});
