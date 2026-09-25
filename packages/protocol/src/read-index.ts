// ②WS/UI 读侧 append-only 编排器（契约 v1.2 §1.3；纯逻辑）。
// 事件一旦编入 seq 永不改变；后来者只追加流尾。内存常驻+LRU（≤32 流×20k 事件）；不持久化（跨 boot 换流）。
import type { HistoryEvent, StreamId } from "./contracts.ts";

export type EventSource = "journal" | "session";

export interface IndexedEvent {
  readonly seq: number;
  readonly source: EventSource;
  /** 源定位：journal 行号（1 基）或 session 条目字节偏移（稳定身份） */
  readonly locator: string;
  readonly event: HistoryEvent;
}

/** 单会话流读索引（append-only） */
export class ReadIndex {
  readonly streamId: StreamId;
  readonly file: string;
  private readonly events: IndexedEvent[] = [];
  /** 源文件指纹（整文件 SHA-256；空=未记录） */
  journalFingerprint = "";
  sessionFingerprint = "";

  constructor(file: string, streamId: StreamId) { this.file = file; this.streamId = streamId; }

  get waterMark(): number { return this.events.length; }

  /** 追加事件（append-only；返回分得的 seq=水位+1）。禁止插入。 */
  append(source: EventSource, locator: string, event: HistoryEvent): number {
    const seq = this.events.length + 1;
    this.events.push({ seq, source, locator, event });
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

  /** 前缀投影比对（换流判定）：已编入的 (source,locator) 序列是否仍为当前扫描结果的前缀。 */
  isPrefixOf(currentScan: readonly { source: EventSource; locator: string }[]): boolean {
    if (this.events.length > currentScan.length) return false;
    for (let i = 0; i < this.events.length; i++) {
      const a = this.events[i], b = currentScan[i];
      if (a === undefined || b === undefined) return false;
      if (a.source !== b.source || a.locator !== b.locator) return false;
    }
    return true;
  }

  /** LRU 预算内事件上限（契约 §1.3：20k/流；超限=该流强制卸载换流）。 */
  get overBudget(): boolean { return this.events.length > 20_000; }
}

/** 流注册表（LRU ≤32 流；超限卸载最久未访问→换流） */
export class ReadIndexRegistry {
  private readonly map = new Map<string, ReadIndex>(); // Map 迭代序=插入序；命中重插=LRU
  private seq = 0;

  get(file: string): ReadIndex {
    const hit = this.map.get(file);
    if (hit) { this.map.delete(file); this.map.set(file, hit); return hit; }
    const idx = new ReadIndex(file, `s-${++this.seq}`);
    this.map.set(file, idx);
    this.evictIfNeeded();
    return idx;
  }

  /** 换流：废弃旧流，下次 get 生成新 streamId。 */
  replace(file: string): void { this.map.delete(file); }

  private evictIfNeeded(): void {
    while (this.map.size > 32) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}
