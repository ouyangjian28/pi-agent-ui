// @vitest-environment jsdom
// M-UX D02/D03 批1 web 面测试：resolveTitle 三级解析 / ws-client requestSessions+dirty 合并 /
// autoFile CSPRNG+filePattern / 刷新钮接线 / launched 后自动补拉（real-app 集成面由 real-app.test 覆盖壳层）。
import { describe, expect, it } from "vitest";
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
