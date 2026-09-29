// @vitest-environment jsdom
// M-OPS（v1.4）not-ready 红条组件测试：cause 人话映射（含未知源兜底）/detail 纯文本渲染（React 转义）/
// role=alert+默认展开/两按钮可选（不传=纯展示）。
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NotReadyBanner } from "../../../apps/web/src/components/not-ready-banner";

afterEach(cleanup);

describe("M-OPS NotReadyBanner", () => {
  it("spawn-exited 映射人话+detail 纯文本渲染（<pre>）+role=alert+默认展开", () => {
    render(
      React.createElement(NotReadyBanner, {
        info: { cause: "spawn-exited", detail: 'Error: model "nope" not found' },
      }),
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("模型 id 有误");
    expect(alert.textContent).toContain('Error: model "nope" not found');
    const detail = alert.querySelector(".not-ready-detail");
    expect(detail).not.toBeNull();
    expect((detail as HTMLDetailsElement).open).toBe(true); // 默认展开=错模型线索直达
    expect(detail?.querySelector("pre")?.textContent).toBe('Error: model "nope" not found');
  });

  it("未知 cause 兜底通用文案；detail=null 不渲染折叠块", () => {
    render(React.createElement(NotReadyBanner, { info: { cause: "weird-cause", detail: null } }));
    expect(screen.getByRole("alert").textContent).toContain("pi 进程启动失败");
    expect(screen.queryByText("启动失败详情（stderr 尾行）")).toBeNull();
  });

  it("两按钮可选：不传=纯展示；传了=可点击回调", () => {
    const onRetry = vi.fn();
    const onSwitchModel = vi.fn();
    const { rerender } = render(
      React.createElement(NotReadyBanner, { info: { cause: "spawn-failed", detail: "boom" } }),
    );
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull(); // 纯展示态无按钮
    rerender(
      React.createElement(NotReadyBanner, {
        info: { cause: "spawn-failed", detail: "boom" },
        onRetry,
        onSwitchModel,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    fireEvent.click(screen.getByRole("button", { name: "换模型" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onSwitchModel).toHaveBeenCalledTimes(1);
  });

  it("readiness-timeout/not-running 映射各自人话", () => {
    for (const [cause, frag] of [
      ["readiness-timeout", "就绪超时"],
      ["not-running", "无运行中的 pi 进程"],
    ] as const) {
      cleanup();
      render(React.createElement(NotReadyBanner, { info: { cause, detail: null } }));
      expect(screen.getByRole("alert").textContent).toContain(frag);
    }
  });
});
