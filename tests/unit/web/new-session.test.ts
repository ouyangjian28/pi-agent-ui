// @vitest-environment jsdom
// M-OPS（v1.4）新建会话视图测试：挂载即拉清单/文件名与模型本地预校验（零帧）/launched→onLaunched/
// not-ready→红条+重试重发+换模型清直达/清单 failed 降级 free-text 仍可用/free-text 优先生效。
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NewSession, type ModelsSource, type RootsSource } from "../../../apps/web/src/components/new-session";
import type { ModelsState, RootsState } from "../../../apps/web/src/ws/ws-client";
import type { WriteClientSurface, WriteSnapshot } from "../../../apps/web/src/ws/write-client";

afterEach(cleanup);

const LAUNCHED = { kind: "launched", intentId: "i-1", commandId: 1 } as const;

const ROOTS_IDLE: RootsState = { status: "idle", items: [], cause: null };

function modelsSnap(
  status: ModelsState["status"],
  items: ModelsState["items"] = [],
  cause: string | null = null,
  roots: RootsState = ROOTS_IDLE, // v1.5（批A）：默认 idle（禁载态），既有模型面测试不受目录选择器干扰
): ModelsSource & RootsSource {
  // P2-3/P3-1：stub 补齐响应式面（订阅不触发——静态注入面够用；getSnapshot 引用恒稳满足 useSyncExternalStore 缓存语义）
  const snap = { models: { status, items, cause }, roots, state: "ready" };
  return {
    requestModels: vi.fn(),
    requestRoots: vi.fn(),
    subscribe: () => () => {},
    getSnapshot: () => snap,
  };
}

class StubWrite {
  readonly sent: { file: string; text: string; model?: string; cwd?: string }[] = [];
  resolveWith: unknown = LAUNCHED;
  rejectWith: Error | null = null;
  private readonly listeners = new Set<() => void>();
  private snap: WriteSnapshot = { connState: "ready", errorKind: null, errorMessage: null, inflight: [], lastResult: null, lastResumeResult: null, resumeState: { phase: "idle", files: [] } } as unknown as WriteSnapshot;
  readonly subscribe = (l: () => void): (() => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  readonly getSnapshot = (): WriteSnapshot => this.snap;
  sendPrompt(file: string, text: string, model?: string, cwd?: string): Promise<unknown> {
    // v1.5（批A）：cwd 仅在提供时落账（缺省面断言形状不变）
    this.sent.push(cwd === undefined ? { file, text, model } : { file, text, model, cwd });
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

  it("换模型=清直达输入（不再发帧直至重提）；P2-2 补断言", async () => {
    const write = new StubWrite();
    write.resolveWith = { kind: "not-ready", cause: "spawn-exited", detail: "model not found" };
    render(
      React.createElement(NewSession, {
        wsClient: modelsSnap("ok"),
        writeClient: write as unknown as WriteClientSurface,
        rootsHint: "x",
        onLaunched: vi.fn(),
        onCancel: vi.fn(),
      }),
    );
    fill("会话文件名", "a.jsonl");
    fill("首条消息", "hi");
    fill("模型 id 直达", "nope/bad");
    fireEvent.click(screen.getByRole("button", { name: "创建会话" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    const sentBefore = write.sent.length;
    fireEvent.click(screen.getByRole("button", { name: "换模型" })); // 换模型=清直达（用户改输入后重试）
    expect((screen.getByLabelText("模型 id 直达") as HTMLInputElement).value).toBe("");
    expect(write.sent).toHaveLength(sentBefore); // 换模型动作本身零发帧
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
    const onCancel = vi.fn();
    render(
      React.createElement(NewSession, {
        wsClient: modelsSnap("ok"),
        writeClient: write as unknown as WriteClientSurface,
        rootsHint: "x",
        onLaunched,
        onCancel,
      }),
    );
    fill("会话文件名", "a.jsonl");
    fill("首条消息", "hi");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onCancel).toHaveBeenCalledTimes(1); // P2-2 补真断言（原版零断言空转）
    fireEvent.click(screen.getByRole("button", { name: "创建会话" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("busy"));
    expect(onLaunched).not.toHaveBeenCalled();
  });

  it("P2-3：connecting 期挂载→ws 到 ready 后补拉清单（防 idle 永久停滞）", async () => {
    const listeners = new Set<() => void>();
    let snap: { models: ModelsState; roots: RootsState; state: string } = {
      models: { status: "idle", items: [], cause: null },
      roots: ROOTS_IDLE,
      state: "connecting",
    };
    const requestModels = vi.fn();
    const wsClient: ModelsSource & RootsSource = {
      requestModels,
      requestRoots: vi.fn(),
      subscribe: (l: () => void) => {
        listeners.add(l);
        return () => {
          listeners.delete(l);
        };
      },
      getSnapshot: () => snap,
    };
    render(
      React.createElement(NewSession, {
        wsClient,
        writeClient: new StubWrite() as unknown as WriteClientSurface,
        rootsHint: "x",
        onLaunched: vi.fn(),
        onCancel: vi.fn(),
      }),
    );
    expect(requestModels).toHaveBeenCalledTimes(1); // 挂载即拉（connecting 期被 ready 态门丢弃）
    snap = { ...snap, state: "ready" };
    listeners.forEach((l) => l());
    await waitFor(() => expect(requestModels).toHaveBeenCalledTimes(2)); // 到 ready 补拉
  });
});

// ---------------------------------------------------------------------------
// v1.5（批A）目录选择器：roots 加载/禁载态/默认选中/选择透传 cwd/单根与失败降级。
// UX 口径：首项=会话记录树（契约「非 cwd 候选」）不入选项；默认选中=候选首项（roots[1]）。
// ---------------------------------------------------------------------------

describe("v1.5 NewSession 目录选择器（批A roots）", () => {
  const ROOTS3: RootsState = { status: "ok", items: ["/srv/sessions", "/srv/proj-a", "/home/yyj/ai"], cause: null };

  function fillAndCreate(): void {
    fill("会话文件名", "a.jsonl");
    fill("首条消息", "hi");
    fireEvent.click(screen.getByRole("button", { name: "创建会话" }));
  }

  it("挂载即 requestRoots（与 requestModels 同补拉口径）", () => {
    const src = modelsSnap("ok", [], null, ROOTS3);
    setup(src);
    expect(src.requestRoots).toHaveBeenCalledTimes(1);
  });

  it("禁载态：roots idle/loading→项目目录下拉禁用且仅占位项", () => {
    setup(modelsSnap("ok", [], null, { status: "loading", items: [], cause: null }));
    const select = screen.getByLabelText("项目目录") as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(select.querySelectorAll("option")).toHaveLength(1);
    expect(select.options[0]!.textContent).toContain("加载中");
  });

  it("roots ok：首项（会话记录树）不入选项；默认选中=候选首项；创建携 cwd=roots[1]", async () => {
    const { write, onLaunched } = setup(modelsSnap("ok", [], null, ROOTS3));
    const select = screen.getByLabelText("项目目录") as HTMLSelectElement;
    expect(select.disabled).toBe(false);
    const values = [...select.options].map((o) => o.value);
    expect(values).toEqual(["/srv/proj-a", "/home/yyj/ai"]); // 首项 /srv/sessions 不在
    expect(select.value).toBe("/srv/proj-a"); // 默认选中=非首项的第一个
    fillAndCreate();
    await waitFor(() => expect(onLaunched).toHaveBeenCalledWith("a.jsonl"));
    expect(write.sent).toEqual([{ file: "a.jsonl", text: "hi", model: undefined, cwd: "/srv/proj-a" }]);
  });

  it("用户改选第三项→创建携 cwd=roots[2]", async () => {
    const { write, onLaunched } = setup(modelsSnap("ok", [], null, ROOTS3));
    fireEvent.change(screen.getByLabelText("项目目录"), { target: { value: "/home/yyj/ai" } });
    fillAndCreate();
    await waitFor(() => expect(onLaunched).toHaveBeenCalled());
    expect(write.sent[0]!.cwd).toBe("/home/yyj/ai");
  });

  it("单根（仅会话记录树）：无选择器+降级提示；创建不携 cwd（服务端默认目录兜底）", async () => {
    const { write, onLaunched } = setup(
      modelsSnap("ok", [], null, { status: "ok", items: ["/srv/sessions"], cause: null }),
    );
    expect(screen.queryByLabelText("项目目录")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("默认目录");
    fillAndCreate();
    await waitFor(() => expect(onLaunched).toHaveBeenCalled());
    expect(write.sent).toEqual([{ file: "a.jsonl", text: "hi", model: undefined }]); // 无 cwd 键
  });

  it("roots failed：降级提示含受控 cause；创建不携 cwd", async () => {
    const { write, onLaunched } = setup(
      modelsSnap("ok", [], null, { status: "failed", items: [], cause: "服务端错误（4402）" }),
    );
    expect(screen.queryByLabelText("项目目录")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("服务端错误（4402）");
    fillAndCreate();
    await waitFor(() => expect(onLaunched).toHaveBeenCalled());
    expect(write.sent).toEqual([{ file: "a.jsonl", text: "hi", model: undefined }]);
  });
});
