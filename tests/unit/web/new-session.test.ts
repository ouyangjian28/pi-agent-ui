// @vitest-environment jsdom
// M-OPS（v1.4）新建会话视图测试：挂载即拉清单/文件名与模型本地预校验（零帧）/launched→onLaunched/
// not-ready→红条+重试重发+换模型清直达/清单 failed 降级 free-text 仍可用/free-text 优先生效。
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach } from "vitest";
import { NewSession, writeLastModel, type ModelsSource, type RootsSource } from "../../../apps/web/src/components/new-session";
import type { ModelsState, RootsState } from "../../../apps/web/src/ws/ws-client";
import type { WriteClientSurface, WriteSnapshot } from "../../../apps/web/src/ws/write-client";

afterEach(cleanup);

const LAUNCHED = { kind: "launched", intentId: "i-1", commandId: 1 } as const;

const ROOTS_IDLE: RootsState = { status: "idle", items: [], journalRoot: null, cause: null };

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

beforeEach(() => {
  window.localStorage.clear(); // 批3 记住上次：防例间串扰（挂载恢复会读到前例写入）
});

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

  it("批3：无文件名输入框；首条消息空→创建钮禁用；创建→file=auto- 格式（model 不携带）", async () => {
    const { write, onLaunched } = setup();
    expect(screen.queryByLabelText("会话文件名")).toBeNull(); // 用户拍板：文件名不显示给用户
    const btn = screen.getByRole("button", { name: "创建会话" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true); // 首条消息空→禁用
    fill("首条消息", "hi");
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    await waitFor(() => expect(onLaunched).toHaveBeenCalled());
    expect(onLaunched.mock.calls[0]![0]).toMatch(/^auto-\d{8}-\d{6}-[0-9a-f]{32}\.jsonl$/);
    expect(write.sent[0]).toMatchObject({ text: "hi", model: undefined });
    expect(write.sent[0]!.file).toMatch(/^auto-/); // 后台自动生成
  });

  it("free-text 优先生效（覆盖下拉）；modelPattern 非法→本地拒零帧", async () => {
    const { write, onLaunched } = setup();
    fill("首条消息", "hi");
    fill("模型 id 直达", "openai-codex/gpt-5.3");
    fireEvent.click(screen.getByRole("button", { name: "创建会话" }));
    await waitFor(() => expect(onLaunched).toHaveBeenCalled());
    expect(write.sent[0]!.model).toBe("openai-codex/gpt-5.3");
    const btn = screen.getByRole("button", { name: "创建会话" }) as HTMLButtonElement;
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
    fill("首条消息", "hi");
    fill("模型 id 直达", "nope/bad");
    fireEvent.click(screen.getByRole("button", { name: "创建会话" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toContain("模型 id 有误");
    expect(onLaunched).not.toHaveBeenCalled();
    write.resolveWith = LAUNCHED;
    fireEvent.click(screen.getByRole("button", { name: "重试" })); // 重试=重发同 prompt
    await waitFor(() => expect(onLaunched.mock.calls[0]![0]).toMatch(/^auto-/));
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
// 批3（用户拍板减法）：新建页零目录元素、零文件名输入框。
// roots 数据域仍拉取（requestRoots 保留供壳层 rootsHint），UI 恒不渲染选择器；
// 创建恒不携 cwd（服务端默认目录兜底）——多根/失败/单根场景一致。
// ---------------------------------------------------------------------------

describe("批3 NewSession 目录减法", () => {
  const ROOTS3: RootsState = { status: "ok", items: ["/srv/sessions", "/srv/proj-a", "/home/yyj/ai"], journalRoot: null, cause: null };
  const ROOTS_DUAL: RootsState = { status: "ok", items: ["/srv/sessions/pi", "/srv/sessions", "/srv/proj-a"], journalRoot: "/srv/sessions", cause: null };

  function fillAndCreate(): void {
    fill("首条消息", "hi");
    fireEvent.click(screen.getByRole("button", { name: "创建会话" }));
  }

  it("requestRoots 数据域保留（挂载即拉；与 requestModels 同补拉口径）", () => {
    const src = modelsSnap("ok", [], null, ROOTS3);
    setup(src);
    expect(src.requestRoots).toHaveBeenCalledTimes(1);
  });

  it("多根场景：无项目目录元素、无文件名输入框；创建不携 cwd（恒服务端默认）", async () => {
    const { write, onLaunched } = setup(modelsSnap("ok", [], null, ROOTS3));
    expect(screen.queryByLabelText("项目目录")).toBeNull();
    expect(screen.queryByLabelText("会话文件名")).toBeNull();
    expect(screen.getByText("新会话将创建在：/srv/sessions")).toBeTruthy(); // rootsHint 一行提示保留
    fillAndCreate();
    await waitFor(() => expect(onLaunched).toHaveBeenCalled());
    expect(write.sent[0]).toEqual({ file: expect.stringMatching(/^auto-/), text: "hi", model: undefined }); // 无 cwd 键
  });

  it("v1.6 双树/journalRoot 下发：同样零目录元素（不依赖清单形状）", async () => {
    const { write, onLaunched } = setup(modelsSnap("ok", [], null, ROOTS_DUAL));
    expect(screen.queryByLabelText("项目目录")).toBeNull();
    fillAndCreate();
    await waitFor(() => expect(onLaunched).toHaveBeenCalled());
    expect(write.sent[0]).toEqual({ file: expect.stringMatching(/^auto-/), text: "hi", model: undefined });
  });

  it("roots failed/loading：用户无感（无等待面无降级文案）；创建仍不携 cwd", async () => {
    const { write, onLaunched } = setup(
      modelsSnap("ok", [], null, { status: "failed", items: [], cause: "服务端错误（4402）" }),
    );
    expect(screen.queryByLabelText("项目目录")).toBeNull();
    expect(screen.queryByText(/加载中|服务端错误/)).toBeNull(); // 目录域任何状态都不冒泡到 UI
    fillAndCreate();
    await waitFor(() => expect(onLaunched).toHaveBeenCalled());
    expect(write.sent[0]).toEqual({ file: expect.stringMatching(/^auto-/), text: "hi", model: undefined });
  });
});

describe("批3 模型记住上次（localStorage）", () => {
  function lastModel(): string | null {
    return window.localStorage.getItem("piagent-last-model");
  }

  it("创建成功发出即写入本次实际用的模型；下次挂载恢复选择", async () => {
    window.localStorage.clear();
    const { write } = setup(modelsSnap("ok", [{ provider: "kimi-coding", id: "k3", context: "256k" }]));
    fireEvent.change(screen.getByLabelText("模型选择"), { target: { value: "kimi-coding/k3" } });
    fill("首条消息", "hi");
    fireEvent.click(screen.getByRole("button", { name: "创建会话" }));
    await waitFor(() => expect(write.sent).toHaveLength(1));
    expect(lastModel()).toBe("kimi-coding/k3");
  });

  it("默认（不选）→写哨兵 __default__；挂载恢复默认态（不选中任何清单项）", async () => {
    window.localStorage.clear();
    const { write } = setup(modelsSnap("ok", [{ provider: "kimi-coding", id: "k3" }]));
    fill("首条消息", "hi");
    fireEvent.click(screen.getByRole("button", { name: "创建会话" }));
    await waitFor(() => expect(write.sent).toHaveLength(1));
    expect(lastModel()).toBe("__default__");
    // 卸载再挂载：恢复默认（select 显默认项）
    cleanup();
    setup(modelsSnap("ok", [{ provider: "kimi-coding", id: "k3" }]));
    expect((screen.getByLabelText("模型选择") as HTMLSelectElement).value).toBe("__default__");
  });

  it("手打自定义 id 创建→写入该值；再挂载恢复（自定义 option 呈现）", async () => {
    window.localStorage.clear();
    const { write } = setup(modelsSnap("ok", []));
    fill("模型 id 直达", "openai-codex/gpt-5.3");
    fill("首条消息", "hi");
    fireEvent.click(screen.getByRole("button", { name: "创建会话" }));
    await waitFor(() => expect(write.sent).toHaveLength(1));
    expect(write.sent[0]!.model).toBe("openai-codex/gpt-5.3");
    expect(lastModel()).toBe("openai-codex/gpt-5.3");
    cleanup();
    setup(modelsSnap("ok", []));
    expect((screen.getByLabelText("模型选择") as HTMLSelectElement).value).toBe("openai-codex/gpt-5.3");
  });

  it("R2-P2-01：恢复旧模型+清单永久挂起（loading）→select 仍可选「默认」→创建帧无 model 键", async () => {
    window.localStorage.setItem("piagent-last-model", "gone/old"); // 合法但清单外旧 id
    const { write } = setup(modelsSnap("loading")); // 清清单项：loading 永不回包（无重试）
    const sel = screen.getByLabelText("模型选择") as HTMLSelectElement;
    expect(sel.value).toBe("gone/old"); // 恢复成功（自定义项显示）
    expect(sel.disabled).toBe(false); // R2-P2-01：loading 不禁 select（默认项不依赖清单）
    fireEvent.change(sel, { target: { value: "__default__" } }); // 回默认（此前被 loading 禁用不可达）
    expect(sel.value).toBe("__default__");
    fill("首条消息", "hi");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "创建会话" })); });
    expect(write.sent).toHaveLength(1);
    expect(write.sent[0].model).toBeUndefined(); // 实际帧无 model 键=真回默认（非发 __default__ 字符串）
  });

  it("R2-P2-02：哨兵值零发送（selectModel 层守卫+modelValid 层拦截双层；行为出口=发送门）", async () => {
    window.localStorage.setItem("piagent-last-model", "gone/old");
    const { write } = setup(modelsSnap("loading"));
    const sel = screen.getByLabelText("模型选择") as HTMLSelectElement;
    expect(sel.value).toBe("gone/old");
    fill("首条消息", "hi");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "创建会话" })); });
    expect(write.sent).toHaveLength(1);
    expect(write.sent[0].model).toBe("gone/old"); // 发送用恢复值（哨兵未漏入）
    // modelValid 层独立证：手打 __default__ 草稿不作 id 发送（__ 前缀保留样式禁创建）
    cleanup();
    window.localStorage.clear();
    const w2 = setup(modelsSnap("loading"));
    fireEvent.change(screen.getByLabelText("模型 id 直达"), { target: { value: "__default__" } });
    fill("首条消息", "hi");
    const btn = screen.getByRole("button", { name: "创建会话" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true); // modelValid=false 禁创建
    expect(w2.write.sent).toHaveLength(0);
    cleanup();
    window.localStorage.clear();
    // 草稿 __custom__ 同拒（select 同值 option 路径的入口值）
    const w3 = setup(modelsSnap("loading"));
    fireEvent.change(screen.getByLabelText("模型 id 直达"), { target: { value: "__custom__" } });
    fill("首条消息", "hi");
    expect((screen.getByRole("button", { name: "创建会话" }) as HTMLButtonElement).disabled).toBe(true);
    expect(w3.write.sent).toHaveLength(0);
  });

  it("杀点A（GPT 三审 Mu-r3-3 裁决）：selectModel 哨兵拒收→零状态迁移（草稿不清/锚不变），非行为等价死层", async () => {
    // 独立行为出口=状态迁移面：拒收既不清草稿也不改 choice（旧守卫裸 pattern 会对 __custom__ 误迁移：清草稿+锚定哨兵）
    window.localStorage.setItem("piagent-last-model", "gone/old");
    setup(modelsSnap("loading")); // 恢复合法旧 id+清单挂起
    const sel = screen.getByLabelText("模型选择") as HTMLSelectElement;
    expect(sel.value).toBe("gone/old");
    fill("首条消息", "hi");
    const input = screen.getByLabelText("模型 id 直达") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "__custom__" } }); // 草稿哨兵：modelValid 禁创建
    expect((screen.getByRole("button", { name: "创建会话" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(sel, { target: { value: "__custom__" } }); // 受控 handler 输入（同值 option 路径入口）
    expect(input.value).toBe("__custom__"); // 杀点：拒收未清草稿（旧守卫此处得空串）
    fireEvent.change(input, { target: { value: "" } }); // 手动清空草稿→回退锚
    expect(sel.value).toBe("gone/old"); // 锚未被哨兵覆盖（旧守卫此处得 __custom__）
    expect((screen.getByRole("button", { name: "创建会话" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("杀点B+R3-P3-01（GPT 三审）：__ 前缀清单项渲染同步拒绝（disabled+标不可用）；handler 拒收值不变", () => {
    // DTO 形状校验允许 {provider:"__reserved"} 入清单；渲染面与选择守卫同口径同步表现拒绝
    window.localStorage.clear();
    setup(modelsSnap("ok", [
      { provider: "__reserved", id: "m", context: "8k" },
      { provider: "kimi-coding", id: "k3" },
    ]));
    const sel = screen.getByLabelText("模型选择") as HTMLSelectElement;
    const opt = screen.getByRole("option", { name: /__reserved \/ m/ }) as HTMLOptionElement;
    expect(opt.disabled).toBe(true); // 渲染同步拒绝：不可选
    expect(opt.textContent).toContain("（不可用）"); // 显式标不可用（非静默）
    fireEvent.change(sel, { target: { value: "__reserved/m" } }); // 受控 handler：值被拒
    expect(sel.value).toBe("__default__"); // 杀点：选择零迁移（退回旧守卫此处得 __reserved/m）
    const ok = screen.getByRole("option", { name: /kimi-coding \/ k3/ }) as HTMLOptionElement;
    expect(ok.disabled).toBe(false); // 正常项不受连坐
  });

  it("autoFile 单次调用（GPT 三审 R2-P3-01 补证入仓）：挂载惰性生成一次，编辑/重试/再交互零重调", async () => {
    window.localStorage.clear();
    const spy = vi.spyOn(crypto, "getRandomValues");
    const { write } = setup(modelsSnap("ok", []));
    fill("首条消息", "hi");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "创建会话" })); });
    await waitFor(() => expect(write.sent).toHaveLength(1));
    expect(spy).toHaveBeenCalledTimes(1); // 全生命周期恰一次（退回 useRef(autoFile()) 每次 render 求值则 >1）
  });

  it("哨兵样式保留值（__custom__ 等）→读写双拒（P1-03 GPT 批2审：不得经存储面漏入 model 域）", () => {
    window.localStorage.clear();
    window.localStorage.setItem("piagent-last-model", "__custom__"); // 过 modelPattern 但属保留样式
    setup(modelsSnap("ok", [{ provider: "kimi-coding", id: "k3" }]));
    expect((screen.getByLabelText("模型选择") as HTMLSelectElement).value).toBe("__default__"); // 读取丢弃
    cleanup();
    window.localStorage.removeItem("piagent-last-model"); // 与写面验证隔离：拒写≠清污染，先移除手动 set 的值
    writeLastModel("__custom__");
    expect(window.localStorage.getItem("piagent-last-model")).toBe(null); // 零写入
    cleanup();
    writeLastModel("kimi-coding/k3");
    writeLastModel("__custom__"); // 已有合法值时哨兵也不得覆盖
    expect(window.localStorage.getItem("piagent-last-model")).toBe("kimi-coding/k3");
  });

  it("存储污染（非法值/异源键）→读取丢弃，恢复默认且不崩", () => {
    window.localStorage.clear();
    window.localStorage.setItem("piagent-last-model", "bad model!!");
    setup(modelsSnap("ok", [{ provider: "kimi-coding", id: "k3" }]));
    expect((screen.getByLabelText("模型选择") as HTMLSelectElement).value).toBe("__default__");
    cleanup();
    window.localStorage.setItem("piagent-last-model", "<script>alert(1)</script>");
    setup(modelsSnap("ok", [{ provider: "kimi-coding", id: "k3" }]));
    expect((screen.getByLabelText("模型选择") as HTMLSelectElement).value).toBe("__default__");
  });
});
