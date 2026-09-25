// 3b-2a+3b2a-R1/R2/R6：FileHistorySource 单测+真盘集成测。
// 证据分级（R7）：主受控面=真 reader 语义（脚本化 FakeReader 可挂起/多槽）+受控 watcher（FakeWatcher）；
// 真盘组=真 fs+RealReader（分型/跨界/撕裂/预算）+受控触发（重扫描由 FakeWatcher notice 驱动——
// 真 watcher E2E 归 3b-3 组装验收）。夹具全部合法 schema（kind="prompt"）。
import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, appendFile, rename, unlink, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileHistorySource, type HistoryReaderPort, type HistoryWatcherPort } from "../../../apps/server/src/runtime/history-source.ts";
import type { HistoryInvalidateReason, HistorySinks, HistoryUnavailableReason } from "../../../apps/server/src/ws/ws-gateway.ts";
import type { ScanRow } from "@pi-agent-ui/protocol";

const CLEANUP: string[] = [];
afterAll(async () => { for (const d of CLEANUP) await rm(d, { recursive: true, force: true }); });
async function tmpRoot(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "hist-src-"));
  CLEANUP.push(d);
  return d;
}
function jline(n: number, text = `m${n}`): string {
  return JSON.stringify({ t: "enqueue", intentId: `i-${n}`, sessionId: "s", generation: 1, leafId: `L${n}`, matchKey: { textHash: `h${n}`, attachmentIdentity: "", ordinal: n }, payload: { kind: "prompt", rawText: text, attachments: [], sentAt: "1" } });
}

type ReadResult = { text: string; identity: string };
/** 挂起读占位：手动 resolve/reject（多槽——R2 单飞/P3 竞态证据）。 */
class HeldRead {
  settled = false;
  private res?: (v: ReadResult) => void;
  private rej?: (e: unknown) => void;
  readonly promise: Promise<ReadResult>;
  constructor() {
    this.promise = new Promise((res, rej) => { this.res = res; this.rej = rej; });
  }
  resolve(v: ReadResult): void { if (!this.settled) { this.settled = true; (this.res as (x: ReadResult) => void)(v); } }
  reject(e: unknown): void { if (!this.settled) { this.settled = true; (this.rej as (x: unknown) => void)(e); } }
}

/** 可编程读取替身：脚本化结果队列；HeldRead 占位=挂起（多槽）。 */
class FakeReader implements HistoryReaderPort {
  reads: Array<ReadResult | Error | HeldRead> = [];
  calls = 0;
  read(_abs: string): Promise<ReadResult> {
    this.calls += 1;
    const next = this.reads[this.calls - 1];
    const r = next === undefined ? { text: "", identity: "0:0" } : next;
    if (r instanceof Error) return Promise.reject(r);
    if (r instanceof HeldRead) return r.promise;
    return Promise.resolve(r);
  }
}

/** 观察替身：每次 .watch 建一个可控句柄（全部留档）；failNextSetup=建立失败（R6 throw 语义）。 */
class FakeWatcher implements HistoryWatcherPort {
  handles: FakeWatchHandle[] = [];
  failNextSetup = false;
  watch(_abs: string, onNotice: () => void, onError: (e: unknown) => void): { close(): void } {
    if (this.failNextSetup) { this.failNextSetup = false; throw new Error("watch setup boom"); }
    const h = new FakeWatchHandle(_abs, onNotice, onError);
    this.handles.push(h);
    return h;
  }
}
class FakeWatchHandle {
  closed = false;
  notices = 0;
  constructor(_abs: string, private readonly onNotice: () => void, private readonly onError: (e: unknown) => void) {}
  triggerNotice(): void { if (!this.closed) { this.notices += 1; this.onNotice(); } }
  triggerError(e: unknown): void { if (!this.closed) this.onError(e); }
  close(): void { this.closed = true; }
}

interface SinkLog {
  appends: ScanRow[];
  invalidates: HistoryInvalidateReason[];
  unavailables: HistoryUnavailableReason[];
  lives: unknown[];
  statuses: unknown[];
}
function makeSinks(): { s: HistorySinks; log: SinkLog } {
  const log: SinkLog = { appends: [], invalidates: [], unavailables: [], lives: [], statuses: [] };
  return {
    log,
    s: {
      onAppend: (r) => { log.appends.push(r); },
      onInvalidate: (reason) => { log.invalidates.push(reason); },
      onUnavailable: (reason) => { log.unavailables.push(reason); },
      onLive: (ev) => { log.lives.push(ev); },
      onStatus: (st) => { log.statuses.push(st); },
    },
  };
}

function harness(over: { reader?: FakeReader; watcher?: FakeWatcher; roots?: string[]; maxScanBytes?: number } = {}) {
  const reader = over.reader ?? new FakeReader();
  const watcher = over.watcher ?? new FakeWatcher();
  const audits: string[] = [];
  const src = new FileHistorySource({
    roots: over.roots ?? ["/safe"], reader, watcher,
    ...(over.maxScanBytes === undefined ? {} : { maxScanBytes: over.maxScanBytes }),
    audit: (l) => { audits.push(l); },
  });
  return { src, reader, watcher, audits };
}
function activeHandles(w: FakeWatcher): FakeWatchHandle[] { return w.handles.filter((x) => !x.closed); }

/** 微任务排空（rescan 是微任务链+setTimeout(0) 泵）。 */
async function drain(ms = 4): Promise<void> { await new Promise((r) => setTimeout(r, ms)); }
async function until(cond: () => boolean, ms = 400): Promise<void> {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await drain(2);
  if (!cond()) throw new Error("until timeout");
}

describe("FileHistorySource（3b-2a+R1/R2）——基线与四窗口（§V①）", () => {
  it("load=快照+observe 绑定（非 null）；前缀追加逐行 onAppend", async () => {
    const text = `${jline(1)}\n${jline(2)}\n`;
    const r = new FakeReader(); r.reads.push({ text, identity: "1:1" }, { text: `${text}${jline(3)}\n`, identity: "1:1" });
    const h = harness({ reader: r });
    const rows = await h.src.load("a.jsonl");
    expect(rows?.map((x) => x.event.kind)).toEqual(["turn-enqueued", "turn-enqueued"]);
    const sk = makeSinks();
    const stop = h.src.observe("a.jsonl", sk.s);
    expect(typeof stop).toBe("function"); // R1：observe 返回解绑闭包（非 null——活跃代绑定成功）
    h.watcher.handles[0]?.triggerNotice();
    await until(() => sk.log.appends.length === 1);
    expect(sk.log.appends[0]).toMatchObject({ locator: "3" });
    expect(sk.log.invalidates).toEqual([]);
    stop!();
    expect(activeHandles(h.watcher)).toHaveLength(0); // 解绑=最后引用离开→槽关闭（句柄全关）
  });

  it("窗口①监视前/读取中：读期间落盘的新行→装载后 dirty 收敛（激活即补扫）", async () => {
    const r = new FakeReader();
    r.reads.push({ text: `${jline(1)}\n`, identity: "1:1" }); // 读返回时盘面其实已有第 2 行
    const h = harness({ reader: r });
    const origRead = r.read.bind(r);
    r.read = (p) => { const pr = origRead(p); h.watcher.handles[0]?.triggerNotice(); return pr; };
    const rows = await h.src.load("a.jsonl");
    expect(rows).toHaveLength(1);
    const sk = makeSinks();
    h.src.observe("a.jsonl", sk.s); // 激活→dirty>0→补扫
    r.reads.push({ text: `${jline(1)}\n${jline(2)}\n`, identity: "1:1" });
    await until(() => sk.log.appends.length === 1);
    expect(sk.log.appends[0]?.locator).toBe("2");
  });

  it("窗口②激活前通知只计数：多次通知=一次重扫（合并）", async () => {
    const r = new FakeReader();
    const t1 = `${jline(1)}\n`;
    r.reads.push({ text: t1, identity: "1:1" }, { text: `${t1}${jline(2)}\n`, identity: "1:1" });
    const h = harness({ reader: r });
    await h.src.load("a.jsonl");
    h.watcher.handles[0]?.triggerNotice();
    h.watcher.handles[0]?.triggerNotice();
    h.watcher.handles[0]?.triggerNotice();
    const sk = makeSinks();
    h.src.observe("a.jsonl", sk.s);
    await until(() => sk.log.appends.length === 1);
    await drain();
    expect(r.calls).toBe(2); // 一次补扫收敛（不随通知次数线性放大）
    expect(sk.log.appends).toHaveLength(1);
  });

  it("窗口③重挂：重扫后旧句柄关闭、新句柄就位（无句柄泄漏）", async () => {
    const t1 = `${jline(1)}\n`;
    const r = new FakeReader();
    r.reads.push({ text: t1, identity: "1:1" }, { text: `${t1}${jline(2)}\n`, identity: "1:1" }, { text: `${t1}${jline(2)}\n${jline(3)}\n`, identity: "1:1" });
    const h = harness({ reader: r });
    await h.src.load("a.jsonl");
    const sk = makeSinks();
    h.src.observe("a.jsonl", sk.s);
    const first = h.watcher.handles[0];
    first?.triggerNotice();
    await until(() => sk.log.appends.length === 1);
    await drain();
    expect(first?.closed).toBe(true); // 重挂后旧句柄已关
    expect(activeHandles(h.watcher)).toHaveLength(1); // 恰一个活跃
    activeHandles(h.watcher)[0]?.triggerNotice();
    await until(() => sk.log.appends.length === 2);
    await drain();
    expect(activeHandles(h.watcher)).toHaveLength(1);
  });

  it("窗口④换代重挂：stop 后重 load，旧流事件不进新流（§V③）", async () => {
    const t1 = `${jline(1)}\n`;
    const r = new FakeReader();
    r.reads.push({ text: t1, identity: "1:1" }, { text: `${t1}${jline(2)}\n`, identity: "1:1" });
    const h = harness({ reader: r });
    await h.src.load("a.jsonl");
    const skA = makeSinks();
    const stopA = h.src.observe("a.jsonl", skA.s);
    const handleA = h.watcher.handles[0];
    stopA!(); // 旧代退役（引用清零→关闭）
    const skB = makeSinks();
    await h.src.load("a.jsonl"); // 新一代（第二次初扫）
    h.src.observe("a.jsonl", skB.s);
    handleA?.triggerNotice(); // 旧代句柄的迟到通知
    await drain(30);
    expect(skB.log.appends).toEqual([]); // 新流完全不受旧通知影响
    expect(skA.log.appends).toEqual([]);
  });
});

describe("FileHistorySource R1——load/observe/release 共享扫描所有权", () => {
  it("P4 双订阅共享初扫：并发 load=一次扫描、同快照；此后 append 双订阅各自收（不静默断流）", async () => {
    const t12 = `${jline(1)}\n${jline(2)}\n`;
    const r = new FakeReader();
    r.reads.push({ text: t12, identity: "1:1" }, { text: `${t12}${jline(3)}\n`, identity: "1:1" });
    const h = harness({ reader: r });
    const [a, b] = await Promise.all([h.src.load("a.jsonl"), h.src.load("a.jsonl")]);
    expect(r.calls).toBe(1); // 单飞：并发 load 共享同一初扫
    expect(a?.map((x) => x.locator)).toEqual(["1", "2"]);
    expect(b?.map((x) => x.locator)).toEqual(a?.map((x) => x.locator));
    const skA = makeSinks(), skB = makeSinks();
    const stopA = h.src.observe("a.jsonl", skA.s);
    expect(h.src.observe("a.jsonl", skB.s)).not.toBeNull(); // B 绑定自己的 sinks（第二 load 引用消耗）
    h.watcher.handles[0]?.triggerNotice();
    await until(() => skA.log.appends.length === 1 && skB.log.appends.length === 1);
    stopA!();
    expect(activeHandles(h.watcher)).toHaveLength(1); // B 仍持有引用——不关闭
  });

  it("join 增量：B 晚到 load-join 返回基线快照（此后增长由 append 补齐）", async () => {
    const t1 = `${jline(1)}\n`;
    const r = new FakeReader();
    r.reads.push({ text: t1, identity: "1:1" }, { text: `${t1}${jline(2)}\n`, identity: "1:1" });
    const h = harness({ reader: r });
    await h.src.load("a.jsonl");
    const skA = makeSinks();
    h.src.observe("a.jsonl", skA.s);
    const b = await h.src.load("a.jsonl"); // join：不触发新扫描
    expect(r.calls).toBe(1);
    expect(b?.map((x) => x.locator)).toEqual(["1"]);
    h.src.observe("a.jsonl", makeSinks().s);
    h.watcher.handles[0]?.triggerNotice();
    await until(() => h.audits.some((l) => l.includes("rescan")));
    await drain();
    expect(r.calls).toBe(2);
  });

  it("P3 在飞初扫：B await 同一 promise（不二次扫描）；A 不被 B 覆盖（单 entry 提交）", async () => {
    const r = new FakeReader();
    const held = new HeldRead();
    r.reads.push(held, { text: `${jline(1)}\n${jline(2)}\n`, identity: "1:1" });
    const h = harness({ reader: r });
    const pa = h.src.load("a.jsonl");
    const pb = h.src.load("a.jsonl"); // 初扫在飞：join 到同一 promise
    await drain();
    expect(r.calls).toBe(1); // 没有第二次扫描
    held.resolve({ text: `${jline(1)}\n`, identity: "1:1" });
    const [a, b] = await Promise.all([pa, pb]);
    expect(a?.map((x) => x.locator)).toEqual(["1"]);
    expect(b?.map((x) => x.locator)).toEqual(["1"]); // 同一提交（无覆盖）
    expect(h.audits.some((l) => l.includes("load-joined-after-scan"))).toBe(true);
  });

  it("release 配对：load 后 release（未 observe）→槽关闭（无主 watcher 归零）", async () => {
    const r = new FakeReader();
    r.reads.push({ text: `${jline(1)}\n`, identity: "1:1" });
    const h = harness({ reader: r });
    await h.src.load("a.jsonl");
    expect(activeHandles(h.watcher)).toHaveLength(1);
    h.src.release("a.jsonl"); // 最后引用离开且未绑定→关闭
    expect(activeHandles(h.watcher)).toHaveLength(0);
    expect(h.audits.some((l) => l.includes("released-unobserved"))).toBe(true);
  });

  it("P9 初扫在飞时放弃（release）→装载完成即弃：无主 watcher=0", async () => {
    const r = new FakeReader();
    const held = new HeldRead();
    r.reads.push(held);
    const h = harness({ reader: r });
    const p = h.src.load("a.jsonl");
    await drain();
    h.src.release("a.jsonl"); // 初扫在飞：置 releasePending
    held.resolve({ text: `${jline(1)}\n`, identity: "1:1" });
    expect(await p).toBeNull(); // 装载即弃（fail-closed，不给无主快照）
    await drain();
    expect(activeHandles(h.watcher)).toHaveLength(0);
    expect(h.audits.some((l) => l.includes("released-unobserved"))).toBe(true);
  });

  it("unobserve 后待配对引用仍在：槽保留至引用清零", async () => {
    const r = new FakeReader();
    r.reads.push({ text: `${jline(1)}\n`, identity: "1:1" });
    const h = harness({ reader: r });
    await h.src.load("a.jsonl"); // +1
    await h.src.load("a.jsonl"); // +1
    const sk = makeSinks();
    const stop = h.src.observe("a.jsonl", sk.s); // -1（绑定）
    stop!(); // 解绑：awaitingBind=1>0 →槽保留
    expect(activeHandles(h.watcher)).toHaveLength(1);
    h.src.release("a.jsonl"); // 最后引用→关闭
    expect(activeHandles(h.watcher)).toHaveLength(0);
  });

  it("observe 无活跃代→null（换代竞态后不再绑定旧代）", async () => {
    const r = new FakeReader();
    r.reads.push({ text: `${jline(1)}\n`, identity: "1:1" });
    const h = harness({ reader: r });
    await h.src.load("a.jsonl");
    h.src.release("a.jsonl"); // 关闭
    expect(h.src.observe("a.jsonl", makeSinks().s)).toBeNull();
  });
});

describe("FileHistorySource R2——单飞扫描与通知折叠", () => {
  it("P2 在飞重扫与追加竞态：旧扫返回旧前缀不得误判 truncate；折叠一次跟进补齐", async () => {
    const t12 = `${jline(1)}\n${jline(2)}\n`;
    const r = new FakeReader();
    r.reads.push({ text: t12, identity: "1:1" }); // 初扫
    const held = new HeldRead();
    r.reads.push(held); // 第一次重扫（挂起）
    r.reads.push({ text: `${t12}${jline(3)}\n`, identity: "1:1" }); // 跟进重扫（见到第 3 行）
    const h = harness({ reader: r });
    await h.src.load("a.jsonl");
    const sk = makeSinks();
    h.src.observe("a.jsonl", sk.s);
    h.watcher.handles[0]?.triggerNotice(); // 触发重扫（挂起中）
    await drain();
    // 重扫挂起期间：第 3 行已落盘+新通知（折 dirtyPending——不并发第二扫）
    h.watcher.handles[0]?.triggerNotice();
    h.watcher.handles[0]?.triggerNotice();
    held.resolve({ text: t12, identity: "1:1" }); // 旧扫返回【旧前缀】（读到追加前快照）
    await until(() => sk.log.appends.length === 1);
    await drain();
    expect(sk.log.invalidates).toEqual([]); // 不误判 truncate/rewrite
    expect(sk.log.appends.map((x) => x.locator)).toEqual(["3"]);
    expect(r.calls).toBe(3); // 初扫+挂起重扫+跟进（通知折叠恰一次）
  });

  it("在飞重扫期间通知折叠：3 次通知→完成后恰一次跟进", async () => {
    const t1 = `${jline(1)}\n`;
    const r = new FakeReader();
    r.reads.push({ text: t1, identity: "1:1" });
    const held = new HeldRead();
    r.reads.push(held, { text: t1, identity: "1:1" }, { text: `${t1}${jline(2)}\n`, identity: "1:1" });
    const h = harness({ reader: r });
    await h.src.load("a.jsonl");
    const sk = makeSinks();
    h.src.observe("a.jsonl", sk.s);
    h.watcher.handles[0]?.triggerNotice();
    await drain();
    h.watcher.handles[0]?.triggerNotice();
    h.watcher.handles[0]?.triggerNotice();
    h.watcher.handles[0]?.triggerNotice();
    held.resolve({ text: t1, identity: "1:1" });
    await until(() => r.calls === 3);
    await drain(20);
    expect(r.calls).toBe(3); // 初扫+重扫+跟进一次（3 通知不放大）
  });

  it("读挂起期间换代（stop）：旧读完成不进任何流（await 后复核）", async () => {
    const t1 = `${jline(1)}\n`;
    const r = new FakeReader();
    r.reads.push({ text: t1, identity: "1:1" });
    const held = new HeldRead();
    r.reads.push(held);
    const h = harness({ reader: r });
    await h.src.load("a.jsonl");
    const sk = makeSinks();
    const stop = h.src.observe("a.jsonl", sk.s);
    h.watcher.handles[0]?.triggerNotice();
    await drain();
    stop!(); // 重扫挂起中换代关闭
    held.resolve({ text: `${t1}${jline(2)}\n`, identity: "1:1" });
    await drain(20);
    expect(sk.log.appends).toEqual([]); // 旧代已 disposed：await 后复核丢弃
    expect(sk.log.invalidates).toEqual([]);
    expect(activeHandles(h.watcher)).toHaveLength(0);
  });

  it("onAppend 抛错不逸出（隔离）", async () => {
    const t1 = `${jline(1)}\n`;
    const r = new FakeReader();
    r.reads.push({ text: t1, identity: "1:1" }, { text: `${t1}${jline(2)}\n`, identity: "1:1" });
    const h = harness({ reader: r });
    await h.src.load("a.jsonl");
    let threw = false;
    const s: HistorySinks = { onAppend: () => { threw = true; throw new Error("sink boom"); }, onLive: () => {}, onStatus: () => {} };
    const stop = h.src.observe("a.jsonl", s);
    h.watcher.handles[0]?.triggerNotice();
    await until(() => threw);
    await drain();
    expect(h.audits.some((l) => l.includes("append-cb-error"))).toBe(true);
    stop!();
  });
});

describe("FileHistorySource R6——watcher 建立失败 fail-closed（不降空句柄）", () => {
  it("初扫 watch 建立失败→load=null（不读盘、无句柄）", async () => {
    const r = new FakeReader();
    const w = new FakeWatcher();
    w.failNextSetup = true;
    const h = harness({ reader: r, watcher: w });
    expect(await h.src.load("a.jsonl")).toBeNull();
    expect(r.calls).toBe(0); // 建观察失败→不读（fail-closed，无读循环）
    expect(w.handles).toHaveLength(0);
    expect(h.audits.some((l) => l.includes("watch-setup-failed"))).toBe(true);
  });

  it("活跃期 watcher error→先重挂新句柄再重扫核实（无窗口、无读循环）", async () => {
    const t1 = `${jline(1)}\n`;
    const r = new FakeReader();
    r.reads.push({ text: t1, identity: "1:1" }, { text: t1, identity: "1:1" });
    const h = harness({ reader: r });
    await h.src.load("a.jsonl");
    const sk = makeSinks();
    h.src.observe("a.jsonl", sk.s);
    const first = h.watcher.handles[0];
    first?.triggerError(new Error("watcher died"));
    await until(() => activeHandles(h.watcher).length === 1 && first?.closed === true);
    await until(() => r.calls === 2); // 重扫一次（核实无变化——句柄换新后异步进行）
    await drain();
    expect(sk.log.invalidates).toEqual([]);
    expect(sk.log.unavailables).toEqual([]); // 恢复成功（重挂成功→不降级）
  });

  it("重挂失败→unavailable(watch-failed)+槽关闭（fail-closed，不空转）", async () => {
    const t1 = `${jline(1)}\n`;
    const r = new FakeReader();
    r.reads.push({ text: t1, identity: "1:1" }, { text: t1, identity: "1:1" });
    const w = new FakeWatcher();
    const h = harness({ reader: r, watcher: w });
    await h.src.load("a.jsonl");
    const sk = makeSinks();
    h.src.observe("a.jsonl", sk.s);
    w.failNextSetup = true; // 重扫后 rearm 失败
    w.handles[0]?.triggerNotice();
    await until(() => sk.log.unavailables.length === 1);
    expect(sk.log.unavailables[0]).toBe("watch-failed");
    expect(activeHandles(w)).toHaveLength(0);
    expect(h.audits.some((l) => l.includes("watch-rearm-failed"))).toBe(true);
  });

  it("活跃期 error 重挂也失败→unavailable（error 路径 fail-closed）", async () => {
    const t1 = `${jline(1)}\n`;
    const r = new FakeReader();
    r.reads.push({ text: t1, identity: "1:1" });
    const w = new FakeWatcher();
    const h = harness({ reader: r, watcher: w });
    await h.src.load("a.jsonl");
    const sk = makeSinks();
    h.src.observe("a.jsonl", sk.s);
    w.failNextSetup = true;
    w.handles[0]?.triggerError(new Error("died"));
    await until(() => sk.log.unavailables.length === 1);
    expect(sk.log.unavailables[0]).toBe("watch-failed");
    expect(activeHandles(w)).toHaveLength(0);
  });

  it("邻文件健康：一个文件 watch 失败不波及另一文件流", async () => {
    const r = new FakeReader();
    r.reads.push({ text: `${jline(1)}\n`, identity: "1:1" }, { text: `${jline(1)}\n`, identity: "2:2" }, { text: `${jline(1)}\n`, identity: "1:1" }, { text: `${jline(1)}\n`, identity: "2:2" });
    const w = new FakeWatcher();
    const h = harness({ reader: r, watcher: w });
    await h.src.load("bad.jsonl");
    await h.src.load("good.jsonl");
    const skBad = makeSinks(), skGood = makeSinks();
    expect(h.src.observe("bad.jsonl", skBad.s)).not.toBeNull();
    expect(h.src.observe("good.jsonl", skGood.s)).not.toBeNull();
    // bad 触发 notice→重扫→重挂失败→unavailable
    w.failNextSetup = true;
    w.handles[0]?.triggerNotice();
    await until(() => skBad.log.unavailables.length === 1);
    const goodHandle = activeHandles(w).find((x) => x !== w.handles[0]);
    goodHandle?.triggerNotice();
    await drain();
    expect(skGood.log.unavailables).toEqual([]); // good 不受影响
    expect(skGood.log.invalidates).toEqual([]);
  });
});

describe("FileHistorySource——盘面分型（§V②）", () => {
  async function setup(t1: string): Promise<{ h: ReturnType<typeof harness>; sk: HistorySinks; log: SinkLog }> {
    const r = new FakeReader();
    r.reads.push({ text: t1, identity: "1:1" });
    const h = harness({ reader: r });
    await h.src.load("a.jsonl");
    const { s: sk, log } = makeSinks();
    h.src.observe("a.jsonl", sk);
    return { h, sk, log };
  }
  it("rewrite（同位置原文变化）→invalidate", async () => {
    const { h, log } = await setup(`${jline(1)}\n`);
    h.reader.reads.push({ text: `${jline(9)}\n`, identity: "1:1" });
    h.watcher.handles[0]?.triggerNotice();
    await until(() => log.invalidates.length === 1);
    expect(log.invalidates[0]).toBe("rewrite");
    expect(h.audits.some((l) => l.includes("invalidate"))).toBe(true);
  });

  it("truncate（变短）→invalidate", async () => {
    const { h, log } = await setup(`${jline(1)}\n${jline(2)}\n`);
    h.reader.reads.push({ text: `${jline(1)}\n`, identity: "1:1" });
    h.watcher.handles[0]?.triggerNotice();
    await until(() => log.invalidates.length === 1);
    expect(log.invalidates[0]).toBe("truncate");
  });

  it("replace（身份变化）→invalidate", async () => {
    const { h, log } = await setup(`${jline(1)}\n`);
    h.reader.reads.push({ text: `${jline(1)}\n`, identity: "9:9" }); // dev:ino 变
    h.watcher.handles[0]?.triggerNotice();
    await until(() => log.invalidates.length === 1);
    expect(log.invalidates[0]).toBe("replace");
  });

  it("幂等重扫（无变化）不发布任何信号", async () => {
    const { h, log } = await setup(`${jline(1)}\n`);
    h.reader.reads.push({ text: `${jline(1)}\n`, identity: "1:1" });
    h.watcher.handles[0]?.triggerNotice();
    await drain(20);
    expect(log.appends).toEqual([]);
    expect(log.invalidates).toEqual([]);
    expect(log.unavailables).toEqual([]);
  });

  it("同文本两行（内容相同但 locator 不同）各自发布", async () => {
    const { h, log } = await setup(`${jline(1)}\n`);
    h.reader.reads.push({ text: `${jline(1)}\n${jline(2)}\n`, identity: "1:1" });
    h.watcher.handles[0]?.triggerNotice();
    await until(() => log.appends.length === 1);
    expect(log.appends[0]?.locator).toBe("2");
  });
});

describe("FileHistorySource R5——投影防御与坏行", () => {
  it("坏行装载为 corrupt 占位（不 null、不抛）；追加坏行照常发布", async () => {
    const r = new FakeReader();
    const base = `${jline(1)}\nnot-json\n`;
    r.reads.push({ text: base, identity: "1:1" }, { text: `${base}{"t":"sending","intentId":{}}\n`, identity: "1:1" });
    const h = harness({ reader: r });
    const rows = await h.src.load("a.jsonl");
    expect(rows?.map((x) => x.event.kind)).toEqual(["turn-enqueued", "journal-corrupt"]);
    const sk = makeSinks();
    h.src.observe("a.jsonl", sk.s);
    h.watcher.handles[0]?.triggerNotice();
    await until(() => sk.log.appends.length === 1);
    expect(sk.log.appends[0]?.event.kind).toBe("journal-corrupt"); // P1b 坏行不再流入非法字段
    expect(sk.log.unavailables).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 真盘组（真 fs+RealReader；watcher 仍受控——真 watcher E2E 归 3b-3 组装验收）
// ---------------------------------------------------------------------------
describe("FileHistorySource 真盘（3b-2a+R7 证据分级）", () => {
  it("真盘全分型：追加/改写/截短/替换(rename)/删除 + 半行撕裂 + 坏行", async () => {
    const root = await tmpRoot();
    const file = join(root, "real.jsonl");
    await writeFile(file, `${jline(1)}\n${jline(2)}\n`, "utf8");
    const w = new FakeWatcher();
    const src = new FileHistorySource({ roots: [root], watcher: w, audit: () => {} });
    const rows1 = await src.load(file);
    expect(rows1).toHaveLength(2);
    const sk = makeSinks();
    const stop = src.observe(file, sk.s);
    // 追加（含一次半行撕裂：先写半行→通知→不发布；补全→通知→发布）
    await appendFile(file, jline(3).slice(0, 20));
    w.handles[0]?.triggerNotice();
    await drain();
    expect(sk.log.appends).toHaveLength(0); // 撕裂尾不发布
    await appendFile(file, `${jline(3).slice(20)}\n`);
    activeHandles(w)[0]?.triggerNotice(); // 撕裂重扫后已 rearm——用当前活跃句柄
    await until(() => sk.log.appends.length === 1);
    expect(sk.log.appends[0]?.locator).toBe("3");
    // 坏行追加→corrupt 发布
    await appendFile(file, "garbage\n");
    activeHandles(w)[0]?.triggerNotice();
    await until(() => sk.log.appends.length === 2);
    expect(sk.log.appends[1]?.event.kind).toBe("journal-corrupt");
    // 改写（同位置原文变化）→rewrite
    await writeFile(file, `${jline(1)}\n${jline(2)}\n${jline(3)}\n${jline(4)}\n${jline(3)}\n${jline(4)}\n${jline(3)}\n${jline(4)}\n${jline(3)}\n`, "utf8"); // 同长度但行 2 原文不同
    activeHandles(w)[0]?.triggerNotice();
    await until(() => sk.log.invalidates.includes("rewrite"));
    stop!();
    // 换代后：截短→invalidate(truncate)
    const rows2 = await src.load(file);
    expect(rows2).not.toBeNull();
    const sk2 = makeSinks();
    const stop2 = src.observe(file, sk2.s);
    await writeFile(file, `${jline(1)}\n`, "utf8");
    activeHandles(w)[0]?.triggerNotice();
    await until(() => sk2.log.invalidates.includes("truncate"));
    stop2!();
    // 替换（rename over→dev:ino 变化）→invalidate(replace)
    const tmp2 = join(root, "real2.jsonl");
    await writeFile(tmp2, `${jline(1)}\n${jline(2)}\n`, "utf8");
    const rows3 = await src.load(file);
    expect(rows3).not.toBeNull();
    const sk3 = makeSinks();
    const stop3 = src.observe(file, sk3.s);
    await rename(tmp2, file);
    activeHandles(w)[0]?.triggerNotice();
    await until(() => sk3.log.invalidates.includes("replace"));
    stop3!();
    // 删除（活跃订阅期 unlink→missing→deleted）
    const rows4 = await src.load(file);
    expect(rows4).not.toBeNull();
    const sk4 = makeSinks();
    const stop4 = src.observe(file, sk4.s);
    await unlink(file);
    activeHandles(w)[0]?.triggerNotice();
    await until(() => sk4.log.unavailables.includes("deleted"));
    stop4!();
  });

  it("UTF-8 多字节字符跨 64KiB 块界：撕裂两半不发布、补全成行", async () => {
    const root = await tmpRoot();
    const file = join(root, "cross.jsonl");
    const head = jline(1);
    // 构造第 2 行使其跨越 65536 字节界：中文每字 3 字节
    const prefixLen = 65530 - head.length - 1; // 第 2 行内、界前的字节数
    const pad = "a".repeat(Math.max(0, prefixLen - 60));
    const line2 = jline(2, `${pad}中文跨界中文跨界`); // 多字节字符大概率跨界
    await writeFile(file, `${head}\n`, "utf8");
    const w = new FakeWatcher();
    const src = new FileHistorySource({ roots: [root], watcher: w, audit: () => {} });
    await src.load(file);
    const sk = makeSinks();
    src.observe(file, sk.s);
    const bytes = Buffer.from(`${line2}\n`, "utf8");
    // 先写前 65530 字节（恰好停在某个多字节字符中间附近）→通知→不发布
    await appendFile(file, bytes.subarray(0, 65530 - head.length - 1));
    w.handles[0]?.triggerNotice();
    await drain();
    expect(sk.log.appends).toHaveLength(0); // 撕裂（可能停在多字节中间）不发布
    await appendFile(file, bytes.subarray(65530 - head.length - 1));
    activeHandles(w)[0]?.triggerNotice(); // 撕裂重扫已 rearm——用当前活跃句柄
    await until(() => sk.log.appends.length === 1);
    expect(sk.log.appends[0]?.event.kind).toBe("turn-enqueued");
  });

  it("maxScanBytes 硬限：超限→load=null（scan-over-budget 面在重扫）", async () => {
    const root = await tmpRoot();
    const file = join(root, "big.jsonl");
    await writeFile(file, `${jline(1)}\n`.repeat(10), "utf8");
    const w = new FakeWatcher();
    const src = new FileHistorySource({ roots: [root], watcher: w, maxScanBytes: 50, audit: () => {} });
    expect(await src.load(file)).toBeNull(); // 超预算 fail-closed
    expect(activeHandles(w)).toHaveLength(0);
  });

  it("真盘初扫读挂起期间 release：装载即弃（槽关闭、无泄漏）", async () => {
    const root = await tmpRoot();
    const file = join(root, "p9.jsonl");
    await writeFile(file, `${jline(1)}\n`, "utf8");
    // 首读真挂起（手动开闸）：验证初扫在飞时 release 的 fail-closed 出口
    let first = true;
    let gateOpen = false;
    const w = new FakeWatcher();
    const src = new FileHistorySource({
      roots: [root], watcher: w, audit: () => {},
      reader: {
        read: async (abs: string) => {
          if (first) { first = false; while (!gateOpen) await new Promise((res) => setTimeout(res, 2)); }
          const st = await stat(abs);
          return { text: await readFile(abs, "utf8"), identity: `${st.dev}:${st.ino}` };
        },
      },
    });
    const p = src.load(file);
    await drain(6); // 初扫挂起中（真读未返回）
    src.release(file); // 置 releasePending
    gateOpen = true; // 放行读
    expect(await p).toBeNull(); // 装载即弃（fail-closed，不给无主快照）
    await drain();
    expect(activeHandles(w)).toHaveLength(0); // 无主 watcher=0
  });
});
