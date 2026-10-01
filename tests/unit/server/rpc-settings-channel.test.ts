import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcSettingsChannel, SettingsRpcError } from "../../../apps/server/src/runtime/rpc-settings-channel.ts";
const channels: RpcSettingsChannel[] = [];
afterEach(() => { for (const channel of channels.splice(0)) channel.dispose(); vi.useRealTimers(); });
function rig(writeOverride?: (line: string) => Promise<boolean>) {
  let current = 1;
  const frames: Array<{ id: string; type: string }> = [];
  const channel = new RpcSettingsChannel({ timeoutMs: 30, isCurrent: (g) => g === current,
    write: async (_g, line) => { frames.push(JSON.parse(line) as { id: string; type: string }); return writeOverride === undefined ? true : writeOverride(line); },
  });
  channels.push(channel);
  return { channel, frames, setCurrent: (g: number) => { current = g; }, reply: (data: unknown, generation = 1) => {
    const frame = frames.at(-1); if (frame === undefined) throw Error("no config frame");
    return channel.accept({ type: "response", id: frame.id, command: frame.type, success: true, data }, generation);
  } };
}
const captured = (p: Promise<unknown>) => p.then(value => ({ value, error: null }), (error: unknown) => ({ value: null, error }));

describe("pi settings control channel", () => {
  it("binds real command/id/generation and never uses c* or readiness ids", async () => {
    const r = rig(); const p = r.channel.request(1, { type: "get_state" }); await Promise.resolve();
    expect(r.frames[0]).toEqual({ id: "cfg-1-1", type: "get_state" }); expect(r.reply({ isStreaming: false })).toBe(true);
    expect(await p).toEqual({ isStreaming: false });
  });
  it("ignores c*, readiness, wrong-generation and unrelated responses", async () => {
    const r = rig(); const p = r.channel.request(1, { type: "get_available_models" }); await Promise.resolve();
    for (const id of ["c1", "ready-1", "cfg-1-999"]) expect(r.channel.accept({ type: "response", id, command: "get_available_models", success: true }, 1)).toBe(false);
    expect(r.reply({}, 2)).toBe(false); expect(r.reply({ models: [] })).toBe(true); expect(await p).toEqual({ models: [] });
  });
  it("early success does not finish a hanging stdin write; total deadline poisons only that generation", async () => {
    vi.useFakeTimers(); let release!: (v: boolean) => void; let writes = 0;
    const r = rig(() => ++writes === 1 ? new Promise<boolean>(resolve => { release = resolve; }) : Promise.resolve(true));
    let settled = false; const p = captured(r.channel.request(1, { type: "set_thinking_level", level: "high" })).then(result => { settled = true; return result; });
    await Promise.resolve(); r.reply(undefined); await Promise.resolve(); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(31); expect((await p).error).toMatchObject({ code: "timeout" }); expect(r.channel.isUncertain(1)).toBe(true);
    release(true); await Promise.resolve(); await expect(r.channel.request(1, { type: "get_state" })).rejects.toMatchObject({ code: "uncertain" }); expect(r.frames).toHaveLength(1);
    r.setCurrent(2); const next = r.channel.request(2, { type: "get_state" }); await Promise.resolve(); r.reply({ model: null }, 2); expect(await next).toEqual({ model: null }); expect(r.channel.isUncertain(2)).toBe(false);
  });
  it("write success without response times out and blocks reuse", async () => {
    vi.useFakeTimers(); const r = rig(); const p = captured(r.channel.request(1, { type: "get_state" }));
    await vi.advanceTimersByTimeAsync(31); expect((await p).error).toMatchObject({ code: "timeout" }); expect(r.channel.isUncertain(1)).toBe(true);
  });
  it("holds the first response snapshot against duplicates while write remains blocked", async () => {
    let release!: (v: boolean) => void; const r = rig(() => new Promise<boolean>(resolve => { release = resolve; }));
    const p = r.channel.request(1, { type: "get_state" }); await Promise.resolve(); const source = { first: true }; expect(r.reply(source)).toBe(true); source.first = false; expect(r.reply({ first: false })).toBe(true);
    release(true); expect(await p).toEqual({ first: true }); expect(r.reply({ first: false })).toBe(false);
  });
  it("known negative setters fail, don't expose remote errors, and quarantine partial mutation", async () => {
    const r = rig(); const p = captured(r.channel.request(1, { type: "set_model", provider: "fixture", modelId: "two" })); await Promise.resolve();
    const id = r.frames[0]?.id; r.channel.accept({ type: "response", id, command: "set_model", success: false, error: "/secret/internal/path" }, 1);
    const error = (await p).error; expect(error).toMatchObject({ code: "rejected" }); expect(String(error)).not.toContain("/secret"); expect(r.channel.isUncertain(1)).toBe(true);
  });
  it.each([{ command: "other", success: true }, { command: "get_state", success: "true" }])("malformed receipt fails closed: %j", async receipt => {
    const r = rig(); const p = captured(r.channel.request(1, { type: "get_state" })); await Promise.resolve();
    r.channel.accept({ type: "response", id: r.frames[0]?.id, ...receipt }, 1); expect((await p).error).toMatchObject({ code: "malformed" }); expect(r.channel.isUncertain(1)).toBe(true);
  });
  it.each(["false", "reject", "throw"])("host %s terminates a request without leaking a waiter", async failure => {
    const r = rig(() => { if (failure === "false") return Promise.resolve(false); if (failure === "reject") return Promise.reject(new Error("private path")); throw Error("private path"); });
    const result = await captured(r.channel.request(1, { type: "get_state" })); expect(result.error).toBeInstanceOf(SettingsRpcError); expect(result.error).toMatchObject({ code: "write-failed" }); expect(r.channel.isUncertain(1)).toBe(true);
  });
  it("rejects concurrent operations before writing their frames", async () => {
    const r = rig(); const p = r.channel.request(1, { type: "get_state" });
    await expect(r.channel.request(1, { type: "get_available_models" })).rejects.toMatchObject({ code: "busy" }); await Promise.resolve(); expect(r.frames).toHaveLength(1); r.reply({}); await p;
  });
  it("cancellation after response but before write releases waiter and ignores late completion", async () => {
    let release!: (v: boolean) => void; const r = rig(() => new Promise<boolean>(resolve => { release = resolve; })); const p = captured(r.channel.request(1, { type: "get_state" }));
    await Promise.resolve(); r.reply({}); r.channel.cancelGeneration(1); expect((await p).error).toMatchObject({ code: "stale" }); expect(r.reply({})).toBe(false); release(true);
  });
  it("generation change at final write continuation cannot confirm old settings", async () => {
    let release!: (v: boolean) => void; const r = rig(() => new Promise<boolean>(resolve => { release = resolve; })); const p = captured(r.channel.request(1, { type: "get_state" }));
    await Promise.resolve(); r.reply({}); r.setCurrent(2); release(true); expect((await p).error).toMatchObject({ code: "stale" });
  });
  it("stale entry and stop before queued write perform zero host writes", async () => {
    const r = rig(); await expect(r.channel.request(2, { type: "get_state" })).rejects.toMatchObject({ code: "stale" });
    const p = captured(r.channel.request(1, { type: "get_state" })); r.channel.cancelGeneration(1); expect((await p).error).toMatchObject({ code: "stale" }); expect(r.frames).toHaveLength(0);
  });
  it("dispose is synchronous, idempotent, clears pending operation and forbids future writes", async () => {
    const r = rig(); const p = captured(r.channel.request(1, { type: "get_state" })); r.channel.dispose(); r.channel.dispose(); expect((await p).error).toMatchObject({ code: "closed" });
    await expect(r.channel.request(1, { type: "get_state" })).rejects.toMatchObject({ code: "closed" }); expect(r.frames).toHaveLength(0);
  });
});
