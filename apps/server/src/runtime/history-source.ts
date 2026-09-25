// 3b-2a：真源 HistorySource（journal 面实现；契约=W1-04 端口+GPT 3b-0 §IV.E 冻结边界）。
// 语义要点（冻结落位）：
//  ① 先监视后读取——watch 建立成功才读盘取基线（观察期无窗口）；读失败/建 watch 失败→load=null
//    （网关 4402 fail-closed；不静默降为快照）。
//  ② 单次装载=一代（generation）：observe 绑定当代 sinks；换代后旧通知/旧异步续体一律丢弃。
//  ③ 事件三分：追加→onAppend（前缀 diff 逐行）；盘面失效→onInvalidate(rewrite|truncate|replace)
//    （源即停旧代追加+关观察；网关负责 4409 退役/重装载）；不可用→onUnavailable(deleted|unreadable|
//    watch-failed|scan-over-budget)（网关 4402 终止该文件订阅；后续请求可重试）。
//  ④ 去重：重扫按「行定位+原始行」diff——同位置同原文=无变化不重发；同文本不同位置=两行各自发布；
//    已观测位置原文变化=失效换流（不做部分续读）。撕裂尾（无换行残片）不发布，补全后自然编入。
//  ⑤ 安全：每次重读都走安全打开（O_NOFOLLOW|O_NONBLOCK+同 fd 身份+常规文件校验+读中硬限）；
//    dev:ino 身份变化=rename/替换→invalidate("replace")。
//  ⑥ 资源：扫描预算 maxScanBytes（默认 8MiB，读中硬限）；未激活期通知只计数（有界，激活时一次重扫）；
//    观察（=网关 refs>0）期间每文件恰一代一 watcher；dispose 先逻辑失效再关 OS watcher。
//  v1 披露：本实现覆盖 journal 面双源之一——session 文件投影与双源归并=3b-2b（journalFor 钩子已预留）。
import { watch as fsWatch, type FSWatcher } from "node:fs";
import { openSafeFile, readBounded, resolveWithinRoots, SafeOpenError } from "../ws/safe-open.ts";
import type {
  HistoryInvalidateReason,
  HistorySinks,
  HistoryUnavailableReason,
  HistorySourcePort,
} from "../ws/ws-gateway.ts";
import { journalToScanRows } from "@pi-agent-ui/protocol";
import type { ScanRow } from "@pi-agent-ui/protocol";
import { scanDigest } from "@pi-agent-ui/protocol";

/** 读取端口：一次调用=一次全新安全打开+有界读+身份（测试可注入；默认真盘）。 */
export interface HistoryReaderPort {
  read(absPath: string): Promise<{ text: string; identity: string }>;
}

/** 观察端口：一次调用=建立一次 OS 级变更通知（测试可注入；默认 fs.watch）。 */
export interface HistoryWatcherPort {
  watch(absPath: string, onNotice: () => void, onError: (err: unknown) => void): { close(): void };
}

export interface FileHistorySourceOpts {
  readonly roots: readonly string[];
  /** 逻辑 file → journal 路径（相对 roots 解析；默认=同路径——file 即 journal 文件）。 */
  readonly journalFor?: (file: string) => string;
  readonly reader?: HistoryReaderPort;
  readonly watcher?: HistoryWatcherPort;
  /** 扫描预算（读中硬限；默认 8MiB）。 */
  readonly maxScanBytes?: number;
  readonly audit?: (line: string) => void;
}

const DEFAULT_MAX_SCAN_BYTES = 8 * 1024 * 1024;

/** 真盘读取：安全打开→有界读→同 fd 身份。任何失败抛 SafeOpenError（含 kind 分类）。 */
class RealReader implements HistoryReaderPort {
  constructor(private readonly maxBytes: number) {}
  async read(absPath: string): Promise<{ text: string; identity: string }> {
    const { fh } = await openSafeFile(absPath);
    try {
      const [buf, st] = await Promise.all([readBounded(fh, this.maxBytes, absPath), fh.stat()]);
      return { text: buf.toString("utf8"), identity: `${st.dev}:${st.ino}` };
    } finally {
      await fh.close().catch(() => {});
    }
  }
}

/** 真盘观察：fs.watch（persistent=false——不阻止进程退出）。 */
class RealWatcher implements HistoryWatcherPort {
  watch(absPath: string, onNotice: () => void, onError: (err: unknown) => void): { close(): void } {
    let w: FSWatcher | null = null;
    let closed = false;
    try {
      w = fsWatch(absPath, { persistent: false }, () => onNotice());
    } catch (e) {
      onError(e);
      return { close(): void { /* 建立即失败：无句柄 */ } };
    }
    w.on("error", (e) => { if (!closed) onError(e); });
    return {
      close(): void {
        if (closed) return;
        closed = true;
        try { w?.close(); } catch { /* 已关 */ }
      },
    };
  }
}

interface GenEntry {
  readonly file: string;
  readonly abs: string;
  /** 逻辑失效标记：disposed=true 后一切通知/续体丢弃。 */
  disposed: boolean;
  state: "active" | "closed";
  identity: string;
  /** 已发布基线（locator+digest 列表；增量 diff 依据）。 */
  baseline: { locator: string; digest: string }[];
  /** 基线原文行缓存（追加行重放给 onAppend 用——ScanRow 需 raw/event）。 */
  baselineRows: ScanRow[];
  watchers: { close(): void }[];
  sinks: HistorySinks | null;
  /** 未激活（observe 前）通知计数：激活时一次重扫收敛。 */
  dirtyNotices: number;
  rescanScheduled: boolean;
}

export class FileHistorySource implements HistorySourcePort {
  private readonly entries = new Map<string, GenEntry>();
  private genSeq = 0;

  constructor(private readonly opts: FileHistorySourceOpts) {}

  private audit(line: string): void {
    try { this.opts.audit?.(`${Date.now()} history-source ${line}`); } catch { /* 审计不阻断 */ }
  }

  private reader(): HistoryReaderPort {
    return this.opts.reader ?? new RealReader(this.opts.maxScanBytes ?? DEFAULT_MAX_SCAN_BYTES);
  }

  private watcherFactory(): HistoryWatcherPort {
    return this.opts.watcher ?? new RealWatcher();
  }

  /** 失败语义：load=null（网关 4402 fail-closed）——读失败/watch 建立失败/越界都不给快照。 */
  async load(file: string): Promise<readonly ScanRow[] | null> {
    const abs = resolveWithinRoots(this.opts.journalFor !== undefined ? this.opts.journalFor(file) : file, this.opts.roots);
    if (abs === null) {
      this.audit(`load-rejected file=${file} reason=outside-roots`);
      return null;
    }
    // ① 先监视（建立失败=fail-closed 拒新订阅，不降快照）。通知/错误直达当代 notice（未激活只计数）。
    const watcherErrors: unknown[] = [];
    // entry 先占位（监视回调闭包引用）；读失败即关。
    const entry: GenEntry = {
      file, abs, disposed: false, state: "active",
      identity: "", baseline: [], baselineRows: [],
      watchers: [], sinks: null, dirtyNotices: 0, rescanScheduled: false,
    };
    const entryRef = entry;
    let watchHandle: { close(): void } | null = null;
    try {
      watchHandle = this.watcherFactory().watch(
        abs,
        () => this.notice(entryRef),
        (e) => { watcherErrors.push(e); this.notice(entryRef); }, // 错误≈变化提示：重扫核实（装载期错误见下）
      );
    } catch (e) {
      this.audit(`watch-setup-failed file=${file} err=${String(e)}`);
      return null;
    }
    entry.watchers.push(watchHandle);
    // ② 后读取（监视已就位——读取期间的变化会被通知标记 dirty）
    let read: { text: string; identity: string };
    try {
      read = await this.reader().read(abs);
    } catch (e) {
      this.closeEntry(entry, `load-read-failed file=${file} err=${safeOpenKind(e)}`);
      return null;
    }
    if (entry.disposed) { // 读取期间被并发换代/销毁：丢弃本次装载
      this.closeEntry(entry, `load-superseded file=${file}`);
      return null;
    }
    const rows = journalToScanRows(read.text);
    entry.identity = read.identity;
    entry.baselineRows = [...rows];
    entry.baseline = rows.map((r) => ({ locator: r.locator, digest: scanDigest(r) }));
    // 换代：旧代先逻辑失效（其 sinks/续体不得再作用）
    const old = this.entries.get(file);
    if (old !== undefined) this.retire(old, "superseded");
    this.entries.set(file, entry);
    // 监视期堆积的错误（watch 建立后又立即出错）：保守视为 watch-failed——不给可疑快照
    if (watcherErrors.length > 0) {
      this.retire(entry, `watch-error-early file=${file}`);
      return null;
    }
    this.audit(`loaded file=${file} gen=${++this.genSeq} rows=${rows.length} dirty=${entry.dirtyNotices}`);
    return rows;
  }

  /** 激活=绑定 sinks（网关已装入快照后才调）。未激活期通知在此时一次重扫收敛。 */
  observe(file: string, sinks: HistorySinks): () => void {
    const entry = this.entries.get(file);
    if (entry === undefined || entry.disposed || entry.state !== "active") return () => {};
    entry.sinks = sinks;
    if (entry.dirtyNotices > 0) {
      entry.dirtyNotices = 0;
      this.scheduleRescan(entry, "activate");
    }
    return () => this.retire(entry, "unobserved");
  }

  private notice(entry: GenEntry): void {
    if (entry.disposed || entry.state !== "active") return;
    if (entry.sinks === null) {
      entry.dirtyNotices += 1; // 未激活：只计数（有界；激活时重扫）
      return;
    }
    this.scheduleRescan(entry, "notice");
  }

  /** 微任务级合并：突发多次通知→一次重扫（重扫本身读全量+diff，天然收敛）。 */
  private scheduleRescan(entry: GenEntry, why: string): void {
    if (entry.rescanScheduled || entry.disposed || entry.state !== "active") return;
    entry.rescanScheduled = true;
    void Promise.resolve().then(async () => {
      entry.rescanScheduled = false;
      if (entry.disposed || entry.state !== "active") return;
      await this.rescan(entry, why);
    });
  }

  private async rescan(entry: GenEntry, why: string): Promise<void> {
    let read: { text: string; identity: string };
    try {
      read = await this.reader().read(entry.abs);
    } catch (e) {
      this.deliverUnavailable(entry, unavailableReasonOf(e));
      return;
    }
    if (entry.disposed || entry.state !== "active") return; // 读期间失效/换代：丢弃
    // 替换检测：dev:ino 变化=rename/替换（即使行内容相同也失效——文件身份已换）
    if (read.identity !== entry.identity) {
      this.deliverInvalidate(entry, "replace");
      return;
    }
    const rows = journalToScanRows(read.text);
    const digests = rows.map((r) => ({ locator: r.locator, digest: scanDigest(r) }));
    // 前缀判定：已观测位置任一（定位+原文摘要）变化→失效；纯变短（前缀相等）→截短
    const common = Math.min(digests.length, entry.baseline.length);
    for (let i = 0; i < common; i++) {
      if (digests[i]?.locator !== entry.baseline[i]?.locator || digests[i]?.digest !== entry.baseline[i]?.digest) {
        this.deliverInvalidate(entry, "rewrite");
        return;
      }
    }
    if (digests.length < entry.baseline.length) {
      this.deliverInvalidate(entry, "truncate");
      return;
    }
    // 追加：逐行重放（同位置同原文的旧行不重发；撕裂尾补全也走这里=新行）
    const appendedCount = rows.length - entry.baseline.length;
    for (let i = entry.baseline.length; i < rows.length; i++) {
      const row = rows[i];
      if (row === undefined) continue;
      try {
        entry.sinks?.onAppend(row);
      } catch (e) {
        this.audit(`append-cb-error file=${entry.file} err=${String(e)}`);
      }
      entry.baselineRows.push(row);
      entry.baseline.push(digests[i] as { locator: string; digest: string });
    }
    this.audit(`rescan file=${entry.file} why=${why} rows=${rows.length} appended=${appendedCount}`);
    // 重挂观察（fs.watch 对 rename 类事件可能失效——每次重扫后重叠换新，关旧；读失败/建失败→watch-failed）
    this.rearmWatcher(entry);
  }

  /** 重叠换新观察：先建新再关旧（无窗口）；重建失败=不可用（fail-closed）。 */
  private rearmWatcher(entry: GenEntry): void {
    if (entry.disposed || entry.state !== "active") return;
    let fresh: { close(): void } | null = null;
    try {
      fresh = this.watcherFactory().watch(entry.abs, () => this.notice(entry), (e) => {
        this.audit(`watch-error file=${entry.file} err=${String(e)}`);
        this.scheduleRescan(entry, "watch-error"); // 错误=变化提示：重扫核实（读失败→unavailable）
      });
    } catch (e) {
      this.audit(`watch-rearm-failed file=${entry.file} err=${String(e)}`);
      this.deliverUnavailable(entry, "watch-failed");
      return;
    }
    entry.watchers.push(fresh);
    for (const w of entry.watchers.splice(0, entry.watchers.length - 1)) {
      try { w.close(); } catch { /* 已关 */ }
    }
  }

  private deliverInvalidate(entry: GenEntry, reason: HistoryInvalidateReason): void {
    const sinks = entry.sinks; // 先捕（closeEntry 会摘 sinks）
    this.closeEntry(entry, `invalidate file=${entry.file} reason=${reason}`);
    this.audit(`invalidate file=${entry.file} reason=${reason}`);
    try {
      sinks?.onInvalidate?.(reason);
    } catch (e) {
      this.audit(`invalidate-cb-error file=${entry.file} err=${String(e)}`);
    }
  }

  private deliverUnavailable(entry: GenEntry, reason: HistoryUnavailableReason): void {
    const sinks = entry.sinks;
    this.closeEntry(entry, `unavailable file=${entry.file} reason=${reason}`);
    this.audit(`unavailable file=${entry.file} reason=${reason}`);
    try {
      sinks?.onUnavailable?.(reason);
    } catch (e) {
      this.audit(`unavailable-cb-error file=${entry.file} err=${String(e)}`);
    }
  }

  /** 逻辑失效先行（disposed/state 关闭+摘 sinks+退登记），再关 OS watcher。 */
  private closeEntry(entry: GenEntry, auditLine: string): void {
    if (this.entries.get(entry.file) === entry) this.entries.delete(entry.file);
    entry.disposed = true;
    entry.state = "closed";
    entry.sinks = null;
    const ws = entry.watchers.splice(0, entry.watchers.length);
    for (const w of ws) {
      try { w.close(); } catch { /* 已关 */ }
    }
    if (auditLine !== "") this.audit(auditLine);
  }

  private retire(entry: GenEntry, why: string): void {
    this.closeEntry(entry, `retired file=${entry.file} why=${why}`);
  }
}

function safeOpenKind(e: unknown): string {
  return e instanceof SafeOpenError ? e.kind : String(e);
}

function unavailableReasonOf(e: unknown): HistoryUnavailableReason {
  if (e instanceof SafeOpenError) {
    switch (e.kind) {
      case "missing": return "deleted";
      case "too-large": return "scan-over-budget";
      default: return "unreadable"; // symlink/not-regular/open-denied/read-failed/outside-roots
    }
  }
  return "unreadable";
}
