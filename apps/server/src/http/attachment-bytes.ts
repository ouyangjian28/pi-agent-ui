import { IMAGE_MAX_PIXELS, IMAGE_UPLOAD_MAX_BYTES, TEXT_UPLOAD_MAX_BYTES, isAttachmentName } from "@pi-agent-ui/protocol";

export class AttachmentInputError extends Error {
  constructor(readonly code: "invalid-name" | "unsupported-format" | "too-large" | "invalid-text" | "invalid-image" | "pixel-limit", message: string) { super(message); this.name = "AttachmentInputError"; }
}
export interface ImageHeader { readonly mimeType: "image/png" | "image/jpeg"; readonly width: number; readonly height: number; }
const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "rst", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml", "xml", "html", "css", "scss", "js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "rb", "go", "rs", "c", "h", "cc", "cpp", "hpp", "java", "kt", "swift", "sh", "bash", "zsh", "sql", "vue", "svelte", "ini", "conf", "log", "patch", "diff"]);
export function classifyAttachmentName(name: string): "image" | "text" {
  if (!isAttachmentName(name)) throw new AttachmentInputError("invalid-name", "文件名无效；请使用不含路径的普通文件名。");
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (["png", "jpg", "jpeg"].includes(extension)) return "image";
  if (TEXT_EXTENSIONS.has(extension)) return "text";
  throw new AttachmentInputError("unsupported-format", "本批支持 PNG/JPEG 图片及 UTF-8 文本/代码；不支持 PDF、Office、归档或二进制文件。");
}
export function decodeTextAttachment(bytes: Uint8Array): string {
  if (bytes.byteLength === 0 || bytes.byteLength > TEXT_UPLOAD_MAX_BYTES) throw new AttachmentInputError("too-large", "文本附件必须为 1～48 KiB。");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new AttachmentInputError("invalid-text", "文本附件不是有效 UTF-8，请转换编码后重试。"); }
  // C0 controls other than tab/CR/LF imply binary data; no executable interpretation.
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text)) throw new AttachmentInputError("invalid-text", "文本附件包含二进制控制字节，不能作为代码/文本发送。");
  return text;
}
function dimensions(mimeType: ImageHeader["mimeType"], width: number, height: number): ImageHeader {
  if (width <= 0 || height <= 0) throw new AttachmentInputError("invalid-image", "图片尺寸无效。");
  if (width * height > IMAGE_MAX_PIXELS) throw new AttachmentInputError("pixel-limit", "图片超过 4000 万像素，请先缩小。");
  return { mimeType, width, height };
}
/** 解码前仅作有界头部预检；成功不等于有效图片，仍须隔离worker完整解码。 */
export function inspectImageHeader(bytes: Uint8Array): ImageHeader {
  if (bytes.byteLength === 0 || bytes.byteLength > IMAGE_UPLOAD_MAX_BYTES) throw new AttachmentInputError("too-large", "图片必须为 1～10 MiB。");
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length >= 33 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && b.readUInt32BE(8) === 13 && b.subarray(12, 16).toString("ascii") === "IHDR") return dimensions("image/png", b.readUInt32BE(16), b.readUInt32BE(20));
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let offset = 2; let found: ImageHeader | undefined;
    while (offset < b.length) {
      if (b[offset++] !== 0xff) break;
      while (offset < b.length && b[offset] === 0xff) offset++;
      const marker = b[offset++];
      if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      if (offset + 2 > b.length) break;
      const length = b.readUInt16BE(offset);
      if (length < 2 || offset + length > b.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8 || found !== undefined) throw new AttachmentInputError("invalid-image", "图片尺寸头冲突或损坏。");
        found = dimensions("image/jpeg", b.readUInt16BE(offset + 5), b.readUInt16BE(offset + 3));
      }
      offset += length;
    }
    if (found !== undefined) return found;
  }
  throw new AttachmentInputError("invalid-image", "文件不是有效 PNG/JPEG 图片，不能仅更改扩展名后发送。");
}
