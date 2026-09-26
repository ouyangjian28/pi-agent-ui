// 3b-2b②：双源 HistorySource 组合器（journal+session → 单一 HistorySourcePort 面）。
// 组合语义（PROJECT 3b-2b 冻结案②）：
// ① load：先 journal 子源（事实源）后 session 子源；行合并=journal 全部在前、session 全部在后
//    （确定性——continueFrom 增量续编与全量重扫固定源序一致）。journal 失败→整体 null（4402）；
//    session 失败/缺映射→journal-only 降级+审计（session 快照缺席是可呈现的诚实缺面，不阻断）。
// ② session 投影归因：session 子源 projector 在扫描时**现读 journal 盘面**派生 enqueue 三元组与
//    consumed 区间（journalAttributionOf）——完整行前缀即耐久事实；撕裂尾天然不参与（匹配语义
//    正确：user 条目只能匹配已完整落盘的 enqueue）。journal 读失败→归因缺证（intentId=null）+审计，
//    不让 session 面因 journal 读故障整体失败（两源可用性独立，降级有序）。
// ③ observe/release：双子源配对转发；两子源均无活跃代→null（端口语义）。任一方绑定成功即返回
//    联合解绑闭包（幂等）。
// ④ session 路径由宿主 sessionFor 提供（无默认映射——pi 会话目录是宿主配置而非约定）；
//    未提供=journal-only 模式（每 load 审计一次）。
import type { ScanRow } from "@pi-agent-ui/protocol";
import { journalAttributionOf, sessionToScanRows } from "@pi-agent-ui/protocol";
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

/** 双源组合器：对外=单一 HistorySourcePort（网关不变）；对内=两个 FileHistorySource 子源。 */
export class DualHistorySource implements HistorySourcePort {
  private readonly journalSrc: FileHistorySource;
  private readonly sessionSrc: FileHistorySource | null;

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
      return { enqueues: [], consumed: [] };
    }
    try {
      const { text } = await reader.read(abs);
      return journalAttributionOf(text);
    } catch (e) {
      this.audit(`attribution-unreadable path=${journalPath} kind=${e instanceof Error ? e.constructor.name : "unknown"}`);
      return { enqueues: [], consumed: [] };
    }
  }

  async load(file: string): Promise<readonly ScanRow[] | null> {
    const jrows = await this.journalSrc.load(file);
    if (jrows === null) return null; // journal=事实源：失败整体 fail-closed
    if (this.sessionSrc === null || this.opts.sessionFor === undefined) {
      this.audit(`journal-only file=${file} reason=no-session-mapping`);
      return jrows;
    }
    const srows = await this.sessionSrc.load(file); // 键=逻辑 file（session 子源内部经 sessionFor 映射路径）
    if (srows === null) {
      this.audit(`session-missing file=${file}`); // journal-only 降级（可呈现缺面）
      return jrows;
    }
    return [...jrows, ...srows];
  }

  observe(file: string, sinks: HistorySinks): (() => void) | null {
    const unJ = this.journalSrc.observe?.(file, sinks) ?? null;
    if (this.sessionSrc === null || this.opts.sessionFor === undefined) return unJ;
    const unS = this.sessionSrc.observe?.(file, sinks) ?? null;
    if (unJ === null && unS === null) return null;
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      try { unJ?.(); } catch { /* 解绑不抛 */ }
      try { unS?.(); } catch { /* 解绑不抛 */ }
    };
  }

  release(file: string): void {
    this.journalSrc.release?.(file);
    if (this.sessionSrc !== null && this.opts.sessionFor !== undefined) {
      this.sessionSrc.release?.(file);
    }
  }
}
