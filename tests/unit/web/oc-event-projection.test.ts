import { describe, expect, it } from "vitest";
import type { HistoryEvent, LiveEvent, SessionStatus, SessionSummaryDTO } from "@pi-agent-ui/protocol/src/contracts";
import { NativePiPort, type NativePiSnapshot } from "../../../apps/web/src/oc-bridge/native-pi-port";
import { OcEventProjection } from "../../../apps/web/src/oc-bridge/oc-event-projection";
function facts(): NativePiSnapshot {
  const port = new NativePiPort("ws://127.0.0.1/ws", "event-fixture-only"); const initial = port.getSnapshot(); port.dispose();
  return { ...initial, list: { ...initial.list, state: "ready", sessions: [], hasMore: false, listReliability: "full", roots: { status: "ok", items: ["/test/journal", "/test/workspace"], journalRoot: "/test/journal", cause: null } }, detail: { ...initial.detail, connState: "ready", file: "a.jsonl", phase: "live" }, write: { ...initial.write, connState: "ready" } };
}
function session(file: string): SessionSummaryDTO { return { sessionId: null, file, title: { text: file, truncated: false }, lastActiveMs: null, entryCount: 0, sizeBytes: 0, hasRecoveryNotice: false, listReliability: "full" }; }
function message(text: string, seq = 1): HistoryEvent { return { kind: "message", seq, ts: null, intentId: null, generation: null, entryId: `native-${seq}`, role: "assistant", textPreview: { text, truncated: false }, final: true }; }
function detail(f: NativePiSnapshot, events: readonly HistoryEvent[], liveEvents: readonly LiveEvent[] = []): NativePiSnapshot { return { ...f, detail: { ...f.detail, events, liveEvents } }; }
describe("native facts to original SDK global.event envelopes", () => {
  it("produces no event from unconfirmed/lost connections or unknown roots", () => {
    const f = facts(); const p = new OcEventProjection();
    for (const bad of [{ ...f, list: { ...f.list, state: "connecting" as const } }, { ...f, write: { ...f.write, connState: "closed" as const } }, { ...f, detail: { ...f.detail, connState: "error" as const } }, { ...f, list: { ...f.list, roots: { ...f.list.roots, status: "failed" as const } } }]) expect(p.project(detail(bad, [message("never emit")]))).toEqual([]);
  });
  it("emits owner message before parts with explicit SDK directory, then deduplicates unchanged facts", () => {
    const f = detail(facts(), [message("actual reply")]); const p = new OcEventProjection(); const events = p.project(f);
    expect(events.map((e) => e.payload.type)).toEqual(["message.updated", "message.part.updated"]);
    expect(events.every((e) => e.directory === "/test/workspace")).toBe(true);
    expect(events[0]!.payload.properties.info).toMatchObject({ id: "pi-native-1-0", sessionID: "a.jsonl", native: { entryId: "native-1" } });
    expect(events[1]!.payload.properties).toMatchObject({ sessionID: "a.jsonl", part: { messageID: "pi-native-1-0", text: "actual reply" } });
    expect(p.project(f)).toEqual([]); expect(JSON.stringify(events)).not.toContain("event-fixture-only");
  });
  it("projects actual list updates without invented id/date; only confirmed full absence deletes", () => {
    const f = facts(); const p = new OcEventProjection(); const first = { ...f, list: { ...f.list, sessions: [session("a.jsonl")] } };
    expect(p.project(first)[0]!.payload).toMatchObject({ type: "session.created", properties: { info: { id: "a.jsonl", time: {} } } });
    const changed = { ...first, list: { ...first.list, sessions: [{ ...session("a.jsonl"), title: { text: "new title", truncated: false } }] } };
    expect(p.project(changed)[0]!.payload.type).toBe("session.updated");
    for (const uncertain of [{ ...f, list: { ...f.list, hasMore: true } }, { ...f, list: { ...f.list, listReliability: "partial" as const } }, { ...f, list: { ...f.list, sessions: null } }]) expect(p.project(uncertain)).toEqual([]);
    expect(p.project(f)[0]!.payload).toMatchObject({ type: "session.deleted", properties: { info: { id: "a.jsonl" } } });
  });
  it("does not remove existing history on a shorter window, failed load, or re-subscription handshake", () => {
    const f = facts(); const p = new OcEventProjection(); p.project(detail(f, [message("old", 1), message("recent", 2)]));
    expect(p.project(detail(f, [message("recent", 2)]))).toEqual([]);
    expect(p.project({ ...f, detail: { ...f.detail, phase: "resync-needed" } })).toEqual([]);
    expect(p.project(detail(f, [message("recent", 2)]))).toEqual([]);
  });
  it("a genuinely new native clear deletes old display rows; replay of that clear cannot infer later deletion", () => {
    const f = facts(); const p = new OcEventProjection(); p.project(detail(f, [message("old", 1)]));
    const clear: HistoryEvent = { kind: "clear", seq: 2, ts: null, generation: null, intentId: null, clearedCount: 1 };
    expect(p.project(detail(f, [clear]))).toEqual([expect.objectContaining({ payload: { type: "message.removed", properties: { sessionID: "a.jsonl", messageID: "pi-native-1-0" } } })]);
    p.project(detail(f, [clear, message("new", 3)]));
    expect(p.project(detail(f, [clear]))).toEqual([]);
  });
  it("live final stays temporary; actual persisted reply removes only temporary id and materialises real id first", () => {
    const f = facts(); const p = new OcEventProjection(); const live: LiveEvent[] = [{ kind: "turn-state", statusVersion: 1, turn: { state: "in-flight", intentId: "intent-1" } }, { kind: "message-final", role: "assistant", text: "answer" }];
    const events = p.project(detail(f, [], live)); expect(events[0]!.payload.properties.info).toMatchObject({ id: "pi-live-intent-1-assistant", native: { final: false } });
    expect(events.map((e) => e.payload.type)).not.toContain("session.idle");
    const persisted = p.project(detail(f, [message("answer", 2)], live));
    expect(persisted.map((e) => e.payload.type)).toEqual(["message.updated", "message.part.updated", "message.removed"]);
    expect(persisted[2]!.payload.properties.messageID).toBe("pi-live-intent-1-assistant");
  });
  it("a new turn retires old live bytes; reasoning visibility exactly follows native events", () => {
    const f = facts(); const p = new OcEventProjection();
    const old: LiveEvent[] = [{ kind: "turn-state", statusVersion: 1, turn: { state: "in-flight", intentId: "old" } }, { kind: "message-delta", part: "thinking", contentIndex: 0, delta: "visible native reasoning" }];
    const first = p.project(detail(f, [], old)); expect(JSON.stringify(first)).toContain("visible native reasoning");
    const next: LiveEvent[] = [...old, { kind: "turn-state", statusVersion: 2, turn: { state: "dispatching", intentId: "new" } }];
    expect(p.project(detail(f, [], next))).toEqual([expect.objectContaining({ payload: { type: "message.removed", properties: { sessionID: "a.jsonl", messageID: "pi-live-old-assistant" } } })]);
  });
  it("keeps projections per session, never cross-removes A when B opens", () => {
    const f = facts(); const p = new OcEventProjection(); p.project(detail(f, [message("A")]));
    const b = { ...f, detail: { ...f.detail, file: "b.jsonl", events: [message("B")] } };
    const events = p.project(b); expect(events.map((e) => e.payload.type)).toEqual(["message.updated", "message.part.updated"]);
    expect(events.every((e) => (e.payload.properties.info as { sessionID?: string } | undefined)?.sessionID !== "a.jsonl")).toBe(true);
    expect(p.project(detail(f, [message("A")]))).toEqual([]);
  });
  it("emits only confirmed native idle/busy status, not fake closure/completion for a closed turn", () => {
    const f = facts(); const p = new OcEventProjection();
    const status: SessionStatus = {
      session: { sessionId: null, file: "a.jsonl", adapterSessionId: null },
      process: { phase: "running", generation: 1, lastStartResult: null, lastStopResult: null, ready: true },
      turn: { state: "in-flight", intentId: "current" },
      backgroundTasks: { availability: "unknown", activeCount: null },
      reap: { eligible: false, idleElapsedMs: null, idleRemainingMs: null, idleMs: 1000 },
      recovery: { availability: "unavailable", resumeBlocked: null, diskBlocked: null, unknownEffectCount: null, unattributableFragments: null, intentsCount: null, settledCount: null, evidenceHash: null },
      statusVersion: 1, serverTimeMs: 1,
    };
    expect(p.project({ ...f, detail: { ...f.detail, status } })[0]!.payload).toEqual({ type: "session.status", properties: { sessionID: "a.jsonl", status: { type: "busy" } } });
    expect(p.project({ ...f, detail: { ...f.detail, status: { ...status, turn: { state: "closed", reason: "turn-timeout" } } } })).toEqual([]);
    expect(p.project({ ...f, detail: { ...f.detail, status: { ...status, turn: { state: "idle" } } } })[0]!.payload).toEqual({ type: "session.status", properties: { sessionID: "a.jsonl", status: { type: "idle" } } });
  });
  it("updates existing part bytes instead of manufacturing a new message or durable completion", () => {
    const f = facts(); const p = new OcEventProjection(); const start: LiveEvent[] = [{ kind: "message-delta", part: "text", contentIndex: 0, delta: "a" }];
    p.project(detail(f, [], start));
    expect(p.project(detail(f, [], [...start, { kind: "message-delta", part: "text", contentIndex: 0, delta: "b" }]))).toEqual([expect.objectContaining({ payload: { type: "message.part.updated", properties: { sessionID: "a.jsonl", part: expect.objectContaining({ text: "ab" }) } } })]);
  });
});
