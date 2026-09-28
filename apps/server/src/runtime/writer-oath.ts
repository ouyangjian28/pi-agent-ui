// P0-3 journal 写权代次（writer oath）：全服务重启身份恢复与拒旧续写。
// 设计稿=docs/p0-3-writer-epoch-design.md；ADR=projects/pi-agent-ui/decisions-2026-09-23.md（P03-D1..D4）。
//
// 两道防线：
//   L1 排他锁文件（O_EXCL 原子创建+pid 探活）——同机双实例硬门：拿不到锁=存在活实例，拒起零字节写入。
//       （Node 无 flock 绑定；O_EXCL 原子性与 ADR-P03-D2「OS/FS 级原子互斥为主门」语义等价，
//        崩溃残留=锁文件+死 pid，探活后可安全抢占。）
//   L2 持久代次宣誓（writer 行 append 入 journal）——跨锁防线：锁失效（NFS 弱语义/绕锁路径写/锁文件被误删）
//       场景下，新写者宣誓更高 epoch，旧写者写前检查发现异已宣誓即冻结写面（writer-superseded）。
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
  /** 锁被持有（活 pid 或探活不可判）——拒起，零字节写入 journal。holder=null=锁文件读/解析失败（保守按活处理）。 */
  | { readonly ok: false; readonly reason: "held"; readonly holder: LockHolderInfo | null };

export interface LockOptions {
  /** journal 绝对路径（锁文件=同目录 `${journalPath}.writer.lock`）。 */
  readonly journalPath: string;
  /** 本进程启动身份（写入锁文件，release 时校验归属）。 */
  readonly bootId: string;
  /** 测试接缝：pid 探活（默认 process.kill(pid,0)；ESRCH=死，其余含 EPERM=活）。 */
  readonly alive?: (pid: number) => boolean;
  readonly now?: () => string;
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
 * 获取 journal 写权排他锁（L1）。拿不到=存在活实例或证据不足，调用方必须拒起。
 * 死实例残留锁（stale）：探活确认死后 unlink+重试一次（抢占失败=竞争者先得，如实 held）。
 */
export async function acquireJournalLock(opts: LockOptions): Promise<LockAcquireResult> {
  const path = lockPathOf(opts.journalPath);
  const alive = opts.alive ?? defaultAlive;
  const body: LockFileBody = { pid: process.pid, bootId: opts.bootId, at: opts.now?.() ?? new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
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
        release: async () => {
          // 归属校验后删（被抢占的锁不删——只清自己的）
          const h = await readLockHolder(path);
          if (h && h.bootId === opts.bootId) await unlink(path).catch(() => undefined);
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const holder = await readLockHolder(path);
      if (holder === null) return { ok: false, reason: "held", holder: null }; // 锁文件不可读=无证据判死，保守拒起（人工清）
      if (alive(holder.pid)) return { ok: false, reason: "held", holder };
      // stale（探活确认死）：抢占——unlink 后重试一次
      await unlink(path).catch(() => undefined);
    }
  }
  return { ok: false, reason: "held", holder: await readLockHolder(path) };
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

/** 追加 writer 宣誓行（盘面门→append→fsync）。 */
export async function appendWriterOath(opts: OathOptions): Promise<OathAppendResult> {
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
  | { readonly ok: false; readonly reason: "writer-superseded" | "foreign-write-detected" | "journal-unreadable"; readonly detail?: string };

/**
 * 写前检查器（旧写者冻结面；冻结粘性——一旦冻结后续 append 一律拒）。
 * 判据：stat size ≠ 记忆值 → 他者写过 → 重扫 writer 行：
 *   异已宣誓（epoch≥自身且 bootId≠自身）→ writer-superseded（让位证据明确）；
 *   无异已宣誓的变化 → foreign-write-detected（保守冻结：合法写者必先宣誓，无宣誓他写=异常盘面）。
 */
export class WriterGuard {
  private lastKnownSize: number | null = null;
  private frozen: GuardVerdict | null = null;

  constructor(
    private readonly journalPath: string,
    private readonly myEpoch: number,
    private readonly myBootId: string,
    private readonly deps: { stat?: (p: string) => Promise<{ size: number }>; readFile?: (p: string) => Promise<string> } = {},
  ) {}

  /** 宣誓/每次 append 成功后记录盘面 size（守卫基线）。 */
  noteSize(size: number): void {
    this.lastKnownSize = size;
  }

  /** append 前调用：ok 才许写。 */
  async checkBeforeAppend(): Promise<GuardVerdict> {
    if (this.frozen) return this.frozen;
    let sizeNow: number;
    try {
      sizeNow = (await (this.deps.stat ?? stat)(this.journalPath)).size;
    } catch (e) {
      return this.freeze({ ok: false, reason: "journal-unreadable", detail: String(e) });
    }
    if (this.lastKnownSize === null || sizeNow === this.lastKnownSize) return { ok: true };
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
