// 安全打开（切片③ w0 对齐 D22/D23：拒绝符号链接+fd 身份验证+同句柄读取）
// 契约 §5.5 授权域：file 正则之后仍须双根授权；realpath 落根内≠拒绝符号链接（根内 symlink 仍被跟随）。
// 本模块：①路径域解析（规范化+目录分隔边界，双根同时约束）；②O_NOFOLLOW 打开最终组件（符号链接→ELOOP→拒绝）；
// ③打开后同 fd fstat 验证常规文件（检查与使用同一句柄，无 TOCTOU 窗口）；④有界流式读取（读中硬限，不先全读）。
// W1-09：O_NONBLOCK 与 O_NOFOLLOW 合用——O_RDONLY 打开 FIFO（无写端）会永久阻塞在 open 内，
//   fstat 拒绝来不及执行；O_NONBLOCK 使 open 立即返回，同 fd fstat 再拒非常规文件。
//   常规文件不受 O_NONBLOCK 影响（Linux 忽略；win32 无此旗标则跳过）。
// 前提声明（文档级）：祖先目录不可被非信任方替换（部署前提：roots 归宿主管理；Node 无 openat 链，逐级 dirfd 不可移植）。
import { open, constants } from "node:fs/promises";
import { isAbsolute, normalize, resolve, sep } from "node:path";

export type SafeOpenErrorKind =
  | "outside-roots" // 不在任何授权根内（含越界遍历/分隔边界绕过）
  | "missing" // 不存在
  | "symlink" // 最终组件是符号链接（O_NOFOLLOW ELOOP/ENOTDIR）
  | "not-regular" // 命中目录/FIFO/设备等非常规文件
  | "open-denied" // 权限等打开失败
  | "read-failed" // 读取中 I/O 错误
  | "too-large"; // 读取超预算（读中硬限，非事后检查）

export class SafeOpenError extends Error {
  constructor(readonly kind: SafeOpenErrorKind, readonly file: string, detail: string) {
    super(`safe-open ${kind}: ${detail}`);
  }
}

/** 目录分隔边界路径包含判断（防 `a..b.jsonl` 前缀绕过 `/roots/a`：必须落在某个根的完整段之下）。 */
export function resolveWithinRoots(file: string, roots: readonly string[]): string | null {
  if (!roots.every(isAbsolute)) return null; // 根必须绝对路径（宿主配置契约）
  for (const root of roots) {
    const abs = resolve(normalize(root), file); // file 相对 root 解析（file 归一化由正则+sep 检查兜底）
    const nr = normalize(root) + sep;
    if (abs === normalize(root) || abs.startsWith(nr)) return abs;
  }
  return null;
}

/** 打开安全文件：O_NOFOLLOW|O_NONBLOCK+fd fstat。成功返回打开的句柄（同句柄读取——调用方不得重新按路径打开）。 */
export async function openSafeFile(absPath: string): Promise<{ fh: import("node:fs/promises").FileHandle; size: number }> {
  let fh: import("node:fs/promises").FileHandle;
  // W1-09：O_NONBLOCK 防 FIFO/设备文件在 open 内永久挂起（读侧常规文件无副作用）；win32 无该旗标则退 0。
  const nbFlag = process.platform === "win32" || constants.O_NONBLOCK === undefined ? 0 : constants.O_NONBLOCK;
  try {
    fh = await open(absPath, constants.O_RDONLY | constants.O_NOFOLLOW | nbFlag);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "ENOTDIR") throw new SafeOpenError("symlink", absPath, code);
    if (code === "ENOENT") throw new SafeOpenError("missing", absPath, code);
    throw new SafeOpenError("open-denied", absPath, code ?? String(e));
  }
  try {
    const st = await fh.stat(); // 同 fd 身份：不是「先 stat 路径再 open」
    if (!st.isFile()) {
      await fh.close().catch(() => {});
      throw new SafeOpenError("not-regular", absPath, `mode=${st.mode & 0o170000}`);
    }
    return { fh, size: st.size };
  } catch (e) {
    if (e instanceof SafeOpenError) throw e;
    await fh.close().catch(() => {});
    throw new SafeOpenError("open-denied", absPath, String(e));
  }
}

/** 有界流式读取（读中硬限：累计超过 maxBytes 即刻失败，不读完再检查）。 */
export async function readBounded(
  fh: import("node:fs/promises").FileHandle,
  maxBytes: number,
  file: string,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const buf = Buffer.allocUnsafe(64 * 1024);
  for (;;) {
    let n: number;
    try {
      n = (await fh.read(buf, 0, buf.length, null)).bytesRead;
    } catch (e) {
      throw new SafeOpenError("read-failed", file, String(e));
    }
    if (n === 0) break;
    total += n;
    if (total > maxBytes) throw new SafeOpenError("too-large", file, `>${maxBytes}B 读中超限`);
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks);
}

/** 便捷组合：域解析→安全打开→有界读取→关闭。任何失败都保证句柄关闭。 */
export async function readSafeWithin(
  file: string,
  roots: readonly string[],
  maxBytes: number,
): Promise<Buffer> {
  const abs = resolveWithinRoots(file, roots);
  if (abs === null) throw new SafeOpenError("outside-roots", file, "不在授权根内");
  const { fh } = await openSafeFile(abs);
  try {
    return await readBounded(fh, maxBytes, file);
  } finally {
    await fh.close().catch(() => {});
  }
}
