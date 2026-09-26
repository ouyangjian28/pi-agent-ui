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
  file: string;
  sinks: HistorySinks | null;
  unJ: (() => void) | null;
  unS: (() => void) | null;
  closed: boolean;
}

/** 3b2c-F2-02：注册级转发包装（observe 与晚附共用同构）——每次绑定独立对象身份，
 *  子源 Set 按身份增删；exactOptionalPropertyTypes 下可选方法条件展开。 */
function wrapSinks(sinks: HistorySinks): HistorySinks {
  return {
    onAppend: (row) => sinks.onAppend(row),
    ...(sinks.onInvalidate !== undefined ? { onInvalidate: (r) => sinks.onInvalidate?.(r) } : {}),
    ...(sinks.onUnavailable !== undefined ? { onUnavailable: (r) => sinks.onUnavailable?.(r) } : {}),
    onLive: (ev) => sinks.onLive(ev),
    onStatus: (s) => sinks.onStatus(s),
  };
}

/** 双源组合器：对外=单一 HistorySourcePort（网关不变）；对内=两个 FileHistorySource 子源。 */
export class DualHistorySource implements HistorySourcePort {
  private readonly journalSrc: FileHistorySource;
  private readonly sessionSrc: FileHistorySource | null;
  /** 3b2c-F2-02：观察登记=多注册模型（file→活跃注册列表）。每个成功 observe()=一条独立注册
   *  （独立 wrap+独立 stop），并行注册=并行交付；旧 stop 迟到只关自己的注册（closed 幂等+身份门
   *  splice）。旧单条 Map 会「后注册覆盖前注册」→最新 stop 后旧注册失活但仍占观察→恢复晚附找不到
   *  入口（丢 session 事件）。 */
  private readonly obs = new Map<string, ObsState[]>();

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
      // 3b2c-F1-01：等待窗复核=**共同出口**（session 成功与 null 降级都在此复核）——旧代码
      // 只在成功侧复核，null 侧返 jrows 旧快照→网关误判改写 4409+等待窗内已发布行丢失。
      const cur = this.journalSrc.currentRows(file);
      if (cur === null || journalStale(jrows, cur)) {
        this.journalSrc.release(file);
        if (srows !== null) this.sessionSrc.release(file);
        this.audit(`load-revalidate file=${file} attempt=${attempt} kind=${cur === null ? "journal-generation-lost" : "journal-prefix-stale"} session=${srows !== null ? "held" : "null"}`);
        continue;
      }
      if (srows === null) {
        this.audit(`session-missing file=${file} attempt=${attempt}`); // journal-only 降级（可呈现缺面）
        return cur; // 当前基线（吸收等待窗增长；session 不可读→补接必 null，不越附）
      }
      this.attachSessionIfObserved(file); // 3b2b-R2：journal-only→双源恢复：补接 session 观察
      return [...cur, ...srows]; // cur=当前代最新基线（吸收等待窗内的合法增长）
    }
    this.audit(`load-revalidate-exhausted file=${file}`);
    return null; // 有界重装仍不稳定=fail-closed（4402）
  }

  /** 3b2c-F3-01/F3-02：晚附给**全部**活跃且未绑 session 的注册各配独立 wrap（与 observe 同构）。
   *  统一走**免扣绑定**（consumeLoadRef:false）——晚附只建立观察，不消耗任何装载方的
   *  待结算引用；引用守恒收敛为单一账本：每次成功 load 的引用只由装载方自己的
   *  observe/release 结算（F2 的 credit 补记账删除——两本互不知情的账正是 F3-01/02 的根因）。 */
  private attachSessionIfObserved(file: string): void {
    if (this.sessionSrc === null || this.opts.sessionFor === undefined) return;
    const regs = this.obs.get(file);
    if (regs === undefined) return;
    let attached = 0;
    for (const st of regs) {
      if (st.closed || st.sinks === null || st.unS !== null) continue;
      const wrap = wrapSinks(st.sinks);
      const unS = this.sessionSrc.observe?.(file, wrap, { consumeLoadRef: false }) ?? null;
      if (unS !== null) {
        st.unS = unS;
        attached++;
      }
    }
    if (attached > 0) {
      this.audit(`session-attached-late file=${file} regs=${attached}`);
    }
  }

  observe(file: string, sinks: HistorySinks): (() => void) | null {
    // 3b2c-F1-04/F2-02：每次绑定用独立转发包装（对象身份隔离）——子源 Set 按对象身份增删：
    // 同一 sinks 对象重绑时旧解绑删旧包装、新解绑删新包装，互不误删（旧代码直接传 sinks，
    // 同对象重绑=旧 stop 删掉新绑定，返回已失效的成功 stop）。
    const wrap = wrapSinks(sinks);
    const unJ = this.journalSrc.observe?.(file, wrap) ?? null;
    if (unJ === null) return null; // 3b2b-R1b：journal=事实源——绑定失败=整组失败（不透 session-only 观察）
    let unS: (() => void) | null = null;
    if (this.sessionSrc !== null && this.opts.sessionFor !== undefined) {
      unS = this.sessionSrc.observe?.(file, wrap) ?? null; // session 尽力（缺文件→null，恢复时补接）
    }
    const st: ObsState = { file, sinks, unJ, unS, closed: false };
    const regs = this.obs.get(file) ?? [];
    regs.push(st);
    this.obs.set(file, regs);
    return () => this.closeObsState(st);
  }

  /** 幂等收口一次联合观察（3b2c-F1-04/Y1/F2-02）：身份门——旧 stop 迟到只关自己的注册（closed
   *  幂等），不作用其他注册；按身份从注册列表 splice（列表空则删键，状态壳不永久滞留）。 */
  private closeObsState(st: ObsState): void {
    if (st.closed) return;
    st.closed = true;
    st.sinks = null;
    try { st.unJ?.(); } catch { /* 解绑不抛 */ }
    try { st.unS?.(); } catch { /* 解绑不抛 */ }
    st.unJ = null;
    st.unS = null;
    const regs = this.obs.get(st.file);
    if (regs === undefined) return;
    const i = regs.indexOf(st);
    if (i !== -1) {
      regs.splice(i, 1);
      if (regs.length === 0) this.obs.delete(st.file);
    }
  }

  release(file: string): void {
    // 3b2c-F3-01/F3-02：引用守恒=单一账本——晚附已改免扣绑定，装载方的 release 直接
    // 配对结算自己的两源引用，无需 credit 补记账（删除后 F3-01 双扣与 F3-02 carry 两条路径一并消失）。
    this.journalSrc.release?.(file);
    if (this.sessionSrc !== null && this.opts.sessionFor !== undefined) {
      this.sessionSrc.release?.(file);
    }
  }

  /** 3b-3⑤：两源整文件指纹（信息性元数据——契约 §1.3 变更检测触发器，供网关审计/诊断）。
   *  journal 无活跃代→null；journal-only（session 未装载/无映射）→session=""。 */
  fingerprints(file: string): { journal: string; session: string } | null {
    const jfp = this.journalSrc.currentFingerprint(file);
    if (jfp === null) return null;
    if (this.sessionSrc === null || this.opts.sessionFor === undefined) return { journal: jfp, session: "" };
    // session 子源槽以**逻辑 file** 键控（journalFor=路径映射器，非槽键——3b-2b② 冻结）
    const sfp = this.sessionSrc.currentFingerprint(file);
    return { journal: jfp, session: sfp ?? "" };
  }
}
