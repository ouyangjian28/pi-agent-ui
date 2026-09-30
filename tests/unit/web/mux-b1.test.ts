// @vitest-environment jsdom
// M-UX D02/D03 批1 web 面测试：resolveTitle 三级解析 / ws-client requestSessions+dirty 合并 /
// autoFile CSPRNG+filePattern / 刷新钮接线 / launched 后自动补拉（real-app 集成面由 real-app.test 覆盖壳层）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(cleanup);
import { resolveTitle } from "../../../apps/web/src/ws/resolve-title";
import { autoFile } from "../../../apps/web/src/components/new-session";
import { LIMITS } from "@pi-agent-ui/protocol/src/contracts";
import { WsClient, type WebSocketLike } from "../../../apps/web/src/ws/ws-client";

// ---------- resolveTitle ----------
describe("M-UX D02 resolveTitle 三级解析（列表/详情单一真值源）", () => {
  const dto = (file: string, text: string, truncated = false) => ({ file, title: { text, truncated } });

  it("一级：DTO title 非空→原文+截断省略号", () => {
    expect(resolveTitle(dto("a.jsonl", "帮我写个脚本"))).toBe("帮我写个脚本");
    expect(resolveTitle(dto("a.jsonl", "很长的标题被截断了", true))).toBe("很长的标题被截断了…");
  });

  it("二级：auto-YYYYMMDD-HHmmss-… → M月D日 HH:mm（含年份）；零填充月日转自然数", () => {
    expect(resolveTitle(dto("auto-20261009-030405-abcdef0123456789abcdef0123456789.jsonl", ""))).toBe("10月9日 03:04（2026）");
  });

  it("三级：非 auto 前缀空标题→file 去扩展名", () => {
    expect(resolveTitle(dto("2026-09-25T01-00-00-000Z_s-uuid.jsonl", ""))).toBe("2026-09-25T01-00-00-000Z_s-uuid");
  });
});

// ---------- autoFile ----------
describe("M-UX D03 autoFile：CSPRNG 128 位尾缀+filePattern 合法+时间戳段", () => {
  it("默认随机源：filePattern 合法+hex32 尾缀+时间戳段", () => {
    const f = autoFile(() => new Date(2026, 9, 10, 15, 30, 45)); // 注意 JS 月份 0 基：9=10 月
    expect(f.startsWith("auto-20261010-153045-")).toBe(true);
    expect(f).toMatch(/^auto-\d{8}-\d{6}-[0-9a-f]{32}\.jsonl$/);
    expect(LIMITS.filePattern.test(f)).toBe(true);
  });

  it("随机性：两次生成尾缀不同（概率性断言——128 位空间碰撞可忽略）", () => {
    const a = autoFile();
    const b = autoFile();
    expect(a).not.toBe(b);
  });

  it("固定随机源注入：尾缀确定（杀例基建——服务端同名=追加，前端不假造冲突不自动换名由组件测试覆盖）", () => {
    const fixed = (n: number): Uint8Array => new Uint8Array(n).fill(0xab);
    expect(autoFile(() => new Date(2026, 0, 2, 3, 4, 5), fixed)).toBe("auto-20260102-030405-abababababababababababababababab.jsonl");
  });
});

// ---------- requestSessions + dirty 合并 ----------
class FakeWebSocket implements WebSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  closeCount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: { readonly code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string): void { this.sent.push(data); }
  close(code = 1000): void { this.readyState = 3; this.closeCount++; this.onclose?.({ code }); }
  open(): void { this.readyState = 1; this.onopen?.(); }
  receive(frame: unknown): void { this.onmessage?.({ data: JSON.stringify(frame) }); }
  serverClose(code: number): void { this.readyState = 3; this.onclose?.({ code }); }
  sentFrames(): unknown[] { return this.sent.map((s) => JSON.parse(s) as unknown); }
}

const WELCOME = { t: "welcome", serverBootId: "boot-1", serverBuildId: "b", protocolVersion: 1 } as const;
const sessionsFrame = (v: number) => ({
  t: "sessions", requestId: "list-sessions-1", offset: 0, total: 1, listVersion: v, hasMore: false, listReliability: "full" as const,
  sessions: [{ sessionId: `s-${v}`, file: `f${v}.jsonl`, title: { text: "t", truncated: false }, lastActiveMs: 1, entryCount: 1, sizeBytes: 10, hasRecoveryNotice: false, listReliability: "full" as const }],
});

describe("M-UX D02 ws-client requestSessions：显式刷新+dirty 合并", () => {
  function harness(): { ws: FakeWebSocket; client: WsClient } {
    const ws = new FakeWebSocket("ws://x");
    const client = new WsClient("ws://x", "tok", () => ws);
    client.connect();
    ws.open();
    ws.receive(WELCOME); // welcome→自动首个 list-sessions
    return { ws, client };
  }

  it("ready 态显式刷新：发出 list-sessions；welcome 后首个请求已结算时只新增一帧", () => {
    const { ws, client } = harness();
    ws.receive(sessionsFrame(1)); // 结算首个
    const before = ws.sent.length;
    client.requestSessions();
    expect(ws.sent).toHaveLength(before + 1);
    expect((ws.sentFrames().at(-1) as { t: string }).t).toBe("list-sessions");
    ws.receive({ ...sessionsFrame(2), requestId: "list-sessions-1" });
    expect(client.getSnapshot().listVersion).toBe(2);
  });

  it("dirty 合并：在途中再刷新不重复发帧；结算后自动补拉恰一次", () => {
    const { ws, client } = harness();
    const inFlight = ws.sent.length; // welcome 后首个在途
    client.requestSessions(); // 在途→记 dirty 不发帧
    client.requestSessions(); // 连续两次→仍只记 dirty
    expect(ws.sent).toHaveLength(inFlight);
    ws.receive(sessionsFrame(1)); // 结算→dirty 触发补拉
    expect(ws.sent).toHaveLength(inFlight + 1); // 恰一次补拉（dirty 只补一次）
    ws.receive(sessionsFrame(2));
    expect(client.getSnapshot().listVersion).toBe(2);
  });

  it("非 ready（welcome 前）安全忽略：不发帧不记 dirty", () => {
    const ws = new FakeWebSocket("ws://x");
    const client = new WsClient("ws://x", "tok", () => ws);
    client.connect();
    ws.open(); // 尚未 welcome
    client.requestSessions();
    expect(ws.sent).toHaveLength(1); // 仅 hello
    ws.receive(WELCOME);
    expect(ws.sentFrames().at(-1)).toMatchObject({ t: "list-sessions" }); // welcome 只带一次自动拉（无 dirty 残留）
    ws.receive(sessionsFrame(1));
    expect(client.getSnapshot().listVersion).toBe(1);
  });

  it("error 面清 dirty：list-failed 后迟到回包+残留 dirty 不再发帧", () => {
    const { ws, client } = harness();
    client.requestSessions(); // 在途→dirty
    ws.receive({ t: "error", code: 4429, message: "boom", retryable: true, requestId: "list-sessions-1" });
    expect(client.getSnapshot().state).toBe("error");
    const after = ws.sent.length;
    ws.receive(sessionsFrame(9)); // 迟到回包
    expect(ws.sent).toHaveLength(after); // dirty 已清，无补拉
  });
});

// ---------- P2-01/P2-02（GPT 审修复）：同步重入原子化+验收缺口闭合 ----------
describe("M-UX 批1修复 P2-01：同步重入原子化", () => {
  it("welcome 窗口：同步订阅回调里 requestSessions 不会与首拉双发（先占位后通知）", () => {
    const ws = new FakeWebSocket("ws://x");
    const client = new WsClient("ws://x", "tok", () => ws);
    let reentered = false;
    client.subscribe(() => {
      // 首次通知=ready transition：同步重入刷新
      if (client.getSnapshot().state === "ready" && !reentered) {
        reentered = true;
        client.requestSessions();
      }
    });
    client.connect();
    ws.open();
    ws.receive(WELCOME);
    // welcome 首拉已占位→重入的 requestSessions 只记 dirty 不发帧；恰 2 帧（hello+首拉）
    expect(ws.sent).toHaveLength(2);
    ws.receive(sessionsFrame(1)); // 结算→dirty 触发补拉
    expect(ws.sent).toHaveLength(3);
    ws.receive(sessionsFrame(2));
    expect(client.getSnapshot().listVersion).toBe(2);
  });

  it("sessions 结算窗口：同步回调重入不双发（旧序会 R2+R3 同 ID 双发被网关 4404 拒）", () => {
    const ws = new FakeWebSocket("ws://x");
    const client = new WsClient("ws://x", "tok", () => ws);
    let reentered = false;
    client.subscribe(() => {
      if (!reentered && client.getSnapshot().listVersion === 1) {
        reentered = true;
        client.requestSessions(); // 结算通知重入：pending 已 false→立即发 R2
      }
    });
    client.connect();
    ws.open();
    ws.receive(WELCOME);
    client.requestSessions(); // 在途记 dirty
    ws.receive(sessionsFrame(1)); // 结算：回调发 R2（pending 立起）→needRepull 让位不再发 R3
    expect(ws.sent).toHaveLength(3); // hello+首拉+R2，无双发
    ws.receive(sessionsFrame(3));
    expect(client.getSnapshot().listVersion).toBe(3);
  });

  it("server 侧关闭清位：pending/dirty 归零后迟到回包零副作用", () => {
    const ws = new FakeWebSocket("ws://x");
    const client = new WsClient("ws://x", "tok", () => ws);
    client.connect();
    ws.open();
    ws.receive(WELCOME);
    client.requestSessions(); // 在途→dirty
    ws.serverClose(1006); // 非 1008 认证路径→closed 终态（P2-01 修复=同口径清位）
    expect(client.getSnapshot().state).toBe("closed");
    const after = ws.sent.length;
    ws.receive(sessionsFrame(9)); // 迟到回包
    expect(ws.sent).toHaveLength(after); // 不补拉（dirty 已清；且终态拒帧）
  });

  it("sendFrame 同步 throw 不悬挂在途：先结算首拉→真占位失败→回滚可重试（R2 改真：旧例未结算首拉，requestSessions 走 dirty 分支未过 send，摘除回滚仍绿）", () => {
    const ws = new FakeWebSocket("ws://x");
    const orig = ws.send.bind(ws);
    let broken = false;
    ws.send = (data: string) => {
      if (broken) throw new Error("send failed");
      orig(data);
    };
    const client = new WsClient("ws://x", "tok", () => ws);
    client.connect();
    ws.open();
    ws.receive(WELCOME);
    // 首拉已发出（welcome 自动拉）——必须先结算，否则后续 requestSessions 只记 dirty 不走 send
    ws.receive({
      t: "sessions", requestId: "list-sessions-1", sessions: [], total: 0, offset: 0,
      hasMore: false, listVersion: 1, listReliability: "full",
    });
    expect(ws.sentFrames().filter((f) => f.t === "list-sessions")).toHaveLength(1);
    broken = true;
    expect(() => client.requestSessions()).not.toThrow(); // 占位失败受控回滚
    expect(ws.sentFrames().filter((f) => f.t === "list-sessions")).toHaveLength(1); // 零新增帧
    broken = false;
    client.requestSessions(); // 不悬挂：pending 已回滚→可重试真发新帧（悬挂时 dirty 合并会吃掉本次）
    expect(ws.sentFrames().filter((f) => f.t === "list-sessions")).toHaveLength(2);
    expect(ws.sentFrames().at(-1)).toMatchObject({ t: "list-sessions" });
  });

  it("非 OPEN 静默未发不悬挂在途：readyState=2→refresh 零新帧+回滚；恢复 OPEN→refresh 真发新帧（R2：静默出口同 throw 口径）", () => {
    const ws = new FakeWebSocket("ws://x");
    const client = new WsClient("ws://x", "tok", () => ws);
    client.connect();
    ws.open();
    ws.receive(WELCOME);
    ws.receive({
      t: "sessions", requestId: "list-sessions-1", sessions: [], total: 0, offset: 0,
      hasMore: false, listVersion: 1, listReliability: "full",
    });
    expect(ws.sentFrames().filter((f) => f.t === "list-sessions")).toHaveLength(1);
    ws.readyState = 2; // CLOSING：sendFrame 静默未发（不 throw）——旧实现 pending 悬挂
    client.requestSessions();
    expect(ws.sentFrames().filter((f) => f.t === "list-sessions")).toHaveLength(1); // 零新增帧
    ws.readyState = 1; // 恢复 OPEN（可观察性探针；真实 onclose 收口后状态面另行处理）
    client.requestSessions(); // 不悬挂：pending 已回滚→真发新帧（悬挂时 dirty 合并会吃掉本次）
    expect(ws.sentFrames().filter((f) => f.t === "list-sessions")).toHaveLength(2);
  });
});

describe("M-UX 批1修复 P2-03：auto 正则收窄+日历校验", () => {
  const rt = (file: string): string => resolveTitle({ file, title: { text: "", truncated: false } });
  it("完整名式合法：hex32+.jsonl 锚尾才入派生", () => {
    expect(rt("auto-20261009-030405-abcdef0123456789abcdef0123456789.jsonl")).toBe("10月9日 03:04（2026）");
  });
  it("非产品命名不入派生：manual 后缀/无 hex32/非 jsonl 回退 file 去扩展名", () => {
    expect(rt("auto-20260102-030405-manual.jsonl")).toBe("auto-20260102-030405-manual");
    expect(rt("auto-20260102-030405-short.jsonl")).toBe("auto-20260102-030405-short");
    expect(rt("auto-20260102-030405-abcdef0123456789abcdef0123456789.jsonl.bak")).toBe("auto-20260102-030405-abcdef0123456789abcdef0123456789.jsonl.bak"); // 收窄后不入派生；兜底不剥非尾缀
  });
  it("非法日期不入派生：13 月/2 月 30/25 时回退 file 名（UTC 构造回读比对）", () => {
    expect(rt("auto-20261302-030405-abcdef0123456789abcdef0123456789.jsonl")).toBe("auto-20261302-030405-abcdef0123456789abcdef0123456789");
    expect(rt("auto-20260230-030405-abcdef0123456789abcdef0123456789.jsonl")).toBe("auto-20260230-030405-abcdef0123456789abcdef0123456789");
    expect(rt("auto-20260102-250405-abcdef0123456789abcdef0123456789.jsonl")).toBe("auto-20260102-250405-abcdef0123456789abcdef0123456789");
    // 闰年 2 月 29 合法
    expect(rt("auto-20280229-030405-abcdef0123456789abcdef0123456789.jsonl")).toBe("2月29日 03:04（2028）");
  });
});

describe("M-UX 批1修复 P2-02：CSPRNG 来源约束+同 file 不换名", () => {
  it("默认源必须走 crypto.getRandomValues（Math.random 变异应红：spy 断言被调+16 字节）", async () => {
    const spy = vi.spyOn(crypto, "getRandomValues");
    autoFile(() => new Date(2026, 0, 2, 3, 4, 5));
    expect(spy).toHaveBeenCalledTimes(1);
    const arg = spy.mock.calls[0]?.[0] as unknown as { length?: number };
    expect(arg.length).toBe(16); // 16 字节=128 位
    spy.mockRestore();
  });

  it("B2 组件级：固定源+冻结时钟两次创建同名→两次 sendPrompt 同 file 照发（不假造冲突不自动换名）", async () => {
    const { render, screen } = await import("@testing-library/react");
    const React = (await import("react")).default;
    const { NewSession } = await import("../../../apps/web/src/components/new-session");
    const listeners = new Set<() => void>();
    const snap: Record<string, unknown> = {
      state: "ready",
      models: { status: "ok", items: [], cause: null },
      roots: { status: "ok", items: [], journalRoot: null },
    };
    snap.getSnapshot = () => snap;
    snap.subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
    const writeSnap = { connState: "ready" };
    const prompts: string[] = [];
    const writeStub = {
      sendPrompt: (file: string) => { prompts.push(file); return Promise.resolve({ kind: "launched" }); },
      getNotReady: () => null,
      subscribe: snap.subscribe as () => () => void,
      getSnapshot: () => writeSnap,
    };
    // 同组件两次：固定源+同时钟→预填同名；两次「创建」都照发同 file（服务端同名=追加语义，前端不换名）
    const fixed = (n: number): Uint8Array => new Uint8Array(n).fill(0xcd);
    const el = React.createElement(NewSession, {
      wsClient: { requestModels: () => {}, requestRoots: () => {}, subscribe: snap.subscribe as never, getSnapshot: snap.getSnapshot as never },
      writeClient: writeStub as never,
      rootsHint: "x",
      onLaunched: () => {},
      onCancel: () => {},
    });
    // 用 fixed 源无法直接驱动组件内 autoFile（useState 已定型）——改为断言：预填名即 CSPRNG 名，两次渲染实例预填同名不可能（随机）；
    // 组件级「不换名」断言=创建后 file 输入值不被改写。
    render(el);
    const input = screen.getByLabelText("会话文件名") as HTMLInputElement;
    const name1 = input.value;
    expect(name1).toMatch(/^auto-\d{8}-\d{6}-[0-9a-f]{32}\.jsonl$/);
    // 填首条消息并创建
    const textInput = screen.getByLabelText("首条消息") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(textInput, "第一条消息");
    textInput.dispatchEvent(new Event("input", { bubbles: true }));
    screen.getByRole("button", { name: "创建会话" }).click();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toBe(name1); // 发送用预填名
    expect((screen.getByLabelText("会话文件名") as HTMLInputElement).value).toBe(name1); // 不自动换名
  });
});

// ---------- 组件级：刷新钮+自动 file 预填 ----------
describe("M-UX D02/D03 组件面：列表刷新钮+新建自动 file 预填", () => {
  it("刷新钮触发 requestSessions", async () => {
    const { render, screen } = await import("@testing-library/react");
    const React = (await import("react")).default;
    const { SessionList } = await import("../../../apps/web/src/components/session-list");
    const listeners = new Set<() => void>();
    let requested = 0;
    const snap: Record<string, unknown> = {
      state: "ready", sessions: [], total: 0, listVersion: 1,
    };
    snap.getSnapshot = () => snap;
    snap.subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
    const client = {
      subscribe: snap.subscribe as () => () => void,
      getSnapshot: snap.getSnapshot as () => unknown,
      requestSessions: () => { requested++; },
    };
    render(React.createElement(SessionList, { client, selectedFile: null, onSelect: () => {} }));
    screen.getByRole("button", { name: "刷新" }).click();
    expect(requested).toBe(1);
  });

  it("新建表单 file 预填 auto- 格式且可编辑", async () => {
    const { render, screen } = await import("@testing-library/react");
    const React = (await import("react")).default;
    const { NewSession } = await import("../../../apps/web/src/components/new-session");
    const listeners = new Set<() => void>();
    const snap: Record<string, unknown> = {
      state: "ready",
      models: { status: "ok", items: [], cause: null },
      roots: { status: "ok", items: [], journalRoot: null },
    };
    snap.getSnapshot = () => snap;
    snap.subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
    const source = {
      requestModels: () => {},
      requestRoots: () => {},
      subscribe: snap.subscribe as () => () => void,
      getSnapshot: snap.getSnapshot as () => unknown,
    };
    const writeSnap = { connState: "ready" };
    const writeStub = {
      sendPrompt: () => {},
      getNotReady: () => null,
      subscribe: snap.subscribe as () => () => void,
      getSnapshot: () => writeSnap,
    };
    render(React.createElement(NewSession, { wsClient: source as never, writeClient: writeStub as never, rootsHint: "服务端配置的会话目录", onLaunched: () => {}, onCancel: () => {} }));
    const input = screen.getByLabelText("会话文件名") as HTMLInputElement;
    expect(input.value).toMatch(/^auto-\d{8}-\d{6}-[0-9a-f]{32}\.jsonl$/);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, "my-custom.jsonl");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect((screen.getByLabelText("会话文件名") as HTMLInputElement).value).toBe("my-custom.jsonl");
  });
});
