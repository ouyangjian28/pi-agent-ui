// 3b-2a：真源 HistorySource（journal 面实现；契约=W1-04 端口+GPT 3b-0 §IV.E 冻结边界）。
// 3b2a-R1/R2 重构（GPT 3b2a 审读）：load/observe/release 共享扫描所有权——
//  ① 每文件一个 FileSlot；槽内最多一份在飞扫描（初扫/重扫共用，串行化）；在飞期间新通知折为
//    dirtyPending，完成后恰一次跟进（不再并发扫描，不再「旧扫描把纯追加误判 truncate」P2）。
//  ② load 加入语义：已有活跃代→返回基线快照副本并 awaitingBind+1（此后增长由 onAppend 补齐）；
//    初扫在飞→await 同一 promise（不再各自扫，P3/P4 双装载竞态根除）。
//  ③ 引用纪律：每次 load 解析=+1 引用；observe 消耗一引用并绑定 sinks；release 消耗一引用——
//    最后引用离开且未绑定时槽关闭（unobserve 同理）。网关纪律=每次 load 解析必配对 observe 或 release。
//  ④ 初扫=先建 watcher（同步失败→抛错→load=null，R6）；读→投影（防御出口）→提交 entry。
//    读期间错误进 earlyWatchErrors（提交后核账→watch-error-early 关闭）；读期间 release→releasePending
//    （提交即弃）。
//  ⑤ watcher 活跃期错误：先重叠挂新（关闭事件丢失窗口；失败→unavailable watch-failed）再排重扫。
// 语义要点（冻结落位，沿 3b-2a 首版）：
//  ① 先监视后读取——观察期无窗口；建立失败=load=null（4402 fail-closed，不降快照）。
//  ② 单次装载=一代：换代后旧通知/旧异步续体一律丢弃（dispose 先逻辑失效再关 OS watcher）。
//  ③ 事件三分：追加→onAppend；盘面失效→onInvalidate(rewrite|truncate|replace)；不可用→
//    onUnavailable(deleted|unreadable|watch-failed|scan-over-budget)。
//  ④ 去重=行定位+原文摘要 diff；同位置同原文=无变化；撕裂尾不发布，补全后自然编入。
//  ⑤ 安全=每次重读安全打开+同 fd 身份+读中硬限；dev:ino 变化=invalidate("replace")。
//  v1 披露：本实现覆盖 journal 面双源之一——session 文件投影与双源归并=3b-2b（journalFor 钩子已预留）。
import { watch as fsWatch } from "node:fs";
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

/**
 * 观察端口：一次调用=建立一次 OS 级变更通知（测试可注入；默认 fs.watch）。
 * 3b2a-R6：建立失败（含同步 throw）必须抛错——调用方据此走 fail-closed（load=null/unavailable），
 * 不得降级为「回调了 onError 的空句柄」（读→watch 失败→再读循环，审读 P7）。
 */
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

/** 真盘观察：fs.watch（persistent=false）。建立失败=同步 throw（R6：fail-closed，不降空句柄）。 */
class RealWatcher implements HistoryWatcherPort {
  watch(absPath: string, onNotice: () => void, onError: (err: unknown) => void): { close(): void } {
    const w = fsWatch(absPath, { persistent: false }, () => onNotice()); // 不存在/不可访问→throw
    w.on("error", (e) => onError(e));
    return {
      close(): void {
        try { w.close(); } catch { /* 已关 */ }
      },
    };
  }
}

/** 一代已提交的装载（槽内 0..1 个；sinks 绑定后才有资格收 append——多 sink 各自收）。 */
interface GenEntry {
  readonly file: string;
  readonly abs: string;
  /** 逻辑失效标记：disposed=true 后一切通知/续体丢弃。 */
  disposed: boolean;
  state: "active" | "closed";
  identity: string;
  /** 已发布基线（locator+digest；增量 diff 依据）。 */
  baseline: { locator: string; digest: string }[];
  /** 基线行缓存（load-join 返回副本；追加行重放给 onAppend）。 */
  baselineRows: ScanRow[];
  watchers: { close(): void }[];
  sinks: Set<HistorySinks> | null; // null=未绑定；非空=已绑定（多订阅各自收——网关单 sink 亦兼容）
}

/**
 * 每文件槽（R1/R2 核心）：单飞扫描+引用计数。
 *  scanInFlight：在飞扫描 promise（初扫/重扫共用；非 null 时新扫描/新 rescan 一律排队不并发）。
 *  dirtyPending：在飞扫描期间/未绑定期的变化待补位（恰一次跟进重扫收敛）。
 *  awaitingBind：已解析但尚未配对（observe/release）的 load 引用数。
 *  releasePending：初扫在飞期间被 release——装载完成即弃（不留无主 watcher）。
 */
interface FileSlot {
  readonly file: string;
  abs: string;
  entry: GenEntry | null;
  scanInFlight: Promise<boolean> | Promise<void> | null;
  dirtyPending: boolean;
  rescanQueued: boolean;
  earlyWatchErrors: number;
  awaitingBind: number;
  releasePending: boolean;
}

export class FileHistorySource implements HistorySourcePort {
  private readonly slots = new Map<string, FileSlot>();
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

  private slotOf(file: string): FileSlot | null {
    const abs = resolveWithinRoots(this.opts.journalFor !== undefined ? this.opts.journalFor(file) : file, this.opts.roots);
    if (abs === null) {
      this.audit(`load-rejected file=${file} reason=outside-roots`);
      return null;
    }
    let slot = this.slots.get(file);
    if (slot === undefined) {
      slot = { file, abs, entry: null, scanInFlight: null, dirtyPending: false, rescanQueued: false, earlyWatchErrors: 0, awaitingBind: 0, releasePending: false };
      this.slots.set(file, slot);
    }
    slot.abs = abs;
    return slot;
  }

  /**
   * 失败语义：load=null（网关 4402 fail-closed）——读失败/watch 建立失败/越界/装载期失效都不给快照。
   * 加入语义：活跃代→基线快照副本+引用（R1）；初扫在飞→await 同一 promise（单飞）。
   */
  async load(file: string): Promise<readonly ScanRow[] | null> {
    const slot = this.slotOf(file);
    if (slot === null) return null;
    const active = slot.entry;
    if (active !== null && !active.disposed && active.state === "active") {
      slot.awaitingBind += 1;
      this.audit(`load-joined file=${file} rows=${active.baselineRows.length} awaiting=${slot.awaitingBind}`);
      return [...active.baselineRows];
    }
    if (slot.scanInFlight !== null) {
      const ok = await slot.scanInFlight;
      if (!ok) return null;
      const e = slot.entry;
      if (e === null || e.disposed) return null; // 提交后立被弃（releasePending/早期错误）→fail-closed
      slot.awaitingBind += 1;
      this.audit(`load-joined-after-scan file=${file} rows=${e.baselineRows.length}`);
      return [...e.baselineRows];
    }
    // 初扫：注册先于执行（微任务推迟扫描体——watch 建立/读调用都在 scanInFlight 赋值之后，
    // 读期间通知才有 dirty 可折；迟到的 load 走上面的单飞分支）
    const run = Promise.resolve().then(() => this.initialScan(slot));
    slot.scanInFlight = run;
    let ok: boolean;
    try {
      ok = await run;
    } finally {
      if (slot.scanInFlight === run) slot.scanInFlight = null;
    }
    if (!ok) return null;
    const e = slot.entry;
    if (e === null || e.disposed) return null;
    slot.awaitingBind += 1;
    this.audit(`load-committed file=${file} rows=${e.baselineRows.length} awaiting=${slot.awaitingBind}`);
    return [...e.baselineRows];
  }

  /** 初扫（在 scanInFlight 内运行）：先建 watcher→读→投影防御→提交。任何失败→false（load=null）。 */
  private async initialScan(slot: FileSlot): Promise<boolean> {
    const { file, abs } = slot;
    let handle: { close(): void };
    try {
      handle = this.watcherFactory().watch(
        abs,
        () => this.slotNotice(slot),
        (e) => this.slotError(slot, e),
      );
    } catch (e) {
      this.audit(`watch-setup-failed file=${file} kind=${errKind(e)}`);
      return false;
    }
    let read: { text: string; identity: string };
    try {
      read = await this.reader().read(abs);
    } catch (e) {
      try { handle.close(); } catch { /* 已关 */ }
      this.audit(`load-read-failed file=${file} kind=${errKind(e)}`);
      return false;
    }
    const rows = this.projectSafely(read.text);
    if (rows === null) {
      try { handle.close(); } catch { /* 已关 */ }
      return false; // project-failed 已审计
    }
    const entry: GenEntry = {
      file, abs, disposed: false, state: "active",
      identity: read.identity,
      baseline: rows.map((r) => ({ locator: r.locator, digest: scanDigest(r) })),
      baselineRows: [...rows],
      watchers: [handle],
      sinks: null,
    };
    slot.entry = entry; // 提交（无 await 间隙——本行到核账之间是同步的）
    if (slot.releasePending) { // 初扫期间被 release：装载即弃（不留无主 watcher）
      this.closeEntry(slot, entry, `released-unobserved file=${file}`);
      return false;
    }
    if (slot.earlyWatchErrors > 0) { // 建立后即出错：不给可疑快照（fail-closed）
      this.closeEntry(slot, entry, `watch-error-early file=${file} errors=${slot.earlyWatchErrors}`);
      return false;
    }
    this.audit(`loaded file=${file} gen=${++this.genSeq} rows=${rows.length} dirty=${slot.dirtyPending}`);
    if (slot.dirtyPending) this.queueRescan(slot, "post-initial"); // 绑定与否由 queueRescan 自判（未绑定留 dirty 给 observe 激活）
    return true;
  }

  /** 激活=绑定 sinks（消耗一次装载引用）。未激活期通知在此时一次重扫收敛。返回解绑闭包。 */
  observe(file: string, sinks: HistorySinks): (() => void) | null {
    const slot = this.slots.get(file);
    const entry = slot?.entry ?? null;
    if (slot === undefined || entry === null || entry.disposed || entry.state !== "active") return null;
    entry.sinks = entry.sinks === null ? new Set([sinks]) : entry.sinks;
    entry.sinks.add(sinks); // 多订阅各自收（网关场景恒单元素）
    if (slot.awaitingBind > 0) slot.awaitingBind -= 1;
    this.audit(`observed file=${file} awaiting=${slot.awaitingBind}`);
    if (slot.dirtyPending) {
      slot.dirtyPending = false;
      this.queueRescan(slot, "activate");
    }
    return () => this.unbind(slot, entry, sinks);
  }

  /** 释放一次装载引用（网关失败口/第二订阅丢弃 load 用）。最后引用离开且未绑定→槽关闭。 */
  release(file: string): void {
    const slot = this.slots.get(file);
    if (slot === undefined) return;
    const entry = slot.entry;
    if (entry === null) {
      if (slot.scanInFlight !== null) slot.releasePending = true; // 初扫在飞：完成即弃
      return;
    }
    if (entry.disposed || entry.state !== "active") return;
    if (slot.awaitingBind > 0) slot.awaitingBind -= 1;
    if (slot.awaitingBind === 0 && entry.sinks === null) {
      this.closeEntry(slot, entry, `released-unobserved file=${slot.file}`);
    }
  }

  private unbind(slot: FileSlot, entry: GenEntry, sinks: HistorySinks): void {
    if (slot.entry !== entry || entry.disposed) return; // 已换代/已失效：no-op
    entry.sinks?.delete(sinks);
    if (entry.sinks !== null && entry.sinks.size === 0) entry.sinks = null; // 末位解绑=未绑定
    if (slot.awaitingBind === 0 && entry.sinks === null) {
      this.closeEntry(slot, entry, `unobserved file=${slot.file}`);
    }
    // 引用未清：待配对的 load 还在——槽保留，后续 observe 绑定或 release 关闭
  }

  private slotNotice(slot: FileSlot): void {
    const e = slot.entry;
    if (e !== null && !e.disposed && e.state === "active") {
      if (e.sinks === null || slot.scanInFlight !== null) { slot.dirtyPending = true; return; } // 未绑定/扫描在飞：折待补扫
      this.queueRescan(slot, "notice");
      return;
    }
    if (slot.scanInFlight !== null) slot.dirtyPending = true; // 初扫在飞：折给完成后的跟进
  }

  /** 排队重扫（微任务合并）：未绑定/在飞一律不排（折 dirtyPending 由激活/完成侧收敛）。 */
  private queueRescan(slot: FileSlot, why: string): void {
    if (slot.rescanQueued) return;
    const e = slot.entry;
    if (e === null || e.disposed || e.state !== "active" || e.sinks === null) return;
    slot.rescanQueued = true;
    void Promise.resolve().then(async () => {
      slot.rescanQueued = false;
      await this.runRescan(slot, why);
    });
  }

  /** 单飞重扫：占用 scanInFlight；在飞期新通知折 dirtyPending，完成后恰一次跟进。 */
  private async runRescan(slot: FileSlot, why: string): Promise<void> {
    const entry = slot.entry;
    if (entry === null || entry.disposed || entry.state !== "active") return;
    if (slot.scanInFlight !== null) { slot.dirtyPending = true; return; } // 兜底（queueRescan 已挡并发）
    // 同 load：先注册后执行（rescanOnce 同步前缀里的 read 调用期间通知可折 dirty）
    const run = Promise.resolve().then(() => this.rescanOnce(slot, entry, why));
    slot.scanInFlight = run;
    try {
      await run;
    } finally {
      if (slot.scanInFlight === run) slot.scanInFlight = null;
      if (slot.dirtyPending && slot.entry !== null && !slot.entry.disposed && slot.entry.sinks !== null) {
        slot.dirtyPending = false;
        this.queueRescan(slot, "follow-up"); // 在飞期折叠的恰一次跟进
      }
    }
  }

  private async rescanOnce(slot: FileSlot, entry: GenEntry, why: string): Promise<void> {
    let read: { text: string; identity: string };
    try {
      read = await this.reader().read(entry.abs);
    } catch (e) {
      this.deliverUnavailable(slot, entry, unavailableReasonOf(e));
      return;
    }
    if (entry.disposed || entry.state !== "active") return; // 读期间失效/换代：丢弃（await 后复核）
    if (read.identity !== entry.identity) {
      this.deliverInvalidate(slot, entry, "replace");
      return;
    }
    const rows = this.projectSafely(read.text);
    if (rows === null) { this.deliverUnavailable(slot, entry, "unreadable"); return; }
    const digests = rows.map((r) => ({ locator: r.locator, digest: scanDigest(r) }));
    // 前缀判定：已观测位置任一（定位+原文摘要）变化→失效；纯变短→截短
    const common = Math.min(digests.length, entry.baseline.length);
    for (let i = 0; i < common; i++) {
      if (digests[i]?.locator !== entry.baseline[i]?.locator || digests[i]?.digest !== entry.baseline[i]?.digest) {
        this.deliverInvalidate(slot, entry, "rewrite");
        return;
      }
    }
    if (digests.length < entry.baseline.length) {
      this.deliverInvalidate(slot, entry, "truncate");
      return;
    }
    const appended = rows.length - entry.baseline.length;
    for (let i = entry.baseline.length; i < rows.length; i++) {
      const row = rows[i];
      if (row === undefined) continue;
      try {
        for (const sk of entry.sinks ?? []) {
          try { sk.onAppend(row); } catch (e) { this.audit(`append-cb-error file=${entry.file} kind=${errKind(e)}`); }
        }
      } catch (e) {
        this.audit(`append-cb-error file=${entry.file} kind=${errKind(e)}`);
      }
      entry.baselineRows.push(row);
      entry.baseline.push(digests[i] as { locator: string; digest: string });
    }
    this.audit(`rescan file=${entry.file} why=${why} rows=${rows.length} appended=${appended}`);
    // 重挂观察（fs.watch 对 rename 类事件可能失效——重叠换新关旧；失败→unavailable，R6 fail-closed）
    this.rearmWatcher(slot, entry);
  }

  /** 重叠换新观察：先建新再关旧（无窗口）；建立失败=不可用（不降级、不空转，R6）。 */
  private rearmWatcher(slot: FileSlot, entry: GenEntry): void {
    if (slot.entry !== entry || entry.disposed || entry.state !== "active") return;
    let fresh: { close(): void };
    try {
      fresh = this.watcherFactory().watch(entry.abs, () => this.slotNotice(slot), (e) => this.slotError(slot, e));
    } catch (e) {
      this.audit(`watch-rearm-failed file=${entry.file} kind=${errKind(e)}`);
      this.deliverUnavailable(slot, entry, "watch-failed");
      return;
    }
    entry.watchers.push(fresh);
    for (const w of entry.watchers.splice(0, entry.watchers.length - 1)) {
      try { w.close(); } catch { /* 已关 */ }
    }
  }

  /** watcher 错误：初扫期（entry 未提交）计入早期核账（装载 fail-closed）；活跃期先重叠挂新（关事件丢失窗口；失败→unavailable），再排重扫核实。 */
  private slotError(slot: FileSlot, err: unknown): void {
    if (slot.entry === null) { // 初扫期错误：不给可疑快照（提交后核账关停）
      slot.earlyWatchErrors += 1;
      this.audit(`watch-error-early file=${slot.file} kind=${errKind(err)}`);
      this.slotNotice(slot);
      return;
    }
    this.audit(`watch-error file=${slot.file} kind=${errKind(err)}`);
    const entry = slot.entry;
    if (entry === null || entry.disposed || entry.state !== "active") return;
    try {
      this.rearmWatcher(slot, entry);
    } catch {
      return; // rearm 失败已走 unavailable
    }
    if (slot.scanInFlight !== null) { slot.dirtyPending = true; return; } // 重扫在飞：折跟进
    this.queueRescan(slot, "watch-error");
  }

  /** 投影防御出口（R5）：投影器 bug/盘面异常不得逃逸成进程错误——防御失败=不可用（unreadable）。 */
  private projectSafely(text: string): ScanRow[] | null {
    try {
      return journalToScanRows(text);
    } catch (e) {
      this.audit(`project-failed kind=${errKind(e)}`);
      return null;
    }
  }

  private deliverInvalidate(slot: FileSlot, entry: GenEntry, reason: HistoryInvalidateReason): void {
    const sinks = [...entry.sinks ?? []]; // 先捕（closeEntry 会摘 sinks）
    this.closeEntry(slot, entry, `invalidate file=${entry.file} reason=${reason}`);
    this.audit(`invalidate file=${entry.file} reason=${reason}`);
    try {
      for (const sk of sinks) sk.onInvalidate?.(reason);
    } catch (e) {
      this.audit(`invalidate-cb-error file=${entry.file} kind=${errKind(e)}`);
    }
  }

  private deliverUnavailable(slot: FileSlot, entry: GenEntry, reason: HistoryUnavailableReason): void {
    const sinks = [...entry.sinks ?? []]; // 先捕（closeEntry 会摘 sinks）
    this.closeEntry(slot, entry, `unavailable file=${entry.file} reason=${reason}`);
    this.audit(`unavailable file=${entry.file} reason=${reason}`);
    try {
      for (const sk of sinks) sk.onUnavailable?.(reason);
    } catch (e) {
      this.audit(`unavailable-cb-error file=${entry.file} kind=${errKind(e)}`);
    }
  }

  /** 逻辑失效先行（摘登记+disposed/state+sinks），再关 OS watcher。 */
  private closeEntry(slot: FileSlot, entry: GenEntry, auditLine: string): void {
    if (slot.entry === entry) slot.entry = null;
    entry.disposed = true;
    entry.state = "closed";
    entry.sinks = null;
    const ws = entry.watchers.splice(0, entry.watchers.length);
    for (const w of ws) {
      try { w.close(); } catch { /* 已关 */ }
    }
    if (auditLine !== "") this.audit(auditLine);
  }
}

/** 错误归名（不拼宿主原始错误详情——审计行只放可稳定断言的类别）。 */
function errKind(e: unknown): string {
  if (e instanceof SafeOpenError) return e.kind;
  if (e instanceof Error) return e.name;
  return typeof e;
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
