// 契约合规的会话目录扫描器（切片③ w0 对齐 D21：现有 host/session-list.ts 不满足 §5.2——全枚举无预算/末尾才 slice/先截断后脱敏/无 partial/无稳定次键）
// 本模块：只读、有界（≤1000 文件枚举+单文件 ≤perFileBudget 读取）、稳定排序（lastActiveMs desc+file 字典序次键）、
// 两级 partial（目录枚举截断=dirReliability；单文件读取截断=条目级）、sanitize 先于截断（title 投影走 SanitizedText）。
// 授权：文件名来自 readdir（basename），最终打开走 openSafeFile（O_NOFOLLOW+常规文件）——拒绝 symlink/FIFO。
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { sanitizeText } from "@pi-agent-ui/protocol";
import { openSafeFile, readBounded } from "./safe-open.ts";

export const SCAN_LIMITS = {
  maxFiles: 1000, // 目录枚举上限（§5.7）
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
  readonly dirReliability: "full" | "partial"; // 目录级（枚举截断/目录不可读）
  readonly dirUnreadable: boolean;
  readonly total: number; // 去重 file 前的全部命中数（未截断时=sessions.length）
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

/** 扫描 roots[0] 下 *.jsonl（v1：列表页根=会话目录单根；多根授权域在 gateway 校验，扫描目录归宿主配置）。 */
export async function scanSessions(
  dir: string,
  opts: { maxFiles?: number; perFileBudget?: number; deps?: { readdir?: typeof readdir; openSafe?: typeof openSafeFile } } = {},
): Promise<ScanResult> {
  const maxFiles = opts.maxFiles ?? SCAN_LIMITS.maxFiles;
  const perFileBudget = opts.perFileBudget ?? SCAN_LIMITS.perFileBudget;
  const rd = opts.deps?.readdir ?? readdir;
  let names: string[];
  try {
    names = await rd(dir);
  } catch {
    return { sessions: [], dirReliability: "partial", dirUnreadable: true, total: 0 };
  }
  const hits = names.filter((n) => FILE_RE.test(n)).sort(); // 枚举序稳定化（文件系统不保证顺序）
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
    dirReliability: truncated ? "partial" : "full",
    dirUnreadable: false,
    total: hits.length,
  };
}

async function scanOne(abs: string, name: string, budget: number, opts: { deps?: { openSafe?: typeof openSafeFile } } ): Promise<RawEntry> {
  const opener = opts.deps?.openSafe ?? openSafeFile;
  try {
    const { fh, size } = await opener(abs);
    let buf: Buffer;
    try {
      buf = await readBounded(fh, budget, name);
    } finally {
      await fh.close().catch(() => {});
    }
    const partial = size > buf.byteLength; // 读取截断（含 readBounded 抛出的场景由 catch 兜底）
    return parseSessionBuffer(buf, name, size, partial);
  } catch {
    // 打开失败（symlink/权限/缺失）或读取超预算：占位条目（partial；不吞文件本身——调用方仍能看到它在列表里）
    return { sessionId: null, file: name, rawTitle: null, lastActiveMs: null, entryCount: 0, sizeBytes: 0, partial: true };
  }
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
      if (typeof o.timestamp === "number" && Number.isFinite(o.timestamp)) lastActiveMs = o.timestamp;
      continue;
    }
    if (o.type === "message" || o.type === "entry") {
      entries++;
      if (typeof o.timestamp === "number" && Number.isFinite(o.timestamp)) lastActiveMs = o.timestamp;
      if (rawTitle === null && o.type === "message") {
        const m = o.message as Record<string, unknown> | undefined;
        const c = m?.content;
        if (typeof c === "string" && c.length > 0) rawTitle = c;
        else if (Array.isArray(c)) {
          const seg = c.find((b): b is { type: string; text: string } => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string");
          if (seg && seg.text.length > 0) rawTitle = seg.text;
        }
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
    sizeBytes: r.sizeBytes,
    listReliability: r.partial ? "partial" : "full",
  };
}
