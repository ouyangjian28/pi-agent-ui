// D3 扩展问答——会话面（docs/d3-ui-passthrough-design.md §7 W-ui-s*）。
// 覆盖矩阵：
//  W-ui-s1 对话族 demux→onUiRequest（select 携 options/timeout 原样）   W-ui-s6 代次终结→pending 全灭+onUiClosed 逐个
//  W-ui-s2 notify→onUiNote（缺省/非法 notifyType→info）                 W-ui-s7 cap 8：第 9 个立即 cancelled+overflow
//  W-ui-s3 setStatus 等四法+未知法→审计 ui-unsupported，不出门          W-ui-s8 恶形丢弃：无 id/select 空 options
//  W-ui-s4 answerUi delivered→stdin 写 extension_ui_response 行          W-ui-s9 onUiRequest 回调抛错→回滚+cancelled+overflow
//  W-ui-s5 首答胜出：次答 unknown；晚答照转（delivered 不因 pi 自答拦截）
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProcessHandle, ProcessHostPort, ProcessSpawnHandlers } from "@pi-agent-ui/protocol";
import { FileDurability } from "../../../apps/server/src/runtime/file-durability.js";
import { RpcSession, UI_PENDING_MAX, type UiAsk, type UiNoteEvent } from "../../../apps/server/src/runtime/rpc-session.js";

class FakeRpcHost implements ProcessHostPort {
  readonly frames: string[] = [];
  private handler: ProcessSpawnHandlers | null = null;
  handle: ProcessHandle | null = null;
  spawn(_args: readonly string[], h: ProcessSpawnHandlers): ProcessHandle {
    this.handler = h;
    this.handle = { id: "fake" };
    return this.handle;
  }
  async writeStdin(_h: ProcessHandle, text: string): Promise<void> { this.frames.push(text); }
  stop(): void { /* noop */ }
  closeStdin(): void { /* noop */ }
  emitEvent(obj: unknown): void { this.handler?.onEvent(obj); }
  emitExit(code: number | null, signal: string | null): void { this.handler?.onExit(code, signal); }
}

const dirs: string[] = [];
const sessions: RpcSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.dispose()));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const tick = (): Promise<void> => new Promise((res) => setImmediate(() => res()));

async function makeRig(over: {
  onUiRequest?: (ask: UiAsk) => void;
  onUiNote?: (note: UiNoteEvent) => void;
  onUiClosed?: (requestId: string, reason: string) => void;
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "rpc-ui-"));
  dirs.push(dir);
  const host = new FakeRpcHost();
  const audits: string[] = [];
  const asks: UiAsk[] = [];
  const notes: UiNoteEvent[] = [];
  const closed: Array<{ requestId: string; reason: string }> = [];
  const session = new RpcSession({
    piArgs: ["--mode", "rpc", "--no-session"],
    journalPath: join(dir, "journal.jsonl"),
    sessionId: "s-ui",
    host,
    durability: new FileDurability(join(dir, "journal.jsonl")),
    readinessTimeoutMs: 500,
    responseTimeoutMs: 5_000,
    timeoutPollMs: 20,
    audit: (l) => audits.push(l),
    onUiRequest: over.onUiRequest ?? ((ask) => asks.push(ask)),
    onUiNote: over.onUiNote ?? ((note) => notes.push(note)),
    onUiClosed: over.onUiClosed ?? ((requestId, reason) => closed.push({ requestId, reason })),
  });
  sessions.push(session);
  // 起 ready：探针→回执（demux 就位，gen=1 running）
  const p = session.start();
  await (async function waitProbe(): Promise<void> { if (host.frames.length === 0) { await tick(); return waitProbe(); } })();
  const probe = JSON.parse(host.frames[0]!) as { id: string };
  host.emitEvent({ id: probe.id, type: "response", command: "get_state", success: true });
  await p;
  return { session, host, audits, asks, notes, closed, dir };
}

/** host.frames 里的 extension_ui_response 行。 */
const uiResponses = (h: FakeRpcHost): Array<Record<string, unknown>> =>
  h.frames.filter((f) => f.includes("extension_ui_response")).map((f) => JSON.parse(f) as Record<string, unknown>);

describe("D3 扩展问答：会话面", () => {
  it("W-ui-s1 对话族 demux→onUiRequest（字段原样：options/timeout/title）", async () => {
    const r = await makeRig();
    r.host.emitEvent({ type: "extension_ui_request", id: "q-1", method: "select", title: "选一个", options: ["a", "b"], timeout: 30000 });
    expect(r.asks).toEqual([{ requestId: "q-1", method: "select", title: "选一个", options: ["a", "b"], timeoutMs: 30000 }]);
    expect(r.audits.some((l) => l.includes("ui-request-drop"))).toBe(false);
    // confirm/input/editor 形
    r.host.emitEvent({ type: "extension_ui_request", id: "q-2", method: "confirm", message: "继续？" });
    r.host.emitEvent({ type: "extension_ui_request", id: "q-3", method: "input", placeholder: "输入" });
    r.host.emitEvent({ type: "extension_ui_request", id: "q-4", method: "editor", prefill: "draft" });
    expect(r.asks.map((a) => a.method)).toEqual(["select", "confirm", "input", "editor"]);
  });

  it("W-ui-s2 notify→onUiNote；缺省/非法 notifyType 归 info", async () => {
    const r = await makeRig();
    r.host.emitEvent({ type: "extension_ui_request", id: "n-1", method: "notify", message: "你好" });
    r.host.emitEvent({ type: "extension_ui_request", id: "n-2", method: "notify", message: "警告", notifyType: "warning" });
    r.host.emitEvent({ type: "extension_ui_request", id: "n-3", method: "notify", message: "错误", notifyType: "error" });
    r.host.emitEvent({ type: "extension_ui_request", id: "n-4", method: "notify", message: "怪型", notifyType: "bogus" });
    r.host.emitEvent({ type: "extension_ui_request", id: "n-5", method: "notify" }); // 无 message
    expect(r.notes.map((n) => n.notifyType)).toEqual(["info", "warning", "error", "info"]);
    expect(r.notes.length).toBe(4);
    expect(r.audits.some((l) => l.includes("ui-notify-drop") && l.includes("n-5"))).toBe(true);
  });

  it("W-ui-s3 setStatus 等四法+未知法→审计 ui-unsupported；零回调零 stdin", async () => {
    const r = await makeRig();
    r.host.emitEvent({ type: "extension_ui_request", id: "s-1", method: "setStatus" });
    r.host.emitEvent({ type: "extension_ui_request", id: "s-2", method: "setWidget" });
    r.host.emitEvent({ type: "extension_ui_request", id: "s-3", method: "setTitle" });
    r.host.emitEvent({ type: "extension_ui_request", id: "s-4", method: "set_editor_text" });
    r.host.emitEvent({ type: "extension_ui_request", id: "s-5", method: "quantum" });
    expect(r.asks).toEqual([]);
    expect(r.notes).toEqual([]);
    expect(uiResponses(r.host)).toEqual([]);
    expect(r.audits.filter((l) => l.includes("ui-unsupported")).length).toBe(5);
  });

  it("W-ui-s4 answerUi delivered→stdin 写 extension_ui_response（type/id/载荷）", async () => {
    const r = await makeRig();
    r.host.emitEvent({ type: "extension_ui_request", id: "q-1", method: "select", options: ["a", "b"] });
    expect((await r.session.answerUi("q-1", { value: "a" })).kind).toBe("delivered");
    const lines = uiResponses(r.host);
    expect(lines).toEqual([{ type: "extension_ui_response", id: "q-1", value: "a" }]);
    // 三载荷形：confirmed / cancelled
    r.host.emitEvent({ type: "extension_ui_request", id: "q-2", method: "confirm" });
    r.host.emitEvent({ type: "extension_ui_request", id: "q-3", method: "input" });
    expect((await r.session.answerUi("q-2", { confirmed: false })).kind).toBe("delivered");
    expect((await r.session.answerUi("q-3", { cancelled: true })).kind).toBe("delivered");
    expect(uiResponses(r.host).slice(1)).toEqual([
      { type: "extension_ui_response", id: "q-2", confirmed: false },
      { type: "extension_ui_response", id: "q-3", cancelled: true },
    ]);
  });

  it("W-ui-s5 首答胜出：次答 unknown；pending 清（同 id 不复活）", async () => {
    const r = await makeRig();
    r.host.emitEvent({ type: "extension_ui_request", id: "q-1", method: "input" });
    expect((await r.session.answerUi("q-1", { value: "x" })).kind).toBe("delivered");
    expect((await r.session.answerUi("q-1", { value: "y" })).kind).toBe("unknown");
    expect(uiResponses(r.host).length).toBe(1); // 只写出首答
    expect(r.audits.some((l) => l.includes("ui-request-duplicate"))).toBe(false);
  });

  it("W-ui-s6 代次终结（意外退出）→本代 pending 全灭+onUiClosed(process-retired) 逐个；此后答案 unknown", async () => {
    const r = await makeRig();
    r.host.emitEvent({ type: "extension_ui_request", id: "q-1", method: "input" });
    r.host.emitEvent({ type: "extension_ui_request", id: "q-2", method: "select", options: ["a"] });
    r.host.emitEvent({ type: "extension_ui_request", id: "n-1", method: "notify", message: "旁听" }); // 非对话族不入 pending
    r.host.emitExit(1, null); // 意外退出→代次终结
    await tick(); await tick();
    expect(r.closed).toEqual([
      { requestId: "q-1", reason: "process-retired" },
      { requestId: "q-2", reason: "process-retired" },
    ]);
    expect((await r.session.answerUi("q-1", { cancelled: true })).kind).toBe("unknown");
    expect(uiResponses(r.host).length).toBe(0); // 不向死进程写 stdin
  });

  it("W-ui-s7 cap 8：第 9 个立即回 cancelled+onUiClosed(overflow)；不入 pending", async () => {
    const r = await makeRig();
    for (let i = 1; i <= UI_PENDING_MAX; i++) r.host.emitEvent({ type: "extension_ui_request", id: `q-${i}`, method: "input" });
    r.host.emitEvent({ type: "extension_ui_request", id: "q-9", method: "input" });
    expect(r.asks.length).toBe(UI_PENDING_MAX); // 第 9 个未上抛
    expect(r.closed).toEqual([{ requestId: "q-9", reason: "overflow" }]);
    expect(uiResponses(r.host)).toEqual([{ type: "extension_ui_response", id: "q-9", cancelled: true }]);
    expect(r.audits.some((l) => l.includes("ui-overflow") && l.includes("q-9"))).toBe(true);
    // 撤一个后可再入（pending 有界释放）
    expect((await r.session.answerUi("q-1", { value: "v" })).kind).toBe("delivered");
    r.host.emitEvent({ type: "extension_ui_request", id: "q-10", method: "input" });
    expect(r.asks.length).toBe(UI_PENDING_MAX + 1);
  });

  it("W-ui-s8 恶形丢弃：无 id/空 id/超长 id/select 空 options→零回调零 stdin", async () => {
    const r = await makeRig();
    r.host.emitEvent({ type: "extension_ui_request", method: "input" }); // 无 id
    r.host.emitEvent({ type: "extension_ui_request", id: "", method: "input" });
    r.host.emitEvent({ type: "extension_ui_request", id: "x".repeat(129), method: "input" });
    r.host.emitEvent({ type: "extension_ui_request", id: "q-s", method: "select", options: [] }); // 空 options
    r.host.emitEvent({ type: "extension_ui_request", id: "q-s2", method: "select", options: "a,b" }); // 非数组
    expect(r.asks).toEqual([]);
    expect(uiResponses(r.host)).toEqual([]);
    expect(r.audits.filter((l) => l.includes("ui-request-drop")).length).toBe(5);
  });

  it("W-ui-s9 onUiRequest 回调抛错→回滚登记+回 cancelled+onUiClosed(overflow)", async () => {
    const r = await makeRig({ onUiRequest: () => { throw new Error("sink-boom"); } });
    r.host.emitEvent({ type: "extension_ui_request", id: "q-1", method: "input" });
    await tick();
    expect(uiResponses(r.host)).toEqual([{ type: "extension_ui_response", id: "q-1", cancelled: true }]);
    expect(r.closed).toEqual([{ requestId: "q-1", reason: "overflow" }]);
    expect((await r.session.answerUi("q-1", { cancelled: true })).kind).toBe("unknown"); // 已回滚
  });
});
