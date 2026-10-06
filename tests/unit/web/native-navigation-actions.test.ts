import { afterEach, describe, expect, it } from "vitest";
import { NativePiPort } from "../../../apps/web/src/oc-bridge/native-pi-port";
import { nativeNavigationActions } from "../../../apps/web/src/oc-bridge/native-navigation-actions";
import type { WebSocketLike } from "../../../apps/web/src/ws/ws-client";
import type { UploadedAttachmentDTO } from "@pi-agent-ui/protocol/src/composer-input";

class Socket implements WebSocketLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: { readonly code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: Record<string, unknown>[] = [];
  send(data: string) { this.sent.push(JSON.parse(data) as Record<string, unknown>); }
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
  receive(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  welcome() { this.readyState = 1; this.onopen?.(); this.receive({ t: "welcome", protocolVersion: 1, serverBootId: "owned-boot", serverBuildId: "owned-build" }); }
  last(t: string) { const frame = this.sent.findLast(f => f.t === t); if (!frame) throw new Error("Missing owned test frame: " + t); return frame; }
}
const ports: NativePiPort[] = [];
afterEach(() => { for (const p of ports.splice(0)) p.dispose(); });
const attachment: UploadedAttachmentDTO = { id: "a".repeat(32), name: "code.ts", kind: "text", mimeType: "text/plain", size: 3, sha256: "b".repeat(64) };
function rig() {
  const sockets: Socket[] = [];
  const port = new NativePiPort("ws://127.0.0.1/ws", "synthetic-navigation-not-production", { createSocket: () => { const s = new Socket(); sockets.push(s); return s; }, upload: async () => attachment });
  ports.push(port);
  const root = "/owned/landing";
  function connect() { port.connect(); for (const s of sockets) if (s.readyState === 0) s.welcome(); }
  function list() {
    const s = sockets.at(-3)!;
    s.receive({ t: "sessions", requestId: s.last("list-sessions").requestId, offset: 0, total: 2, hasMore: false, listVersion: 1, listReliability: "partial", sessions: ["a.jsonl", "b.jsonl"].map(file => ({ sessionId: null, file, title: { text: file, truncated: false }, lastActiveMs: null, entryCount: 1, sizeBytes: 3, hasRecoveryNotice: false, listReliability: "partial" })) });
  }
  function roots(values = [root, "/owned/journal"], journal = "/owned/journal") { const s = sockets.at(-3)!; s.receive({ t: "roots-list", requestId: s.last("get-roots").requestId, roots: values, journalRoot: journal }); }
  const ready = () => { connect(); list(); roots(); };
  const mutations = () => sockets.flatMap(s => s.sent).filter(f => ["prompt", "resume", "stop"].includes(String(f.t)));
  return { port, sockets, root, connect, list, roots, ready, mutations };
}
describe("explicit native navigation: actual owner/three clients, no Source store or engine writes", () => {
  it("construction is inert; no sockets, owner selection, restored Source preferences or local draft", () => {
    const r = rig(), before = r.port.getSnapshot(); nativeNavigationActions(r.port);
    expect(r.port.getSnapshot()).toBe(before); expect(r.sockets).toHaveLength(0); expect(before.conversation.drafts.size).toBe(0);
  });
  it("unready clients, unconfirmed list and missing/nonlanding roots refuse before mutation", () => {
    const r = rig(), nav = nativeNavigationActions(r.port, () => "new.jsonl");
    expect(nav.open("a.jsonl")).toMatchObject({ status: "local", reason: "not-ready" }); r.connect();
    expect(nav.newDraft()).toMatchObject({ reason: "not-ready" }); r.list();
    expect(nav.open("a.jsonl")).toMatchObject({ reason: "not-ready" }); r.roots(["/owned/journal"]);
    expect(nav.newDraft()).toMatchObject({ reason: "not-ready" }); expect(r.port.getSnapshot().conversation.drafts.size).toBe(0); expect(r.mutations()).toEqual([]);
  });
  it("confirmed member opens actual native slot; same file reopens without duplicate subscription", () => {
    const r = rig(); r.ready(); const nav = nativeNavigationActions(r.port);
    const a = nav.open("a.jsonl", r.root); expect(a).toEqual({ status: "selected", kind: "session", slotId: "session:a.jsonl", file: "a.jsonl", directory: r.root });
    expect(nav.open("a.jsonl", r.root)).toEqual(a); expect(r.port.getSnapshot().conversation.view).toEqual({ kind: "session", file: "a.jsonl" });
    expect(r.sockets[2]!.sent.filter(f => f.t === "subscribe")).toHaveLength(1); expect(r.mutations()).toEqual([]);
  });
  it("valid-looking but unlisted target, invalid filename and traversal cannot change the old slot", () => {
    const r = rig(); r.ready(); const nav = nativeNavigationActions(r.port); nav.open("a.jsonl"); const before = r.port.getSnapshot().conversation;
    for (const f of ["unlisted.jsonl", "../a.jsonl", "/a.jsonl", "not-session.txt"]) expect(nav.open(f)).toMatchObject({ status: "local", reason: "unconfirmed-target" });
    expect(r.port.getSnapshot().conversation).toBe(before); expect(r.mutations()).toEqual([]);
  });
  it("foreign, journal and explicit-null directory refuse rather than guessing execution cwd", () => {
    const r = rig(); r.ready(); const nav = nativeNavigationActions(r.port, () => "new.jsonl"), before = r.port.getSnapshot().conversation;
    for (const d of ["/foreign", "/owned/journal", null]) { expect(nav.open("a.jsonl", d)).toMatchObject({ reason: "directory-mismatch" }); expect(nav.newDraft(d)).toMatchObject({ reason: "directory-mismatch" }); }
    expect(r.port.getSnapshot().conversation).toBe(before); expect(r.mutations()).toEqual([]);
  });
  it("new draft is local/default only, never a fake durable session or a Source model restoration", () => {
    const r = rig(); r.ready(); const result = nativeNavigationActions(r.port, () => "local-new.jsonl").newDraft(r.root);
    expect(result).toMatchObject({ status: "selected", kind: "draft", file: "local-new.jsonl", directory: r.root });
    const s = [...r.port.getSnapshot().conversation.drafts.values()][0]!; expect(s).toMatchObject({ file: "local-new.jsonl", text: "", modelChoice: "__default__", thinkingLevel: null });
    expect(r.port.getSnapshot().list.sessions?.map(x => x.file)).toEqual(["a.jsonl", "b.jsonl"]); expect(r.mutations()).toEqual([]);
  });
  it("switch A→local draft→B→A retains exact A text/model/thinking/attachments and draft text", async () => {
    const r = rig(); r.ready(); const nav = nativeNavigationActions(r.port, () => "local-new.jsonl"); const a = nav.open("a.jsonl"); expect(a.status).toBe("selected"); if (a.status !== "selected") throw new Error("Fixture A refused");
    r.port.owner.edit(a.slotId, "A 原文"); r.port.owner.configure(a.slotId, "fixture/one", "unfinished/model"); r.port.owner.configureThinking(a.slotId, "high"); await r.port.owner.upload(a.slotId, [new File(["abc"], "code.ts", { type: "text/plain" })]);
    const before = r.port.getSnapshot().conversation.sessions.get(a.slotId)!; const draft = nav.newDraft(); if (draft.status !== "selected") throw new Error("Fixture draft refused"); r.port.owner.edit(draft.slotId, "local draft");
    nav.open("b.jsonl"); nav.open("a.jsonl"); expect(r.port.getSnapshot().conversation.sessions.get(a.slotId)).toEqual(before); expect(before).toMatchObject({ text: "A 原文", modelChoice: "fixture/one", freeText: "unfinished/model", thinkingLevel: "high", attachments: [attachment] });
    expect(r.port.getSnapshot().conversation.drafts.get(draft.slotId)?.text).toBe("local draft"); expect(r.mutations()).toEqual([]);
  });
  it("name collision in confirmed/local owner facts and invalid/throwing factory never overwrite target", () => {
    const r = rig(); r.ready(); nativeNavigationActions(r.port, () => "local-new.jsonl").newDraft(); const before = r.port.getSnapshot().conversation;
    for (const f of ["a.jsonl", "local-new.jsonl"]) expect(nativeNavigationActions(r.port, () => f).newDraft()).toMatchObject({ reason: "filename-collision" });
    expect(nativeNavigationActions(r.port, () => "../bad.jsonl").newDraft()).toMatchObject({ reason: "invalid-filename" }); const x = nativeNavigationActions(r.port, () => { throw new Error("must not echo factory error"); }).newDraft(); expect(x).toMatchObject({ reason: "invalid-filename" }); expect(JSON.stringify(x)).not.toContain("must not echo");
    expect(r.port.getSnapshot().conversation).toBe(before); expect(r.mutations()).toEqual([]);
  });
  it("closed port cannot fall back to Source or return selected from retained ready facts", () => {
    const r = rig(); r.ready(); const nav = nativeNavigationActions(r.port, () => "new.jsonl"); r.port.dispose(); const before = r.port.getSnapshot();
    expect(nav.open("a.jsonl")).toMatchObject({ status: "local", reason: "unavailable" }); expect(nav.newDraft()).toMatchObject({ status: "local", reason: "unavailable" }); expect(r.port.getSnapshot()).toBe(before); expect(r.mutations()).toEqual([]);
  });
  it("pending→unknown/reconnect late ACK retains A edits and selected B; navigation never retries", async () => {
    const r = rig(); r.ready(); const nav = nativeNavigationActions(r.port); const a = nav.open("a.jsonl"); if (a.status !== "selected") throw new Error("Fixture A refused"); r.port.owner.edit(a.slotId, "first");
    const pending = r.port.send(a.slotId); const old = r.sockets[1]!, handler = old.onmessage, frame = old.last("prompt"); r.port.owner.edit(a.slotId, "new A"); r.port.reconnect(); await pending;
    expect(nav.open("b.jsonl")).toMatchObject({ reason: "not-ready" }); r.ready(); expect(nav.open("b.jsonl")).toMatchObject({ status: "selected", file: "b.jsonl" });
    handler?.({ data: JSON.stringify({ t: "write-ack", requestId: frame.requestId, file: frame.file, outcome: { kind: "launched", intentId: "late-owned", commandId: 1 } }) });
    expect(r.port.getSnapshot().conversation.view).toEqual({ kind: "session", file: "b.jsonl" }); expect(r.port.getSnapshot().conversation.sessions.get(a.slotId)).toMatchObject({ text: "new A", phase: "settled-unknown" });
    expect(r.mutations().map(f => f.t)).toEqual(["prompt"]); expect((await r.port.send(a.slotId)).status).toBe("local");
  });
});
