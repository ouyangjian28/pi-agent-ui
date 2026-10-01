import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationState, authenticatedAttachmentUploader } from "../../../apps/web/src/ws/conversation-state";
import { WriteSendError, type WriteClientSurface } from "../../../apps/web/src/ws/write-client";
import type { WriteSendOutcomeDTO } from "@pi-agent-ui/protocol/src/contracts";
import type { UploadedAttachmentDTO } from "@pi-agent-ui/protocol/src/composer-input";
const item: UploadedAttachmentDTO = { id: "a".repeat(32), name: "code.ts", kind: "text", mimeType: "text/plain", size: 3, sha256: "b".repeat(64) };
const file = () => new File(["abc"], "code.ts", { type: "text/plain" });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function rig(uploader = vi.fn(async () => item)) {
  const reply = deferred<WriteSendOutcomeDTO>(), send = vi.fn(() => reply.promise);
  const client: WriteClientSurface = { sendPrompt: send, sendStop: vi.fn(), resume: vi.fn(), subscribe: () => () => {}, getSnapshot: () => ({ connState: "ready", errorKind: null, errorMessage: null, inflight: [], lastResult: null, resumeState: { phase: "idle" }, lastResumeResult: null }) };
  const state = new ConversationState(() => {}, 20_000, uploader); state.setClient(client);
  const id = state.create("owned.jsonl")!; state.edit(id, "原文");
  return { state, id, send, reply, uploader, slot: () => state.getSnapshot().drafts.get(id)! };
}
afterEach(() => vi.unstubAllGlobals());
describe("附件owner，受控上传/发送回执", () => {
  it("真send接口携带引用和思考；明确拒绝保留完整草稿与附件", async () => {
    const r = rig(); await r.state.upload(r.id, [file()]); r.state.configureThinking(r.id, "high");
    const sending = r.state.send(r.id, "p/model");
    expect(r.send).toHaveBeenCalledWith("owned.jsonl", "原文", "p/model", undefined, { thinkingLevel: "high", attachments: [item.id] });
    r.reply.resolve({ kind: "not-ready", cause: "settings-rejected" }); await sending;
    expect(r.slot()).toMatchObject({ text: "原文", attachments: [item], thinkingLevel: "high", phase: "settled-rejected" }); r.state.dispose();
  });
  it("未知不自动重发或抹附件；无确认再次发送为零帧", async () => {
    const r = rig(); await r.state.upload(r.id, [file()]); const p = r.state.send(r.id);
    r.reply.reject(new WriteSendError("transport", "controlled")); await p;
    expect(r.slot()).toMatchObject({ text: "原文", attachments: [item], phase: "settled-unknown" });
    expect((await r.state.send(r.id)).status).toBe("local"); expect(r.send).toHaveBeenCalledTimes(1); r.state.dispose();
  });
  it("launched清除同版本附件；草稿转会话保留参数", async () => {
    const r = rig(); await r.state.upload(r.id, [file()]); r.state.configureThinking(r.id, "low"); const p = r.state.send(r.id);
    r.reply.resolve({ kind: "launched", intentId: "i-1", commandId: 1 }); await p;
    expect(r.state.getSnapshot().sessions.get("session:owned.jsonl")).toMatchObject({ text: "", attachments: [], thinkingLevel: "low" }); r.state.dispose();
  });
  it("晚ACK不能清除在途编辑的新稿与附件", async () => {
    const r = rig(); await r.state.upload(r.id, [file()]); const p = r.state.send(r.id); r.state.edit(r.id, "新稿");
    r.reply.resolve({ kind: "launched", intentId: "i-1", commandId: 1 }); await p;
    expect(r.state.getSnapshot().sessions.get("session:owned.jsonl")).toMatchObject({ text: "新稿", attachments: [item] }); r.state.dispose();
  });
  it("上传未完禁发送；离开与回来不丢完成附件", async () => {
    const upload = deferred<UploadedAttachmentDTO>(), r = rig(vi.fn(() => upload.promise));
    const p = r.state.upload(r.id, [file()]); expect((await r.state.send(r.id)).status).toBe("local"); expect(r.send).not.toHaveBeenCalled();
    r.state.back(); upload.resolve(item); await p; r.state.restore(r.id);
    expect(r.slot()).toMatchObject({ attachments: [item], uploading: false }); r.state.dispose();
  });
  it("部分上传失败只保留成功件；不伪造失败件引用", async () => {
    const uploader = vi.fn(async () => item).mockResolvedValueOnce(item).mockRejectedValueOnce(new Error("controlled")); const r = rig(uploader);
    await r.state.upload(r.id, [file(), file()]); expect(r.slot().attachments).toEqual([item]); expect(r.slot().uploadError).not.toBeNull();
    expect(uploader).toHaveBeenCalledTimes(2); r.state.dispose();
  });
  it("dispose取消上传，晚结果不发表", async () => {
    const upload = deferred<UploadedAttachmentDTO>(), r = rig(vi.fn(() => upload.promise)); const p = r.state.upload(r.id, [file()]);
    const before = r.state.getSnapshot(); r.state.dispose(); upload.resolve(item); await p;
    expect(r.state.getSnapshot()).toBe(before);
  });
});
describe("同源cookie绑定当前token，受控fetch", () => {
  it("先认证再上传；同token两次只认证一次，改token重认证", async () => {
    let token = "synthetic-one";
    const fetcher = vi.fn(async (url: string) => url === "/login" ? { ok: true } : { ok: true, json: async () => ({ ok: true, attachment: item }) }); vi.stubGlobal("fetch", fetcher);
    const uploader = authenticatedAttachmentUploader(() => token), signal = new AbortController().signal;
    await uploader(file(), signal); await uploader(file(), signal); token = "synthetic-two"; await uploader(file(), signal);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/login", "/api/attachments", "/api/attachments", "/login", "/api/attachments"]);
    const login = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(login[1]).toMatchObject({ credentials: "same-origin", redirect: "error", body: JSON.stringify({ token: "synthetic-one" }) });
  });
  it("认证失败零上传；登录等待中身份改变零上传", async () => {
    const fetcher = vi.fn(async () => ({ ok: false })); vi.stubGlobal("fetch", fetcher);
    await expect(authenticatedAttachmentUploader(() => "synthetic")(file(), new AbortController().signal)).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(1);
    const pending = deferred<{ ok: boolean }>(); fetcher.mockImplementationOnce(() => pending.promise); let token = "one";
    const p = authenticatedAttachmentUploader(() => token)(file(), new AbortController().signal); token = "two"; pending.resolve({ ok: true });
    await expect(p).rejects.toThrow("登录已变更"); expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
