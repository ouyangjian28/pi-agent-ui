// @vitest-environment jsdom
// A1a WS 客户端测试：FakeWebSocket 模式（注入式假 socket，不依赖真 ws 库/真网络；本文件不触 DOM，
// docblock 为派单统一要求）。覆盖：握手成功（hello 带 token→welcome→list-sessions）/握手 4401 两形态/
// sessions 列表更新/连接关闭终态/未知帧与非 JSON 外壳畸形安全忽略（已知帧的结构化畸形由 R1 各测覆盖）/
// R1 消费帧运行时校验（审报 §2-R1 全部反例）/R2 错误文案受控（token 不进快照）/
// R3 关闭=不可逆停止屏障（审报 §5-3 五时序）/C1 握手期非认证失败受控反馈。
import { describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import { WsClient, type WebSocketLike } from "../../../apps/web/src/ws/ws-client";

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];
  static reset(): void {
    FakeWebSocket.instances = [];
  }
  readyState = 0; // CONNECTING
  readonly sent: string[] = [];
  closeCount = 0; // 主动物理释放调用计数（close 幂等/迟到释放断言用）
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
  // ---- 测试驱动面（模拟服务端行为） ----
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  /** 迟到的 open 回调：不改 readyState——模拟 close 后才触发的保存回调（§5-3 时序）。 */
  lateOpen(): void {
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

const VALID_DTO = {
  sessionId: "s-1",
  file: "a.jsonl",
  title: { text: "搭建会话工作台", truncated: false },
  lastActiveMs: 1_730_000_000_000,
  entryCount: 12,
  sizeBytes: 3456,
  hasRecoveryNotice: false,
  listReliability: "full",
} as const;

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

/** 握手后进入列表期：取出在途 list-sessions requestId，登记通知计数器与基线快照。 */
function listPhase(): {
  client: WsClient;
  ws: FakeWebSocket;
  requestId: string;
  before: ReturnType<WsClient["getSnapshot"]>;
  notified: () => number;
} {
  const { client, ws } = setup();
  handshake(ws);
  const requestId = (ws.sentFrames()[1] as { requestId: string }).requestId;
  const before = client.getSnapshot();
  let n = 0;
  client.subscribe(() => n++);
  return { client, ws, requestId, before, notified: () => n };
}

/** 与在途 requestId 关联的合法 sessions 回包。 */
function validSessions(requestId: string): unknown {
  return {
    t: "sessions",
    requestId,
    sessions: [VALID_DTO],
    total: 1,
    offset: 0,
    hasMore: false,
    listVersion: 1,
    listReliability: "full",
  };
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

  it("握手期收到 error 4401→auth-failed（受控文案）；随后 1008 关闭不降级为 closed", () => {
    const { client, ws } = setup("bad-token");
    ws.open();
    ws.receive({ t: "error", code: 4401, message: "未认证或令牌无效", retryable: false });
    expect(client.getSnapshot().state).toBe("error");
    expect(client.getSnapshot().errorKind).toBe("auth-failed");
    expect(client.getSnapshot().errorMessage).toContain("认证失败");
    expect(client.getSnapshot().errorMessage).toContain("4401");
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
    ws.receive({
      t: "sessions",
      requestId: listReq.requestId,
      sessions: [VALID_DTO],
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

  it("未知帧类型（含写类 ack）与非 JSON/帧外壳畸形输入安全忽略，不抛错不变更快照", () => {
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

describe("R1 已知帧运行时形状校验（畸形已知帧按未知帧零副作用；坏帧后合法回包仍成功）", () => {
  it("welcome 缺字段：不算握手成功（保持 authenticating、不发 list）；随后合法 welcome 仍完成握手", () => {
    const { client, ws } = setup();
    ws.open();
    ws.receive({ t: "welcome" });
    expect(client.getSnapshot().state).toBe("authenticating");
    expect(ws.sent).toHaveLength(1); // 仅 hello，未发 list-sessions
    ws.receive(WELCOME);
    expect(client.getSnapshot().state).toBe("ready");
    expect((ws.sentFrames()[1] as { t: string }).t).toBe("list-sessions");
  });

  it("welcome protocolVersion:2：不支持版本不算握手成功；随后版本 1 的合法 welcome 仍成功", () => {
    const { client, ws } = setup();
    ws.open();
    ws.receive({ ...WELCOME, protocolVersion: 2 });
    expect(client.getSnapshot().state).toBe("authenticating");
    expect(ws.sent).toHaveLength(1);
    ws.receive(WELCOME);
    expect(client.getSnapshot().state).toBe("ready");
    expect(ws.sent).toHaveLength(2);
  });

  it("sessions 为对象：整帧忽略、不消耗在途请求；同 requestId 合法回包仍落地", () => {
    const { client, ws, requestId, before, notified } = listPhase();
    ws.receive({ t: "sessions", requestId, sessions: { length: 1 }, total: 1, offset: 0, hasMore: false, listVersion: 1, listReliability: "full" });
    expect(client.getSnapshot()).toBe(before); // 引用不变=未改快照、未通知
    expect(notified()).toBe(0);
    ws.receive(validSessions(requestId));
    expect(client.getSnapshot().sessions).toHaveLength(1); // 在途请求未被坏帧消耗
  });

  it("sessions 数组含 null：整帧忽略、在途请求保留；合法回包仍落地", () => {
    const { client, ws, requestId, before, notified } = listPhase();
    ws.receive({ t: "sessions", requestId, sessions: [null], total: 1, offset: 0, hasMore: false, listVersion: 1, listReliability: "full" });
    expect(client.getSnapshot()).toBe(before);
    expect(notified()).toBe(0);
    ws.receive(validSessions(requestId));
    expect(client.getSnapshot().sessions).toHaveLength(1);
  });

  it("条目 title:null：SessionSummaryDTO 校验拒绝整帧、在途请求保留；合法回包仍落地", () => {
    const { client, ws, requestId, before, notified } = listPhase();
    ws.receive({
      t: "sessions",
      requestId,
      sessions: [{ ...VALID_DTO, title: null }],
      total: 1,
      offset: 0,
      hasMore: false,
      listVersion: 1,
      listReliability: "full",
    });
    expect(client.getSnapshot()).toBe(before);
    expect(notified()).toBe(0);
    ws.receive(validSessions(requestId));
    expect(client.getSnapshot().sessions).toHaveLength(1);
  });

  it("sessions 字段缺失：整帧忽略不清在途请求（不误判为空目录）；合法回包仍落地", () => {
    const { client, ws, requestId, before, notified } = listPhase();
    ws.receive({ t: "sessions", requestId, total: 1, offset: 0, hasMore: false, listVersion: 1, listReliability: "full" });
    expect(client.getSnapshot()).toBe(before);
    expect(notified()).toBe(0);
    expect(client.getSnapshot().sessions).toBeNull(); // 不是「收到空列表」
    ws.receive(validSessions(requestId));
    expect(client.getSnapshot().sessions).toHaveLength(1);
  });

  it("error.message 为对象：畸形 error 整帧忽略（不清在途、不进错误态）；随后合法 sessions 仍成功", () => {
    const { client, ws, requestId, before, notified } = listPhase();
    ws.receive({ t: "error", code: 4409, requestId, message: { x: 1 }, retryable: true });
    expect(client.getSnapshot()).toBe(before); // 仍 ready，无任何副作用
    expect(notified()).toBe(0);
    ws.receive(validSessions(requestId));
    expect(client.getSnapshot().sessions).toHaveLength(1);
  });
});

describe("R2 错误文案受控（远端 error.message 永不进快照）", () => {
  const SENTINEL = "review-token-sentinel";

  it("关联 4409 反射 token：快照只存受控文案（含码），序列化不含 token；error 后迟到合法回包不落地", () => {
    const { client, ws, requestId } = listPhase();
    ws.receive({ t: "error", code: 4409, requestId, message: `request rejected: ${SENTINEL}`, retryable: true });
    const snap = client.getSnapshot();
    expect(snap.state).toBe("error");
    expect(snap.errorKind).toBe("list-failed");
    expect(snap.errorMessage).toContain("4409");
    expect(snap.errorMessage).not.toContain(SENTINEL);
    expect(JSON.stringify(snap)).not.toContain(SENTINEL); // 全字段序列化无 token
    ws.receive(validSessions(requestId)); // 在途已清+error 终态门：迟到回包零副作用
    expect(client.getSnapshot()).toBe(snap);
  });

  it("4401 反射 token：auth-failed 快照序列化不含 token；随后 1008 关闭不降级零副作用", () => {
    const { client, ws } = setup(SENTINEL);
    ws.open();
    ws.receive({ t: "error", code: 4401, message: `未认证或令牌无效: ${SENTINEL}`, retryable: false });
    const snap = client.getSnapshot();
    expect(snap.state).toBe("error");
    expect(snap.errorKind).toBe("auth-failed");
    expect(snap.errorMessage).toContain("认证失败");
    expect(JSON.stringify(snap)).not.toContain(SENTINEL);
    ws.serverClose(1008);
    expect(client.getSnapshot()).toBe(snap); // 不降级、引用不变=零副作用
  });
});

describe("R3 关闭=不可逆停止屏障（§5-3 五时序；断言只用发帧计数/close 计数/快照身份）", () => {
  it("close-before-connect：未 connect 即 close→closed 终态；随后 connect 永久拒绝（不建 socket）", () => {
    FakeWebSocket.reset();
    const client = new WsClient("ws://127.0.0.1:9001/ws", "t", (url) => new FakeWebSocket(url));
    client.close();
    expect(client.getSnapshot().state).toBe("closed");
    client.connect();
    expect(FakeWebSocket.instances).toHaveLength(0); // 停止位生效：不创建连接
  });

  it("异步关闭窗口：CLOSING 中主动 close 定格终态；迟到的 close 事件/回包/open 回调全零副作用", () => {
    const { client, ws } = setup();
    handshake(ws);
    ws.readyState = 2; // 服务端已发起关闭、close 事件未达（浏览器异步 CLOSING 窗口）
    client.close();
    const frozen = client.getSnapshot();
    expect(frozen.state).toBe("closed");
    expect(ws.closeCount).toBe(1); // 物理释放恰好一次
    ws.serverClose(1000); // 迟到的 close 事件
    expect(client.getSnapshot()).toBe(frozen);
    const requestId = (ws.sentFrames()[1] as { requestId: string }).requestId;
    ws.receive(validSessions(requestId)); // 迟到合法回包
    expect(client.getSnapshot()).toBe(frozen);
    ws.lateOpen(); // 迟到的 open 回调
    expect(client.getSnapshot()).toBe(frozen);
    expect(client.getSnapshot().state).toBe("closed"); // 不复活 authenticating
    expect(ws.sentFrames()).toHaveLength(2); // 全程仅 hello+list，无第二次 hello
  });

  it("迟到 open 回调：serverClose(1000) 后保存的 onopen 触发不复活状态、不补发 hello", () => {
    const { client, ws } = setup();
    ws.serverClose(1000); // open 从未发生（CONNECTING 期被服务端关闭）
    expect(client.getSnapshot().state).toBe("closed");
    ws.lateOpen(); // 迟到的 open 回调
    expect(client.getSnapshot().state).toBe("closed");
    expect(ws.sent).toHaveLength(0); // 未发过 hello，也不补发
  });

  it("error 后主动 close：socket 物理释放、error 展示保留；迟到回包零副作用；重复 close 幂等；connect 拒绝", () => {
    const { client, ws } = setup();
    handshake(ws);
    const requestId = (ws.sentFrames()[1] as { requestId: string }).requestId;
    ws.receive({ t: "error", code: 4409, requestId, message: "拒绝", retryable: true });
    expect(client.getSnapshot().state).toBe("error");
    client.close(); // error 态也必须可关：展示态与物理释放分离
    const frozen = client.getSnapshot();
    expect(frozen.state).toBe("error"); // 展示保留具体错误
    expect(frozen.errorKind).toBe("list-failed");
    expect(ws.closeCount).toBe(1);
    ws.receive(validSessions(requestId)); // 迟到合法回包
    expect(client.getSnapshot()).toBe(frozen);
    client.close(); // 重复 close 幂等
    expect(ws.closeCount).toBe(1);
    client.connect(); // close 后 connect 拒绝
    expect(FakeWebSocket.instances).toHaveLength(1); // 不建第二连接
  });

  it("ready 主动 close 幂等：重复 close 只释放一次；close 后 connect 拒绝且迟到帧零副作用", () => {
    const { client, ws } = setup();
    handshake(ws);
    client.close();
    const frozen = client.getSnapshot();
    expect(frozen.state).toBe("closed");
    expect(ws.closeCount).toBe(1);
    client.close(); // 幂等：不再触发释放/通知
    expect(ws.closeCount).toBe(1);
    expect(client.getSnapshot()).toBe(frozen);
    client.connect(); // 拒绝重连
    expect(FakeWebSocket.instances).toHaveLength(1);
    const requestId = (ws.sentFrames()[1] as { requestId: string }).requestId;
    ws.receive(validSessions(requestId)); // 迟到帧
    expect(client.getSnapshot()).toBe(frozen);
  });
});

describe("C1 握手期非认证失败受控反馈", () => {
  it("握手期 4403→handshake-failed 受控文案（不丢版本不匹配原因）；随后 1003 关闭不降级", () => {
    const { client, ws } = setup();
    ws.open();
    ws.receive({ t: "error", code: 4403, message: "unsupported protocol version", retryable: false });
    const snap = client.getSnapshot();
    expect(snap.state).toBe("error");
    expect(snap.errorKind).toBe("handshake-failed");
    expect(snap.errorMessage).toContain("4403");
    expect(snap.errorMessage).toContain("协议版本");
    ws.serverClose(1003); // §5.3：4403 走 close 1003——不降级为通用 closed
    expect(client.getSnapshot()).toBe(snap);
  });

  it("连接工厂抛异常→transport 受控错误；后续 connect 永久拒绝不重复抛出", () => {
    FakeWebSocket.reset();
    const client = new WsClient("ws://127.0.0.1:9001/ws", "t", () => {
      throw new Error("no websocket");
    });
    client.connect();
    const snap = client.getSnapshot();
    expect(snap.state).toBe("error");
    expect(snap.errorKind).toBe("transport");
    expect(snap.errorMessage).toContain("连接创建失败");
    client.connect();
    expect(client.getSnapshot()).toBe(snap); // 幂等拒绝，无第二次迁移
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// M-OPS（v1.4）模型清单面：get-models 发送器+models-list 载入+降级口径+零副作用门。
// ---------------------------------------------------------------------------

describe("M-OPS 模型清单面（get-models/models-list）", () => {
  it("ready 后 requestModels 发 get-models（requestId 过 pattern）；回帧 ok→快照 items；再调幂等不重发", () => {
    const { client, ws } = setup();
    handshake(ws);
    const before = ws.sent.length;
    client.requestModels();
    const frame = ws.sentFrames()[before] as { t: string; requestId: string };
    expect(frame.t).toBe("get-models");
    expect(frame.requestId).toMatch(/^[\w-]{1,64}$/);
    expect(client.getSnapshot().models.status).toBe("loading");
    ws.receive({
      t: "models-list",
      requestId: frame.requestId,
      models: [
        { provider: "openai-codex", id: "gpt-6", context: "400k" },
        { provider: "kimi-coding", id: "k3" },
      ],
    });
    const m = client.getSnapshot().models;
    expect(m.status).toBe("ok");
    expect(m.items).toHaveLength(2);
    expect(m.items[0]).toEqual({ provider: "openai-codex", id: "gpt-6", context: "400k" });
    expect(m.cause).toBeNull();
    const sentAfter = ws.sent.length;
    client.requestModels(); // ok 后幂等：不重发
    expect(ws.sent).toHaveLength(sentAfter);
  });

  it("服务端降级口径：回帧带 cause→failed+空表+cause；failed 后可重发（新显式动作）", () => {
    const { client, ws } = setup();
    handshake(ws);
    client.requestModels();
    const rid = (ws.sentFrames().at(-1) as { requestId: string }).requestId;
    ws.receive({ t: "models-list", requestId: rid, models: [], cause: "pi --list-models 退出码 1" });
    const m = client.getSnapshot().models;
    expect(m.status).toBe("failed");
    expect(m.items).toEqual([]);
    expect(m.cause).toBe("pi --list-models 退出码 1");
    expect(client.getSnapshot().state).toBe("ready"); // 不连坐主连接状态
    client.requestModels();
    expect(client.getSnapshot().models.status).toBe("loading");
    expect(ws.sentFrames().filter((f) => (f as { t: string }).t === "get-models")).toHaveLength(2);
  });

  it("R1 形状拒：条目缺 provider 整帧拒绝、在途保持、后续合法帧成功", () => {
    const { client, ws } = setup();
    handshake(ws);
    client.requestModels();
    const rid = (ws.sentFrames().at(-1) as { requestId: string }).requestId;
    expect(client.getSnapshot().models.status).toBe("loading");
    ws.receive({ t: "models-list", requestId: rid, models: [{ id: "no-provider" }] }); // 畸形条目
    expect(client.getSnapshot().models.status).toBe("loading"); // 在途未消耗
    ws.receive({ t: "models-list", requestId: rid, models: [{ provider: "p", id: "m" }] }); // 坏帧后合法仍成功
    expect(client.getSnapshot().models.status).toBe("ok");
  });

  it("零副作用门：未请求的 models-list 忽略；close 后 requestModels 静默不抛", () => {
    const { client, ws } = setup();
    handshake(ws);
    ws.receive({ t: "models-list", requestId: "get-models-1", models: [{ provider: "p", id: "m" }] }); // 未请求
    expect(client.getSnapshot().models.status).toBe("idle");
    client.close();
    expect(() => client.requestModels()).not.toThrow();
    expect(ws.sentFrames().filter((f) => (f as { t: string }).t === "get-models")).toHaveLength(0);
  });

  it("握手前 requestModels 静默不发（welcome 前非 hello 帧会被 4401）", () => {
    const { client, ws } = setup();
    ws.open(); // authenticating 期
    client.requestModels();
    expect(ws.sentFrames().filter((f) => (f as { t: string }).t === "get-models")).toHaveLength(0);
    handshake(ws); // welcome 到达
    client.requestModels(); // ready 后可发
    expect(ws.sentFrames().filter((f) => (f as { t: string }).t === "get-models")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// v1.5（批A）授权根面：get-roots 发送器+roots-list 载入+幂等+零副作用门（挂 list 连接）。
// ---------------------------------------------------------------------------

describe("v1.5 授权根面（get-roots/roots-list，批A）", () => {
  const ROOTS = ["/srv/sessions", "/srv/proj-a", "/home/yyj/ai"];

  it("ready 后 requestRoots 发 get-roots；回帧 ok→快照 items 原序；在途/ok 幂等不重发", () => {
    const { client, ws } = setup();
    handshake(ws);
    const before = ws.sent.length;
    client.requestRoots();
    const frame = ws.sentFrames()[before] as { t: string; requestId: string };
    expect(frame.t).toBe("get-roots");
    expect(frame.requestId).toMatch(/^[\w-]{1,64}$/);
    expect(client.getSnapshot().roots.status).toBe("loading");
    client.requestRoots(); // 在途幂等：不重发
    expect(ws.sent).toHaveLength(before + 1);
    ws.receive({ t: "roots-list", requestId: frame.requestId, roots: ROOTS });
    const r = client.getSnapshot().roots;
    expect(r.status).toBe("ok");
    expect(r.items).toEqual(ROOTS); // 服务端原序保留（首项=会话记录树，由 UI 层解释）
    expect(r.cause).toBeNull();
    const sentAfter = ws.sent.length;
    client.requestRoots(); // ok 后幂等：不重发
    expect(ws.sent).toHaveLength(sentAfter);
  });

  it("P1-05（GPT 批2审）：roots 在途时远端 close→在途清位+timer 撤销，10s 后旧 timer 零副作用（不改终态快照/不通知）", async () => {
    vi.useFakeTimers();
    try {
      const { client, ws } = setup();
      handshake(ws);
      client.requestRoots();
      expect(client.getSnapshot().roots.status).toBe("loading");
      ws.serverClose(1000); // 远端正常关闭（非 close() 主动；此 transition 自身通知不算）
      expect(client.getSnapshot().state).toBe("closed");
      expect(vi.getTimerCount()).toBe(0); // 物理撤销（非 pending 门兜底——GPT P1-06 口径：pending 门拦截≠timer 清理）
      let notified = 0;
      client.subscribe(() => notified++);
      await act(async () => { vi.advanceTimersByTime(10_000); }); // 旧 timer 到点
      expect(client.getSnapshot().roots.status).toBe("loading"); // 定格不清空（同 models 口径）；绝不被旧 timer 改 failed
      expect(notified).toBe(0); // 终态后零通知（timer 撤销，非 pending 门拦截）
      // 重挂语义：closed 后不再发新请求（connect 拒绝面另测）；迟到回包零副作用
      ws.receive({ t: "roots-list", requestId: "get-roots-1", roots: ROOTS });
      expect(client.getSnapshot().roots.status).toBe("loading");
    } finally {
      vi.useRealTimers();
    }
  });

  it("P2-02（GPT 批2审）：sendFrame 同步 throw→pending 回滚，下一 requestRoots 可重发（不悬挂）", () => {
    const { client, ws } = setup();
    handshake(ws);
    client.requestRoots(); // 首次成功发出（get-roots-1 在途）
    const rid1 = (ws.sentFrames().at(-1) as { requestId: string }).requestId;
    // 结算首请求（failed）→腾出 pending 位，再让 send 同步 throw
    ws.receive({ t: "error", code: 4402, requestId: rid1, message: "拒绝", retryable: true });
    expect(client.getSnapshot().roots.status).toBe("failed");
    const origSend = ws.send.bind(ws);
    ws.send = () => { throw new Error("boom"); }; // socket.send 同步抛
    client.requestRoots(); // failed 可重发路径：send throw
    expect(client.getSnapshot().roots.status).toBe("failed"); // 不悬挂 loading
    ws.send = origSend;
    client.requestRoots(); // 回滚后可重发（不悬挂证明）
    expect(client.getSnapshot().roots.status).toBe("loading");
    expect(ws.sentFrames().filter((f) => f.t === "get-roots").length).toBeGreaterThanOrEqual(2);
  });

  it("R1 形状拒：roots 含非 string 整帧拒绝、在途保持、后续合法帧成功", () => {
    const { client, ws } = setup();
    handshake(ws);
    client.requestRoots();
    const rid = (ws.sentFrames().at(-1) as { requestId: string }).requestId;
    expect(client.getSnapshot().roots.status).toBe("loading");
    ws.receive({ t: "roots-list", requestId: rid, roots: ["/ok", 42] }); // 畸形条目
    expect(client.getSnapshot().roots.status).toBe("loading"); // 在途未消耗
    ws.receive({ t: "roots-list", requestId: rid, roots: ROOTS }); // 坏帧后合法仍成功
    expect(client.getSnapshot().roots.status).toBe("ok");
    expect(client.getSnapshot().roots.items).toEqual(ROOTS);
  });

  it("error 帧 requestId 匹配→failed+受控文案（不回显远端 message），不连坐主连接；failed 后可重发", () => {
    const { client, ws } = setup();
    handshake(ws);
    client.requestRoots();
    const rid = (ws.sentFrames().at(-1) as { requestId: string }).requestId;
    ws.receive({ t: "error", code: 4402, message: "secret /srv/sessions leak", retryable: false, requestId: rid });
    const r = client.getSnapshot().roots;
    expect(r.status).toBe("failed");
    expect(r.cause).toBe("会话不存在或不可读（4402）"); // 受控文案，远端 message 不进快照
    expect(client.getSnapshot().state).toBe("ready"); // 不连坐主连接状态
    client.requestRoots(); // failed 可重发（新显式动作）
    expect(client.getSnapshot().roots.status).toBe("loading");
    expect(ws.sentFrames().filter((f) => (f as { t: string }).t === "get-roots")).toHaveLength(2);
  });

  it("零副作用门：未请求的 roots-list 忽略；握手前/close 后 requestRoots 静默不发", () => {
    const { client, ws } = setup();
    ws.open(); // authenticating 期
    client.requestRoots();
    expect(ws.sentFrames().filter((f) => (f as { t: string }).t === "get-roots")).toHaveLength(0);
    handshake(ws);
    ws.receive({ t: "roots-list", requestId: "get-roots-1", roots: ROOTS }); // 未请求
    expect(client.getSnapshot().roots.status).toBe("idle");
    client.close();
    expect(() => client.requestRoots()).not.toThrow();
    expect(ws.sentFrames().filter((f) => (f as { t: string }).t === "get-roots")).toHaveLength(0);
  });
});
