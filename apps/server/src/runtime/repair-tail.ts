// P0-1a 修复留痕（PROJECT P0 冻结序①）：宿主显式撕裂尾截断修复工具。
// 背景（勘察结论）：仓内此前无任何生产 truncate/修复代码路径——撕裂尾修复纯靠宿主手工截尾，
// 修复事实只在内存快照（withRepair 标记）里活一次重启即灭，且截尾后证据链锚点（len+sha）判
// concurrent-modification → 文件永久不可再捕获 = 链路死结。本工具把修复变成显式宿主事务：
//   ① 安全校验：根内解析+O_RDWR|O_NOFOLLOW 同 fd fstat+旧锚前缀哈希复核（锚不匹配=改写面，拒绝动手）；
//   ② 物理修复：ftruncate(byteStart)+fdatasync → 原位置追加 repair 行（P0-1a 行型：
//      byteStart/byteEnd/removedSha256/buildId/contractVersion/at）+fdatasync；
//   ③ 锚点合法转移：锚点 sidecar 重写为修复后盘面 {len,sha}（tmp+rename 原子）——修复行+新锚
//      同在本次宿主授权内完成，截尾不再是「洗白」而是「有留痕的转移」。
// 信任边界（与 B12-1 同哲学）：
//   - 本工具=宿主侧受信动作（与 migrateLegacyEvidence 同类）；journal 写者（pi 进程）无权触锚点；
//   - 锚点缺失时不建锚（不做首捕授权——那是 trustFirstCapture/迁移工具的职责面）；
//   - 崩溃残局（文件已改、锚点未写）→ 默认 fail-closed（aborted:anchor-stale）；仅宿主显式
//     authorizeStaleAnchorRepair 且旧锚前缀仍可密码学复验（anchor.len ≤ 末条 repair 行 byteStart
//     且前缀哈希吻合）才补完锚点（reconciled）；锚曾覆盖被移除字节 → 前缀不可复验 → 永拒。
// 披露（如实，非缺陷）：truncate 与 repair 行写回之间存在崩溃微窗（残局=无行可对账→锚点死结，
// 需重走迁移/重置仓）——P0-3 writerEpoch 与未来原子段切换再收口；跨进程无锁（Q16 部署前提：
// 修复期禁写，与 provider serialize 同部署纪律）。读面认行（recover/projection）不依赖本工具存在。
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { JOURNAL_CONTRACT_VERSION, type RepairLine } from "@pi-agent-ui/protocol";
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
  /** 证据链 sidecar 目录（绝对路径；与 provider 同目录——锚点转移写入处）。 */
  readonly evidenceDir: string;
  /** 宿主构建身份（非空串；入 repair 行）。 */
  readonly buildId: string;
  /** 读入预算（默认 8MiB=DEFAULT_RECOVERY_COMBINED_BYTES 口径；超限拒修——超限文件本就无法捕获）。 */
  readonly maxBytes?: number;
  readonly now?: () => number;
  readonly audit?: (line: string) => void;
  /** 锚点原子写接缝（受信宿主边界；默认真 fs/promises tmp+rename）。 */
  readonly fsLike?: FsLike;
  /** 测试接缝：读取完成后、复核截断前调用（确定性注入读后竞态——成长/篡改注入点）。 */
  readonly afterRead?: (ctx: { readonly byteStart: number; readonly byteEnd: number }) => Promise<void>;
  /** 崩溃残局领回授权（默认拒绝）。true=宿主声明「锚点前缀可复验的修复事务补完」——
   * 密码学可验（旧锚前缀哈希吻合+末条 repair 行对界）才生效，否则仍拒。 */
  readonly authorizeStaleAnchorRepair?: (file: string) => boolean | Promise<boolean>;
}

export type RepairTailResult =
  | { readonly kind: "repaired"; readonly file: string; readonly byteStart: number; readonly byteEnd: number;
      readonly removedSha256: string; readonly anchor: { readonly len: number; readonly sha: string }; readonly at: string }
  | { readonly kind: "reconciled"; readonly file: string; readonly anchor: { readonly len: number; readonly sha: string } }
  | { readonly kind: "no-torn-tail"; readonly file: string; readonly size: number }
  | { readonly kind: "oversized"; readonly file: string; readonly size: number; readonly budget: number }
  | { readonly kind: "aborted";
      readonly file: string;
      readonly reason: "anchor-corrupt" | "anchor-mismatch" | "anchor-stale" | "file-changed";
      readonly detail?: string }
  | { readonly kind: "unreadable"; readonly file: string; readonly detail?: string };

/** 侧车锚点形状（与 recovery-evidence-source.ts EvidenceAnchor 同构；此处独立声明避免跨模块私有类型泄漏）。 */
interface AnchorFile { readonly version: 1; readonly file: string; readonly len: number; readonly sha: string }

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
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

/** 解析全文，末条 repair 行事实（offset=行首字节偏移；len=含换行行字节长）。 */
function lastRepairRowFact(raw: Buffer): { row: RepairLine; offset: number; rowLen: number } | null {
  let off = 0;
  let last: { row: RepairLine; offset: number; rowLen: number } | null = null;
  const text = raw.toString("utf8");
  for (const seg of text.split("\n")) {
    if (seg === "") break; // 末段（撕裂或空）
    const rowLen = Buffer.byteLength(`${seg}\n`, "utf8");
    if (seg.includes("\"t\":\"repair\"")) {
      try {
        const p = JSON.parse(seg) as RepairLine;
        if (p !== null && typeof p === "object" && p.t === "repair") last = { row: p, offset: off, rowLen };
      } catch { /* 坏行：非末条完整 repair 行不认 */ }
    }
    off += rowLen;
  }
  return last;
}

/**
 * 宿主显式撕裂尾修复（P0-1a）。幂等：无撕裂尾=no-torn-tail（锚点一致时）；
 * 已完成修复后的重复调用同样走 no-torn-tail。返回 typed 结果；任何 aborted/unreadable 均不动盘面
 * （fail-closed：宁可让文件留在坏态交宿主调查，不半途改写）。
 */
export async function repairJournalTail(opts: RepairTailOptions): Promise<RepairTailResult> {
  const audit = opts.audit ?? (() => {});
  const now = opts.now ?? (() => Date.now());
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  if (typeof opts.buildId !== "string" || opts.buildId.length === 0) {
    throw new Error("buildId 非法（须非空串）：拒绝修复（行身份不可缺）");
  }
  if (!isAbsolute(opts.evidenceDir)) throw new Error("evidenceDir 非法（须绝对路径）：拒绝修复");
  if (opts.roots.length === 0 || !opts.roots.every(isAbsolute)) {
    throw new Error("roots 非法（非空且须绝对路径）：拒绝修复");
  }
  const jAbs = resolveWithinRoots(opts.file, opts.roots);
  if (jAbs === null) return { kind: "unreadable", file: opts.file, detail: "journal 不在授权根内" };

  let fh: import("node:fs/promises").FileHandle;
  let size: number;
  try {
    ({ fh, size } = await openSafeReadWrite(jAbs));
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
        return { kind: "oversized", file: opts.file, size, budget: maxBytes };
      }
      audit(`repair-tail-unreadable file=${opts.file} detail=read-failed`);
      return { kind: "unreadable", file: opts.file, detail: "read-failed" };
    }
    const byteEnd = raw.byteLength;
    const byteStart = raw.lastIndexOf(0x0a) + 1; // 无 \n=0（全文件皆撕裂尾）

    // 锚点事实（先载入；无论有无撕裂尾都可能需要它判一致性）
    const anchor = await loadAnchor(opts.evidenceDir, opts.file);
    if (anchor === "corrupt") {
      audit(`repair-tail-aborted file=${opts.file} reason=anchor-corrupt`);
      return { kind: "aborted", file: opts.file, reason: "anchor-corrupt", detail: "锚点 sidecar 损坏=篡改面（fail-closed）" };
    }

    if (byteStart === byteEnd) {
      // 无撕裂尾。判定序（测试抓出首版把 reconciled 写成不可达死码后重排）：
      // ①前缀不可复验（锚覆盖被移除字节/盘面改写）→永拒；②未完成修复事务（崩溃窗口 B：
      // repair 行已落盘、锚未转移）且锚前缀仍可验+行对界→需显式授权补完（reconciled）；
      // ③其余（纯扩展正常增长）→干净 no-op。
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
        return { kind: "reconciled", file: opts.file, anchor: { len: byteEnd, sha: newSha } };
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
    const at = new Date(now()).toISOString();
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

    // 物理修复：截断→行内 datasync→原位追加 repair 行→datasync（硬序，与写面同纪律）
    await fh.truncate(byteStart);
    await fh.datasync();
    await fh.write(row, 0, row.byteLength, byteStart);
    await fh.datasync();

    // 锚点合法转移（仅既有锚；无锚不建——首捕授权面不在此）
    const newRaw = Buffer.concat([raw.subarray(0, byteStart), row]);
    const newAnchor = { len: newRaw.byteLength, sha: sha256Hex(newRaw) };
    if (anchor !== null) {
      await writeAnchor(opts, anchorPath(opts.evidenceDir, opts.file), { version: 1, file: opts.file, len: newAnchor.len, sha: newAnchor.sha });
    }
    audit(`repair-tail-repaired file=${opts.file} byteStart=${byteStart} byteEnd=${byteEnd} buildId=${opts.buildId} anchor=${anchor !== null ? "moved" : "absent"}`);
    return { kind: "repaired", file: opts.file, byteStart, byteEnd, removedSha256, anchor: newAnchor, at };
  } finally {
    await fh.close().catch(() => {});
  }
}

/** 锚点原子写（tmp 独占名+rename；失败=tmp 卫生后抛=修复事务失败上浮——锚不落盘=转移未完成）。 */
async function writeAnchor(opts: RepairTailOptions, apath: string, anchor: AnchorFile): Promise<void> {
  const fsx = opts.fsLike ?? realFsAnchor;
  const tmp = `${apath}.tmp-${process.pid}-${(opts.now ?? Date.now)().toString(36)}-${randomBytes(6).toString("hex")}`;
  try {
    await fsx.writeFile(tmp, JSON.stringify(anchor), "utf8");
    await fsx.rename(tmp, apath);
  } catch (err) {
    await fsx.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
