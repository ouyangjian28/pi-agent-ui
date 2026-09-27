// @vitest-environment jsdom
// A1d app-clients 测试：resolveWsUrl 纯函数推导（同源默认/?server=覆盖（仅 dev）/受控降级）+
// B1 凭据目的地绑定（生产忽略 ?server=/isSameOriginWsTarget 同源判据/跨源零携密 hello）+
// N2 fragment 拒绝 + createAppClients 三件套组装（三面独立连接、hello 带 token）与统一 dispose（幂等）。
// 注入式假 socket，不起真网络；本文件不触 DOM。
import { describe, expect, it } from "vitest";
import { createAppClients, isSameOriginWsTarget, resolveWsUrl } from "../../../apps/web/src/ws/app-clients";
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
    expect(
      resolveWsUrl({ protocol: "http:", host: "localhost:3000" }, "?server=ws://127.0.0.1:9001", { dev: true }),
    ).toBe("ws://127.0.0.1:9001/");
  });
  it("?server=wss://…带路径时保留路径（dev）", () => {
    expect(
      resolveWsUrl({ protocol: "https:", host: "ui.example.com" }, "?server=wss://dev.example.com:8443/ws", {
        dev: true,
      }),
    ).toBe("wss://dev.example.com:8443/ws");
  });
  it("B1：生产模式（dev=false）?server= 一律忽略，回退同源——凭据目的地绑定，不容 URL 改指向", () => {
    // 跨源覆盖被忽略
    expect(
      resolveWsUrl({ protocol: "https:", host: "ui.example.com" }, "?server=wss://collector.example.invalid/ws", {
        dev: false,
      }),
    ).toBe("wss://ui.example.com/");
    // 即便覆盖值恰好同源也同样忽略（生产无 ?server= 语义）
    expect(
      resolveWsUrl({ protocol: "https:", host: "ui.example.com" }, "?server=wss://ui.example.com/ws", {
        dev: false,
      }),
    ).toBe("wss://ui.example.com/");
    expect(resolveWsUrl({ protocol: "http:", host: "localhost:3000" }, "?server=ws://127.0.0.1:9001", { dev: false })).toBe(
      "ws://localhost:3000/",
    );
  });
  it("N2：带 fragment 的 ws(s) URL 按畸形处理，回退同源", () => {
    expect(
      resolveWsUrl({ protocol: "https:", host: "ui.example.com" }, "?server=wss://dev.example.com/ws%23frag", {
        dev: true,
      }),
    ).toBe("wss://ui.example.com/");
    expect(
      resolveWsUrl({ protocol: "http:", host: "localhost:3000" }, "?server=ws://127.0.0.1:9001/ws#frag", { dev: true }),
    ).toBe("ws://localhost:3000/");
  });
  it("非 ws(s) scheme 的 server 值被忽略，回退同源默认", () => {
    expect(
      resolveWsUrl({ protocol: "https:", host: "ui.example.com" }, "?server=http://evil.example", { dev: true }),
    ).toBe("wss://ui.example.com/");
  });
  it("畸形 server 值被忽略，回退同源默认", () => {
    expect(resolveWsUrl({ protocol: "http:", host: "localhost:3000" }, "?server=not a url", { dev: true })).toBe(
      "ws://localhost:3000/",
    );
  });
});

describe("isSameOriginWsTarget（B1 凭据目的地绑定判据）", () => {
  it("http 页面 + ws://同 host:port = 同源（可信）", () => {
    expect(isSameOriginWsTarget({ protocol: "http:", host: "localhost:3000" }, "ws://localhost:3000/")).toBe(true);
    expect(isSameOriginWsTarget({ protocol: "http:", host: "localhost:3000" }, "ws://localhost:3000/ws")).toBe(true);
  });
  it("https 页面 + wss://同 host:port = 同源（可信）", () => {
    expect(isSameOriginWsTarget({ protocol: "https:", host: "ui.example.com" }, "wss://ui.example.com/")).toBe(true);
  });
  it("不同端口=跨源（不可信）", () => {
    expect(isSameOriginWsTarget({ protocol: "http:", host: "localhost:3000" }, "ws://localhost:9001/")).toBe(false);
  });
  it("不同 host=跨源（不可信）", () => {
    expect(isSameOriginWsTarget({ protocol: "https:", host: "ui.example.com" }, "wss://collector.example.invalid/ws")).toBe(
      false,
    );
  });
  it("https 页面 + ws:// = 明文降级，跨源（不可信）", () => {
    expect(isSameOriginWsTarget({ protocol: "https:", host: "ui.example.com" }, "ws://ui.example.com/")).toBe(false);
  });
  it("不可解析 URL 一律不可信", () => {
    expect(isSameOriginWsTarget({ protocol: "http:", host: "localhost:3000" }, "not a url")).toBe(false);
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

  it("B1：token 置空串时 hello 零携密（跨源目的地由组合根如此调用，服务端按未认证拒）", () => {
    FakeWebSocket.reset();
    const clients = createAppClients({
      url: "wss://collector.example.invalid/ws",
      token: "",
      createSocket: (url) => new FakeWebSocket(url),
    });
    for (const ws of FakeWebSocket.instances) {
      ws.open();
      expect(ws.sentFrames()).toEqual([{ t: "hello", protocolVersion: 1, token: "" }]);
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
