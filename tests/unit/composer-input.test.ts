import { describe, expect, it } from "vitest";
import { ATTACHMENT_MAX_COUNT, IMAGE_UPLOAD_MAX_BYTES, TEXT_UPLOAD_MAX_BYTES, isThinkingLevel, isAttachmentIds, isAttachmentName, isUploadedAttachment } from "../../packages/protocol/src/composer-input.ts";
const id = "a".repeat(32);
const text = { id, name: "sample.ts", kind: "text", mimeType: "text/plain", size: 1, sha256: "b".repeat(64) };
describe("composer input contract bounds", () => {
  it("thinking is a strict value domain, not a model capability claim", () => {
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) expect(isThinkingLevel(level)).toBe(true);
    for (const level of [undefined, null, "default", "High", "auto", 1]) expect(isThinkingLevel(level)).toBe(false);
  });
  it("retains duplicate attachment references as multiset input", () => {
    expect(isAttachmentIds([])).toBe(true); expect(isAttachmentIds([id, id])).toBe(true);
  });
  it("rejects traversal, arbitrary hashes, uppercase and nonstring references", () => {
    for (const ids of [["../file"], ["a".repeat(64)], ["A".repeat(32)], [null], "a", null]) expect(isAttachmentIds(ids)).toBe(false);
  });
  it("bounds item count without expanding websocket payload", () => {
    expect(isAttachmentIds(Array(ATTACHMENT_MAX_COUNT).fill(id))).toBe(true);
    expect(isAttachmentIds(Array(ATTACHMENT_MAX_COUNT + 1).fill(id))).toBe(false);
  });
  it("accepts ordinary unicode/space/code filenames", () => {
    for (const name of ["截图 1.png", "foo.test.ts", "文档.md"]) expect(isAttachmentName(name)).toBe(true);
  });
  it("rejects unsafe or unreadable filename labels", () => {
    for (const name of ["", ".", "..", "../a", "x/y", "x\\y", "x\n.txt", "x\u0000", "<img>.png", "x".repeat(161), null]) expect(isAttachmentName(name)).toBe(false);
  });
  it("accepts exact typed metadata and image/text hard limits", () => {
    expect(isUploadedAttachment(text)).toBe(true);
    expect(isUploadedAttachment({ ...text, size: TEXT_UPLOAD_MAX_BYTES })).toBe(true);
    for (const mimeType of ["image/png", "image/jpeg"]) expect(isUploadedAttachment({ ...text, kind: "image", mimeType, size: IMAGE_UPLOAD_MAX_BYTES })).toBe(true);
  });
  it("rejects image/text mismatch, unsupported archives and forged metadata", () => {
    for (const patch of [{ mimeType: "image/png" }, { kind: "image" }, { mimeType: "application/zip" }, { id: "bad" }, { sha256: "c".repeat(12) }, { size: 0 }, { size: -1 }, { size: 1.5 }, { size: Infinity }, { size: TEXT_UPLOAD_MAX_BYTES + 1 }, { serverPath: "/private/file" }]) expect(isUploadedAttachment({ ...text, ...patch })).toBe(false);
    expect(isUploadedAttachment({ ...text, kind: "image", mimeType: "image/png", size: IMAGE_UPLOAD_MAX_BYTES + 1 })).toBe(false);
  });
  it("does not accept arrays, null or missing required members", () => {
    for (const input of [null, [], {}, { ...text, name: undefined }, { ...text, size: undefined }, { ...text, sha256: undefined }]) expect(isUploadedAttachment(input)).toBe(false);
  });
});
