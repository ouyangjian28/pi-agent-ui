// 3b5-3 迁移执行面：宿主显式初始化路径的旧锚/旧仓迁移工具（TECH B14/B15——B15 六条验收边界的执行面）。
// 定位：一次性宿主工具。对 roots 下每个 journal 文件（递归枚举 *.jsonl；枚举只报名，不判定——
// symlink/FIFO 名交 provider safe-open 拒并如实入记录），在显式迁移窗口内经 createRecoveryEvidenceProvider
// 完成权威化：首锚建立（trustFirstCapture）、纯追加前缀验证（截断/同长改写拒绝且不补登记，B15④/R38）、
// seen 补登记（B13-2 登记不变量）——三者全部复用 provider 既有逻辑，本文件禁复制任何证据链算法。
// 接缝复用（B15⑥）：
//   - trustFirstCapture 包装＝计数器（provider 仅在 无锚 且 未登记 时询及；legacy-anchor 补登记路径不询及
//     → 计数=该文件为 fresh-capture 形态）；恒 true 仅存在于本函数创建的 provider 实例生命周期内
//     （迁移窗口=本工具运行期，B15①②：函数返回即关窗，无 bless 通道残留）；
//   - fsLike 包装＝真 fs/promises 直通 + seen.json 归位观测：调用内 seen.json rename 完成=登记原子提交
//     （persistSeenLike 缺省路径走注入 fsLike）→ migrated vs noop 的幂等判据；拒绝路径 provider 不写穿，
//     观测器保持沉默（fail-closed 由 provider 保证，工具只如实转译）；
//   - audit＝逐文件收集（文件间串行调用+provider 仓级串行 → 行归属无交错；成功捕获 provider 无审计行）。
// 迁移验收记录（返回值，不落盘——宿主自行归档）：
//   每文件 {file, outcome: migrated|noop|rejected,
//          source: fresh-capture（无锚未登记，本次建首锚）|legacy-anchor（有锚未登记，本次补登记）
//                 |already-registered（已登记，幂等 no-op）|none（拒绝，未建立权威）,
//          anchor: {len,sha}|null —— 调用后盘面锚点（只读状态报告，读失败/形状非法→null）,
//          registered: yes|no|unknown（盘面 seen.json 读出；仓缺失=no，损坏/形状非法/不可读=unknown）,
//          rejection?: {reason, detail} —— reason=unavailable 联合成员名或 file-unreadable；
//                                    detail=成员 detail 字段（file-unreadable）或最后一条审计行（unavailable）,
//          audit: 该文件全部审计行原文}
//   整体 {evidenceDir（宿主目录·B14 可信前提）, roots, startedAt, endedAt,
//         files（逻辑名去重后字典序）, counts{total,migrated,noop,rejected}, rejections（拒绝文件记录表）}
// 语义边界（如实披露，非缺陷）：
//   - 多 root 同名相对路径：provider resolveWithinRoots 先命中者先读，其余=missing 拒入记录（限制如实记录）；
//   - 拒绝文件绝不补登记、绝不动锚（provider 既有 fail-closed，R38 实证）——工具仅如实记录；
//   - root 目录不可读→readdir 抛出（宿主配置错，与 provider 工厂校验同类口径：配置错即抛，不静默吞）。
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createRecoveryEvidenceProvider,
  isRecoverySnapshot,
  type FsLike,
} from "./recovery-evidence-source.ts";

export interface LegacyEvidenceMigrationOptions {
  /** journal 根目录（绝对路径，非空——校验由 provider 工厂承担，本工具直传）。 */
  readonly roots: readonly string[];
  readonly sessionRoots?: readonly string[];
  readonly sessionFor?: (file: string) => string;
  /** 证据仓目录（宿主可信目录，B14）。 */
  readonly evidenceDir: string;
  readonly maxCombinedBytes?: number;
  /** 时钟注入（记录 startedAt/endedAt；与 provider 共用同一时钟）。 */
  readonly now?: () => number;
}

export interface LegacyEvidenceAnchorFact {
  readonly len: number;
  readonly sha: string;
}

export type LegacyEvidenceMigrationSource =
  | "fresh-capture"
  | "legacy-anchor"
  | "already-registered"
  | "none";

export interface LegacyEvidenceMigrationFileRecord {
  readonly file: string;
  readonly outcome: "migrated" | "noop" | "rejected";
  readonly source: LegacyEvidenceMigrationSource;
  readonly anchor: LegacyEvidenceAnchorFact | null;
  readonly registered: "yes" | "no" | "unknown";
  readonly rejection?: { readonly reason: string; readonly detail?: string };
  readonly audit: readonly string[];
}

export interface LegacyEvidenceMigrationRecord {
  readonly evidenceDir: string;
  readonly roots: readonly string[];
  readonly startedAt: number;
  readonly endedAt: number;
  readonly files: readonly LegacyEvidenceMigrationFileRecord[];
  readonly counts: {
    readonly total: number;
    readonly migrated: number;
    readonly noop: number;
    readonly rejected: number;
  };
  readonly rejections: readonly LegacyEvidenceMigrationFileRecord[];
}

/** 递归枚举 root 下 *.jsonl（相对 root 的逻辑名，POSIX 分隔符）。只报名不判定：symlink/FIFO 交 provider 拒。 */
async function listJournalFiles(root: string): Promise<string[]> {
  const names: string[] = [];
  const walk = async (absDir: string, prefix: string): Promise<void> => {
    for (const ent of await readdir(absDir, { withFileTypes: true })) {
      const rel = prefix === "" ? ent.name : `${prefix}/${ent.name}`;
      if (ent.isDirectory()) await walk(join(absDir, ent.name), rel);
      else if (ent.name.endsWith(".jsonl")) names.push(rel);
    }
  };
  await walk(root, "");
  return names;
}

function anchorPath(evidenceDir: string, file: string): string {
  return join(evidenceDir, `${encodeURIComponent(file)}.evidence.json`);
}

/** 调用后盘面锚点事实（len+sha256）。ENOENT/损坏/形状非法→null（拒绝原因已由 rejection/audit 承载）。 */
async function readAnchorFact(evidenceDir: string, file: string): Promise<LegacyEvidenceAnchorFact | null> {
  try {
    const parsed = JSON.parse(await readFile(anchorPath(evidenceDir, file), "utf8")) as {
      len?: unknown;
      sha?: unknown;
    };
    if (
      typeof parsed?.len === "number" &&
      Number.isSafeInteger(parsed.len) &&
      parsed.len >= 0 &&
      typeof parsed?.sha === "string" &&
      /^[0-9a-f]{64}$/.test(parsed.sha)
    ) {
      return { len: parsed.len, sha: parsed.sha };
    }
    return null;
  } catch {
    return null;
  }
}

/** 调用后盘面登记状态。仓缺失=no；损坏/不可读/形状非法=unknown（不臆断）。 */
async function readRegistered(evidenceDir: string, file: string): Promise<"yes" | "no" | "unknown"> {
  try {
    const parsed = JSON.parse(await readFile(join(evidenceDir, "seen.json"), "utf8")) as {
      files?: unknown;
    };
    if (Array.isArray(parsed?.files) && parsed.files.every((f) => typeof f === "string")) {
      return (parsed.files as readonly string[]).includes(file) ? "yes" : "no";
    }
    return "unknown";
  } catch (e) {
    if ((e as { code?: unknown })?.code === "ENOENT") return "no";
    return "unknown";
  }
}

/**
 * 宿主显式初始化路径的旧锚/旧仓迁移工具（3b5-3）。逐文件调用 provider（串行——provider 仓级
 * serialize 在实例内串行，工具层再串行保证逐文件观测归属唯一）。幂等=重复运行遇已登记文件 no-op。
 * 返回迁移验收记录；root 不可读/工厂校验失败→抛出（宿主配置错不吞）。
 */
export async function migrateLegacyEvidence(
  opts: LegacyEvidenceMigrationOptions,
): Promise<LegacyEvidenceMigrationRecord> {
  const now = opts.now ?? (() => Date.now());
  const startedAt = now();
  const seenTarget = join(opts.evidenceDir, "seen.json");
  const realFs: FsLike = { writeFile, rename, rm };
  let seenCommitted = false; // 本文件调用内 seen.json 归位（rename 完成=登记原子提交时点）
  let blessCalled = false; // 本文件调用内 provider 询及首捕授权（=无锚未登记 fresh 形态）
  const fsx: FsLike = {
    writeFile: (p, d, e) => realFs.writeFile(p, d, e),
    rename: async (from, to) => {
      await realFs.rename(from, to);
      if (to === seenTarget) seenCommitted = true;
    },
    rm: (p, o) => realFs.rm(p, o),
  };
  const fileAudit: string[] = [];
  const provider = createRecoveryEvidenceProvider({
    roots: opts.roots,
    evidenceDir: opts.evidenceDir,
    ...(opts.sessionRoots !== undefined ? { sessionRoots: opts.sessionRoots } : {}),
    ...(opts.sessionFor !== undefined ? { sessionFor: opts.sessionFor } : {}),
    ...(opts.maxCombinedBytes !== undefined ? { maxCombinedBytes: opts.maxCombinedBytes } : {}),
    now,
    audit: (line) => {
      fileAudit.push(line);
    },
    fsLike: fsx,
    trustFirstCapture: () => {
      blessCalled = true;
      return true;
    },
  });
  // 多 root 同名相对路径去重：字典序后串行逐文件（先根先读的顺序由 provider resolveWithinRoots 决定）。
  const names = [...new Set((await Promise.all(opts.roots.map(listJournalFiles))).flat())].sort();
  const files: LegacyEvidenceMigrationFileRecord[] = [];
  for (const file of names) {
    seenCommitted = false;
    blessCalled = false;
    fileAudit.length = 0;
    const result = await provider(file);
    const auditLines = [...fileAudit];
    let outcome: LegacyEvidenceMigrationFileRecord["outcome"];
    let source: LegacyEvidenceMigrationSource;
    let rejection: LegacyEvidenceMigrationFileRecord["rejection"] | undefined;
    if (isRecoverySnapshot(result)) {
      outcome = seenCommitted ? "migrated" : "noop";
      source =
        outcome === "migrated"
          ? blessCalled
            ? "fresh-capture"
            : "legacy-anchor"
          : "already-registered";
    } else {
      outcome = "rejected";
      source = "none";
      rejection =
        result.kind === "unavailable"
          ? {
              reason: result.reason,
              ...(auditLines.length > 0
                ? { detail: auditLines[auditLines.length - 1] }
                : {}),
            }
          : { reason: "file-unreadable", ...(result.detail !== undefined ? { detail: result.detail } : {}) };
    }
    files.push({
      file,
      outcome,
      source,
      anchor: await readAnchorFact(opts.evidenceDir, file),
      registered: await readRegistered(opts.evidenceDir, file),
      ...(rejection !== undefined ? { rejection } : {}),
      audit: auditLines,
    });
  }
  const endedAt = now();
  const migrated = files.filter((f) => f.outcome === "migrated").length;
  const noop = files.filter((f) => f.outcome === "noop").length;
  const rejections = files.filter((f) => f.outcome === "rejected");
  return {
    evidenceDir: opts.evidenceDir,
    roots: opts.roots,
    startedAt,
    endedAt,
    files,
    counts: { total: files.length, migrated, noop, rejected: rejections.length },
    rejections,
  };
}
