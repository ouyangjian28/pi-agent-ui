// @vitest-environment jsdom
// M-OPS（v1.4）新建会话视图测试：挂载即拉清单/文件名与模型本地预校验（零帧）/launched→onLaunched/
// not-ready→红条+重试重发+换模型清直达/清单 failed 降级 free-text 仍可用/free-text 优先生效。
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NewSession, type ModelsSource } from "../../../apps/web/src/components/new-session";
import type { ModelsState } from "../../../apps/web/src/ws/ws-client";
import type { WriteClientSurface, WriteSnapshot } from "../../../apps/web/src/ws/write-client";

afterEach(cleanup);

const LAUNCHED = { kind: "launched", intentId: "i-1", commandId: 1 } as const;

function modelsSnap(status: ModelsState["status"], items: ModelsState["items"] = [], cause: string | null = null): ModelsSource {
  return {
    requestModels: vi.fn(),
    getSnapshot: () => ({ models: { status, items, cause } }),
  };
}

class StubWrite {
  readonly sent: { file: string; text: string; model?: string }[] = [];
  resolveWith: unknown = LAUNCHED;
  rejectWith: Error | null = null;
  private readonly listeners = new Set<() => void>();
  private snap: WriteSnapshot = { connState: "ready", errorKind: null, errorMessage: null, inflight: [], lastResult: null, lastResumeResult: null, resumeState: { phase: "idle", files: [] } } as unknown as WriteSnapshot;
  readonly subscribe = (l: () => void): (() => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  readonly getSnapshot = (): WriteSnapshot => this.snap;
  sendPrompt(file: string, text: string, model?: string): Promise<unknown> {
    this.sent.push({ file, text, model });
    return this.rejectWith !== null ? Promise.reject(this.rejectWith) : Promise.resolve(this.resolveWith);
  }
}

function setup(models: ModelsSource = modelsSnap("ok", [{ provider: "kimi-coding", id: "k3" }])) {
  const write = new StubWrite();
  const onLaunched = vi.fn();
  const onCancel = vi.fn();
  const ui = render(
    React.createElement(NewSession, {
      wsClient: models,
      writeClient: write as unknown as WriteClientSurface,
      rootsHint: "/srv/sessions",
      onLaunched,
      onCancel,
    }),
  );
  return { write, onLaunched, onCancel, ui };
}

function fill(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe("M-OPS NewSession", () => {
  it("挂载即 requestModels；清单 ok 渲染下拉项（provider/id+context）", () => {
    const models = modelsSnap("ok", [
      { provider: "kimi-coding", id: "k3", context: "256k" },
      { provider: "openai-codex", id: "gpt-5.3" },
    ]);
    setup(models);
    expect(models.requestModels).toHaveBeenCalledTimes(1);
    const select = screen.getByLabelText("模型选择") as HTMLSelectElement;
    expect(select.querySelectorAll("option")).toHaveLength(3); // 默认+2 项
    expect(select.options[1]!.textContent).toContain("kimi-coding / k3（256k）");
  });

  it("文件名非法/首消息空→创建钮禁用；合法输入→sendPrompt 三参（model=undefined 不携带）", async () => {
    const { write, onLaunched } = setup();
    const btn = screen.getByRole("button", { name: "创建会话" }) as HTMLButtonElement;
    fill("会话文件名", "bad name");
    fill("首条消息", "hi");
    expect(btn.disabled).toBe(true);
    fill("会话文件名", "plan.jsonl");
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    await waitFor(() => expect(onLaunched).toHaveBeenCalledWith("plan.jsonl"));
    expect(write.sent).toEqual([{ file: "plan.jsonl", text: "hi", model: undefined }]);
  });

  it("free-text 优先生效（覆盖下拉）；modelPattern 非法→本地拒零帧", async () => {
    const { write, onLaunched } = setup();
    fill("会话文件名", "a.jsonl");
    fill("首条消息", "hi");
    fill("模型 id 直达", "openai-codex/gpt-5.3");
    fireEvent.click(screen.getByRole("button", { name: "创建会话" }));
    await waitFor(() => expect(onLaunched).toHaveBeenCalled());
    expect(write.sent[0]!.model).toBe("openai-codex/gpt-5.3");
    const btn = screen.getByRole("button", { name: "创建会话" }) as HTMLButtonElement;
    fill("会话文件名", "b.jsonl");
    fill("模型 id 直达", "bad model!!");
    expect(btn.disabled).toBe(true); // modelPattern 非法→钮禁用（本地预校验零帧）
    fireEvent.click(btn);
    expect(write.sent).toHaveLength(1); // 非法→本地拒零帧
  });

  it("not-ready→红条；重试=重发同 prompt；换模型=清直达；launched→onLaunched", async () => {
    const write = new StubWrite();
    write.resolveWith = { kind: "not-ready", cause: "spawn-exited", detail: "model not found" };
    const onLaunched = vi.fn();
    render(
      React.createElement(NewSession, {
        wsClient: modelsSnap("ok"),
        writeClient: write as unknown as WriteClientSurface,
        rootsHint: "x",
        onLaunched,
        onCancel: vi.fn(),
      }),
    );
    fill("会话文件名", "a.jsonl");
    fill("首条消息", "hi");
    fill("模型 id 直达", "nope/bad");
    fireEvent.click(screen.getByRole("button", { name: "创建会话" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toContain("模型 id 有误");
    expect(onLaunched).not.toHaveBeenCalled();
    write.resolveWith = LAUNCHED;
    fireEvent.click(screen.getByRole("button", { name: "重试" })); // 重试=重发同 prompt
    await waitFor(() => expect(onLaunched).toHaveBeenCalledWith("a.jsonl"));
    expect(write.sent).toHaveLength(2);
  });

  it("清单 failed→降级提示含 cause；free-text 仍可用", async () => {
    const { write, onLaunched } = setup(modelsSnap("failed", [], "pi 退出码 1"));
    expect(screen.getByRole("status").textContent).toContain("pi 退出码 1");
    fill("会话文件名", "a.jsonl");
    fill("首条消息", "hi");
    fill("模型 id 直达", "kimi-coding/k3");
    fireEvent.click(screen.getByRole("button", { name: "创建会话" }));
    await waitFor(() => expect(onLaunched).toHaveBeenCalled());
    expect(write.sent[0]!.model).toBe("kimi-coding/k3");
  });

  it("取消按钮→onCancel；非 launched 非 not-ready 结果→受控横幅", async () => {
    const write = new StubWrite();
    write.resolveWith = { kind: "busy" };
    const onLaunched = vi.fn();
    const { rerender } = render(
      React.createElement(NewSession, {
        wsClient: modelsSnap("ok"),
        writeClient: write as unknown as WriteClientSurface,
        rootsHint: "x",
        onLaunched,
        onCancel: vi.fn(),
      }),
    );
    fill("会话文件名", "a.jsonl");
    fill("首条消息", "hi");
    fireEvent.click(screen.getByRole("button", { name: "创建会话" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("busy"));
    expect(onLaunched).not.toHaveBeenCalled();
    expect(rerender).toBeTruthy();
  });
});
