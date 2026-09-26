// 3b-2a：真源 HistorySource（journal 面实现；契约=W1-04 端口+GPT 3b-0 §IV.E 冻结边界）。
// 3b2a-R1/R2 重构（GPT 3b2a 审读）：load/observe/release 共享扫描所有权——
//  ① 每文件一个 FileSlot；槽内最多一份在飞扫描（初扫/重扫共用，串行化）；在飞期间新通知折为
//    dirtyPending，完成后恰一次跟进（不再并发扫描，不再「旧扫描把纯追加误判 truncate」P2）。
//  ② load 加入语义：已有活跃代→返回基线快照副本并 awaitingBind+1（此后增长由 onAppend 补齐）；
//    初扫在飞→await 同一 promise（不再各自扫，P3/P4 双装载竞态根除）。
//  ③ 引用纪律：每次 load 解析=+1 引用；observe 消耗一引用并绑定 sinks；release 消耗一引用——
//    最后引用离开且未绑定时槽关闭（unobserve 同理）。网关纪律=每次 load 解析必配对 observe 或 release。
//  ④ 初扫=先建 watcher（同步失败→抛错→load=null，R6）；读→投影（防御出口）→提交 entry。
//    读期间错误进 earlyWatchErrors（提交后核账→watch-error-early 关闭）；读期间 release→
//    撤该参与者票据（结算返 null）；换代间隙到达→releaseCarry 结转由下一代吸收（3b2c-B1）。
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
  /** 文本→扫描行投影器（3b-2b②：session 子源注入 sessionToScanRows+归因；默认=journal 投影）。 */
  readonly projector?: (text: string, file: string) => Promise<readonly ScanRow[]> | readonly ScanRow[];
}

export const DEFAULT_MAX_SCAN_BYTES = 8 * 1024 * 1024;

/** 真盘读取：安全打开→有界读→同 fd 身份。任何失败抛 SafeOpenError（含 kind 分类）。 */
export class RealReader implements HistoryReaderPort {
  constructor(private readonly maxBytes: number) {}
  async read(absPath: string): Promise<{ text: string; identity: string }> {
    const { fh } = await openSafeFile(absPath);
    try {
      const [buf, st] = await Promise.all([readBounded(fh, this.maxBytes, absPath), fh.stat()]);
      // 3b2c-F1-05：合法性判据=字节级（非字符值）——完整前缀（末 \n 前）用 fatal UTF-8 解码：
      // 非法编码（0xff/0xfe/断裂多字节）拒；合法字符值（含真实用户输入的 U+FFFD=EF BF BD）放行
      // （旧判据「完整行含 U+FFFD 即拒」会误杀含该合法字符的整文件）。撕裂尾（末段无 \n）
      // lenient 解码容忍（本就不发布；补全后重读定位自然正确）。完整前缀字节↔字符串一一对应，
      // scanDigest 字符串比对保有字节级判等力（有损解码等价类仍封死）。
      const lastNl = buf.lastIndexOf(0x0a);
      const prefix = buf.subarray(0, lastNl + 1);
      const tail = buf.subarray(lastNl + 1);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(prefix);
      } catch {
        throw new SafeOpenError("read-failed", absPath, "invalid-utf8-complete-line");
      }
      if (tail.length > 0) text += new TextDecoder("utf-8").decode(tail);
      return { text, identity: `${st.dev}:${st.ino}` };
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
  /** 注册序（3b2e-C2）：每次 watcher 注册独立递增。 */
  regCounter: number;
  /** 当前有效注册（3b2e-C2）：rearm 重挂后旧句柄回调凭 reg 失效（同代亦然，GPT 3b2d D3/D15）。 */
  activeReg: number;
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
 *  awaitingBind：已返回快照但尚未配对（observe/release）的 load 引用数（跨代延续——
 *    旧代未配对引用不因换代失效，也不取消新装载，3b2c-B1/N6）。
 *  earlyWatchErrors：仅当次初扫有效（初扫启动清零——上一代错误不污染下一代，3b2c-B1/N2）。
 *  releaseCarry：换代间隙到达的 release 结转数——无 entry 可扣、无在飞票据可撤时记账，
 *    由下一代成功 load 的计数增量吸收（网关每 load 恰一次结算 ⇒ 总量守恒；新代装载
 *    不被旧 release 杀死，3b2c-B1/N6）。
 *  pendingEntry：初扫在飞期间的待提交代——观察回调的**身份票据**（3b2c-B2）：回调携带
 *    entry 本体，slot.pendingEntry/slot.entry 任一不匹配即丢弃（旧代原始 notice/error
 *    不得驱动/杀伤新代，GPT 3b2b N3/N4）。
 *  pendingTickets：在飞初扫参与者票据集（load 取票/成功结算/失败自动撤销/release 撤票）。
 */
/** 装载票据（3b2c-B1）：在飞初扫的每个 load 参与者各持一票；release 先撤票据
 *  （该 load 结算时返回 null），不再用布尔/计数跨代猜测。 */
interface LoadTicket {
  released: boolean;
}

interface FileSlot {
  readonly file: string;
  abs: string;
  entry: GenEntry | null;
  pendingEntry: GenEntry | null;
  scanInFlight: Promise<boolean> | Promise<void> | null;
  dirtyPending: boolean;
  rescanQueued: boolean;
  earlyWatchErrors: number;
  awaitingBind: number;
  pendingTickets: Set<LoadTicket>;
  releaseCarry: number;
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
    const abs = resolveWithinRoots(this.opts.journalFor !== undefined ? this.opts.journalFor(file) : file, this.opts.roots);    if (abs === null) {
      this.audit(`load-rejected file=${file} reason=outside-roots`);
      return null;
    }
    let slot = this.slots.get(file);
    if (slot === undefined) {
      slot = { file, abs, entry: null, pendingEntry: null, scanInFlight: null, dirtyPending: false, rescanQueued: false, earlyWatchErrors: 0, awaitingBind: 0, pendingTickets: new Set(), releaseCarry: 0 };
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
      this.takeHeldCount(slot);
      this.audit(`load-joined file=${file} rows=${active.baselineRows.length} awaiting=${slot.awaitingBind}`);
      return [...active.baselineRows];
    }
    if (slot.scanInFlight !== null) {
      // 加入在飞初扫：取票（3b2c-B1）——release 到达先撤票；失败自动销票
      const ticket: LoadTicket = { released: false };
      slot.pendingTickets.add(ticket);
      const ok = await slot.scanInFlight;
      slot.pendingTickets.delete(ticket);
      if (!ok || ticket.released) { this.maybeReapSlot(slot); return null; } // 票据被撤=fail-closed，不再计数
      const e = slot.entry;
      if (e === null || e.disposed) return null; // 提交后立被弃（全撤/早期错误）→fail-closed
      this.takeHeldCount(slot);
      this.audit(`load-joined-after-scan file=${file} rows=${e.baselineRows.length}`);
      return [...e.baselineRows];
    }
    // 初扫：注册先于执行（微任务推迟扫描体——watch 建立/读调用都在 scanInFlight 赋值之后，
    // 读期间通知才有 dirty 可折；迟到的 load 走上面的单飞分支）
    const ticket: LoadTicket = { released: false };
    slot.pendingTickets.add(ticket);
    const run = Promise.resolve().then(() => this.initialScan(slot));
    slot.scanInFlight = run;
    let ok: boolean;
    try {
      ok = await run;
    } finally {
      if (slot.scanInFlight === run) slot.scanInFlight = null;
    }
    slot.pendingTickets.delete(ticket);
    if (!ok || ticket.released) { this.maybeReapSlot(slot); return null; }
    const e = slot.entry;
    if (e === null || e.disposed) { this.maybeReapSlot(slot); return null; }
    this.takeHeldCount(slot);
    this.audit(`load-committed file=${file} rows=${e.baselineRows.length} awaiting=${slot.awaitingBind}`);
    return [...e.baselineRows];
  }

  /** 成功结算取引用计数：releaseCarry 优先吸收（换代间隙结转的 release——总量守恒，
   *  3b2c-B1/N6）；吸收后无人要且未绑定→关闭（不留无主 watcher）。 */
  private takeHeldCount(slot: FileSlot): void {
    if (slot.releaseCarry > 0) {
      slot.releaseCarry -= 1;
      const e = slot.entry;
      const wants = [...slot.pendingTickets].some((t) => !t.released); // 仍有未撤在飞参与者：不关
      if (!wants && slot.releaseCarry === 0 && slot.awaitingBind === 0 && e !== null && !e.disposed && e.state === "active" && e.sinks === null) {
        this.closeEntry(slot, e, `released-unobserved-carry file=${slot.file}`);
      }
      return;
    }
    slot.awaitingBind += 1;
  }

  /** 建立一次观察注册（3b2e-C2）：每次注册独立 reg 身份，activeReg 先于 watch() 生效——
   *  rearm/重挂后旧句柄闭包（旧 reg）在 genNotice/genError 被 reg 门拒绝（同代亦然）。
   *  3b2g-R2（GPT 3b2f F4/F5）：watch() 返回后复核注册身份——watch 建立期间可同步
   *  回调 onError 驱动嵌套 rearm（新注册取代本注册或已关代）：旧返回句柄立即关闭、返 null，
   *  调用方不得推送为最新/关真正的断注册（旧代码：嵌套失败→孤儿句柄推入已关代；嵌套成功→外层 splice 关掉新句柄）。 */
  private registerWatch(abs: string, slot: FileSlot, entry: GenEntry): { close(): void } | null {
    const reg = ++entry.regCounter;
    entry.activeReg = reg;
    const handle = this.watcherFactory().watch(
      abs,
      () => this.genNotice(slot, entry, reg),
      (e) => this.genError(slot, entry, e, reg),
    );
    if (
      reg !== entry.activeReg || // 嵌套注册已取代本注册（新句柄才是最新）
      (slot.entry !== entry && slot.pendingEntry !== entry) || // 代已提交/在飞均不属于本注册（初扫期身份锚=pendingEntry）
      entry.disposed || entry.state !== "active" // 代已死
    ) {
      try { handle.close(); } catch { /* 已关 */ }
      return null;
    }
    return handle;
  }

  /** 初扫（在 scanInFlight 内运行）：先建 watcher→读→投影防御→提交。任何失败→false（load=null）。 */
  private async initialScan(slot: FileSlot): Promise<boolean> {
    const { file, abs } = slot;
    slot.earlyWatchErrors = 0; // B1/N2：每次初扫清零——上一代错误不污染本代（D1：合法旧 held 引用保槽时本行为必要防线）
    slot.dirtyPending = false; // C1/D14（3b2e）：失败代折叠的 dirty 不跨入新初扫——新代无 notice 不得多读
    // 3b2c-B2：观察票据=entry 本体（提交前由 slot.pendingEntry 认领；回调不捕获 slot 现态）
    const entry: GenEntry = {
      file, abs, disposed: false, state: "active",
      identity: "",
      baseline: [],
      baselineRows: [],
      watchers: [],
      sinks: null,
      regCounter: 0,
      activeReg: 0,
    };
    slot.pendingEntry = entry;
    let handle: { close(): void } | null;
    try {
      handle = this.registerWatch(abs, slot, entry);
      if (handle === null) { // R2：注册期间被取代/已关（防御——初扫期无嵌套 rearm，恒不达）
        slot.pendingEntry = null;
        this.audit(`watch-setup-superseded file=${file}`);
        return false;
      }
      entry.watchers.push(handle);
    } catch (e) {
      slot.pendingEntry = null;
      this.audit(`watch-setup-failed file=${file} kind=${errKind(e)}`);
      return false;
    }
    let read: { text: string; identity: string };
    try {
      read = await this.reader().read(abs);
    } catch (e) {
      slot.pendingEntry = null;
      try { handle.close(); } catch { /* 已关 */ }
      this.audit(`load-read-failed file=${file} kind=${errKind(e)}`);
      return false;
    }
    if (slot.pendingEntry !== entry) { // 读期间已被取代（防御——scanInFlight 单飞下理论不可达）
      try { handle.close(); } catch { /* 已关 */ }
      this.audit(`initial-scan-superseded file=${file}`);
      return false;
    }
    const rows = await this.projectSafely(read.text, slot.file);
    if (rows === null) {
      slot.pendingEntry = null;
      try { handle.close(); } catch { /* 已关 */ }
      return false; // project-failed 已审计
    }
    entry.identity = read.identity;
    entry.baseline = rows.map((r) => ({ locator: r.locator, digest: scanDigest(r) }));
    entry.baselineRows = [...rows];
    slot.pendingEntry = null;
    slot.entry = entry; // 提交（无 await 间隙——本行到核账之间是同步的）
    let wantsIt = false;
    for (const t of slot.pendingTickets) { // 票据账（B1/N1）：全部被撤=装载即弃
      if (!t.released) { wantsIt = true; break; }
    }
    if (!wantsIt) {
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

  /** 3b2b-R1：当前活跃代基线行副本（无引用副作用）——DualHistorySource 装载等待窗后的复核面。
   *  无活跃代（槽未建/已失效/已淘汰）=null；副本语义=调用方持快照，后续追加不影响已取值。 */
  currentRows(file: string): readonly ScanRow[] | null {
    const slot = this.slots.get(file);
    const entry = slot?.entry ?? null;
    if (slot === undefined || entry === null || entry.disposed || entry.state !== "active") return null;
    return [...entry.baselineRows];
  }

  /** 释放一次装载引用（网关失败口/第二订阅丢弃 load 用）。最后引用离开且未绑定→槽关闭。 */
  release(file: string): void {
    const slot = this.slots.get(file);
    if (slot === undefined) return;
    // 结算序（3b2c-B1）：① 已提交计数（跨代延续——旧代未配对引用先结算，B1/N6：
    //    A 死后 C 的 release 扣 C 的计数，不撤 B 的在飞票、不结转）→ ② 在飞票据
    //    （结算对象=在飞 load 本身；多参与者 FIFO 定序——网关单订阅场景在飞参与者
    //    恒 ≤1，歧义退化不存在）→ ③ 结转下一代（releaseCarry：重复/迟到结算吸收，
    //    总量守恒，新代装载不被杀）。
    if (slot.awaitingBind > 0) {
      slot.awaitingBind -= 1;
      const entry = slot.entry;
      if (slot.awaitingBind === 0 && entry !== null && !entry.disposed && entry.state === "active" && entry.sinks === null) {
        this.closeEntry(slot, entry, `released-unobserved file=${slot.file}`);
      }
      this.maybeReapSlot(slot);
      return;
    }
    for (const t of slot.pendingTickets) {
      if (!t.released) {
        t.released = true;
        this.audit(`release-pending file=${slot.file}`);
        return;
      }
    }
    slot.releaseCarry += 1;
    this.audit(`release-carry file=${slot.file} carry=${slot.releaseCarry}`);
    this.maybeReapSlot(slot);
  }

  /** 槽静默回收（3b2c-B1）：完全静止（无代/无在飞/无票/无结转）时移除槽——
   *  退役槽不留 Map（有界回收；下次 load 全新建槽=零状态继承）。
   *  3b2g-R1（GPT 3b2f F10）：删除前验证 Map 中槽对象身份——审计回调可在两次回收间
   *  重入 load 建新槽，按文件名盲删会删掉后继槽（新 load 失去登记无法 observe/释放）；
   *  身份不匹配=本槽已被回收过或已被新槽取代，幂等 no-op 不审计不宣称删除。 */
  private maybeReapSlot(slot: FileSlot): void {
    if (
      slot.entry !== null || slot.pendingEntry !== null || slot.scanInFlight !== null ||
      slot.pendingTickets.size > 0 || slot.releaseCarry > 0 || slot.awaitingBind > 0
    ) return;
    if (this.slots.get(slot.file) !== slot) return; // R1：Map 身份门——只删自己的槽
    this.slots.delete(slot.file);
    this.audit(`slot-reaped file=${slot.file}`);
  }

  private unbind(slot: FileSlot, entry: GenEntry, sinks: HistorySinks): void {
    if (slot.entry !== entry || entry.disposed) return; // 已换代/已失效：no-op
    entry.sinks?.delete(sinks);
    if (entry.sinks !== null && entry.sinks.size === 0) entry.sinks = null; // 末位解绑=未绑定
    if (slot.awaitingBind === 0 && entry.sinks === null) {
      this.closeEntry(slot, entry, `unobserved file=${slot.file}`);
    }
    this.maybeReapSlot(slot);
    // 引用未清：待配对的 load 还在——槽保留，后续 observe 绑定或 release 关闭
  }

  /** 观察通知（票据=entry 本体，3b2c-B2）：初扫期（pendingEntry===entry）折 dirty；
   *  提交期（slot.entry===entry 且活跃）按绑定态推进；其余=旧代票据，丢弃。
   *  原始回调直调（绕过句柄 close 门）同样被本身份门挡下——GPT 3b2b N4。
   *  C2（3b2e/GPT 3b2d D15）：提交期另验 reg——同代 rearm 后的退役句柄（旧注册闭包）
   *  不得驱动读（不依赖句柄 close 门，端口边界迟到旧通知即拒）。 */
  private genNotice(slot: FileSlot, entry: GenEntry, reg: number): void {
    if (slot.pendingEntry === entry) {
      slot.dirtyPending = true; // 本代初扫在飞：折给完成后的跟进
      return;
    }
    if (slot.entry !== entry || entry.disposed || entry.state !== "active") return; // 旧代票据：丢弃
    if (reg !== entry.activeReg) { this.audit(`notice-stale-reg-dropped file=${slot.file}`); return; } // 同代退役注册：丢弃
    if (entry.sinks === null || slot.scanInFlight !== null) { slot.dirtyPending = true; return; } // 未绑定/扫描在飞：折待补扫
    this.queueRescan(slot, "notice");
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
      this.maybeReapSlot(slot); // C1/D2（3b2e）：在飞重扫曾挡住 unbind/release 侧回收——重扫终了的身份安全收尾点补收（静止槽不滞留 Map）
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
    if (entry.disposed || entry.state !== "active" || slot.entry !== entry) return; // 读期间失效/换代：丢弃（await 后复核）
    if (read.identity !== entry.identity) {
      this.deliverInvalidate(slot, entry, "replace");
      return;
    }
    const rows = await this.projectSafely(read.text, slot.file);
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
    let fresh: { close(): void } | null;
    try {
      fresh = this.registerWatch(entry.abs, slot, entry);
    } catch (e) {
      this.audit(`watch-rearm-failed file=${entry.file} kind=${errKind(e)}`);
      this.deliverUnavailable(slot, entry, "watch-failed");
      return;
    }
    if (fresh === null) { // R2：嵌套注册已接管（或代已关）——新句柄归嵌套所有，不推送不 splice
      this.audit(`watch-rearm-superseded file=${entry.file}`);
      return;
    }
    entry.watchers.push(fresh);
    for (const w of entry.watchers.splice(0, entry.watchers.length - 1)) {
      try { w.close(); } catch { /* 已关 */ }
    }
  }

  /** watcher 错误：初扫期（entry 未提交）计入早期核账（装载 fail-closed）；活跃期先重叠挂新（关事件丢失窗口；失败→unavailable），再排重扫核实。 */
  /** 观察错误（票据=entry 本体，3b2c-B2/N3）：初扫期计入本代核账；活跃期重叠挂新；
   *  旧代票据直调（绕过句柄 close 门）丢弃——不得杀伤新代。 */
  private genError(slot: FileSlot, entry: GenEntry, err: unknown, reg: number): void {
    if (slot.pendingEntry === entry) { // 本代初扫期错误：不给可疑快照（提交后核账关停）
      slot.earlyWatchErrors += 1;
      this.audit(`watch-error-early file=${slot.file} kind=${errKind(err)}`);
      slot.dirtyPending = true;
      return;
    }
    if (slot.entry !== entry || entry.disposed || entry.state !== "active") {
      this.audit(`watch-error-stale-dropped file=${slot.file} kind=${errKind(err)}`); // 旧代票据：丢弃（N3）
      return;
    }
    if (reg !== entry.activeReg) { // C2（3b2e/GPT 3b2d D3）：同代退役注册——不得驱动 rearm 杀当前观察
      this.audit(`watch-error-stale-reg-dropped file=${slot.file} kind=${errKind(err)}`);
      return;
    }
    this.audit(`watch-error file=${slot.file} kind=${errKind(err)}`);
    try {
      this.rearmWatcher(slot, entry);
    } catch {
      return; // rearm 失败已走 unavailable
    }
    if (slot.scanInFlight !== null) { slot.dirtyPending = true; return; } // 重扫在飞：折跟进
    this.queueRescan(slot, "watch-error");
  }

  /** 投影防御出口（R5）：投影器 bug/盘面异常不得逃逸成进程错误——防御失败=不可用（unreadable）。 */
  private async projectSafely(text: string, file: string): Promise<ScanRow[] | null> {
    try {
      const rows = await (this.opts.projector ? this.opts.projector(text, file) : journalToScanRows(text));
      return [...rows];
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
    this.maybeReapSlot(slot);
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
