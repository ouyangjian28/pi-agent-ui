// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { AppRoot } from "../../../apps/web/src/app-root";
import { TOKEN_STORAGE_KEY } from "../../../apps/web/src/components/token-gate";
import type { WebSocketLike } from "../../../apps/web/src/ws/ws-client";
class Socket implements WebSocketLike {
  static all: Socket[] = [];
  readyState = 0; sent: Record<string, unknown>[] = []; modelsAtPrompt: (string | null)[] = []; onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null; onmessage: ((event: { data: unknown }) => void) | null = null; onerror: (() => void) | null = null;
  constructor() { Socket.all.push(this); }
  send(bytes: string) { const frame = JSON.parse(bytes); if (frame.t === "prompt") this.modelsAtPrompt.push(window.localStorage.getItem("piagent-last-model")); this.sent.push(frame); }
  receive(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
  open() { this.readyState = 1; this.onopen?.(); this.receive({ t: "welcome", serverBootId: "fixture", serverBuildId: "fixture", protocolVersion: 1 }); }
}
const factory = () => new Socket();
const dto = (file: string, text: string) => ({ sessionId: file, file, title: { text, truncated: false }, lastActiveMs: Date.now(), entryCount: 2, sizeBytes: 50, hasRecoveryNotice: false, listReliability: "full" });
const status = (file: string) => ({ session: { sessionId: file, file, adapterSessionId: null }, process: { phase: "running", generation: 1, ready: true, lastStartResult: null, lastStopResult: null }, turn: { state: "idle" }, backgroundTasks: { availability: "known", activeCount: 0 }, reap: { eligible: false, idleElapsedMs: null, idleRemainingMs: null, idleMs: 0 }, recovery: { availability: "unavailable", resumeBlocked: null, diskBlocked: null, unknownEffectCount: null, unattributableFragments: null, intentsCount: null, settledCount: null, evidenceHash: null }, statusVersion: 1, serverTimeMs: Date.now() });
function list(rows: ReturnType<typeof dto>[], total = rows.length, offset = 0, hasMore = false) {
  const socket = Socket.all[0]!; const request = socket.sent.filter((frame) => frame.t === "list-sessions").at(-1)!;
  act(() => socket.receive({ t: "sessions", requestId: request.requestId, sessions: rows, offset, total, hasMore, listVersion: 1, listReliability: "full" }));
}
function start() {
  render(React.createElement(AppRoot, { createSocket: factory }));
  act(() => Socket.all.forEach((socket) => socket.open()));
  list([dto("b.jsonl", "已有对话 B")]);
}
function snapshot(file: string, text = "真实历史正文") {
  const socket = Socket.all[1]!; const request = socket.sent.filter((frame) => frame.t === "subscribe").at(-1)!;
  act(() => socket.receive({ t: "snapshot", requestId: request.requestId, subscriptionId: "sub-1", streamId: "stream-1", snapshotId: "snap-1", barrier: 1, status: status(file), page: [{ seq: 1, ts: Date.now(), generation: 1, intentId: null, kind: "message", role: "assistant", entryId: "e-1", final: true, textPreview: { text, truncated: false } }], historyNext: null, liveFrom: { streamId: "stream-1", seq: 2 }, hasMore: false }));
}
function draft() { fireEvent.click(screen.getByRole("button", { name: "＋新对话" })); return screen.getByLabelText("首条消息") as HTMLTextAreaElement; }
function firstSend(text = "v1") {
  const textarea = draft(); fireEvent.change(textarea, { target: { value: text } }); fireEvent.click(screen.getByRole("button", { name: "发送并开始对话" }));
  return { textarea, frame: Socket.all[2]!.sent.filter((frame) => frame.t === "prompt").at(-1)! };
}
async function ack(frame: Record<string, unknown>, outcome: unknown) {
  await act(async () => { Socket.all[2]!.receive({ t: "write-ack", requestId: frame.requestId, file: frame.file, outcome }); await Promise.resolve(); });
}
beforeEach(() => {
  Socket.all = []; window.localStorage.clear(); window.localStorage.setItem(TOKEN_STORAGE_KEY, "local-fixture"); window.history.replaceState(null, "", "/");
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("R1 真 AppRoot+三客户端首链", () => {
  it("欢迎首字不重挂；默认在线帧缺 model/cwd；launched→真实列表新行/正文→第二条同 file", async () => {
    start(); const textarea = screen.getByLabelText("首条消息") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "第一句话" } }); expect(screen.getByLabelText("首条消息")).toBe(textarea);
    expect(Socket.all[1]!.sent.filter((frame) => frame.t === "subscribe")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "发送并开始对话" })); const frame = Socket.all[2]!.sent.at(-1)!;
    expect(frame).toMatchObject({ t: "prompt", text: "第一句话", file: expect.stringMatching(/^auto-/) });
    expect(frame).not.toHaveProperty("model"); expect(frame).not.toHaveProperty("cwd");
    expect(Socket.all[2]!.modelsAtPrompt).toEqual(["__default__"]); // 真出帧时已写偏好，非 ACK 后补写
    expect(Socket.all[1]!.sent.filter((f) => f.t === "subscribe")).toHaveLength(0);
    await ack(frame, { kind: "launched", intentId: "i-1", commandId: 1 });
    expect(screen.getByLabelText("写入消息内容")).toBe(textarea); expect(textarea.value).toBe("");
    list([dto(String(frame.file), "第一句话"), dto("b.jsonl", "已有对话 B")]); snapshot(String(frame.file));
    expect(within(document.querySelector(".session-list")!).getByRole("button", { name: /第一句话/ }).getAttribute("aria-current")).toBe("page"); expect(screen.getByText(/真实历史正文/)).toBeTruthy();
    fireEvent.change(textarea, { target: { value: "第二句话" } }); fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
    expect(Socket.all[2]!.sent.filter((f) => f.t === "prompt")).toHaveLength(2); expect(Socket.all[2]!.sent.at(-1)).toMatchObject({ file: frame.file, text: "第二句话" });
  });
  it("真实 main 的 StrictMode 重挂探测不销毁状态 owner，首字与首帧保持", () => {
    render(React.createElement(React.StrictMode, null, React.createElement(AppRoot, { createSocket: factory })));
    act(() => Socket.all.slice(-3).forEach((socket) => socket.open()));
    const textarea = screen.getByLabelText("首条消息") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Strict 首字" } });
    expect(textarea.value).toBe("Strict 首字"); expect(screen.getByLabelText("首条消息")).toBe(textarea);
    fireEvent.click(screen.getByRole("button", { name: "发送并开始对话" }));
    expect(Socket.all.flatMap((socket) => socket.sent).filter((frame) => frame.t === "prompt")).toEqual([expect.objectContaining({ text: "Strict 首字", file: expect.stringMatching(/^auto-/) })]);
  });
  it("列表第51条真实可见、点选正确 file；partial 与累计数量可发现", () => {
    start(); fireEvent.click(screen.getByRole("button", { name: "刷新" })); list(Array.from({ length: 50 }, (_, index) => dto(`p${index + 1}.jsonl`, `第${index + 1}条对话`)), 51, 0, true);
    expect(screen.getByText("已载 50 / 共 51")).toBeTruthy(); fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    expect(Socket.all[0]!.sent.filter((f) => f.t === "list-sessions").at(-1)).toMatchObject({ offset: 50 });
    list([dto("p51.jsonl", "第51条对话")], 51, 50, false);
    expect(screen.getByText("已载 51 / 共 51")).toBeTruthy(); fireEvent.click(screen.getByRole("button", { name: /第51条对话/ }));
    expect(Socket.all[1]!.sent.filter((f) => f.t === "subscribe").at(-1)).toMatchObject({ file: "p51.jsonl" });
  });
  it("Enter/Shift+Enter/IME：真 composer composing/229 零发送", () => {
    start(); const textarea = draft(); fireEvent.change(textarea, { target: { value: "中文输入" } });
    fireEvent.keyDown(textarea, { key: "Enter", isComposing: true }); fireEvent.keyDown(textarea, { key: "Enter", keyCode: 229 }); fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true }); fireEvent.keyDown(textarea, { key: "Enter", repeat: true });
    expect(Socket.all[2]!.sent.filter((frame) => frame.t === "prompt")).toHaveLength(0);
    fireEvent.keyDown(textarea, { key: "Enter" }); expect(Socket.all[2]!.sent.filter((frame) => frame.t === "prompt")).toHaveLength(1);
  });
  it.each([false, true])("VIS-01：已受理入列表后无空草稿区，残稿仍能从列表恢复（手机=%s）", async (narrow) => {
    vi.stubGlobal("matchMedia", () => ({ matches: narrow, addEventListener: () => {}, removeEventListener: () => {} }));
    start(); const { textarea, frame } = firstSend("已受理首发");
    fireEvent.change(textarea, { target: { value: "在途后续残稿" } });
    await ack(frame, { kind: "launched", intentId: "i-vis-1", commandId: 1 });
    list([dto(String(frame.file), "已受理首发"), dto("b.jsonl", "已有对话 B")]);
    snapshot(String(frame.file), "合成回复已显示");
    fireEvent.click(screen.getByRole("button", { name: "会话列表", exact: true }));
    expect(document.querySelector('.real-app')?.getAttribute("data-view")).toBe("list");
    expect(document.querySelector("section.unfinished-drafts")).toBeNull();
    expect(screen.queryByRole("region", { name: "未完成草稿" })).toBeNull();
    const before = Socket.all[1]!.sent.length;
    fireEvent.click(screen.getByRole("button", { name: /已受理首发/ }));
    expect(screen.getByLabelText("写入消息内容")).toBe(textarea);
    expect(textarea.value).toBe("在途后续残稿");
    expect(Socket.all[1]!.sent).toHaveLength(before); // 返回和重开不退订/重订
    // 后续列表暂时不含该 file 时，原恢复身份应重新可见，而不是已被删除。
    fireEvent.click(screen.getByRole("button", { name: "刷新", exact: true }));
    list([dto("b.jsonl", "已有对话 B")]);
    fireEvent.click(screen.getByRole("button", { name: "会话列表", exact: true }));
    expect(screen.getByRole("button", { name: /打开已受理对话/ })).toBeTruthy();
    expect(Socket.all[2]!.sent.filter((f) => f.t === "prompt")).toHaveLength(1);
  });
  it.each([false, true])("VIS-01：已受理未入列仍能打开同一 file（手机=%s）", async (narrow) => {
    vi.stubGlobal("matchMedia", () => ({ matches: narrow, addEventListener: () => {}, removeEventListener: () => {} }));
    start(); const { frame } = firstSend("尚未入列的首发");
    fireEvent.click(screen.getByRole("button", { name: "返回列表" }));
    await ack(frame, { kind: "launched", intentId: "i-vis-2", commandId: 1 });
    const section = screen.getByRole("region", { name: "未完成草稿" });
    const recover = within(section).getByRole("button", { name: /打开已受理对话/ });
    expect(recover.textContent).toContain("尚未入列的首发");
    fireEvent.click(recover);
    expect(Socket.all[1]!.sent.filter((f) => f.t === "subscribe").at(-1)).toMatchObject({ file: frame.file });
    expect(Socket.all[2]!.sent.filter((f) => f.t === "prompt")).toHaveLength(1);
  });
  it.each([false, true])("VIS-01：busy 拒收条目含原稿并可全文找回（手机=%s）", async (narrow) => {
    vi.stubGlobal("matchMedia", () => ({ matches: narrow, addEventListener: () => {}, removeEventListener: () => {} }));
    const text = "拒收草稿：不要吞掉任何输入";
    start(); const { textarea, frame } = firstSend(text);
    await ack(frame, { kind: "busy" });
    fireEvent.click(screen.getByRole("button", { name: "返回列表" }));
    const recover = within(screen.getByRole("region", { name: "未完成草稿" })).getByRole("button", { name: /找回未发送成功的草稿/ });
    expect(recover.textContent).toContain(text);
    fireEvent.click(recover);
    expect(screen.getByLabelText("首条消息")).toBe(textarea); expect(textarea.value).toBe(text);
    expect(Socket.all[1]!.sent.filter((f) => f.t === "subscribe")).toHaveLength(0);
    expect(Socket.all[2]!.sent.filter((f) => f.t === "prompt")).toHaveLength(1);
  });
  it("VIS-01：在途与未知恢复入口不因同 file 已入列而隐藏，未知二发仍须确认", async () => {
    start(); const { frame } = firstSend("保护在途与未知原稿");
    fireEvent.click(screen.getByRole("button", { name: "返回列表" }));
    list([dto(String(frame.file), "已发现目标 file"), dto("b.jsonl", "已有对话 B")]);
    expect(screen.getByRole("button", { name: /找回发送中的草稿/ }).textContent).toContain("保护在途与未知原稿");
    await act(async () => { Socket.all[2]!.receive({ t: "error", requestId: frame.requestId, code: 4402, retryable: true, message: "never display" }); await Promise.resolve(); });
    fireEvent.click(screen.getByRole("button", { name: /找回结果未知的草稿/ }));
    expect((screen.getByLabelText("首条消息") as HTMLTextAreaElement).value).toBe("保护在途与未知原稿");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "发送并开始对话" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("重复执行"));
    expect(Socket.all[2]!.sent.filter((f) => f.t === "prompt")).toHaveLength(1);
    expect(document.body.textContent).not.toContain("never display");
  });
  it("VIS-02：受理行只陈述写事实，message-final 不伪造整轮 idle 或归档", async () => {
    start(); const { frame } = firstSend("核验中性受理文案");
    await ack(frame, { kind: "launched", intentId: "i-vis-3", commandId: 1 });
    snapshot(String(frame.file));
    act(() => Socket.all[1]!.receive({ t: "status", subscriptionId: "sub-1", status: { ...status(String(frame.file)), turn: { state: "in-flight", intentId: "i-vis-3" }, statusVersion: 2 } }));
    const heading = document.querySelector(".conversation-heading small")!;
    const turnBeforeFinal = heading.textContent;
    expect(turnBeforeFinal).not.toContain("空闲");
    expect(screen.getByText("消息已受理。", { exact: true })).toBeTruthy();
    act(() => Socket.all[1]!.receive({ t: "events", subscriptionId: "sub-1", origin: "live", refSeq: null, liveSeq: 1, events: [{ kind: "message-final", role: "assistant", text: "合成 final 正文，不代表整轮结束" }] }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
    expect(screen.getByText("合成 final 正文，不代表整轮结束")).toBeTruthy();
    expect(screen.getByText("消息已受理。", { exact: true })).toBeTruthy();
    expect(document.body.textContent).not.toContain("等待回复");
    expect(heading.textContent).toBe(turnBeforeFinal);
    expect(screen.getByText(/未确认入档/)).toBeTruthy();
    expect(Socket.all[2]!.sent.filter((f) => f.t === "prompt")).toHaveLength(1);
  });
  it("在途编辑→返回→选 B→A launched，保 B 三域；恢复 A 残稿仅一次", async () => {
    start(); const { textarea, frame } = firstSend(); fireEvent.change(textarea, { target: { value: "v2" } });
    expect((screen.getByRole("button", { name: "＋新对话" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "返回列表" })); fireEvent.click(screen.getByRole("button", { name: /已有对话 B/ })); snapshot("b.jsonl");
    fireEvent.change(screen.getByLabelText("写入消息内容"), { target: { value: "B 稿" } });
    const before = Socket.all[1]!.sent.length; await ack(frame, { kind: "launched", intentId: "i-1", commandId: 1 });
    expect(Socket.all[1]!.sent).toHaveLength(before); expect((screen.getByLabelText("写入消息内容") as HTMLTextAreaElement).value).toBe("B 稿");
    fireEvent.click(screen.getByRole("button", { name: /打开已受理对话/ }));
    expect(Socket.all[1]!.sent.filter((f) => f.t === "subscribe").at(-1)?.file).toBe(frame.file);
    expect((screen.getByLabelText("写入消息内容") as HTMLTextAreaElement).value).toBe("v2");
    fireEvent.change(screen.getByLabelText("写入消息内容"), { target: { value: "A 后续稿" } }); fireEvent.click(screen.getByRole("button", { name: /已有对话 B/ }));
    fireEvent.click(screen.getByRole("button", { name: /打开已受理对话/ })); expect((screen.getByLabelText("写入消息内容") as HTMLTextAreaElement).value).toBe("A 后续稿");
  });
  it.each(["busy", "4402"])("B 下 %s：分类与全文恢复，4402 ready+人工二发先确认", async (kind) => {
    start(); const { frame } = firstSend(); fireEvent.click(screen.getByRole("button", { name: "返回列表" })); fireEvent.click(screen.getByRole("button", { name: /已有对话 B/ })); snapshot("b.jsonl");
    const before = Socket.all[1]!.sent.length;
    if (kind === "busy") await ack(frame, { kind: "busy" }); else await act(async () => { Socket.all[2]!.receive({ t: "error", requestId: frame.requestId, code: 4402, retryable: true, message: "never display" }); await Promise.resolve(); });
    expect(Socket.all[1]!.sent).toHaveLength(before); expect(screen.getByText(/真实历史正文/)).toBeTruthy();
    expect(Socket.all[2]!.readyState).toBe(1); expect(Socket.all[2]!.sent.filter((f) => f.t === "prompt")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: kind === "busy" ? /找回未发送成功/ : /找回结果未知/ }));
    expect((screen.getByLabelText("首条消息") as HTMLTextAreaElement).value).toBe("v1");
    if (kind === "4402") {
      expect(screen.getByRole("alert").textContent).toContain("可能已受理");
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false); fireEvent.click(screen.getByRole("button", { name: "发送并开始对话" }));
      expect(confirm).toHaveBeenCalledWith(expect.stringContaining("重复执行")); expect(Socket.all[2]!.sent.filter((f) => f.t === "prompt")).toHaveLength(1);
      confirm.mockReturnValue(true); fireEvent.click(screen.getByRole("button", { name: "发送并开始对话" })); expect(Socket.all[2]!.sent.filter((f) => f.t === "prompt")).toHaveLength(2);
    } else expect(screen.getByRole("alert").textContent).toContain("草稿已保留");
  });
  it("手机返回/767↔768 保订阅待答与同一个 composer；真换 file 必须提示", () => {
    const changes = new Set<() => void>();
    const media = { matches: true, addEventListener: (_: string, fn: () => void) => changes.add(fn), removeEventListener: (_: string, fn: () => void) => changes.delete(fn) };
    vi.stubGlobal("matchMedia", () => media);
    start(); fireEvent.click(screen.getByRole("button", { name: /已有对话 B/ })); snapshot("b.jsonl");
    const textarea = screen.getByLabelText("写入消息内容"); fireEvent.change(textarea, { target: { value: "保持 IME 草稿" } });
    act(() => Socket.all[1]!.receive({ t: "ui-request", requestId: "question-1", file: "b.jsonl", method: "confirm", title: "是否继续？" }));
    expect(screen.getByText("是否继续？")).toBeTruthy(); const before = Socket.all[1]!.sent.length;
    fireEvent.click(screen.getByRole("button", { name: "会话列表" }));
    expect(document.querySelector("main")?.hasAttribute("inert")).toBe(true); expect(Socket.all[1]!.sent).toHaveLength(before);
    act(() => { media.matches = false; changes.forEach((fn) => fn()); });
    expect(document.querySelector("main")?.hasAttribute("inert")).toBe(false); expect(screen.getByLabelText("写入消息内容")).toBe(textarea);
    act(() => { media.matches = true; changes.forEach((fn) => fn()); });
    fireEvent.click(screen.getByRole("button", { name: /已有对话 B/ }));
    expect(screen.getByLabelText("写入消息内容")).toBe(textarea); expect((textarea as HTMLTextAreaElement).value).toBe("保持 IME 草稿");
    expect(Socket.all[1]!.sent).toHaveLength(before);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "换模型开新对话" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("取消待答")); expect(Socket.all[1]!.sent).toHaveLength(before);
    expect(Socket.all[2]!.sent.some((f) => f.t === "stop" || f.t === "prompt")).toBe(false);
    expect(document.body.textContent).not.toContain("当前模型");
  });
  it("真 SubscribeClient 消费正文三形：坏形零消费，连续 final 真正文不被 history 增量删除", async () => {
    start(); fireEvent.click(screen.getByRole("button", { name: /已有对话 B/ })); snapshot("b.jsonl");
    const receive = (events: unknown[], liveSeq: number) => act(() => Socket.all[1]!.receive({ t: "events", subscriptionId: "sub-1", origin: "live", refSeq: null, liveSeq, events }));
    receive([{ kind: "message-delta", part: "text", contentIndex: -1, delta: "坏形正文" }], 1);
    await act(async () => { await new Promise((yes) => setTimeout(yes, 25)); }); expect(screen.queryByLabelText("直播正文")).toBeNull();
    receive([{ kind: "message-delta", part: "text", contentIndex: 0, delta: "增量" }, { kind: "message-part-end", part: "text", contentIndex: 0 }, { kind: "message-final", role: "assistant", text: "完整正文一" }, { kind: "message-final", role: "assistant", text: "完整正文二" }], 4);
    await act(async () => { await new Promise((yes) => setTimeout(yes, 25)); });
    expect(Array.from(document.querySelectorAll(".live-final .live-stream-text"), (node) => node.textContent)).toEqual(["完整正文一", "完整正文二"]);
    act(() => Socket.all[1]!.receive({ t: "events", subscriptionId: "sub-1", origin: "history", refSeq: 3, events: [{ seq: 2, ts: null, intentId: null, generation: null, kind: "message", role: "assistant", entryId: "e-2", final: true, textPreview: { text: "历史另一个助手", truncated: false } }, { seq: 3, ts: null, intentId: null, generation: null, kind: "journal-repair", repairReason: "torn-tail", repairByteStart: 10, repairByteEnd: 12 }] }));
    expect(screen.getByText("历史另一个助手")).toBeTruthy(); expect(screen.getByText(/日志修复/)).toBeTruthy();
    expect(screen.getByLabelText("历史事件").textContent).not.toContain("日志修复");
    expect(screen.getByLabelText("活动事件").textContent).toContain("日志修复");
    expect(Array.from(document.querySelectorAll(".live-final .live-stream-text"), (node) => node.textContent)).toEqual(["完整正文一", "完整正文二"]); expect(screen.getAllByText(/未确认入档/)).toHaveLength(2);
  });
  it("真实 managed composer 保留停止结算与失败：prompt/stop 并行，停止不清残稿，不隐藏失败", async () => {
    start(); fireEvent.click(screen.getByRole("button", { name: /已有对话 B/ })); snapshot("b.jsonl");
    const textarea = screen.getByLabelText("写入消息内容") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "v1" } }); fireEvent.click(screen.getByRole("button", { name: "发送", exact: true }));
    const prompt = Socket.all[2]!.sent.at(-1)!; fireEvent.change(textarea, { target: { value: "v2 残稿" } });
    fireEvent.click(screen.getByRole("button", { name: "停止", exact: true })); const stop = Socket.all[2]!.sent.at(-1)!;
    expect(stop).toMatchObject({ t: "stop", file: "b.jsonl" }); expect(stop.requestId).not.toBe(prompt.requestId);
    await act(async () => { Socket.all[2]!.receive({ t: "write-stop-ack", requestId: stop.requestId, file: "b.jsonl", outcome: { kind: "deadline-exceeded" } }); await Promise.resolve(); });
    expect(screen.getByText("停止超时：进程未在期限内退出")).toBeTruthy(); expect(textarea.value).toBe("v2 残稿");
    await ack(prompt, { kind: "busy" }); fireEvent.click(screen.getByRole("button", { name: "停止", exact: true })); const secondStop = Socket.all[2]!.sent.at(-1)!;
    await act(async () => { Socket.all[2]!.receive({ t: "error", requestId: secondStop.requestId, code: 4402, retryable: true, message: "never display stop error" }); await Promise.resolve(); });
    const alerts = screen.getAllByRole("alert").map((node) => node.textContent).join(" "); expect(alerts).toContain("4402"); expect(alerts).not.toContain("never display stop error"); expect(textarea.value).toBe("v2 残稿");
    expect(Socket.all[2]!.sent.filter((frame) => frame.t === "stop")).toHaveLength(2); expect(Socket.all[2]!.sent.filter((frame) => frame.t === "prompt")).toHaveLength(1);
  });
  it("重连跨 client：页面和输入节点保留；零自动补发，新握手前零业务帧", async () => {
    vi.useFakeTimers(); start(); const { textarea } = firstSend("原始输入");
    fireEvent.change(textarea, { target: { value: "新编辑稿" } });
    act(() => Socket.all[2]!.close(1006));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(Socket.all).toHaveLength(6); expect(screen.getByLabelText("首条消息")).toBe(textarea); expect(textarea.value).toBe("新编辑稿");
    expect(Socket.all.slice(3).every((s) => s.sent.length === 0)).toBe(true);
    act(() => Socket.all.slice(3).forEach((s) => s.open()));
    expect(Socket.all.flatMap((s) => s.sent).filter((f) => f.t === "prompt")).toHaveLength(1);
    expect(screen.getByRole("alert").textContent).toContain("可能已受理");
  });
  it("新建拒收六类均保全文（不订未创建 file）", async () => {
    start(); const { textarea, frame } = firstSend("不吞输入"); await ack(frame, { kind: "not-ready", cause: "spawn-exited", detail: "fixture" });
    expect(textarea.value).toBe("不吞输入"); expect(Socket.all[1]!.sent.filter((f) => f.t === "subscribe")).toHaveLength(0);
    expect(screen.getByRole("alert").textContent).toContain("fixture"); expect(screen.getByRole("note").textContent).toContain("不会被重置");
  });
});
