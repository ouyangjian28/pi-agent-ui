// ②WS/UI 读侧 append-only 编排器（契约 v1.2 §1.3；纯逻辑）。
// 事件一旦编入 seq 永不改变；后来者只追加流尾。内存常驻+LRU（默认 32 流×20k 事件）；不持久化（跨 boot 换流）。
//
// B02（c4 审定）不变量：
// 1. 坐标统一——编入分得的 seq 是事件在流内的唯一权威坐标；append 以分配值覆盖
//    event.seq（宿主侧历史序号不进入读索引坐标系，防「索引 seq=1 而 event.seq=99」分裂）。
// 2. 原始证据校验（c6 C5-02）——换流判定不只比位置：每条编入事件保存**原始行字节摘要**
//    （FNV-1a64 over 宿主提供的原始行文本，非投影后事件）。投影（脱敏/截断/规范化）会
//    抹平原文差异（同 locator 原文改写但脱敏后相同 → 投影摘要相同），原始摘要不会。
//    诚实语义：任何已观测位置的原始内容变化都触发换流（不做部分续读）。
// 3. 流身份注入——streamId 由注入的 newId 生成（boot 内唯一随机 16B base64url；
//    无注入源时用 crypto.getRandomValues，再退化为进程内计数器）。
// 4. 超限出口有限（c6 C5-02 收紧 + c7 C6-03 修正）——触顶→换流一次宽容；**现流**再次触顶
//    且宽容额度已用=文件超出索引预算 → registry 拒绝（FileOverBudgetError，宿主转 4402）。
//    新流在预算内恒可用（不因历史触顶记录误拒空流）；无内部循环。append 不设硬门（写侧容量
//    由宿主经 get/overBudget 检查+换流维持——接线验收项）。内存预算数字=理论估算（非实测）。
import { fnv1a64Hex } from "./sanitizer.ts";
import type { HistoryEvent, StreamId } from "./contracts.ts";

export type EventSource = "journal" | "session";

export interface IndexedEvent {
  readonly seq: number;
  readonly source: EventSource;
  /** 源定位：journal 行号（1 基）或 session 条目字节偏移（稳定身份） */
  readonly locator: string;
  /** 原始行字节摘要（编入时刻对宿主提供的 raw 计算；换流判定主证据——防投影抹平改写） */
  readonly digest: string;
  readonly event: HistoryEvent;
}

/** 扫描行（宿主重扫产出；digest 与编入时同算法——对 raw 原文） */
export interface ScanRow {
  readonly source: EventSource;
  readonly locator: string;
  /** 原始行文本（journal 行原文 / session 条目原文；宿主重扫时提供） */
  readonly raw: string;
  readonly event: HistoryEvent;
}

export function scanDigest(row: ScanRow): string {
  return fnv1a64Hex(JSON.stringify([row.source, row.locator, row.raw]));
}

export interface ReadIndexLimits {
  readonly maxEventsPerStream: number;
}

export const DEFAULT_READ_INDEX_LIMITS: ReadIndexLimits = { maxEventsPerStream: 20_000 };

/** 单会话流读索引（append-only） */
export class ReadIndex {
  readonly streamId: StreamId;
  readonly file: string;
  private readonly events: IndexedEvent[] = [];
  /** 源文件指纹（整文件 SHA-256；空=未记录） */
  journalFingerprint = "";
  sessionFingerprint = "";

  constructor(file: string, streamId: StreamId, private readonly limits: ReadIndexLimits = DEFAULT_READ_INDEX_LIMITS) {
    this.file = file; this.streamId = streamId;
  }

  get waterMark(): number { return this.events.length; }

  /** 追加事件（append-only；返回分得的 seq=水位+1）。禁止插入。seq 覆盖=坐标统一（B02）。
   *  raw=原始行文本（换流判定主证据，C5-02）。 */
  append(source: EventSource, locator: string, raw: string, event: HistoryEvent): number {
    const seq = this.events.length + 1;
    const unified: HistoryEvent = { ...event, seq };
    this.events.push({ seq, source, locator, digest: fnv1a64Hex(JSON.stringify([source, locator, raw])), event: unified });
    return seq;
  }

  /** 读 [fromSeq..toSeqInclusive]（≤max 条）。 */
  read(fromSeq: number, max: number, toInclusive?: number): IndexedEvent[] {
    const out: IndexedEvent[] = [];
    for (let s = Math.max(1, fromSeq); s <= this.events.length; s++) {
      if (toInclusive !== undefined && s > toInclusive) break;
      const ev = this.events[s - 1];
      if (ev === undefined) break;
      out.push(ev);
      if (out.length >= max) break;
    }
    return out;
  }

  /** 前缀投影比对（换流判定）：位置+locator+内容摘要 全等才可续读（B02：内容改写亦换流）。 */
  isPrefixOf(currentScan: readonly ScanRow[]): boolean {
    if (this.events.length > currentScan.length) return false;
    for (let i = 0; i < this.events.length; i++) {
      const a = this.events[i], b = currentScan[i];
      if (a === undefined || b === undefined) return false;
      if (a.source !== b.source || a.locator !== b.locator) return false;
      if (a.digest !== scanDigest(b)) return false; // 同位同 locator 但原文改写（含投影抹平型）→ 换流
    }
    return true;
  }

  /** 预算内事件上限（超限=该流废弃，下次 get 重扫换流；出口有限，无内部循环）。 */
  get overBudget(): boolean { return this.events.length > this.limits.maxEventsPerStream; }
}

export interface ReadIndexRegistryLimits {
  readonly maxStreams: number;
}

export const DEFAULT_REGISTRY_LIMITS: ReadIndexRegistryLimits = { maxStreams: 32 };

/** 流注册表（LRU ≤maxStreams；命中/活动刷新；超限卸载最久未访问→换流） */
/** 文件超出索引预算（同文件两次触顶）：宿主应转 4402 会话不可读——不再以空流掩盖反复重扫。 */
export class FileOverBudgetError extends Error {
  constructor(readonly file: string) { super(`read-index: file over budget (twice): ${file}`); this.name = "FileOverBudgetError"; }
}

export class ReadIndexRegistry {
  private readonly map = new Map<string, ReadIndex>(); // Map 迭代序=插入序；重插=LRU 刷新
  /** 已触顶过一次的文件（第二次触顶→拒绝，有限出口） */
  private readonly overBudgetFiles = new Set<string>();

  constructor(
    private readonly newId: () => StreamId = defaultStreamId,
    private readonly limits: ReadIndexRegistryLimits = DEFAULT_REGISTRY_LIMITS,
    private readonly indexLimits: ReadIndexLimits = DEFAULT_READ_INDEX_LIMITS,
  ) {}

  /** 取流（C6-03 修正）：仅当**现流触顶且宽容额度已用**才拒绝；首次触顶→废弃换新（新流从空开始，
   *  预算内 get 恒放行——不因历史触顶记录误拒空流）。额度按文件记（Set）；LRU 淘汰后重建视为新流
   *  （重建流再触顶时因 Set 记录仍会被拒——出口有限，无无限重扫环）。 */
  get(file: string): ReadIndex {
    const hit = this.map.get(file);
    if (hit) {
      if (hit.overBudget) {
        if (this.overBudgetFiles.has(file)) throw new FileOverBudgetError(file); // 额度已用且现流又触顶
        this.map.delete(file); // 首次触顶：换流（唯一一次宽容）
        this.overBudgetFiles.add(file);
      } else { this.map.delete(file); this.map.set(file, hit); return hit; } // 预算内放行（含曾触顶文件的新流）
    }
    const idx = new ReadIndex(file, this.newId(), this.indexLimits);
    this.map.set(file, idx);
    this.evictIfNeeded();
    return idx;
  }

  /** LRU 活动刷新（append/read 期间宿主调用；防长连接高频流被冷流挤出）。 */
  touch(file: string): void {
    const hit = this.map.get(file);
    if (hit) { this.map.delete(file); this.map.set(file, hit); }
  }

  /** 换流：废弃旧流，下次 get 生成新 streamId。 */
  replace(file: string): void { this.map.delete(file); }

  /** 当前流数（测试/监控） */
  get size(): number { return this.map.size; }

  private evictIfNeeded(): void {
    while (this.map.size > this.limits.maxStreams) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break; // 有限出口
      this.map.delete(oldest);
    }
  }
}

/** boot 内随机流 ID（16B base64url）；无 crypto 时退化为进程内计数（boot 隔离靠进程边界） */
function defaultStreamId(): StreamId {
  const g = globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } };
  if (typeof g.crypto?.getRandomValues === "function") {
    const b = new Uint8Array(16);
    g.crypto.getRandomValues(b);
    let s = "";
    for (const x of b) s += x.toString(16).padStart(2, "0");
    return `s-${s}`;
  }
  return `s-fallback-${++defaultStreamIdCounter}-${Date.now().toString(36)}`;
}
let defaultStreamIdCounter = 0;
