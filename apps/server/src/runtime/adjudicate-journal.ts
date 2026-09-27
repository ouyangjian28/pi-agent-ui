// P0-1b 裁决持久化写工具 v2（GPT r1 B1-B5 修复批）
//
// 职责：宿主人工裁决（resend/abandon）以 adjudicate 行追加进 journal（与 repair 行同机制），
// 重启后可重读配对解锁。四道门（任一拒=零改盘）：
//   ①实根包含门（r1 B4）：词法落根不够——稳定祖先 symlink 可把实文件引到根外；realpath 全链
//     解析后实路径包含判定（与 repair-tail 同界）。越界=aborted path-escape。
//   ②盘面门（r1 B2）：裁决追加的前提=盘面已愈且无在途修复事务——bad 行（含撕裂尾）非空=
//     aborted bad-tail（追加补换行会把撕裂尾变中间断行，repair-tail 只修尾→永久阻断）；repair-pending
//     marker 在场=aborted repair-pending（repair 行已落+marker 未清的残局：事务未完，追加裁决
//     会让 marker 补完路径 marker-conflict 死）。
//   ③身份门（r1 B1/B3/B5）：subject（fragment/repair）=修复事务四元组，须与恰一条 repair 行
//     唯一匹配（多条同四元组=歧义拒）；fragment 另验 intentId∈重放 enqueue 集。raw 全文不入
//     subject——原字节证据由 repair 行 removedSha256 持有（撕裂字节重编码 SHA 不可复原）。
//   ④幂等/冲突终局：同四元组（fragment 须同 intentId）同 verdict=idempotent 返回原时点；
//     换 verdict 或 fragment 换归因目标=conflicting-verdict（终局不可翻转、目标不可静默更换）。
// 落盘：append+sync（失败=write-failed，提交结果不确定——append 已完成的形裁决已在盘，
// 幂等重试收敛，非「零裁决」）；锚点转移（前缀复验→len/sha 前移）失败不回滚不阻断——
// provider 验锚只查旧前缀不变（纯扩展允许），下轮捕获自动写新锚收敛，无死锁（r1 P1 正例）。
//
// 信任域：宿主侧受信动作（操作者记名）；evidenceDir（锚+marker）为宿主专属，journal 写者无权触。
// 披露：前缀复验基于初读缓冲（串行前提内的追加窗校验，非并发检测）；marker/锚 tmp+rename
// 无目录 fsync（沿用 Q13 限制）。

import { randomBytes, createHash } from "node:crypto";
import { readFile, realpath, rename, writeFile } from "node:fs/promises";
import { isAbsolute, sep } from "node:path";
import type { FileHandle } from "node:fs/promises";
import { parseJournalText } from "./recover.ts";
import { journalLineSchemaError, type AdjudicateLine, type JournalLine, type IntentId } from "@pi-agent-ui/protocol";

export type AdjudicateSubject =
  | { kind: "fragment"; removedSha256: string; byteStart: number; byteEnd: number; at: string; intentId: IntentId }
  | { kind: "repair"; removedSha256: string; byteStart: number; byteEnd: number; at: string };

export interface AdjudicateOptions {
  /** journal 文件名（相对授权根）。 */
  readonly file: string;
  /** 授权根目录集（journal 只许落在这些根内）。 */
  readonly roots: readonly string[];
  /** 证据目录（锚点与 repair-pending marker 所在，宿主专属信任域）。 */
  readonly evidenceDir: string;
  readonly subject: AdjudicateSubject;
  readonly verdict: "resend" | "abandon";
  readonly operator: string;
  readonly buildId: string;
  readonly contractVersion?: number;
  readonly at?: string;
  /** 审计回调（结构化留痕，不阻断）。 */
  readonly audit?: (msg: string) => void;
  /** 测试接缝：打开句柄（默认 openSafeReadWrite）。 */
  readonly openHandle?: (abs: string) => Promise<{ fh: FileHandle; size: number }>;
  /** 测试接缝：读 marker 内容（默认 readFile）。 */
  readonly readMarker?: (path: string) => Promise<string>;
  /** 测试接缝：锚转移（默认 tmp+rename 原子写）。 */
  readonly writeAnchorImpl?: (path: string, body: string) => Promise<void>;
}

export type AdjudicateResult =
  | { kind: "adjudicated"; at: string; anchorMoved: boolean }
  | { kind: "idempotent"; at: string }
  | { kind: "aborted"; reason: "file-absent" | "path-escape" | "repair-pending" | "bad-tail" | "subject-absent" | "conflicting-verdict" | "write-failed"; detail?: string };

interface AnchorFile {
  readonly version: 1;
  readonly file: string;
  readonly len: number;
  readonly sha: string;
  readonly capturedAt: string;
}

function anchorPath(evidenceDir: string, file: string): string {
  return `${evidenceDir}/${encodeURIComponent(file)}.evidence.json`;
}
function markerPath(evidenceDir: string, file: string): string {
  return `${evidenceDir}/${encodeURIComponent(file)}.repair-pending.json`;
}

async function loadAnchor(evidenceDir: string, file: string): Promise<AnchorFile | null | "corrupt"> {
  let txt: string;
  try {
    txt = await readFile(anchorPath(evidenceDir, file), "utf8");
  } catch {
    return null;
  }
  try {
    const a = JSON.parse(txt) as AnchorFile;
    if (typeof a.len !== "number" || typeof a.sha !== "string") return "corrupt";
    return a;
  } catch {
    return "corrupt";
  }
}

async function resolveWithinRoots(file: string, roots: readonly string[]): Promise<string | null> {
  if (!isAbsolute(file)) {
    for (const r of roots) {
      if (isAbsolute(r)) {
        const abs = `${r.replace(/\/+$/, "")}/${file}`;
        return abs;
      }
    }
    return null;
  }
  return null; // 绝对路径一律不接受（只吃相对名）
}

function sha256HexBuf(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function repairKey(s: { removedSha256: string; byteStart: number; byteEnd: number; at: string }): string {
  return `${s.removedSha256}|${s.byteStart}|${s.byteEnd}|${s.at}`;
}

function knownIntentIds(lines: readonly JournalLine[]): Set<IntentId> {
  // 重放身份面：enqueue（入队意图）/sending（发送开栓）——归因目标须在重放范围内。
  const ids = new Set<IntentId>();
  for (const l of lines) if (l.t === "enqueue" || l.t === "sending") ids.add(l.intentId);
  return ids;
}

export async function adjudicateJournal(opts: AdjudicateOptions): Promise<AdjudicateResult> {
  const audit = opts.audit ?? (() => {});

  // ①实根包含门（r1 B4：词法解析后 realpath 全链验根，祖先 symlink 越界拒）。
  const abs = await resolveWithinRoots(opts.file, opts.roots);
  if (abs === null) return { kind: "aborted", reason: "file-absent", detail: "path-escape" };
  let jReal: string;
  try {
    jReal = await realpath(abs);
  } catch {
    audit(`adjudicate-aborted file=${opts.file} reason=file-absent detail=realpath-failed`);
    return { kind: "aborted", reason: "file-absent", detail: "realpath-failed" };
  }
  let insideRoots = false;
  for (const r of opts.roots) {
    let rReal: string;
    try {
      rReal = await realpath(r);
    } catch {
      continue;
    }
    if (jReal === rReal || jReal.startsWith(rReal + sep)) {
      insideRoots = true;
      break;
    }
  }
  if (!insideRoots) {
    audit(`adjudicate-aborted file=${opts.file} reason=file-absent detail=path-escape real=${jReal}`);
    return { kind: "aborted", reason: "file-absent", detail: "path-escape" };
  }

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

  const text = rawBuf.toString("utf8");
  const { lines, bad } = parseJournalText(text);

  // ②盘面门（r1 B2）：marker 在场=修复事务未完→拒；bad 非空（含撕裂尾）=盘面未愈→拒。
  // 两个都是零改盘（不补换行不 append）。
  const readMarker = opts.readMarker ?? ((p: string) => readFile(p, "utf8"));
  let markerPresent = false;
  try {
    await readMarker(markerPath(opts.evidenceDir, opts.file));
    markerPresent = true;
  } catch {
    markerPresent = false;
  }
  if (markerPresent) {
    audit(`adjudicate-aborted file=${opts.file} reason=repair-pending`);
    return { kind: "aborted", reason: "repair-pending", detail: "修复事务进行中（marker 在场），事务完成后再裁决" };
  }
  if (bad.length > 0) {
    audit(`adjudicate-aborted file=${opts.file} reason=bad-tail badCount=${bad.length}`);
    return { kind: "aborted", reason: "bad-tail", detail: "盘面存在坏行/撕裂尾（未愈），修复完成后再裁决" };
  }

  // ③身份门（r1 B1/B3/B5）：四元组与 repair 行唯一匹配；fragment 另验归因目标在重放范围。
  const subject = opts.subject;
  const repairRows = lines.filter((l): l is Extract<JournalLine, { t: "repair" }> => l.t === "repair");
  const wantKey = repairKey(subject);
  const matches = repairRows.filter((l) => repairKey(l) === wantKey);
  if (matches.length !== 1) {
    return { kind: "aborted", reason: "subject-absent", detail: matches.length === 0 ? "四元组无匹配 repair 行" : "四元组匹配多条 repair 行（歧义拒）" };
  }
  if (subject.kind === "fragment" && !knownIntentIds(lines).has(subject.intentId)) {
    return { kind: "aborted", reason: "subject-absent", detail: "归因目标不在重放范围（enqueue 集）" };
  }

  // ④幂等/冲突终局（r1 B3）：同 kind 同四元组已裁决→同 verdict 且同归因目标=幂等；
  // 反 verdict（终局不可翻转）或 fragment 换归因目标（不可静默更换）均=conflicting-verdict。
  const existing = lines.filter((l): l is JournalLine & { t: "adjudicate" } => l.t === "adjudicate");
  const prior = existing.find((a) => a.subject.kind === subject.kind && repairKey(a.subject) === wantKey);
  if (prior) {
    if (prior.verdict === opts.verdict && (prior.subject.kind !== "fragment" || subject.kind !== "fragment" || prior.subject.intentId === subject.intentId)) {
      return { kind: "idempotent", at: prior.at };
    }
    const swappedTarget = prior.subject.kind === "fragment" && subject.kind === "fragment" && prior.subject.intentId !== subject.intentId;
    return {
      kind: "aborted",
      reason: "conflicting-verdict",
      detail: swappedTarget ? `该修复事务已绑定归因目标 ${prior.subject.intentId}（终局不可静默更换）` : `已裁决 ${prior.verdict}，终局不可翻转`,
    };
  }

  // 落盘：盘面门保证无撕裂尾（sep 逻辑保留作防御）；append+sync。
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
  const sepNeeded = rawBuf.byteLength === 0 || rawBuf[rawBuf.byteLength - 1] === 0x0a ? "" : "\n";
  const appended = Buffer.from(`${sepNeeded}${body}\n`, "utf8");
  try {
    await fh.appendFile(appended);
    await fh.sync();
  } catch (e) {
    // 提交结果不确定：append 已完成再抛（如 sync 失败）的形裁决已在盘——幂等重试收敛，非零裁决。
    audit(`adjudicate-aborted file=${opts.file} reason=write-failed detail=${String(e)}`);
    return { kind: "aborted", reason: "write-failed", detail: "append-or-sync-failed（提交结果不确定，幂等重试收敛）" };
  }

  // 锚点转移：前缀复验（初读缓冲内的追加窗校验，串行前提；非并发检测）→len/sha 前移。
  // 失败不回滚不阻断（r1 P1：provider 验锚只查旧前缀，纯扩展允许，下轮捕获自动收敛）。
  let anchorMoved = false;
  const anchor = await loadAnchor(opts.evidenceDir, opts.file);
  if (anchor !== "corrupt" && anchor !== null) {
    const prefixOk = rawBuf.byteLength >= anchor.len && sha256HexBuf(rawBuf.subarray(0, anchor.len)) === anchor.sha;
    if (!prefixOk) {
      audit(`adjudicate-anchor-stale file=${opts.file}（锚前缀漂移，跳过转移；下轮捕获收敛）`);
    } else {
      const next: AnchorFile = { version: 1, file: opts.file, len: rawBuf.byteLength + appended.byteLength, sha: sha256HexBuf(Buffer.concat([rawBuf, appended])), capturedAt: line.at };
      const writeAnchorImpl = opts.writeAnchorImpl ?? (async (p: string, b: string) => {
        const tmp = `${p}.tmp-${process.pid}-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
        await writeFile(tmp, b, "utf8");
        await rename(tmp, p);
      });
      try {
        await writeAnchorImpl(anchorPath(opts.evidenceDir, opts.file), JSON.stringify(next));
        anchorMoved = true;
      } catch (e) {
        audit(`adjudicate-anchor-transfer-failed file=${opts.file} detail=${String(e)}（裁决已落盘；下轮捕获自动收敛）`);
      }
    }
  }
  return { kind: "adjudicated", at: line.at, anchorMoved };
}
