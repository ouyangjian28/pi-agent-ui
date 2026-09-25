// 文件耐久端口：append-only 逐行 fdatasync（TECH §5 journal=主保险，永不 rename）。
// 语义对齐 DurabilityPort 契约：append reject=写入结果未确认（完整/部分行可能已在盘），
// 之后继续 append 前须先修复尾部——本实现不自我修复，reject 后保持句柄，恢复归上层重放裁决。
// 串行化：内部 Promise 队列保证行原子性（两个写者共用同一实例时行不交错）；
// close() 同样入队（先排空已接收 append 再关句柄），close 后本实例拒绝新 append（S4-06）。
// 失败锁（S4-06）：close() 不解除——关闭文件描述符不是修复授权；恢复须走 markRepaired()
// 显式入口（宿主先完成尾部修复/换段裁决后调用），或另建新实例（换段）。
// 目录耐久（s4e R3）：首次成功追加（open+写+datasync）返回前同步父目录一次——新建 journal
// 文件的目录条目（文件名）在此之前不保证耐久；mkdir 先于文件创建≠目录条目已同步。
// win32 平台目录 open 不可携→跳过（生产部署=Linux；Windows 下文件名耐久不保证，注释声明）。
// 目录同步失败=本次追加结果未确认：fail-closed 同其他写失败。
import { open, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { DurabilityPort, JournalLine } from "@pi-agent-ui/protocol";

/** fs 端口（测试注入用；生产=node:fs/promises 同构子集）。 */
export interface DurabilityFsPort {
  open(path: string, flags: string): Promise<DurabilityFileHandleLike>;
  /** 目录同步（首写后文件名条目耐久；仅生产真实现需要，测试替身记录调用即可）。 */
  syncDir?(dirPath: string): Promise<void>;
}
export interface DurabilityFileHandleLike {
  /** offset=缓冲区偏移（Y-C3/s4c 命名勘误：非文件 position；append 模式下文件位置由实现推进）。
   *  与 node:fs/promises FileHandle.write(buffer, offset, ...) 重载同构。 */
  write(buf: Buffer, offset?: number): Promise<{ bytesWritten: number }>;
  datasync(): Promise<void>;
  close(): Promise<void>;
}

export interface FileDurabilityOpts {
  /** fs 端口注入（单元测试受控替身；默认真 fs）。 */
  readonly fsPort?: DurabilityFsPort;
}

const realFs: DurabilityFsPort =
  process.platform === "win32"
    ? { open: (path: string, flags: string) => open(path, flags as "a") } // win32 无目录 open：跳过目录同步（文件名耐久不保证，注释声明）
    : {
        open: (path: string, flags: string) => open(path, flags as "a"),
        syncDir: async (dirPath: string) => {
          const dh = await open(dirPath, "r"); // POSIX：以读模式打开目录再 fsync（文件名条目耐久）
          try {
            await dh.datasync();
          } finally {
            await dh.close();
          }
        },
      };

export class FileDurability implements DurabilityPort {
  private fh: DurabilityFileHandleLike | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private failed = false;
  private closed = false;
  private dirSynced = false; // 首写后文件名条目已同步（append 不改目录条目，只做一次）

  constructor(readonly path: string, private readonly opts: FileDurabilityOpts = {}) {}

  private async handle(): Promise<DurabilityFileHandleLike> {
    if (this.fh === null) {
      if (this.opts.fsPort === undefined) {
        await mkdir(dirname(this.path), { recursive: true }); // 真实 fs 才建目录（注入端口=测试路径免碰真盘）
      }
      this.fh = await (this.opts.fsPort ?? realFs).open(this.path, "a");
    }
    return this.fh;
  }

  append(line: JournalLine): Promise<void> {
    // B3（s4b）：接收判定在入口同步完成——close 只拦「之后」的调用，已接收任务照常执行；
    // 已接收任务在前序写入失败（failed）时仍拒绝执行（不越过不确定的尾）。
    if (this.closed) {
      return Promise.reject(new Error(`FileDurability: 已关闭，拒绝追加（${this.path}）`));
    }
    if (this.failed) {
      // 首次失败后未修复即续写：拒绝（保守；上层须先重放裁决/换段）
      return Promise.reject(new Error(`FileDurability: 处于未修复失败态（${this.path}）`));
    }
    const run = async (): Promise<void> => {
      if (this.failed) {
        // 执行时前序任务已失败：本任务不越过不确定的尾（拒绝而非静默丢）
        throw new Error(`FileDurability: 处于未修复失败态（${this.path}）`);
      }
      try {
        const fh = await this.handle();
        const buf = Buffer.from(`${JSON.stringify(line)}\n`, "utf8");
        let offset = 0;
        while (offset < buf.length) {
          // 部分写返回 < length（磁盘满/EINTR 后重试同一 offset）
          const { bytesWritten } = await fh.write(buf, offset);
          if (bytesWritten === 0) throw new Error("FileDurability: 写入零进展（疑似不可恢复的底层故障）"); // Y3：防死循环
          offset += bytesWritten;
        }
        await fh.datasync(); // fdatasync：行内容已确认（append 模式下数据指针随写推进，无需 fsync 元数据）
        if (!this.dirSynced) {
          // R3（s4e）：首次追加返回前同步父目录——否则新建文件名不在目录耐久面内（掉电可丢文件名）。
          const fs = this.opts.fsPort ?? realFs;
          if (fs.syncDir !== undefined) {
            await fs.syncDir(dirname(this.path));
            this.dirSynced = true; // 成功才置位：失败走 catch=本次 append 未确认（fail-closed）
          }
        }
      } catch (e) {
        this.failed = true; // 打开/写入/sync 任一失败=结果未确认：后续 append 拒绝，直到恢复流程裁决
        throw e;
      }
    };
    const next = this.queue.then(run, run); // 前序失败也继续排队（各自调用方收到各自错误）
    this.queue = next.catch(() => undefined); // 队列永续
    return next.then(() => undefined);
  }

  /** 关闭句柄（入队串行：先排空已接收 append）。不隐含修复语义：failed 不因 close 解除（S4-06）。
   *  close 后本实例拒绝新 append；复用须 markRepaired() 前置于 close，或换段新建实例。 */
  close(): Promise<void> {
    const run = async (): Promise<void> => {
      const fh = this.fh;
      this.fh = null;
      if (fh !== null) await fh.close();
    };
    this.closed = true; // 同步置位：close 后新 append 立即拒（已入队任务照常完成）
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next.then(() => undefined);
  }

  /** 显式恢复授权（S4-06）：宿主完成尾部修复/换段裁决后解锁失败态，允许续写。
   *  授权证据（尾部已修复/新段无撕裂）由宿主持有，本入口不验证——误授权后果=撕裂尾后续写。 */
  markRepaired(): void {
    this.failed = false;
  }

  /** 标记失败（外部修复流程用）；后续 append 拒绝直到 markRepaired()。 */
  markFailed(reason: string): void {
    this.failed = true;
    void reason;
  }
}
