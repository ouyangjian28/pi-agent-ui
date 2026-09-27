// @vitest-environment jsdom
// A1b 订阅客户端测试：FakeWebSocket 注入（同 ws-client.test.ts 模式）。覆盖验收点：
// ①subscribe 三分支（初始化/重同步 cursor/续页 snapshotId+historyNext）②unsubscribe ③流式帧
// （snapshot 分页→末页 liveFrom→history/live events 追加幂等）④终局语义（4431 订阅级 close 连接不受影响/
// 4409 stream-replaced 旧流不进快照/末页 60s 宽限重试收 4409=按末页 cursor 续读不重建）⑤同 file 至多一个
// 活动订阅+在途 4404 不崩 ⑥cursor 严格透传服务端值 ⑦R1 消费帧运行时校验（坏帧零副作用可续收）⑧R2 受控
// 文案（error.message 不进快照）⑨R3 close 停止屏障简版。快照断言用身份比较（toBe）。
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

// ---- 帧构造器（合法域；畸形由各测试内联覆盖） ----

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
  return { seq, ts: null, generation: null, intentId: null, kind: "message", entryId: `e-${seq}`, role: "user", final: true, textPreview: { text, truncated: false } };
}

function liveProgress(note: "thinking" | "message-start" | "message-end" = "thinking"): LiveEvent {
  return { kind: "pi-progress", piType: "message_update", note };
}

interface PageSpec {
  requestId: string;
  subscriptionId?: string;
  streamId?: string;
  snapshotId?: string;
  page: HistoryEvent[];
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
    barrier: 0,
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

/** ready 后订阅 a.jsonl 并回放两页到末页（页1: msg1 hasMore / 页2: msg2+msg3 末页 liveFrom={stream-1,4}），进入 live。 */
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
  ws.receive(pageFrame({ requestId: initRequestId, page: [msg(1)], historyNext: { streamId: "stream-1", seq: 2 } }));
  const pageRequestId = (ws.sentFrames()[2] as { requestId: string }).requestId;
  ws.receive(
    pageFrame({
      requestId: pageRequestId,
      page: [msg(2), msg(3)],
      historyNext: null,
      liveFrom: { streamId: "stream-1", seq: 4 },
    }),
  );
  return { client, ws, initRequestId, pageRequestId, subscriptionId: "sub-1" };
}

// ---------------------------------------------------------------------------

describe("subscribe 三分支与订阅生命周期", () => {
  it("分支1 初始化：ready 后 subscribeSession 发 {t:subscribe,requestId,file}；握手前调用则排队，welcome 后自动发出", () => {
    // 握手前排队
    const { client, ws } = setup();
    client.subscribeSession("a.jsonl");
    ws.open(); // hello 在 open 后才发
    expect(ws.sent).toHaveLength(1); // 仅 hello——welcome 前不发订阅帧
    ws.receive(WELCOME);
    expect(ws.sent).toHaveLength(2);
    expect(ws.sentFrames()[1]).toEqual({ t: "subscribe", requestId: expect.stringMatching(/^[\w-]{1,64}$/), file: "a.jsonl" });
    expect(client.getSnapshot().phase).toBe("subscribing");

    // ready 后直发
    const again = setup();
    handshake(again.ws);
    again.client.subscribeSession("b.jsonl");
    expect(again.ws.sentFrames()[1]).toEqual({ t: "subscribe", requestId: expect.any(String), file: "b.jsonl" });
  });

  it("分支3 续页：首页 hasMore 后自动发 {t:subscribe,file,snapshotId,historyNext}——游标/snapshotId 严格透传服务端值", () => {
    const { client, ws } = setup();
    handshake(ws);
    client.subscribeSession("a.jsonl");
    const initRequestId = (ws.sentFrames()[1] as { requestId: string }).requestId;
    ws.receive(
      pageFrame({
        requestId: initRequestId,
        snapshotId: "snap-77",
        page: [msg(1)],
        historyNext: { streamId: "stream-9", seq: 41 },
      }),
    );
    process.stdout.write("DBG_SNAP=" + JSON.stringify(client.getSnapshot()) + "\n");
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

  it("分页聚合到末页：事件按页累积，末页（historyNext=null+liveFrom）转 live，cursor=liveFrom（末页续读起点）", () => {
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
    ws.receive(pageFrame({ requestId, page: [], historyNext: null, liveFrom: { streamId: "stream-e", seq: 1 } }));
    const snap = client.getSnapshot();
    expect(snap.phase).toBe("live");
    expect(snap.events).toHaveLength(0);
    expect(snap.cursor).toEqual({ streamId: "stream-e", seq: 1 });
  });

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

  it("同 file 至多一个活动订阅：重复 subscribeSession 先发 unsubscribe 退旧再建新；旧订阅 events 不得再进快照", () => {
    const { client, ws, subscriptionId } = livePhase();
    client.subscribeSession("a.jsonl");
    const frames = ws.sentFrames().slice(-2) as { t: string; subscriptionId?: string; file?: string }[];
    expect(frames[0]).toEqual({ t: "unsubscribe", requestId: expect.any(String), subscriptionId });
    expect(frames[1]).toEqual({ t: "subscribe", requestId: expect.any(String), file: "a.jsonl" });
    const newRequestId = (frames[1] as { requestId: string }).requestId;
    ws.receive(pageFrame({ requestId: newRequestId, subscriptionId: "sub-2", page: [msg(9)], historyNext: null, liveFrom: { streamId: "stream-1", seq: 10 } }));
    const snap = client.getSnapshot();
    expect(snap.subscriptionId).toBe("sub-2");
    expect(snap.events.map((e) => e.seq)).toEqual([9]); // 新订阅=新快照（旧事件不残留）
    const frozen = client.getSnapshot();
    ws.receive(historyEvents(subscriptionId, 4, [msg(4)])); // 旧订阅流迟到一个性
    ws.receive({ t: "resync-required", subscriptionId, reason: "stream-replaced" }); // 旧订阅替换通知
    expect(client.getSnapshot()).toBe(frozen); // 均忽略：旧流不得再进快照
  });

  it("文件名非法：发送前本地拒绝（不发帧），受控文案；连接保持 ready 可再订阅合法文件", () => {
    const { client, ws } = setup();
    handshake(ws);
    const before = ws.sentFrames().length;
    client.subscribeSession("../etc/passwd");
    expect(ws.sentFrames().length).toBe(before); // 零帧成本
    const snap = client.getSnapshot();
    expect(snap.phase).toBe("closed");
    expect(snap.errorKind).toBe("subscribe-failed");
    expect(snap.errorMessage).toContain("文件名非法");
    client.subscribeSession("ok.jsonl");
    expect((ws.sentFrames().at(-1) as { t: string; file: string }).file).toBe("ok.jsonl");
  });
});

describe("流式帧：history/live 追加与幂等去重", () => {
  it("events history 追加：帧内/跨帧重复 seq 幂等吸收（不重复入列）；全重复帧零通知（快照身份不变）", () => {
    const { client, ws, subscriptionId } = livePhase();
    ws.receive(historyEvents(subscriptionId, 4, [msg(4), msg(4)])); // 帧内重复
    expect(client.getSnapshot().events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    const before = client.getSnapshot();
    ws.receive(historyEvents(subscriptionId, 5, [msg(4)])); // 跨帧重复
    expect(client.getSnapshot()).toBe(before); // 身份比较：无新事件=无新快照
    ws.receive(historyEvents(subscriptionId, 5, [msg(5)]));
    expect(client.getSnapshot().events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("events live 追加：liveSeq 递增投递进 liveEvents；重复/回退 liveSeq 帧忽略；空帧只推进帧号不通知", () => {
    const { client, ws, subscriptionId } = livePhase();
    ws.receive(liveEvents(subscriptionId, 1, [liveProgress("thinking"), liveProgress("message-start")]));
    expect(client.getSnapshot().liveEvents).toHaveLength(2);
    const before = client.getSnapshot();
    ws.receive(liveEvents(subscriptionId, 1, [liveProgress()])); // 重复帧号
    ws.receive(liveEvents(subscriptionId, 0, [liveProgress()])); // 回退帧号（非法序）
    expect(client.getSnapshot()).toBe(before);
    ws.receive(liveEvents(subscriptionId, 2, [])); // 空帧：帧号推进但不通知
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

describe("订阅终局语义", () => {
  it("4431 订阅级：该订阅 close（受控文案），连接保持 ready 且可立即再订阅新文件——连接与其余订阅面不受影响", () => {
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
    client.subscribeSession("b.jsonl"); // 连接可继续服务新订阅
    expect((ws.sentFrames().at(-1) as { t: string; file: string }).file).toBe("b.jsonl");
  });

  it("4431 非活动订阅 id：忽略零副作用", () => {
    const { client, ws, subscriptionId } = livePhase();
    const before = client.getSnapshot();
    ws.receive({ t: "error", code: 4431, subscriptionId: "sub-ghost", message: "x", retryable: false });
    expect(client.getSnapshot()).toBe(before);
    expect(before.phase).toBe("live");
  });

  it("4409 stream-replaced（resync-required）：活动订阅被替换后旧流关闭——旧流帧不得再进快照", () => {
    const { client, ws, subscriptionId } = livePhase();
    ws.receive({ t: "resync-required", subscriptionId, reason: "stream-replaced" });
    const snap = client.getSnapshot();
    expect(snap.phase).toBe("closed");
    expect(snap.subscriptionId).toBeNull();
    const frozen = client.getSnapshot();
    ws.receive(historyEvents(subscriptionId, 4, [msg(4)]));
    ws.receive(liveEvents(subscriptionId, 2, [liveProgress()]));
    expect(client.getSnapshot()).toBe(frozen);
    expect(snap.events.map((e) => e.seq)).toEqual([1, 2, 3]); // 内容保留
  });

  it("server-side-gap（resync-required）：置 resync-needed 保留 events+cursor；不做自动重同步（无新帧）", () => {
    const { client, ws, subscriptionId } = livePhase();
    const sentBefore = ws.sentFrames().length;
    ws.receive({ t: "resync-required", subscriptionId, reason: "server-side-gap" });
    const snap = client.getSnapshot();
    expect(snap.phase).toBe("resync-needed");
    expect(snap.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(snap.cursor).toEqual({ streamId: "stream-1", seq: 4 }); // 末页 cursor 保留
    expect(ws.sentFrames().length).toBe(sentBefore); // 无自动重发（本片承诺）
  });

  it("分支2 重同步：resync-needed 才可发起，发 {t:subscribe,file,cursor}——cursor=末页 liveFrom 严格透传；live 态调用为无操作", () => {
    const { client, ws, subscriptionId } = livePhase();
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
    expect(client.getSnapshot().phase).toBe("subscribing");
  });

  it("末页 60s 宽限后重试收 4409：置 resync-needed（events+cursor 不重建）；再续读按末页 cursor 收增量页——原事件保留、seq 幂等吸收重放", () => {
    const { client, ws, subscriptionId } = livePhase();
    ws.receive({ t: "resync-required", subscriptionId, reason: "server-side-gap" });
    client.resyncFromCursor(); // 用户显式续读（宽限已过）
    const resyncRequestId = (ws.sentFrames().at(-1) as { requestId: string }).requestId;
    ws.receive({ t: "error", code: 4409, requestId: resyncRequestId, message: "快照已过期", retryable: true });
    const snap = client.getSnapshot();
    expect(snap.phase).toBe("resync-needed"); // 不重建：内容+游标原地保留
    expect(snap.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(snap.cursor).toEqual({ streamId: "stream-1", seq: 4 });
    // 用户再次显式续读：按末页 cursor 直接续读（无需 snapshotId）
    client.resyncFromCursor();
    expect(ws.sentFrames().at(-1)).toEqual({ t: "subscribe", requestId: expect.any(String), file: "a.jsonl", cursor: { streamId: "stream-1", seq: 4 } });
    const retryRequestId = (ws.sentFrames().at(-1) as { requestId: string }).requestId;
    ws.receive(
      pageFrame({
        requestId: retryRequestId,
        subscriptionId: "sub-3",
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

  it("在途 requestId 重复（4404）：不崩——订阅终局受控文案，连接保持 ready，可再订阅", () => {
    const { client, ws } = setup();
    handshake(ws);
    client.subscribeSession("a.jsonl");
    const requestId = (ws.sentFrames()[1] as { requestId: string }).requestId;
    const before = client.getSnapshot();
    ws.receive({ t: "error", code: 4404, requestId, message: "duplicate requestId", retryable: false });
    const snap = client.getSnapshot();
    expect(snap.phase).toBe("closed");
    expect(snap.errorKind).toBe("subscribe-failed");
    expect(snap.errorMessage).toContain("4404");
    expect(snap.connState).toBe("ready"); // 连接不受影响
    client.subscribeSession("a.jsonl"); // 可立即重试
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
    expect(snap.errorMessage).toContain("4402");
    expect(snap.connState).toBe("ready");
    client.subscribeSession("ok.jsonl");
    expect((ws.sentFrames().at(-1) as { file: string }).file).toBe("ok.jsonl");
  });
});

describe("R1 消费帧运行时校验（坏帧零副作用：不污染快照/不消费在途；可续收合法帧）", () => {
  it("坏 snapshot（page 含 null 事件）：整帧忽略、在途保留；同 requestId 合法首页仍落地", () => {
    const { client, ws } = setup();
    handshake(ws);
    client.subscribeSession("a.jsonl");
    const requestId = (ws.sentFrames()[1] as { requestId: string }).requestId;
    const before = client.getSnapshot();
    ws.receive(pageFrame({ requestId, page: [msg(1), null as unknown as HistoryEvent], historyNext: null, liveFrom: { streamId: "stream-1", seq: 2 } }));
    expect(client.getSnapshot()).toBe(before); // 零副作用（身份不变）
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
      pageFrame({ requestId, page: [], historyNext: { streamId: "stream-1", seq: 2 }, liveFrom: { streamId: "stream-1", seq: 5 } }), // 双非 null
    );
    expect(client.getSnapshot().phase).toBe("subscribing");
    ws.receive(pageFrame({ requestId, page: [], historyNext: null, liveFrom: { streamId: "stream-1", seq: 1 } }));
    expect(client.getSnapshot().phase).toBe("live");
  });

  it("坏 snapshot 游标（seq:0/流Id 缺失）：整帧忽略；合法帧仍落地", () => {
    const { client, ws } = setup();
    handshake(ws);
    client.subscribeSession("a.jsonl");
    const requestId = (ws.sentFrames()[1] as { requestId: string }).requestId;
    ws.receive(pageFrame({ requestId, page: [], historyNext: { streamId: "stream-1", seq: 0 }, liveFrom: null }));
    ws.receive(pageFrame({ requestId, page: [], historyNext: { seq: 2 } as unknown as EventCursor, liveFrom: null })); // 缺 streamId
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
    ws.receive(historyEvents(subscriptionId, 4, [{ ...msg(4), role: "alien" }]));
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
    ws.receive(pageFrame({ requestId, page: [msg(1)], historyNext: null, liveFrom: { streamId: "stream-1", seq: 2 } }));
    expect(client.getSnapshot().phase).toBe("live"); // 合法帧照常受理
  });

  it("requestId 不符的 snapshot（迟到页/无关请求）与非活动 subscriptionId 的 events：忽略；合法帧落地", () => {
    const { client, ws, initRequestId, subscriptionId } = livePhase();
    const before = client.getSnapshot();
    ws.receive(pageFrame({ requestId: initRequestId, subscriptionId: "sub-late", page: [msg(9)], historyNext: null, liveFrom: { streamId: "stream-1", seq: 10 } }));
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
      ws.receive({ t: "sessions", requestId: "r", sessions: [], total: 0, offset: 0, hasMore: false, listVersion: 1, listReliability: "full" });
      ws.receive({ t: "write-ack", requestId: "w1", file: "a.jsonl", outcome: { kind: "busy" } });
      ws.receive({ t: "pong", nonce: "n" });
      ws.receiveRaw("not json");
      ws.receiveRaw(JSON.stringify([1, 2]));
      ws.receiveRaw(new ArrayBuffer(4));
    }).not.toThrow();
    expect(client.getSnapshot().connState).toBe("authenticating");
    ws.receive(WELCOME);
    expect(ws.sentFrames()[1]).toEqual({ t: "subscribe", requestId: expect.any(String), file: "a.jsonl" }); // 合法 welcome 后自动发出
  });
});

describe("R2 错误文案受控（error.message 永不进快照）", () => {
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
});

describe("R3 close 停止屏障与连接级错误", () => {
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

  it("握手期 4401→auth-failed（连接级）；ready 后服务端 1008 关闭→closed 终态（无自动重连）", () => {
    const first = setup("bad");
    first.ws.open();
    first.ws.receive({ t: "error", code: 4401, message: "未认证", retryable: false });
    expect(first.client.getSnapshot().connState).toBe("error");
    expect(first.client.getSnapshot().errorKind).toBe("auth-failed");
    first.ws.serverClose(1008);
    expect(first.client.getSnapshot().connState).toBe("error"); // 不降级

    const { client, ws, subscriptionId } = livePhase();
    ws.serverClose(1006);
    const snap = client.getSnapshot();
    expect(snap.connState).toBe("closed");
    const frozen = client.getSnapshot();
    ws.receive(historyEvents(subscriptionId, 4, [msg(4)]));
    expect(client.getSnapshot()).toBe(frozen);
    expect(ws.sentFrames().length).toBeLessThanOrEqual(3); // 无重连帧
  });
});
