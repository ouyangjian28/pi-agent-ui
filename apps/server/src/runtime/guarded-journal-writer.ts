// P0-2 r1 装配面：journal 写路径守卫壳（设计稿 docs/p0-2-write-identity-design.md §1.2）。
// 职责：把 P0-3 组件（acquireJournalLock/appendWriterOath/WriterGuard）装进生产 DurabilityPort——
// RpcSession 的 TurnGate/DispatchCoordinator 两写入口共用本壳，统一被守（FF-P02-2）。
// 装配序（每 journal 文件一次，懒触发=工厂 writerFor）：acquireJournalLock → 读盘扫描 maxEpoch →
// appendWriterOath(epoch=maxEpoch+1, bootId) → guard.initialize(oath) → 开写面。
// append 序（每行）：await boot → guard.checkBeforeAppend → inner.append → noteAppended(serializeJournalLine 实长)。
// 失败语义 fail-closed：锁 held（活/死同拒）/bad-tail/oath 写失败 → 该文件写面永不开放，append 恒 reject。
import { readFile } from "node:fs/promises";
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
  /** 释放全部已获取锁（前提=写面已静止：调用方须先停会话排空在途——composition dispose 序保证）。 */
  dispose(): Promise<void>;
}

/** 装配终局：ready 携可直接使用的守卫实例（epoch/oath 已注入）；failed 携原因。 */
type BootResult =
  | { readonly kind: "ready"; readonly guard: WriterGuard }
  | { readonly kind: "failed"; readonly failure: GuardedBootFailure };

export function createGuardedJournalWriterFactory(opts: GuardedWriterFactoryOpts): GuardedWriterFactory {
  const writers = new Map<string, DurabilityPort>();
  const releases: Array<() => Promise<void>> = [];
  let disposed = false;
  const audit = (line: string): void => { try { opts.audit?.(line); } catch { /* 审计异常不阻断 */ } };
  const readJournal = opts.readJournal ?? ((p: string) => readFile(p, "utf8"));

  /** 装配链（每文件一次）：锁 → 扫描 → 宣誓 → guard。全 async 内聚，无跨文件共享可变态。 */
  const bootFile = async (journalPath: string): Promise<BootResult> => {
    // ① L1 锁（fail-closed：活/死同拒——stale 诊断不抢占；EEXIST 探针活死同拒）
    const lock = await acquireJournalLock({
      journalPath,
      bootId: opts.bootId,
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    });
    if (!lock.ok) {
      audit(`guarded-writer lock-held file=${journalPath} stale=${lock.stale} holderPid=${lock.holder?.pid ?? "unknown"}`);
      return { kind: "failed", failure: { kind: "writer-lock-held", stale: lock.stale, holderPid: lock.holder?.pid ?? null } };
    }
    releases.push(lock.release);
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
    private readonly bootP: Promise<BootResult>;
    private guard: WriterGuard | null = null;
    private failure: GuardedBootFailure | null = null;
    /** 工厂 dispose 置位（FF-P02-3：dispose 后无新 append 受理——在途已排空的调用方序前提）；
     *  装配中 dispose→boot 完成但 append 仍拒（写面未开放过，零业务行保证不破）。 */
    disposed = false;

    constructor(readonly journalPath: string, private readonly inner: DurabilityPort) {
      this.bootP = bootFile(journalPath).then((r) => {
        if (r.kind === "failed") this.failure = r.failure;
        else this.guard = r.guard;
        return r;
      });
    }

    async append(line: JournalLine): Promise<void> {
      if (this.disposed) throw new Error("guarded-writer:disposed（写面已关，拒绝追加）");
      const boot = await this.bootP;
      if (this.disposed) throw new Error("guarded-writer:disposed（写面已关，拒绝追加）"); // await 窗口内 dispose 竞态
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
    }

    async close(): Promise<void> {
      await this.inner.close?.();
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
      disposed = true; // 同步置位：销毁后拒新建立即生效
      for (const w of writers.values()) if (w instanceof GuardedJournalWriter) w.disposed = true; // FF-P02-3：现存写者全关写面
      writers.clear();
      // 写面已静止（调用方序保证：registry.dispose 排空会话后才到此处）——逐文件释放锁
      for (const [i, release] of releases.entries()) {
        try { await release(); } catch (e) { audit(`guarded-writer release-error #${i}: ${String(e)}`); }
      }
      releases.length = 0;
    },
  };
}
