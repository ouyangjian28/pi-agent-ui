import { afterEach, describe, expect, it } from "vitest";
import { NativePiPort } from "../../../apps/web/src/oc-bridge/native-pi-port";
import type { WebSocketLike } from "../../../apps/web/src/ws/ws-client";

class Socket implements WebSocketLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: { readonly code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: Record<string, unknown>[] = [];
  closeCount = 0;
  send(data: string): void { this.sent.push(JSON.parse(data) as Record<string, unknown>); }
  close(code = 1000): void { this.readyState = 3; this.closeCount++; this.onclose?.({ code }); }
  receive(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) }); }
  welcome(): void {
    this.readyState = 1; this.onopen?.();
    this.receive({ t: "welcome", protocolVersion: 1, serverBootId: "test-boot", serverBuildId: "test-build" });
  }
  last(t: string): Record<string, unknown> {
    const found = this.sent.findLast((frame) => frame.t === t);
    if (!found) throw new Error(`No test frame: ${t}`);
    return found;
  }
}
const ports: NativePiPort[] = [];
afterEach(() => { for (const port of ports.splice(0)) port.dispose(); });
function rig() {
  const sockets: Socket[] = [];
  const port = new NativePiPort("ws://127.0.0.1/ws", "fixture-token-not-production", { createSocket: () => {
    const socket = new Socket(); sockets.push(socket); return socket;
  } });
  ports.push(port);
  const ready = () => { for (const socket of sockets) if (socket.readyState === 0) socket.welcome(); };
  return { port, sockets, ready };
}
function ack(socket: Socket, outcome: unknown) {
  const frame = socket.last("prompt");
  socket.receive({ t: "write-ack", requestId: frame.requestId, file: frame.file, outcome });
}

describe("OpenChamber native port: actual clients, not SDK/HTTP success stubs", () => {
  it("is inert until connect, creates exactly the original three clients, and keeps facts/token separate", () => {
    const r = rig(); const initial = r.port.getSnapshot();
    expect(r.sockets).toHaveLength(0);
    expect(initial.list.sessions).toBeNull(); expect(initial.list.models.status).toBe("idle");
    expect(r.port.getSnapshot()).toBe(initial);
    r.port.connect(); r.port.connect(); expect(r.sockets).toHaveLength(3); r.ready();
    for (const socket of r.sockets) expect(socket.sent[0]).toEqual({ t: "hello", protocolVersion: 1, token: "fixture-token-not-production" });
    expect(r.sockets[0]!.sent.filter((f) => f.t === "get-models")).toHaveLength(1);
    expect(r.sockets[0]!.sent.filter((f) => f.t === "get-roots")).toHaveLength(1);
    expect(JSON.stringify(r.port.getSnapshot())).not.toContain("fixture-token-not-production");
    expect(r.sockets.flatMap((s) => s.sent).filter((f) => f.t === "prompt")).toHaveLength(0);
  });
  it("retains native partial list facts and actual thinking levels; omitted capability stays unknown", () => {
    const r = rig(); r.port.connect(); r.ready(); const list = r.sockets[0]!;
    list.receive({ t: "sessions", requestId: list.last("list-sessions").requestId, offset: 0, total: 1, hasMore: false, listVersion: 1, listReliability: "partial", sessions: [{
      sessionId: null, file: "a.jsonl", title: { text: "actual fixture", truncated: true }, lastActiveMs: null, entryCount: 1, sizeBytes: 3, hasRecoveryNotice: true, listReliability: "partial",
    }] });
    list.receive({ t: "models-list", requestId: list.last("get-models").requestId, models: [{ provider: "fixture", id: "one", thinkingLevels: ["off", "low"] }, { provider: "fixture", id: "unknown", thinking: "yes" }] });
    expect(r.port.getSnapshot().list).toMatchObject({ total: 1, listReliability: "partial", models: { status: "ok" } });
    expect(r.port.getSnapshot().list.sessions?.[0]).toMatchObject({ hasRecoveryNotice: true, title: { truncated: true } });
    expect(r.port.getSnapshot().list.models.items[0]?.thinkingLevels).toEqual(["off", "low"]);
    expect(r.port.getSnapshot().list.models.items[1]?.thinkingLevels).toBeUndefined();
  });
  it("invalid filenames are local rejection; a local draft is not a durable session", () => {
    const r = rig(); expect(r.port.createDraft("../a.jsonl")).toBeNull(); expect(r.port.openSession("/root/a.jsonl")).toBeNull();
    const id = r.port.createDraft("draft.jsonl")!;
    expect(r.port.owner.getSnapshot().drafts.get(id)?.file).toBe("draft.jsonl");
    expect(r.port.getSnapshot().list.sessions).toBeNull(); expect(r.sockets).toHaveLength(0);
  });
  it("open same session/back/edit never duplicates subscriptions or issues a prompt/stop", () => {
    const r = rig(); r.port.connect(); r.ready();
    const id = r.port.openSession("a.jsonl")!;
    r.port.owner.edit(id, "keep me"); r.port.openSession("a.jsonl"); r.port.back();
    const detail = r.sockets[2]!;
    expect(detail.sent.filter((f) => f.t === "subscribe")).toHaveLength(1);
    expect(detail.sent.filter((f) => f.t === "unsubscribe")).toHaveLength(0);
    expect(r.port.getSnapshot().conversation.sessions.get(id)?.text).toBe("keep me");
    expect(r.sockets.flatMap((s) => s.sent).filter((f) => f.t === "prompt" || f.t === "stop")).toHaveLength(0);
  });
  it("version-changing late launched retains A and B edits, without navigating B away", async () => {
    const r = rig(); r.port.connect(); r.ready(); const id = r.port.createDraft("a.jsonl")!;
    r.port.owner.edit(id, "first"); const pending = r.port.send(id, "fixture/one");
    expect(r.port.owner.getSnapshot().drafts.get(id)?.text).toBe("first");
    r.port.owner.edit(id, "second"); r.port.owner.edit(id, "first");
    const b = r.port.openSession("b.jsonl")!; r.port.owner.edit(b, "B draft");
    ack(r.sockets[1]!, { kind: "launched", intentId: "i-1", commandId: 1 });
    expect((await pending).status).toBe("launched");
    expect(r.port.owner.getSnapshot().drafts.get(id)?.text).toBe("first");
    expect(r.port.owner.getSnapshot().sessions.get(b)?.text).toBe("B draft");
    expect(r.port.getSnapshot().conversation.view).toEqual({ kind: "session", file: "b.jsonl" });
  });
  it("same owner across reconnect, pending becomes unknown, late receipt cannot clear or auto-retry", async () => {
    const r = rig(); r.port.connect(); r.ready(); const owner = r.port.owner; const id = r.port.createDraft("a.jsonl")!;
    owner.edit(id, "original"); const pending = r.port.send(id); const oldWrite = r.sockets[1]!;
    const delayedHandler = oldWrite.onmessage; const frame = oldWrite.last("prompt");
    r.port.reconnect(); r.ready();
    expect(r.port.owner).toBe(owner); expect(r.sockets).toHaveLength(6);
    expect((await pending).status).toBe("unknown"); owner.edit(id, "new edit");
    delayedHandler?.({ data: JSON.stringify({ t: "write-ack", requestId: frame.requestId, file: frame.file, outcome: { kind: "launched", intentId: "late", commandId: 1 } }) });
    expect(owner.getSnapshot().drafts.get(id)).toMatchObject({ text: "new edit", phase: "settled-unknown" });
    expect((await r.port.send(id)).status).toBe("local");
    expect(r.sockets.flatMap((s) => s.sent).filter((f) => f.t === "prompt")).toHaveLength(1);
  });
  it("gate-failed ACK is unknown, not success; explicit resume/stop are not synthesized by navigation", async () => {
    const r = rig(); r.port.connect(); r.ready(); const id = r.port.createDraft("a.jsonl")!; r.port.owner.edit(id, "do not drop");
    const pending = r.port.send(id); ack(r.sockets[1]!, { kind: "gate-failed", stage: "enqueue" });
    expect((await pending).status).toBe("unknown");
    expect(r.port.owner.getSnapshot().drafts.get(id)?.text).toBe("do not drop");
    expect((await r.port.send(id)).status).toBe("local");
    r.port.back(); r.port.openSession("b.jsonl");
    expect(r.sockets[1]!.sent.filter((f) => f.t === "prompt")).toHaveLength(1);
    expect(r.sockets[1]!.sent.filter((f) => f.t === "resume" || f.t === "stop")).toHaveLength(0);
  });
  it("dispose is irreversible and ignores saved callbacks; no timer/transport can be restarted", async () => {
    const r = rig(); r.port.connect(); r.ready(); const id = r.port.createDraft("a.jsonl")!; r.port.owner.edit(id, "keep");
    const snapshot = r.port.getSnapshot(); const delayed = r.sockets[0]!.onopen;
    r.port.dispose(); r.port.dispose(); r.port.connect(); r.port.reconnect(); delayed?.();
    expect(r.sockets).toHaveLength(3); expect(r.sockets.map((s) => s.closeCount)).toEqual([1, 1, 1]);
    expect(r.port.getSnapshot()).toBe(snapshot); expect(r.port.createDraft("later.jsonl")).toBeNull();
    expect(await r.port.send(id)).toMatchObject({ status: "local", kind: "closed" });
  });
});
