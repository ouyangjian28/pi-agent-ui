// 文件耐久端口：append-only 逐行 fdatasync（TECH §5 journal=主保险，永不 rename）。
// 语义对齐 DurabilityPort 契约：append reject=写入结果未确认（完整/部分行可能已在盘），
// 之后继续 append 前须先修复尾部——本实现不自我修复，reject 后保持句柄，恢复归上层重放裁决。
// 串行化：内部 Promise 队列保证行原子性（两个写者共用同一实例时行不交错）。
import { open, type FileHandle } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { DurabilityPort, JournalLine } from "@pi-agent-ui/protocol";

export class FileDurability implements DurabilityPort {
  private fh: FileHandle | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private failed = false;

  constructor(readonly path: string) {}

  private async handle(): Promise<FileHandle> {
    if (this.fh === null) {
      await mkdir(dirname(this.path), { recursive: true });
      this.fh = await open(this.path, "a");
    }
    return this.fh;
  }

  append(line: JournalLine): Promise<void> {
    const run = async (): Promise<void> => {
      if (this.failed) {
        // 首次失败后未修复即续写：拒绝（保守；上层须先重放裁决/换段）
        throw new Error(`FileDurability: 处于未修复失败态（${this.path}）`);
      }
      try {
        const fh = await this.handle();
        const buf = Buffer.from(`${JSON.stringify(line)}\n`, "utf8");
        let offset = 0;
        while (offset < buf.length) {
          // 部分写返回 < length（磁盘满/EINTR 后重试同一 offset）
          const { bytesWritten } = await fh.write(buf, offset);
          offset += bytesWritten;
        }
        await fh.datasync(); // fdatasync：行内容已确认（append 模式下数据指针随写推进，无需 fsync 元数据）
      } catch (e) {
        this.failed = true; // 打开/写入/sync 任一失败=结果未确认：后续 append 拒绝，直到恢复流程裁决/重置
        throw e;
      }
    };
    const next = this.queue.then(run, run); // 前序失败也继续排队（各自调用方收到各自错误）
    this.queue = next.catch(() => undefined); // 队列永续
    return next.then(() => undefined);
  }

  /** 进程崩溃/测试清理用：不隐含修复语义。 */
  async close(): Promise<void> {
    const fh = this.fh;
    this.fh = null;
    this.failed = false; // close 后可重开（新实例/恢复流程自行裁决）
    if (fh !== null) await fh.close();
  }

  /** 标记失败（外部修复流程用）；后续 append 拒绝直到 close() 重置。 */
  markFailed(reason: string): void {
    this.failed = true;
    void reason;
  }
}
