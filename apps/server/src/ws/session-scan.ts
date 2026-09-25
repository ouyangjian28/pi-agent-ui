// 契约合规的会话目录扫描器（切片③ w0 对齐 D21：现有 host/session-list.ts 不满足 §5.2——全枚举无预算/末尾才 slice/先截断后脱敏/无 partial/无稳定次键）
// 本模块：只读、有界、稳定排序（lastActiveMs desc+file 字典序次键）、两级 partial（目录枚举截断=dirReliability；单文件读取截断=条目级）、sanitize 先于截断。
// W1-10：流式目录迭代（opendir 逐项，非全量 readdir）+访问量上限（visitedCap）——非匹配名也不形成无界单轮工作量；
//   total=访问上限内收集到的命中数（截断时为保守值，真实命中数未知不伪造）。
// W1-12：时间戳口径与 v3 实况对齐——number 与 ISO string（Date.parse 可解析）都认；
//   entryCount 口径=header 外全部可解析对象行（不限 type=message/entry，与 host/session-list.ts 旧扫描器一致）。
// partial ③：超预算/打不开的文件保留已知 sizeBytes（不再归零）——身份/大小仍可呈现，只标内容 partial。
// 授权：文件名来自 readdir（basename），最终打开走 openSafeFile（O_NOFOLLOW+常规文件）——拒绝 symlink/FIFO。
import { opendir } from "node:fs/promises";
import { join } from "node:path";
import { sanitizeText } from "@pi-agent-ui/protocol";
import { openSafeFile, readBounded } from "./safe-open.ts";

export const SCAN_LIMITS = {
  maxFiles: 1000, // 目录枚举上限（§5.7）
  visitCapFactor: 4, // 访问上限系数：visitedCap=maxFiles*4（非匹配名也计入单轮工作量上限）
  perFileBudget: 512 * 1024, // 单文件读取预算（截断=条目级 partial；标题/身份在前部通常可得）
  titleLimit: 80,
} as const;

export interface ScannedSession {
  readonly sessionId: string | null; // header.id；损坏=null 显式呈现
  readonly file: string;
  readonly title: { readonly text: string; readonly truncated: boolean }; // sanitize 先于截断
  readonly lastActiveMs: number | null;
  readonly entryCount: number;
  readonly sizeBytes: number;
  readonly listReliability: "full" | "partial"; // 条目级（读取截断）
}

export interface ScanResult {
  readonly sessions: readonly ScannedSession[]; // 稳定排序：lastActiveMs desc（null 最后）+file 字典序次键
  readonly dirReliability: "full" | "partial"; // 目录级（枚举截断/目录不可读/迭代中断）
  readonly dirUnreadable: boolean;
  readonly total: number; // 访问上限内的命中数（未截断时=sessions.length；截断时为保守下界口径）
  readonly visited: number; // 实际迭代的目录项数（W1-10 访问上限观测口，测试/审计用）
  readonly visitTruncated: boolean; // 是否因访问上限提前停止迭代
}

interface RawEntry {
  sessionId: string | null;
  file: string;
  rawTitle: string | null;
  lastActiveMs: number | null;
  entryCount: number;
  sizeBytes: number;
  partial: boolean;
}

const FILE_RE = /^[\w.-]{1,114}\.jsonl$/; // 契约 file 正则（客户端入参同源校验）

/** 扫描 dir 下 *.jsonl（v1：列表页根=会话目录单根；多根授权域在 gateway 校验，扫描目录归宿主配置）。 */
export async function scanSessions(
  dir: string,
  opts: { maxFiles?: number; perFileBudget?: number; deps?: { opendir?: typeof opendir; openSafe?: typeof openSafeFile } } = {},
): Promise<ScanResult> {
  const maxFiles = opts.maxFiles ?? SCAN_LIMITS.maxFiles;
  const visitCap = maxFiles * SCAN_LIMITS.visitCapFactor;
  const perFileBudget = opts.perFileBudget ?? SCAN_LIMITS.perFileBudget;
  const od = opts.deps?.opendir ?? opendir;
  const hits: string[] = [];
  let visited = 0;
  let visitTruncated = false;
  let iterError = false;
  try {
    const it = await od(dir);
    try {
      for (;;) {
        const ent = await it.read();
        if (ent === null) break;
        visited++;
        if (visited > visitCap) { // W1-10：非匹配名也计入——访问量上限即停（保守 total）
          visitTruncated = true;
          break;
        }
        const n = ent.name;
        if (FILE_RE.test(n)) hits.push(n);
      }
    } catch {
      iterError = true; // 迭代中断：partial（已收集部分仍可用）
    } finally {
      await it.close().catch(() => {});
    }
  } catch {
    return { sessions: [], dirReliability: "partial", dirUnreadable: true, total: 0, visited, visitTruncated };
  }
  hits.sort(); // 枚举序稳定化（文件系统不保证顺序）
  const truncated = hits.length > maxFiles;
  const selected = truncated ? hits.slice(0, maxFiles) : hits;
  const raws: RawEntry[] = [];
  for (const name of selected) {
    raws.push(await scanOne(join(dir, name), name, perFileBudget, opts));
  }
  const sessions = raws
    .map(toDto)
    .sort((a, b) => {
      const la = a.lastActiveMs ?? Number.NaN;
      const lb = b.lastActiveMs ?? Number.NaN;
      if (a.lastActiveMs !== null && b.lastActiveMs !== null && la !== lb) return lb - la; // 新→旧
      if (a.lastActiveMs === null && b.lastActiveMs !== null) return 1; // null 最后
      if (a.lastActiveMs !== null && b.lastActiveMs === null) return -1;
      return a.file < b.file ? -1 : a.file > b.file ? 1 : 0; // 稳定次键
    });
  return {
    sessions,
    dirReliability: truncated || visitTruncated || iterError ? "partial" : "full",
    dirUnreadable: false,
    total: hits.length,
    visited,
    visitTruncated,
  };
}

async function scanOne(abs: string, name: string, budget: number, opts: { deps?: { openSafe?: typeof openSafeFile } }): Promise<RawEntry> {
  const opener = opts.deps?.openSafe ?? openSafeFile;
  let opened: { fh: import("node:fs/promises").FileHandle; size: number };
  try {
    opened = await opener(abs);
  } catch {
    // 打开失败（symlink/权限/缺失）：占位条目（partial；不吞文件本身——身份可呈现，大小未知）
    return { sessionId: null, file: name, rawTitle: null, lastActiveMs: null, entryCount: 0, sizeBytes: -1, partial: true };
  }
  const { fh, size } = opened;
  let buf: Buffer;
  try {
    buf = await readBounded(fh, budget, name);
  } catch {
    // 读取超预算/I/O 错误：占位条目（partial）但保留已知 sizeBytes（W1 partial③）
    return { sessionId: null, file: name, rawTitle: null, lastActiveMs: null, entryCount: 0, sizeBytes: size, partial: true };
  } finally {
    await fh.close().catch(() => {});
  }
  const partial = size > buf.byteLength; // 读取截断
  return parseSessionBuffer(buf, name, size, partial);
}

/** v3 时间戳：number 或 ISO string（Date.parse 可解析且有限）；其余=null（不猜）。 */
function tsOf(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.length >= 8 && v.length <= 40) {
    const t = Date.parse(v); // ISO 8601（NaN/越界自然拒绝）
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/** 解析 v3 JSONL（header 按【类型】识别非位置——r8-03 口径）；撕裂尾/坏行跳过不计。 */
export function parseSessionBuffer(buf: Buffer, name: string, sizeBytes: number, partial: boolean): RawEntry {
  const text = buf.toString("utf8");
  const lines = text.split("\n");
  let sessionId: string | null = null;
  let rawTitle: string | null = null;
  let lastActiveMs: number | null = null;
  let entries = 0;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i] ?? "";
    if (ln === "") continue;
    let obj: unknown;
    try {
      obj = JSON.parse(ln);
    } catch {
      continue; // 坏行/撕裂尾跳过
    }
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) continue;
    const o = obj as Record<string, unknown>;
    if (o.type === "session") {
      if (typeof o.id === "string" && o.id.length > 0 && o.id.length <= 128) sessionId = o.id;
      const t0 = tsOf(o.timestamp);
      if (t0 !== null) lastActiveMs = t0;
      continue;
    }
    // W1-12：entryCount 口径=header 外全部可解析对象行（与 v3 旧扫描器 host/session-list.ts 一致）
    entries++;
    const t = tsOf(o.timestamp);
    if (t !== null) lastActiveMs = t;
    if (rawTitle === null) {
      const m = o.message as Record<string, unknown> | undefined;
      const c = m?.content;
      if (typeof c === "string" && c.length > 0) rawTitle = c;
      else if (Array.isArray(c)) {
        const seg = c.find((b): b is { type: string; text: string } => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string");
        if (seg && seg.text.length > 0) rawTitle = seg.text;
      }
    }
  }
  return { sessionId, file: name, rawTitle, lastActiveMs, entryCount: entries, sizeBytes, partial };
}

function toDto(r: RawEntry): ScannedSession {
  const t = r.rawTitle === null ? { text: "", truncated: false } : sanitizeText(r.rawTitle, SCAN_LIMITS.titleLimit); // sanitize 先于截断
  return {
    sessionId: r.sessionId,
    file: r.file,
    title: t,
    lastActiveMs: r.lastActiveMs,
    entryCount: r.entryCount,
    // partial ③：占位条目保留已知 sizeBytes（-1=大小未知，如打开即失败）；超预算截断条目保留 fstat size
    sizeBytes: r.sizeBytes,
    listReliability: r.partial ? "partial" : "full",
  };
}
