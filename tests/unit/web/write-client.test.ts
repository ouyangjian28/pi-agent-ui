// @vitest-environment jsdom
// A1c 写面客户端测试（归属整改重写：本文件由 Kimi 亲手重写；注入式假 socket，不起真网络）。
// 组织口径=派单六条保真锚点，逐条落断言：
//  G1 requestId 关联：ack/stop-ack/error 只归当次请求；错配帧不误伤（含旧请求迟到 ack）；
//  G2 64KiB 预校验+(file×kind) 在途本地拒：超限/在途拒不发帧、有受控错误面；
//  G3 writeFaceErrorText 受控文案映射；断开统一 reject 存活 pending；4402 不自动重发；
//  G4 close() 不可逆（后继调用幂等，pending 全拒）；
//  G5 writeViewOf 纯派生+lastResult file 身份门（跨 file 不误报）；
//  G6 composer 双挂点行为（发送中禁用/状态呈现/stop 交互；真客户端+真 hook+真组件链）。
// 另锁：R1 坏帧零副作用（畸形帧不消费在途）、K5-C2 socket.send 同步抛错受控结算、
// 订阅通知语义（一次结算=一次通知、getSnapshot 引用稳定）。

import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WriteClient, WriteSendError, type WebSocketLike } from "../../../apps/web/src/ws/write-client";
import { writeViewOf } from "../../../apps/web/src/ws/use-write";
import { WriteComposer } from "../../../apps/web/src/components/write-composer";

afterEach(cleanup);

// ---------------------------------------------------------------------------
// 造假面：注入式假 socket（模拟服务端行为的驱动方法单列）
// ---------------------------------------------------------------------------

class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  static reset(): void {
    FakeSocket.instances = [];
  }
  readyState = 0;
  readonly sent: string[] = [];
  closeCount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: { readonly code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(_code = 1000): void {
    this.readyState = 3;
    this.closeCount++;
  }
  // ---- 测试驱动面（模拟服务端/传输行为） ----
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
  frames(): unknown[] {
    return this.sent.map((s) => JSON.parse(s) as unknown);
  }
}

const WELCOME = { t: "welcome", serverBootId: "boot-1", serverBuildId: "build-test", protocolVersion: 1 } as const;
const LAUNCHED = { kind: "launched", intentId: "i-1", commandId: 7 } as const;
const STOP_CONFIRMED = { kind: "confirmed", exit: { code: 0, signal: null } } as const;

function setup(token = "test-token"): { client: WriteClient; ws: FakeSocket } {
  FakeSocket.reset();
  const client = new WriteClient("ws://127.0.0.1:9001/ws", token, (url) => new FakeSocket(url));
  client.connect();
  const ws = FakeSocket.instances[0]!;
  return { client, ws };
}

/** 走完握手：open→hello→welcome→ready。 */
function ready(): { client: WriteClient; ws: FakeSocket } {
  const { client, ws } = setup();
  ws.open();
  ws.receive(WELCOME);
  return { client, ws };
}

/** 取第 n 个已发帧的 requestId。 */
function sentRequestId(ws: FakeSocket, index: number): string {
  return (ws.frames()[index] as { requestId: string }).requestId;
}

/** 断言 promise 以 WriteSendError 拒绝并取出之。 */
function expectWriteError(promise: Promise<unknown>): Promise<WriteSendError> {
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

// ---------------------------------------------------------------------------
// 握手与连接生命周期
// ---------------------------------------------------------------------------

describe("握手与连接生命周期", () => {
  it("open→hello（带 token/protocolVersion）→welcome→ready；重复 welcome 幂等忽略", () => {
    const { client, ws } = setup();
    expect(client.getSnapshot().connState).toBe("connecting");
    ws.open();
    expect(client.getSnapshot().connState).toBe("authenticating");
    expect(ws.frames()[0]).toEqual({ t: "hello", protocolVersion: 1, token: "test-token" });
    ws.receive(WELCOME);
    expect(client.getSnapshot().connState).toBe("ready");
    ws.receive(WELCOME); // 重复 welcome：幂等忽略（不报错不降级）
    expect(client.getSnapshot().connState).toBe("ready");
  });

  it("welcome 形状门：缺字段/版本不符不得算握手成功（滞留 authenticating，后续合法 welcome 仍可完成）", () => {
    const { client, ws } = setup();
    ws.open();
    ws.receive({ t: "welcome", serverBootId: "b", serverBuildId: "s", protocolVersion: 2 }); // 版本不符
    ws.receive({ t: "welcome", serverBootId: "b", protocolVersion: 1 }); // 缺 serverBuildId
    expect(client.getSnapshot().connState).toBe("authenticating");
    ws.receive(WELCOME); // 合法 welcome 照常完成握手
    expect(client.getSnapshot().connState).toBe("ready");
  });

  it("未 ready 发送=not-ready 本地拒（零写帧，仅 hello）", async () => {
    const { client, ws } = setup();
    ws.open(); // authenticating（未 welcome）
    const error = await expectWriteError(client.sendPrompt("a.jsonl", "hi"));
    expect(error.kind).toBe("not-ready");
    expect(ws.sent.length).toBe(1); // 仅 hello
  });

  it("createSocket 同步抛错：连接级 transport 失败+停止位（connect 永久拒绝）", () => {
    FakeSocket.reset();
    const client = new WriteClient("ws://x/ws", "t", () => {
      throw new Error("no socket");
    });
    client.connect();
    const snap = client.getSnapshot();
    expect(snap.connState).toBe("error");
    expect(snap.errorKind).toBe("transport");
    client.connect(); // 停止位后拒绝
    expect(FakeSocket.instances.length).toBe(0);
  });

  it("订阅语义：快照变更逐次通知；getSnapshot 引用稳定（未变即相等）", () => {
    const { client, ws } = ready();
    let notified = 0;
    client.subscribe(() => notified++);
    const before = client.getSnapshot();
    void client.sendPrompt("a.jsonl", "hi");
    expect(notified).toBe(1); // 占位即通知
    expect(client.getSnapshot()).not.toBe(before);
    const mid = client.getSnapshot();
    expect(client.getSnapshot()).toBe(mid); // 无变更即引用相等
    ws.receive({ t: "write-ack", requestId: "wr-p-1", file: "a.jsonl", outcome: LAUNCHED });
    expect(notified).toBe(2); // 出表+lastResult 合并为一次通知
    expect(client.getSnapshot()).not.toBe(mid);
  });
});

// ---------------------------------------------------------------------------
// G1：requestId 关联（ack/stop-ack/error 只归当次请求；错配帧不误伤）
// ---------------------------------------------------------------------------

describe("G1 requestId 关联", () => {
  it("sendPrompt→prompt 帧（requestId 形如 wr-p-N）→write-ack 同 requestId resolve，outcome 透传+lastResult", async () => {
    const { client, ws } = ready();
    let settled: unknown = null;
    void client.sendPrompt("a.jsonl", "你好").then((outcome) => {
      settled = outcome;
    });
    expect(ws.frames()[1]).toEqual({ t: "prompt", requestId: "wr-p-1", file: "a.jsonl", text: "你好" });
    expect(client.getSnapshot().inflight).toEqual([{ file: "a.jsonl", kind: "prompt" }]);
    ws.receive({ t: "write-ack", requestId: "wr-p-1", file: "a.jsonl", outcome: LAUNCHED });
    await Promise.resolve();
    expect(settled).toEqual(LAUNCHED);
    expect(client.getSnapshot().inflight).toEqual([]);
    expect(client.getSnapshot().lastResult).toEqual({ ok: true, kind: "prompt", file: "a.jsonl", outcome: LAUNCHED });
  });

  it("sendStop→stop 帧→write-stop-ack resolve；prompt×stop 并行在途（file×kind 各一，requestId 分账）", async () => {
    const { client, ws } = ready();
    const promptPromise = client.sendPrompt("a.jsonl", "hi");
    const stopPromise = client.sendStop("a.jsonl");
    expect(ws.frames()[1]).toMatchObject({ t: "prompt", requestId: "wr-p-1" });
    expect(ws.frames()[2]).toMatchObject({ t: "stop", requestId: "wr-s-2", file: "a.jsonl" });
    expect(client.getSnapshot().inflight).toEqual([
      { file: "a.jsonl", kind: "prompt" },
      { file: "a.jsonl", kind: "stop" },
    ]);
    ws.receive({ t: "write-stop-ack", requestId: "wr-s-2", file: "a.jsonl", outcome: STOP_CONFIRMED });
    await expect(stopPromise).resolves.toEqual(STOP_CONFIRMED);
    expect(client.getSnapshot().inflight).toEqual([{ file: "a.jsonl", kind: "prompt" }]); // prompt 仍在途
    ws.receive({
      t: "write-ack",
      requestId: "wr-p-1",
      file: "a.jsonl",
      outcome: { kind: "invalidated", stage: "sending" },
    });
    await expect(promptPromise).resolves.toEqual({ kind: "invalidated", stage: "sending" });
  });

  it("旧请求迟到 ack 不误伤：A 已结算后重投 A 的 ack，B 在途保留且随后照常结算", async () => {
    const { client, ws } = ready();
    const a = client.sendPrompt("a.jsonl", "one");
    ws.receive({ t: "write-ack", requestId: "wr-p-1", file: "a.jsonl", outcome: LAUNCHED });
    await expect(a).resolves.toEqual(LAUNCHED);
    const b = client.sendPrompt("a.jsonl", "two"); // wr-p-2
    ws.receive({ t: "write-ack", requestId: "wr-p-1", file: "a.jsonl", outcome: { kind: "busy" } }); // 旧请求重复/迟到 ack
    expect(client.getSnapshot().inflight).toEqual([{ file: "a.jsonl", kind: "prompt" }]); // B 零误伤
    expect(client.getSnapshot().lastResult).toEqual({ ok: true, kind: "prompt", file: "a.jsonl", outcome: LAUNCHED }); // 不被旧 ack 覆盖
    ws.receive({ t: "write-ack", requestId: "wr-p-2", file: "a.jsonl", outcome: { kind: "no-process" } });
    await expect(b).resolves.toEqual({ kind: "no-process" });
  });

  it("ack 三重交叉验证：requestId 匹配但 file 回显不符=零消费（在途保留，等合法结算）", async () => {
    const { client, ws } = ready();
    const promise = client.sendPrompt("a.jsonl", "hi");
    ws.receive({ t: "write-ack", requestId: sentRequestId(ws, 1), file: "OTHER.jsonl", outcome: LAUNCHED });
    expect(client.getSnapshot().inflight).toEqual([{ file: "a.jsonl", kind: "prompt" }]);
    ws.receive({ t: "write-ack", requestId: sentRequestId(ws, 1), file: "a.jsonl", outcome: { kind: "no-process" } });
    await expect(promise).resolves.toEqual({ kind: "no-process" });
  });

  it("requestId 匹配但 kind 错配（stop-ack 冒名 prompt 请求）=零消费", async () => {
    const { client, ws } = ready();
    const promise = client.sendPrompt("a.jsonl", "hi");
    ws.receive({
      t: "write-stop-ack",
      requestId: sentRequestId(ws, 1),
      file: "a.jsonl",
      outcome: { kind: "no-process" },
    });
    expect(client.getSnapshot().inflight).toEqual([{ file: "a.jsonl", kind: "prompt" }]); // 不被错 kind 消费
    ws.receive({ t: "write-ack", requestId: sentRequestId(ws, 1), file: "a.jsonl", outcome: LAUNCHED });
    await expect(promise).resolves.toEqual(LAUNCHED);
  });

  // A1c-r1-B1 修复：恢复旧基线「合法 write-stop-ack outcome no-process 正向结算」防线——
  // 重写后 no-process 仅出现在错 kind 负例中（解析器拒绝也能过），M4 变异（isStopOutcome 判
  // no-process 非法）实证 42 例全绿=正例缺失；本例以 stop 自身 requestId 合法结算补齐，
  // 与上方错 kind 负例分例保留（不合并为会提前抛断言的单一路径）。
  it("合法 write-stop-ack no-process 正向结算：stop 以自身 requestId 结算，prompt 在途零误伤", async () => {
    const { client, ws } = ready();
    const promptPromise = client.sendPrompt("a.jsonl", "hi");
    const stopPromise = client.sendStop("a.jsonl");
    expect(ws.frames()[1]).toMatchObject({ t: "prompt", requestId: "wr-p-1" });
    expect(ws.frames()[2]).toMatchObject({ t: "stop", requestId: "wr-s-2", file: "a.jsonl" });
    // no-process=服务端无在跑进程可停，是 stop 的合法 outcome（非错误路径，须正常 resolve）
    ws.receive({ t: "write-stop-ack", requestId: "wr-s-2", file: "a.jsonl", outcome: { kind: "no-process" } });
    await expect(stopPromise).resolves.toEqual({ kind: "no-process" });
    expect(client.getSnapshot().inflight).toEqual([{ file: "a.jsonl", kind: "prompt" }]); // stop 出账，prompt 仍在途
    expect(client.getSnapshot().lastResult).toEqual({
      ok: true,
      kind: "stop",
      file: "a.jsonl",
      outcome: { kind: "no-process" },
    });
    ws.receive({ t: "write-ack", requestId: "wr-p-1", file: "a.jsonl", outcome: LAUNCHED }); // 结算 prompt，避免悬挂
    await expect(promptPromise).resolves.toEqual(LAUNCHED);
    expect(client.getSnapshot().inflight).toEqual([]);
  });

  it("error 带 requestId 只结算该请求：其余在途存活，连接保持 ready", async () => {
    const { client, ws } = ready();
    const a = client.sendPrompt("a.jsonl", "one");
    const b = client.sendPrompt("b.jsonl", "two");
    ws.receive({ t: "error", code: 4404, message: "dup", retryable: false, requestId: sentRequestId(ws, 1) });
    const error = await expectWriteError(a);
    expect(error.kind).toBe("server");
    expect(error.code).toBe(4404);
    expect(client.getSnapshot().connState).toBe("ready"); // 连接存活
    expect(client.getSnapshot().inflight).toEqual([{ file: "b.jsonl", kind: "prompt" }]); // B 存活
    ws.receive({ t: "write-ack", requestId: sentRequestId(ws, 2), file: "b.jsonl", outcome: LAUNCHED });
    await expect(b).resolves.toEqual(LAUNCHED); // B 照常结算
  });

  it("无关联 requestId 的 ack/error 安全忽略（在途零消费）", async () => {
    const { client, ws } = ready();
    const promise = client.sendPrompt("a.jsonl", "hi");
    ws.receive({ t: "write-ack", requestId: "wr-p-99", file: "a.jsonl", outcome: LAUNCHED });
    ws.receive({ t: "error", code: 4402, message: "x", retryable: false, requestId: "wr-p-99" });
    expect(client.getSnapshot().inflight).toEqual([{ file: "a.jsonl", kind: "prompt" }]);
    ws.receive({ t: "write-ack", requestId: sentRequestId(ws, 1), file: "a.jsonl", outcome: LAUNCHED });
    await expect(promise).resolves.toEqual(LAUNCHED);
  });
});

// ---------------------------------------------------------------------------
// G2：64KiB 预校验（TextEncoder 口径）+(file×kind) 在途本地拒
// ---------------------------------------------------------------------------

describe("G2 本地预校验（零帧本地拒）", () => {
  it("file 越界（filePattern）=local-invalid（零帧）", async () => {
    const { client, ws } = ready();
    const error = await expectWriteError(client.sendPrompt("a/b.jsonl", "hi"));
    expect(error.kind).toBe("local-invalid");
    expect(error.code).toBeNull();
    expect(ws.sent.length).toBe(1); // 仅 hello
  });

  it("空文本=local-invalid（零帧）", async () => {
    const { client, ws } = ready();
    const error = await expectWriteError(client.sendPrompt("a.jsonl", ""));
    expect(error.kind).toBe("local-invalid");
    expect(ws.sent.length).toBe(1);
  });

  it("文本超 64KiB（ASCII 65537 字节/多字节 98307 字节）=local-invalid 零帧+受控文案含 64KiB", async () => {
    const { client, ws } = ready();
    const error1 = await expectWriteError(client.sendPrompt("a.jsonl", "a".repeat(65_537)));
    expect(error1.kind).toBe("local-invalid");
    expect(error1.message).toContain("64KiB");
    const error2 = await expectWriteError(client.sendPrompt("a.jsonl", "你".repeat(32_769))); // 3 字节/字
    expect(error2.kind).toBe("local-invalid");
    expect(ws.sent.length).toBe(1); // 两次均未发帧
  });

  it("恰好 64KiB 边界（65536 字节）放行：帧已发出", () => {
    const { client, ws } = ready();
    void client.sendPrompt("a.jsonl", "a".repeat(65_536));
    expect(ws.sent.length).toBe(2);
  });

  it("合法 emoji 代理对边界：恰 65536 字节（16384 个😀）放行；+1 字节零帧本地拒（TextEncoder 口径）", async () => {
    const { client, ws } = ready();
    void client.sendPrompt("a.jsonl", "😀".repeat(16_384)); // 16384×4=65536
    expect(ws.sent.length).toBe(2); // 放行
    const error = await expectWriteError(client.sendPrompt("a.jsonl", "😀".repeat(16_384) + "a")); // 65537
    expect(error.kind).toBe("local-invalid");
    expect(ws.sent.length).toBe(2); // 零帧
  });

  it("孤立高代理项按 U+FFFD 实际 3 字节计：32768 个高代理项=98304 字节→零帧本地拒", async () => {
    const { client, ws } = ready();
    // "\ud800\ud800" 16384 组：手写旧算法误计 16384 对×4=65536 放行；TextEncoder=32768 个 U+FFFD×3=98304
    const error = await expectWriteError(client.sendPrompt("a.jsonl", "\ud800\ud800".repeat(16_384)));
    expect(error.kind).toBe("local-invalid");
    expect(error.message).toContain("64KiB");
    expect(ws.sent.length).toBe(1); // 零帧（仅 hello）
  });

  it("孤立低代理项同口径 3 字节：21845 个=65535 放行；21846 个=65538 拒", async () => {
    const { client, ws } = ready();
    void client.sendPrompt("a.jsonl", "\udc00".repeat(21_845)); // 65535≤65536
    expect(ws.sent.length).toBe(2);
    const error = await expectWriteError(client.sendPrompt("a.jsonl", "\udc00".repeat(21_846))); // 65538>65536
    expect(error.kind).toBe("local-invalid");
    expect(ws.sent.length).toBe(2);
  });

  it("混合文本边界：16383😀+1 孤立高代理项+1a=恰 65536 放行；+1a=65537 零帧拒", async () => {
    const { client, ws } = ready();
    const boundary = "😀".repeat(16_383) + "\ud800" + "a"; // 65532+3+1=65536
    void client.sendPrompt("a.jsonl", boundary);
    expect(ws.sent.length).toBe(2);
    const error = await expectWriteError(client.sendPrompt("a.jsonl", boundary + "a")); // 65537
    expect(error.kind).toBe("local-invalid");
    expect(ws.sent.length).toBe(2);
  });

  it("同 file 同 kind 在途重复=in-flight 本地拒（零帧，不等服务端 4404）；他 file 同 kind 可并行", async () => {
    const { client, ws } = ready();
    void client.sendPrompt("a.jsonl", "one");
    const dup = await expectWriteError(client.sendPrompt("a.jsonl", "two"));
    expect(dup.kind).toBe("in-flight");
    expect(dup.message).toContain("发送中的消息");
    expect(ws.sent.length).toBe(2); // 第二个 prompt 未发帧（hello+第一个 prompt）
    void client.sendPrompt("b.jsonl", "three"); // 他 file：放行（file×kind 唯一）
    expect(ws.sent.length).toBe(3);
  });

  it("stop 在途重复=in-flight 本地拒（受控文案）；prompt 在途时同 file 的 stop 允许（并行合法流）", async () => {
    const { client, ws } = ready();
    void client.sendStop("a.jsonl");
    const dup = await expectWriteError(client.sendStop("a.jsonl"));
    expect(dup.kind).toBe("in-flight");
    expect(dup.message).toContain("停止请求已在途");
    expect(ws.sent.length).toBe(2); // 仅 hello+第一个 stop
    void client.sendPrompt("a.jsonl", "hi"); // stop 在途不挡 prompt（kind 分账）
    expect(ws.sent.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// G3：writeFaceErrorText 受控文案 / 断开统一 reject / 4402 不自动重发
// ---------------------------------------------------------------------------

describe("G3 受控文案与错误路由", () => {
  it("4402 带 requestId：kind=server+code 附带，文案受控（服务端 message 回显不透传），retryable=true 不自动重发", async () => {
    const { client, ws } = ready();
    const promise = client.sendPrompt("a.jsonl", "secret-text");
    ws.receive({
      t: "error",
      code: 4402,
      message: "host exploded echoing secret-text",
      retryable: true,
      requestId: sentRequestId(ws, 1),
    });
    const error = await expectWriteError(promise);
    expect(error.kind).toBe("server");
    expect(error.code).toBe(4402);
    expect(error.message).not.toContain("secret-text"); // 远端自由文本不透传
    expect(error.message).toContain("4402"); // 受控文案内嵌 code
    expect(client.getSnapshot().connState).toBe("ready"); // 连接存活
    expect(client.getSnapshot().lastResult).toMatchObject({ ok: false, kind: "prompt", file: "a.jsonl" });
    expect(ws.sent.length).toBe(2); // 无重发帧
  });

  it("4401 连接级：在途全拒（4401 受控文案）+errorKind=auth-failed+终态；后续 close 1008 不降级", async () => {
    const { client, ws } = ready();
    const p1 = client.sendPrompt("a.jsonl", "one");
    const p2 = client.sendPrompt("b.jsonl", "two");
    ws.receive({ t: "error", code: 4401, message: "bad token", retryable: false });
    const errors = await Promise.all([expectWriteError(p1), expectWriteError(p2)]);
    for (const error of errors) {
      expect(error.kind).toBe("transport");
      expect(error.message).toContain("4401");
    }
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
    const error = await expectWriteError(promise);
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
  });

  it('4432 心跳终局 requestId:""（现役网关空串信封惯例）→连接级失败+在途全拒+受控文案', async () => {
    const { client, ws } = ready();
    const promise = client.sendPrompt("a.jsonl", "hi");
    ws.receive({ t: "error", code: 4432, message: "heartbeat deadline", retryable: false, requestId: "" });
    const error = await expectWriteError(promise);
    expect(error.kind).toBe("transport");
    expect(error.message).toContain("4432");
    const snap = client.getSnapshot();
    expect(snap.connState).toBe("error");
    expect(snap.errorKind).toBe("transport");
    expect(snap.inflight).toEqual([]);
  });

  it("非空陌生 requestId 的连接级码（4403）不升格：连接存活、在途保留、后续合法 ack 照常结算", async () => {
    const { client, ws } = ready();
    const promise = client.sendPrompt("a.jsonl", "hi");
    ws.receive({ t: "error", code: 4403, message: "version", retryable: false, requestId: "wr-p-999" }); // 陌生 id
    expect(client.getSnapshot().connState).toBe("ready"); // 不升格连接错误
    ws.receive({ t: "write-ack", requestId: sentRequestId(ws, 1), file: "a.jsonl", outcome: LAUNCHED });
    await expect(promise).resolves.toEqual(LAUNCHED); // 原在途照常结算
  });

  it("畸形 error 帧（未登记码/缺 message/requestId 非 string）整帧忽略，在途零消费", async () => {
    const { client, ws } = ready();
    const promise = client.sendPrompt("a.jsonl", "hi");
    ws.receive({ t: "error", code: 4999, message: "?", retryable: false, requestId: sentRequestId(ws, 1) }); // 未登记码
    ws.receive({ t: "error", code: 4402, retryable: false, requestId: sentRequestId(ws, 1) }); // 缺 message
    ws.receive({ t: "error", code: 4402, message: "x", retryable: false, requestId: 123 }); // requestId 非 string
    expect(client.getSnapshot().inflight).toEqual([{ file: "a.jsonl", kind: "prompt" }]);
    ws.receive({ t: "write-ack", requestId: sentRequestId(ws, 1), file: "a.jsonl", outcome: LAUNCHED });
    await expect(promise).resolves.toEqual(LAUNCHED);
  });

  it("R1 坏帧零副作用：非 JSON/非对象/未知 t/畸形 write-ack 均安全忽略，后续合法 ack 照常结算", async () => {
    const { client, ws } = ready();
    const promise = client.sendPrompt("a.jsonl", "hi");
    const rid = sentRequestId(ws, 1);
    ws.receiveRaw("not-json{");
    ws.receiveRaw(42);
    ws.receive({ t: "sessions", sessions: [] }); // 订阅面帧非本面
    ws.receive({
      t: "write-ack",
      requestId: rid,
      file: "a.jsonl",
      outcome: { kind: "launched", intentId: 7, commandId: 1 },
    }); // outcome 越域（intentId 非 string）
    ws.receive({ t: "write-ack", requestId: 1234, file: "a.jsonl", outcome: LAUNCHED }); // requestId 非法类型
    expect(client.getSnapshot().inflight).toEqual([{ file: "a.jsonl", kind: "prompt" }]); // 零消费
    ws.receive({ t: "write-ack", requestId: rid, file: "a.jsonl", outcome: LAUNCHED });
    await expect(promise).resolves.toEqual(LAUNCHED);
  });

  it("outcome DTO 形状门：stop-ack 的 confirmed.exit 越域=零消费；合法 outcome 照常结算", async () => {
    const { client, ws } = ready();
    const promise = client.sendStop("a.jsonl");
    ws.receive({
      t: "write-stop-ack",
      requestId: sentRequestId(ws, 1),
      file: "a.jsonl",
      outcome: { kind: "confirmed", exit: { code: -1, signal: null } },
    }); // code 负数越域
    expect(client.getSnapshot().inflight).toEqual([{ file: "a.jsonl", kind: "stop" }]);
    ws.receive({ t: "write-stop-ack", requestId: sentRequestId(ws, 1), file: "a.jsonl", outcome: STOP_CONFIRMED });
    await expect(promise).resolves.toEqual(STOP_CONFIRMED);
  });
});

// ---------------------------------------------------------------------------
// G4：close() 不可逆 + 断开统一 reject
// ---------------------------------------------------------------------------

describe("G4 断开与关闭", () => {
  it("serverClose：在途统一 transport 拒（受控文案）+connState=closed；无自动重连", async () => {
    const { client, ws } = ready();
    const p1 = client.sendPrompt("a.jsonl", "one");
    const p2 = client.sendStop("b.jsonl");
    ws.serverClose(1006);
    const errors = await Promise.all([expectWriteError(p1), expectWriteError(p2)]);
    for (const error of errors) {
      expect(error.kind).toBe("transport");
      expect(error.message).toContain("连接已断开");
    }
    expect(client.getSnapshot().connState).toBe("closed");
    expect(client.getSnapshot().inflight).toEqual([]);
  });

  it("握手期 serverClose(1008)=auth-failed", () => {
    const { client, ws } = setup();
    ws.open();
    ws.serverClose(1008);
    expect(client.getSnapshot().connState).toBe("error");
    expect(client.getSnapshot().errorKind).toBe("auth-failed");
  });

  it("close()=不可逆停止屏障：在途 closed 拒；幂等；connect 拒绝；迟到帧/迟到 close 零副作用", async () => {
    const { client, ws } = ready();
    const promise = client.sendPrompt("a.jsonl", "hi");
    client.close();
    const error = await expectWriteError(promise);
    expect(error.kind).toBe("closed");
    expect(client.getSnapshot().connState).toBe("closed");
    client.close(); // 幂等
    expect(ws.closeCount).toBe(1);
    client.connect(); // 停止位后拒绝（无新连接）
    expect(FakeSocket.instances.length).toBe(1);
    ws.receive({ t: "write-ack", requestId: "wr-p-1", file: "a.jsonl", outcome: LAUNCHED }); // 迟到帧零副作用
    ws.serverClose(1006); // 迟到 close 事件零副作用
    expect(client.getSnapshot().connState).toBe("closed");
    expect(client.getSnapshot().inflight).toEqual([]);
  });

  it("close() 任意状态可关：未 connect 即 close→此后 connect 永久拒绝；close 后发送=closed 拒", async () => {
    FakeSocket.reset();
    const client = new WriteClient("ws://x/ws", "t", (url) => new FakeSocket(url));
    client.close(); // 未 connect 也可关
    client.connect();
    expect(FakeSocket.instances.length).toBe(0); // 永久拒绝
    const error = await expectWriteError(client.sendPrompt("a.jsonl", "hi"));
    expect(error.kind).toBe("closed");
  });
});

// ---------------------------------------------------------------------------
// K5-C2：socket.send 同步抛错→受控结算（两份账同步清理）
// ---------------------------------------------------------------------------

/** send() 对 prompt/stop 帧同步抛错的假 socket（传输层损坏面；hello 照常放行以完成握手）。 */
class ThrowingSendSocket extends FakeSocket {
  override send(data: string): void {
    if (data.includes('"prompt"') || data.includes('"stop"')) throw new Error("injected transport failure");
    super.send(data);
  }
}

describe("K5-C2 发帧同步抛错", () => {
  function throwingReady(): { client: WriteClient; ws: ThrowingSendSocket } {
    FakeSocket.reset();
    const client = new WriteClient("ws://x/ws", "t", () => new ThrowingSendSocket());
    client.connect();
    const ws = FakeSocket.instances[0] as ThrowingSendSocket;
    ws.open();
    ws.receive(WELCOME);
    return { client, ws };
  }

  it("prompt 发帧抛错：promise 受控拒（transport）+在途表/快照两账清零+lastResult 落账；同 file 再发不被在途门卡死", async () => {
    const { client } = throwingReady();
    const error = await expectWriteError(client.sendPrompt("a.jsonl", "hi"));
    expect(error.kind).toBe("transport");
    expect(error.message).toContain("发送失败");
    const snap = client.getSnapshot();
    expect(snap.inflight).toEqual([]); // 快照账清零
    expect(snap.lastResult).toMatchObject({ ok: false, kind: "prompt", file: "a.jsonl" });
    expect(snap.connState).toBe("ready"); // 发送失败≠连接终局（不自动升级）
    const again = await expectWriteError(client.sendPrompt("a.jsonl", "hi")); // 再发：不被在途重复门卡死
    expect(again.kind).toBe("transport"); // 仍受控拒（socket 仍坏），而非 in-flight
  });

  it("stop 发帧抛错：同受控结算（kind=stop）", async () => {
    const { client } = throwingReady();
    const error = await expectWriteError(client.sendStop("a.jsonl"));
    expect(error.kind).toBe("transport");
    expect(client.getSnapshot().inflight).toEqual([]);
    expect(client.getSnapshot().lastResult).toMatchObject({ ok: false, kind: "stop", file: "a.jsonl" });
  });
});

// ---------------------------------------------------------------------------
// G5：writeViewOf 纯派生+lastResult file 身份门（真客户端快照驱动）
// ---------------------------------------------------------------------------

describe("G5 派生视图与 file 身份门", () => {
  it("真客户端快照→writeViewOf：在途/结果按 file 身份门透出，跨 file 不误报", async () => {
    const { client, ws } = ready();
    const promise = client.sendPrompt("a.jsonl", "hi");
    // 在途：a.jsonl 视角 sending；b.jsonl 视角 idle（在途不透出）
    expect(writeViewOf(client.getSnapshot(), "a.jsonl", null)).toMatchObject({ phase: "sending", sending: true });
    expect(writeViewOf(client.getSnapshot(), "b.jsonl", null)).toMatchObject({ phase: "idle", sending: false });
    ws.receive({ t: "write-ack", requestId: sentRequestId(ws, 1), file: "a.jsonl", outcome: LAUNCHED });
    await promise;
    // 结果：a.jsonl 视角可见；b.jsonl/file=null 视角不透出（身份门）
    expect(writeViewOf(client.getSnapshot(), "a.jsonl", null).lastResult).toMatchObject({ ok: true, file: "a.jsonl" });
    expect(writeViewOf(client.getSnapshot(), "b.jsonl", null).lastResult).toBeNull();
    expect(writeViewOf(client.getSnapshot(), null, null).lastResult).toBeNull();
  });

  it("writeViewOf 态机优先级：连接级硬错误 > 在途（stop 后发优先）> 瞬态错误 > idle", async () => {
    const { client, ws } = ready();
    const p = client.sendPrompt("a.jsonl", "hi");
    const s = client.sendStop("a.jsonl");
    // prompt×stop 并行：stop 为后发动作优先呈现
    expect(writeViewOf(client.getSnapshot(), "a.jsonl", null)).toMatchObject({
      phase: "stopping",
      sending: true,
      stopping: true,
    });
    // 在途优先于瞬态错误
    expect(writeViewOf(client.getSnapshot(), "a.jsonl", "旧错误").phase).toBe("stopping");
    // 连接级错误优先于一切
    ws.receive({ t: "error", code: 4405, message: "closed", retryable: false });
    await Promise.all([expectWriteError(p), expectWriteError(s)]); // 在途被统一受控拒（防未处理拒绝）
    const view = writeViewOf(client.getSnapshot(), "a.jsonl", null);
    expect(view.phase).toBe("error");
    expect(view.ready).toBe(false);
    expect(view.errorMessage).toContain("4405");
  });
});

// ---------------------------------------------------------------------------
// G6：composer 写挂面行为（真客户端+真 hook+真组件链：发送中禁用/状态呈现/stop 交互）
// ---------------------------------------------------------------------------

describe("G6 composer 写挂面（真实链）", () => {
  it("发送中：发送键禁用+状态行呈现「发送中…」+停止键保持可用；ack 后恢复并清空草稿、结果文案呈现", async () => {
    const { client, ws } = ready();
    render(React.createElement(WriteComposer, { client, file: "a.jsonl" }));
    const textarea = screen.getByLabelText("写入消息内容") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "你好写宿主" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(ws.frames()[1]).toEqual({ t: "prompt", requestId: "wr-p-1", file: "a.jsonl", text: "你好写宿主" });
    // 发送中禁用+状态呈现（无乐观清空）
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "停止" }) as HTMLButtonElement).disabled).toBe(false); // 发送后立即停止合法流
    expect(textarea.value).toBe("你好写宿主");
    expect(
      screen
        .getAllByRole("status")
        .map((n) => n.textContent)
        .join(),
    ).toContain("发送中…");
    await act(async () => {
      ws.receive({ t: "write-ack", requestId: "wr-p-1", file: "a.jsonl", outcome: LAUNCHED });
    });
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true); // 草稿已清空→空文本禁用
    expect(textarea.value).toBe(""); // ack 后清空（B1：无在途编辑）
    const statuses = screen
      .getAllByRole("status")
      .map((n) => n.textContent)
      .join();
    expect(statuses).toContain("可发送");
    expect(statuses).toContain("已入队（intentId=i-1）");
  });

  it("stop 交互：停止中禁用停止键+状态行「停止中…」；stop-ack 后恢复+结果文案", async () => {
    const { client, ws } = ready();
    render(React.createElement(WriteComposer, { client, file: "a.jsonl" }));
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(ws.frames()[1]).toEqual({ t: "stop", requestId: "wr-s-1", file: "a.jsonl" });
    expect((screen.getByRole("button", { name: "停止" }) as HTMLButtonElement).disabled).toBe(true); // 停止在途
    expect(
      screen
        .getAllByRole("status")
        .map((n) => n.textContent)
        .join(),
    ).toContain("停止中…");
    await act(async () => {
      ws.receive({
        t: "write-stop-ack",
        requestId: "wr-s-1",
        file: "a.jsonl",
        outcome: { kind: "confirmed", exit: { code: 1, signal: "SIGTERM" } },
      });
    });
    expect((screen.getByRole("button", { name: "停止" }) as HTMLButtonElement).disabled).toBe(false);
    expect(
      screen
        .getAllByRole("status")
        .map((n) => n.textContent)
        .join(),
    ).toContain("已停止");
  });

  it("连接级失败：写面硬错误横幅 role=alert（受控文案）+发送入口关闭", async () => {
    const { client, ws } = ready();
    render(React.createElement(WriteComposer, { client, file: "a.jsonl" }));
    fireEvent.change(screen.getByLabelText("写入消息内容"), { target: { value: "hi" } });
    act(() => {
      ws.receive({ t: "error", code: 4405, message: "closed", retryable: false });
    });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("4405");
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true); // ready=false 锁入口
    expect((screen.getByLabelText("写入消息内容") as HTMLTextAreaElement).disabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// v1.1 resume 面：帧形/校验/ack 配对/4409 排队超时/断连终局/坏帧零副作用
// ---------------------------------------------------------------------------

describe("resume 面", () => {
  const RESUME_LAUNCHED = { kind: "launched", intentId: "i-9", commandId: 3 } as const;

  it("resume 帧形状+ack 配对：resume{requestId,file,intentId,generation}→write-resume-ack 同 requestId resolve+快照两账", async () => {
    const { client, ws } = ready();
    let settled: unknown = null;
    void client.resume("a.jsonl", "i-1", 2).then((outcome) => {
      settled = outcome;
    });
    expect(ws.frames()[1]).toEqual({
      t: "resume",
      requestId: "wr-r-1",
      file: "a.jsonl",
      intentId: "i-1",
      generation: 2,
    });
    expect(client.getSnapshot().resumeState).toEqual({ phase: "resuming", files: ["a.jsonl"] });
    expect(client.getSnapshot().inflight).toEqual([]); // resume 独立账，不混入 prompt/stop 在途视图
    ws.receive({ t: "write-resume-ack", requestId: "wr-r-1", file: "a.jsonl", outcome: RESUME_LAUNCHED });
    await Promise.resolve();
    expect(settled).toEqual(RESUME_LAUNCHED);
    expect(client.getSnapshot().resumeState).toEqual({ phase: "idle" });
    expect(client.getSnapshot().lastResumeResult).toEqual({ ok: true, file: "a.jsonl", outcome: RESUME_LAUNCHED });
  });

  it("两失败枝+执行七枝 outcome 正常 resolve（identity-rejected 四 cause/execution-failed/not-ready）", async () => {
    const { client, ws } = ready();
    const outcomes: unknown[] = [
      { kind: "identity-rejected", cause: "no-recovery-data" },
      { kind: "identity-rejected", cause: "resume-blocked" },
      { kind: "identity-rejected", cause: "resume-not-authorized" },
      { kind: "identity-rejected", cause: "generation-mismatch" },
      { kind: "execution-failed", cause: "payload-unavailable" },
      { kind: "busy" },
      { kind: "gate-rejected", reason: "closed" },
      { kind: "gate-failed", stage: "sending" },
      { kind: "invalidated", stage: "post-send" },
      { kind: "no-process" },
      { kind: "not-ready", cause: "x" },
      { kind: "not-ready" },
    ];
    for (let i = 0; i < outcomes.length; i++) {
      const p = client.resume("a.jsonl", "i-1", 1);
      ws.receive({ t: "write-resume-ack", requestId: `wr-r-${i + 1}`, file: "a.jsonl", outcome: outcomes[i] });
      await expect(p).resolves.toEqual(outcomes[i]);
    }
  });

  it("ack 三重交叉验证：requestId 匹配但 file 回显不符/错 kind 帧冒名=零消费（在途保留，合法帧照常结算）", async () => {
    const { client, ws } = ready();
    const promise = client.resume("a.jsonl", "i-1", 1);
    ws.receive({ t: "write-resume-ack", requestId: "wr-r-1", file: "OTHER.jsonl", outcome: RESUME_LAUNCHED }); // file 不符
    ws.receive({ t: "write-ack", requestId: "wr-r-1", file: "a.jsonl", outcome: LAUNCHED }); // write-ack 冒名 resume 请求
    expect(client.getSnapshot().resumeState).toEqual({ phase: "resuming", files: ["a.jsonl"] });
    ws.receive({ t: "write-resume-ack", requestId: "wr-r-1", file: "a.jsonl", outcome: RESUME_LAUNCHED });
    await expect(promise).resolves.toEqual(RESUME_LAUNCHED);
  });

  it("参数校验零帧本地拒：file 非法/intentId 越形/generation 非正整数（0/-1/1.5/NaN）", async () => {
    const { client, ws } = ready();
    const e1 = await expectWriteError(client.resume("a/b.jsonl", "i-1", 1));
    expect(e1.kind).toBe("local-invalid");
    const e2 = await expectWriteError(client.resume("a.jsonl", "bad id!", 1)); // 空格+叹号越 intentIdPattern
    expect(e2.kind).toBe("local-invalid");
    expect(e2.message).toContain("意图标识非法");
    for (const g of [0, -1, 1.5, Number.NaN]) {
      const e = await expectWriteError(client.resume("a.jsonl", "i-1", g));
      expect(e.kind).toBe("local-invalid");
      expect(e.message).toContain("进程代次非法");
    }
    expect(ws.sent.length).toBe(1); // 全部零帧（仅 hello）
  });

  it("未 ready/同 file 在途重复=本地拒（他 file 可并行；同 file prompt×resume 并行合法）", async () => {
    const { client, ws } = setup();
    ws.open(); // authenticating 未 ready
    const e0 = await expectWriteError(client.resume("a.jsonl", "i-1", 1));
    expect(e0.kind).toBe("not-ready");
    ws.receive(WELCOME);
    void client.resume("a.jsonl", "i-1", 1);
    const dup = await expectWriteError(client.resume("a.jsonl", "i-2", 1));
    expect(dup.kind).toBe("in-flight");
    expect(dup.message).toContain("恢复重发已在途");
    void client.resume("b.jsonl", "i-3", 4); // 他 file 并行
    void client.sendPrompt("a.jsonl", "hi"); // 同 file prompt×resume 并行（kind 分账）
    expect(ws.sent.length).toBe(4); // hello+resume(a)+resume(b)+prompt(a)
    expect(client.getSnapshot().resumeState).toEqual({ phase: "resuming", files: ["a.jsonl", "b.jsonl"] }); // 跨 file 在途集合同账
  });

  it("4409 排队超时（requestId 匹配在途 resume）：记「计算排队超时，可重试」结果——非硬错：连接 ready+可显式重试", async () => {
    const { client, ws } = ready();
    const promise = client.resume("a.jsonl", "i-1", 1);
    ws.receive({ t: "error", code: 4409, message: "compute gate queue timeout", retryable: true, requestId: "wr-r-1" });
    const error = await expectWriteError(promise);
    expect(error.kind).toBe("server");
    expect(error.code).toBe(4409);
    expect(error.message).toBe("计算排队超时，可重试（4409）"); // 专用受控文案（非 writeFaceErrorText 4409 游标措辞）
    const snap = client.getSnapshot();
    expect(snap.connState).toBe("ready"); // 连接存活
    expect(snap.resumeState).toEqual({ phase: "idle" });
    expect(snap.lastResumeResult).toEqual({ ok: false, file: "a.jsonl", message: "计算排队超时，可重试（4409）" });
    // 可显式重试：重发照常走帧+ack 结算
    const retry = client.resume("a.jsonl", "i-1", 1);
    expect(ws.frames()[2]).toMatchObject({ t: "resume", requestId: "wr-r-2", file: "a.jsonl" });
    ws.receive({ t: "write-resume-ack", requestId: "wr-r-2", file: "a.jsonl", outcome: RESUME_LAUNCHED });
    await expect(retry).resolves.toEqual(RESUME_LAUNCHED);
  });

  it("resume 在途遇 prompt 的 4409：prompt 仍按通用受控文案结算（游标措辞不误染 resume 专用面）", async () => {
    const { client, ws } = ready();
    const p = client.sendPrompt("a.jsonl", "hi");
    const r = client.resume("a.jsonl", "i-1", 1);
    ws.receive({ t: "error", code: 4409, message: "cursor", retryable: true, requestId: "wr-p-1" });
    const error = await expectWriteError(p);
    expect(error.message).toBe(writeFaceText4409Prompt());
    expect(client.getSnapshot().resumeState).toEqual({ phase: "resuming", files: ["a.jsonl"] }); // resume 在途不受影响
    ws.receive({ t: "write-resume-ack", requestId: "wr-r-2", file: "a.jsonl", outcome: RESUME_LAUNCHED });
    await expect(r).resolves.toEqual(RESUME_LAUNCHED);
  });

  it("断连终局：resume 在途统一 transport 拒+resumeState 归 idle+lastResumeResult 落账", async () => {
    const { client, ws } = ready();
    const promise = client.resume("a.jsonl", "i-1", 1);
    ws.serverClose(1006);
    const error = await expectWriteError(promise);
    expect(error.kind).toBe("transport");
    expect(error.message).toContain("连接已断开");
    const snap = client.getSnapshot();
    expect(snap.resumeState).toEqual({ phase: "idle" });
    expect(snap.lastResumeResult).toMatchObject({ ok: false, file: "a.jsonl" });
    expect(snap.connState).toBe("closed");
  });

  it("坏帧零副作用：畸形 write-resume-ack（outcome 越域/缺字段）不消费在途，合法帧照常结算", async () => {
    const { client, ws } = ready();
    const promise = client.resume("a.jsonl", "i-1", 1);
    ws.receive({
      t: "write-resume-ack",
      requestId: "wr-r-1",
      file: "a.jsonl",
      outcome: { kind: "identity-rejected", cause: "unknown-cause" },
    }); // cause 越域
    ws.receive({
      t: "write-resume-ack",
      requestId: "wr-r-1",
      file: "a.jsonl",
      outcome: { kind: "execution-failed", cause: "other" },
    }); // cause 越域
    ws.receive({ t: "write-resume-ack", requestId: "wr-r-1", file: "a.jsonl" }); // 缺 outcome
    ws.receive({ t: "write-resume-ack", requestId: "wr-r-99", file: "a.jsonl", outcome: RESUME_LAUNCHED }); // 陌生 requestId
    expect(client.getSnapshot().resumeState).toEqual({ phase: "resuming", files: ["a.jsonl"] }); // 零消费
    ws.receive({ t: "write-resume-ack", requestId: "wr-r-1", file: "a.jsonl", outcome: RESUME_LAUNCHED });
    await expect(promise).resolves.toEqual(RESUME_LAUNCHED);
  });

  it("close()：在途 resume 以 closed 受控拒+resumeState 归 idle", async () => {
    const { client } = ready();
    const promise = client.resume("a.jsonl", "i-1", 1);
    client.close();
    const error = await expectWriteError(promise);
    expect(error.kind).toBe("closed");
    expect(client.getSnapshot().resumeState).toEqual({ phase: "idle" });
    const after = await expectWriteError(client.resume("a.jsonl", "i-1", 1));
    expect(after.kind).toBe("closed");
  });
});

/** prompt 面 4409 通用受控文案（writeFaceErrorText 私有，镜像期望值防回归漂移）。 */
function writeFaceText4409Prompt(): string {
  return "请求游标或状态已过期（4409）";
}

// ---------------------------------------------------------------------------
// M-OPS（v1.4）：sendPrompt 可选 model 形参（docs/m-ops-design.md §3；契约 §10.3）
// ---------------------------------------------------------------------------

describe("M-OPS sendPrompt model 形参", () => {
  it("带合法 model：prompt 帧携带 model 域（spawn 尾追 --model 由服务端保证）", async () => {
    const { client, ws } = ready();
    const promise = client.sendPrompt("a.jsonl", "你好", "openai/gpt-5.3:high");
    const frame = ws.frames()[1] as Record<string, unknown>;
    expect(frame).toMatchObject({ t: "prompt", file: "a.jsonl", text: "你好", model: "openai/gpt-5.3:high" });
    ws.receive({ t: "write-ack", requestId: sentRequestId(ws, 1), file: "a.jsonl", outcome: LAUNCHED });
    await expect(promise).resolves.toEqual(LAUNCHED);
  });

  it("不带 model：prompt 帧无 model 键（undefined=不改会话模型，v1 帧形兼容）", async () => {
    const { client, ws } = ready();
    const promise = client.sendPrompt("a.jsonl", "你好");
    const frame = ws.frames()[1] as Record<string, unknown>;
    expect("model" in frame).toBe(false);
    ws.receive({ t: "write-ack", requestId: sentRequestId(ws, 1), file: "a.jsonl", outcome: LAUNCHED });
    await expect(promise).resolves.toEqual(LAUNCHED);
  });

  it("显式 undefined：与缺省同语义（帧无 model 键）", () => {
    const { client, ws } = ready();
    void client.sendPrompt("a.jsonl", "你好", undefined);
    const frame = ws.frames()[1] as Record<string, unknown>;
    expect("model" in frame).toBe(false);
  });

  it("非法 model（空格/空串/超 128）→本地预校验拒（local-invalid），零帧成本", async () => {
    const { client, ws } = ready();
    const before = ws.sent.length;
    for (const bad of ["has space", "", "m".repeat(129), "bad\nid"]) {
      const error = await expectWriteError(client.sendPrompt("a.jsonl", "你好", bad));
      expect(error.kind).toBe("local-invalid");
    }
    expect(ws.sent.length).toBe(before); // 一律未发帧
  });
});
