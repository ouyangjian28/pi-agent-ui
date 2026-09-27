// @vitest-environment jsdom
// A1c 写面客户端测试：注入式假 socket（不起真网络；本文件不触 DOM，docblock 为派单统一要求）。
// 覆盖矩阵：
// - 握手：open→hello（带 token）→welcome→ready；未 ready 发送=not-ready 本地拒（零帧）；
// - ack 关联：sendPrompt→prompt 帧（requestId 递增）→write-ack 同 requestId resolve（outcome 透传）；
//   sendStop→write-stop-ack（confirmed exit 透传）；prompt×stop 并行在途（file×kind 各一）；
// - 错误映射：4401 连接级（在途全拒+errorKind=auth-failed）；4402 带 requestId（kind=server+code，
//   retryable=true 不自动重发）；4404 带 requestId（在途结算+连接存活）；4405 无 requestId（连接级终局，
//   后续 close 1008 不降级）；握手期 error=连接级；
// - 本地预校验：file 越界/空文本/>64KiB（UTF-8 字节数）=local-invalid 本地拒零帧；同 file 同 kind 在途重复=
//   in-flight 本地拒（不等服务端 4404）；
// - R1 坏帧零副作用：非 JSON/未知 t/畸形 write-ack（outcome 越域/缺 requestId）/requestId 无关联/ack file 回显
//   不符=在途保留，后续合法 ack 照常结算；
// - 断开终局：serverClose→在途统一 transport 拒；close()=停止位（在途 closed 拒+幂等+迟到回调零副作用+
//   connect 永久拒绝）；快照 inflight 视图与订阅通知。
import { describe, expect, it } from "vitest";
import { WriteClient, WriteSendError, type WebSocketLike } from "../../../apps/web/src/ws/write-client";

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
  close(_code = 1000): void {
    this.readyState = 3;
    this.closeCount++;
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
const LAUNCHED = { kind: "launched", intentId: "i-1", commandId: 7 } as const;
const CONFIRMED = { kind: "confirmed", exit: { code: 0, signal: null } } as const;

function setup(token = "test-token"): { client: WriteClient; ws: FakeWebSocket } {
  FakeWebSocket.reset();
  const client = new WriteClient("ws://127.0.0.1:9001/ws", token, (url) => new FakeWebSocket(url));
  client.connect();
  const ws = FakeWebSocket.instances[0]!;
  return { client, ws };
}

/** 走完握手：open→hello→welcome→ready。 */
function ready(): { client: WriteClient; ws: FakeWebSocket } {
  const { client, ws } = setup();
  ws.open();
  ws.receive(WELCOME);
  return { client, ws };
}

/** 取第 n 个写帧的 requestId（0=prompt1）。 */
function requestIdOf(ws: FakeWebSocket, index: number): string {
  return (ws.sentFrames()[index] as { requestId: string }).requestId;
}

function rejectionOf(promise: Promise<unknown>): Promise<WriteSendError> {
  return promise.then(
    () => {
      throw new Error("expected rejection");
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(WriteSendError);
      return error as WriteSendError;
    },
  );
}

describe("A1c WriteClient：握手与发送", () => {
  it("握手：open→hello（带 token/protocolVersion）→welcome→ready；重复 welcome 幂等", () => {
    const { client, ws } = setup();
    expect(client.getSnapshot().connState).toBe("connecting");
    ws.open();
    expect(client.getSnapshot().connState).toBe("authenticating");
    expect(ws.sentFrames()[0]).toEqual({ t: "hello", protocolVersion: 1, token: "test-token" });
    ws.receive(WELCOME);
    expect(client.getSnapshot().connState).toBe("ready");
    ws.receive(WELCOME); // 重复 welcome：幂等忽略（不报错不降级）
    expect(client.getSnapshot().connState).toBe("ready");
  });

  it("未 ready 发送=not-ready 本地拒，零帧", async () => {
    const { client, ws } = setup();
    ws.open(); // authenticating（未 welcome）
    const error = await rejectionOf(client.sendPrompt("a.jsonl", "hi"));
    expect(error.kind).toBe("not-ready");
    expect(ws.sent.length).toBe(1); // 仅 hello
  });

  it("sendPrompt→prompt 帧（requestId 形如 wr-p-N）→write-ack 同 requestId resolve，outcome 透传+lastResult", async () => {
    const { client, ws } = ready();
    let settled: unknown = null;
    void client.sendPrompt("a.jsonl", "你好").then((outcome) => {
      settled = outcome;
    });
    const frames = ws.sentFrames();
    expect(frames[1]).toEqual({ t: "prompt", requestId: "wr-p-1", file: "a.jsonl", text: "你好" });
    expect(client.getSnapshot().inflight).toEqual([{ file: "a.jsonl", kind: "prompt" }]);
    ws.receive({ t: "write-ack", requestId: "wr-p-1", file: "a.jsonl", outcome: LAUNCHED });
    await Promise.resolve();
    expect(settled).toEqual(LAUNCHED);
    expect(client.getSnapshot().inflight).toEqual([]);
    expect(client.getSnapshot().lastResult).toEqual({ ok: true, kind: "prompt", file: "a.jsonl", outcome: LAUNCHED });
  });

  it("sendStop→stop 帧→write-stop-ack resolve；prompt×stop 可并行在途（file×kind 各一，requestId 分账）", async () => {
    const { client, ws } = ready();
    const promptPromise = client.sendPrompt("a.jsonl", "hi");
    const stopPromise = client.sendStop("a.jsonl");
    expect(ws.sentFrames()[1]).toMatchObject({ t: "prompt", requestId: "wr-p-1" });
    expect(ws.sentFrames()[2]).toMatchObject({ t: "stop", requestId: "wr-s-2", file: "a.jsonl" });
    expect(client.getSnapshot().inflight).toEqual([
      { file: "a.jsonl", kind: "prompt" },
      { file: "a.jsonl", kind: "stop" },
    ]);
    ws.receive({ t: "write-stop-ack", requestId: "wr-s-2", file: "a.jsonl", outcome: CONFIRMED });
    await expect(stopPromise).resolves.toEqual(CONFIRMED);
    expect(client.getSnapshot().inflight).toEqual([{ file: "a.jsonl", kind: "prompt" }]); // prompt 仍在途
    ws.receive({ t: "write-ack", requestId: "wr-p-1", file: "a.jsonl", outcome: { kind: "invalidated", stage: "sending" } });
    await expect(promptPromise).resolves.toEqual({ kind: "invalidated", stage: "sending" });
  });

  it("订阅通知：快照变更逐次通知；getSnapshot 引用稳定（未变即相等）", () => {
    const { client, ws } = ready();
    let n = 0;
    client.subscribe(() => n++);
    const before = client.getSnapshot();
    const promise = client.sendPrompt("a.jsonl", "hi");
    void promise;
    expect(n).toBe(1); // 占位即通知
    expect(client.getSnapshot()).not.toBe(before);
    const mid = client.getSnapshot();
    ws.receive({ t: "write-ack", requestId: "wr-p-1", file: "a.jsonl", outcome: LAUNCHED });
    expect(n).toBe(2); // 出表通知（lastResult 同帧合并为一次 transition）
    expect(client.getSnapshot()).not.toBe(mid);
  });
});

describe("A1c WriteClient：本地预校验（零帧本地拒）", () => {
  it("file 越界（filePattern）=local-invalid", async () => {
    const { client, ws } = ready();
    const error = await rejectionOf(client.sendPrompt("a/b.jsonl", "hi"));
    expect(error.kind).toBe("local-invalid");
    expect(error.code).toBeNull();
    expect(ws.sent.length).toBe(1); // 仅 hello，未发写帧
  });

  it("空文本=local-invalid", async () => {
    const { client } = ready();
    const error = await rejectionOf(client.sendPrompt("a.jsonl", ""));
    expect(error.kind).toBe("local-invalid");
  });

  it("文本超 64KiB（UTF-8 字节数，含多字节/代理对）=local-invalid 零帧", async () => {
    const { client, ws } = ready();
    const ascii = "a".repeat(65_537); // 65_537 ASCII 字节 > 65_536
    const error1 = await rejectionOf(client.sendPrompt("a.jsonl", ascii));
    expect(error1.kind).toBe("local-invalid");
    expect(error1.message).toContain("64KiB");
    const multibyte = "你".repeat(32_769); // 3 字节/字 → 98_307 字节
    const error2 = await rejectionOf(client.sendPrompt("a.jsonl", multibyte));
    expect(error2.kind).toBe("local-invalid");
    expect(ws.sent.length).toBe(1); // 两次均未发帧
  });

  it("恰好 64KiB 边界（65536 字节）放行：帧已发出", () => {
    const { client, ws } = ready();
    const text = "a".repeat(65_536);
    void client.sendPrompt("a.jsonl", text);
    expect(ws.sent.length).toBe(2);
  });

  it("同 file 同 kind 在途重复=in-flight 本地拒（不等服务端 4404）；他 file 同 kind 可并行", async () => {
    const { client, ws } = ready();
    void client.sendPrompt("a.jsonl", "one");
    const dup = await rejectionOf(client.sendPrompt("a.jsonl", "two"));
    expect(dup.kind).toBe("in-flight");
    expect(dup.message).toContain("发送中的消息");
    expect(ws.sent.length).toBe(2); // 第二个 prompt 未发帧（hello+第一个 prompt）
    void client.sendPrompt("b.jsonl", "three"); // 他 file：放行（file×kind 唯一）
    expect(ws.sent.length).toBe(3);
  });

  it("stop 在途重复=in-flight 本地拒（受控文案）", async () => {
    const { client, ws } = ready();
    void client.sendStop("a.jsonl");
    const dup = await rejectionOf(client.sendStop("a.jsonl"));
    expect(dup.kind).toBe("in-flight");
    expect(dup.message).toContain("停止请求已在途");
    expect(ws.sent.length).toBe(2); // 仅 hello+第一个 stop
  });
});

describe("A1c WriteClient：错误映射与不自动重试", () => {
  it("4402 带 requestId：kind=server+code 附带，文案受控（服务端 message 不透传），retryable=true 不自动重发", async () => {
    const { client, ws } = ready();
    const promise = client.sendPrompt("a.jsonl", "secret-text");
    const rid = requestIdOf(ws, 1);
    ws.receive({ t: "error", code: 4402, message: "host exploded echoing secret-text", retryable: true, requestId: rid });
    const error = await rejectionOf(promise);
    expect(error.kind).toBe("server");
    expect(error.code).toBe(4402);
    expect(error.message).not.toContain("secret-text");
    expect(error.message).toContain("4402");
    expect(client.getSnapshot().connState).toBe("ready"); // 连接存活
    expect(client.getSnapshot().lastResult).toMatchObject({ ok: false, kind: "prompt", file: "a.jsonl" });
    expect(ws.sent.length).toBe(2); // 无重发帧
  });

  it("4404 带 requestId（服务端在途重复/形状）：仅结算该请求，连接存活", async () => {
    const { client, ws } = ready();
    const promise = client.sendPrompt("a.jsonl", "hi");
    ws.receive({ t: "error", code: 4404, message: "dup", retryable: false, requestId: requestIdOf(ws, 1) });
    const error = await rejectionOf(promise);
    expect(error.kind).toBe("server");
    expect(error.code).toBe(4404);
    expect(client.getSnapshot().connState).toBe("ready");
  });

  it("4401 连接级：在途全拒+errorKind=auth-failed+终态；后续 close 不改文案", async () => {
    const { client, ws } = ready();
    const p1 = client.sendPrompt("a.jsonl", "one");
    const p2 = client.sendPrompt("b.jsonl", "two");
    ws.receive({ t: "error", code: 4401, message: "bad token", retryable: false });
    const errors = await Promise.all([rejectionOf(p1), rejectionOf(p2)]);
    for (const error of errors) expect(error.message).toContain("4401");
    const snap = client.getSnapshot();
    expect(snap.connState).toBe("error");
    expect(snap.errorKind).toBe("auth-failed");
    expect(snap.inflight).toEqual([]);
    ws.serverClose(1008); // 已终态：不降级、不重复结算
    expect(client.getSnapshot().errorMessage).toContain("4401");
  });

  it("4405 无 requestId（连接级，未开放写帧）：连接级终局，在途全拒；随后的 close 1008 不降级", async () => {
    const { client, ws } = ready();
    const promise = client.sendPrompt("a.jsonl", "hi");
    ws.receive({ t: "error", code: 4405, message: "closed", retryable: false });
    const error = await rejectionOf(promise);
    expect(error.message).toContain("4405");
    expect(client.getSnapshot().connState).toBe("error");
    expect(client.getSnapshot().errorKind).toBe("transport");
    ws.serverClose(1008);
    expect(client.getSnapshot().connState).toBe("error"); // 不降级 closed
  });

  it("握手期 error：非 4401→transport 连接级终局；4401 优先认 auth-failed", () => {
    const { client, ws } = setup();
    ws.open();
    ws.receive({ t: "error", code: 4401, message: "x", retryable: false }); // 4401 优先于握手期分支
    expect(client.getSnapshot().errorKind).toBe("auth-failed");
    const { client: c2, ws: ws2 } = setup();
    ws2.open();
    ws2.receive({ t: "error", code: 4403, message: "version", retryable: false });
    expect(c2.getSnapshot().connState).toBe("error");
    expect(c2.getSnapshot().errorKind).toBe("transport");
    void client;
  });

  it("在途重复场景修正口径：prompt 在途时同 file 的 stop 允许（并行合法流）", async () => {
    const { client, ws } = ready();
    void client.sendPrompt("a.jsonl", "one");
    const stopPromise = client.sendStop("a.jsonl"); // 不拒
    ws.receive({ t: "write-stop-ack", requestId: requestIdOf(ws, 2), file: "a.jsonl", outcome: { kind: "no-process" } });
    await expect(stopPromise).resolves.toEqual({ kind: "no-process" });
  });
});

describe("A1c WriteClient：R1 坏帧零副作用", () => {
  it("非 JSON 外壳/非对象/未知 t：安全忽略，在途保留", async () => {
    const { client, ws } = ready();
    const promise = client.sendPrompt("a.jsonl", "hi");
    const rid = requestIdOf(ws, 1);
    ws.receiveRaw("not-json{");
    ws.receiveRaw(42);
    ws.receive({ t: "sessions", sessions: [] });
    ws.receive({ t: "write-ack", requestId: rid, file: "a.jsonl", outcome: { kind: "launched", intentId: 7, commandId: 1 } }); // outcome 越域（intentId 非 string）
    ws.receive({ t: "write-ack", requestId: 1234, file: "a.jsonl", outcome: LAUNCHED }); // requestId 非法类型
    ws.receive({ t: "write-ack", requestId: "wr-p-99", file: "a.jsonl", outcome: LAUNCHED }); // 无关联在途
    expect(client.getSnapshot().inflight).toEqual([{ file: "a.jsonl", kind: "prompt" }]); // 零消费
    ws.receive({ t: "write-ack", requestId: rid, file: "a.jsonl", outcome: LAUNCHED }); // 合法 ack 照常结算
    await expect(promise).resolves.toEqual(LAUNCHED);
  });

  it("write-ack 的 file 回显与在途不符=零消费（在途保留，等合法结算）；畸形 error 帧（未知码）忽略", async () => {
    const { client, ws } = ready();
    const promise = client.sendPrompt("a.jsonl", "hi");
    const rid = requestIdOf(ws, 1);
    ws.receive({ t: "write-ack", requestId: rid, file: "OTHER.jsonl", outcome: LAUNCHED });
    expect(client.getSnapshot().inflight).toEqual([{ file: "a.jsonl", kind: "prompt" }]);
    ws.receive({ t: "error", code: 4999, message: "?", retryable: false, requestId: rid }); // 未登记码=畸形
    expect(client.getSnapshot().inflight).toEqual([{ file: "a.jsonl", kind: "prompt" }]);
    ws.receive({ t: "write-ack", requestId: rid, file: "a.jsonl", outcome: { kind: "no-process" } });
    await expect(promise).resolves.toEqual({ kind: "no-process" });
  });
});

describe("A1c WriteClient：断开与关闭", () => {
  it("serverClose：在途统一 transport 拒（受控文案）+connState=closed；无自动重连", async () => {
    const { client, ws } = ready();
    const p1 = client.sendPrompt("a.jsonl", "one");
    const p2 = client.sendStop("b.jsonl");
    ws.serverClose(1006);
    const errors = await Promise.all([rejectionOf(p1), rejectionOf(p2)]);
    for (const error of errors) {
      expect(error.kind).toBe("transport");
      expect(error.message).toContain("连接已断开");
    }
    expect(client.getSnapshot().connState).toBe("closed");
    expect(client.getSnapshot().inflight).toEqual([]);
  });

  it("close()=不可逆停止位：在途 closed 拒；幂等；connect 拒绝；迟到帧零副作用", async () => {
    const { client, ws } = ready();
    const promise = client.sendPrompt("a.jsonl", "hi");
    client.close();
    const error = await rejectionOf(promise);
    expect(error.kind).toBe("closed");
    expect(client.getSnapshot().connState).toBe("closed");
    client.close(); // 幂等
    expect(ws.closeCount).toBe(1);
    client.connect(); // 停止位后拒绝（无新连接）
    expect(FakeWebSocket.instances.length).toBe(1);
    ws.receive({ t: "write-ack", requestId: "wr-p-1", file: "a.jsonl", outcome: LAUNCHED }); // 迟到帧零副作用
    expect(client.getSnapshot().inflight).toEqual([]);
  });

  it("握手期 serverClose(1008)=auth-failed", () => {
    const { client, ws } = setup();
    ws.open();
    ws.serverClose(1008);
    expect(client.getSnapshot().connState).toBe("error");
    expect(client.getSnapshot().errorKind).toBe("auth-failed");
  });
});
