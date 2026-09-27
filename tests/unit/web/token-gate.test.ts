// @vitest-environment jsdom
// A1d token 门测试（经 RealApp 全链）：URL ?token= 读取+replaceState 清参数（其余参数保留）/
// localStorage 回退/URL 优先于 localStorage/受控输入面提交存储/空输入拒提交/
// 4401 认证失败面→「清除 token 重输」回输入面/全程 token 值不进 DOM。
// 注入式假 socket，不起真网络。
import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RealApp } from "../../../apps/web/src/real-app";
import { TOKEN_STORAGE_KEY } from "../../../apps/web/src/components/token-gate";
import type { WebSocketLike } from "../../../apps/web/src/ws/ws-client";

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];
  static reset(): void {
    FakeWebSocket.instances = [];
  }
  readyState = 0;
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: { readonly code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code = 1000): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  sentFrames(): { t?: string; token?: string }[] {
    return this.sent.map((s) => JSON.parse(s) as { t?: string; token?: string });
  }
}

const factory = (url: string) => new FakeWebSocket(url);

beforeEach(() => {
  FakeWebSocket.reset();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("token 门：来源优先级", () => {
  it("URL ?token= 优先：读取后 replaceState 清掉参数（server= 等其余参数保留），token 存 localStorage", () => {
    window.history.replaceState(null, "", "/?token=url-token&server=ws://127.0.0.1:9");
    render(React.createElement(RealApp, { createSocket: factory }));
    expect(FakeWebSocket.instances).toHaveLength(3); // token 确定即建三件套
    act(() => FakeWebSocket.instances[0]!.open());
    expect(FakeWebSocket.instances[0]!.sentFrames()).toEqual([
      { t: "hello", protocolVersion: 1, token: "url-token" },
    ]);
    // 地址栏不再含 token；server= 参数保留
    expect(window.location.search).not.toContain("url-token");
    expect(new URLSearchParams(window.location.search).get("server")).toBe("ws://127.0.0.1:9");
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe("url-token");
  });

  it("URL ?token= 是唯一参数时清成裸路径", () => {
    window.history.replaceState(null, "", "/?token=only-token");
    render(React.createElement(RealApp, { createSocket: factory }));
    expect(window.location.search).toBe("");
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it("localStorage 回退：无 URL token 时用已存令牌", () => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, "stored-token");
    render(React.createElement(RealApp, { createSocket: factory }));
    expect(FakeWebSocket.instances).toHaveLength(3);
    act(() => FakeWebSocket.instances[0]!.open());
    expect(FakeWebSocket.instances[0]!.sentFrames()[0]).toEqual({
      t: "hello",
      protocolVersion: 1,
      token: "stored-token",
    });
  });

  it("URL token 优先于 localStorage 并覆盖之", () => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, "stored-token");
    window.history.replaceState(null, "", "/?token=url-token");
    render(React.createElement(RealApp, { createSocket: factory }));
    act(() => FakeWebSocket.instances[0]!.open());
    expect(FakeWebSocket.instances[0]!.sentFrames()[0]).toEqual({
      t: "hello",
      protocolVersion: 1,
      token: "url-token",
    });
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe("url-token");
  });
});

describe("token 门：受控输入面", () => {
  it("两来源都缺省时渲染输入面，不建任何连接", () => {
    render(React.createElement(RealApp, { createSocket: factory }));
    expect(screen.getByLabelText("访问令牌")).toBeTruthy();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("提交后存 localStorage 并建三件套（trim 后非空才受理）", () => {
    render(React.createElement(RealApp, { createSocket: factory }));
    fireEvent.change(screen.getByLabelText("访问令牌"), { target: { value: "  typed-token  " } });
    fireEvent.click(screen.getByRole("button", { name: "连接" }));
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe("typed-token");
    expect(FakeWebSocket.instances).toHaveLength(3);
    act(() => FakeWebSocket.instances[0]!.open());
    expect(FakeWebSocket.instances[0]!.sentFrames()[0]).toEqual({
      t: "hello",
      protocolVersion: 1,
      token: "typed-token",
    });
  });

  it("空输入/纯空白不可提交（按钮禁用）", () => {
    render(React.createElement(RealApp, { createSocket: factory }));
    const button = screen.getByRole("button", { name: "连接" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("访问令牌"), { target: { value: "   " } });
    expect(button.disabled).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});

describe("token 门：4401 与泄漏面", () => {
  it("4401→受控错误面+「清除 token 重输」：点击后清 localStorage 回输入面，token 值全程不进 DOM", () => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, "bad-token");
    render(React.createElement(RealApp, { createSocket: factory }));
    act(() => {
      FakeWebSocket.instances[0]!.open();
      FakeWebSocket.instances[0]!.receive({
        t: "error",
        code: 4401,
        message: "unauthorized: token=bad-token", // 远端自由文本回显令牌——受控面绝不渲染
        retryable: false,
      });
    });
    expect(screen.getByRole("alert").textContent).toContain("认证失败");
    expect(document.body.textContent).not.toContain("bad-token");

    fireEvent.click(screen.getByRole("button", { name: "清除 token 重输" }));
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    expect(screen.getByLabelText("访问令牌")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("访问令牌"), { target: { value: "fresh-token" } });
    fireEvent.click(screen.getByRole("button", { name: "连接" }));
    expect(FakeWebSocket.instances).toHaveLength(6); // 旧三件套已弃，新三件套重建
    act(() => FakeWebSocket.instances[3]!.open());
    expect(FakeWebSocket.instances[3]!.sentFrames()[0]).toEqual({
      t: "hello",
      protocolVersion: 1,
      token: "fresh-token",
    });
  });

  it("连接建立后 DOM 任何位置都不含 token 值", () => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, "super-secret-token");
    render(React.createElement(RealApp, { createSocket: factory }));
    act(() => {
      for (const ws of FakeWebSocket.instances) ws.open();
    });
    expect(document.body.textContent).not.toContain("super-secret-token");
    expect(window.location.search).not.toContain("super-secret-token");
  });
});
