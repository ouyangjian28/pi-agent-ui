import { constants } from "node:fs";
import { open, mkdir, unlink, readdir, type FileHandle } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { readBounded } from "../ws/safe-open.ts";

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const KEY = /^[0-9a-f]{32}\.(blob|json)$/;
export class AttachmentStorageError extends Error {
  constructor() { super("附件存储不可用或内容已改变；文件未发送。"); this.name = "AttachmentStorageError"; }
}
/** Linux dirfd链：逐层NOFOLLOW，后续操作始终锚在目录句柄；不是realpath先验+按路径重开。 */
export class PinnedDirectory {
  private closed = false;
  private active = 0;
  private drained: (() => void) | undefined;
  private closePromise: Promise<void> | undefined;
  private begin(): void { if (this.closed) throw new AttachmentStorageError(); this.active++; }
  private end(): void { this.active--; if (this.active === 0) this.drained?.(); }
  private constructor(private readonly handle: FileHandle) {}
  static async open(path: string): Promise<PinnedDirectory> {
    if (process.platform !== "linux" || !isAbsolute(path) || resolve(path) === "/" || path.includes("\0")) throw new AttachmentStorageError();
    let current: FileHandle | undefined;
    try {
      current = await open("/", DIRECTORY_FLAGS);
      const parts = resolve(path).split("/").filter(Boolean);
      for (let i = 0; i < parts.length; i++) {
        const nextPath = `/proc/self/fd/${current.fd}/${parts[i]}`;
        if (i === parts.length - 1) {
          try { await mkdir(nextPath, { mode: 0o700 }); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        }
        const next = await open(nextPath, DIRECTORY_FLAGS);
        await current.close(); current = next;
      }
      const st = await current.stat();
      if (!st.isDirectory() || (st.mode & 0o077) !== 0 || (process.geteuid !== undefined && st.uid !== process.geteuid())) throw new AttachmentStorageError();
      return new PinnedDirectory(current);
    } catch { if (current !== undefined) await current.close().catch(() => {}); throw new AttachmentStorageError(); }
  }
  private path(key: string): string {
    if (this.closed || !KEY.test(key)) throw new AttachmentStorageError();
    return `/proc/self/fd/${this.handle.fd}/${key}`;
  }
  async writeExclusive(key: string, bytes: Uint8Array): Promise<void> {
    this.begin();
    let file: FileHandle | undefined;
    try {
      file = await open(this.path(key), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      const st = await file.stat();
      if (!st.isFile() || st.nlink !== 1 || (st.mode & 0o077) !== 0) throw new AttachmentStorageError();
      await file.writeFile(bytes); await file.sync(); await this.handle.sync();
    } catch { throw new AttachmentStorageError(); }
    finally { try { if (file !== undefined) await file.close(); } finally { this.end(); } }
  }
  async read(key: string, maxBytes: number): Promise<Buffer> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new AttachmentStorageError();
    this.begin();
    let file: FileHandle | undefined;
    try {
      file = await open(this.path(key), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = await file.stat();
      if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) !== 0 || before.size > maxBytes) throw new AttachmentStorageError();
      const bytes = await readBounded(file, maxBytes, "attachment");
      const after = await file.stat();
      if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.nlink !== 1) throw new AttachmentStorageError();
      return bytes;
    } catch { throw new AttachmentStorageError(); }
    finally { try { if (file !== undefined) await file.close(); } finally { this.end(); } }
  }
  async names(): Promise<readonly string[]> {
    this.begin();
    try { return await readdir(`/proc/self/fd/${this.handle.fd}`); } catch { throw new AttachmentStorageError(); }
    finally { this.end(); }
  }
  async remove(key: string): Promise<void> {
    this.begin();
    try { await unlink(this.path(key)); await this.handle.sync(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new AttachmentStorageError(); }
    finally { this.end(); }
  }
  close(): Promise<void> {
    this.closePromise ??= (async () => {
      this.closed = true;
      if (this.active > 0) await new Promise<void>((resolve) => { this.drained = resolve; });
      await this.handle.close();
    })();
    return this.closePromise;
  }
}
