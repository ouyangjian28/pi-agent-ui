// P0-1b 裁决持久化工具（设计=docs/p0-1b-adjudicate-design.md）。
// adjudicate 行落 journal（宿主侧受信动作，与 repair 行同机制）；裁决行撕裂=坏行→fail-closed
// （只多阻断不漏授权）。写面三道门：①身份在场校验（fragment=raw 在坏行集/repair=四元组在
// repair 行集）②幂等/冲突终局（同 verdict=幂等返回；反 verdict=拒，不可翻转）③落盘
// append+sync（失败=write-failed 零裁决）。落盘成功后锚点转移（len+sha 前移到新内容），
// 否则下轮证据捕获因内容漂移拒新快照（concurrent-modification 保守阻断）。
// 撕裂尾在场时追加前补换行：撕裂行转为中间坏行（raw 保留可全等匹配身份），裁决行独立成行。
import { createHash, randomBytes } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { parseJournalText } from "./recover.ts";
import { journalLineSchemaError, type AdjudicateLine, type JournalLine } from "@pi-agent-ui/protocol";

/** 重放范围意图集（fragment 裁决 intentId 必须在当前重放范围内；enqueue 集即重放范围）。 */
const knownIntentIds = (lines: readonly JournalLine[]): ReadonlySet<string> =>
  new Set(lines.filter((l) => l.t === "enqueue").map((l) => l.intentId));

export type AdjudicateSubject =
  | { readonly kind: "fragment"; readonly raw: string; readonly intentId: string }
  | { readonly kind: "repair"; readonly removedSha256: string; readonly byteStart: number; readonly byteEnd: number; readonly at: string };

export type AdjudicateResult =
  | { readonly kind: "adjudicated"; readonly at: string; readonly anchorMoved: boolean }
  | { readonly kind: "idempotent"; readonly at: string }
  | { readonly kind: "aborted"; readonly reason: "file-absent" | "subject-absent" | "conflicting-verdict" | "write-failed"; readonly detail?: string };

export interface AdjudicateOptions {
  readonly file: string;
  readonly roots: readonly string[];
  readonly evidenceDir: string;
  readonly subject: AdjudicateSubject;
  readonly verdict: "resend" | "abandon";
  readonly operator: string;
  readonly buildId: string;
  readonly contractVersion?: number;
  readonly at?: string;
  /** 测试接缝：默认 openSafeReadWrite；返回 {fh,size}。 */
  readonly openHandle?: (abs: string) => Promise<{ fh: FileHandle; size: number }>;
  readonly audit?: (line: string) => void;
}

interface AnchorFile { readonly version: 1; readonly file: string; readonly len: number; readonly sha: string }

const sha256Hex = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

const repairKey = (r: { removedSha256: string; byteStart: number; byteEnd: number; at: string }): string =>
  `${r.removedSha256}|${r.byteStart}|${r.byteEnd}|${r.at}`;

async function resolveWithinRoots(file: string, roots: readonly string[]): Promise<string | null> {
  const { resolve, isAbsolute, normalize } = await import("node:path");
  if (isAbsolute(file) || file.includes("..")) return null;
  const clean = normalize(file);
  if (clean === "." || clean.startsWith("../")) return null;
  for (const r of roots) {
    const abs = resolve(r, clean);
    const base = resolve(r);
    if (abs === base || !abs.startsWith(`${base}/`)) continue;
    return abs;
  }
  return null;
}

function anchorPath(evidenceDir: string, file: string): string {
  return `${evidenceDir}/${encodeURIComponent(file)}.evidence.json`;
}

async function loadAnchor(evidenceDir: string, file: string): Promise<AnchorFile | null | "corrupt"> {
  let txt: string;
  try {
    txt = await readFile(anchorPath(evidenceDir, file), "utf8");
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return null;
    return "corrupt";
  }
  try {
    const p = JSON.parse(txt) as Partial<AnchorFile>;
    if (p !== null && typeof p === "object" && p.version === 1 && p.file === file &&
        typeof p.len === "number" && Number.isInteger(p.len) && p.len >= 0 &&
        typeof p.sha === "string" && /^[0-9a-f]{64}$/.test(p.sha)) {
      return { version: 1, file, len: p.len, sha: p.sha };
    }
    return "corrupt";
  } catch {
    return "corrupt";
  }
}

async function writeAnchor(evidenceDir: string, file: string, anchor: AnchorFile): Promise<void> {
  const apath = anchorPath(evidenceDir, file);
  const tmp = `${apath}.tmp-${process.pid}-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
  await writeFile(tmp, JSON.stringify(anchor), "utf8");
  await rename(tmp, apath);
}

export async function adjudicateJournal(opts: AdjudicateOptions): Promise<AdjudicateResult> {
  const audit = opts.audit ?? (() => {});
  const abs = await resolveWithinRoots(opts.file, opts.roots);
  if (abs === null) return { kind: "aborted", reason: "file-absent", detail: "path-escape" };
  const openHandle = opts.openHandle ?? (async (a: string) => {
    const { openSafeReadWrite } = await import("../ws/safe-open.ts");
    const real = await openSafeReadWrite(a);
    return { fh: real.fh as unknown as FileHandle, size: real.size };
  });
  let fh: FileHandle;
  let rawBuf: Buffer;
  try {
    const opened = await openHandle(abs);
    fh = opened.fh;
    rawBuf = await fh.readFile();
  } catch {
    audit(`adjudicate-aborted file=${opts.file} reason=file-absent`);
    return { kind: "aborted", reason: "file-absent", detail: "open-or-read-failed" };
  }
  try {
    const text = rawBuf.toString("utf8");
    const { lines } = parseJournalText(text);

    // ①身份在场校验（统一以修复事务为锚——两种 subject 都必须在修复后落盘；修复前残片在场时
    // 追加会破坏撕裂尾结构，且设计上裁决不可先于物理修复）：fragment=sha(raw) 与某 repair 行
    // removedSha256 全等（修复事务持有残片证据的耐久哈希）且 intentId 在重放范围；repair=四元组在
    // repair 行集。无匹配→subject-absent（fail-closed 拒落行）。
    const subject = opts.subject;
    const repairRows = lines.filter((l) => l.t === "repair");
    if (subject.kind === "fragment") {
      const knownIds = knownIntentIds(lines);
      const shaMatch = repairRows.some((l) => l.removedSha256 === sha256Hex(subject.raw));
      if (!shaMatch || !knownIds.has(subject.intentId)) return { kind: "aborted", reason: "subject-absent" };
    } else {
      const wantKey = repairKey(subject);
      const present = repairRows.some((l) => repairKey(l) === wantKey);
      if (!present) return { kind: "aborted", reason: "subject-absent" };
    }

    // ②幂等/冲突终局：同 subject 同 verdict=幂等；反 verdict=不可翻转。
    const existing = lines.filter((l): l is JournalLine & { t: "adjudicate" } => l.t === "adjudicate");
    const sameSubject = (a: AdjudicateLine): boolean =>
      a.subject.kind === "fragment" && subject.kind === "fragment"
        ? a.subject.raw === subject.raw
        : a.subject.kind === "repair" && subject.kind === "repair"
          ? repairKey(a.subject) === repairKey(subject)
          : false;
    const prior = existing.find(sameSubject);
    if (prior) {
      return prior.verdict === opts.verdict
        ? { kind: "idempotent", at: prior.at }
        : { kind: "aborted", reason: "conflicting-verdict", detail: `已裁决 ${prior.verdict}，终局不可翻转` };
    }

    // ③落盘：撕裂尾补换行（撕裂行→中间坏行，raw 保留）；裁决行独立成行；append+sync。
    const line: AdjudicateLine = {
      t: "adjudicate",
      subject: opts.subject,
      verdict: opts.verdict,
      operator: opts.operator,
      buildId: opts.buildId,
      contractVersion: opts.contractVersion ?? 2,
      at: opts.at ?? new Date().toISOString(),
    };
    const schemaErr = journalLineSchemaError(line as unknown as Record<string, unknown>);
    if (schemaErr !== null) return { kind: "aborted", reason: "write-failed", detail: `schema: ${schemaErr}` };
    const body = JSON.stringify(line);
    const sep = rawBuf.byteLength === 0 || rawBuf[rawBuf.byteLength - 1] === 0x0a ? "" : "\n";
    const appended = Buffer.from(`${sep}${body}\n`, "utf8");
    try {
      await fh.appendFile(appended);
      await fh.sync();
    } catch (e) {
      audit(`adjudicate-aborted file=${opts.file} reason=write-failed detail=${String(e)}`);
      return { kind: "aborted", reason: "write-failed", detail: "append-or-sync-failed" };
    }

    // ④锚点转移：前缀复验（防追加窗口篡改）→len+sha 前移到新内容。失败不回滚（行已落盘），
    // 读面下轮捕获因内容漂移拒新快照=保守阻断，方向正确；anchorMoved=false 供宿主重试锚转移。
    let anchorMoved = false;
    const anchor = await loadAnchor(opts.evidenceDir, opts.file);
    if (anchor !== null && anchor !== "corrupt") {
      const prefixOk = anchor.len <= rawBuf.byteLength && sha256Hex(rawBuf.subarray(0, anchor.len)) === anchor.sha;
      if (prefixOk) {
        const fullSha = createHash("sha256").update(rawBuf).update(appended).digest("hex");
        try {
          await writeAnchor(opts.evidenceDir, opts.file, { version: 1, file: opts.file, len: rawBuf.byteLength + appended.byteLength, sha: fullSha });
          anchorMoved = true;
        } catch (e) {
          audit(`adjudicate-anchor-move-failed file=${opts.file} detail=${String(e)}`);
        }
      } else {
        audit(`adjudicate-anchor-prefix-mismatch file=${opts.file}`);
      }
    }
    return { kind: "adjudicated", at: line.at, anchorMoved };
  } finally {
    await fh.close();
  }
}
