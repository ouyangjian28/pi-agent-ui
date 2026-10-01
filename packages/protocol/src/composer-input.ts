// UI-HYBRID 输入三件套；小对象引用走WS，附件原字节只走受限HTTP上传。
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export const ATTACHMENT_MAX_COUNT = 8;
export const IMAGE_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const TEXT_UPLOAD_MAX_BYTES = 48 * 1024;
export const ATTACHMENT_TOTAL_MAX_BYTES = 20 * 1024 * 1024;
export const IMAGE_MAX_PIXELS = 40_000_000;
export const ATTACHMENT_ID_PATTERN = /^[0-9a-f]{32}$/;

export interface ComposerPromptOptions {
  readonly thinkingLevel?: ThinkingLevel;
  readonly attachments?: readonly string[];
}
export interface UploadedAttachmentDTO {
  readonly id: string;
  readonly name: string;
  readonly kind: "image" | "text";
  readonly mimeType: "image/png" | "image/jpeg" | "text/plain";
  readonly size: number;
  readonly sha256: string;
}
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}
/** 重复引用合法：图片身份是多重集，不能去重成集合。 */
export function isAttachmentIds(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= ATTACHMENT_MAX_COUNT && value.every((id: unknown) => typeof id === "string" && ATTACHMENT_ID_PATTERN.test(id));
}
/** 只接受文件名；不允许路径、控制字符、HTML注入式姓名或超长标签。 */
export function isAttachmentName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 160 && value !== "." && value !== ".." && !/[\\/\x00-\x1f\x7f<>]/u.test(value);
}
export function isUploadedAttachment(value: unknown): value is UploadedAttachmentDTO {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((key) => !["id", "name", "kind", "mimeType", "size", "sha256"].includes(key))) return false;
  if (typeof v.id !== "string" || !ATTACHMENT_ID_PATTERN.test(v.id) || !isAttachmentName(v.name)) return false;
  if (typeof v.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(v.sha256)) return false;
  if (typeof v.size !== "number" || !Number.isSafeInteger(v.size) || v.size <= 0) return false;
  return (v.kind === "image" && (v.mimeType === "image/png" || v.mimeType === "image/jpeg") && v.size <= IMAGE_UPLOAD_MAX_BYTES)
    || (v.kind === "text" && v.mimeType === "text/plain" && v.size <= TEXT_UPLOAD_MAX_BYTES);
}
