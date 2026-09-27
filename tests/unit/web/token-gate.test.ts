// @vitest-environment jsdom
// A1d token 门测试（经 RealApp 全链）：URL ?token= 读取+replaceState 清参数（其余参数/hash/history.state 保留）/
// localStorage 回退/URL 优先于 localStorage/受控输入面提交存储/空输入拒提交/
// 4401 认证失败面→「清除 token 重输」回输入面/连接与错误面不回显令牌（N5 措辞收窄：
// textContent 断言不支撑「DOM 任何位置/全程」，手输阶段 password input 的 value 本来就可被脚本读）。
// B1 认证目的地绑定（RealApp 全链）：跨源 ?server= 零携密 hello/同源覆盖正常/生产忽略 ?server=。
// N1 清参边界：空值/重复键/编码值/hash 与 history.state 保留。
// 注入式假 socket，不起真网络。
import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RealApp } from "../../../apps/web/src/real-app";
import { TOKEN_STORAGE_KEY, clearUrlToken, readUrlToken } from "../../../apps/web/src/components/token-gate";
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
    // server 覆盖取同源值（B1：同源目的地才允许 hello 携带令牌）
    const sameOriginServer = `ws://${window.location.host}/ws`;
    window.history.replaceState(null, "", `/?token=url-token&server=${encodeURIComponent(sameOriginServer)}`);
    render(React.createElement(RealApp, { createSocket: factory }));
    expect(FakeWebSocket.instances).toHaveLength(3); // token 确定即建三件套
    expect(FakeWebSocket.instances[0]!.url).toBe(sameOriginServer);
    act(() => FakeWebSocket.instances[0]!.open());
    expect(FakeWebSocket.instances[0]!.sentFrames()).toEqual([
      { t: "hello", protocolVersion: 1, token: "url-token" },
    ]);
    // 地址栏不再含 token；server= 参数保留
    expect(window.location.search).not.toContain("url-token");
    expect(new URLSearchParams(window.location.search).get("server")).toBe(sameOriginServer);
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
  it("4401→受控错误面+「清除 token 重输」：点击后清 localStorage 回输入面，连接与错误面不回显令牌", () => {
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

  it("连接建立后正文面（textContent）与地址栏均不含 token 值", () => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, "super-secret-token");
    render(React.createElement(RealApp, { createSocket: factory }));
    act(() => {
      for (const ws of FakeWebSocket.instances) ws.open();
    });
    expect(document.body.textContent).not.toContain("super-secret-token");
    expect(window.location.search).not.toContain("super-secret-token");
  });
});

describe("N1：清参边界（readUrlToken/clearUrlToken 纯面）", () => {
  it("空值+重复键：?token=&token=有效值 → 取有效值，全部 token 键删除", () => {
    const r = readUrlToken("?token=&token=real-token");
    expect(r.token).toBe("real-token");
    expect(r.cleanedSearch).toBe("");
    expect(r.hadTokenParam).toBe(true);
  });
  it("重复键全删：?token=a&token=b → 取首个非空 a，cleanedSearch 不含任何 token 键", () => {
    const r = readUrlToken("?token=a&token=b&x=1");
    expect(r.token).toBe("a");
    expect(r.cleanedSearch).toBe("?x=1");
    expect(r.cleanedSearch).not.toContain("token");
  });
  it("编码值正确解码，其余参数（含重复键）原序保留", () => {
    const r = readUrlToken("?x=1&token=a%20b%26c&x=2&server=ws%3A%2F%2Fhost%3A1");
    expect(r.token).toBe("a b&c");
    expect(r.cleanedSearch).toBe("?x=1&x=2&server=ws%3A%2F%2Fhost%3A1");
  });
  it("全部 token 键为空：token=null 但 hadTokenParam=true（仍应清参）", () => {
    const r = readUrlToken("?token=&x=1");
    expect(r.token).toBeNull();
    expect(r.hadTokenParam).toBe(true);
    expect(r.cleanedSearch).toBe("?x=1");
  });
  it("无 token 键：原样返回且 hadTokenParam=false", () => {
    const r = readUrlToken("?x=1&x=2");
    expect(r).toEqual({ token: null, cleanedSearch: "?x=1&x=2", hadTokenParam: false });
  });
  it("clearUrlToken 保留 hash 与 history.state（N1 修复：旧实现二者皆丢）", () => {
    window.history.replaceState({ keep: 1 }, "", "/sub?token=t&x=1&x=2#anchor");
    clearUrlToken("?x=1&x=2");
    expect(window.location.pathname).toBe("/sub");
    expect(window.location.search).toBe("?x=1&x=2");
    expect(window.location.hash).toBe("#anchor");
    expect(window.history.state).toEqual({ keep: 1 });
  });
  it("RealApp 全链：?token= 清参后 hash 与 history.state 保留", () => {
    window.history.replaceState({ keep: 2 }, "", "/?token=url-token#section");
    render(React.createElement(RealApp, { createSocket: factory }));
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("#section");
    expect(window.history.state).toEqual({ keep: 2 });
    expect(FakeWebSocket.instances).toHaveLength(3);
  });
  it("RealApp 全链：?token=（空值）也清参，回退 localStorage/输入面", () => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, "stored-token");
    window.history.replaceState(null, "", "/?token=&x=1");
    render(React.createElement(RealApp, { createSocket: factory }));
    expect(window.location.search).toBe("?x=1"); // 空 token 键已清
    expect(FakeWebSocket.instances).toHaveLength(3); // 回退到已存令牌建连
  });
});

describe("B1：认证目的地绑定（RealApp 全链，假 socket 抓首帧）", () => {
  it("a) 预存 token + 跨源 ?server=（不同端口也算跨源）→ 三客户端零 hello 携 token + UI 提示", () => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, "stored-secret");
    const crossOrigin = `ws://${window.location.hostname}:1/ws`; // 同主机不同端口=跨源
    window.history.replaceState(null, "", `/?server=${encodeURIComponent(crossOrigin)}`);
    render(React.createElement(RealApp, { createSocket: factory }));
    expect(FakeWebSocket.instances).toHaveLength(3);
    for (const ws of FakeWebSocket.instances) expect(ws.url).toBe(crossOrigin); // dev 覆盖仍生效
    act(() => {
      for (const ws of FakeWebSocket.instances) ws.open();
    });
    for (const ws of FakeWebSocket.instances) {
      expect(ws.sentFrames()).toEqual([{ t: "hello", protocolVersion: 1, token: "" }]); // 零携密
      expect(ws.sent.join("")).not.toContain("stored-secret");
    }
    expect(screen.getByText(/跨源目标不支持凭据/)).toBeTruthy();
  });

  it("b) 预存 token + 同源 ?server=（dev 语义）→ hello 正常携带令牌，无跨源提示", () => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, "stored-secret");
    const sameOrigin = `ws://${window.location.host}/ws`;
    window.history.replaceState(null, "", `/?server=${encodeURIComponent(sameOrigin)}`);
    render(React.createElement(RealApp, { createSocket: factory }));
    expect(FakeWebSocket.instances).toHaveLength(3);
    for (const ws of FakeWebSocket.instances) expect(ws.url).toBe(sameOrigin);
    act(() => {
      for (const ws of FakeWebSocket.instances) ws.open();
    });
    for (const ws of FakeWebSocket.instances) {
      expect(ws.sentFrames()).toEqual([{ t: "hello", protocolVersion: 1, token: "stored-secret" }]);
    }
    expect(screen.queryByText(/跨源目标不支持凭据/)).toBeNull();
  });

  it("c) 生产模式 ?server= 被忽略回退同源（resolveWsUrl 注入桩 dev=false；RealApp 依赖 import.meta.env.DEV 无法在 jsdom 翻转，生产语义在 app-clients.test.ts 单元层锁定）", () => {
    // 本例锁定「组合根只经 resolveWsUrl 取 URL」这一接线事实：jsdom（dev 语义）下跨源覆盖生效，
    // 生产忽略语义见 app-clients.test.ts「B1：生产模式（dev=false）…」例。
    window.localStorage.setItem(TOKEN_STORAGE_KEY, "stored-secret");
    window.history.replaceState(null, "", "/?server=wss://collector.example.invalid/ws");
    render(React.createElement(RealApp, { createSocket: factory }));
    expect(FakeWebSocket.instances[0]!.url).toBe("wss://collector.example.invalid/ws"); // dev 生效
    act(() => FakeWebSocket.instances[0]!.open());
    expect(FakeWebSocket.instances[0]!.sentFrames()).toEqual([{ t: "hello", protocolVersion: 1, token: "" }]);
  });

  it("d) 手输 token 走同源不受影响：输入面提交后 hello 正常携带", () => {
    render(React.createElement(RealApp, { createSocket: factory }));
    fireEvent.change(screen.getByLabelText("访问令牌"), { target: { value: "typed-token" } });
    fireEvent.click(screen.getByRole("button", { name: "连接" }));
    expect(FakeWebSocket.instances).toHaveLength(3);
    expect(FakeWebSocket.instances[0]!.url).toBe(`ws://${window.location.host}/`); // 默认同源
    act(() => FakeWebSocket.instances[0]!.open());
    expect(FakeWebSocket.instances[0]!.sentFrames()).toEqual([
      { t: "hello", protocolVersion: 1, token: "typed-token" },
    ]);
  });
});
