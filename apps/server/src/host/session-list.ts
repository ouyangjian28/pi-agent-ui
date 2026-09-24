// 会话列表扫描（TECH §6 会话互见：查看≠接管；列表=只读扫描会话文件）
// session-format v3 JSONL：首行 header（version/id/timestamp），后续 entry 行（role/text/时间戳）。
// 坏行跳过（不炸列表）；目录不存在=空列表；目录级 fs.watch 新文件通知。
import { watch, type FSWatcher } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export interface SessionSummary {
  readonly sessionId: string;
  readonly title: string;
  readonly lastActiveMs: number | null;
  readonly entryCount: number;
  readonly sizeBytes: number;
}

export interface SessionScanOptions {
  /** 标题截断长度（默认 80）。 */
  readonly titleMaxChars?: number;
  /** 列表上限（默认 200）。 */
  readonly limit?: number;
}

/** 扫描目录下 *.jsonl 会话文件，按最后活动时间倒序。 */
export async function listSessions(dir: string, opts: SessionScanOptions = {}): Promise<SessionSummary[]> {
  const titleMax = opts.titleMaxChars ?? 80;
  const limit = opts.limit ?? 200;
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return []; // 目录不存在/不可读=空列表（不炸）
  }
  const summaries: SessionSummary[] = [];
  for (const f of files) {
    if (!f.endsWith(".jsonl")) continue;
    const path = join(dir, f);
    try {
      const [info, text] = await Promise.all([stat(path), readFile(path, "utf8")]);
      const { title, lastMs, entryCount } = summarize(text, titleMax);
      summaries.push({ sessionId: f.replace(/\.jsonl$/, ""), title, lastActiveMs: lastMs, entryCount, sizeBytes: info.size });
    } catch {
      continue; // 单文件坏（权限/中途删除）=跳过，不影响其余
    }
  }
  summaries.sort((a, b) => (b.lastActiveMs ?? 0) - (a.lastActiveMs ?? 0));
  return summaries.slice(0, limit);
}

function summarize(text: string, titleMax: number): { title: string; lastMs: number | null; entryCount: number } {
  let title = "";
  let lastMs: number | null = null;
  let entryCount = 0;
  let headerSeen = false;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // 坏行跳过（撕裂尾=半行 JSON）
    }
    if (!headerSeen) {
      headerSeen = true; // 首行=header（version 等）不计 entry
      continue;
    }
    entryCount += 1;
    const ts = extractTimestamp(obj);
    if (ts !== null) lastMs = ts;
    if (!title) title = extractUserText(obj, titleMax);
  }
  return { title: title || "(无标题)", lastMs, entryCount };
}

function extractTimestamp(obj: unknown): number | null {
  if (typeof obj !== "object" || obj === null) return null;
  const ts = (obj as Record<string, unknown>).timestamp ?? (obj as Record<string, unknown>).ts;
  if (typeof ts === "number") return ts;
  if (typeof ts === "string") {
    const p = Date.parse(ts);
    return Number.isFinite(p) ? p : null;
  }
  return null;
}

function extractUserText(obj: unknown, titleMax: number): string {
  if (typeof obj !== "object" || obj === null) return "";
  const r = obj as Record<string, unknown>;
  if (r.type !== "message" && r.role !== "user") return "";
  const role = r.role ?? (typeof r.message === "object" && r.message !== null ? (r.message as Record<string, unknown>).role : undefined);
  if (role !== "user") return "";
  const content = r.content ?? (typeof r.message === "object" && r.message !== null ? (r.message as Record<string, unknown>).content : undefined);
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    for (const c of content) {
      if (typeof c === "object" && c !== null && (c as Record<string, unknown>).type === "text") {
        text = String((c as Record<string, unknown>).text ?? "");
        break;
      }
    }
  }
  text = text.trim().replace(/\s+/g, " ");
  return text.length > titleMax ? text.slice(0, titleMax) + "…" : text;
}

/** 目录级 watch：新会话文件出现→回调（新文件=列表外文件名出现）。 */
export function watchSessions(dir: string, onNew: (file: string) => void): FSWatcher | null {
  try {
    return watch(dir, (event, filename) => {
      if (typeof filename === "string" && filename.endsWith(".jsonl") && event === "rename") onNew(filename);
    });
  } catch {
    return null; // 目录不存在=不 watch（调用方可先建目录）
  }
}
