// @vitest-environment jsdom
// Real WsClient → list projection. Filtering must not claim/search unloaded history.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SessionList } from "../../../apps/web/src/components/session-list";
import { WsClient, type WebSocketLike } from "../../../apps/web/src/ws/ws-client";

class Socket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: { readonly code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send(bytes: string) {
    this.sent.push(bytes);
  }
  close() {
    this.readyState = 3;
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}
const row = (file: string, text: string) => ({
  sessionId: file,
  file,
  title: { text, truncated: false },
  lastActiveMs: Date.now(),
  entryCount: 2,
  sizeBytes: 128,
  hasRecoveryNotice: false,
  listReliability: "full" as const,
});
function setup() {
  const socket = new Socket();
  const client = new WsClient("ws://127.0.0.1/fixture", "local-non-credential", () => socket);
  const select = vi.fn();
  client.connect();
  render(React.createElement(SessionList, { client, selectedFile: "a.jsonl", onSelect: select }));
  act(() => {
    socket.readyState = 1;
    socket.onopen?.();
    socket.receive({ t: "welcome", serverBootId: "fixture", serverBuildId: "fixture", protocolVersion: 1 });
    const request = JSON.parse(socket.sent.at(-1)!);
    socket.receive({
      t: "sessions",
      requestId: request.requestId,
      sessions: [row("a.jsonl", "聊天工作台设计"), row("b.jsonl", "本周工作计划")],
      offset: 0,
      total: 3,
      hasMore: true,
      listVersion: 1,
      listReliability: "full",
    });
  });
  return { socket, client, select };
}
afterEach(cleanup);
describe("hybrid loaded-list search", () => {
  it("filters loaded title/file locally without extra frames; clearing restores selection", () => {
    const { socket, select } = setup();
    const before = socket.sent.length;
    const search = screen.getByRole("searchbox", { name: "搜索已加载会话" });
    fireEvent.change(search, { target: { value: "计划" } });
    expect(screen.queryByRole("button", { name: /聊天工作台设计/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /本周工作计划/ }));
    expect(select).toHaveBeenCalledWith("b.jsonl");
    fireEvent.change(search, { target: { value: " A.JSONL " } });
    expect(screen.getByRole("button", { name: /聊天工作台设计/ }).getAttribute("aria-current")).toBe("page");
    expect(screen.queryByRole("button", { name: /本周工作计划/ })).toBeNull();
    fireEvent.change(search, { target: { value: "" } });
    expect(screen.getAllByRole("button", { name: /条消息/ })).toHaveLength(2);
    expect(socket.sent).toHaveLength(before);
  });
  it("no matches is not empty database; scope and pagination remain discoverable", () => {
    setup();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "不在已加载页" } });
    expect(screen.getByRole("status").textContent).toContain("已加载会话中没有匹配项");
    expect(screen.queryByRole("heading", { name: "还没有会话" })).toBeNull();
    expect(screen.getByText("仅搜索已加载的 2 条，不是全库搜索")).toBeTruthy();
    expect(screen.getByText("已载 2 / 共 3")).toBeTruthy();
    expect(screen.getByRole("button", { name: "加载更多" })).toBeTruthy();
  });
  it("loading another page updates current query, rather than inventing remote search", () => {
    const { socket } = setup();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "资料" } });
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    const request = JSON.parse(socket.sent.at(-1)!);
    expect(request.t).toBe("list-sessions");
    expect(request.offset).toBe(2);
    act(() =>
      socket.receive({
        t: "sessions",
        requestId: request.requestId,
        sessions: [row("c.jsonl", "整理资料")],
        offset: 2,
        total: 3,
        hasMore: false,
        listVersion: 1,
        listReliability: "full",
      }),
    );
    expect(screen.getByRole("button", { name: /整理资料/ })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("仅搜索已加载的 3 条，不是全库搜索")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "加载更多" })).toBeNull();
  });
});
