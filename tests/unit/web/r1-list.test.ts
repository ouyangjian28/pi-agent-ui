import { describe, expect, it } from "vitest";
import { WsClient, type WebSocketLike } from "../../../apps/web/src/ws/ws-client";
import { groupSessions } from "../../../apps/web/src/ws/session-groups";
class Socket implements WebSocketLike {
  readyState = 1; sent: Record<string, unknown>[] = []; onopen: (() => void) | null = null; onmessage: ((e: { data: unknown }) => void) | null = null; onclose: ((e: { code: number }) => void) | null = null; onerror: (() => void) | null = null;
  send(data: string) { this.sent.push(JSON.parse(data)); } close(code = 1000) { this.onclose?.({ code }); }
  receive(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}
function dto(n: number, lastActiveMs: number | null = n) { return { sessionId: `s-${n}`, file: `f${n}.jsonl`, title: { text: `会话${n}`, truncated: false }, lastActiveMs, entryCount: 1, sizeBytes: 10, hasRecoveryNotice: false, listReliability: "full" as const }; }
function rig() {
  const socket = new Socket(); const client = new WsClient("ws://local-fixture", "fixture", () => socket); client.connect(); socket.onopen?.(); socket.receive({ t: "welcome", protocolVersion: 1, serverBootId: "fixture", serverBuildId: "fixture" });
  return { socket, client, last: () => socket.sent.filter((frame) => frame.t === "list-sessions").at(-1)!, page: (rows: ReturnType<typeof dto>[], offset = 0, more = true, version = 1) => socket.receive({ t: "sessions", requestId: socket.sent.filter((f) => f.t === "list-sessions").at(-1)!.requestId, sessions: rows, offset, total: 70, hasMore: more, listVersion: version, listReliability: "full" }) };
}
describe("R1 续页，raw 游标×请求世代", () => {
  it("第51条可到达；短页 hasMore 不跳，重复行不影响 nextOffset", () => {
    const r = rig(); r.page(Array.from({ length: 50 }, (_, i) => dto(i + 1))); r.client.requestMoreSessions(); expect(r.last().offset).toBe(50);
    r.page([dto(50), dto(51)], 50); expect(r.client.getSnapshot().sessions).toHaveLength(51); expect(r.client.getSnapshot().nextOffset).toBe(52);
    r.client.requestMoreSessions(); expect(r.last().offset).toBe(52); r.page([dto(52)], 52, false);
    expect(r.client.getSnapshot().sessions?.map((row) => row.file)).toContain("f51.jsonl"); expect(r.client.getSnapshot().sessions).toHaveLength(52); expect(r.client.getSnapshot().hasMore).toBe(false); r.client.close();
  });
  it("listVersion 变丢累计页，offset0 重拉；旧 requestId 晚到零并入", () => {
    const r = rig(); r.page([dto(1), dto(2)]); r.client.requestMoreSessions(); const old = r.last().requestId;
    r.page([dto(99)], 2, false, 2); expect(r.client.getSnapshot().sessions).toBeNull(); expect(r.last().offset ?? 0).toBe(0); expect(r.last().requestId).not.toBe(old);
    const snap = r.client.getSnapshot(); r.socket.receive({ t: "sessions", requestId: old, sessions: [dto(88)], offset: 2, total: 3, hasMore: false, listVersion: 2, listReliability: "full" }); expect(r.client.getSnapshot()).toBe(snap);
    r.page([dto(3)], 0, false, 2); expect(r.client.getSnapshot().sessions?.map((row) => row.file)).toEqual(["f3.jsonl"]); r.client.close();
  });
  it("在途续页期间刷新换世代，旧页不并入；dirty 合并只补拉一次", () => {
    const r = rig(); r.page([dto(1)]); r.client.requestMoreSessions(); const before = r.socket.sent.length;
    r.client.requestSessions(); r.client.requestSessions(); expect(r.socket.sent).toHaveLength(before);
    r.page([dto(2)], 1); expect(r.client.getSnapshot().sessions?.map((row) => row.file)).toEqual(["f1.jsonl"]);
    expect(r.socket.sent).toHaveLength(before + 1); expect(r.last().offset ?? 0).toBe(0); r.page([dto(4)], 0, false); expect(r.client.getSnapshot().sessions?.map((row) => row.file)).toEqual(["f4.jsonl"]); r.client.close();
  });
  it("续页错误不冒充断线：保累计、可显式重试；partial 可发现", () => {
    const r = rig(); r.page([dto(1)]); r.client.requestMoreSessions();
    r.socket.receive({ t: "error", requestId: r.last().requestId, code: 4402, retryable: true, message: "never display" });
    expect(r.client.getSnapshot()).toMatchObject({ state: "ready", pageState: "error", nextOffset: 1 }); expect(r.client.getSnapshot().sessions).toHaveLength(1);
    r.client.requestMoreSessions(); expect(r.last().offset).toBe(1);
    r.socket.receive({ t: "sessions", requestId: r.last().requestId, sessions: [dto(2)], offset: 1, total: 2, hasMore: false, listVersion: 1, listReliability: "partial" });
    expect(r.client.getSnapshot()).toMatchObject({ pageState: "idle", pageError: null, listReliability: "partial" }); r.client.close();
  });
  it("换 client/关闭的旧页无任何通知或覆盖", () => {
    const r = rig(); const rid = r.last().requestId; r.client.close(); const old = r.client.getSnapshot();
    r.socket.receive({ t: "sessions", requestId: rid, sessions: [dto(9)], offset: 0, total: 1, hasMore: false, listVersion: 1, listReliability: "full" }); expect(r.client.getSnapshot()).toBe(old);
    const newer = rig(); expect(newer.client.getSnapshot().sessions).toBeNull(); newer.client.close();
  });
});
describe("R1 自然日四互斥组（TZ 三态外部复跑）", () => {
  it("今天/昨天/过去7天/更早四边界、未来、null、无效Date；DST 不用固定毫秒", () => {
    const now = new Date(2026, 2, 9, 12); const day = (offset: number) => new Date(2026, 2, 9 + offset).getTime();
    const groups = groupSessions([dto(1, day(0)), dto(2, day(-1)), dto(3, day(-1) - 1), dto(4, day(-7)), dto(5, day(-7) - 1), dto(6, null), dto(7, 9e15), dto(8, day(1))], now);
    expect(groups.map((group) => [group.label, group.sessions.map((row) => row.file)])).toEqual([
      ["今天", ["f8.jsonl", "f1.jsonl"]], ["昨天", ["f2.jsonl"]], ["过去 7 天", ["f3.jsonl", "f4.jsonl"]], ["更早", ["f7.jsonl", "f5.jsonl", "f6.jsonl"]],
    ]);
  });
});
