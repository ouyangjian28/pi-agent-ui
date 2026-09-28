// P0-3 journal 写权代次（writer oath）：全服务重启身份恢复与拒旧续写。
// 设计稿=docs/p0-3-writer-epoch-design.md；ADR=projects/pi-agent-ui/decisions-2026-09-23.md（P03-D1..D4）。
//
// 两道防线：
//   L1 排他锁文件（O_EXCL 原子创建+pid 探活诊断）——同机双实例硬门：拿不到锁=存在实例或证据不足，
//       拒起零字节写入。**fail-closed：不自动抢占 stale 锁**（r2/GPT r1 F1：探活→unlink→重建
//       的 TOCTOU 窗可产生双持有者；删窗内后来者新建的锁被抢先者 unlink 删除→双写）。
//       stale（探活确认死）同样 held 拒+stale:true 诊断——恢复=宿主/运维显式清锁（pid+bootId
//       证据在场可判），宁拒起不可双写。锁文件持有期内唯一删除者=持有者自身（release 归属校验）。
//   L2 持久代次宣誓（writer 行 append 入 journal）——跨锁防线：锁失效（绕锁路径写/锁文件被误删）
//       场景下，新写者宣誓更高 epoch，旧写者写前检查发现异已宣誓即冻结写面（writer-superseded）。
//       界限（r2/GPT r1 F2）：L2 是事后检测非预防（check→append 窗口存在）；无存储端原子拒旧写，
//       多机共享存储不属支持形态（ADR-P03-D2 r2 修订）。
//
// 启动恢复硬序（宣誓前不开写面）：flock(L1) → 既有恢复链（repair/adjudicate/对账，不改）→
//   扫描最高 writer epoch=N → 自 epoch=N+1 → append 宣誓行+fsync → 开放写面。
//
// 信任域：锁文件与 journal 同目录（写者域）；探活方向保守（判活=拒起/抢占失败，误判死=人工清锁）。
// 不变量（读面机检，违反=呈现不崩溃）：INV-1 首个业务行之前必有 writer 行；INV-2 epoch 严格递增；
//   INV-3 同 epoch 不现两 bootId。

import { open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { scanWriterEpoch } from "@pi-agent-ui/protocol";
import type { JournalLine } from "@pi-agent-ui/protocol";
import { parseJournalText } from "./recover.ts";

// ---------------------------------------------------------------------------
// L1 排他锁文件
// ---------------------------------------------------------------------------

export interface LockHolderInfo {
  readonly pid: number;
  readonly bootId: string | null;
  readonly at: string | null;
}

export type LockAcquireResult =
  | { readonly ok: true; readonly release: () => Promise<void> }
  /** 锁被持有——拒起，零字节写入 journal。holder=null=锁文件读/解析失败（保守按活处理）。
   *  stale=true=探活确认死（崩溃残留）——仍拒起；恢复=显式清锁（本函数不清：自动抢占 TOCTOU=双持有者风险）。 */
  | { readonly ok: false; readonly reason: "held"; readonly holder: LockHolderInfo | null; readonly stale: boolean };

export interface LockOptions {
  /** journal 绝对路径（锁文件=同目录 `${journalPath}.writer.lock`）。 */
  readonly journalPath: string;
  /** 本进程启动身份（写入锁文件，release 时校验归属）。 */
  readonly bootId: string;
  /** 测试接缝：pid 探活（默认 process.kill(pid,0)；ESRCH=死，其余含 EPERM=活）。 */
  readonly alive?: (pid: number) => boolean;
  readonly now?: () => string;
  /** 测试接缝：锁文件读回（r3/F1：release 交错测试可控）。 */
  readonly readLockHolder?: (path: string) => Promise<LockHolderInfo | null>;
}

/** 锁文件内容。 */
interface LockFileBody {
  readonly pid: number;
  readonly bootId: string;
  readonly at: string;
}

function lockPathOf(journalPath: string): string {
  return `${journalPath}.writer.lock`;
}

function defaultAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code !== "ESRCH"; // EPERM（存在但别的用户）等=按活保守
  }
}

async function readLockHolder(path: string): Promise<LockHolderInfo | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockFileBody>;
    if (typeof parsed.pid !== "number" || !Number.isSafeInteger(parsed.pid) || parsed.pid < 1) return null;
    return {
      pid: parsed.pid,
      bootId: typeof parsed.bootId === "string" && parsed.bootId.length > 0 ? parsed.bootId : null,
      at: typeof parsed.at === "string" ? parsed.at : null,
    };
  } catch {
    return null; // 读失败/解析失败=无证据判死 → 保守按 held 拒
  }
}

/**
 * 获取 journal 写权排他锁（L1）。拿不到=存在实例或证据不足，调用方必须拒起。
 * fail-closed（r2/GPT r1 F1）：stale 锁（探活确认死）同样拒起+stale 诊断——不 unlink 不重试
 * （r1 实现的探活→unlink→重建抢占有 TOCTOU 窗：两竞争者交错 unlink 可互删对方新锁→双持有者）。
 * 崩溃残留恢复=显式动作（宿主/运维按 pid+bootId 证据清锁后重启）；宁拒起不可双写。
 */
export async function acquireJournalLock(opts: LockOptions): Promise<LockAcquireResult> {
  const path = lockPathOf(opts.journalPath);
  const alive = opts.alive ?? defaultAlive;
  const body: LockFileBody = { pid: process.pid, bootId: opts.bootId, at: opts.now?.() ?? new Date().toISOString() };
  try {
    const fh = await open(path, "wx");
    try {
      await writeFile(fh, `${JSON.stringify(body)}\n`, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    return {
      ok: true,
      release: (() => {
        // 单次共享（r3/GPT r2 R2-F1）：重叠/重复调用共享同一在途 Promise——至多一次「读回校验→
        // unlink」序列。无共享时交错（release-1 读回暂停→release-2 读+unlink 完成→B 拿锁→
        // release-1 恢复再删=B 的锁被删→C 拿锁=双持有）。前置：调用方保证 release 后写面静止
        // （装配层约束：先关写面再释放锁，见设计稿 §3 r3）。
        let started: Promise<void> | null = null;
        return () => {
          started ??= (async () => {
            const readHolder = opts.readLockHolder ?? readLockHolder;
            const h = await readHolder(path);
            if (h && h.bootId === opts.bootId) await unlink(path).catch(() => undefined);
          })();
          return started;
        };
      })(),
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const holder = await (opts.readLockHolder ?? readLockHolder)(path);
    if (holder === null) return { ok: false, reason: "held", holder: null, stale: false }; // 锁文件不可读=无证据，保守拒起（人工处置）
    const holderAlive = alive(holder.pid);
    return { ok: false, reason: "held", holder, stale: !holderAlive }; // 死=stale 诊断仍拒（显式恢复面）
  }
}

// ---------------------------------------------------------------------------
// L2-扫描：writer 行代次与不变量机检 → 已上移 protocol（scanWriterEpoch；读面/恢复/守卫共用）
// ---------------------------------------------------------------------------

export type { WriterEpochScan, WriterAnomaly } from "@pi-agent-ui/protocol";

// ---------------------------------------------------------------------------
// L2-宣誓：writer 行追加
// ---------------------------------------------------------------------------

export type OathAppendResult =
  | { readonly ok: true; readonly epoch: number; readonly byteStart: number; readonly byteEnd: number }
  /** 撕裂尾/schema 坏行在场=拒（追加补换行会把撕裂尾变永久中间断行；先走 repair-tail 修复）。 */
  | { readonly ok: false; readonly reason: "bad-tail" }
  /** 参数非法（r2/F5：epoch 非正安全整数含代次耗尽/bootId 空）——写前拒，零改盘。 */
  | { readonly ok: false; readonly reason: "invalid-oath"; readonly detail: string }
  /** 追加+fsync 失败（结果未确认：行可能已全/半落盘——幂等重收敛归上层恢复流程）。 */
  | { readonly ok: false; readonly reason: "write-failed"; readonly detail: string };

export interface OathOptions {
  readonly journalPath: string;
  /** 本次宣誓代次（=扫描所得 maxEpoch+1；调用方保证）。 */
  readonly epoch: number;
  readonly bootId: string;
  readonly at?: string;
  /** 测试接缝：打开句柄（默认 append 模式 open）。 */
  readonly openHandle?: (abs: string) => Promise<FileHandle>;
  /** 测试接缝：盘面预检读（默认 readFile utf8）。 */
  readonly readFile?: (path: string) => Promise<string>;
  readonly stat?: (path: string) => Promise<{ size: number }>;
}

/** 追加 writer 宣誓行（参数校验→盘面门→append→fsync）。 */
export async function appendWriterOath(opts: OathOptions): Promise<OathAppendResult> {
  // r2/F5：写前校验将写行——成功返回不得掩盖自造 schema 非法行（epoch 耗尽/越界同样拒；零改盘）
  if (!Number.isSafeInteger(opts.epoch) || opts.epoch < 1)
    return { ok: false, reason: "invalid-oath", detail: `epoch 非正安全整数：${String(opts.epoch)}` };
  if (typeof opts.bootId !== "string" || opts.bootId.length === 0)
    return { ok: false, reason: "invalid-oath", detail: "bootId 空" };
  // r3/GPT r2 R2-F3：at 显式提供时空串拒（写出 schema 不接受的行=写读不一致）；
  // 组装行另做 parseJournalText 自证（成功返回不得掩盖自造 schema 非法行）——均在任何 I/O 前。
  if (opts.at !== undefined && (typeof opts.at !== "string" || opts.at.length === 0))
    return { ok: false, reason: "invalid-oath", detail: "at 空串" };
  let raw: string;
  const readRaw = opts.readFile ?? ((p: string) => readFile(p, "utf8"));
  try {
    raw = await readRaw(opts.journalPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      raw = ""; // 新建 journal：首行=宣誓（INV-1 成立）
    } else {
      return { ok: false, reason: "write-failed", detail: `journal 读失败：${String(e)}` };
    }
  }
  const parsed = parseJournalText(raw);
  if (parsed.bad.length > 0) return { ok: false, reason: "bad-tail" };
  const line = { t: "writer", epoch: opts.epoch, bootId: opts.bootId, at: opts.at ?? new Date().toISOString() };
  const appended = `${JSON.stringify(line)}\n`;
  const selfCheck = parseJournalText(appended);
  if (selfCheck.bad.length > 0)
    return { ok: false, reason: "invalid-oath", detail: `宣誓行 schema 自检失败：${selfCheck.bad[0]?.error ?? "unknown"}` };
  const byteStart = Buffer.byteLength(raw, "utf8");
  let fh: FileHandle;
  try {
    fh = await (opts.openHandle ?? ((abs: string) => open(abs, "a")))(opts.journalPath);
  } catch (e) {
    return { ok: false, reason: "write-failed", detail: `句柄打开失败：${String(e)}` };
  }
  try {
    await fh.appendFile(appended);
    await fh.sync();
  } catch (e) {
    return { ok: false, reason: "write-failed", detail: `追加/sync 失败：${String(e)}` };
  } finally {
    await fh.close().catch(() => undefined);
  }
  return { ok: true, epoch: opts.epoch, byteStart, byteEnd: byteStart + Buffer.byteLength(appended, "utf8") };
}

// ---------------------------------------------------------------------------
// L2-写前守卫：旧写者停写面
// ---------------------------------------------------------------------------

export type GuardVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "writer-superseded" | "foreign-write-detected" | "journal-unreadable" | "uninitialized"; readonly detail?: string };

/**
 * 写前检查器（旧写者冻结面；冻结粘性——一旦冻结后续 append 一律拒，noteAppended 不解冻）。
 * 基线契约（r2/GPT r1 F2）：增量记账，禁全盘 stat 回写——写后用盘面 stat 值重建基线会把并发
 * 他者宣誓字节吞进自身基线，守卫永续放行。正确序：initialize(宣誓后 stat) → [check → append →
 * fsync → noteAppended(自写字节数)]循环。check→append 窗口=检测非预防（L2 界限，见文件头）。
 * 判据：stat size ≠ 基线 → 他者写过 → 重扫 writer 行：异已宣誓（epoch≥自身且 bootId≠自身）
 * → writer-superseded；无异已宣誓的变化 → foreign-write-detected（合法写者必先宣誓）。
 */
export class WriterGuard {
  private lastKnownSize: number | null = null;
  private frozen: GuardVerdict | null = null;
  private initialized = false;

  constructor(
    private readonly journalPath: string,
    private readonly myEpoch: number,
    private readonly myBootId: string,
    private readonly deps: { stat?: (p: string) => Promise<{ size: number }>; readFile?: (p: string) => Promise<string> } = {},
  ) {}

  /** 建基线（一次性）。入参=appendWriterOath 成功结果（r3/GPT r2 R2-F2：可信自身宣誓边界=自己
   *  写的字节终点 byteEnd——用全盘 stat 会把并发他者宣誓字节吞进基线，守卫永续放行；二次
   *  initialize 可重置基线同样吞字节）。已初始化/冻结后调用=无效返回 false（拒重复重置）。 */
  initialize(oath: { readonly byteEnd: number }): boolean {
    if (this.frozen || this.initialized) return false;
    this.initialized = true;
    this.lastKnownSize = oath.byteEnd;
    return true;
  }

  /** 每次 append+fsync 成功后记账（增量：基线+自写字节数；勿用全盘 stat——会吞并发他者写）。 */
  noteAppended(bytes: number): void {
    if (this.frozen) return;
    if (this.lastKnownSize !== null) this.lastKnownSize += bytes;
  }

  /** append 前调用：ok 才许写；未 initialize=拒（接线面必须先宣誓建基线）。 */
  async checkBeforeAppend(): Promise<GuardVerdict> {
    if (this.frozen) return this.frozen;
    if (this.lastKnownSize === null) return this.freeze({ ok: false, reason: "uninitialized", detail: "先 initialize（宣誓 fsync 后）再开写面" });
    let sizeNow: number;
    try {
      sizeNow = (await (this.deps.stat ?? stat)(this.journalPath)).size;
    } catch (e) {
      return this.freeze({ ok: false, reason: "journal-unreadable", detail: String(e) });
    }
    if (sizeNow === this.lastKnownSize) return { ok: true };
    // 盘面被他人动过：重扫 writer 行判让位
    let raw: string;
    const readRaw = this.deps.readFile ?? ((p: string) => readFile(p, "utf8"));
    try {
      raw = await readRaw(this.journalPath);
    } catch (e) {
      return this.freeze({ ok: false, reason: "journal-unreadable", detail: String(e) });
    }
    const scan = scanWriterEpoch(parseJournalText(raw).lines);
    const superseded = scan.maxEpoch !== null && scan.maxEpoch >= this.myEpoch && scan.latestBootId !== this.myBootId;
    return this.freeze(
      superseded
        ? { ok: false, reason: "writer-superseded", detail: `epoch=${scan.maxEpoch} bootId=${scan.latestBootId}` }
        : { ok: false, reason: "foreign-write-detected", detail: `size ${this.lastKnownSize}→${sizeNow} 无异已宣誓` },
    );
  }

  private freeze(v: GuardVerdict): GuardVerdict {
    this.frozen = v;
    return v;
  }
}
