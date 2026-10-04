import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { NativePiPort, type NativePiSnapshot } from "../../../apps/web/src/oc-bridge/native-pi-port";
import { getNativeSdkFetch, installNativeSdkFetch, type NativeSdkBinding } from "../../../apps/web/src/oc-bridge/native-sdk-fetch";

const ROOT = resolve(process.cwd());
const require = createRequire(resolve(ROOT, "package.json"));
const ts = require("typescript") as typeof import("typescript");
const { nativeRuntimeFetchTransform } = await import(resolve(ROOT, "tools/ui-oc-native-fetch-transform.mjs"));
const original = readFileSync(resolve(ROOT, "vendor/openchamber-frontend/packages/ui/src/lib/runtime-fetch.ts"), "utf8");
const compiled = ts.transpileModule(nativeRuntimeFetchTransform(original), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const bindings: NativeSdkBinding[] = [];
afterEach(() => { for (const binding of bindings.splice(0)) binding.dispose(); vi.restoreAllMocks(); });
function rig() {
  const native = new NativePiPort("ws://127.0.0.1/ws", "sdk-fixture-only");
  const initial = native.getSnapshot(); native.dispose();
  let facts: NativePiSnapshot = { ...initial,
    list: { ...initial.list, state: "ready", sessions: [], hasMore: false, listReliability: "full", roots: { status: "ok", items: ["/test/journal", "/test/workspace"], journalRoot: "/test/journal", cause: null } },
    detail: { ...initial.detail, connState: "ready", file: "a.jsonl", phase: "live" },
    write: { ...initial.write, connState: "ready" },
  };
  const listeners = new Set<() => void>();
  const port = { getSnapshot: () => facts, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; } };
  const network = vi.fn<typeof fetch>(async () => new Response("static/native-network-only"));
  const target = { fetch: network as typeof fetch, location: { origin: "http://127.0.0.1:7777", href: "http://127.0.0.1:7777/" } };
  const install = (capture: typeof fetch = network) => {
    const binding = installNativeSdkFetch(target, port, target.location.origin, capture); bindings.push(binding); return binding;
  };
  return { target, network, port, listeners, install, set(value: NativePiSnapshot) { facts = value; for (const fn of [...listeners]) fn(); } };
}
function sourceModule(r: ReturnType<typeof rig>) {
  const relay = { fetch: vi.fn(async () => new Response("legacy-relay")) };
  const getRelay = vi.fn(() => relay);
  const authHeaders = vi.fn(async (value: Headers) => value);
  const authResponse = vi.fn();
  const resolver = vi.fn(() => ({ api: () => "https://legacy.invalid/api", auth: () => "https://legacy.invalid/auth", health: () => "https://legacy.invalid/health" }));
  const exports: Record<string, any> = {};
  const context: Record<string, any> = { exports, window: r.target, Request, Response, Headers, URL, URLSearchParams };
  Object.defineProperty(context, "fetch", { get: () => r.target.fetch });
  context.require = (name: string) => {
    if (name === "@pi-native/sdk-fetch") return { getNativeSdkFetch: () => getNativeSdkFetch(r.target) };
    if (name === "./relay/runtime-tunnel") return { getActiveRelayTunnel: getRelay };
    if (name === "./relay/tunnel-payloads") return { TUNNEL_PARSE_BASE: r.target.location.origin };
    if (name === "./runtime-auth") return { buildRuntimeAuthHeaders: authHeaders };
    if (name === "./runtime-auth-expiry") return { observeRuntimeAuthResponse: authResponse };
    if (name === "./runtime-url") return { getRuntimeUrlResolver: resolver };
    throw new Error("Unexpected actual source runtime import: " + name);
  };
  runInNewContext(compiled, context);
  return { exports, relay, getRelay, authHeaders, authResponse, resolver };
}

describe("actual original SDK native fetch seam (not App/bootstrap/send acceptance)", () => {
  it("leaves an unbound source scope null, with no implicit port creation", () => {
    const r = rig(); expect(getNativeSdkFetch(r.target)).toBeNull(); expect(r.network).not.toHaveBeenCalled();
  });
  it("binds health/auth/path/config/session reads to confirmed facts, not network", async () => {
    const r = rig(); const b = r.install(); expect(getNativeSdkFetch(r.target)).toBe(b.fetch);
    expect(await (await r.target.fetch("/health")).json()).toMatchObject({ healthy: true, nativePi: true });
    expect(await (await b.fetch("/auth/session")).json()).toMatchObject({ authenticated: true, nativePi: true });
    expect(await (await b.fetch("/api/path")).json()).toMatchObject({ directory: "/test/workspace", nativeExecutionDirectoryKnown: false });
    expect(await (await b.fetch("/api/session")).json()).toEqual([]); expect(r.network).not.toHaveBeenCalled();
  });
  it("refuses every SDK write including Request streaming/consumed bodies without reading them", async () => {
    const r = rig(); const b = r.install();
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "HEAD"]) expect((await b.fetch("/api/session/a.jsonl/prompt_async", { method })).status).toBe(501);
    const body = new Request("http://127.0.0.1:7777/api/session", { method: "POST", body: "fixture-body" }); await body.text();
    expect((await b.fetch(body)).status).toBe(501); expect(r.network).not.toHaveBeenCalled();
  });
  it("refuses foreign, credentialled and malformed addresses without network", async () => {
    const r = rig(); const b = r.install();
    for (const value of ["https://outside.invalid/api/session", "http://user:fixture@127.0.0.1:7777/api/session", "file:///tmp/fixture"]) expect((await b.fetch(value)).status).toBe(403);
    expect((await b.fetch("http://[")).status).toBe(400); expect(r.network).not.toHaveBeenCalled();
  });
  it("permits only captured same-origin static GETs; native HTTP and unknown backend routes remain refused", async () => {
    const r = rig(); const b = r.install();
    for (const value of ["/terminal", "/goal", "/login", "/api/attachments", "/private/asset.png"]) expect((await b.fetch(value)).status).toBe(501);
    expect((await b.fetch("/assets/ui.js", { method: "POST" })).status).toBe(501);
    expect(await (await b.fetch("/assets/ui.js")).text()).toBe("static/native-network-only"); expect(r.network).toHaveBeenCalledTimes(1);
  });
  it("matches source query set/last-value semantics and preserves options, without adding source credentials", async () => {
    const r = rig(); const b = r.install(); const signal = new AbortController().signal;
    await b.fetch("/assets/ui.js?a=old", { query: new URLSearchParams([["a", "first"], ["a", "last"]]), signal, headers: { "x-test": "fixture-only" } });
    const [input, init] = r.network.mock.calls[0]!; expect(String(input)).toBe("http://127.0.0.1:7777/assets/ui.js?a=last"); expect(init).toMatchObject({ signal, headers: { "x-test": "fixture-only" } }); expect(init).not.toHaveProperty("query");
    await b.fetch("/assets/ui.js", { query: { yes: true, n: 3, absent: null, missing: undefined } }); expect(String(r.network.mock.calls[1]![0])).toBe("http://127.0.0.1:7777/assets/ui.js?yes=true&n=3");
  });
  it("rejects invalid constructor input with fixed errors and no installed bridge", () => {
    const r = rig();
    for (const url of ["not-url", "file:///tmp/fixture", "http://user:fixture@127.0.0.1/", "http://127.0.0.1/?token=fixture", "http://127.0.0.1/#fixture"]) {
      expect(() => installNativeSdkFetch(r.target, r.port, url, r.network)).toThrow(/pi SDK/); expect(getNativeSdkFetch(r.target)).toBeNull();
    }
    expect(r.target.fetch).toBe(r.network);
  });
  it("honours Request method and init override instead of inventing SDK HTTP success", async () => {
    const r = rig(); const b = r.install(); const request = new Request("http://127.0.0.1:7777/health");
    expect((await b.fetch(request)).status).toBe(200); expect((await b.fetch(request, { method: "POST" })).status).toBe(501); expect(r.network).not.toHaveBeenCalled();
  });
  it("cannot replace a live/disposed owner binding or revive its old HTTP path", () => {
    const r = rig(); const b = r.install(); expect(() => r.install()).toThrow("不可偷偷替换"); b.dispose(); expect(() => r.install()).toThrow("不可偷偷替换"); expect(getNativeSdkFetch(r.target)).toBe(b.fetch);
  });
  it("disposal leaves direct globals and captured SDK wrappers fail-closed without disposing the owner", async () => {
    const r = rig(); const originalFacts = r.port.getSnapshot(); const b = r.install(); const captured = b.fetch; b.dispose(); b.dispose();
    expect(r.port.getSnapshot()).toBe(originalFacts); expect((await captured("/health")).status).toBe(503); expect((await r.target.fetch("/api/session", { method: "POST" })).status).toBe(503); expect(r.network).not.toHaveBeenCalled();
  });
  it("connection loss is observed from the same port, with no HTTP/relay fallback", async () => {
    const r = rig(); const b = r.install(); const f = r.port.getSnapshot(); r.set({ ...f, write: { ...f.write, connState: "closed" } });
    expect((await b.fetch("/health")).status).toBe(503); expect((await b.fetch("/api/global/event")).status).toBe(503); expect(r.listeners.size).toBe(0); expect(r.network).not.toHaveBeenCalled();
  });
  it("keeps separately captured native login/upload usable, never through the SDK seam", async () => {
    const r = rig(); const nativeHttp = r.network; const b = r.install();
    expect((await b.fetch("/api/attachments", { method: "POST" })).status).toBe(501); expect(r.network).not.toHaveBeenCalled();
    await nativeHttp("http://127.0.0.1:7777/api/attachments", { method: "POST", body: "native-fixture-only" }); expect(r.network).toHaveBeenCalledTimes(1);
  });
  it("shares SSE reads with the native transport and releases all subscribers on disposal", async () => {
    const r = rig(); const b = r.install(); const response = await b.fetch("/api/global/event"); expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader(); const pending = reader.read(); expect(r.listeners.size).toBe(1); b.dispose(); expect((await pending).done).toBe(true); expect(r.listeners.size).toBe(0); expect(r.network).not.toHaveBeenCalled();
  });
  it("rejects already-aborted reads and static requests without adding a subscriber/network request", async () => {
    const r = rig(); const b = r.install(); const abort = new AbortController(); abort.abort();
    for (const path of ["/api/global/event", "/assets/ui.js"]) await expect(b.fetch(path, { signal: abort.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(r.listeners.size).toBe(0); expect(r.network).not.toHaveBeenCalled();
  });
  it("actual source runtimeFetch takes native reads/writes before an active relay, URL resolver, or legacy auth", async () => {
    const r = rig(); const source = sourceModule(r); r.install();
    expect(await (await source.exports.runtimeFetch("/health")).json()).toMatchObject({ nativePi: true });
    expect((await source.exports.runtimeFetch("/api/session", { method: "POST" })).status).toBe(501);
    expect((await source.exports.runtimeFetch("https://legacy.invalid/api/session")).status).toBe(403);
    for (const call of [source.getRelay, source.relay.fetch, source.resolver, source.authHeaders, source.authResponse, r.network]) expect(call).not.toHaveBeenCalled();
  });
  it("actual source global installer does not wrap native fetch or recurse on static assets", async () => {
    const r = rig(); const source = sourceModule(r); const b = r.install(); source.exports.installRuntimeFetchBridge(); expect(r.target.fetch).toBe(b.fetch);
    await r.target.fetch("/assets/ui.js"); expect(r.network).toHaveBeenCalledTimes(1); expect(source.getRelay).not.toHaveBeenCalled();
  });
  it("actual pre-existing source global wrapper delegates to the native bridge after binding, not relay/network", async () => {
    const r = rig(); const source = sourceModule(r); source.exports.installRuntimeFetchBridge(); const capturedSourceFetch = r.target.fetch;
    r.install(r.network); expect((await capturedSourceFetch("/api/session", { method: "POST" })).status).toBe(501);
    expect(await (await capturedSourceFetch("/health")).json()).toMatchObject({ nativePi: true });
    await capturedSourceFetch("/assets/ui.js"); expect(r.network).toHaveBeenCalledTimes(1); expect(source.getRelay).not.toHaveBeenCalled();
  });
  it("actual source fallback is unchanged when unbound, and source drift/double transformation fails visibly", async () => {
    const r = rig(); const source = sourceModule(r); expect(await (await source.exports.runtimeFetch("/health")).text()).toBe("legacy-relay"); expect(source.relay.fetch).toHaveBeenCalledTimes(1);
    expect(() => nativeRuntimeFetchTransform(nativeRuntimeFetchTransform(original))).toThrow("already applied");
    expect(() => nativeRuntimeFetchTransform(original.replace("export const runtimeFetch = async", "export const driftedFetch = async"))).toThrow("anchor missing/duplicated");
  });
  it("rejects a wrongly captured SDK wrapper instead of infinitely recursing or forwarding an SDK write", async () => {
    const r = rig(); const source = sourceModule(r); source.exports.installRuntimeFetchBridge(); const wrongCapture = r.target.fetch;
    const b = r.install(wrongCapture); expect((await b.fetch("/assets/ui.js")).status).toBe(503); expect((await b.fetch("/api/session", { method: "POST" })).status).toBe(501); expect(r.network).not.toHaveBeenCalled();
  });
});
