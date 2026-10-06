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
const status = (file: string) => ({ session: { sessionId: file, file, adapterSessionId: null }, process: { phase: "running", generation: 1, ready: true, lastStartResult: null, lastStopResult: null }, turn: { state: "in-flight", intentId: "i-1" }, backgroundTasks: { availability: "known", activeCount: 0 }, reap: { eligible: false, idleElapsedMs: null, idleRemainingMs: null, idleMs: 0 }, recovery: { availability: "unavailable", resumeBlocked: null, diskBlocked: null, unknownEffectCount: null, unattributableFragments: null, intentsCount: null, settledCount: null, evidenceHash: null }, statusVersion: 1, serverTimeMs: Date.now() });
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

describe("S1 独立缺口复现：真实探针收到的已有 response-timeout 契约", () => {
  it("受理后收到超时事件，主面须提示超时或结果未知，不能只收进折叠活动详情", async () => {
    start(); const {frame}=firstSend("S1 首条");
    await ack(frame,{kind:"launched",intentId:"i-1",commandId:1});snapshot(String(frame.file),"已存旧历史");
    const text=screen.getByLabelText("写入消息内容") as HTMLTextAreaElement;fireEvent.change(text,{target:{value:"尚未发送的残稿"}});
    act(()=>Socket.all[1]!.receive({t:"events",subscriptionId:"sub-1",origin:"history",refSeq:2,events:[{seq:2,ts:null,generation:1,intentId:"i-1",kind:"response-timeout",commandId:1}]}));
    expect(document.querySelector(".activity-list")?.textContent).toContain("响应超时");
    expect(document.querySelector(".activity-details")?.hasAttribute("open")).toBe(false);
    expect(text.value).toBe("尚未发送的残稿");
    expect(Socket.all[2]!.sent.filter(f=>f.t==="prompt")).toHaveLength(1);
    const primaryAlerts=[...document.querySelectorAll("section.session-detail > [role=alert]")].map(el=>el.textContent).join(" ");
    expect(primaryAlerts,"response-timeout 已消费，但主读面没有超时/未知横幅").toMatch(/超时|未知|尚未确认/);
  });
});
