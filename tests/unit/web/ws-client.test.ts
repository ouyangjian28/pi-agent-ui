// A1a WS 客户端测试：FakeWebSocket 模式（注入式假 socket，不依赖真 ws 库/真网络）。
// 覆盖：握手成功（hello 带 token→welcome→list-sessions）/握手 4401 两形态/sessions 列表更新/
// 连接关闭终态/未知帧（含写类 ack）与畸形数据安全忽略。
import { describe, expect, it } from "vitest";
import { WsClient, type WebSocketLike } from "../../../apps/web/src/ws/ws-client";

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];
  static reset(): void {
    FakeWebSocket.instances = [];
  }
  readyState = 0; // CONNECTING
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
  // ---- 测试驱动面（模拟服务端行为） ----
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  receiveRaw(data: unknown): void {
    this.onmessage?.({ data });
  }
  serverClose(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  sentFrames(): unknown[] {
    return this.sent.map((s) => JSON.parse(s) as unknown);
  }
}

const WELCOME = { t: "welcome", serverBootId: "boot-1", serverBuildId: "build-test", protocolVersion: 1 } as const;

function setup(token = "test-token"): { client: WsClient; ws: FakeWebSocket } {
  FakeWebSocket.reset();
  const client = new WsClient("ws://127.0.0.1:9001/ws", token, (url) => new FakeWebSocket(url));
  client.connect();
  const ws = FakeWebSocket.instances[0]!;
  return { client, ws };
}

/** 走完握手：open→hello→welcome→ready→list-sessions 已发。 */
function handshake(ws: FakeWebSocket): void {
  ws.open();
  ws.receive(WELCOME);
}

describe("WsClient 握手与状态机", () => {
  it("open 后发 hello（带 token），welcome 后转 ready 并自动发 list-sessions，状态迁移可订阅", () => {
    const { client, ws } = setup("secret-token");
    const states: string[] = [];
    client.subscribe(() => states.push(client.getSnapshot().state));
    expect(client.getSnapshot().state).toBe("connecting");
    ws.open();
    expect(client.getSnapshot().state).toBe("authenticating");
    expect(ws.sentFrames()[0]).toEqual({ t: "hello", protocolVersion: 1, token: "secret-token" });
    expect(ws.sent).toHaveLength(1); // welcome 前不得发任何非 hello 帧
    ws.receive(WELCOME);
    expect(client.getSnapshot().state).toBe("ready");
    const list = ws.sentFrames()[1] as { t: string; requestId: string };
    expect(list.t).toBe("list-sessions");
    expect(list.requestId).toMatch(/^[\w-]{1,64}$/);
    expect(ws.sent).toHaveLength(2); // 全连接期只发过 hello+list-sessions
    expect(states).toEqual(["authenticating", "ready"]);
  });

  it("握手期收到 error 4401→auth-failed；随后 1008 关闭不降级为 closed", () => {
    const { client, ws } = setup("bad-token");
    ws.open();
    ws.receive({ t: "error", code: 4401, message: "未认证或令牌无效", retryable: false });
    expect(client.getSnapshot().state).toBe("error");
    expect(client.getSnapshot().errorKind).toBe("auth-failed");
    expect(client.getSnapshot().errorMessage).toBe("未认证或令牌无效");
    ws.serverClose(1008);
    expect(client.getSnapshot().state).toBe("error"); // 保留更具体的 auth-failed，不降级
    expect(client.getSnapshot().errorKind).toBe("auth-failed");
  });

  it("authenticating 期无 error 帧直接 1008 关闭→auth-failed（§5.3：4401 走 close 1008）", () => {
    const { client, ws } = setup("bad-token");
    ws.open();
    ws.serverClose(1008);
    expect(client.getSnapshot().state).toBe("error");
    expect(client.getSnapshot().errorKind).toBe("auth-failed");
  });

  it("收到与请求关联的 sessions 帧→列表落地并通知订阅者；requestId 不符的帧忽略", () => {
    const { client, ws } = setup();
    handshake(ws);
    const listReq = ws.sentFrames()[1] as { requestId: string };
    let notified = 0;
    client.subscribe(() => notified++);
    ws.receive({
      t: "sessions",
      requestId: "someone-else",
      sessions: [],
      total: 0,
      offset: 0,
      hasMore: false,
      listVersion: 9,
      listReliability: "full",
    });
    expect(client.getSnapshot().sessions).toBeNull();
    expect(notified).toBe(0);
    const dto = {
      sessionId: "s-1",
      file: "a.jsonl",
      title: { text: "搭建会话工作台", truncated: false },
      lastActiveMs: 1_730_000_000_000,
      entryCount: 12,
      sizeBytes: 3456,
      hasRecoveryNotice: false,
      listReliability: "full",
    };
    ws.receive({
      t: "sessions",
      requestId: listReq.requestId,
      sessions: [dto],
      total: 1,
      offset: 0,
      hasMore: false,
      listVersion: 3,
      listReliability: "full",
    });
    const snap = client.getSnapshot();
    expect(snap.sessions).toHaveLength(1);
    expect(snap.sessions![0]!.title.text).toBe("搭建会话工作台");
    expect(snap.total).toBe(1);
    expect(snap.listVersion).toBe(3);
    expect(notified).toBe(1);
  });

  it("ready 后服务端关闭→closed 终态；终态后帧不再改变快照；主动 close 同入 closed", () => {
    const { client, ws } = setup();
    handshake(ws);
    ws.serverClose(1000);
    const closed = client.getSnapshot();
    expect(closed.state).toBe("closed");
    ws.receive({ t: "pong", nonce: "n" }); // 终态后任何帧不落地
    expect(client.getSnapshot()).toBe(closed);

    const again = setup();
    handshake(again.ws);
    again.client.close();
    expect(again.client.getSnapshot().state).toBe("closed");
  });

  it("未知帧类型（含写类 ack）与畸形数据一律安全忽略，不抛错不变更快照", () => {
    const { client, ws } = setup();
    handshake(ws);
    const before = client.getSnapshot();
    expect(() => {
      ws.receive({ t: "write-ack", requestId: "w1", file: "a.jsonl", outcome: { kind: "busy" } });
      ws.receive({ t: "write-stop-ack", requestId: "w2", file: "a.jsonl", outcome: { kind: "no-process" } });
      ws.receive({ t: "totally-unknown-frame", x: 1 });
      ws.receive({ t: "events", subscriptionId: "sub1", origin: "live", liveSeq: 1, refSeq: null, events: [] });
      ws.receive({ t: "pong", nonce: "n" });
      ws.receive({ t: "error", code: 4409, message: "无关联请求的游标错误", retryable: true, requestId: "nobody" });
      ws.receiveRaw("not json at all");
      ws.receiveRaw(JSON.stringify([1, 2, 3]));
      ws.receiveRaw(JSON.stringify(null));
      ws.receiveRaw(new ArrayBuffer(4)); // 二进制非本面
    }).not.toThrow();
    expect(client.getSnapshot()).toBe(before); // 引用相等=无变更无通知
    expect(client.getSnapshot().state).toBe("ready");
  });
});
