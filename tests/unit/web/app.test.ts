// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App, MOBILE_QUERY } from "../../../apps/web/src/App";
import { fixtureAdapter } from "../../../apps/web/src/fixtures/adapter";

let narrow = false;
let listeners: Set<() => void>;
beforeEach(() => {
  narrow = false;
  listeners = new Set();
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: narrow,
      media: query,
      addEventListener: (_: string, callback: () => void) => listeners.add(callback),
      removeEventListener: (_: string, callback: () => void) => listeners.delete(callback),
    })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function resize(mobile: boolean) {
  act(() => {
    narrow = mobile;
    listeners.forEach((callback) => callback());
  });
}
const mount = (props = {}) => render(React.createElement(App, props));

describe("双布局壳与导航", () => {
  it("桌面呈现三栏；窄屏只呈现一级且动态响应断点", async () => {
    const user = userEvent.setup();
    const { container } = mount();
    expect(screen.getByRole("navigation", { name: "会话列表" })).toBeTruthy();
    expect(screen.getByRole("main", { name: "当前会话" })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "详情侧栏" })).toBeTruthy();
    resize(true);
    expect(window.matchMedia).toHaveBeenCalledWith(MOBILE_QUERY);
    expect(container.querySelector('[data-layout="mobile"]')).not.toBeNull();
    expect(screen.queryByRole("main")).toBeNull();
    expect(screen.queryByRole("complementary")).toBeNull();
    await user.click(screen.getByRole("button", { name: /搭建会话工作台/ }));
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.getByRole("main")).toBeTruthy();
    resize(false);
    expect(screen.getByRole("navigation")).toBeTruthy();
    expect(screen.getByRole("complementary")).toBeTruthy();
  });
  it("手机可见返回按钮恢复列表层级和原行焦点", async () => {
    narrow = true;
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: /确认交互方案/ }));
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "确认交互方案" }));
    expect(screen.getByText(/演示问题尚未接入确认通道/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "← 返回列表" }));
    expect(screen.queryByRole("main")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /确认交互方案/ }));
    expect(screen.getByText("待答 1 · 未读 3")).toBeTruthy();
  });
  it("列表上下键、Enter 打开与 Esc 返回均管理焦点", async () => {
    narrow = true;
    const user = userEvent.setup();
    mount();
    screen.getByRole("button", { name: /搭建会话工作台/ }).focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /确认交互方案/ }));
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /搭建会话工作台/ }));
    await user.keyboard("{ArrowDown}{Enter}");
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "确认交互方案" }));
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /确认交互方案/ }));
  });
  it("空 adapter 与空态场景可读，仍有新建入口", () => {
    mount({ adapter: { ...fixtureAdapter, sessions: [] } });
    expect(screen.getByRole("heading", { name: "还没有会话" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "＋ 新建" })).toBeTruthy();
  });
  it("加载与连接异常静态场景不声称成功或重试已受理", async () => {
    const user = userEvent.setup();
    mount({ initialState: "loading" });
    expect(screen.getByRole("status").getAttribute("aria-busy")).toBe("true");
    await user.selectOptions(screen.getByLabelText("场景"), "offline");
    expect(screen.getByRole("alert").textContent).toContain("连接异常 · 状态待确认");
    await user.click(screen.getByRole("button", { name: "返回样本演示" }));
    expect(screen.queryByRole("alert")).toBeNull();
    await user.selectOptions(screen.getByLabelText("场景"), "empty");
    expect(screen.getByRole("heading", { name: "还没有会话" })).toBeTruthy();
  });
  it("unknown 与恢复暂定为中性状态，三色均附文字", () => {
    mount();
    for (const label of ["运行中", "已完成", "待你确认"]) expect(screen.getByText(label)).toBeTruthy();
    const badges = screen.getAllByText("状态待确认");
    expect(badges).toHaveLength(2);
    for (const badge of badges) expect(badge.classList.contains("done")).toBe(false);
  });
  it("手机新建保留模型下拉；不创建真实会话，Esc 返回新建按钮", async () => {
    narrow = true;
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "＋ 新建" }));
    expect(screen.getByLabelText("模型")).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("模型"), fixtureAdapter.models[1]!);
    expect((screen.getByRole("button", { name: /创建会话/ }) as HTMLButtonElement).disabled).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.getByRole("navigation")).toBeTruthy();
  });
  it("不把 HTML 或未知 part 当活动内容或权限卡渲染", async () => {
    const user = userEvent.setup();
    const sample = fixtureAdapter.sessions[0]!;
    const { container } = mount({
      adapter: {
        ...fixtureAdapter,
        sessions: [
          {
            ...sample,
            messages: [
              {
                id: "unsafe",
                seq: 1,
                role: "assistant",
                parts: [
                  { type: "text", text: "<img src=x onerror=alert(1)>", source: "fixture", version: 1 },
                  { type: "interactive", text: "批准命令", source: "fixture", version: 1 },
                ],
              },
            ],
          },
        ],
      },
    });
    await user.click(screen.getByRole("button", { name: /搭建会话工作台/ }));
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("不支持的内容")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "批准命令" })).toBeNull();
  });
});
