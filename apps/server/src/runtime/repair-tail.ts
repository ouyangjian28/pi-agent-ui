// P0-1a 修复留痕（PROJECT P0 冻结序①）：宿主显式撕裂尾截断修复工具。
// 背景（勘察结论）：仓内此前无任何生产 truncate/修复代码路径——撕裂尾修复纯靠宿主手工截尾，
// 修复事实只在内存快照（withRepair 标记）里活一次重启即灭，且截尾后证据链锚点（len+sha）判
// concurrent-modification → 文件永久不可再捕获 = 链路死结。本工具把修复变成显式宿主事务：
//   ① 安全校验：根内词法解析+realpath 实根包含门（GPT r1 B3：稳定祖先 symlink 不得越权引入
//      根外实文件）+O_RDWR|O_NOFOLLOW 同 fd fstat+旧锚前缀哈希复核（锚不匹配=改写面，拒绝动手）；
//   ② 持久意图先于破坏（GPT r1 B5/P5）：truncate 前先把 repair-pending marker 写入 evidenceDir
//      （tmp+rename 原子；与锚点同信任域=宿主专属，journal 写者无权触）——崩溃后重试可凭 marker
//      识别「截断已做/行未补」「行已补/锚未转」两种残局并完成事务，物理修复不再可能无痕回退；
//   ③ 物理修复：ftruncate(byteStart)+fdatasync → 写循环补 repair 行（bytesWritten 死循环推进，
//      零进展即抛；GPT r1 B4：单次 write 短写不检查会误报成功+虚构锚）+fdatasync+回读验证；
//   ④ 锚点合法转移：以回读验证后的盘面字节为准重写锚点（tmp+rename）——修复行+新锚同在本次
//      宿主授权内完成，截尾不是「洗白」而是「有留痕的转移」。
// 信任边界（与 B12-1 同哲学）：
//   - 本工具=宿主侧受信动作（与 migrateLegacyEvidence 同类）；journal 写者（pi 进程）无权触
//     evidenceDir（含 marker 与锚点）；无锚不建锚（首捕授权面不在此）；
//   - marker 无独立真实性证明（r2 B5 披露）：其权威性完全依赖 evidenceDir 目录访问隔离
//     （Q16 部署前提）——越权写入 evidenceDir 者本可直改锚点，故 marker 不构成新增攻击面，
//     但越权伪造 marker 可误导修复事务（bounds+哈希须与盘面密码学吻合才生效，见下）；
//   - marker 补完仅认「盘面与 marker 事实密码学吻合」的形态（截断形=len==byteStart 且末无行；
//     已补行形=末行 schema 合法且 byteStart/byteEnd/removedSha256 与 marker 全等），其余
//     abort=repair-marker-conflict 留宿主调查；锚覆盖被移除字节时 marker 也不得转移锚（前缀
//     伪造不可排除——journal 写者可改盘面，故锚转移仍要求旧锚前缀可复验，与无 marker 残局同界）；
//   - 无 marker 的「行已落盘锚未转移」残局仍走 authorizeStaleAnchorRepair 显式授权门
//     （默认拒绝；GPT r1 B2：识别 repair 行必须过共享 journalLineSchemaError——非法行不得
//     作为合法修复事务凭证）。
// 披露（如实，非缺陷）：marker/锚 tmp+rename 不代表掉电耐久（无目录 fsync，沿用 Q13 限制）；
// 跨进程无锁（Q16 部署前提：修复期禁写，与 provider serialize 同部署纪律）。恢复语义（GPT r1
// B1）：repair 行存在=物理修复事实，不等于裁决——读面（recover.ts）对含 repairLog 的盘面保守
// 阻断重发授权，待 P0-1b 裁决行显式解锁。
import { createHash, randomBytes } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, sep } from "node:path";
import { JOURNAL_CONTRACT_VERSION, journalLineSchemaError, type RepairLine } from "@pi-agent-ui/protocol";
import { openSafeReadWrite, resolveWithinRoots } from "../ws/safe-open.ts";
import { SafeOpenError } from "../ws/safe-open.ts";
import type { FsLike } from "./recovery-evidence-source.ts";

const realFsAnchor: FsLike = {
  writeFile: async (p, d, e) => { const { writeFile } = await import("node:fs/promises"); await writeFile(p, d, e); },
  rename: async (f, t) => { const { rename } = await import("node:fs/promises"); await rename(f, t); },
  rm: async (p, o) => { const { rm } = await import("node:fs/promises"); await rm(p, o); },
};

export interface RepairTailOptions {
  /** 逻辑 journal 名（网关/源同口径；须解析进 roots）。 */
  readonly file: string;
  /** journal 授权根（绝对路径；与网关 roots 同源口径）。 */
  readonly roots: readonly string[];
  /** 证据链 sidecar 目录（绝对路径；与 provider 同目录——marker 与锚点写入处）。 */
  readonly evidenceDir: string;
  /** 宿主构建身份（非空串；入 repair 行）。 */
  readonly buildId: string;
  /** 读入预算（默认 8MiB=DEFAULT_RECOVERY_COMBINED_BYTES 口径；超限拒修——超限文件本就无法捕获）。 */
  readonly maxBytes?: number;
  readonly now?: () => number;
  readonly audit?: (line: string) => void;
  /** 锚点/marker 原子写接缝（受信宿主边界；默认真 fs/promises tmp+rename）。 */
  readonly fsLike?: FsLike;
  /** 测试接缝：journal 打开器（默认 openSafeReadWrite；GPT r1 B4 短写注入点）。 */
  readonly openHandle?: (abs: string) => Promise<import("node:fs/promises").FileHandle>;
  /** 测试接缝：读取完成后、复核截断前调用（确定性注入读后竞态——成长/篡改注入点）。 */
  readonly afterRead?: (ctx: { readonly byteStart: number; readonly byteEnd: number }) => Promise<void>;
  /** 无 marker 残局领回授权（默认拒绝）。true=宿主声明「锚点前缀可复验的修复事务补完」——
   * 密码学可验（旧锚前缀哈希吻合+末条 repair 行对界且过 schema）才生效，否则仍拒。 */
  readonly authorizeStaleAnchorRepair?: (file: string) => boolean | Promise<boolean>;
}

export type RepairTailResult =
  | { readonly kind: "repaired"; readonly file: string; readonly byteStart: number; readonly byteEnd: number;
      readonly removedSha256: string; readonly anchor: { readonly len: number; readonly sha: string } | null; readonly at: string;
      readonly via?: "fresh" | "marker-complete" }
  | { readonly kind: "reconciled"; readonly file: string; readonly anchor: { readonly len: number; readonly sha: string } | null;
      readonly via?: "marker-reconcile" | "authorized" | "marker-cleanup" }
  | { readonly kind: "no-torn-tail"; readonly file: string; readonly size: number }
  | { readonly kind: "oversized"; readonly file: string; readonly size: number; readonly budget: number }
  | { readonly kind: "aborted";
      readonly file: string;
      readonly reason: "anchor-corrupt" | "anchor-mismatch" | "anchor-stale" | "file-changed" | "path-escape" | "repair-marker-conflict";
      readonly detail?: string }
  | { readonly kind: "unreadable"; readonly file: string; readonly detail?: string };

/** 侧车锚点形状（与 recovery-evidence-source.ts EvidenceAnchor 同构；此处独立声明避免跨模块私有类型泄漏）。 */
interface AnchorFile { readonly version: 1; readonly file: string; readonly len: number; readonly sha: string }

/** 修复意图 marker（B5/P5：truncate 前持久化——崩溃后残局可识别可补完）。 */
interface RepairMarker { readonly version: 1; readonly file: string; readonly byteStart: number; readonly byteEnd: number;
  readonly removedSha256: string; readonly startedAt: string }

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
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
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return null;
    return "corrupt";
  }
  return parseAnchor(txt, file);
}

function parseAnchor(txt: string, file: string): AnchorFile | "corrupt" {
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

async function loadMarker(evidenceDir: string, file: string): Promise<RepairMarker | null | "corrupt"> {
  let txt: string;
  try {
    txt = await readFile(markerPath(evidenceDir, file), "utf8");
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return null;
    return "corrupt";
  }
  try {
    const p = JSON.parse(txt) as Partial<RepairMarker>;
    if (p !== null && typeof p === "object" && p.version === 1 && p.file === file &&
        typeof p.byteStart === "number" && Number.isInteger(p.byteStart) && p.byteStart >= 0 &&
        typeof p.byteEnd === "number" && Number.isInteger(p.byteEnd) && p.byteEnd > p.byteStart &&
        typeof p.removedSha256 === "string" && /^[0-9a-f]{64}$/.test(p.removedSha256) &&
        typeof p.startedAt === "string" && p.startedAt.length > 0) {
      return { version: 1, file, byteStart: p.byteStart, byteEnd: p.byteEnd, removedSha256: p.removedSha256, startedAt: p.startedAt };
    }
    return "corrupt";
  } catch {
    return "corrupt";
  }
}

/** 构造 repair 行（含换行；字段序固定=身份可复算）。 */
function buildRepairRow(opts: { byteStart: number; byteEnd: number; removedSha256: string; buildId: string; at: string }): Buffer {
  const line: RepairLine = {
    t: "repair",
    reason: "torn-tail",
    byteStart: opts.byteStart,
    byteEnd: opts.byteEnd,
    removedSha256: opts.removedSha256,
    buildId: opts.buildId,
    contractVersion: JOURNAL_CONTRACT_VERSION,
    at: opts.at,
  };
  return Buffer.from(`${JSON.stringify(line)}\n`, "utf8");
}

/** 解析全文，末条 schema 合法 repair 行事实（offset=行首字节偏移；rowLen=含换行行字节长）。
 * 空行与共享解析器同语义（跳过不中断——GPT r1 P6）；坏行/非法行不认（须过共享 journalLineSchemaError——GPT r1 B2）。 */
function lastRepairRowFact(raw: Buffer): { row: RepairLine; offset: number; rowLen: number } | null {
  let off = 0;
  let last: { row: RepairLine; offset: number; rowLen: number } | null = null;
  const text = raw.toString("utf8");
  const segs = text.split("\n");
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i] as string;
    const isFinal = i === segs.length - 1;
    if (seg === "") {
      if (isFinal) break; // 文件末换行后的空段
      off += 1; // 盘内空行（1 字节）——跳过继续扫（P6：不得截断后续完整行识别）
      continue;
    }
    const rowLen = Buffer.byteLength(`${seg}\n`, "utf8");
    if (seg.includes("\"t\":\"repair\"")) {
      try {
        const p = JSON.parse(seg) as unknown;
        if (p !== null && typeof p === "object" && !Array.isArray(p) && (p as { t?: string }).t === "repair" &&
            journalLineSchemaError(p as Record<string, unknown>) === null) {
          last = { row: p as RepairLine, offset: off, rowLen };
        }
      } catch { /* 非 JSON 行不认 */ }
    }
    off += rowLen;
  }
  return last;
}

/** 写循环（B4：单次 write 可合法短写——零进展抛、逐段推进直至写满）。 */
async function writeFull(fh: import("node:fs/promises").FileHandle, buf: Buffer, position: number, file: string): Promise<void> {
  let written = 0;
  while (written < buf.byteLength) {
    const r = await fh.write(buf, written, buf.byteLength - written, position + written);
    if (r.bytesWritten <= 0) {
      throw new Error(`repair-tail write-stall file=${file} written=${written}/${buf.byteLength}`);
    }
    written += r.bytesWritten;
  }
}

/**
 * 宿主显式撕裂尾修复（P0-1a）。幂等：无撕裂尾且无 marker=no-torn-tail（锚点一致时）。
 * 返回 typed 结果；aborted/unreadable 均不动盘面（fail-closed：宁可让文件留在坏态交宿主调查，
 * 不半途改写）。写途异常（短写停滞/回读不符/锚写失败）上浮抛错——marker 已持久，重试可续。
 */
export async function repairJournalTail(opts: RepairTailOptions): Promise<RepairTailResult> {
  const audit = opts.audit ?? (() => {});
  const now = opts.now ?? (() => Date.now());
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  if (typeof opts.buildId !== "string" || opts.buildId.length === 0) {
    throw new Error("buildId 非法（须非空串）：拒绝修复（行身份不可缺）");
  }
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error(`maxBytes 非法（须有限正数，实得 ${String(maxBytes)}）：拒绝修复`);
  }
  if (!isAbsolute(opts.evidenceDir)) throw new Error("evidenceDir 非法（须绝对路径）：拒绝修复");
  if (opts.roots.length === 0 || !opts.roots.every(isAbsolute)) {
    throw new Error("roots 非法（非空且须绝对路径）：拒绝修复");
  }
  const jAbs = resolveWithinRoots(opts.file, opts.roots);
  if (jAbs === null) return { kind: "unreadable", file: opts.file, detail: "journal 不在授权根内" };

  // B3 实根包含门：词法落根不够——稳定祖先 symlink 可把实文件引到根外；realpath 全链解析后
  // 必须仍落在某授权根的实路径之下（部署前提：祖先目录不可被非信任方替换——此门挡的是
  // 「预先存在/宿主误配」的越界 symlink，不承诺拦截开窗替换竞态）。
  let jReal: string;
  try {
    jReal = await realpath(jAbs);
  } catch {
    audit(`repair-tail-unreadable file=${opts.file} detail=realpath-failed`);
    return { kind: "unreadable", file: opts.file, detail: "realpath-failed" };
  }
  let insideRoots = false;
  for (const r of opts.roots) {
    let rReal: string;
    try {
      rReal = await realpath(r);
    } catch { continue; }
    if (jReal === rReal || jReal.startsWith(rReal + sep)) { insideRoots = true; break; }
  }
  if (!insideRoots) {
    audit(`repair-tail-aborted file=${opts.file} reason=path-escape real=${jReal}`);
    return { kind: "aborted", file: opts.file, reason: "path-escape", detail: "实路径越出全部授权根（祖先 symlink 越界）" };
  }

  const openH = opts.openHandle ?? openSafeReadWrite;
  let fh: import("node:fs/promises").FileHandle;
  try {
    const opened = await openH(jAbs) as { fh?: import("node:fs/promises").FileHandle } | import("node:fs/promises").FileHandle;
    fh = "fh" in opened && opened.fh ? opened.fh : opened as import("node:fs/promises").FileHandle;
  } catch (e) {
    const detail = e instanceof SafeOpenError ? e.kind : "open-failed";
    audit(`repair-tail-unreadable file=${opts.file} detail=${detail}`);
    return { kind: "unreadable", file: opts.file, detail };
  }
  try {
    // 有界读（64KiB 块流式，与 readBounded 同纪律；复用 ws/safe-open 读窗）
    const { readBounded } = await import("../ws/safe-open.ts");
    let raw: Buffer;
    try {
      raw = await readBounded(fh, maxBytes, opts.file);
    } catch (e) {
      if (e instanceof SafeOpenError && e.kind === "too-large") {
        return { kind: "oversized", file: opts.file, size: (await fh.stat()).size, budget: maxBytes };
      }
      audit(`repair-tail-unreadable file=${opts.file} detail=read-failed`);
      return { kind: "unreadable", file: opts.file, detail: "read-failed" };
    }
    const byteEnd = raw.byteLength;
    const byteStart = raw.lastIndexOf(0x0a) + 1; // 无 \n=0（全文件皆撕裂尾）

    // 锚点与 marker 事实（先载入；残局判定要联合两者）
    const anchor = await loadAnchor(opts.evidenceDir, opts.file);
    if (anchor === "corrupt") {
      audit(`repair-tail-aborted file=${opts.file} reason=anchor-corrupt`);
      return { kind: "aborted", file: opts.file, reason: "anchor-corrupt", detail: "锚点 sidecar 损坏=篡改面（fail-closed）" };
    }
    const marker = await loadMarker(opts.evidenceDir, opts.file);
    if (marker === "corrupt") {
      audit(`repair-tail-aborted file=${opts.file} reason=repair-marker-conflict detail=marker-corrupt`);
      return { kind: "aborted", file: opts.file, reason: "repair-marker-conflict", detail: "repair-pending marker 损坏=篡改面（fail-closed，留宿主调查）" };
    }

    if (byteStart === byteEnd) {
      // 无撕裂尾：marker 优先（B5/P5——崩溃残局补完走 marker 事实，不经授权门：
      // marker 本身即宿主意图的持久记录）；无 marker 才走旧残局/健康判定。
      if (marker !== null) {
        return await completeMarkerResidue(fh, raw, anchor, marker, opts, audit);
      }
      // 无 marker：三分支（前缀不可复验→永拒；未完成修复事务+授权→补完锚；纯扩展→no-op）
      if (anchor === null) return { kind: "no-torn-tail", file: opts.file, size: byteEnd };
      const prefixValid = byteEnd >= anchor.len && sha256Hex(raw.subarray(0, anchor.len)) === anchor.sha;
      const last = lastRepairRowFact(raw);
      const unfinished =
        last !== null &&
        last.row.byteStart === last.offset && // 行自身对界（repair 行首偏移=其声明 byteStart）
        last.offset + last.rowLen === byteEnd && // 该行是文件末行（其后无他物）
        anchor.len <= last.offset; // 锚未覆盖被移除字节（前缀可复验）
      if (!prefixValid) {
        audit(`repair-tail-aborted file=${opts.file} reason=anchor-stale detail=prefix-irreproducible`);
        return { kind: "aborted", file: opts.file, reason: "anchor-stale", detail: "锚点前缀不可复验（覆盖被移除字节/改写面）：需宿主重走迁移/调查" };
      }
      if (unfinished) {
        let ok = false;
        if (opts.authorizeStaleAnchorRepair !== undefined) {
          try { ok = await opts.authorizeStaleAnchorRepair(opts.file); } catch { ok = false; }
        }
        if (!ok) {
          audit(`repair-tail-aborted file=${opts.file} reason=anchor-stale detail=unauthorized-residue`);
          return { kind: "aborted", file: opts.file, reason: "anchor-stale", detail: "未完成修复事务（行已落盘锚未转移）：需显式 authorizeStaleAnchorRepair 授权领回" };
        }
        const newSha = sha256Hex(raw);
        await writeAnchor(opts, anchorPath(opts.evidenceDir, opts.file), { version: 1, file: opts.file, len: byteEnd, sha: newSha });
        audit(`repair-tail-reconciled file=${opts.file} len=${byteEnd}`);
        return { kind: "reconciled", file: opts.file, anchor: { len: byteEnd, sha: newSha }, via: "authorized" };
      }
      return { kind: "no-torn-tail", file: opts.file, size: byteEnd };
    }

    // 有撕裂尾：先验锚（锚不匹配=文件已被改写——不是修复面，拒绝动手）
    if (anchor !== null) {
      if (anchor.len > byteEnd || sha256Hex(raw.subarray(0, anchor.len)) !== anchor.sha) {
        audit(`repair-tail-aborted file=${opts.file} reason=anchor-mismatch oldLen=${anchor.len} newLen=${byteEnd}`);
        return { kind: "aborted", file: opts.file, reason: "anchor-mismatch", detail: "当前盘面与已见证据不符（并发改写/回退）" };
      }
    }

    const removedSha256 = sha256Hex(raw.subarray(byteStart, byteEnd));
    // B3/r2：有撕裂尾时在场 marker 必须参与判定——吻合（bounds+尾哈希全等）=「marker 写后
    // truncate 前崩溃」残局，复用原 marker 事实继续 fresh 修复（startedAt 保留原始时间戳）；
    // 部分补行形=truncate 已做+行写一半崩溃（尾段恰为 marker 构造行的严格前缀）→截回截断形
    // 走 marker 补完（原始删除事实不被二次修复覆盖）；其余=冲突拒绝（marker 保留）。
    if (marker !== null) {
      if (marker.byteStart === byteStart && marker.byteEnd === byteEnd) {
        if (marker.removedSha256 !== removedSha256) {
          audit(`repair-tail-aborted file=${opts.file} reason=file-changed detail=marker-tail-hash`);
          return { kind: "aborted", file: opts.file, reason: "file-changed", detail: "尾段哈希与在场 marker 不符（并发改写）" };
        }
      } else {
        const mrow = buildRepairRow({ byteStart: marker.byteStart, byteEnd: marker.byteEnd, removedSha256: marker.removedSha256, buildId: opts.buildId, at: marker.startedAt });
        const tail = raw.subarray(byteStart, byteEnd);
        if (marker.byteStart === byteStart && byteEnd < marker.byteEnd && mrow.subarray(0, tail.byteLength).equals(tail)) {
          await fh.truncate(marker.byteStart);
          await fh.datasync();
          return await completeMarkerResidue(fh, raw.subarray(0, marker.byteStart), anchor, marker, opts, audit);
        }
        audit(`repair-tail-aborted file=${opts.file} reason=repair-marker-conflict size=${byteEnd} marker=[${marker.byteStart},${marker.byteEnd}]`);
        return { kind: "aborted", file: opts.file, reason: "repair-marker-conflict", detail: "有撕裂尾且与在场 marker 事实不吻合（非部分补行形）——留宿主调查（marker 保留）" };
      }
    }
    const at = marker !== null ? marker.startedAt : new Date(now()).toISOString();
    const row = buildRepairRow({ byteStart, byteEnd, removedSha256, buildId: opts.buildId, at });

    // 测试接缝：读后竞态注入点（读窗完成→复核截断前）
    if (opts.afterRead !== undefined) await opts.afterRead({ byteStart, byteEnd });

    // 同 fd 复核（读窗竞态闭合）：尺寸未变+移除段哈希未变——变了=有并发写者，拒绝动手
    const st2 = await fh.stat();
    if (st2.size !== byteEnd) {
      audit(`repair-tail-aborted file=${opts.file} reason=file-changed size=${st2.size} expected=${byteEnd}`);
      return { kind: "aborted", file: opts.file, reason: "file-changed", detail: "复核尺寸漂移（并发写者）" };
    }
    const tail2 = Buffer.allocUnsafe(byteEnd - byteStart);
    await fh.read(tail2, 0, tail2.byteLength, byteStart);
    if (sha256Hex(tail2) !== removedSha256) {
      audit(`repair-tail-aborted file=${opts.file} reason=file-changed detail=tail-hash`);
      return { kind: "aborted", file: opts.file, reason: "file-changed", detail: "复核尾段哈希漂移（并发写者）" };
    }

    // 持久意图先于破坏（B5/P5）：marker 落 evidenceDir 后才截断——崩溃残局可识别可补完。
    // 吻合形 marker 已在场（上文判定）——不重写，保留原始 startedAt/事实链。
    if (marker === null) {
      await writeMarker(opts, markerPath(opts.evidenceDir, opts.file), { version: 1, file: opts.file, byteStart, byteEnd, removedSha256, startedAt: at });
    }

    // 物理修复：截断→行内 datasync→写循环补行→datasync→回读验证（硬序，与写面同纪律）
    await fh.truncate(byteStart);
    await fh.datasync();
    await writeFull(fh, row, byteStart, opts.file);
    await fh.datasync();
    const chk = Buffer.allocUnsafe(row.byteLength);
    await fh.read(chk, 0, chk.byteLength, byteStart);
    if (!chk.equals(row)) throw new Error("repair-tail row verify failed");

    // 锚点合法转移（仅既有锚；无锚不建——首捕授权面不在此）。锚内容=回读验证后的盘面事实。
    // B2/r2 P7/P8：回读=严格事务后像验证——短读即抛（不做短 Buffer 静默）；保留前缀与授权
    // 前缀逐字节全等+行段与预期行全等（复核窗口外的等长篡改/校验后截短在此暴露，锚不搬）。
    const finalRaw = await readBack(fh, byteStart + row.byteLength, opts.file);
    if (!finalRaw.subarray(0, byteStart).equals(raw.subarray(0, byteStart))) {
      throw new Error(`repair-tail prefix-mismatch-after-repair file=${opts.file}`);
    }
    if (!finalRaw.subarray(byteStart).equals(row)) {
      throw new Error(`repair-tail row-mismatch-after-repair file=${opts.file}`);
    }
    const newAnchor = { len: finalRaw.byteLength, sha: sha256Hex(finalRaw) };
    if (anchor !== null) {
      await writeAnchor(opts, anchorPath(opts.evidenceDir, opts.file), { version: 1, file: opts.file, len: newAnchor.len, sha: newAnchor.sha });
    }
    await clearMarker(opts, markerPath(opts.evidenceDir, opts.file));
    audit(`repair-tail-repaired file=${opts.file} byteStart=${byteStart} byteEnd=${byteEnd} buildId=${opts.buildId} anchor=${anchor !== null ? "moved" : "absent"}`);
    return { kind: "repaired", file: opts.file, byteStart, byteEnd, removedSha256, anchor: anchor === null ? null : newAnchor, at, via: "fresh" };
  } finally {
    await fh.close().catch(() => {});
  }
}

/** 无尾 marker 残局补完（r2 B3 状态机收敛点）：raw=截断形或已补行形盘面（以 \n 结尾）。
 *  四形分派：①锚已转移+行已落盘=只欠清理（B4 幂等清 marker）②截断形=补行 ③已补行形=转锚
 *  ④其余=repair-marker-conflict 拒绝（marker 保留，原始事实不被二次修复覆盖）。 */
async function completeMarkerResidue(
  fh: import("node:fs/promises").FileHandle,
  raw: Buffer,
  anchor: AnchorFile | null,
  marker: RepairMarker,
  opts: RepairTailOptions,
  audit: (line: string) => void,
): Promise<RepairTailResult> {
  const byteEnd = raw.byteLength;
  const last = lastRepairRowFact(raw);
  const rowAtBounds = last !== null && last.offset === marker.byteStart && last.offset + last.rowLen === byteEnd &&
    last.row.byteStart === marker.byteStart && last.row.byteEnd === marker.byteEnd && last.row.removedSha256 === marker.removedSha256;
  const truncatedShape = byteEnd === marker.byteStart; // 截断已做、行未补（长度即证据：前缀段以 \n 结尾）
  // B4/r2 P6：锚已转移+行已落盘=物理修复全部完成、只欠 marker 清理（clearMarker 崩溃窗）——
  // 幂等补完：盘面新后像与锚全等即清 marker 返回（不重写锚、不经前缀门——新锚本身就是完成证据）。
  if (rowAtBounds && anchor !== null && anchor.len === byteEnd && sha256Hex(raw) === anchor.sha) {
    await clearMarker(opts, markerPath(opts.evidenceDir, opts.file));
    audit(`repair-tail-marker-cleanup file=${opts.file} len=${byteEnd}`);
    return { kind: "reconciled", file: opts.file, anchor: { len: anchor.len, sha: anchor.sha }, via: "marker-cleanup" };
  }
  if (truncatedShape || rowAtBounds) {
    // 锚可转移性：无锚直接跳过；有锚仍要求旧锚前缀可复验（journal 写者可改盘面——marker
    // 不豁免前缀伪造，锚覆盖被移除字节依旧永拒走迁移）。
    const prefixOk = anchor === null ||
      (anchor.len <= marker.byteStart && byteEnd >= anchor.len && sha256Hex(raw.subarray(0, anchor.len)) === anchor.sha);
    if (!prefixOk) {
      audit(`repair-tail-aborted file=${opts.file} reason=anchor-stale detail=marker-prefix-irreproducible`);
      return { kind: "aborted", file: opts.file, reason: "anchor-stale", detail: "marker 残局但旧锚前缀不可复验（覆盖被移除字节/改写面）：需宿主重走迁移/调查" };
    }
    const builtRow = buildRepairRow({ byteStart: marker.byteStart, byteEnd: marker.byteEnd, removedSha256: marker.removedSha256, buildId: opts.buildId, at: marker.startedAt });
    if (!rowAtBounds) {
      // 截断形补行（removedSha256 等事实全部来自 marker——尾已物理消失）
      await writeFull(fh, builtRow, marker.byteStart, opts.file);
      await fh.datasync();
      const chk = Buffer.allocUnsafe(builtRow.byteLength);
      await fh.read(chk, 0, chk.byteLength, marker.byteStart);
      if (!chk.equals(builtRow)) throw new Error("repair-tail marker-completion verify failed");
    }
    // B2/r2：回读=严格事务后像验证——短读即抛；保留前缀与授权前缀逐字节全等+行段全等
    // （预期=盘面已补行段的字节原文（rowAtBounds）或刚写入的构造行——不用重构造行对比盘面
    // 行：marker 不存 buildId，跨 build 部署重试不得因 buildId 差异误判行不符）。
    const expectedRow = rowAtBounds ? raw.subarray((last as { offset: number }).offset, byteEnd) : builtRow;
    const finalRaw = await readBack(fh, marker.byteStart + expectedRow.byteLength, opts.file);
    if (!finalRaw.subarray(0, marker.byteStart).equals(raw.subarray(0, marker.byteStart))) {
      throw new Error(`repair-tail prefix-mismatch-after-marker-completion file=${opts.file}`);
    }
    if (!finalRaw.subarray(marker.byteStart).equals(expectedRow)) {
      throw new Error(`repair-tail row-mismatch-after-marker-completion file=${opts.file}`);
    }
    const newAnchor = { len: finalRaw.byteLength, sha: sha256Hex(finalRaw) };
    if (anchor !== null) {
      await writeAnchor(opts, anchorPath(opts.evidenceDir, opts.file), { version: 1, file: opts.file, len: newAnchor.len, sha: newAnchor.sha });
    }
    await clearMarker(opts, markerPath(opts.evidenceDir, opts.file));
    audit(`repair-tail-marker-complete file=${opts.file} shape=${rowAtBounds ? "row-already-written" : "truncated"} len=${newAnchor.len}`);
    return rowAtBounds
      ? { kind: "reconciled", file: opts.file, anchor: anchor === null ? null : newAnchor, via: "marker-reconcile" }
      : { kind: "repaired", file: opts.file, byteStart: marker.byteStart, byteEnd: marker.byteEnd, removedSha256: marker.removedSha256, anchor: anchor === null ? null : newAnchor, at: marker.startedAt, via: "marker-complete" };
  }
  audit(`repair-tail-aborted file=${opts.file} reason=repair-marker-conflict size=${byteEnd} marker=[${marker.byteStart},${marker.byteEnd}]`);
  return { kind: "aborted", file: opts.file, reason: "repair-marker-conflict", detail: "盘面与 marker 事实不吻合（非截断形/已补行形）——留宿主调查（marker 保留）" };
}

/** 全量回读（B4：锚只信盘面——write 返回值不可作为内容证据）。
 *  B2/r2 P8：严格等长——提前 EOF 即抛（短 Buffer 静默返回=虚构锚：校验后盘面被截短仍报成功）。 */
async function readBack(fh: import("node:fs/promises").FileHandle, expectedLen: number, file: string): Promise<Buffer> {
  const buf = Buffer.allocUnsafe(expectedLen);
  let got = 0;
  while (got < expectedLen) {
    const r = await fh.read(buf, got, expectedLen - got, got);
    if (r.bytesRead <= 0) {
      throw new Error(`repair-tail read-back-short file=${file} got=${got}/${expectedLen}`);
    }
    got += r.bytesRead;
  }
  return buf;
}

/** 锚点原子写（tmp 高熵独占名+rename；非掉电耐久=Q13 披露；失败=tmp 卫生后抛=修复事务失败上浮）。 */
async function writeAnchor(opts: RepairTailOptions, apath: string, anchor: AnchorFile): Promise<void> {
  await atomicWrite(opts, apath, JSON.stringify(anchor));
}

async function writeMarker(opts: RepairTailOptions, mpath: string, marker: RepairMarker): Promise<void> {
  await atomicWrite(opts, mpath, JSON.stringify(marker));
}

async function clearMarker(opts: RepairTailOptions, mpath: string): Promise<void> {
  const fsx = opts.fsLike ?? realFsAnchor;
  // B4/r2 P6：清理失败不上浮=静默残局（重试永久误拒）——rm 故障必须抛（物理修复已完成，
  // 调用方重试走 marker-cleanup 幂等补完）；force:true 下 ENOENT 不抛。
  await fsx.rm(mpath, { force: true });
}

async function atomicWrite(opts: RepairTailOptions, apath: string, text: string): Promise<void> {
  const fsx = opts.fsLike ?? realFsAnchor;
  const tmp = `${apath}.tmp-${process.pid}-${(opts.now ?? Date.now)().toString(36)}-${randomBytes(6).toString("hex")}`;
  try {
    await fsx.writeFile(tmp, text, "utf8");
    await fsx.rename(tmp, apath);
  } catch (err) {
    await fsx.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
