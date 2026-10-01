import { WRITE_TEXT_MAX_BYTES, isAttachmentIds, isUploadedAttachment, type UploadedAttachmentDTO } from "@pi-agent-ui/protocol";
import type { AttachmentStore } from "../http/attachment-store.ts";

/** 内部耐久快照；不可由WS客户端指定身份/对象描述。 */
export interface PromptAttachmentSnapshot {
  readonly owner: string;
  readonly sourceText: string;
  readonly objects: readonly UploadedAttachmentDTO[];
}
export interface PreparedAttachmentPrompt {
  readonly rawText: string;
  readonly hashes: readonly string[];
  readonly images: readonly { readonly type: "image"; readonly data: string; readonly mimeType: "image/png" | "image/jpeg" }[];
  readonly snapshot: PromptAttachmentSnapshot;
}
export class PromptAttachmentError extends Error {
  constructor() { super("附件不可用或与原发送快照不一致；未发送。"); this.name = "PromptAttachmentError"; }
}
type Source = Pick<AttachmentStore, "resolve">;

function validSnapshot(value: unknown): value is PromptAttachmentSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).length === 3 && Object.keys(v).every((k) => ["owner", "sourceText", "objects"].includes(k))
    && typeof v.owner === "string" && /^[0-9a-f]{64}$/.test(v.owner)
    && typeof v.sourceText === "string" && Buffer.byteLength(v.sourceText, "utf8") <= WRITE_TEXT_MAX_BYTES
    && Array.isArray(v.objects) && v.objects.length > 0 && v.objects.every(isUploadedAttachment)
    && isAttachmentIds(v.objects.map((item: UploadedAttachmentDTO) => item.id));
}
function sameObject(a: UploadedAttachmentDTO, b: UploadedAttachmentDTO): boolean {
  return a.id === b.id && a.sha256 === b.sha256 && a.name === b.name && a.kind === b.kind && a.mimeType === b.mimeType && a.size === b.size;
}

/** 只准备不可变内容；调用方在模型/图像能力确认后pin，再入journal，不能先写意图。 */
export async function preparePromptAttachments(source: Source, owner: string, ids: readonly string[], text: string): Promise<PreparedAttachmentPrompt> {
  if (!/^[0-9a-f]{64}$/.test(owner) || !isAttachmentIds(ids) || ids.length === 0 || typeof text !== "string" || Buffer.byteLength(text, "utf8") > WRITE_TEXT_MAX_BYTES) throw new PromptAttachmentError();
  const resolved = await source.resolve(owner, ids);
  if (resolved.length !== ids.length || resolved.some((item, index) => item.attachment.id !== ids[index])) throw new PromptAttachmentError();
  let rawText = text;
  const images: PreparedAttachmentPrompt["images"][number][] = [];
  const hashes: string[] = [];
  for (const item of resolved) {
    if (item.attachment.kind === "text") {
      if (item.text === undefined) throw new PromptAttachmentError();
      rawText += `\n\n--- 用户附件 ${item.attachment.name}（UTF-8）---\n${item.text}\n--- 附件结束 ---`;
      if (Buffer.byteLength(rawText, "utf8") > WRITE_TEXT_MAX_BYTES) throw new PromptAttachmentError();
    } else {
      if (item.attachment.mimeType !== "image/png" && item.attachment.mimeType !== "image/jpeg") throw new PromptAttachmentError();
      images.push({ type: "image", data: Buffer.from(item.bytes).toString("base64"), mimeType: item.attachment.mimeType });
      hashes.push(item.attachment.sha256.slice(0, 12));
    }
  }
  return { rawText, hashes, images, snapshot: { owner, sourceText: text, objects: resolved.map((item) => ({ ...item.attachment })) } };
}

/** 恢复必须核实原完整对象/文本/重复次数，不把展开后的文本再次展开或降成无图。 */
export async function restorePromptAttachments(source: Source, owner: string, snapshot: unknown, expectedText: string, expectedHashes: readonly string[]): Promise<PreparedAttachmentPrompt> {
  if (!validSnapshot(snapshot) || snapshot.owner !== owner) throw new PromptAttachmentError();
  const prepared = await preparePromptAttachments(source, owner, snapshot.objects.map((item) => item.id), snapshot.sourceText);
  if (prepared.rawText !== expectedText || prepared.hashes.length !== expectedHashes.length || prepared.hashes.some((hash, i) => hash !== expectedHashes[i])
    || prepared.snapshot.objects.some((item, i) => !sameObject(item, snapshot.objects[i]!))) throw new PromptAttachmentError();
  return prepared;
}
