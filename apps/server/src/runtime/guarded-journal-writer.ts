// P0-2 装配面：journal 写路径守卫壳（设计稿 docs/p0-2-write-identity-design.md §1.2/§3）。
// 职责：把 P0-3 组件（acquireJournalLock/appendWriterOath/WriterGuard）装进生产 DurabilityPort——
// RpcSession 的 TurnGate/DispatchCoordinator 两写入口共用本壳，统一被守（FF-P02-2）。
// r2 根修（GPT r1 审 R1/R2/R3）：每 writer 一条生命周期队列——boot/append/close 全串行，
// dispose 汇合全部队列（含在途 boot）后才释放锁；装配中 dispose 在检查点中止（零宣誓零泄漏）；
// bootP 从构造即归一化（任何异常→failed 结果，永不成 unhandled rejection——GPT R3）。
// 装配序（每 journal 文件一次，懒触发=工厂 writerFor）：
//   mkdir 父目录（对齐 FileDurability 递归建目录）→ acquireJournalLock → disposed 检查点①
//   → 读盘扫描 maxEpoch → disposed 检查点② → appendWriterOath(epoch=maxEpoch+1, bootId)
//   → guard.initialize(oath) → 开写面。
// append 序（每行，全程队列临界区）：disposed 判 → 装配结果判（fail-closed 恒拒）
//   → guard.checkBeforeAppend → inner.append → noteAppended(serializeJournalLine 实长)。
// 失败语义 fail-closed：锁 held（活/死同拒）/bad-tail/oath 写失败/装配 I/O 异常 → 该文件写面永不开放，append 恒 reject。
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { scanWriterEpoch, serializeJournalLine, type DurabilityPort, type JournalLine } from "@pi-agent-ui/protocol";
import { parseJournalText } from "./recover.ts";
import { FileDurability } from "./file-durability.ts";
import { acquireJournalLock, appendWriterOath, WriterGuard } from "./writer-oath.ts";

/** 装配失败原因（append reject Error.message 前缀 guarded-writer:；RpcSession 面收为 durability-failure 类）。 */
export type GuardedBootFailure =
  | { readonly kind: "writer-lock-held"; readonly stale: boolean; readonly holderPid: number | null }
  | { readonly kind: "writer-bad-tail" }
  | { readonly kind: "writer-oath-failed"; readonly detail: string };

export interface GuardedWriterFactoryOpts {
  /** server 启动身份（P02-D2：composition 启动生成一次，全文件共享；锁文件+宣誓行同值）。 */
  readonly bootId: string;
  readonly audit?: (line: string) => void;
  /** 测试接缝：底座耐久实现（默认 FileDurability(file)）。 */
  readonly durabilityFor?: (journalPath: string) => DurabilityPort;
  /** 测试接缝：盘面读（默认 readFile utf8；ENOENT=新建 journal 空盘面）。 */
  readonly readJournal?: (journalPath: string) => Promise<string>;
  readonly now?: () => string;
}

export interface GuardedWriterFactory {
  /** 每 journal 文件一个守卫写者（同文件幂等返回同一实例——TurnGate/Coordinator 共用）。 */
  writerFor(journalPath: string): DurabilityPort;
  /** 汇合全部写者生命周期队列（含在途 boot/append）→ close 底座 → 释放锁（dispose 返回后写面静止、无残锁）。 */
  dispose(): Promise<void>;
}

/** 装配终局：ready 携可直接使用的守卫实例（epoch/oath 已注入）；failed 携原因。 */
type BootResult =
  | { readonly kind: "ready"; readonly guard: WriterGuard }
  | { readonly kind: "failed"; readonly failure: GuardedBootFailure };

export function createGuardedJournalWriterFactory(opts: GuardedWriterFactoryOpts): GuardedWriterFactory {
  const writers = new Map<string, GuardedJournalWriter>();
  const releases = new Map<string, () => Promise<void>>(); // journalPath→release（dispose 归口释放；boot 检查点中止时当场释放）
  let disposed = false; // 工厂层：置位后 writerFor 拒新构造；boot 检查点读此标志中止装配
  const audit = (line: string): void => { try { opts.audit?.(line); } catch { /* 审计异常不阻断 */ } };
  const readJournal = opts.readJournal ?? ((p: string) => readFile(p, "utf8"));

  /** 装配链（每文件一次，进该 writer 队列执行）：目录 → 锁 → 检查点① → 扫描 → 检查点② → 宣誓 → guard。 */
  const bootFile = async (journalPath: string): Promise<BootResult> => {
    // ⓪ 目录准备（GPT R3：FileDurability 会递归建父目录，锁先跑须对齐——否则 ENOENT 杀装配）
    try {
      await mkdir(dirname(journalPath), { recursive: true });
    } catch (e) {
      audit(`guarded-writer mkdir-failed file=${journalPath} detail=${String(e)}`);
      return { kind: "failed", failure: { kind: "writer-oath-failed", detail: `目录准备失败：${String(e)}` } };
    }
    // ① L1 锁（fail-closed：活/死同拒——stale 诊断不抢占；EEXIST 探针活死同拒）
    let lockRelease: (() => Promise<void>) | null = null;
    try {
      const lock = await acquireJournalLock({
        journalPath,
        bootId: opts.bootId,
        ...(opts.now !== undefined ? { now: opts.now } : {}),
      });
      if (!lock.ok) {
        audit(`guarded-writer lock-held file=${journalPath} stale=${lock.stale} holderPid=${lock.holder?.pid ?? "unknown"}`);
        return { kind: "failed", failure: { kind: "writer-lock-held", stale: lock.stale, holderPid: lock.holder?.pid ?? null } };
      }
      lockRelease = lock.release;
    } catch (e) {
      // 取锁 I/O 异常（非 EEXIST 业务面）：归一装配失败——永不向上抛（GPT R3：unhandled rejection 杀进程）
      audit(`guarded-writer lock-io-failed file=${journalPath} detail=${String(e)}`);
      return { kind: "failed", failure: { kind: "writer-oath-failed", detail: `取锁 I/O 失败：${String(e)}` } };
    }
    if (disposed) { // 检查点①：装配中 dispose → 当场释放（dispose 循环不认未登记的锁）+零宣誓
      try { await lockRelease(); } catch (e) { audit(`guarded-writer release-error file=${journalPath} detail=${String(e)}`); }
      audit(`guarded-writer boot-aborted-disposed file=${journalPath} stage=after-lock`);
      return { kind: "failed", failure: { kind: "writer-oath-failed", detail: "disposed-mid-boot(after-lock)" } };
    }
    releases.set(journalPath, lockRelease);
    // ② 盘面扫描（只读 writer 行历史定代次——修复/裁决/恢复链不入装配链，ADR-P02-D4）
    let raw: string;
    try {
      raw = await readJournal(journalPath);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        return { kind: "failed", failure: { kind: "writer-oath-failed", detail: `journal 读失败：${String(e)}` } };
      }
      raw = ""; // 新建 journal：首行=宣誓（INV-1）
    }
    const scan = scanWriterEpoch(parseJournalText(raw).lines);
    const epoch = (scan.maxEpoch ?? 0) + 1;
    if (disposed) { // 检查点②：锁已登记——dispose 循环统一释放；零宣誓
      audit(`guarded-writer boot-aborted-disposed file=${journalPath} stage=pre-oath`);
      return { kind: "failed", failure: { kind: "writer-oath-failed", detail: "disposed-mid-boot(pre-oath)" } };
    }
    // ③ 宣誓（自带 bad-tail 门+参数门+自证；fsync 完成即身份在盘）
    const oath = await appendWriterOath({
      journalPath,
      epoch,
      bootId: opts.bootId,
      ...(opts.now !== undefined ? { at: opts.now() } : {}),
    });
    if (!oath.ok) {
      // 判掉 bad-tail 后剩 invalid-oath|write-failed（均携 detail；invalid-oath 含 at 空串等参数面，装配链不会产生但归一映射）
      const failure: GuardedBootFailure =
        oath.reason === "bad-tail" ? { kind: "writer-bad-tail" } : { kind: "writer-oath-failed", detail: oath.detail };
      audit(`guarded-writer oath-failed file=${journalPath} failure=${failure.kind}${failure.kind === "writer-oath-failed" ? ` detail=${failure.detail}` : ""}`);
      return { kind: "failed", failure };
    }
    // ④ guard 建基线（装配层唯一流入=GPT r3 R3-F1 装配约定：initialize 只收自身 oath 成功结果）
    const guard = new WriterGuard(journalPath, epoch, opts.bootId);
    const initOk = guard.initialize({ byteEnd: oath.byteEnd });
    if (!initOk) {
      // 构造后立即 initialize 必真（一次性标志此时不可能置位）——防御深度，非可达路径
      return { kind: "failed", failure: { kind: "writer-oath-failed", detail: "guard initialize 拒（不可达防御）" } };
    }
    audit(`guarded-writer ready file=${journalPath} epoch=${epoch} bootId=${opts.bootId} byteEnd=${oath.byteEnd}`);
    return { kind: "ready", guard };
  };

  class GuardedJournalWriter implements DurabilityPort {
    /** 生命周期队列（r2 R2 根修）：boot/append/close 全部串行——check→append→note 为不可分临界区，
     *  同写者并发 append 不再被误判 foreign（datasync 窗口内外无第二个 check 在飞）。 */
    private queueTail: Promise<unknown> = Promise.resolve();
    private guard: WriterGuard | null = null;
    private failure: GuardedBootFailure | null = null;
    private readonly writerBooted: Promise<BootResult>;
    /** 写面关停标志：队列临界区内判（含工厂 dispose 汇合）。 */
    private closed = false;

    constructor(readonly journalPath: string, private readonly inner: DurabilityPort) {
      // boot 进队列+从构造即归一化（GPT R3：rejection 永不逃逸成 unhandled——任何异常→failed 结果）
      this.writerBooted = this.enqueue(() => bootFile(journalPath)).then(
        (r) => { if (r.kind === "failed") this.failure = r.failure; else this.guard = r.guard; return r; },
        (e: unknown) => {
          // 防御深度：bootFile 自身已 try/catch 归一，此处兜底不可预期异常（仍归一失败，不杀进程）
          const failure: GuardedBootFailure = { kind: "writer-oath-failed", detail: `装配不可预期异常：${String(e)}` };
          this.failure = failure;
          return { kind: "failed", failure } as const;
        },
      );
    }

    /** 入队：op 与前序临界区串行；队列推进不因前序失败而卡死。返回 op 自身的终局 Promise。 */
    private enqueue<T>(op: () => Promise<T>): Promise<T> {
      const p = this.queueTail.then(op, op);
      this.queueTail = p.then(() => undefined, () => undefined);
      return p;
    }

    /** 工厂 dispose 汇合点：进队列置 closed+关底座——返回即该 writer 全部生命周期操作已排空。 */
    drainAndClose(): Promise<void> {
      return this.enqueue(async () => {
        this.closed = true;
        await this.inner.close?.();
      });
    }

    async append(line: JournalLine): Promise<void> {
      return this.enqueue(async () => {
        if (this.closed) throw new Error("guarded-writer:disposed（写面已关，拒绝追加）");
        const boot = await this.writerBooted; // 已入队前置：boot 恒先于任何 append 临界区（构造即首发）
        if (this.closed) throw new Error("guarded-writer:disposed（写面已关，拒绝追加）"); // await 窗口内关停竞态
        const guard = boot.kind === "ready" ? this.guard : null;
        if (guard === null) {
          // 装配失败（fail-closed 恒拒）或竞态缺 guard（防御深度，boot ready 则 guard 必在）
          const f = this.failure;
          throw new Error(
            `guarded-writer:${f !== null ? (f.kind === "writer-oath-failed" ? `${f.kind}:${f.detail}` : f.kind) : "not-ready"}`,
          );
        }
        const verdict = await guard.checkBeforeAppend();
        if (!verdict.ok) {
          throw new Error(`guarded-writer:${verdict.reason}${verdict.detail !== undefined ? `:${verdict.detail}` : ""}`);
        }
        await this.inner.append(line);
        guard.noteAppended(serializeJournalLine(line).length); // P02-D1：记账与实写同源
      });
    }

    close(): Promise<void> {
      return this.drainAndClose();
    }
  }

  return {
    writerFor(journalPath: string): DurabilityPort {
      if (disposed) throw new Error("guarded-writer-factory: 已销毁，拒绝构造写者");
      const cached = writers.get(journalPath);
      if (cached !== undefined) return cached;
      const inner = opts.durabilityFor?.(journalPath) ?? new FileDurability(journalPath);
      const w = new GuardedJournalWriter(journalPath, inner);
      writers.set(journalPath, w);
      return w;
    },
    async dispose(): Promise<void> {
      disposed = true; // 同步置位：销毁后拒新 writerFor + boot 检查点中止
      // 汇合每个 writer 的生命周期队列（含在途 boot/append），close 底座——返回后写面静止
      await Promise.all([...writers.values()].map((w) => w.drainAndClose().catch((e: unknown) => {
        audit(`guarded-writer drain-error file=${w.journalPath} detail=${String(e)}`);
      })));
      writers.clear();
      // 写面静止后释放全部锁（按文件归口；释放失败不吞清理——audit 留痕，锁自然残留下次 fail-closed）
      for (const [file, release] of releases) {
        try { await release(); } catch (e) { audit(`guarded-writer release-error file=${file} detail=${String(e)}`); }
      }
      releases.clear();
    },
  };
}
