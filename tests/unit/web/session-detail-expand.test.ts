// @vitest-environment jsdom
// D4 批③ 全文展开组件测试（SessionDetail 展开链，按 ui-dialog.test.ts 先例风格：.test.ts 无 JSX，
// React.createElement + @testing-library）。覆盖：展开按钮三条件触发口径（§4.4 P3-N8）、展开中禁用/
// 失败复位重试、blocks 逐块渲染（thinking 折叠默认收起/toolCall 名称+argsPreview）、truncated 文案
// 「已截断·可见 X KB / Y 块」（不展示 rawBytes）、ok 态 rawBytes、展开缓存换 file 清（P3-N7）。
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SessionDetail } from "../../../apps/web/src/components/session-detail";
import type { EntryFetchResult, SessionDetailSnapshot } from "../../../apps/web/src/ws/subscribe-client";
import type { EntryFrame, HistoryEvent } from "@pi-agent-ui/protocol/src/contracts";

afterEach(cleanup);

/** 顶 SubscribeClientSurface 的展开存根：快照由测试推进；expandEntry 记录在案、结果由测试手动定局。 */
class ExpandStubClient {
  private readonly listeners = new Set<() => void>();
  constructor(private snap: SessionDetailSnapshot) {}
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly getSnapshot = (): SessionDetailSnapshot => this.snap;
  subscribeSession(): void {}
  unsubscribeSession(): void {}
  resyncFromCursor(): void {}
  answerUi(): void {}
  readonly expandCalls: Array<{ file: string; entryId: string }> = [];
  private readonly deferreds: Array<(result: EntryFetchResult) => void> = [];
  expandEntry(file: string, entryId: string): Promise<EntryFetchResult> {
    this.expandCalls.push({ file, entryId });
    return new Promise<EntryFetchResult>((resolve) => this.deferreds.push(resolve));
  }
  /** 定局最近一次展开请求（act 内 flush 微任务，setState 不越界）。 */
  async settleLast(result: EntryFetchResult): Promise<void> {
    const resolve = this.deferreds.shift();
    if (!resolve) throw new Error("无在途展开请求");
    await act(async () => resolve(result));
  }
  push(next: SessionDetailSnapshot): void {
    this.snap = next;
    act(() => {
      for (const listener of this.listeners) listener();
    });
  }
}

function detailSnap(patch: Partial<SessionDetailSnapshot>): SessionDetailSnapshot {
  return {
    connState: "ready",
    errorKind: null,
    errorMessage: null,
    streamNote: null,
    file: "a.jsonl",
    phase: "live",
    subscriptionId: "sub-1",
    events: [],
    liveEvents: [],
    status: null,
    cursor: null,
    uiRequests: [],
    ...patch,
  };
}

function msgEvent(seq: number, patch: Record<string, unknown> = {}): HistoryEvent {
  return {
    seq,
    ts: null,
    generation: null,
    intentId: null,
    kind: "message",
    entryId: `e-${seq}`,
    role: "assistant",
    final: true,
    ...patch,
  } as HistoryEvent;
}

function entryFrame(patch: Partial<EntryFrame> = {}): EntryFrame {
  return {
    t: "entry",
    requestId: "entry-1",
    entryId: "e-1",
    source: "session",
    digest: "fnv1a64:abc",
    state: "ok",
    blocks: [{ kind: "text", text: "正文全文内容" }],
    ...patch,
  };
}

const EXPANDABLE_EVENTS: HistoryEvent[] = [
  msgEvent(1, { textPreview: { text: "半截预览", truncated: true } }), // 条件③：预览截断
  msgEvent(2, { blockCount: 2, toolCallId: "tc-1" }), // 条件②：可见块数>0（toolCall-only 无 textPreview）
  msgEvent(3, { hasThinking: true, textPreview: { text: "完", truncated: false } }), // 条件①：门开含思考
];

describe("D4 批③ 展开按钮触发口径（三条件其一）", () => {
  it("hasThinking/blockCount>0/textPreview.truncated 各挂按钮；三条件皆无与非 message 事件不挂", () => {
    const events: HistoryEvent[] = [
      ...EXPANDABLE_EVENTS,
      msgEvent(4, { textPreview: { text: "完整短消息", truncated: false } }), // 三条件皆无
      { seq: 5, ts: null, generation: null, intentId: null, kind: "turn-engaged" } as HistoryEvent, // 非 message
    ];
    const client = new ExpandStubClient(detailSnap({ events }));
    render(React.createElement(SessionDetail, { client, file: "a.jsonl" }));
    const buttons = screen.getAllByRole("button", { name: "展开" });
    expect(buttons).toHaveLength(3); // 仅三条件命中的三行
  });
});

describe("D4 批③ 展开链（触发→加载→渲染）", () => {
  function mountOne(): { client: ExpandStubClient } {
    const client = new ExpandStubClient(
      detailSnap({ events: [msgEvent(1, { blockCount: 1, textPreview: { text: "预览", truncated: true } })] }),
    );
    render(React.createElement(SessionDetail, { client, file: "a.jsonl" }));
    return { client };
  }

  it("点击展开→expandEntry(file,entryId)；加载中按钮禁用；ok 后逐块渲染（thinking 折叠默认收起、toolCall 名称+argsPreview、rawBytes 展示）", async () => {
    const { client } = mountOne();
    fireEvent.click(screen.getByRole("button", { name: "展开" }));
    expect(client.expandCalls).toEqual([{ file: "a.jsonl", entryId: "e-1" }]);
    const loading = screen.getByRole("button", { name: "加载中…" }) as HTMLButtonElement;
    expect(loading.disabled).toBe(true);
    await client.settleLast({
      ok: true,
      frame: entryFrame({
        blocks: [
          { kind: "thinking", text: "隐藏的思考" },
          { kind: "text", text: "正文全文内容" },
          { kind: "toolCall", toolCallId: "tc-1", toolName: "bash", argsPreview: '{"cmd":"ls"}' },
          { kind: "attachment", attachmentId: "att-9" },
        ],
        rawBytes: 2048,
        totalBlockCount: 3,
      }),
    });
    expect(screen.getByText("正文全文内容")).toBeTruthy();
    // thinking 折叠区默认收起（无 open 属性），内容仍在 DOM（details 语义）
    const thinking = document.querySelector("details.entry-thinking") as HTMLDetailsElement;
    expect(thinking).toBeTruthy();
    expect(thinking.open).toBe(false);
    expect(screen.getByText("隐藏的思考")).toBeTruthy();
    expect(screen.getByText(/工具调用：bash：\{"cmd":"ls"\}/)).toBeTruthy(); // argsPreview 服务端已净化，直接展示
    expect(screen.getByText(/附件：att-9/)).toBeTruthy();
    expect(screen.getByText("全文 2.0 KB")).toBeTruthy(); // ok 态可显示 rawBytes
  });

  it("truncated 态文案「已截断·可见 X KB / Y 块」：不展示 rawBytes、不可再放大；块级 truncatedAt 带省略号", async () => {
    const { client } = mountOne();
    fireEvent.click(screen.getByRole("button", { name: "展开" }));
    await client.settleLast({
      ok: true,
      frame: entryFrame({
        state: "truncated",
        blocks: [
          { kind: "text", text: "a".repeat(2048), truncatedAt: 2048 },
          { kind: "toolCall", toolCallId: null, toolName: "read", argsPreview: "" },
        ],
        totalBlockCount: 7,
        // truncated 帧 wire 级不携 rawBytes
      }),
    });
    expect(screen.getByText("已截断·可见 2.0 KB / 2 块")).toBeTruthy();
    expect(screen.queryByText(/全文 .* KB/)).toBeNull(); // 原文规模不展示
    expect(screen.queryByRole("button", { name: "展开" })).toBeNull(); // 不可再放大
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
  });

  it("失败=受控错误文案+按钮复位可重试（重试再发 expandEntry）", async () => {
    const { client } = mountOne();
    fireEvent.click(screen.getByRole("button", { name: "展开" }));
    await client.settleLast({ ok: false, reason: "timeout", message: "内容获取超时，稍后重试" });
    expect(screen.getByText(/内容获取超时，稍后重试/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(client.expandCalls).toHaveLength(2); // 复位后可重试
    await client.settleLast({ ok: true, frame: entryFrame() });
    expect(screen.getByText("正文全文内容")).toBeTruthy();
  });

  it("展开缓存换 file 清（P3-N7）：旧 file 展开内容不泄入新 file（同 entryId 亦清）", async () => {
    const client = new ExpandStubClient(
      detailSnap({ events: [msgEvent(1, { blockCount: 1, textPreview: { text: "预览", truncated: true } })] }),
    );
    const view = render(React.createElement(SessionDetail, { client, file: "a.jsonl" }));
    fireEvent.click(screen.getByRole("button", { name: "展开" }));
    await client.settleLast({ ok: true, frame: entryFrame({ blocks: [{ kind: "text", text: "旧文件全文" }] }) });
    expect(screen.getByText("旧文件全文")).toBeTruthy();
    // 换 file：组件 prop 切换→缓存清空；新快照同 entryId 事件不得复用旧展开态
    act(() => {
      view.rerender(React.createElement(SessionDetail, { client, file: "b.jsonl" }));
    });
    client.push(
      detailSnap({ file: "b.jsonl", events: [msgEvent(1, { blockCount: 1, textPreview: { text: "新文件预览", truncated: true } })] }),
    );
    expect(screen.queryByText("旧文件全文")).toBeNull(); // 缓存已清，不残留旧全文
    expect(screen.getByRole("button", { name: "展开" })).toBeTruthy(); // 新 file 可重新展开
  });
});
