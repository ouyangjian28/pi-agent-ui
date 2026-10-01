import { afterEach, describe, expect, it, vi } from "vitest";
import { DualHistorySource } from "../../../apps/server/src/runtime/dual-history-source.ts";
import type { HistoryReaderPort, HistoryWatcherPort } from "../../../apps/server/src/runtime/history-source.ts";
import { fnv1a64Hex } from "@pi-agent-ui/protocol";
const sessionText = `${JSON.stringify({ type: "session", version: 3, id: "owned", timestamp: "2026-01-01T00:00:00Z", cwd: "/workspace" })}\n${JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "assistant", content: [{ type: "text", text: "落盘答复" }] } })}\n`;
function fixture(delay = 10, permanent = false, onAudit: (line: string) => void = () => {}) {
  let ready = false, sessionWatches = 0, closed = 0, opened = 0;
  const reader: HistoryReaderPort = { read: async (path) => { const text = path.startsWith("/s/") ? sessionText : ""; return { text, identity: path, fingerprint: fnv1a64Hex(text) }; } };
  const watcher: HistoryWatcherPort = { watch: (path) => {
    if (path.startsWith("/s/")) { sessionWatches++; if (!ready || permanent) { ready = true; throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); } }
    opened++; return { close: () => { closed++; } };
  } };
  const src = new DualHistorySource({ roots: ["/j"], sessionRoots: ["/s"], journalFor: (file) => `/j/${file}`, sessionFor: (file) => `/s/${file}`, reader, watcher, sessionJoinDelayMs: delay, audit: onAudit });
  return { src, watcher, reader, watches: () => sessionWatches, active: () => opened - closed };
}
afterEach(() => vi.useRealTimers());
describe("写模式首次订阅等待SDK创建转录（受控读/观察）", () => {
  it("先缺文件、随后可读：同一次装载取得正文并绑定后续观察", async () => {
    const r = fixture(); const rows = await r.src.load("owned.jsonl");
    expect(rows?.some((row) => row.source === "session" && row.event.kind === "message" && row.event.textPreview?.text === "落盘答复")).toBe(true);
    expect(r.watches()).toBe(2);
    const stop = r.src.observe("owned.jsonl", { onAppend: () => {}, onLive: () => {}, onStatus: () => {} });
    expect(stop).not.toBeNull(); stop?.(); r.src.dispose(); expect(r.active()).toBe(0);
  });
  it("始终缺失：最多三次尝试且仍诚实journal-only，无孤儿观察", async () => {
    const r = fixture(5, true); expect(await r.src.load("owned.jsonl")).toEqual([]); expect(r.watches()).toBe(3);
    r.src.release("owned.jsonl"); r.src.dispose(); expect(r.active()).toBe(0);
  });
  it("缺省0保留原只读立即降级行为", async () => {
    const r = fixture(0); expect(await r.src.load("owned.jsonl")).toEqual([]); expect(r.watches()).toBe(1); r.src.release("owned.jsonl"); r.src.dispose();
  });
  it("等待窗内dispose：不重开子源，精确收回原观察", async () => {
    vi.useFakeTimers(); let reached!: () => void; const waiting = new Promise<void>((resolve) => { reached = resolve; });
    const r = fixture(20, true, (line) => { if (line.includes("session-join-wait")) reached(); });
    const loading = r.src.load("owned.jsonl"); await waiting; r.src.dispose(); await vi.advanceTimersByTimeAsync(20);
    expect(await loading).toBeNull(); expect(r.watches()).toBe(1); expect(r.active()).toBe(0);
  });
  it("事实源失败不被转录成功掩盖，零session装载", async () => {
    const r = fixture(); r.reader.read = async () => { throw new Error("journal unavailable"); };
    expect(await r.src.load("owned.jsonl")).toBeNull(); expect(r.watches()).toBe(0); r.src.dispose(); expect(r.active()).toBe(0);
  });
});
