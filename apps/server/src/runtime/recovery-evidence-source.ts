// 3b-4 恢复真读源：RecoveryEvidenceProvider 生产实现（typed 结果+合计 8MiB 入口预算+取消语义）。
// 冻结依据：3b-0 对齐报告（audits/gpt-adapter-3b0-align-2026-09-26.md §5 3b-4 四条+接口裁定「补 typed
// 失败结果（snapshot|unavailable{reason}|file-unreadable）+读中 8MiB 计量+取消语义」）与
// docs/ws-ui-contracts-v1.md §5.6「恢复投影单次读取 ≤8MB（journal+session 合计）→超=unavailable:oversized」。
//
// 预算语义（3b-0 修正项）：8MiB = **journal+session 输入合计字节数**（stat 字节口径，UTF-8 多字节字符
// 按实际字节数计入），不是响应帧大小也不是堆内存。单文件未超但两文件合计超→oversized。
// 「检查后增长」：预算门过后、读完成前输入变大→拒（有界读读 allowed+1 字节，超出即拒——两段闸口
// 间的追加不会溜进结论）。安全 open 失败（缺失/权限等一切读前置错误）→file-unreadable（typed）。
// 快照链纪律（c5 B03）不变：本 provider 只做「首次捕获」的合法入口；恢复结论仍只对快照负责。
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parseJournalText } from "./recover.ts";
import type { RecoveryEvidenceSnapshot } from "./recover.ts";
import type { SessionId } from "@pi-agent-ui/protocol";

/** typed 失败/成功结果（3b-0 冻结三形；reason 枚举=契约 §4 unavailable reason 冻结集）。 */
export type RecoveryEvidenceResult =
  | RecoveryEvidenceSnapshot
  | { readonly kind: "unavailable"; readonly reason: "read-failed" | "concurrent-modification" | "oversized" | "no-evidence-snapshot" }
  | { readonly kind: "file-unreadable"; readonly path: string; readonly detail?: string };

/** 快照判别（snapshot 无 kind 字段；union 收窄用）。 */
export function isRecoverySnapshot(x: RecoveryEvidenceResult | null | undefined): x is RecoveryEvidenceSnapshot {
  return x !== null && x !== undefined && (x as { kind?: string }).kind === undefined;
}

/** 合计入口预算默认值（契约 §5.6：8MB=8*1024*1024）。 */
export const DEFAULT_RECOVERY_COMBINED_BYTES = 8 * 1024 * 1024;

/** stat 接缝（测试可注入增长竞态；默认=node fs）。 */
export interface StatLike { stat(path: string): Promise<{ size: number }>; }
/** 有界读接缝：读至多 maxBytes+1 字节；返回 null=超限（超过 maxBytes——含检查后增长场景）。 */
export interface BoundedReadLike { readBounded(path: string, maxBytes: number): Promise<string | null>; }

/** 默认 stat（node:fs/promises）。 */
import { stat as fsStat } from "node:fs/promises";
const defaultStat: StatLike = { stat: (p) => fsStat(p) };

/** 默认有界读：open→fstat（open 后权威尺寸）→按 maxBytes+1 读；>maxBytes→null（预算门/增长门同判）。 */
const defaultBoundedRead: BoundedReadLike = {
  async readBounded(path, maxBytes) {
    const fh = await open(path, "r");
    try {
      const sizeNow = (await fh.stat()).size; // open 后尺寸（比预检 stat 更接近读时刻）
      const want = Math.min(sizeNow, maxBytes + 1);
      const buf = Buffer.alloc(want);
      const { bytesRead } = await fh.read(buf, 0, want, 0);
      if (bytesRead > maxBytes) return null; // 超预算（含检查后增长：预检 ≤、读时 >）
      return buf.subarray(0, bytesRead).toString("utf8");
    } finally {
      await fh.close();
    }
  },
};

export interface RecoveryEvidenceSourceOptions {
  /** journal 授权根（与网关 roots 同源口径）。 */
  readonly roots: readonly string[];
  /** session 根（默认=roots）。 */
  readonly sessionRoots?: readonly string[];
  /** 逻辑 file→session 路径映射（未提供=journal-only，预算=journal 单文件）。 */
  readonly sessionFor?: (file: string) => string;
  /** journal+session 合计入口预算（默认 8MiB）。 */
  readonly maxCombinedBytes?: number;
  /** 快照 sessionId 派生（默认=去 .jsonl 后缀）。 */
  readonly sessionIdFor?: (file: string) => SessionId;
  readonly now?: () => number;
  readonly audit?: (line: string) => void;
  /** 测试接缝。 */
  readonly statLike?: StatLike;
  readonly readLike?: BoundedReadLike;
}

function errName(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 生产 provider 工厂。file=网关已授权的逻辑 file 名（越界判定在网关；本层再 resolve 一次取绝对路径）。
 * 取消语义：signal.aborted 时各步骤间早退（返回 unavailable/read-failed 由网关按连接态丢弃——
 * 已断连接的帧不入队；未断而 abort 的场景不存在，abort 恒绑定连接关闭）。
 */
export function createRecoveryEvidenceProvider(
  opts: RecoveryEvidenceSourceOptions,
): (file: string, signal?: AbortSignal) => Promise<RecoveryEvidenceResult> {
  const maxBytes = opts.maxCombinedBytes ?? DEFAULT_RECOVERY_COMBINED_BYTES;
  const sessionIdFor = opts.sessionIdFor ?? ((f: string) => f.replace(/\.jsonl$/, ""));
  const statLike = opts.statLike ?? defaultStat;
  const readLike = opts.readLike ?? defaultBoundedRead;
  const now = opts.now ?? (() => Date.now());
  const audit = opts.audit ?? (() => {});
  const sessionRoots = opts.sessionRoots ?? opts.roots;
  return async (file, signal): Promise<RecoveryEvidenceResult> => {
    if (signal?.aborted) return { kind: "unavailable", reason: "read-failed" };
    // journal 绝对路径：roots 内解析（与网关授权同源；不可解析=配置面错位→file-unreadable 如实上报）
    const jAbs = resolveWithin(file, opts.roots);
    if (jAbs === null) return { kind: "file-unreadable", path: file, detail: "journal 不在授权根内" };
    // session 路径：sessionFor 相对名→sessionRoots 内解析；绝对路径照用；无映射=journal-only
    let sAbs: string | null = null;
    if (opts.sessionFor !== undefined) {
      const s = opts.sessionFor(file);
      sAbs = isAbsolute(s) ? s : resolveWithin(s, sessionRoots);
    }
    if (signal?.aborted) return { kind: "unavailable", reason: "read-failed" };
    // 预检（合计字节门）：journal 必在；session ENOENT=合法降级（journal-only），其余 stat 错=file-unreadable
    let jSize: number;
    try {
      jSize = (await statLike.stat(jAbs)).size;
    } catch (e) {
      return { kind: "file-unreadable", path: jAbs, detail: errName(e) };
    }
    let sSize = 0;
    if (sAbs !== null) {
      try {
        sSize = (await statLike.stat(sAbs)).size;
      } catch (e) {
        if (!isEnoent(e)) return { kind: "file-unreadable", path: sAbs, detail: errName(e) };
        sSize = 0; // session 缺失=journal-only 降级（与 DualHistorySource 同口径）
        sAbs = null;
      }
    }
    if (signal?.aborted) return { kind: "unavailable", reason: "read-failed" };
    if (jSize + sSize > maxBytes) {
      audit(`recovery-oversized file=${file} journal=${jSize} session=${sSize} budget=${maxBytes}`);
      return { kind: "unavailable", reason: "oversized" };
    }
    // 有界读（allowed=预算−session 占用；读 allowed+1 字节探增长）
    let raw: string | null;
    try {
      raw = await readLike.readBounded(jAbs, maxBytes - sSize);
    } catch (e) {
      return { kind: "file-unreadable", path: jAbs, detail: errName(e) };
    }
    if (signal?.aborted) return { kind: "unavailable", reason: "read-failed" };
    if (raw === null || Buffer.byteLength(raw) > maxBytes - sSize) {
      // 纵深复核：seam 契约约定超限返 null，但对返回体再验字节长（注入/演进防护——超限串不得漏进结论）
      audit(`recovery-oversized-grew file=${file} journal=${jSize} session=${sSize} budget=${maxBytes}`);
      return { kind: "unavailable", reason: "oversized" }; // 检查后增长（或读窗内超限）→拒
    }
    const { lines, bad } = parseJournalText(raw);
    return { version: 1, file, sessionId: sessionIdFor(file), lines, bad, attributedFragments: [], repaired: false, createdAt: now() };
  };
}

function isEnoent(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "ENOENT";
}

/** roots 内解析（与 ws-gateway resolveWithinRoots 同语义的最小实现：首命中根+防 .. 逃逸）。 */
function resolveWithin(file: string, roots: readonly string[]): string | null {
  if (file.length === 0 || file.includes("/") || file.includes("\\") || file === "." || file === "..") return null;
  for (const root of roots) {
    const abs = resolve(root, file);
    if (abs === resolve(root, abs)) return abs; // resolve 幂等=未逃逸（file 无分隔符时恒真，双保险）
  }
  return null;
}
