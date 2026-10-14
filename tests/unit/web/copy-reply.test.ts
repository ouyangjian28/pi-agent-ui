// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { LiveStreamView } from "../../../apps/web/src/components/live-stream";
import { SessionDetail } from "../../../apps/web/src/components/session-detail";
import type { EntryFrame, HistoryEvent, LiveEvent } from "@pi-agent-ui/protocol/src/contracts";
import type { EntryFetchResult, SessionDetailSnapshot } from "../../../apps/web/src/ws/subscribe-client";

// CRLF, whitespace, Markdown syntax, dangerous inert payload and beyond display limits.
const text = '# 原文😀\r\n\r\n| A | B |\r\n| --- | --- |\r\n| **x** | `y` |\r\n```mermaid\r\nflowchart TD\r\nA[开始] --> B{结束?}\r\n```\r\n<script>alert(1)</script> [x](javascript:alert(2))\r\n' + "z".repeat(103_000) + "\r\n尾字  \r\n";
const final = (body = text): LiveEvent => ({ kind: "message-final", role: "assistant", text: body });
const delta: LiveEvent = { kind: "message-delta", part: "text", contentIndex: 0, delta: "生成中，不完整" };
const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); }); };
function clipboard(writeText = vi.fn().mockResolvedValue(undefined)) {
  const readText = vi.fn();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText, readText } });
  return { writeText, readText };
}
function snap(events: readonly HistoryEvent[]): SessionDetailSnapshot {
  return { connState: "ready", errorKind: null, errorMessage: null, streamNote: null, file: "a.jsonl", phase: "live", subscriptionId: "s1", events, liveEvents: [], status: null, cursor: null, uiRequests: [] };
}
const message = (patch = {}): HistoryEvent => ({ kind: "message", seq: 1, ts: null, generation: null, intentId: null, entryId: "e-1", role: "assistant", final: true, blockCount: 1, textPreview: { text: "不完整预览", truncated: true }, ...patch });
const frame = (patch: Partial<EntryFrame> = {}): EntryFrame => ({ t: "entry", requestId: "r1", entryId: "e-1", source: "session", digest: "fnv1a64:a", state: "ok", blocks: [{ kind: "thinking", text: "PRIVATE THOUGHT" }, { kind: "text", text }, { kind: "toolCall", toolCallId: "t1", toolName: "bash", argsPreview: "PRIVATE TOOL" }, { kind: "attachment", attachmentId: "image" }], ...patch });
function history(patch = {}) {
  let settle!: (value: EntryFetchResult) => void;
  const snapshot = snap([message(patch)]);
  const client = { subscribe: () => () => {}, getSnapshot: () => snapshot, subscribeSession: vi.fn(), unsubscribeSession: vi.fn(), resyncFromCursor: vi.fn(), answerUi: vi.fn(), expandEntry: vi.fn(() => new Promise<EntryFetchResult>((resolve) => { settle = resolve; })) };
  const view = render(React.createElement(SessionDetail, { client, file: "a.jsonl" }));
  return { client, view, settle: async (value: EntryFetchResult) => { await act(async () => settle(value)); } };
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined }); });

describe("CP frozen public source copying (not DOM rendering)", () => {
  it("final copies every source byte beyond rendering limits; only acknowledges resolved writeText; never reads", async () => {
    let resolve!: () => void;
    const api = clipboard(vi.fn(() => new Promise<void>((done) => { resolve = done; })));
    render(React.createElement(LiveStreamView, { liveEvents: [final()], historyEvents: [] }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "复制完整回复原文" }));
    expect(api.writeText).toHaveBeenCalledExactlyOnceWith(text);
    expect(screen.queryByText("已复制")).toBeNull();
    expect((screen.getByRole("button", { name: "复制完整回复原文" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => resolve());
    expect(screen.getByText("已复制")).toBeTruthy();
    expect(api.readText).not.toHaveBeenCalled();
  });

  it("delta has no copy action; final → next delta collapse → real reopen copies final, not summary/thinking", async () => {
    const api = clipboard();
    const events: LiveEvent[] = [delta];
    const view = render(React.createElement(LiveStreamView, { liveEvents: events, historyEvents: [] }));
    await flush();
    expect(screen.queryByRole("button", { name: "复制完整回复原文" })).toBeNull();
    events.push({ ...delta, part: "thinking", delta: "PRIVATE" }, final());
    view.rerender(React.createElement(LiveStreamView, { liveEvents: [...events], historyEvents: [] }));
    await flush();
    events.push(delta);
    view.rerender(React.createElement(LiveStreamView, { liveEvents: [...events], historyEvents: [] }));
    await flush();
    expect(view.container.querySelector(".frozen-content")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /已生成 ·/ }));
    expect(view.container.querySelector(".frozen-content")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "复制完整回复原文" })));
    expect(api.writeText).toHaveBeenCalledExactlyOnceWith(text);
  });

  it.each(["missing", "denied", "throw"])("%s clipboard gives honest failure + manual source, never fake success", async (kind) => {
    const api = clipboard(kind === "throw" ? vi.fn(() => { throw new Error("sync failure"); }) : vi.fn().mockRejectedValue(new Error("denied")));
    if (kind === "missing") Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    render(React.createElement(LiveStreamView, { liveEvents: [final()], historyEvents: [] }));
    await flush();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "复制完整回复原文" })));
    expect(screen.queryByText("已复制")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("复制失败");
    const source = screen.getByRole("textbox", { name: "回复原文（手工复制）" }) as HTMLTextAreaElement;
    expect(source.readOnly).toBe(true);
    // HTML textarea normalizes CRLF for manual selection; writeText above must not.
    expect(source.value).toBe(text.replace(/\r\n/g, "\n"));
    expect(api.readText).not.toHaveBeenCalled();
  });

  it("unloaded history fetches existing read-only entry-get before writing; never copies preview/private blocks", async () => {
    const api = clipboard(); const h = history();
    fireEvent.click(screen.getByRole("button", { name: "复制完整回复原文" }));
    expect(h.client.expandEntry).toHaveBeenCalledExactlyOnceWith("a.jsonl", "e-1");
    expect(api.writeText).not.toHaveBeenCalled();
    await h.settle({ ok: true, frame: frame() });
    expect(api.writeText).toHaveBeenCalledExactlyOnceWith(text);
    expect(screen.getByText("已复制")).toBeTruthy();
    expect(h.client.resyncFromCursor).not.toHaveBeenCalled();
    expect(h.client.answerUi).not.toHaveBeenCalled();
  });

  it("already expanded history reuses exact text blocks without another fetch (no inserted delimiters)", async () => {
    const api = clipboard(); const h = history();
    fireEvent.click(screen.getByRole("button", { name: "展开" }));
    await h.settle({ ok: true, frame: frame({ blocks: [{ kind: "text", text: "**first**\r\n" }, { kind: "thinking", text: "PRIVATE" }, { kind: "text", text: "\r\nlast  " }] }) });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "复制完整回复原文" })));
    expect(h.client.expandEntry).toHaveBeenCalledTimes(1);
    expect(api.writeText).toHaveBeenCalledExactlyOnceWith("**first**\r\n\r\nlast  ");
  });

  it.each(["timeout", "truncated", "block-truncated", "no-text"])("history %s never writes partial data or reports success", async (kind) => {
    const api = clipboard(); const h = history();
    fireEvent.click(screen.getByRole("button", { name: "复制完整回复原文" }));
    await h.settle(kind === "timeout" ? { ok: false, reason: "timeout", message: "获取超时" } : { ok: true, frame: frame(kind === "truncated" ? { state: "truncated" } : kind === "block-truncated" ? { blocks: [{ kind: "text", text: "半截", truncatedAt: 2 }] } : { blocks: [{ kind: "thinking", text: "PRIVATE" }] }) });
    expect(api.writeText).not.toHaveBeenCalled();
    expect(screen.queryByText("已复制")).toBeNull();
    expect(screen.getAllByRole("alert").some((node) => node.textContent?.includes("复制失败"))).toBe(true);
    expect(screen.queryByRole("textbox", { name: "回复原文（手工复制）" })).toBeNull();
  });

  it.each([{ role: "user" }, { final: false }])("non-final or non-assistant history has no copy action: %j", (patch) => {
    history(patch);
    expect(screen.queryByRole("button", { name: "复制完整回复原文" })).toBeNull();
  });

  it("switching file with pending entry-get never copies late old content", async () => {
    const api = clipboard(); const h = history();
    fireEvent.click(screen.getByRole("button", { name: "复制完整回复原文" }));
    h.view.rerender(React.createElement(SessionDetail, { client: h.client, file: "b.jsonl" }));
    await h.settle({ ok: true, frame: frame() });
    expect(api.writeText).not.toHaveBeenCalled();
    expect(within(h.view.container).queryByText("已复制")).toBeNull();
  });
});
