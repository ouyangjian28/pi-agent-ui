// @vitest-environment jsdom
// M-OPS（v1.4）写面 composer 测试（P3-2 修复批补）：not-ready 落账后草稿恢复（冷启动失败不吞
// 用户输入）+banner 重试钮=重发恢复后的草稿。composer 主体渲染面在 real-app E2E 覆盖，此处只测
// not-ready 分支语义。
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WriteComposer } from "../../../apps/web/src/components/write-composer";
import type { WriteClientSurface, WriteSnapshot } from "../../../apps/web/src/ws/write-client";

afterEach(cleanup);

class StubWriteClient {
  private readonly listeners = new Set<() => void>();
  readonly promptCalls: { file: string; text: string }[] = [];
  private resolveWith: unknown = { kind: "launched", intentId: "i-1", commandId: 7 };
  private snap: WriteSnapshot = {
    connState: "ready",
    errorKind: null,
    errorMessage: null,
    inflight: [],
    lastResult: null,
    lastResumeResult: null,
    resumeState: { phase: "idle", files: [] },
  } as unknown as WriteSnapshot;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly getSnapshot = (): WriteSnapshot => this.snap;
  sendPrompt(file: string, text: string): Promise<unknown> {
    this.promptCalls.push({ file, text });
    return Promise.resolve(this.resolveWith);
  }
  sendStop(): Promise<unknown> {
    return Promise.resolve({ kind: "no-process" });
  }
  resume(): Promise<unknown> {
    return Promise.resolve(this.resolveWith);
  }
  /** 注入 resolve 值并广播（模拟 write-ack 回包落账）。 */
  resolveNext(value: unknown): void {
    this.resolveWith = value;
  }
}

function renderComposer(file: string | null = "a.jsonl"): StubWriteClient {
  const stub = new StubWriteClient();
  render(React.createElement(WriteComposer, { client: stub as unknown as WriteClientSurface, file }));
  return stub;
}

describe("M-OPS 写面 not-ready 草稿恢复（P3-2）", () => {
  it("not-ready 落账→草稿恢复（textarea 值回来）+banner 重试钮重发同文本", async () => {
    const stub = renderComposer();
    stub.resolveNext({ kind: "not-ready", cause: "spawn-exited", detail: "boom" });
    const textarea = screen.getByLabelText("写入消息内容") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "冷启动失败别吞我" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    // not-ready 落账：banner 出现+草稿被合法 ack 清空后由恢复效应找回
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("模型 id 有误"));
    await waitFor(() => expect((screen.getByLabelText("写入消息内容") as HTMLTextAreaElement).value).toBe("冷启动失败别吞我"));
    expect(stub.promptCalls).toHaveLength(1);
    // 重试钮（canSend=true 时挂出）→重发恢复后的草稿
    stub.resolveNext({ kind: "launched", intentId: "i-2", commandId: 8 });
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(stub.promptCalls).toHaveLength(2));
    expect(stub.promptCalls[1]!.text).toBe("冷启动失败别吞我");
  });

  it("launched 正常路径草稿照清（恢复效应不误伤）", async () => {
    const stub = renderComposer();
    const textarea = screen.getByLabelText("写入消息内容") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "正常消息" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect((screen.getByLabelText("写入消息内容") as HTMLTextAreaElement).value).toBe(""));
    expect(stub.promptCalls).toHaveLength(1);
  });
});
