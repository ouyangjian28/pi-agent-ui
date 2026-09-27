// @vitest-environment jsdom
// A1d app-clients 测试：resolveWsUrl 纯函数推导（同源默认/?server=覆盖/受控降级）+
// createAppClients 三件套组装（三面独立连接、hello 带 token）与统一 dispose（幂等）。
// 注入式假 socket，不起真网络；本文件不触 DOM。
import { describe, expect, it } from "vitest";
import { createAppClients, resolveWsUrl } from "../../../apps/web/src/ws/app-clients";
import type { WebSocketLike } from "../../../apps/web/src/ws/ws-client";

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];
  static reset(): void {
    FakeWebSocket.instances = [];
  }
  readyState = 0;
  readonly sent: string[] = [];
  closeCount = 0;
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
    this.closeCount++;
    this.onclose?.({ code });
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  sentFrames(): { t?: string; token?: string }[] {
    return this.sent.map((s) => JSON.parse(s) as { t?: string; token?: string });
  }
}

describe("resolveWsUrl", () => {
  it("http 页面默认同源 ws://host/", () => {
    expect(resolveWsUrl({ protocol: "http:", host: "localhost:3000" }, "")).toBe("ws://localhost:3000/");
  });
  it("https 页面默认升级为 wss://host/", () => {
    expect(resolveWsUrl({ protocol: "https:", host: "ui.example.com" }, "")).toBe("wss://ui.example.com/");
  });
  it("?server=ws://host:port 覆盖默认（dev）", () => {
    expect(resolveWsUrl({ protocol: "http:", host: "localhost:3000" }, "?server=ws://127.0.0.1:9001")).toBe(
      "ws://127.0.0.1:9001/",
    );
  });
  it("?server=wss://…带路径时保留路径", () => {
    expect(resolveWsUrl({ protocol: "https:", host: "ui.example.com" }, "?server=wss://dev.example.com:8443/ws")).toBe(
      "wss://dev.example.com:8443/ws",
    );
  });
  it("非 ws(s) scheme 的 server 值被忽略，回退同源默认", () => {
    expect(resolveWsUrl({ protocol: "https:", host: "ui.example.com" }, "?server=http://evil.example")).toBe(
      "wss://ui.example.com/",
    );
  });
  it("畸形 server 值被忽略，回退同源默认", () => {
    expect(resolveWsUrl({ protocol: "http:", host: "localhost:3000" }, "?server=not a url")).toBe(
      "ws://localhost:3000/",
    );
  });
});

describe("createAppClients", () => {
  it("建三面独立连接：三个独立 socket 实例，同一 url", () => {
    FakeWebSocket.reset();
    const clients = createAppClients({
      url: "ws://localhost:3000/",
      token: "t-1",
      createSocket: (url) => new FakeWebSocket(url),
    });
    expect(FakeWebSocket.instances).toHaveLength(3);
    expect(new Set(FakeWebSocket.instances).size).toBe(3);
    for (const ws of FakeWebSocket.instances) expect(ws.url).toBe("ws://localhost:3000/");
    clients.dispose();
  });

  it("三面各自发起握手：open 后各自发 hello（带同一 token）", () => {
    FakeWebSocket.reset();
    const clients = createAppClients({
      url: "ws://localhost:3000/",
      token: "secret-token",
      createSocket: (url) => new FakeWebSocket(url),
    });
    for (const ws of FakeWebSocket.instances) {
      expect(ws.sent).toHaveLength(0); // open 前零帧
      ws.open();
      expect(ws.sentFrames()).toEqual([{ t: "hello", protocolVersion: 1, token: "secret-token" }]);
    }
    clients.dispose();
  });

  it("dispose() 统一关闭三面连接", () => {
    FakeWebSocket.reset();
    const clients = createAppClients({
      url: "ws://localhost:3000/",
      token: "t-1",
      createSocket: (url) => new FakeWebSocket(url),
    });
    for (const ws of FakeWebSocket.instances) ws.open();
    clients.dispose();
    for (const ws of FakeWebSocket.instances) {
      expect(ws.readyState).toBe(3);
      expect(ws.closeCount).toBe(1);
    }
    expect(clients.wsClient.getSnapshot().state).toBe("closed");
    expect(clients.subscribeClient.getSnapshot().connState).toBe("closed");
    expect(clients.writeClient.getSnapshot().connState).toBe("closed");
  });

  it("dispose() 幂等：重复调用不重复关闭", () => {
    FakeWebSocket.reset();
    const clients = createAppClients({
      url: "ws://localhost:3000/",
      token: "t-1",
      createSocket: (url) => new FakeWebSocket(url),
    });
    clients.dispose();
    clients.dispose();
    for (const ws of FakeWebSocket.instances) expect(ws.closeCount).toBe(1);
  });
});
