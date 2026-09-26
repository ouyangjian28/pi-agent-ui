import { describe, expect, it } from "vitest";
import { DualHistorySource } from "../../apps/server/src/runtime/dual-history-source.ts";
import type { HistoryReaderPort, HistoryWatcherPort } from "../../apps/server/src/runtime/history-source.ts";
import type { HistoryInvalidateReason, HistorySinks, HistoryUnavailableReason } from "../../apps/server/src/ws/ws-gateway.ts";
import { matchKeyOf } from "@pi-agent-ui/protocol";
import type { ScanRow } from "@pi-agent-ui/protocol";

class PathReader implements HistoryReaderPort {
  readonly files = new Map<string, { text: string; identity: string }>();
  readCalls: string[] = [];
  read(absPath: string): Promise<{ text: string; identity: string }> {
    this.readCalls.push(absPath);
    const f = this.files.get(absPath);
    if (f === undefined) return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    return Promise.resolve({ text: f.text, identity: f.identity });
  }
  set(path: string, text: string, identity?: string): void { this.files.set(path, { text, identity: identity ?? `dev-ino-${path}` }); }
}
class PathWatcher implements HistoryWatcherPort {
  readonly handles: { abs: string; closed: boolean; onNotice: () => void; onError: (e: unknown) => void }[] = [];
  watch(abs: string, onNotice: () => void, onError: (e: unknown) => void): { close(): void } {
    const h = { abs, closed: false, onNotice, onError };
    this.handles.push(h);
    return { close: () => { h.closed = true; } };
  }
  active(abs: string) { return this.handles.filter((h) => h.abs === abs && !h.closed); }
  notice(abs: string): void { const h = [...this.active(abs)].pop(); if (h) h.onNotice(); }
}
const USER_TEXT = "hello dual";
function jEnqueue(intentId: string, text: string, ordinal: number): string {
  return JSON.stringify({ t: "enqueue", intentId, sessionId: "s", generation: 1, leafId: "L", matchKey: matchKeyOf(text, [], ordinal), payload: { kind: "prompt", rawText: text, attachments: [], sentAt: "1" } });
}
function sUser(id: string, text: string): string {
  return JSON.stringify({ type: "message", id, parentId: null, timestamp: 1, message: { role: "user", content: text } });
}
async function drain(ms = 4): Promise<void> { await new Promise((r) => setTimeout(r, ms)); }
async function until(cond: () => boolean, ms = 800): Promise<void> {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await drain(2);
  if (!cond()) throw new Error("until timeout");
}

describe("dbg exhaustion", () => {
  it("trace", async () => {
    const reader = new PathReader();
    const watcher = new PathWatcher();
    const audits: string[] = [];
    const src = new DualHistorySource({ roots: ["/j"], sessionRoots: [/s/], sessionFor: (f) => f.replace("/j/", "/s/"), reader, watcher, audit: (l) => { audits.push(l); console.log("AUDIT", l); } });
    const held: Array<(v: { text: string; identity: string } | Error) => void> = [];
    const baseRead = reader.read.bind(reader);
    reader.read = (p: string) => {
      if (p === "/s/a") return new Promise((res, rej) => { held.push((v) => { if (v instanceof Error) rej(v); else res(v); }); });
      return baseRead(p);
    };
    reader.set("/j/a", jEnqueue("i-1", USER_TEXT, 0) + "\n", "id-j1");
    await src.load("/j/a");
    const log: HistoryInvalidateReason[] = [];
    const sinks: HistorySinks = { onAppend: () => {}, onInvalidate: (r) => { log.push(r); console.log("INVALIDATE", r); }, onUnavailable: () => {}, onLive: () => {}, onStatus: () => {} };
    const un = src.observe("/j/a", sinks);
    reader.set("/s/a", sUser("u1", USER_TEXT) + "\n");
    const ld = src.load("/j/a");
    for (let round = 2; round <= 4; round++) {
      await until(() => held.length >= 1);
      console.log("ROUND", round, "held", held.length, "readCalls", reader.readCalls.join(","));
      reader.set("/j/a", jEnqueue(`i-${round}`, "replaced", 0) + "\n", `id-j${round}`);
      watcher.notice("/j/a");
      await until(() => log.includes("replace" as HistoryInvalidateReason));
      const settle = held.shift();
      settle?.({ text: sUser("u1", USER_TEXT) + "\n", identity: `id-s${round}` });
      await drain(10);
      console.log("post-settle audits:", audits.length);
    }
    console.log("awaiting ld...");
    const rows = await ld;
    console.log("LD RESOLVED", rows === null ? "null" : rows.length);
    expect(audits.some((l) => l.includes("load-revalidate-exhausted"))).toBe(true);
    un?.();
  }, 15000);
});
