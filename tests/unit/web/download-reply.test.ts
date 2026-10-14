// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CopyReply } from "../../../apps/web/src/components/copy-reply";
import { LiveStreamView } from "../../../apps/web/src/components/live-stream";
import { SessionDetail } from "../../../apps/web/src/components/session-detail";
import type { EntryFrame, HistoryEvent, LiveEvent } from "@pi-agent-ui/protocol/src/contracts";
import type { EntryFetchResult, SessionDetailSnapshot } from "../../../apps/web/src/ws/subscribe-client";

const label = "下载完整回复原文为 Markdown";
const text = '# 原文😀\r\n\r\n| A | B |\r\n| --- | --- |\r\n| **x** | `y` |\r\n```mermaid\r\nflowchart TD\r\nA[开始] --> B{结束?}\r\n```\r\n<script>alert(1)</script> [x](javascript:alert(2))\r\n' + "z".repeat(103_000) + "\r\n尾字  \r\n";
const final = (body = text): LiveEvent => ({ kind: "message-final", role: "assistant", text: body });
const delta: LiveEvent = { kind: "message-delta", part: "text", contentIndex: 0, delta: "生成中，不完整" };
const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); }); };
let blobs: Blob[];
let anchors: { name: string; href: string }[];
const createURL = vi.fn(); const revokeURL = vi.fn();
const readBlob = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader(); reader.onload = () => resolve(reader.result as string); reader.onerror = reject; reader.readAsText(blob);
});
function snapshot(events: readonly HistoryEvent[]): SessionDetailSnapshot {
  return { connState: "ready", errorKind: null, errorMessage: null, streamNote: null, file: "a.jsonl", phase: "live", subscriptionId: "s1", events, liveEvents: [], status: null, cursor: null, uiRequests: [] };
}
const message = (patch = {}): HistoryEvent => ({ kind: "message", seq: 1, ts: null, generation: null, intentId: null, entryId: "../../evil.exe\u0000", role: "assistant", final: true, blockCount: 1, textPreview: { text: "不完整预览", truncated: true }, ...patch });
const frame = (patch: Partial<EntryFrame> = {}): EntryFrame => ({ t: "entry", requestId: "r1", entryId: "../../evil.exe\u0000", source: "session", digest: "fnv1a64:a", state: "ok", blocks: [{ kind: "thinking", text: "PRIVATE" }, { kind: "text", text }, { kind: "toolCall", toolCallId: "t1", toolName: "bash", argsPreview: "PRIVATE TOOL" }], ...patch });
function history(patch = {}) {
  let settle!: (value: EntryFetchResult) => void;
  const snap = { ...snapshot([message(patch)]) };
  const client = { subscribe: () => () => {}, getSnapshot: () => snap, subscribeSession: vi.fn(), unsubscribeSession: vi.fn(), resyncFromCursor: vi.fn(), answerUi: vi.fn(), expandEntry: vi.fn(() => new Promise<EntryFetchResult>((resolve) => { settle = resolve; })) };
  const view = render(React.createElement(SessionDetail, { client, file: "a.jsonl" }));
  return { client, view, snap, settle: async (value: EntryFetchResult) => { await act(async () => settle(value)); } };
}
async function download() { await act(async () => fireEvent.click(screen.getByRole("button", { name: label }))); }
beforeEach(() => {
  blobs = []; anchors = []; createURL.mockReset(); revokeURL.mockReset();
  createURL.mockImplementation((blob: Blob) => { blobs.push(blob); return `blob:test-${blobs.length}`; });
  vi.stubGlobal("URL", class extends URL { static createObjectURL = createURL; static revokeObjectURL = revokeURL; });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { anchors.push({ name: this.download, href: this.href }); });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: vi.fn(() => { throw new Error("No clipboard reads"); }), writeText: vi.fn() } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("DL-1~4 completed public source download preparation (native save tested separately)", () => {
  it("final uses exact full source, markdown Blob and safe filename; never claims saved", async () => {
    render(React.createElement(LiveStreamView, { liveEvents: [final()], historyEvents: [] })); await flush(); await download();
    expect(blobs).toHaveLength(1); expect(blobs[0]!.type).toBe("text/markdown");
    expect(await readBlob(blobs[0]!)).toBe(text);
    expect(anchors).toHaveLength(1); expect(anchors[0]!.name).toMatch(/^reply-[0-9]+\.md$/);
    expect(anchors[0]!.href).toBe("blob:test-1"); expect(screen.getByText("已发起下载")).toBeTruthy();
    expect(screen.queryByText(/已保存/)).toBeNull(); expect(document.querySelector("a[download]")).toBeNull();
    expect(navigator.clipboard.readText).not.toHaveBeenCalled(); expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });
  it("delta is unavailable; final → next delta → actual reopen downloads frozen source", async () => {
    const events = [delta]; const view = render(React.createElement(LiveStreamView, { liveEvents: events, historyEvents: [] })); await flush();
    expect(screen.queryByRole("button", { name: label })).toBeNull();
    events.push(final()); view.rerender(React.createElement(LiveStreamView, { liveEvents: [...events], historyEvents: [] })); await flush();
    events.push(delta); view.rerender(React.createElement(LiveStreamView, { liveEvents: [...events], historyEvents: [] })); await flush();
    expect(screen.queryByRole("button", { name: label })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /已生成 ·/ })); await download();
    expect(await readBlob(blobs[0]!)).toBe(text);
  });
  it("unloaded history awaits read-only entry-get and blocks reentry, never preview/private text", async () => {
    const h = history(); fireEvent.click(screen.getByRole("button", { name: label })); fireEvent.click(screen.getByRole("button", { name: label }));
    expect(h.client.expandEntry).toHaveBeenCalledExactlyOnceWith("a.jsonl", "../../evil.exe\u0000"); expect(createURL).not.toHaveBeenCalled();
    expect(screen.getByText("正在准备下载…")).toBeTruthy(); expect((screen.getByRole("button", { name: label }) as HTMLButtonElement).disabled).toBe(true);
    await h.settle({ ok: true, frame: frame() }); expect(await readBlob(blobs[0]!)).toBe(text);
    expect(anchors[0]!.name).toMatch(/^reply-[0-9]+\.md$/); expect(h.client.answerUi).not.toHaveBeenCalled(); expect(h.client.resyncFromCursor).not.toHaveBeenCalled();
  });
  it("already loaded history concatenates public blocks without delimiters and without fetch", async () => {
    const h = history(); fireEvent.click(screen.getByRole("button", { name: "展开" }));
    await h.settle({ ok: true, frame: frame({ blocks: [{ kind: "text", text: "**first**\r\n" }, { kind: "thinking", text: "PRIVATE" }, { kind: "text", text: "\r\nlast  " }] }) });
    await download(); expect(h.client.expandEntry).toHaveBeenCalledTimes(1); expect(await readBlob(blobs[0]!)).toBe("**first**\r\n\r\nlast  ");
  });
  it.each(["timeout", "truncated", "block-truncated", "no-text"])("history %s never downloads partial data or reports success", async (kind) => {
    const h = history(); fireEvent.click(screen.getByRole("button", { name: label }));
    await h.settle(kind === "timeout" ? { ok: false, reason: "timeout", message: "获取超时" } : { ok: true, frame: frame(kind === "truncated" ? { state: "truncated" } : kind === "block-truncated" ? { blocks: [{ kind: "text", text: "半截", truncatedAt: 2 }] } : { blocks: [{ kind: "thinking", text: "PRIVATE" }] }) });
    expect(createURL).not.toHaveBeenCalled(); expect(anchors).toEqual([]); expect(screen.queryByText("已发起下载")).toBeNull();
    expect(screen.getAllByRole("alert").some((node) => node.textContent?.includes("下载失败"))).toBe(true);
  });
  it.each([{ role: "user" }, { final: false }])("non-assistant/non-final has no download: %j", (patch) => {
    history(patch); expect(screen.queryByRole("button", { name: label })).toBeNull();
  });
  it.each(["file", "client", "subscription"])("late entry-get after %s switch cannot download", async (kind) => {
    const h = history(); fireEvent.click(screen.getByRole("button", { name: label }));
    if (kind === "subscription") h.snap.subscriptionId = "s2";
    h.view.rerender(React.createElement(SessionDetail, { client: kind === "client" ? { ...h.client } : h.client, file: kind === "file" ? "b.jsonl" : "a.jsonl" }));
    await h.settle({ ok: true, frame: frame() }); expect(createURL).not.toHaveBeenCalled(); expect(anchors).toEqual([]); expect(screen.queryByText("已发起下载")).toBeNull();
  });
  it.each(["blob", "url", "anchor", "click", "timer"])("%s preparation failure is honest, releases allocated resources, and permits retry", async (kind) => {
    render(React.createElement(CopyReply, { text }));
    if (kind === "blob") vi.stubGlobal("Blob", class { constructor() { throw new Error("Blob failed"); } });
    if (kind === "url") createURL.mockImplementationOnce(() => { throw new Error("URL failed"); });
    if (kind === "anchor") { const original = document.createElement.bind(document); vi.spyOn(document, "createElement").mockImplementationOnce(((...args: Parameters<typeof document.createElement>) => { if (args[0] === "a") throw new Error("anchor failed"); return original(...args); }) as typeof document.createElement); }
    if (kind === "click") vi.mocked(HTMLAnchorElement.prototype.click).mockImplementationOnce(() => { throw new Error("click failed"); });
    if (kind === "timer") vi.spyOn(globalThis, "setTimeout").mockImplementationOnce(() => { throw new Error("schedule failed"); });
    await download(); expect(screen.getByRole("alert").textContent).toContain("下载失败"); expect(screen.queryByText("已发起下载")).toBeNull();
    expect(document.querySelector("a[download]")).toBeNull();
    if (["anchor", "click", "timer"].includes(kind)) expect(revokeURL).toHaveBeenCalledWith("blob:test-1");
    vi.restoreAllMocks(); vi.unstubAllGlobals();
    vi.stubGlobal("URL", class extends URL { static createObjectURL = createURL; static revokeObjectURL = revokeURL; });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await download(); expect(screen.getByText("已发起下载")).toBeTruthy();
  });
  it("revokes after a deferred browser-consumption window, also on unmount, once per URL", async () => {
    vi.useFakeTimers(); const view = render(React.createElement(CopyReply, { text })); await download();
    expect(revokeURL).not.toHaveBeenCalled(); await act(async () => vi.advanceTimersByTime(1000)); expect(revokeURL).toHaveBeenCalledExactlyOnceWith("blob:test-1");
    await download(); view.unmount(); expect(revokeURL.mock.calls).toEqual([["blob:test-1"], ["blob:test-2"]]);
    await act(async () => vi.runAllTimers()); expect(revokeURL).toHaveBeenCalledTimes(2);
  });
  it("empty final downloads empty source, not the display placeholder", async () => {
    render(React.createElement(CopyReply, { text: "" })); await download(); expect(await readBlob(blobs[0]!)).toBe("");
  });
});
