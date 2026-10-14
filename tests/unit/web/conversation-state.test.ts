import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationState, classifySend, classifySendError } from "../../../apps/web/src/ws/conversation-state";
import { WriteSendError, type WriteClientSurface } from "../../../apps/web/src/ws/write-client";
import type { WriteSendOutcomeDTO } from "@pi-agent-ui/protocol/src/contracts";
const launched = { kind: "launched", intentId: "i-1", commandId: 1 } as const;
function rig(wait = 20_000) {
  let resolve!: (result: WriteSendOutcomeDTO) => void;
  let reject!: (error: unknown) => void;
  const refresh = vi.fn();
  const send = vi.fn(() => new Promise<WriteSendOutcomeDTO>((yes, no) => { resolve = yes; reject = no; }));
  const client: WriteClientSurface = {
    sendPrompt: send,
    sendStop: vi.fn(), resume: vi.fn(), subscribe: () => () => {},
    getSnapshot: () => ({ connState: "ready", errorKind: null, errorMessage: null, inflight: [], lastResult: null, resumeState: { phase: "idle" }, lastResumeResult: null }),
  };
  const state = new ConversationState(refresh, wait); state.setClient(client);
  const id = state.create("a.jsonl")!; state.edit(id, "v1");
  return { state, id, client, send, refresh, resolve: (r: WriteSendOutcomeDTO) => resolve(r), reject: (e: unknown) => reject(e) };
}
afterEach(() => vi.useRealTimers());
describe("v6 五域穷尽分类", () => {
  it.each<WriteSendOutcomeDTO>([
    { kind: "busy" }, { kind: "gate-rejected", reason: "busy" }, { kind: "identity-rejected", cause: "generation-mismatch" },
    { kind: "not-ready", cause: "spawn-exited", detail: "test" }, { kind: "no-process" }, { kind: "invalidated", stage: "first-byte" },
  ])("明确未启动 $kind 仅拒收", (outcome) => expect(classifySend(outcome).status).toBe("rejected"));
  it("launched≠任意 ACK；gate-failed 为保守未知", () => {
    expect(classifySend(launched).status).toBe("launched");
    expect(classifySend({ kind: "gate-failed", stage: "enqueue" }).status).toBe("unknown");
  });
  it.each(["not-ready", "local-invalid", "closed", "in-flight"] as const)("本地零帧 %s 保留分类", (kind) => {
    expect(classifySendError(new WriteSendError(kind, "controlled"), false)).toEqual({ status: "local", kind, message: "controlled" });
  });
  it.each(["server", "transport", "closed"] as const)("发出后 %s 不降为拒收", (kind) => {
    expect(classifySendError(new WriteSendError(kind, "controlled", kind === "server" ? 4402 : null), true).status).toBe("unknown");
  });
});
describe("v6 转移表，独立三门", () => {
  it("行1/2/3：发送前零订阅目标；launched 才开 A、清 v1、刷列表", async () => {
    const r = rig(); expect(r.state.getSnapshot().activeFile).toBeNull();
    const p = r.state.send(r.id); expect(r.state.getSnapshot().view).toEqual({ kind: "draft", id: r.id });
    expect(r.state.getSnapshot().activeFile).toBeNull();
    expect(r.send).toHaveBeenCalledWith("a.jsonl", "v1", undefined);
    r.resolve(launched); await p;
    expect(r.state.getSnapshot().view).toEqual({ kind: "session", file: "a.jsonl" });
    expect(r.state.getSnapshot().activeFile).toBe("a.jsonl");
    expect(r.state.getSnapshot().sessions.get("session:a.jsonl")?.text).toBe("");
    expect(r.refresh).toHaveBeenCalledTimes(1); r.state.dispose();
  });
  it("行3：在途编辑后改回同文本也不清；残稿首次带入，再开不重灌", async () => {
    const r = rig(); const p = r.state.send(r.id);
    r.state.edit(r.id, "v2"); r.state.edit(r.id, "v1"); r.resolve(launched); await p;
    expect(r.state.getSnapshot().sessions.get("session:a.jsonl")?.text).toBe("v1");
    r.state.edit("session:a.jsonl", "A 新稿"); r.state.back(); r.state.restore(r.id);
    expect(r.state.getSnapshot().sessions.get("session:a.jsonl")?.text).toBe("A 新稿"); r.state.dispose();
  });
  it("行4/5：拒收保全文+配置，未发送取消才丢弃", async () => {
    const r = rig(); r.state.configure(r.id, "gone/old", "my/model");
    const p = r.state.send(r.id, "my/model"); r.resolve({ kind: "not-ready" }); await p;
    expect(r.state.getSnapshot().drafts.get(r.id)).toMatchObject({ text: "v1", modelChoice: "gone/old", freeText: "my/model", phase: "settled-rejected" });
    r.state.back(); r.state.restore(r.id); expect(r.send).toHaveBeenCalledTimes(1);
    const d2 = r.state.create("d2.jsonl")!; r.state.back(); expect(r.state.getSnapshot().drafts.has(d2)).toBe(false); r.state.dispose();
  });
  it("行6/10：返回保原操作；禁新 D2 但恢复 D 不二发", async () => {
    const r = rig(); const p = r.state.send(r.id); r.state.edit(r.id, "v2"); r.state.back();
    expect(r.state.getSnapshot().drafts.get(r.id)?.phase).toBe("in-flight-away");
    expect(r.state.create("d2.jsonl")).toBeNull(); r.state.restore(r.id);
    expect(r.state.getSnapshot().drafts.get(r.id)).toMatchObject({ text: "v2", phase: "sending" });
    expect(r.send).toHaveBeenCalledTimes(1); r.resolve(launched); await p;
    expect(r.state.getSnapshot().sessions.get("session:a.jsonl")?.text).toBe("v2"); r.state.dispose();
  });
  it("行7/10c：list 收 launched 不订 A；人工恢复才订 A 残稿一次", async () => {
    const r = rig(); const p = r.state.send(r.id); r.state.edit(r.id, "v2"); r.state.back(); r.resolve(launched); await p;
    expect(r.state.getSnapshot()).toMatchObject({ view: { kind: "list" }, activeFile: null });
    expect(r.refresh).toHaveBeenCalledTimes(1); r.state.restore(r.id);
    expect(r.state.getSnapshot()).toMatchObject({ view: { kind: "session", file: "a.jsonl" }, activeFile: "a.jsonl" });
    r.state.edit("session:a.jsonl", "后续稿"); r.state.back(); r.state.restore(r.id);
    expect(r.state.getSnapshot().sessions.get("session:a.jsonl")?.text).toBe("后续稿"); r.state.dispose();
  });
  it.each(["busy", "4402"])("行8/9/10a/10b：%s 不依赖成功路径找回 v1，重试旧结果不清新稿", async (kind) => {
    const r = rig(); const p = r.state.send(r.id); r.state.back();
    if (kind === "busy") r.resolve({ kind: "busy" }); else r.reject(new WriteSendError("server", "controlled", 4402)); await p;
    r.state.restore(r.id); expect(r.state.getSnapshot().drafts.get(r.id)?.text).toBe("v1");
    expect(r.state.getSnapshot().drafts.get(r.id)?.phase).toBe(kind === "busy" ? "settled-rejected" : "settled-unknown");
    if (kind === "4402") {
      const denied = await r.state.send(r.id); expect(denied.status).toBe("local"); expect(r.send).toHaveBeenCalledTimes(1);
    }
    const p2 = r.state.send(r.id, undefined, true);
    expect(r.state.getSnapshot().drafts.get(r.id)).toMatchObject({ result: null, phase: "sending" });
    r.state.edit(r.id, "new"); r.resolve(launched); await p2;
    expect(r.state.getSnapshot().sessions.get("session:a.jsonl")?.text).toBe("new"); r.state.dispose();
  });
  it.each(["launched", "busy", "4402"])("行11-14：选 B 后 A %s，B 页面/file/composer 保真", async (kind) => {
    const r = rig(); const p = r.state.send(r.id); r.state.edit(r.id, "v2"); r.state.back();
    r.state.open("b.jsonl"); r.state.edit("session:b.jsonl", "B 草稿");
    if (kind === "4402") r.reject(new WriteSendError("server", "controlled", 4402)); else r.resolve(kind === "busy" ? { kind: "busy" } : launched);
    await p;
    expect(r.state.getSnapshot()).toMatchObject({ view: { kind: "session", file: "b.jsonl" }, activeFile: "b.jsonl" });
    expect(r.state.getSnapshot().sessions.get("session:b.jsonl")?.text).toBe("B 草稿");
    expect(r.state.getSnapshot().drafts.get(r.id)?.phase).toBe(`settled-${kind === "busy" ? "rejected" : kind === "4402" ? "unknown" : "launched"}`);
    expect(r.client.getSnapshot().connState).toBe("ready"); expect(r.send).toHaveBeenCalledTimes(1);
    if (kind === "launched") { r.state.open("a.jsonl"); expect(r.state.getSnapshot().sessions.get("session:a.jsonl")?.text).toBe("v2"); }
    else { r.state.back(); r.state.restore(r.id); expect(r.state.getSnapshot().drafts.get(r.id)?.text).toBe("v2"); }
    r.state.dispose();
  });
  it("行15-18：手机返回保 file；同 file 重开无换目标；换 B/新建才换目标", () => {
    const r = rig(); r.state.back(); r.state.open("a.jsonl"); r.state.edit("session:a.jsonl", "keep"); r.state.back();
    expect(r.state.getSnapshot().activeFile).toBe("a.jsonl"); r.state.open("a.jsonl");
    expect(r.state.getSnapshot().sessions.get("session:a.jsonl")?.text).toBe("keep");
    r.state.open("b.jsonl"); expect(r.state.getSnapshot().activeFile).toBe("b.jsonl"); r.state.create("d2.jsonl");
    expect(r.state.getSnapshot().activeFile).toBeNull(); r.state.dispose();
  });
  it("行19/20：client 替换保 view/file/草稿；旧 client launched 记账但不清稿", async () => {
    const r = rig(); const p = r.state.send(r.id); r.state.setClient({ ...r.client });
    expect(r.state.getSnapshot().drafts.get(r.id)).toMatchObject({ text: "v1", phase: "settled-unknown" });
    r.resolve(launched); await p; expect(r.refresh).toHaveBeenCalledTimes(1);
    expect(r.state.getSnapshot().sessions.get("session:a.jsonl")?.text).toBe("v1"); r.state.dispose();
  });
  it("等待截止非协议终局：恢复不二发，原 pending 迟到 launched 仍进三门", async () => {
    vi.useFakeTimers(); const r = rig(50); const p = r.state.send(r.id); r.state.back(); vi.advanceTimersByTime(50);
    expect(r.state.getSnapshot().drafts.get(r.id)).toMatchObject({ phase: "settled-unknown", operation: { pending: true } });
    r.state.restore(r.id); expect(r.send).toHaveBeenCalledTimes(1);
    expect((await r.state.send(r.id, undefined, true)).status).toBe("local"); expect(r.send).toHaveBeenCalledTimes(1);
    r.resolve(launched); await p;
    expect(r.state.getSnapshot()).toMatchObject({ view: { kind: "session", file: "a.jsonl" }, activeFile: "a.jsonl" });
    expect(vi.getTimerCount()).toBe(0); r.state.dispose();
  });
});
