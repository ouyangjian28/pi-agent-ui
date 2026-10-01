import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { AttachmentInputError, inspectImageHeader, type ImageHeader } from "./attachment-bytes.ts";

const require = createRequire(import.meta.url);
const DECODE_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
try {
  const { PhotonImage } = require(workerData.decoder);
  const image = PhotonImage.new_from_byteslice(workerData.bytes);
  try { parentPort.postMessage({width:image.get_width(),height:image.get_height()}); }
  finally { image.free(); }
} catch { parentPort.postMessage(null); }
`;

/** 有界worker，原同一字节先头部后解码；主线程不调用原生解码器。 */
export class ImageValidator {
  private active = 0;
  private closed = false;
  private readonly workers = new Set<Worker>();
  constructor(private readonly timeoutMs = 2500, private readonly maxConcurrent = 2) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 2) throw new Error("invalid image validation bounds");
  }
  async validate(input: Uint8Array): Promise<ImageHeader> {
    if (this.closed) throw new AttachmentInputError("invalid-image", "图片服务已关闭。");
    if (this.active >= this.maxConcurrent) throw new AttachmentInputError("invalid-image", "图片校验繁忙，请稍后重试；文件未发送。");
    // Bound before allocation, then check the owned copy again (shared buffers may change).
    inspectImageHeader(input);
    // Own one immutable copy: caller cannot change header/payload while worker decodes.
    const bytes = Uint8Array.from(input);
    const header = inspectImageHeader(bytes);
    this.active++;
    let worker: Worker | undefined;
    try {
      const decoder = require.resolve("@silvia-odwyer/photon-node");
      worker = new Worker(DECODE_WORKER, { eval: true, workerData: { decoder, bytes }, resourceLimits: { maxOldGenerationSizeMb: 192, stackSizeMb: 4 } });
      this.workers.add(worker);
      const current = worker;
      const result = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new AttachmentInputError("invalid-image", "图片解码超时，请缩小或重新导出图片。")), this.timeoutMs);
        const finish = (error?: Error, value?: unknown): void => { clearTimeout(timer); if (error !== undefined) reject(error); else resolve(value); };
        current.once("message", (value: unknown) => finish(undefined, value));
        current.once("error", () => finish(new AttachmentInputError("invalid-image", "图片解码失败，文件未发送。")));
        current.once("exit", () => finish(new AttachmentInputError("invalid-image", "图片校验进程已退出，文件未发送。")));
      });
      if (this.closed || result === null || typeof result !== "object") throw new AttachmentInputError("invalid-image", "图片损坏或不受支持，文件未发送。");
      const dimensions = result as Record<string, unknown>;
      if (dimensions.width !== header.width || dimensions.height !== header.height) throw new AttachmentInputError("invalid-image", "图片解码尺寸与文件头不一致，文件未发送。");
    } catch (error) {
      if (error instanceof AttachmentInputError) throw error;
      throw new AttachmentInputError("invalid-image", "图片校验不可用，文件未发送。");
    } finally {
      try { if (worker !== undefined) await worker.terminate(); }
      finally { if (worker !== undefined) this.workers.delete(worker); this.active--; }
    }
    if (this.closed) throw new AttachmentInputError("invalid-image", "图片服务已关闭，文件未发送。");
    return header;
  }
  async dispose(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.workers].map((worker) => worker.terminate()));
  }
}
