import { describe, expect, it, vi } from "vitest";
import { createRpcWriteHost, type ResumeAuthority } from "../../../apps/server/src/ws/rpc-write-host.ts";
import type { EnqueuePayload } from "@pi-agent-ui/protocol";
const principal = "a".repeat(64);
const composer = { version: 1 as const, model: "p/model", thinkingLevel: "high" as const, attachments: { owner: principal, sourceText: "原文", objects: [{ id: "1".repeat(32), name: "photo.png", kind: "image" as const, mimeType: "image/png" as const, size: 123, sha256: "b".repeat(64) }] } };
const payload: EnqueuePayload = { kind: "prompt-configured", rawText: "原文", attachments: ["b".repeat(12)], sentAt: "2026-01-01T00:00:00Z", composer };
function rig(value: { rawText: string } & Partial<EnqueuePayload>) {
  const send = vi.fn(async () => ({ kind: "launched" as const, key: { intentId: "new", commandId: 7, generation: 4 } }));
  const factory = vi.fn(() => ({ send, stop: vi.fn() }));
  const report = { resendAuthorized: ["old"], resumeBlocked: false };
  const authority: ResumeAuthority = { reportFor: () => report, generationFor: () => 4, executeFor: () => ({ report, payload: value }) };
  return { send, factory, host: createRpcWriteHost({ sessionFor: factory, resumeAuthority: authority }) };
}
describe("configured resume接线（受控权威/会话）", () => {
  it("不退化文字；原正文、对象次数、配置和当前身份交给真实运行时入口", async () => {
    const r = rig(payload);
    expect(await r.host.resume("owned.jsonl", "old", 4, undefined, principal)).toEqual({ kind: "launched", intentId: "new", commandId: 7 });
    expect(r.send).toHaveBeenCalledWith("原文", 4, "p/model", { replay: { rawText: "原文", attachments: payload.attachments, composer }, principal });
  });
  it("带图片身份却没字节对象快照：零建会话、零重发", async () => {
    const r = rig({ rawText: "原文", attachments: ["b".repeat(12)] });
    expect(await r.host.resume("owned.jsonl", "old", 4, undefined, principal)).toEqual({ kind: "execution-failed", cause: "payload-unavailable" });
    expect(r.factory).not.toHaveBeenCalled(); expect(r.send).not.toHaveBeenCalled();
  });
  it("configured载荷配置缺失：零建会话、零重发", async () => {
    const r = rig({ kind: "prompt-configured", rawText: "原文", attachments: [] });
    expect(await r.host.resume("owned.jsonl", "old", 4, undefined, principal)).toEqual({ kind: "execution-failed", cause: "payload-unavailable" });
    expect(r.factory).not.toHaveBeenCalled();
  });
  it("原授权收回仍先挡住，不能因附件接线绕过恢复门", async () => {
    const r = rig(payload);
    expect(await r.host.resume("owned.jsonl", "wrong-intent", 4, undefined, principal)).toEqual({ kind: "identity-rejected", cause: "resume-not-authorized" });
    expect(r.factory).not.toHaveBeenCalled();
  });
});
