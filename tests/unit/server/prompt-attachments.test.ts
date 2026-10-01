import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { preparePromptAttachments, restorePromptAttachments } from "../../../apps/server/src/runtime/prompt-attachments.ts";
import type { ResolvedAttachment } from "../../../apps/server/src/http/attachment-store.ts";

const owner = "a".repeat(64);
const imageId = "1".repeat(32), textId = "2".repeat(32);
const image = Buffer.from("unit-test-original-image-bytes"); // 仅测试编码/身份，真实图像解码在AttachmentStore。
const code = "const value = '中文';";
function entry(id: string): ResolvedAttachment {
  const isImage = id === imageId, bytes = isImage ? image : Buffer.from(code);
  return { attachment: { id, name: isImage ? "photo.png" : "code.ts", kind: isImage ? "image" : "text", mimeType: isImage ? "image/png" : "text/plain", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, bytes, ...(isImage ? {} : { text: code }) };
}
function source() { return { resolve: vi.fn(async (_owner: string, ids: readonly string[]) => ids.map(entry)) }; }

describe("附件发送/恢复内容映射（受控字节源）", () => {
  it("原字节base64与完整哈希对应，保留重复图，不把代码当执行操作", async () => {
    const prepared = await preparePromptAttachments(source(), owner, [imageId, textId, imageId], "检查这段代码");
    expect(prepared.images).toEqual([{ type: "image", data: image.toString("base64"), mimeType: "image/png" }, { type: "image", data: image.toString("base64"), mimeType: "image/png" }]);
    expect(prepared.hashes).toEqual([entry(imageId).attachment.sha256.slice(0, 12), entry(imageId).attachment.sha256.slice(0, 12)]);
    expect(prepared.rawText).toContain(code);
    expect(prepared.snapshot.objects.map((item) => item.id)).toEqual([imageId, textId, imageId]);
  });
  it("恢复重读同对象，只展开一次，文本/图/次数均一致", async () => {
    const src = source();
    const initial = await preparePromptAttachments(src, owner, [imageId, textId, imageId], "检查");
    const restored = await restorePromptAttachments(src, owner, initial.snapshot, initial.rawText, initial.hashes);
    expect(restored).toEqual(initial);
    expect(src.resolve).toHaveBeenCalledTimes(2);
  });
  it("另一个身份拒绝，零读取", async () => {
    const src = source(), initial = await preparePromptAttachments(src, owner, [imageId], "检查");
    src.resolve.mockClear();
    await expect(restorePromptAttachments(src, "b".repeat(64), initial.snapshot, initial.rawText, initial.hashes)).rejects.toThrow("附件不可用");
    expect(src.resolve).not.toHaveBeenCalled();
  });
  it("对象元数据漂移拒绝；不能只核对短hash", async () => {
    const src = source(), initial = await preparePromptAttachments(src, owner, [imageId], "检查");
    const drift = { ...initial.snapshot, objects: initial.snapshot.objects.map((item) => ({ ...item, name: "other.png" })) };
    await expect(restorePromptAttachments(src, owner, drift, initial.rawText, initial.hashes)).rejects.toThrow("不一致");
  });
  it("原文改变或重复图片次数少了均拒绝", async () => {
    const src = source(), initial = await preparePromptAttachments(src, owner, [imageId, imageId], "检查");
    await expect(restorePromptAttachments(src, owner, initial.snapshot, "变了", initial.hashes)).rejects.toThrow();
    await expect(restorePromptAttachments(src, owner, initial.snapshot, initial.rawText, initial.hashes.slice(1))).rejects.toThrow();
  });
  it("对象缺失响亮失败，不退化为仅文字", async () => {
    const src = source(), initial = await preparePromptAttachments(src, owner, [imageId], "检查");
    src.resolve.mockRejectedValueOnce(new Error("missing"));
    await expect(restorePromptAttachments(src, owner, initial.snapshot, initial.rawText, initial.hashes)).rejects.toThrow("missing");
  });
  it("UTF8总正文按字节拒超限，不截断附件", async () => {
    await expect(preparePromptAttachments(source(), owner, [textId], "中".repeat(21846))).rejects.toThrow();
    const src = { resolve: async () => [{ ...entry(textId), text: "x".repeat(49152) }, { ...entry(textId), text: "x".repeat(49152) }] };
    await expect(preparePromptAttachments(src, owner, [textId, textId], "检查")).rejects.toThrow();
  });
});
