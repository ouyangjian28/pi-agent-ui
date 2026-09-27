// @vitest-environment jsdom
// A1b 订阅客户端测试（归属整改重写：Kimi 亲手重写；覆盖=旧版 51 例全部语义面+新增，断言等价或更强）。
// 模式：FakeWebSocket 注入记录帧（无真网络）；快照断言用身份比较（toBe）锁零副作用。
// 覆盖面（对照契约 docs/ws-ui-contracts-v1.md + K3/K4 审报）：
//  握手与初始化（排队/直发/非法文件名/工厂抛错）；subscribe 三分支与游标透传；分页聚合与幂等去重；
//  终局三分支语义（end 末页/error 帧终局/连接级 onclose）；K3-B1/K4 结构化身份路由（终局按
//  subscriptionId+requestId 空串路由，不解析 message 文本）+旧信封兼容；drain 出口 4431 信封专测
//  （K4 发现1 d0de86b 的客户端对应面）；终局信封 12 组合矩阵（4409/4431/4402 × 新/旧信封 × 活动/非活动）；
//  K3-B2 首页在途取消留痕补退订；K3-C2 跨字段/续页绑定一致性；C5 空串 requestId 连接级口径；
//  R 系（形状门坏帧零副作用/受控文案/close 停止屏障）。
import { describe, expect, it } from "vitest";
import { SubscribeClient, type WebSocketLike } from "../../../apps/web/src/ws/subscribe-client";
import type { EventCursor, HistoryEvent, LiveEvent } from "@pi-agent-ui/protocol/src/contracts";

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

const STATUS = {
  session: { sessionId: "s-1", file: "a.jsonl", adapterSessionId: null },
  process: { phase: "running" as const, generation: 1, lastStartResult: null, lastStopResult: null, ready: true },
  turn: { state: "in-flight" as const, intentId: "i-1" },
  backgroundTasks: { availability: "known" as const, activeCount: null },
  reap: { eligible: false, idleElapsedMs: null, idleRemainingMs: null, idleMs: 0 },
  recovery: {
    availability: "available" as const,
    resumeBlocked: null,
    diskBlocked: null,
    unknownEffectCount: null,
    unattributableFragments: null,
    intentsCount: null,
    settledCount: null,
    evidenceHash: null,
  },
  statusVersion: 3,
  serverTimeMs: 1_730_000_000_000,
};

function msg(seq: number, text = `消息 ${seq}`): HistoryEvent {
  return {
    seq,
    ts: null,
    generation: null,
    intentId: null,
    kind: "message",
    entryId: `e-${seq}`,
    role: "user",
    final: true,
    textPreview: { text, truncated: false },
  };
}

function liveProgress(note: "thinking" | "message-start" | "message-end" = "thinking"): LiveEvent {
  return { kind: "pi-progress", piType: "message_update", note };
}

interface PageSpec {
  requestId: string;
  subscriptionId?: string;
  streamId?: string;
  snapshotId?: string;
  /** 快照水位 H（同一快照实例各页 barrier 恒等；非空多页禁用 H=0；空流 H=0 为默认）。 */
  barrier?: number;
  page: Array<HistoryEvent | null>;
  historyNext?: EventCursor | null;
  liveFrom?: EventCursor | null;
  hasMore?: boolean;
}

function pageFrame(spec: PageSpec): unknown {
  return {
    t: "snapshot",
    requestId: spec.requestId,
    subscriptionId: spec.subscriptionId ?? "sub-1",
    streamId: spec.streamId ?? "stream-1",
    snapshotId: spec.snapshotId ?? "snap-1",
    barrier: spec.barrier ?? 0,
    status: STATUS,
    page: spec.page,
    historyNext: spec.historyNext ?? null,
    liveFrom: spec.liveFrom ?? null,
    hasMore: spec.hasMore ?? (spec.historyNext ?? null) !== null,
  };
}

function historyEvents(subscriptionId: string, refSeq: number, events: HistoryEvent[]): unknown {
  return { t: "events", subscriptionId, origin: "history", refSeq, events };
}

function liveEvents(subscriptionId: string, liveSeq: number, events: LiveEvent[]): unknown {
  return { t: "events", subscriptionId, origin: "live", liveSeq, refSeq: null, events };
}

function setup(token = "test-token"): { client: SubscribeClient; ws: FakeWebSocket } {
  FakeWebSocket.reset();
  const client = new SubscribeClient("ws://127.0.0.1:9001/ws", token, (url) => new FakeWebSocket(url));
  client.connect();
  const ws = FakeWebSocket.instances[0]!;
  return { client, ws };
}

function handshake(ws: FakeWebSocket): void {
  ws.open();
  ws.receive(WELCOME);
}

/** ready 后订阅 a.jsonl 并回放两页到末页（H=3；页1: msg1 hasMore / 页2: msg2+msg3 末页 liveFrom={stream-1,4}），进入 live。 */
function livePhase(): {
  client: SubscribeClient;
  ws: FakeWebSocket;
  initRequestId: string;
  pageRequestId: string;
  subscriptionId: string;
} {
  const { client, ws } = setup();
  handshake(ws);
  client.subscribeSession("a.jsonl");
  const initRequestId = (ws.sentFrames()[1] as { requestId: string }).requestId;
  ws.receive(
    pageFrame({ requestId: initRequestId, barrier: 3, page: [msg(1)], historyNext: { streamId: "stream-1", seq: 2 } }),
  );
  const pageRequestId = (ws.sentFrames()[2] as { requestId: string }).requestId;
  ws.receive(
    pageFrame({
      requestId: pageRequestId,
      barrier: 3,
      page: [msg(2), msg(3)],
      historyNext: null,
      liveFrom: { streamId: "stream-1", seq: 4 },
    }),
  );
  return { client, ws, initRequestId, pageRequestId, subscriptionId: "sub-1" };
}

/** 新信封终局帧（K3-B1/K4 结构化身份）：subscriptionId=所停流，requestId 恒空串；message 可含 id 文本但前端不解析。 */
function terminalError(
  code: 4409 | 4431 | 4402,
  subscriptionId: string,
  message = `stream-replaced:${subscriptionId}`,
): unknown {
  return { t: "error", code, message, retryable: code !== 4431, requestId: "", subscriptionId };
}

// ---------------------------------------------------------------------------

describe("握手与初始化订阅", () => {
  it("welcome 前调用=排队（只发 hello）；welcome 后自动发出 {t:subscribe,requestId,file}", () => {
    const { client, ws } = setup();
    client.subscribeSession("a.jsonl");
    ws.open(); // hello 在 open 后才发
    expect(ws.sent).toHaveLength(1); // welcome 前不发订阅帧
    ws.receive(WELCOME);
    expect(ws.sent).toHaveLength(2);
    expect(ws.sentFrames()[1]).toEqual({
      t: "subscribe",
      requestId: expect.stringMatching(/^[\w-]{1,64}$/),
      file: "a.jsonl",
    });
    expect(client.getSnapshot().phase).toBe("subscribing");
    expect(client.getSnapshot().connState).toBe("ready");
  });

  it("ready 后调用=直发初始化帧；requestId 形态合法", () => {
    const { client, ws } = setup();
    handshake(ws);
    client.subscribeSession("b.jsonl");
    expect(ws.sentFrames()[1]).toEqual({
      t: "subscribe",
      requestId: expect.stringMatching(/^[\w-]{1,64}$/),
      file: "b.jsonl",
    });
    expect(client.getSnapshot().phase).toBe("subscribing");
  });

  it("文件名非法：发送前本地拒绝（零帧），受控文案+subscribe-failed；连接保持 ready 可再订阅合法文件", () => {
    const { client, ws } = setup();
    handshake(ws);
    const before = ws.sentFrames().length;
    client.subscribeSession("../etc/passwd");
    expect(ws.sentFrames().length).toBe(before);
    const snap = client.getSnapshot();
    expect(snap.phase).toBe("closed");
    expect(snap.errorKind).toBe("subscribe-failed");
    expect(snap.errorMessage).toContain("文件名非法");
    client.subscribeSession("ok.jsonl");
    expect((ws.sentFrames().at(-1) as { t: string; file: string }).file).toBe("ok.jsonl");
  });

  it("socket 工厂抛错：停止位置位+transport 受控错误；后续 connect/subscribe 全拒绝", () => {
    const client = new SubscribeClient("ws://127.0.0.1:9001/ws", "t", () => {
      throw new Error("no socket");
    });
    client.connect();
    const snap = client.getSnapshot();
    expect(snap.connState).toBe("error");
    expect(snap.errorKind).toBe("transport");
    expect(snap.errorMessage).toContain("连接创建失败");
    client.connect(); // 已停止：幂等拒绝
    expect(client.getSnapshot()).toBe(snap);
  });

  it("重复 connect 幂等（单连接面）；迟到/重复 open 不重发 hello", () => {
    const { client, ws } = setup();
    client.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);
    ws.open();
    ws.open(); // 重复 open
    expect(ws.sentFrames().filter((f) => (f as { t: string }).t === "hello")).toHaveLength(1);
    handshake(ws);
    ws.open(); // ready 后迟到 open
    expect(ws.sentFrames().filter((f) => (f as { t: string }).t === "hello")).toHaveLength(1);
  });
});

describe("subscribe 三分支与游标透传", () => {
  it("分支3 续页：首页 hasMore 后自动发 {t:subscribe,file,snapshotId,historyNext}——游标/snapshotId 严格透传服务端值", () => {
    const { client, ws } = setup();
    handshake(ws);
    client.subscribeSession("a.jsonl");
    const initRequestId = (ws.sentFrames()[1] as { requestId: string }).requestId;
    ws.receive(
      pageFrame({
        requestId: initRequestId,
        snapshotId: "snap-77",
        streamId: "stream-9",
        barrier: 41,
        page: [msg(1)],
        historyNext: { streamId: "stream-9", seq: 41 },
      }),
    );
    expect(ws.sentFrames()[2]).toEqual({
      t: "subscribe",
      requestId: expect.stringMatching(/^[\w-]{1,64}$/),
      file: "a.jsonl",
      snapshotId: "snap-77",
      historyNext: { streamId: "stream-9", seq: 41 }, // 服务端值原样回传，不重算
    });
    expect(client.getSnapshot().phase).toBe("paging");
    expect(client.getSnapshot().cursor).toEqual({ streamId: "stream-9", seq: 41 });
  });

  it("分页聚合到末页（正常终局=end 帧路径）：事件按页累积，末页（historyNext=null+liveFrom）转 live，cursor=liveFrom", () => {
    const { client } = livePhase();
    const snap = client.getSnapshot();
    expect(snap.phase).toBe("live");
    expect(snap.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(snap.cursor).toEqual({ streamId: "stream-1", seq: 4 }); // 末页 liveFrom 原样保留
    expect(snap.status).not.toBeNull();
    expect(snap.subscriptionId).toBe("sub-1");
  });

  it("空会话文件（H=0）：末页 page=[] 且 liveFrom={s,1}——phase=live、events 空、cursor 为续读起点", () => {
    const { client, ws } = setup();
    handshake(ws);
    client.subscribeSession("empty.jsonl");
    const requestId = (ws.sentFrames()[1] as { requestId: string }).requestId;
    ws.receive(
      pageFrame({
        requestId,
        streamId: "stream-e",
        page: [],
        historyNext: null,
        liveFrom: { streamId: "stream-e", seq: 1 },
      }),
    );
    const snap = client.getSnapshot();
    expect(snap.phase).toBe("live");
    expect(snap.events).toHaveLength(0);
    expect(snap.cursor).toEqual({ streamId: "stream-e", seq: 1 });
  });

  it("分支2 重同步：resync-needed 才可发起，发 {t:subscribe,file,cursor}——cursor=末页 liveFrom 严格透传；live 态调用为无操作；liveEvents 重置", () => {
    const { client, ws, subscriptionId } = livePhase();
    ws.receive(liveEvents(subscriptionId, 1, [liveProgress()])); // 先入一条直播事件
    expect(client.getSnapshot().liveEvents).toHaveLength(1);
    const before = ws.sentFrames().length;
    client.resyncFromCursor(); // live 态：不是终局态，不得发起
    expect(ws.sentFrames().length).toBe(before);
    ws.receive({ t: "resync-required", subscriptionId, reason: "server-side-gap" });
    client.resyncFromCursor();
    expect(ws.sentFrames().at(-1)).toEqual({
      t: "subscribe",
      requestId: expect.stringMatching(/^[\w-]{1,64}$/),
      file: "a.jsonl",
      cursor: { streamId: "stream-1", seq: 4 }, // 末页 cursor 原样，不重算
    });
    const snap = client.getSnapshot();
    expect(snap.phase).toBe("subscribing");
    expect(snap.liveEvents).toHaveLength(0); // 瞬时面重置（live 进度不承诺恢复）
    expect(snap.events.map((e) => e.seq)).toEqual([1, 2, 3]); // 历史不重建
  });
});

describe("流式帧：history/live 追加与幂等去重", () => {
  it("events history 追加：帧内/跨帧重复 seq 幂等吸收；全重复帧零通知（快照身份不变）", () => {
    const { client, ws, subscriptionId } = livePhase();
    ws.receive(historyEvents(subscriptionId, 4, [msg(4), msg(4)])); // 帧内重复
    expect(client.getSnapshot().events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    const before = client.getSnapshot();
    ws.receive(historyEvents(subscriptionId, 5, [msg(4)])); // 跨帧重复
    expect(client.getSnapshot()).toBe(before); // 身份比较：无新事件=无新快照
    ws.receive(historyEvents(subscriptionId, 5, [msg(5)]));
    expect(client.getSnapshot().events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("events live 追加：liveSeq 递增投递进 liveEvents；重复/回退 liveSeq 帧忽略；空帧只推进序号不通知", () => {
    const { client, ws, subscriptionId } = livePhase();
    ws.receive(liveEvents(subscriptionId, 1, [liveProgress("thinking"), liveProgress("message-start")]));
    expect(client.getSnapshot().liveEvents).toHaveLength(2);
    const before = client.getSnapshot();
    ws.receive(liveEvents(subscriptionId, 1, [liveProgress()])); // 重复序号
    ws.receive(liveEvents(subscriptionId, 0, [liveProgress()])); // 回退序号（形状门外 but 幂等吸收）
    expect(client.getSnapshot()).toBe(before);
    ws.receive(liveEvents(subscriptionId, 2, [])); // 空帧：序号推进但不通知
    expect(client.getSnapshot()).toBe(before);
    ws.receive(liveEvents(subscriptionId, 3, [liveProgress("message-end")]));
    const snap = client.getSnapshot();
    expect(snap.liveEvents).toHaveLength(3);
    expect(snap.events.map((e) => e.seq)).toEqual([1, 2, 3]); // live 不进历史列
  });

  it("status 帧更新 status（turn/process 变化可见）；非活动订阅的 status 忽略", () => {
    const { client, ws, subscriptionId } = livePhase();
    const next = { ...STATUS, turn: { state: "idle" as const }, statusVersion: 4 };
    ws.receive({ t: "status", subscriptionId, status: next });
    expect(client.getSnapshot().status?.turn.state).toBe("idle");
    const before = client.getSnapshot();
    ws.receive({ t: "status", subscriptionId: "sub-other", status: next });
    expect(client.getSnapshot()).toBe(before);
  });
});

describe("退订与重订阅", () => {
  it("unsubscribeSession：发 {t:unsubscribe,subscriptionId}，phase 回 idle，已有事件保留；此后旧订阅帧不再落地", () => {
    const { client, ws, subscriptionId } = livePhase();
    const eventsBefore = client.getSnapshot().events;
    client.unsubscribeSession();
    const last = ws.sentFrames().at(-1) as { t: string; subscriptionId: string };
    expect(last.t).toBe("unsubscribe");
    expect(last.subscriptionId).toBe(subscriptionId);
    const snap = client.getSnapshot();
    expect(snap.phase).toBe("idle");
    expect(snap.events).toBe(eventsBefore); // 身份相同：退订不清数据
    const frozen = client.getSnapshot();
    ws.receive(historyEvents(subscriptionId, 4, [msg(4)]));
    ws.receive(liveEvents(subscriptionId, 1, [liveProgress()]));
    ws.receive({ t: "status", subscriptionId, status: STATUS });
    expect(client.getSnapshot()).toBe(frozen); // 旧订阅全部帧零副作用
  });

  it("同 file 至多一个活动订阅：重复 subscribeSession 先发 unsubscribe 退旧再建新；旧订阅帧不得再进快照", () => {
    const { client, ws, subscriptionId } = livePhase();
    client.subscribeSession("a.jsonl");
    const frames = ws.sentFrames().slice(-2) as { t: string; subscriptionId?: string; file?: string }[];
    expect(frames[0]).toEqual({ t: "unsubscribe", requestId: expect.any(String), subscriptionId });
    expect(frames[1]).toEqual({ t: "subscribe", requestId: expect.any(String), file: "a.jsonl" });
    const newRequestId = (frames[1] as { requestId: string }).requestId;
    ws.receive(
      pageFrame({
        requestId: newRequestId,
        subscriptionId: "sub-2",
        barrier: 9,
        page: [msg(9)],
        historyNext: null,
        liveFrom: { streamId: "stream-1", seq: 10 },
      }),
    );
    const snap = client.getSnapshot();
    expect(snap.subscriptionId).toBe("sub-2");
    expect(snap.events.map((e) => e.seq)).toEqual([9]); // 新订阅=新快照（旧事件不残留）
    const frozen = client.getSnapshot();
    ws.receive(historyEvents(subscriptionId, 4, [msg(4)])); // 旧订阅流迟到
    ws.receive({ t: "resync-required", subscriptionId, reason: "stream-replaced" }); // 旧订阅替换通知
    expect(client.getSnapshot()).toBe(frozen);
  });
});

describe("订阅终局语义（三分支之 error 帧路径）", () => {
  it("4431 订阅级（带 subscriptionId）：该订阅终局（受控文案），连接保持 ready 且可立即再订阅新文件", () => {
    const { client, ws, subscriptionId } = livePhase();
    ws.receive({ t: "error", code: 4431, subscriptionId, message: "预算炸了", retryable: false });
    const snap = client.getSnapshot();
    expect(snap.phase).toBe("closed");
    expect(snap.errorKind).toBe("stream-terminal");
    expect(snap.errorMessage).toContain("4431");
    expect(snap.connState).toBe("ready"); // 连接不受影响
    expect(snap.events.map((e) => e.seq)).toEqual([1, 2, 3]); // 内容保留
    const frozen = client.getSnapshot();
    ws.receive(liveEvents(subscriptionId, 9, [liveProgress()])); // 旧订阅流不再受理
    expect(client.getSnapshot()).toBe(frozen);
    client.subscribeSession("b.jsonl");
    expect((ws.sentFrames().at(-1) as { t: string; file: string }).file).toBe("b.jsonl");
  });

  it("4431 非活动订阅 id：忽略零副作用", () => {
    const { client, ws } = livePhase();
    const before = client.getSnapshot();
    ws.receive({ t: "error", code: 4431, subscriptionId: "sub-ghost", message: "x", retryable: false });
    expect(client.getSnapshot()).toBe(before);
    expect(before.phase).toBe("live");
  });

  it("4409 stream-replaced（resync-required）：活动订阅被替换后旧流关闭——旧流帧不得再进快照，内容保留", () => {
    const { client, ws, subscriptionId } = livePhase();
    ws.receive({ t: "resync-required", subscriptionId, reason: "stream-replaced" });
    const snap = client.getSnapshot();
    expect(snap.phase).toBe("closed");
    expect(snap.subscriptionId).toBeNull();
    expect(snap.streamNote).toContain("旧流已停止");
    const frozen = client.getSnapshot();
    ws.receive(historyEvents(subscriptionId, 4, [msg(4)]));
    ws.receive(liveEvents(subscriptionId, 2, [liveProgress()]));
    expect(client.getSnapshot()).toBe(frozen);
    expect(snap.events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("server-side-gap（resync-required）：置 resync-needed 保留 events+cursor；不做自动重同步（零新帧）", () => {
    const { client, ws, subscriptionId } = livePhase();
    const sentBefore = ws.sentFrames().length;
    ws.receive({ t: "resync-required", subscriptionId, reason: "server-side-gap" });
    const snap = client.getSnapshot();
    expect(snap.phase).toBe("resync-needed");
    expect(snap.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(snap.cursor).toEqual({ streamId: "stream-1", seq: 4 });
    expect(ws.sentFrames().length).toBe(sentBefore); // 无自动重发
  });

  it("重同步（cursor）请求收 4409：置 resync-needed（events+cursor 不重建）；再手动续读收增量页——重放由 seq 幂等吸收", () => {
    const { client, ws, subscriptionId } = livePhase();
    ws.receive({ t: "resync-required", subscriptionId, reason: "server-side-gap" });
    client.resyncFromCursor();
    const resyncRequestId = (ws.sentFrames().at(-1) as { requestId: string }).requestId;
    ws.receive({ t: "error", code: 4409, requestId: resyncRequestId, message: "快照已过期", retryable: true });
    const snap = client.getSnapshot();
    expect(snap.phase).toBe("resync-needed");
    expect(snap.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(snap.cursor).toEqual({ streamId: "stream-1", seq: 4 });
    // 用户再次显式续读：按末页 cursor 直接续读（无需 snapshotId）
    client.resyncFromCursor();
    expect(ws.sentFrames().at(-1)).toEqual({
      t: "subscribe",
      requestId: expect.any(String),
      file: "a.jsonl",
      cursor: { streamId: "stream-1", seq: 4 },
    });
    const retryRequestId = (ws.sentFrames().at(-1) as { requestId: string }).requestId;
    ws.receive(
      pageFrame({
        requestId: retryRequestId,
        subscriptionId: "sub-3",
        barrier: 4,
        page: [msg(2), msg(4)], // 重放 2 + 增量 4：幂等吸收
        historyNext: null,
        liveFrom: { streamId: "stream-1", seq: 5 },
      }),
    );
    const done = client.getSnapshot();
    expect(done.phase).toBe("live");
    expect(done.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]); // 不重建：原事件在前，增量追加
    expect(done.subscriptionId).toBe("sub-3");
  });

  it("在途 requestId 重复（4404）：订阅终局受控文案，连接保持 ready，可再订阅", () => {
    const { client, ws } = setup();
    handshake(ws);
    client.subscribeSession("a.jsonl");
    const requestId = (ws.sentFrames()[1] as { requestId: string }).requestId;
    ws.receive({ t: "error", code: 4404, requestId, message: "duplicate requestId", retryable: false });
    const snap = client.getSnapshot();
    expect(snap.phase).toBe("closed");
    expect(snap.errorKind).toBe("subscribe-failed");
    expect(snap.errorMessage).toContain("4404");
    expect(snap.connState).toBe("ready");
    client.subscribeSession("a.jsonl");
    expect((ws.sentFrames().at(-1) as { t: string }).t).toBe("subscribe");
  });

  it("请求级失败（4402 会话不存在）：订阅终局+受控文案；连接 ready 保持可订阅其他文件", () => {
    const { client, ws } = setup();
    handshake(ws);
    client.subscribeSession("missing.jsonl");
    const requestId = (ws.sentFrames()[1] as { requestId: string }).requestId;
    ws.receive({ t: "error", code: 4402, requestId, message: "no such session", retryable: false });
    const snap = client.getSnapshot();
    expect(snap.phase).toBe("closed");
    expect(snap.errorKind).toBe("subscribe-failed");
    expect(snap.errorMessage).toContain("4402");
    expect(snap.connState).toBe("ready");
    client.subscribeSession("ok.jsonl");
    expect((ws.sentFrames().at(-1) as { file: string }).file).toBe("ok.jsonl");
  });

  it("无关 requestId 的请求级错误：忽略零副作用，活动流继续", () => {
    const { client, ws, subscriptionId } = livePhase();
    const before = client.getSnapshot();
    ws.receive({ t: "error", code: 4404, requestId: "req-ghost", message: "dup", retryable: false });
    expect(client.getSnapshot()).toBe(before);
    ws.receive(liveEvents(subscriptionId, 2, [liveProgress()]));
    expect(client.getSnapshot().liveEvents).toHaveLength(1);
  });
});

describe("形状门：坏帧零副作用（不污染快照/不消费在途；可续收合法帧）", () => {
  it("坏 snapshot（page 含 null 事件）：整帧忽略、在途保留；同 requestId 合法首页仍落地", () => {
    const { client, ws } = setup();
    handshake(ws);
    client.subscribeSession("a.jsonl");
    const requestId = (ws.sentFrames()[1] as { requestId: string }).requestId;
    const before = client.getSnapshot();
    ws.receive(
      pageFrame({
        requestId,
        barrier: 1,
        page: [msg(1), null],
        historyNext: null,
        liveFrom: { streamId: "stream-1", seq: 2 },
      }),
    );
    expect(client.getSnapshot()).toBe(before);
    expect(client.getSnapshot().phase).toBe("subscribing"); // 在途未被坏帧消耗
    ws.receive(pageFrame({ requestId, page: [msg(1)], historyNext: null, liveFrom: { streamId: "stream-1", seq: 2 } }));
    expect(client.getSnapshot().phase).toBe("live");
    expect(client.getSnapshot().events).toHaveLength(1);
  });

  it("坏 snapshot 末页不变量：historyNext 与 liveFrom 同 null/同非 null 均拒收；随后合法末页仍成功", () => {
    const { client, ws } = setup();
    handshake(ws);
    client.subscribeSession("a.jsonl");
    const requestId = (ws.sentFrames()[1] as { requestId: string }).requestId;
    ws.receive(pageFrame({ requestId, page: [], historyNext: null, liveFrom: null })); // 双 null
    expect(client.getSnapshot().phase).toBe("subscribing");
    ws.receive(
      pageFrame({
        requestId,
        page: [],
        historyNext: { streamId: "stream-1", seq: 2 },
        liveFrom: { streamId: "stream-1", seq: 5 },
        hasMore: true,
      }), // 双非 null
    );
    expect(client.getSnapshot().phase).toBe("subscribing");
    ws.receive(pageFrame({ requestId, page: [], historyNext: null, liveFrom: { streamId: "stream-1", seq: 1 } }));
    expect(client.getSnapshot().phase).toBe("live");
  });

  it("坏 snapshot 游标（seq:0/缺 streamId）：整帧忽略；合法帧仍落地", () => {
    const { client, ws } = setup();
    handshake(ws);
    client.subscribeSession("a.jsonl");
    const requestId = (ws.sentFrames()[1] as { requestId: string }).requestId;
    ws.receive(pageFrame({ requestId, page: [], historyNext: { streamId: "stream-1", seq: 0 }, liveFrom: null }));
    ws.receive(pageFrame({ requestId, page: [], historyNext: { seq: 2 } as unknown as EventCursor, liveFrom: null }));
    expect(client.getSnapshot().phase).toBe("subscribing");
    ws.receive(pageFrame({ requestId, page: [], historyNext: null, liveFrom: { streamId: "stream-1", seq: 1 } }));
    expect(client.getSnapshot().phase).toBe("live");
  });

  it("坏 status（turn.state 非法）：忽略；随后合法 status 落地", () => {
    const { client, ws, subscriptionId } = livePhase();
    const before = client.getSnapshot();
    ws.receive({ t: "status", subscriptionId, status: { ...STATUS, turn: { state: "flying" } } });
    expect(client.getSnapshot()).toBe(before);
    ws.receive({ t: "status", subscriptionId, status: { ...STATUS, statusVersion: 9 } });
    expect(client.getSnapshot().status?.statusVersion).toBe(9);
  });

  it("坏 events（history refSeq:-1 / message role 越枚举 / live 缺 refSeq:null）：逐帧忽略不污染；随后合法帧落地", () => {
    const { client, ws, subscriptionId } = livePhase();
    const before = client.getSnapshot();
    ws.receive(historyEvents(subscriptionId, -1, [msg(4)]));
    ws.receive(historyEvents(subscriptionId, 4, [{ ...msg(4), role: "alien" } as HistoryEvent]));
    ws.receive({ t: "events", subscriptionId, origin: "live", liveSeq: 5, events: [liveProgress()] }); // 缺 refSeq:null
    expect(client.getSnapshot()).toBe(before);
    ws.receive(historyEvents(subscriptionId, 4, [msg(4)]));
    ws.receive(liveEvents(subscriptionId, 5, [liveProgress()]));
    const snap = client.getSnapshot();
    expect(snap.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(snap.liveEvents).toHaveLength(1);
  });

  it("坏 error（未知码 4999/message 为对象/retryable 缺失）：整帧忽略不落错误态；随后合法流程不受影响", () => {
    const { client, ws } = setup();
    handshake(ws);
    client.subscribeSession("a.jsonl");
    const requestId = (ws.sentFrames()[1] as { requestId: string }).requestId;
    const before = client.getSnapshot();
    ws.receive({ t: "error", code: 4999, requestId, message: "x", retryable: false });
    ws.receive({ t: "error", code: 4402, requestId, message: { x: 1 }, retryable: false });
    ws.receive({ t: "error", code: 4402, requestId, message: "x" });
    expect(client.getSnapshot()).toBe(before);
    expect(before.connState).toBe("ready");
    ws.receive(
      pageFrame({
        requestId,
        barrier: 1,
        page: [msg(1)],
        historyNext: null,
        liveFrom: { streamId: "stream-1", seq: 2 },
      }),
    );
    expect(client.getSnapshot().phase).toBe("live");
  });

  it("requestId 不符的 snapshot（迟到页/无关请求）与非活动 subscriptionId 的 events：忽略；合法帧落地", () => {
    const { client, ws, initRequestId, subscriptionId } = livePhase();
    const before = client.getSnapshot();
    ws.receive(
      pageFrame({
        requestId: initRequestId,
        subscriptionId: "sub-late",
        barrier: 9,
        page: [msg(9)],
        historyNext: null,
        liveFrom: { streamId: "stream-1", seq: 10 },
      }),
    );
    ws.receive(historyEvents("sub-ghost", 4, [msg(4)]));
    ws.receive(liveEvents("sub-ghost", 1, [liveProgress()]));
    expect(client.getSnapshot()).toBe(before);
    ws.receive(historyEvents(subscriptionId, 4, [msg(4)]));
    expect(client.getSnapshot().events).toHaveLength(4);
  });

  it("未知帧（sessions/写类 ack/pong）与非 JSON/数组外壳/二进制：安全忽略不抛错；畸形 welcome 不触发排队订阅", () => {
    const { client, ws } = setup();
    client.subscribeSession("a.jsonl"); // 排队
    ws.open();
    const badWelcome = { t: "welcome", serverBootId: "b", protocolVersion: 1 }; // 缺 serverBuildId
    ws.receive(badWelcome);
    expect(ws.sent).toHaveLength(1); // 未自动发订阅
    expect(() => {
      ws.receive({
        t: "sessions",
        requestId: "r",
        sessions: [],
        total: 0,
        offset: 0,
        hasMore: false,
        listVersion: 1,
        listReliability: "full",
      });
      ws.receive({ t: "write-ack", requestId: "w1", file: "a.jsonl", outcome: { kind: "busy" } });
      ws.receive({ t: "pong", nonce: "n" });
      ws.receiveRaw("not json");
      ws.receiveRaw(JSON.stringify([1, 2]));
      ws.receiveRaw(new ArrayBuffer(4));
    }).not.toThrow();
    expect(client.getSnapshot().connState).toBe("authenticating");
    ws.receive(WELCOME);
    expect(ws.sentFrames()[1]).toEqual({ t: "subscribe", requestId: expect.any(String), file: "a.jsonl" });
  });
});

describe("受控错误文案（远端 error.message 永不进快照）", () => {
  const SENTINEL = "secret-token-sentinel";

  it("4402 message 回显 token：快照只存受控文案，全字段序列化不含 token；错误后旧流帧零副作用", () => {
    const { client, ws } = setup();
    handshake(ws);
    client.subscribeSession("a.jsonl");
    const requestId = (ws.sentFrames()[1] as { requestId: string }).requestId;
    ws.receive({ t: "error", code: 4402, requestId, message: `session not found: ${SENTINEL}`, retryable: false });
    const snap = client.getSnapshot();
    expect(snap.errorMessage).toContain("4402");
    expect(JSON.stringify(snap)).not.toContain(SENTINEL);
    const frozen = client.getSnapshot();
    ws.receive(pageFrame({ requestId, page: [msg(1)], historyNext: null, liveFrom: { streamId: "stream-1", seq: 2 } }));
    expect(client.getSnapshot()).toBe(frozen); // 在途已清：迟到回包不落地
  });

  it("4431 message 回显 token：终局态快照序列化不含 token", () => {
    const { client, ws, subscriptionId } = livePhase();
    ws.receive({ t: "error", code: 4431, subscriptionId, message: `budget blown ${SENTINEL}`, retryable: false });
    const snap = client.getSnapshot();
    expect(snap.errorKind).toBe("stream-terminal");
    expect(JSON.stringify(snap)).not.toContain(SENTINEL);
  });

  it("连接级失败（4432）message 回显 token：快照受控文案不含 token", () => {
    const { client, ws } = livePhase();
    ws.receive({ t: "error", code: 4432, message: `heartbeat ${SENTINEL}`, retryable: true });
    const snap = client.getSnapshot();
    expect(snap.connState).toBe("error");
    expect(JSON.stringify(snap)).not.toContain(SENTINEL);
  });
});

describe("close 停止屏障与连接级终局（三分支之连接级路径）", () => {
  it("live 态主动 close：迟到帧零副作用、重复 close 幂等、close 后 subscribeSession 拒绝", () => {
    const { client, ws, subscriptionId } = livePhase();
    client.close();
    const frozen = client.getSnapshot();
    expect(frozen.connState).toBe("closed");
    expect(ws.closeCount).toBe(1);
    ws.receive(liveEvents(subscriptionId, 5, [liveProgress()]));
    expect(client.getSnapshot()).toBe(frozen);
    client.close();
    expect(ws.closeCount).toBe(1);
    client.subscribeSession("b.jsonl");
    expect(ws.sent).toHaveLength(3); // 全程仅 hello+订阅+续页——停止后无新帧
  });

  it("onerror 后必跟 onclose：连接级错误归 onclose 统一出口（error 帧本身不改态）", () => {
    const { client, ws, subscriptionId } = livePhase();
    const before = client.getSnapshot();
    ws.onerror?.();
    expect(client.getSnapshot()).toBe(before); // onerror 零副作用
    ws.serverClose(1006);
    const snap = client.getSnapshot();
    expect(snap.connState).toBe("closed");
    expect(snap.events.map((e) => e.seq)).toEqual([1, 2, 3]); // 内容保留
    const frozen = client.getSnapshot();
    ws.receive(historyEvents(subscriptionId, 4, [msg(4)]));
    expect(client.getSnapshot()).toBe(frozen); // 连接终态后帧零受理
  });

  it("握手期 4401→auth-failed（连接级）；ready 后服务端 1008 关闭→closed 终态（无自动重连）", () => {
    const first = setup("bad");
    first.ws.open();
    first.ws.receive({ t: "error", code: 4401, message: "未认证", retryable: false });
    expect(first.client.getSnapshot().connState).toBe("error");
    expect(first.client.getSnapshot().errorKind).toBe("auth-failed");
    first.ws.serverClose(1008);
    expect(first.client.getSnapshot().connState).toBe("error"); // 不降级

    const { client, ws } = livePhase();
    ws.serverClose(1008);
    expect(client.getSnapshot().connState).toBe("closed");
    expect(ws.sentFrames().length).toBeLessThanOrEqual(3); // 无重连帧
  });

  it("握手期非 4401 错误（如 4403）→handshake-failed；握手期 1008 关闭→auth-failed", () => {
    const { client, ws } = setup();
    ws.open();
    ws.receive({ t: "error", code: 4403, message: "version", retryable: false });
    expect(client.getSnapshot().connState).toBe("error");
    expect(client.getSnapshot().errorKind).toBe("handshake-failed");
    expect(client.getSnapshot().errorMessage).toContain("4403");
    const second = setup();
    second.ws.open();
    second.ws.serverClose(1008);
    expect(second.client.getSnapshot().errorKind).toBe("auth-failed");
  });
});

describe("K3-B2 首页在途取消：留痕补退订（迟到首页绝不写快照、绝不清当前 file 订阅）", () => {
  it("首包前退订/卸载：在途初始化留痕——迟到首页只触发补发 unsubscribe（订阅 id 由首页识别），快照零污染；其后该订阅帧零受理", () => {
    const { client, ws } = setup();
    handshake(ws);
    client.subscribeSession("a.jsonl");
    const initRequestId = (ws.sentFrames()[1] as { requestId: string }).requestId;
    client.unsubscribeSession(); // 首包前退订（无活动订阅：此刻无退订帧可发）
    expect((ws.sentFrames().at(-1) as { t: string }).t).toBe("subscribe"); // 仍只有 hello+subscribe
    ws.receive(
      pageFrame({
        requestId: initRequestId,
        subscriptionId: "sub-late",
        streamId: "stream-1",
        barrier: 1,
        page: [msg(1)],
        historyNext: null,
        liveFrom: { streamId: "stream-1", seq: 2 },
      }),
    );
    const snap = client.getSnapshot();
    expect(snap.phase).toBe("idle"); // 未被迟到页改写
    expect(snap.events).toHaveLength(0);
    expect(snap.subscriptionId).toBeNull();
    expect(snap.cursor).toBeNull();
    expect(ws.sentFrames().at(-1)).toEqual({
      t: "unsubscribe",
      requestId: expect.any(String),
      subscriptionId: "sub-late",
    });
    const frozen = client.getSnapshot();
    ws.receive(historyEvents("sub-late", 2, [msg(2)]));
    ws.receive(liveEvents("sub-late", 1, [liveProgress()]));
    ws.receive({ t: "status", subscriptionId: "sub-late", status: STATUS });
    expect(client.getSnapshot()).toBe(frozen); // 补退订后：该订阅全部帧零副作用
  });

  it("A→B→A 往返：A/B 各自迟到首页只补退订各自订阅；二次 A 首页正常落地且当前 file 订阅续流不受影响", () => {
    const { client, ws } = setup();
    handshake(ws);
    client.subscribeSession("a.jsonl"); // init-1 在途
    client.subscribeSession("b.jsonl"); // init-2 在途（init-1 作废留痕）
    client.subscribeSession("a.jsonl"); // init-3 在途（init-2 作废留痕）
    const [initA1, initB, initA2] = (ws.sentFrames().slice(1) as { requestId: string }[]).map((f) => f.requestId);
    const beforeLate = client.getSnapshot();
    expect(beforeLate.file).toBe("a.jsonl");
    expect(beforeLate.events).toHaveLength(0);
    ws.receive(
      pageFrame({
        requestId: initA1,
        subscriptionId: "sub-a1",
        streamId: "stream-a",
        barrier: 1,
        page: [msg(1)],
        historyNext: null,
        liveFrom: { streamId: "stream-a", seq: 2 },
      }),
    );
    expect(ws.sentFrames().at(-1)).toEqual({
      t: "unsubscribe",
      requestId: expect.any(String),
      subscriptionId: "sub-a1",
    });
    expect(client.getSnapshot().file).toBe("a.jsonl");
    expect(client.getSnapshot().events).toHaveLength(0); // 绝不写当前快照
    expect(client.getSnapshot().phase).toBe("subscribing"); // 当前在途（init-3）绝不被清
    ws.receive(
      pageFrame({
        requestId: initB,
        subscriptionId: "sub-b1",
        streamId: "stream-b",
        barrier: 7,
        page: [msg(7)],
        historyNext: null,
        liveFrom: { streamId: "stream-b", seq: 8 },
      }),
    );
    expect(ws.sentFrames().at(-1)).toEqual({
      t: "unsubscribe",
      requestId: expect.any(String),
      subscriptionId: "sub-b1",
    });
    ws.receive(
      pageFrame({
        requestId: initA2,
        subscriptionId: "sub-a2",
        streamId: "stream-a",
        barrier: 1,
        page: [msg(1)],
        historyNext: null,
        liveFrom: { streamId: "stream-a", seq: 2 },
      }),
    );
    const snap = client.getSnapshot();
    expect(snap.phase).toBe("live");
    expect(snap.subscriptionId).toBe("sub-a2");
    expect(snap.events.map((e) => e.seq)).toEqual([1]);
    expect(snap.cursor).toEqual({ streamId: "stream-a", seq: 2 });
    ws.receive(historyEvents("sub-a2", 2, [msg(2)])); // 当前流续读不受影响
    expect(client.getSnapshot().events.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("failSubscription 残留：本地终局的活动订阅补发退订帧；本地拒绝丢弃的建订在途同样留痕补退订", () => {
    // ① 活动订阅 + 非法文件名调用：退订帧必须发出
    const live = livePhase();
    live.client.subscribeSession("../etc/passwd");
    expect(live.ws.sentFrames().at(-1)).toEqual({
      t: "unsubscribe",
      requestId: expect.any(String),
      subscriptionId: live.subscriptionId,
    });
    // ② 建订在途 + 非法文件名调用：在途留痕，迟到首页补退订且不落快照
    const { client, ws } = setup();
    handshake(ws);
    client.subscribeSession("a.jsonl");
    const initRequestId = (ws.sentFrames()[1] as { requestId: string }).requestId;
    client.subscribeSession("../bad"); // 本地拒绝：目标 file 不变，订阅终局
    expect(client.getSnapshot().errorKind).toBe("subscribe-failed");
    ws.receive(
      pageFrame({
        requestId: initRequestId,
        subscriptionId: "sub-x",
        streamId: "stream-1",
        barrier: 1,
        page: [msg(1)],
        historyNext: null,
        liveFrom: { streamId: "stream-1", seq: 2 },
      }),
    );
    expect(ws.sentFrames().at(-1)).toEqual({
      t: "unsubscribe",
      requestId: expect.any(String),
      subscriptionId: "sub-x",
    });
    const snap = client.getSnapshot();
    expect(snap.phase).toBe("closed"); // 迟到首页未改写终局
    expect(snap.events).toHaveLength(0);
  });

  it("畸形迟到首页（已取消建订）：形状门先拒——连退订帧都不发（坏帧不触发补退订义务）", () => {
    const { client, ws } = setup();
    handshake(ws);
    client.subscribeSession("a.jsonl");
    const initRequestId = (ws.sentFrames()[1] as { requestId: string }).requestId;
    client.unsubscribeSession();
    const before = ws.sentFrames().length;
    ws.receive(
      pageFrame({
        requestId: initRequestId,
        subscriptionId: "sub-late",
        barrier: 1,
        page: [null],
        historyNext: null,
        liveFrom: { streamId: "stream-1", seq: 2 },
      }),
    );
    expect(ws.sentFrames().length).toBe(before); // 零副作用
    expect(client.getSnapshot().phase).toBe("idle");
  });
});

describe("K3-C2 跨字段/续页实例绑定一致性（矛盾帧拒绝后可恢复续读）", () => {
  it("hasMore 与末页不变量矛盾（末页却 hasMore=true / 非末页却 hasMore=false）：整帧拒绝零消费；同 requestId 一致帧恢复续读", () => {
    const { client, ws } = setup();
    handshake(ws);
    client.subscribeSession("a.jsonl");
    const requestId = (ws.sentFrames()[1] as { requestId: string }).requestId;
    const before = client.getSnapshot();
    ws.receive(
      pageFrame({
        requestId,
        barrier: 1,
        page: [msg(1)],
        historyNext: null,
        liveFrom: { streamId: "stream-1", seq: 2 },
        hasMore: true,
      }),
    );
    ws.receive(
      pageFrame({
        requestId,
        barrier: 1,
        page: [msg(1)],
        historyNext: { streamId: "stream-1", seq: 2 },
        liveFrom: null,
        hasMore: false,
      }),
    );
    expect(client.getSnapshot()).toBe(before);
    expect(client.getSnapshot().cursor).toBeNull(); // 矛盾帧游标不得成为下一游标
    ws.receive(
      pageFrame({
        requestId,
        barrier: 1,
        page: [msg(1)],
        historyNext: { streamId: "stream-1", seq: 2 },
        liveFrom: null,
        hasMore: true,
      }),
    );
    expect(client.getSnapshot().phase).toBe("paging");
    expect(client.getSnapshot().cursor).toEqual({ streamId: "stream-1", seq: 2 });
  });

  it("跨流游标（historyNext.streamId ≠ frame.streamId）：整帧拒绝，不得成为下一游标；本流一致帧恢复续读", () => {
    const { client, ws } = setup();
    handshake(ws);
    client.subscribeSession("a.jsonl");
    const requestId = (ws.sentFrames()[1] as { requestId: string }).requestId;
    const before = client.getSnapshot();
    ws.receive(
      pageFrame({
        requestId,
        streamId: "stream-1",
        barrier: 1,
        page: [msg(1)],
        historyNext: { streamId: "stream-other", seq: 2 },
      }),
    );
    expect(client.getSnapshot()).toBe(before);
    expect(client.getSnapshot().cursor).toBeNull();
    ws.receive(
      pageFrame({
        requestId,
        streamId: "stream-1",
        barrier: 1,
        page: [msg(1)],
        historyNext: { streamId: "stream-1", seq: 2 },
      }),
    );
    expect(client.getSnapshot().phase).toBe("paging");
    expect(ws.sentFrames()[2]).toMatchObject({
      t: "subscribe",
      snapshotId: "snap-1",
      historyNext: { streamId: "stream-1", seq: 2 },
    });
  });

  it("续页实例绑定：snapshotId/streamId/barrier/subscriptionId 与当前快照实例不符的续页帧拒绝（不消费在途）；绑定一致帧恢复续读到末页", () => {
    const { client, ws } = setup();
    handshake(ws);
    client.subscribeSession("a.jsonl");
    const initRequestId = (ws.sentFrames()[1] as { requestId: string }).requestId;
    ws.receive(
      pageFrame({
        requestId: initRequestId,
        barrier: 3,
        page: [msg(1)],
        historyNext: { streamId: "stream-1", seq: 2 },
      }),
    );
    const pageRequestId = (ws.sentFrames()[2] as { requestId: string }).requestId;
    const paging = client.getSnapshot();
    // 绑定不一致四连：snapshotId / streamId / barrier / subscriptionId 各错一档
    ws.receive(
      pageFrame({
        requestId: pageRequestId,
        snapshotId: "snap-other",
        barrier: 3,
        page: [msg(2)],
        historyNext: null,
        liveFrom: { streamId: "stream-1", seq: 4 },
      }),
    );
    ws.receive(
      pageFrame({
        requestId: pageRequestId,
        streamId: "stream-x",
        barrier: 3,
        page: [msg(2)],
        historyNext: null,
        liveFrom: { streamId: "stream-x", seq: 4 },
      }),
    );
    ws.receive(
      pageFrame({
        requestId: pageRequestId,
        barrier: 9,
        page: [msg(2)],
        historyNext: null,
        liveFrom: { streamId: "stream-1", seq: 4 },
      }),
    );
    ws.receive(
      pageFrame({
        requestId: pageRequestId,
        subscriptionId: "sub-2",
        barrier: 3,
        page: [msg(2)],
        historyNext: null,
        liveFrom: { streamId: "stream-1", seq: 4 },
      }),
    );
    expect(client.getSnapshot()).toBe(paging); // 全部拒绝：相位/游标/在途不变
    expect(ws.sentFrames().length).toBe(3); // 未发新帧（在途未被消费也未重发）
    ws.receive(
      pageFrame({
        requestId: pageRequestId,
        barrier: 3,
        page: [msg(2), msg(3)],
        historyNext: null,
        liveFrom: { streamId: "stream-1", seq: 4 },
      }),
    );
    const done = client.getSnapshot();
    expect(done.phase).toBe("live");
    expect(done.events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });
});

describe("C5 连接级错误映射（ready 后无 requestId 关联的连接级码；空串=服务端 errFrame 无关联惯例）", () => {
  it("4432/4403 无 requestId：进连接级失败——connState=error、transport、受控文案含码（4432 心跳原因不丢）；内容保留、其后帧零受理", () => {
    const { client, ws, subscriptionId } = livePhase();
    const eventsBefore = client.getSnapshot().events;
    ws.receive({ t: "error", code: 4432, message: "heartbeat dead", retryable: false });
    let snap = client.getSnapshot();
    expect(snap.connState).toBe("error");
    expect(snap.errorKind).toBe("transport");
    expect(snap.errorMessage).toContain("4432");
    expect(snap.events).toBe(eventsBefore);
    const frozen = client.getSnapshot();
    ws.receive(liveEvents(subscriptionId, 2, [liveProgress()]));
    expect(client.getSnapshot()).toBe(frozen);
    const again = livePhase();
    again.ws.receive({ t: "error", code: 4403, message: "version", retryable: false });
    snap = again.client.getSnapshot();
    expect(snap.connState).toBe("error");
    expect(snap.errorKind).toBe("transport");
    expect(snap.errorMessage).toContain("4403");
  });

  it('空串口径：4403/4432 带 requestId=""（非缺省）→ 同入连接级失败（transport）受控文案', () => {
    const { client, ws } = livePhase();
    ws.receive({ t: "error", code: 4432, message: "heartbeat dead", retryable: false, requestId: "" });
    let snap = client.getSnapshot();
    expect(snap.connState).toBe("error");
    expect(snap.errorKind).toBe("transport");
    expect(snap.errorMessage).toContain("4432");
    const again = livePhase();
    again.ws.receive({ t: "error", code: 4403, message: "version", retryable: false, requestId: "" });
    snap = again.client.getSnapshot();
    expect(snap.connState).toBe("error");
    expect(snap.errorKind).toBe("transport");
    expect(snap.errorMessage).toContain("4403");
  });

  it("边界：4413/4429 无 requestId 不升级连接级（请求级码无关联时忽略零副作用）", () => {
    const { client, ws, subscriptionId } = livePhase();
    const before = client.getSnapshot();
    ws.receive({ t: "error", code: 4413, message: "x", retryable: false });
    ws.receive({ t: "error", code: 4429, message: "x", retryable: false });
    ws.receive({ t: "error", code: 4405, message: "x", retryable: false, requestId: "req-unrelated" }); // 非空且不在途
    expect(client.getSnapshot()).toBe(before);
    ws.receive(liveEvents(subscriptionId, 2, [liveProgress()])); // 流未被误伤
    expect(client.getSnapshot().liveEvents).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// K3-B1/K4 结构化身份路由：终局帧按 subscriptionId（+requestId 恒空串）路由，不按文本匹配。
// ---------------------------------------------------------------------------
describe("K3-B1 终局帧结构化路由（新信封）", () => {
  it('K3 P1 回归：同 file 重订阅时退旧终局 4409{subscriptionId=旧, requestId=""} 不冒充新请求失败，随后新 snapshot 正常落地', () => {
    const { client, ws, subscriptionId } = livePhase();
    client.subscribeSession("a.jsonl"); // 同 file 重订阅：本地先退旧 sub-1 + 新 init 在途
    const newRequestId = (ws.sentFrames().at(-1) as { requestId: string }).requestId;
    ws.receive(terminalError(4409, subscriptionId)); // 服务端退旧终局：指认旧流
    let snap = client.getSnapshot();
    expect(snap.phase).toBe("subscribing"); // 新建订未被终局误伤
    expect(snap.errorKind).toBeNull();
    expect(snap.errorMessage).toBeNull();
    ws.receive(
      pageFrame({
        requestId: newRequestId,
        subscriptionId: "sub-2",
        barrier: 9,
        page: [msg(9)],
        historyNext: null,
        liveFrom: { streamId: "stream-1", seq: 10 },
      }),
    );
    snap = client.getSnapshot();
    expect(snap.phase).toBe("live"); // 合法新 snapshot 不再被丢
    expect(snap.subscriptionId).toBe("sub-2");
    expect(snap.events.map((e) => e.seq)).toEqual([9]);
    const frozen = client.getSnapshot();
    ws.receive(historyEvents(subscriptionId, 4, [msg(4)]));
    expect(client.getSnapshot()).toBe(frozen);
  });

  it('4431 终局（新信封全形态 requestId=""）：流终局视图（stream-terminal+内容保留），连接 ready，可再订阅', () => {
    const { client, ws, subscriptionId } = livePhase();
    const eventsBefore = client.getSnapshot().events;
    ws.receive(terminalError(4431, subscriptionId, "订阅积压超限"));
    const snap = client.getSnapshot();
    expect(snap.phase).toBe("closed");
    expect(snap.errorKind).toBe("stream-terminal");
    expect(snap.errorMessage).toContain("4431");
    expect(snap.connState).toBe("ready");
    expect(snap.events).toBe(eventsBefore);
    const frozen = client.getSnapshot();
    ws.receive(liveEvents(subscriptionId, 9, [liveProgress()]));
    expect(client.getSnapshot()).toBe(frozen);
    client.subscribeSession("b.jsonl");
    expect((ws.sentFrames().at(-1) as { t: string }).t).toBe("subscribe");
  });

  it("4402 流终局容量出口（带 subscriptionId）：按流终局路由（stream-terminal）而非请求级「会话不存在」——内容保留、连接 ready", () => {
    const { client, ws, subscriptionId } = livePhase();
    ws.receive(terminalError(4402, subscriptionId, "watcher 预算超限"));
    const snap = client.getSnapshot();
    expect(snap.phase).toBe("closed");
    expect(snap.errorKind).toBe("stream-terminal");
    expect(snap.errorMessage).toContain("4402");
    expect(snap.connState).toBe("ready");
    expect(snap.events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("4409 终局落当前活动流（observe-missed/磁盘换流）：置 resync-needed 保留快照+cursor，旧流帧零受理；手动续读按 cursor 建新流", () => {
    const { client, ws, subscriptionId } = livePhase();
    ws.receive(terminalError(4409, subscriptionId));
    const snap = client.getSnapshot();
    expect(snap.phase).toBe("resync-needed");
    expect(snap.subscriptionId).toBe("sub-1"); // 快照字段保留（展示口径）；内部活动流已退役（下证：旧流帧零受理）
    expect(snap.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(snap.cursor).toEqual({ streamId: "stream-1", seq: 4 });
    expect(snap.errorKind).toBeNull(); // 流终局≠请求失败
    const frozen = client.getSnapshot();
    ws.receive(liveEvents(subscriptionId, 9, [liveProgress()]));
    expect(client.getSnapshot()).toBe(frozen);
    client.resyncFromCursor();
    const resyncRequestId = (ws.sentFrames().at(-1) as { requestId: string }).requestId;
    ws.receive(
      pageFrame({
        requestId: resyncRequestId,
        subscriptionId: "sub-3",
        barrier: 4,
        page: [msg(4)],
        historyNext: null,
        liveFrom: { streamId: "stream-1", seq: 5 },
      }),
    );
    const done = client.getSnapshot();
    expect(done.phase).toBe("live");
    expect(done.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]); // 续读不重建
  });

  it("message 文本不参与路由：终局帧 message 里的 id 与结构化字段不一致时，路由仍按 subscriptionId 字段", () => {
    const { client, ws, subscriptionId } = livePhase();
    ws.receive({
      t: "error",
      code: 4409,
      message: "stream-replaced:sub-DECOY", // 文本诱饵：与字段不一致
      retryable: true,
      requestId: "",
      subscriptionId,
    });
    expect(client.getSnapshot().phase).toBe("resync-needed"); // 按字段命中活动流，不被文本带偏
  });

  it("A→B→A 换流（新信封）：每次换流的服务端退旧终局 4409 均被本地先行退役吸收（不伤新在途），三段订阅各自正确落地", () => {
    const { client, ws } = setup();
    handshake(ws);
    client.subscribeSession("a.jsonl");
    const a1 = (ws.sentFrames()[1] as { requestId: string }).requestId;
    ws.receive(
      pageFrame({
        requestId: a1,
        subscriptionId: "sub-a1",
        streamId: "stream-a",
        barrier: 1,
        page: [msg(1)],
        historyNext: null,
        liveFrom: { streamId: "stream-a", seq: 2 },
      }),
    );
    expect(client.getSnapshot().subscriptionId).toBe("sub-a1");
    client.subscribeSession("b.jsonl");
    const bInit = (ws.sentFrames().at(-1) as { requestId: string }).requestId;
    ws.receive(terminalError(4409, "sub-a1")); // 已退役→忽略
    expect(client.getSnapshot().phase).toBe("subscribing");
    ws.receive(
      pageFrame({
        requestId: bInit,
        subscriptionId: "sub-b1",
        streamId: "stream-b",
        barrier: 7,
        page: [msg(7)],
        historyNext: null,
        liveFrom: { streamId: "stream-b", seq: 8 },
      }),
    );
    expect(client.getSnapshot().subscriptionId).toBe("sub-b1");
    expect(client.getSnapshot().events.map((e) => e.seq)).toEqual([7]);
    client.subscribeSession("a.jsonl");
    const a2 = (ws.sentFrames().at(-1) as { requestId: string }).requestId;
    ws.receive(terminalError(4409, "sub-b1"));
    ws.receive(
      pageFrame({
        requestId: a2,
        subscriptionId: "sub-a2",
        streamId: "stream-a",
        barrier: 1,
        page: [msg(1)],
        historyNext: null,
        liveFrom: { streamId: "stream-a", seq: 2 },
      }),
    );
    const snap = client.getSnapshot();
    expect(snap.subscriptionId).toBe("sub-a2");
    expect(snap.events.map((e) => e.seq)).toEqual([1]);
    const frozen = client.getSnapshot();
    ws.receive(historyEvents("sub-a1", 2, [msg(2)]));
    ws.receive(historyEvents("sub-b1", 9, [msg(9)]));
    expect(client.getSnapshot()).toBe(frozen); // 两代旧流帧均零受理
  });

  it("B2 兼容：终局帧不豁免迟到首页补退订——已取消建订的流先收终局（忽略），迟到首页仍补发 unsubscribe", () => {
    const { client, ws } = setup();
    handshake(ws);
    client.subscribeSession("a.jsonl");
    const initRequestId = (ws.sentFrames()[1] as { requestId: string }).requestId;
    client.unsubscribeSession();
    ws.receive(terminalError(4409, "sub-late")); // 无活动订阅→忽略
    expect(client.getSnapshot().phase).toBe("idle");
    ws.receive(
      pageFrame({
        requestId: initRequestId,
        subscriptionId: "sub-late",
        streamId: "stream-1",
        barrier: 1,
        page: [msg(1)],
        historyNext: null,
        liveFrom: { streamId: "stream-1", seq: 2 },
      }),
    );
    expect(ws.sentFrames().at(-1)).toEqual({
      t: "unsubscribe",
      requestId: expect.any(String),
      subscriptionId: "sub-late",
    });
    expect(client.getSnapshot().events).toHaveLength(0);
  });

  it("K4 发现1 drain 出口形态（4431+subscriptionId+requestId 空串）：按流终局处理——连接保持 ready，内容保留", () => {
    // 服务端 subscription-engine drain overBudget 出口与 close() 终局信封统一（d0de86b）：
    // 客户端侧只需认结构化身份——本例锁定「drain 形态信封=订阅终局」的消费语义（服务端⑲b的客户端对应面）。
    const { client, ws, subscriptionId } = livePhase();
    const eventsBefore = client.getSnapshot().events;
    ws.receive({
      t: "error",
      code: 4431,
      message: "outbound frame over budget",
      retryable: false,
      requestId: "",
      subscriptionId,
    });
    const snap = client.getSnapshot();
    expect(snap.phase).toBe("closed");
    expect(snap.errorKind).toBe("stream-terminal");
    expect(snap.errorMessage).toContain("4431");
    expect(snap.connState).toBe("ready");
    expect(snap.events).toBe(eventsBefore);
  });
});

describe("终局信封 12 组合矩阵（4409/4431/4402 × 新信封/旧信封 × 活动流/非活动流）", () => {
  const CASES: Array<{
    code: 4409 | 4431 | 4402;
    phase: "resync-needed" | "closed";
    errorKind: "stream-terminal" | null;
  }> = [
    { code: 4409, phase: "resync-needed", errorKind: null },
    { code: 4431, phase: "closed", errorKind: "stream-terminal" },
    { code: 4402, phase: "closed", errorKind: "stream-terminal" },
  ];
  for (const { code, phase, errorKind } of CASES) {
    it(`${code} 新信封×活动流：按 subscriptionId 终局（${phase}），连接 ready 内容保留`, () => {
      const { client, ws, subscriptionId } = livePhase();
      ws.receive(terminalError(code, subscriptionId));
      const snap = client.getSnapshot();
      expect(snap.phase).toBe(phase);
      expect(snap.errorKind).toBe(errorKind);
      expect(snap.connState).toBe("ready");
      expect(snap.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    });

    it(`${code} 新信封×非活动流：忽略零副作用（防串流）`, () => {
      const { client, ws, subscriptionId } = livePhase();
      const before = client.getSnapshot();
      ws.receive(terminalError(code, "sub-ghost"));
      expect(client.getSnapshot()).toBe(before);
      expect(before.phase).toBe("live");
      ws.receive(liveEvents(subscriptionId, 2, [liveProgress()])); // 活动流不受影响
      expect(client.getSnapshot().liveEvents).toHaveLength(1);
    });

    it(`${code} 旧信封（无 subscriptionId、requestId 空串/缺省）×活动流：按当前活动流终局（${phase}）`, () => {
      const { client, ws } = livePhase();
      ws.receive({ t: "error", code, message: "legacy", retryable: code !== 4431, requestId: "" });
      expect(client.getSnapshot().phase).toBe(phase);
      expect(client.getSnapshot().connState).toBe("ready");
      const second = livePhase();
      second.ws.receive({ t: "error", code, message: "legacy", retryable: code !== 4431 }); // requestId 整体缺省同判
      expect(second.client.getSnapshot().phase).toBe(phase);
      expect(second.client.getSnapshot().connState).toBe("ready");
    });

    it(`${code} 旧信封×无活动流（首包前/已退订）：忽略零副作用，不误伤在途 init`, () => {
      const { client, ws } = setup();
      handshake(ws);
      client.subscribeSession("a.jsonl");
      const before = client.getSnapshot();
      ws.receive({ t: "error", code, message: "x", retryable: code !== 4431, requestId: "" });
      expect(client.getSnapshot()).toBe(before);
      expect(before.phase).toBe("subscribing");
    });
  }
});
