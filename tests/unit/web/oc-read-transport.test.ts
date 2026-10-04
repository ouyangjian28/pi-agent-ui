import { afterEach, describe, expect, it, vi } from "vitest";
import { NativePiPort, type NativePiSnapshot } from "../../../apps/web/src/oc-bridge/native-pi-port";
import { OcReadTransport } from "../../../apps/web/src/oc-bridge/oc-read-transport";
function feed() {
  const port = new NativePiPort("ws://127.0.0.1/ws", "read-fixture-only"); const initial = port.getSnapshot(); port.dispose();
  let value: NativePiSnapshot = { ...initial, list: { ...initial.list, state: "ready", sessions: [], hasMore: false, listReliability: "full", roots: { status: "ok", items: ["/test/journal", "/test/workspace"], journalRoot: "/test/journal", cause: null } }, detail: { ...initial.detail, connState: "ready", file: "a.jsonl", phase: "live" }, write: { ...initial.write, connState: "ready" } };
  const listeners = new Set<() => void>();
  const source = { getSnapshot: () => value, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; } };
  return { source, listeners, set(next: NativePiSnapshot) { value = next; for (const fn of [...listeners]) fn(); } };
}
const transports: OcReadTransport[] = [];
afterEach(() => { for (const t of transports.splice(0)) t.dispose(); vi.restoreAllMocks(); vi.useRealTimers(); });
function rig() { const f = feed(); const transport = new OcReadTransport(f.source, "http://127.0.0.1:7777/"); transports.push(transport); return { ...f, transport }; }
const decode = new TextDecoder();
describe("original SDK read transport, not original UI acceptance", () => {
  it("provides only native reads, rejects writes and foreign/credentialled/malformed addresses without network", async () => {
    const r = rig(); const network = vi.spyOn(globalThis, "fetch");
    expect(await (await r.transport.fetch("/health")).json()).toMatchObject({ healthy: true, nativePi: true });
    for (const path of ["/api/session", "/api/session/a.jsonl/prompt_async", "/api/session/a.jsonl/abort", "/api/global/event"]) expect((await r.transport.fetch(path, { method: "POST" })).status).toBe(501);
    expect((await r.transport.fetch("https://external.invalid/api/session")).status).toBe(403);
    expect((await r.transport.fetch("http://user:password@127.0.0.1:7777/api/session")).status).toBe(403);
    expect((await r.transport.fetch("file:///etc/passwd")).status).toBe(403);
    expect((await r.transport.fetch("http://[")).status).toBe(400);
    expect(network).not.toHaveBeenCalled(); network.mockRestore();
  });
  it("rejects malformed/credentialled constructor addresses and busy-loop heartbeat settings without exposing inputs", () => {
    const f = feed();
    expect(() => new OcReadTransport(f.source, "not-url")).toThrow("读取地址无效");
    expect(() => new OcReadTransport(f.source, "http://user:password@127.0.0.1/")).toThrow("无凭据");
    expect(() => new OcReadTransport(f.source, "file:///tmp/test")).toThrow("HTTP(S)");
    expect(() => new OcReadTransport(f.source, "http://127.0.0.1/", 0)).toThrow("保活间隔无效");
  });
  it("honours Request method and rejects both stream/reads before native confirmation", async () => {
    const r = rig(); expect((await r.transport.fetch(new Request("http://127.0.0.1:7777/api/session", { method: "DELETE" }))).status).toBe(501);
    r.set({ ...r.source.getSnapshot(), write: { ...r.source.getSnapshot().write, connState: "closed" } });
    expect((await r.transport.fetch("/api/global/event")).status).toBe(503);
    expect((await r.transport.fetch("/api/session")).status).toBe(503); expect(r.listeners.size).toBe(0);
  });
  it("uses the exact SDK envelope via SSE; live final is not persistence; no duplicate on unrelated updates", async () => {
    const r = rig(); const response = await r.transport.fetch("/api/global/event"); expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    const reader = response.body!.getReader(); const f = r.source.getSnapshot();
    r.set({ ...f, detail: { ...f.detail, liveEvents: [{ kind: "message-final", role: "assistant", text: "answer" }] } });
    const first = decode.decode((await reader.read()).value); const event = JSON.parse(first.slice(6).trim());
    expect(event).toMatchObject({ directory: "/test/workspace", payload: { type: "message.updated", properties: { info: { native: { final: false, temporary: true } } } } });
    expect(decode.decode((await reader.read()).value)).toContain("message.part.updated");
    r.set({ ...r.source.getSnapshot(), write: { ...f.write } });
    expect(r.listeners.size).toBe(1); await reader.cancel(); expect(r.listeners.size).toBe(0);
  });
  it("normal stream cancellation removes the listener and heartbeat, without a double-close", async () => {
    vi.useFakeTimers(); const r = rig(); const response = await r.transport.fetch("/api/event"); expect(vi.getTimerCount()).toBe(1);
    await response.body!.cancel(); expect(r.listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
    r.transport.dispose(); expect((await r.transport.fetch("/health")).status).toBe(503);
  });
  it("abort closes active stream and already-aborted input rejects before creating one", async () => {
    const r = rig(); const abort = new AbortController(); const response = await r.transport.fetch("/api/global/event", { signal: abort.signal });
    const reader = response.body!.getReader(); const pending = reader.read(); abort.abort(); expect(await pending).toEqual({ done: true, value: undefined }); expect(r.listeners.size).toBe(0);
    await expect(r.transport.fetch("/api/global/event", { signal: abort.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
  it("connection loss closes stream, doesn't fake server.connected or automatically retry any request", async () => {
    const r = rig(); const response = await r.transport.fetch("/api/global/event"); const reader = response.body!.getReader(); const pending = reader.read();
    const f = r.source.getSnapshot(); r.set({ ...f, detail: { ...f.detail, connState: "closed" } });
    expect(await pending).toEqual({ done: true, value: undefined }); expect(r.listeners.size).toBe(0);
  });
  it("dispose closes every reader and is irreversible; heartbeat is parser-only, not status", async () => {
    vi.useFakeTimers(); const r = rig(); const first = await r.transport.fetch("/api/global/event"); const second = await r.transport.fetch("/api/global/event");
    const a = first.body!.getReader(); const b = second.body!.getReader(); const next = a.read();
    await vi.advanceTimersByTimeAsync(15000); expect(decode.decode((await next).value)).toBe("event: heartbeat\ndata: {}\n\n");
    await b.read(); const aeof = a.read(); const beof = b.read(); r.transport.dispose();
    expect((await aeof).done).toBe(true); expect((await beof).done).toBe(true); expect(r.listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
    r.transport.dispose(); expect((await r.transport.fetch("/health")).status).toBe(503);
  });
});
