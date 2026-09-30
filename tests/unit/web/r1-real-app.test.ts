// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { AppRoot } from "../../../apps/web/src/app-root";
import { TOKEN_STORAGE_KEY } from "../../../apps/web/src/components/token-gate";
import type { WebSocketLike } from "../../../apps/web/src/ws/ws-client";
class Socket implements WebSocketLike {
  static all: Socket[] = [];
  readyState = 0; sent: Record<string, unknown>[] = []; onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null; onmessage: ((event: { data: unknown }) => void) | null = null; onerror: (() => void) | null = null;
  constructor() { Socket.all.push(this); }
  send(bytes: string) { this.sent.push(JSON.parse(bytes)); }
  receive(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
  open() { this.readyState = 1; this.onopen?.(); this.receive({ t: "welcome", serverBootId: "fixture", serverBuildId: "fixture", protocolVersion: 1 }); }
}
const factory = () => new Socket();
const dto = (file: string, text: string) => ({ sessionId: file, file, title: { text, truncated: false }, lastActiveMs: Date.now(), entryCount: 2, sizeBytes: 50, hasRecoveryNotice: false, listReliability: "full" });
const status = (file: string) => ({ session: { sessionId: file, file, adapterSessionId: null }, process: { phase: "running", generation: 1, ready: true, lastStartResult: null, lastStopResult: null }, turn: { state: "idle" }, backgroundTasks: { availability: "known", activeCount: 0 }, reap: { eligible: false, idleElapsedMs: null, idleRemainingMs: null, idleMs: 0 }, recovery: { availability: "unavailable", resumeBlocked: null, diskBlocked: null, unknownEffectCount: null, unattributableFragments: null, intentsCount: null, settledCount: null, evidenceHash: null }, statusVersion: 1, serverTimeMs: Date.now() });
function list(rows: ReturnType<typeof dto>[]) {
  const socket = Socket.all[0]!; const request = socket.sent.filter((frame) => frame.t === "list-sessions").at(-1)!;
  act(() => socket.receive({ t: "sessions", requestId: request.requestId, sessions: rows, offset: 0, total: rows.length, hasMore: false, listVersion: 1, listReliability: "full" }));
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
    expect(Socket.all[1]!.sent.filter((f) => f.t === "subscribe")).toHaveLength(0);
    await ack(frame, { kind: "launched", intentId: "i-1", commandId: 1 });
    expect(screen.getByLabelText("写入消息内容")).toBe(textarea); expect(textarea.value).toBe("");
    list([dto(String(frame.file), "第一句话"), dto("b.jsonl", "已有对话 B")]); snapshot(String(frame.file));
    expect(within(document.querySelector(".session-list")!).getByRole("button", { name: /第一句话/ }).getAttribute("aria-current")).toBe("page"); expect(screen.getByText(/真实历史正文/)).toBeTruthy();
    fireEvent.change(textarea, { target: { value: "第二句话" } }); fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
    expect(Socket.all[2]!.sent.filter((f) => f.t === "prompt")).toHaveLength(2); expect(Socket.all[2]!.sent.at(-1)).toMatchObject({ file: frame.file, text: "第二句话" });
  });
  it("Enter/Shift+Enter/IME：真 composer composing/229 零发送", () => {
    start(); const textarea = draft(); fireEvent.change(textarea, { target: { value: "中文输入" } });
    fireEvent.keyDown(textarea, { key: "Enter", isComposing: true }); fireEvent.keyDown(textarea, { key: "Enter", keyCode: 229 }); fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(Socket.all[2]!.sent.filter((frame) => frame.t === "prompt")).toHaveLength(0);
    fireEvent.keyDown(textarea, { key: "Enter" }); expect(Socket.all[2]!.sent.filter((frame) => frame.t === "prompt")).toHaveLength(1);
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
  it("新建拒收六类均保全文（不订未创建 file）", async () => {
    start(); const { textarea, frame } = firstSend("不吞输入"); await ack(frame, { kind: "not-ready", cause: "spawn-exited", detail: "fixture" });
    expect(textarea.value).toBe("不吞输入"); expect(Socket.all[1]!.sent.filter((f) => f.t === "subscribe")).toHaveLength(0);
    expect(screen.getByRole("alert").textContent).toContain("fixture"); expect(screen.getByRole("note").textContent).toContain("不会被重置");
  });
});
