// 3b-2b②：双源 HistorySource 组合器（journal+session → 单一 HistorySourcePort 面）。
// 组合语义（PROJECT 3b-2b 冻结案②）：
// ① load：先 journal 子源（事实源）后 session 子源；行合并=journal 全部在前、session 全部在后
//    （确定性——continueFrom 增量续编与全量重扫固定源序一致）。journal 失败→整体 null（4402）；
//    session 失败/缺映射→journal-only 降级+审计（session 快照缺席是可呈现的诚实缺面，不阻断）。
// ② session 投影归因：session 子源 projector 在扫描时**现读 journal 盘面**派生 enqueue 三元组与
//    consumed 区间（journalAttributionOf）——完整行前缀即耐久事实；撕裂尾天然不参与（匹配语义
//    正确：user 条目只能匹配已完整落盘的 enqueue）。journal 读失败→归因缺证（intentId=null）+审计，
//    不让 session 面因 journal 读故障整体失败（两源可用性独立，降级有序）。
// ③ observe/release：双子源配对转发；**journal=事实源——其绑定失败=整组失败**（3b2b-R1b：
//    不得被 session 成功掩盖——否则观察退化为 session-only，违反 fail-closed）。文件级观察状态
//    记录 sinks 与两源实际绑定（3b2b-R2）：journal-only 降级后恢复双源时，load 侧补接 session
//    子源观察（同一 sinks），后到事实不再漏发。
// ④ session 路径由宿主 sessionFor 提供（无默认映射——pi 会话目录是宿主配置而非约定）；
//    未提供=journal-only 模式（每 load 审计一次）。
// 3b2b-R1：组合装载跨 await 复核 journal——session 读等待窗内 journal 可能增长（吸收）/换代
//   （有界重装）/映射抛错（精确回滚已取得引用）；旧副本不得回滚索引或绕过事实源失效。
import type { ScanRow } from "@pi-agent-ui/protocol";
import { journalAttributionOf, scanDigest, sessionToScanRows } from "@pi-agent-ui/protocol";
import { resolveWithinRoots } from "../ws/safe-open.ts";
import { DEFAULT_MAX_SCAN_BYTES, FileHistorySource, RealReader, type HistoryReaderPort, type HistoryWatcherPort } from "./history-source.ts";
import type { HistorySinks, HistorySourcePort } from "../ws/ws-gateway.ts";

export interface DualHistorySourceOpts {
  readonly roots: readonly string[];
  /** session 文件允许的根（pi 会话目录常在 journal roots 之外；默认=roots）。 */
  readonly sessionRoots?: readonly string[];
  /** 逻辑 file → journal 路径（默认=同路径，透传给 journal 子源）。 */
  readonly journalFor?: (file: string) => string;
  /** 逻辑 file → session 路径；未提供=journal-only 模式。 */
  readonly sessionFor?: (file: string) => string;
  readonly reader?: HistoryReaderPort;
  readonly watcher?: HistoryWatcherPort;
  readonly maxScanBytes?: number;
  readonly audit?: (line: string) => void;
}

/** 3b2b-R1：装载重试上限（等待窗内 journal 换代/改写的有界重装；超出=fail-closed null）。 */
const LOAD_ATTEMPTS = 3;

/** 3b2b-R1：装载等待窗后的 journal 复核——旧副本是否仍是当前代的合法前缀。 */
function journalStale(prev: readonly ScanRow[], cur: readonly ScanRow[]): boolean {
  if (cur.length < prev.length) return true; // 等待窗内行数反而变少=旧代副本对不上新盘面
  for (let i = 0; i < prev.length; i++) {
    const a = prev[i], b = cur[i];
    if (a === undefined || b === undefined) return true;
    if (a.locator !== b.locator) return true;
    if (scanDigest(a) !== scanDigest(b)) return true; // 同位改写（含换代后同长度）→旧代作废
  }
  return false;
}

/** 文件级观察状态（3b2b-R2）：记录 sinks 与两源实际绑定闭包——降级恢复时补接 session。 */
interface ObsState {
  sinks: HistorySinks | null;
  unJ: (() => void) | null;
  unS: (() => void) | null;
  closed: boolean;
}

/** 双源组合器：对外=单一 HistorySourcePort（网关不变）；对内=两个 FileHistorySource 子源。 */
export class DualHistorySource implements HistorySourcePort {
  private readonly journalSrc: FileHistorySource;
  private readonly sessionSrc: FileHistorySource | null;
  private readonly obs = new Map<string, ObsState>();

  constructor(private readonly opts: DualHistorySourceOpts) {
    this.journalSrc = new FileHistorySource({
      roots: opts.roots,
      ...(opts.journalFor === undefined ? {} : { journalFor: opts.journalFor }),
      ...(opts.reader === undefined ? {} : { reader: opts.reader }),
      ...(opts.watcher === undefined ? {} : { watcher: opts.watcher }),
      ...(opts.maxScanBytes === undefined ? {} : { maxScanBytes: opts.maxScanBytes }),
      audit: (line) => this.audit(`journal-sub ${line}`),
    });
    if (opts.sessionFor === undefined) {
      this.sessionSrc = null;
    } else {
      const journalFor = opts.journalFor;
      const sessionFor = opts.sessionFor;
      const readAttribution = this.readJournalAttribution.bind(this);
      this.sessionSrc = new FileHistorySource({
        roots: opts.sessionRoots ?? opts.roots,
        // session 子源的路径映射=sessionFor（键恒为**逻辑 file**——projector 拿到的 file 才能经
        // journal 子源的 journalFor 还原 journal 盘面路径做归因）
        journalFor: sessionFor,
        ...(opts.reader === undefined ? {} : { reader: opts.reader }),
        ...(opts.watcher === undefined ? {} : { watcher: opts.watcher }),
        ...(opts.maxScanBytes === undefined ? {} : { maxScanBytes: opts.maxScanBytes }),
        audit: (line) => this.audit(`session-sub ${line}`),
        projector: async (sessionText, file) => {
          // 归因键=该 session 快照所属逻辑 file 的 journal 盘面（journalFor 缺省=同路径）
          const journalPath = journalFor !== undefined ? journalFor(file) : file;
          const { enqueues, consumed } = await readAttribution(journalPath);
          return sessionToScanRows({ sessionText, enqueues, consumed });
        },
      });
    }
  }

  private audit(line: string): void {
    try { this.opts.audit?.(`${Date.now()} dual-history ${line}`); } catch { /* 审计不阻断 */ }
  }

  /** journal 归因现读：安全路径解析+有界读；失败→空归因（缺证降级，session 投影 intentId=null）。 */
  /** 归因读通道：注入 reader 或真盘默认（无注入≠无归因——双源默认装配下归因仍成立）。 */
  private get attributionReader(): HistoryReaderPort {
    return this.opts.reader ?? new RealReader(this.opts.maxScanBytes ?? DEFAULT_MAX_SCAN_BYTES);
  }

  private async readJournalAttribution(journalPath: string): Promise<ReturnType<typeof journalAttributionOf>> {
    const reader = this.attributionReader;
    const abs = resolveWithinRoots(journalPath, this.opts.roots);
    if (abs === null) {
      this.audit(`attribution-rejected path=${journalPath} reason=outside-roots`);
      return { enqueues: [], consumed: [], rejected: 0 };
    }
    try {
      const { text } = await reader.read(abs);
      const r = journalAttributionOf(text);
      if (r.rejected > 0) this.audit(`attribution-schema-rejected path=${journalPath} count=${r.rejected}`); // 3b2b-R3：坏行不采信，可观测
      return r;
    } catch (e) {
      this.audit(`attribution-unreadable path=${journalPath} kind=${e instanceof Error ? e.constructor.name : "unknown"}`);
      return { enqueues: [], consumed: [], rejected: 0 };
    }
  }

  async load(file: string): Promise<readonly ScanRow[] | null> {
    if (this.sessionSrc === null || this.opts.sessionFor === undefined) {
      const jrows = await this.journalSrc.load(file);
      if (jrows === null) return null;
      this.audit(`journal-only file=${file} reason=no-session-mapping`);
      return jrows;
    }
    for (let attempt = 1; attempt <= LOAD_ATTEMPTS; attempt++) {
      const jrows = await this.journalSrc.load(file); // journal 引用（+1）——成功路径由 observe/release 配对
      if (jrows === null) return null; // journal=事实源：失败整体 fail-closed
      let srows: readonly ScanRow[] | null;
      try {
        srows = await this.sessionSrc.load(file); // 键=逻辑 file（session 子源内部经 sessionFor 映射路径）
      } catch (e) {
        // 3b2b-R1：sessionFor 同步抛错等——journal 引用已取得，必须精确回滚（不留无主 watcher）
        this.journalSrc.release(file);
        this.audit(`session-load-threw file=${file} attempt=${attempt}`);
        throw e;
      }
      if (srows === null) {
        this.audit(`session-missing file=${file} attempt=${attempt}`); // journal-only 降级（可呈现缺面）
        return jrows;
      }
      // 3b2b-R1：等待窗复核——journal 代次/水位已变则旧副本作废，有界重装（不能拿旧快照回滚索引）
      const cur = this.journalSrc.currentRows(file);
      if (cur === null || journalStale(jrows, cur)) {
        this.journalSrc.release(file);
        this.sessionSrc.release(file);
        this.audit(`load-revalidate file=${file} attempt=${attempt} kind=${cur === null ? "journal-generation-lost" : "journal-prefix-stale"}`);
        continue;
      }
      this.attachSessionIfObserved(file); // 3b2b-R2：journal-only→双源恢复：补接 session 观察
      return [...cur, ...srows]; // cur=当前代最新基线（吸收等待窗内的合法增长）
    }
    this.audit(`load-revalidate-exhausted file=${file}`);
    return null; // 有界重装仍不稳定=fail-closed（4402）
  }

  /** 3b2b-R2：journal-only 降级后恢复双源——若观察仍在且 session 未绑定，补接（同一 sinks）。 */
  private attachSessionIfObserved(file: string): void {
    const st = this.obs.get(file);
    if (st === undefined || st.closed || st.sinks === null || st.unS !== null) return;
    if (this.sessionSrc === null || this.opts.sessionFor === undefined) return;
    const unS = this.sessionSrc.observe?.(file, st.sinks) ?? null;
    if (unS !== null) {
      st.unS = unS;
      this.audit(`session-attached-late file=${file}`);
    }
  }

  observe(file: string, sinks: HistorySinks): (() => void) | null {
    const unJ = this.journalSrc.observe?.(file, sinks) ?? null;
    if (unJ === null) return null; // 3b2b-R1b：journal=事实源——绑定失败=整组失败（不透 session-only 观察）
    if (this.sessionSrc === null || this.opts.sessionFor === undefined) return unJ;
    const unS = this.sessionSrc.observe?.(file, sinks) ?? null; // session 尽力（缺文件→null，恢复时补接）
    const priorSt = this.obs.get(file);
    if (priorSt !== undefined && !priorSt.closed) {
      // 防御：旧联合 stop 未被调用（网关侧泄漏）——先收口旧绑定再建新
      try { priorSt.unJ?.(); } catch { /* 解绑不抛 */ }
      try { priorSt.unS?.(); } catch { /* 解绑不抛 */ }
    }
    const st: ObsState = { sinks, unJ, unS, closed: false };
    this.obs.set(file, st);
    return () => {
      if (st.closed) return;
      st.closed = true;
      st.sinks = null;
      try { st.unJ?.(); } catch { /* 解绑不抛 */ }
      try { st.unS?.(); } catch { /* 解绑不抛 */ }
      st.unJ = null;
      st.unS = null;
    };
  }

  release(file: string): void {
    this.journalSrc.release?.(file);
    if (this.sessionSrc !== null && this.opts.sessionFor !== undefined) {
      this.sessionSrc.release?.(file);
    }
  }
}
