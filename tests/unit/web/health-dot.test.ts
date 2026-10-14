// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HealthDot, connectionHealth, type ConnectionState } from "../../../apps/web/src/components/health-dot";
afterEach(cleanup);
describe("HealthDot 三档完整映射", () => {
  const states: ConnectionState[] = ["connecting", "authenticating", "ready", "closed", "error"];
  it("125 组合优先级穷尽：全 ready 绿、全终态红，其余黄；认证优先", () => {
    for (const a of states) for (const b of states) for (const c of states) {
      const trio = [a, b, c]; const expected = trio.every((s) => s === "ready") ? "ok" : trio.every((s) => s === "error" || s === "closed") ? "err" : "warn";
      expect(connectionHealth(trio).tone).toBe(expected); expect(connectionHealth(trio, true)).toEqual({ tone: "err", text: "认证失败" });
    }
  });
  it("绿色可触屏打开、真实三域明细、Esc 关闭焦点归还，立即重连显式动作", () => {
    const reconnect = vi.fn(); render(React.createElement(HealthDot, { states: ["ready", "ready", "ready"], onReconnect: reconnect, reconnect: null }));
    const button = screen.getByRole("button", { name: "连接状态：全部已连接" }); fireEvent.click(button);
    expect(screen.getByRole("dialog", { name: "连接明细" })).toBeTruthy(); expect(screen.getAllByText("已连接")).toHaveLength(3);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "立即重连" }));
    fireEvent.click(screen.getByRole("button", { name: "立即重连" })); expect(reconnect).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "Escape" }); expect(screen.queryByRole("dialog")).toBeNull(); expect(document.activeElement).toBe(button);
    fireEvent.click(button); fireEvent.pointerDown(document.body); expect(screen.queryByRole("dialog")).toBeNull(); expect(document.activeElement).toBe(button);
  });
});
