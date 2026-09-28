// 安全打开（切片③ w0 对齐 D22/D23：拒绝符号链接+fd 身份验证+同句柄读取）
// 契约 §5.5 授权域：file 正则之后仍须双根授权；realpath 落根内≠拒绝符号链接（根内 symlink 仍被跟随）。
// 本模块：①路径域解析（规范化+目录分隔边界，双根同时约束）；②O_NOFOLLOW 打开最终组件（符号链接→ELOOP→拒绝）；
// ③打开后同 fd fstat 验证常规文件（检查与使用同一句柄，无 TOCTOU 窗口）；④有界流式读取（读中硬限，不先全读）。
// W1-09：O_NONBLOCK 与 O_NOFOLLOW 合用——O_RDONLY 打开 FIFO（无写端）会永久阻塞在 open 内，
//   fstat 拒绝来不及执行；O_NONBLOCK 使 open 立即返回，同 fd fstat 再拒非常规文件。
//   常规文件不受 O_NONBLOCK 影响（Linux 忽略；win32 无此旗标则跳过）。
// 前提声明（文档级）：祖先目录不可被非信任方替换（部署前提：roots 归宿主管理；Node 无 openat 链，逐级 dirfd 不可移植）。
import { open, constants } from "node:fs/promises";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";

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

/** resolveWithinRoots 反函数（P0-2 r3a P1 修复/K3 审）：journal 绝对路径→首个匹配根下的逻辑名。
 * 无匹配返回 null（调用方 fail-open 原样透传——归一失败不制造拒因，键面仍由 provider 侧现有约束兜底）。 */
export function logicalNameWithinRoots(abs: string, roots: readonly string[]): string | null {
  if (!isAbsolute(abs) || !roots.every(isAbsolute)) return null;
  for (const root of roots) {
    const nr = normalize(root);
    if (abs === nr) return ".";
    if (abs.startsWith(nr + sep)) return relative(nr, abs);
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

/** 打开安全文件（读写版，P0-1a 修复工具用）：O_RDWR|O_NOFOLLOW|O_NONBLOCK+同 fd fstat 常规验证。
 *  语义与 openSafeFile 完全同源（同错误分类）；仅旗标 O_RDONLY→O_RDWR——写面仅限修复工具截尾+补行，
 *  生产读路径不得使用（读路径仍走 openSafeFile 只读）。 */
export async function openSafeReadWrite(absPath: string): Promise<{ fh: import("node:fs/promises").FileHandle; size: number }> {
  let fh: import("node:fs/promises").FileHandle;
  const nbFlag = process.platform === "win32" || constants.O_NONBLOCK === undefined ? 0 : constants.O_NONBLOCK;
  try {
    fh = await open(absPath, constants.O_RDWR | constants.O_NOFOLLOW | nbFlag);
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

/** readBounded 所需的最小文件句柄形状（结构化接缝——测试可注入脚本化分次 read；FileHandle 结构兼容）。 */
export interface BoundedReadHandle {
  read(buffer: Buffer, offset: number, length: number, position: number | null): Promise<{ bytesRead: number }>;
}

/** 有界流式读取（读中硬限：累计超过 maxBytes 即刻失败，不读完再检查）。 */
export async function readBounded(
  fh: BoundedReadHandle,
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

// ---------------------------------------------------------------------------
// D4 全文读面（docs/d4-fulltext-design.md §4.3）：offset 定点读行器。
// ---------------------------------------------------------------------------
export type ReadLineResult =
  | { readonly ok: true; readonly raw: string } // raw=行内容不含终止 \n（与扫描期按 \n 切分同口径）
  | { readonly ok: false; readonly reason: "bad-start" | "oversized" | "torn" | "invalid-utf8" };

/** D4 §4.3 readLineAt：在已安全打开的句柄上从字节偏移 offset 读一行。
 *  三条命中判据（缺一=不命中；调用方对 digest 对账后定 4414 stale）：
 *  ①行首判定：offset===0，或前一字节（position:offset-1 读 1B）===0x0A——否则 bad-start
 *    （重写后中段残片）；
 *  ②行界判定：读窗内行以 \n 结束（撕裂尾拒——与扫描期 complete 同式）；窗口满 maxBytes+1
 *    字节无 \n→oversized（行硬读限=1MiB 产品取值）；EOF 无 \n→torn；
 *  ③解码纪律：TextDecoder(fatal:true, ignoreBOM:true)（同 history-source.ts:73-90）失败
 *    →invalid-utf8。
 *  I/O 错→SafeOpenError("read-failed")。 */
export async function readLineAt(
  fh: BoundedReadHandle,
  offset: number,
  maxBytes: number,
  file: string,
): Promise<ReadLineResult> {
  // 判据①：行首（offset===0 免读前字节）。
  if (offset !== 0) {
    const prev = Buffer.allocUnsafe(1);
    let n1: number;
    try {
      n1 = (await fh.read(prev, 0, 1, offset - 1)).bytesRead;
    } catch (e) {
      throw new SafeOpenError("read-failed", file, String(e));
    }
    if (n1 === 0 || prev[0] !== 0x0a) return { ok: false, reason: "bad-start" };
  }
  // 判据②：读窗 maxBytes+1（+1=容纳不含 \n 的 maxBytes 行 + 终止符；无 \n→oversized/torn）。
  const win = Buffer.allocUnsafe(maxBytes + 1);
  let n2: number;
  try {
    n2 = (await fh.read(win, 0, win.length, offset)).bytesRead;
  } catch (e) {
    throw new SafeOpenError("read-failed", file, String(e));
  }
  const nl = win.subarray(0, n2).indexOf(0x0a);
  if (nl === -1) return { ok: false, reason: n2 < win.length ? "torn" : "oversized" }; // EOF 无 \n=撕裂尾；窗满无 \n=超行硬限
  const lineBytes = win.subarray(0, nl); // 不含 \n（raw 契约）
  // 判据③：完整前缀 fatal 解码（撕裂尾不在本面——判据②已拒）。
  try {
    return { ok: true, raw: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(lineBytes) };
  } catch {
    return { ok: false, reason: "invalid-utf8" };
  }
}
