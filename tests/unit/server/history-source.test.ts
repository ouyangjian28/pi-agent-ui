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
  /** 3b2g-R2 探针（GPT 3b2f F4/F5）：第 N 次注册在句柄建立后、返回前同步回调 onError（嵌套 rearm 窗口） */
  errorOnRegBeforeReturn: number | null = null;
  failNestedSetup = false;
  regCount = 0;
  watch(_abs: string, onNotice: () => void, onError: (e: unknown) => void): { close(): void } {
    if (this.failNextSetup) { this.failNextSetup = false; throw new Error("watch setup boom"); }
    const h = new FakeWatchHandle(_abs, onNotice, onError);
    this.handles.push(h); // 句柄已建立并留档——注册合法成立后才注入运行错误
    this.regCount += 1;
    if (this.errorOnRegBeforeReturn === this.regCount) {
      if (this.failNestedSetup) this.failNextSetup = true; // F4 排程：嵌套注册（N+1）建立失败
      onError(new Error("registered watcher error before return")); // 同步嵌套：驱动 rearmWatcher 后才返回
    }
    return h;
  }
}
class FakeWatchHandle {
  closed = false;
  notices = 0;
  constructor(_abs: string, private readonly onNotice: () => void, private readonly onError: (e: unknown) => void) {}
  triggerNotice(): void { if (!this.closed) { this.notices += 1; this.onNotice(); } }
  triggerError(e: unknown): void { if (!this.closed) this.onError(e); }
  /** 直调原始回调——**绕过本替身 closed 门**（GPT 3b2b B2/B7：真闭包泄漏必须可模拟）。 */
  rawNotice(): void { this.notices += 1; this.onNotice(); }
  rawError(e: unknown): void { this.onError(e); }
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

function harness(over: { reader?: FakeReader; watcher?: FakeWatcher; roots?: string[]; maxScanBytes?: number; onAuditLine?: (l: string, audits: string[]) => void } = {}) {
  const reader = over.reader ?? new FakeReader();
  const watcher = over.watcher ?? new FakeWatcher();
  const audits: string[] = [];
  const src = new FileHistorySource({
    roots: over.roots ?? ["/safe"], reader, watcher,
    ...(over.maxScanBytes === undefined ? {} : { maxScanBytes: over.maxScanBytes }),
    audit: (l) => {
      audits.push(l);
      over.onAuditLine?.(l, audits); // 3b2g-R1 探针（F10）：审计回调重入口（公开面——同步再入 load）
    },
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

  it("UTF-8 精确切点（3b2c-B7）：中文首字节=65535，半字符截断不发布、补全逐字无损", async () => {
    const root = await tmpRoot();
    const file = join(root, "cross.jsonl");
    const head = jline(1);
    const zh = "中文跨界中文跨界"; // 每字 3 字节
    // 精确切点：首个多字节字符首字节=绝对偏移 65535——文件恰写满 64KiB（[0,65536)）时
    // 只含其首字节（余二字节缺=半字符悬挂文件尾；读端 toString 出 U+FFFD 替换尾）。
    const headBytes = Buffer.byteLength(head) + 1;
    const zhFirstInLine = jline(2, zh).indexOf(zh); // JSON 前缀全 ASCII → 字符数=字节数
    const padLen = 65535 - headBytes - zhFirstInLine;
    expect(padLen).toBeGreaterThan(0);
    const line2 = jline(2, "a".repeat(padLen) + zh);
    expect(headBytes + zhFirstInLine + padLen).toBe(65535); // 构造自证：切点精确落在首字节
    const lineBytes = Buffer.from(`${line2}\n`, "utf8");
    expect(headBytes + lineBytes.length).toBeGreaterThan(65536); // 界外还有余量（zh 第 2/3 字节+JSON 尾）
    await writeFile(file, `${head}\n`, "utf8");
    const w = new FakeWatcher();
    const src = new FileHistorySource({ roots: [root], watcher: w, audit: () => {} });
    await src.load(file);
    const sk = makeSinks();
    src.observe(file, sk.s);
    // 追加段从 line2 自身字节 0 起（head 已在文件内）——切点=绝对 65536：恰含 zh 首字节、余二字节缺
    await appendFile(file, lineBytes.subarray(0, 65536 - headBytes));
    w.handles[0]?.triggerNotice();
    await drain();
    expect(sk.log.appends).toHaveLength(0); // 半字符+行未完 → 挂起不发布（U+FFFD 不入流）
    await appendFile(file, lineBytes.subarray(65536 - headBytes));
    activeHandles(w)[0]?.triggerNotice(); // 撕裂重扫已 rearm——用当前活跃句柄
    await until(() => sk.log.appends.length === 1);
    expect(sk.log.appends[0]?.event.kind).toBe("turn-enqueued");
    // 逐字核：补全成行后原文无损——无替换符、无丢字
    const parsed = JSON.parse(sk.log.appends[0]?.raw ?? "{}") as { payload: { rawText: string } };
    expect(parsed.payload.rawText).toBe("a".repeat(padLen) + zh);
    expect(parsed.payload.rawText.includes("\uFFFD")).toBe(false);
  });

  it("N13（3b2c-B7）：默认真工厂（RealWatcher）建立失败→load=null+reader 零调用", async () => {
    const root = await tmpRoot();
    const reads: string[] = [];
    const src = new FileHistorySource({
      roots: [root],
      reader: {
        read: (abs: string) => {
          reads.push(abs); // 断言用计数器；正常路径应零调用（watch 先于 read）
          return Promise.reject(new Error("不应读盘"));
        },
      },
      audit: () => {},
    }); // 不注 watcher → 默认 RealWatcher：fs.watch 对不存在路径同步 throw（ENOENT）
    const out = await src.load(join(root, "absent.jsonl"));
    expect(out).toBeNull(); // fail-closed：装载失败（不降级空句柄、不伪快照）
    expect(reads).toHaveLength(0); // 建立失败在读取之前——绝不读盘（杀窄 M-R6：静默降级会先读）
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
    src.release(file); // 撤在飞票据（3b2c-B1）
    gateOpen = true; // 放行读
    expect(await p).toBeNull(); // 装载即弃（fail-closed，不给无主快照）
    await drain();
    expect(activeHandles(w)).toHaveLength(0); // 无主 watcher=0
  });
});

describe("FileHistorySource 3b2c-B1/B2——槽位代次隔离+原始回调身份门（GPT 3b2b 反例）", () => {
  const text = `${jline(1)}\n${jline(2)}\n`;

  it("N1：初扫挂起→release→装载即弃；后续 load=全新初照成功（不残留）", async () => {
    const r = new FakeReader();
    const held = new HeldRead();
    r.reads.push(held, { text, identity: "1:1" });
    const h = harness({ reader: r });
    const p1 = h.src.load("a.jsonl");
    await drain(); // 初扫挂起
    h.src.release("a.jsonl"); // 撤票（B1/N1：不再置跨代布尔）
    held.resolve({ text, identity: "1:1" });
    expect(await p1).toBeNull(); // 该装载 fail-closed
    await drain();
    expect(activeHandles(h.watcher)).toHaveLength(0); // 无主 watcher=0
    expect(h.audits.some((l) => l.includes("released-unobserved"))).toBe(true);
    // 反例核心：后续正常 load 不被上一代 release 污染
    const rows2 = await h.src.load("a.jsonl");
    expect(rows2?.map((x) => x.event.kind)).toEqual(["turn-enqueued", "turn-enqueued"]);
    expect(activeHandles(h.watcher)).toHaveLength(1);
  });

  it("N2：初扫期 watch 错误关闭本代；新初扫不被上一代错误计数污染", async () => {
    const r = new FakeReader();
    const held = new HeldRead();
    r.reads.push(held, { text, identity: "1:1" });
    const h = harness({ reader: r });
    const p1 = h.src.load("a.jsonl");
    await drain();
    (h.watcher.handles[0] as FakeWatchHandle).triggerError(new Error("early boom")); // 本代初扫期错误
    held.resolve({ text, identity: "1:1" });
    expect(await p1).toBeNull(); // watch-error-early fail-closed
    expect(h.audits.some((l) => l.includes("watch-error-early"))).toBe(true);
    // 反例核心：错误计数随代清零，新初扫正常
    const rows2 = await h.src.load("a.jsonl");
    expect(rows2).not.toBeNull();
    expect(activeHandles(h.watcher)).toHaveLength(1);
  });

  it("N3：直调旧代原始 onError（绕过 closed 门）不杀新代初扫", async () => {
    const r = new FakeReader();
    const heldB = new HeldRead();
    r.reads.push({ text, identity: "1:1" }, heldB);
    const h = harness({ reader: r });
    expect(await h.src.load("a.jsonl")).not.toBeNull();
    const stop = h.src.observe("a.jsonl", makeSinks().s);
    stop?.(); // unobserve → A 代关闭（句柄 close）
    // B 新初扫挂起
    const p2 = h.src.load("a.jsonl");
    await drain();
    expect(h.watcher.handles.length).toBeGreaterThanOrEqual(2);
    // 直调 A 原始错误闭包（真回调，非替身门）
    (h.watcher.handles[0] as FakeWatchHandle).rawError(new Error("old-era boom"));
    heldB.resolve({ text, identity: "1:1" });
    const rows2 = await p2;
    expect(rows2).not.toBeNull(); // 旧代错误不得杀新代装载
    expect(h.audits.some((l) => l.includes("watch-error-stale-dropped"))).toBe(true);
  });

  it("N4：直调旧代原始 notice（绕过 closed 门）不驱动新代重读", async () => {
    const r = new FakeReader();
    r.reads.push({ text, identity: "1:1" }, { text, identity: "1:1" });
    const h = harness({ reader: r });
    expect(await h.src.load("a.jsonl")).not.toBeNull();
    const stopA = h.src.observe("a.jsonl", makeSinks().s);
    stopA?.(); // A 代关闭
    // B 新代：load+observe 活跃
    const b = makeSinks();
    expect(await h.src.load("a.jsonl")).not.toBeNull();
    const stopB = h.src.observe("a.jsonl", b.s);
    await drain();
    const callsBefore = r.calls;
    (h.watcher.handles[0] as FakeWatchHandle).rawNotice(); // 旧代原始通知
    await drain(8);
    expect(r.calls).toBe(callsBefore); // 旧通知被身份门丢弃：不触发新代重扫
    expect(b.log.invalidates).toHaveLength(0);
    expect(b.log.unavailables).toHaveLength(0);
    stopB?.();
  });

  it("N4b：同槽换代（carry 存活槽位）下旧代原始 notice 不驱动新代重读", async () => {
    // N4 的 stopA 后槽被回收（slot-reaped），旧闭包指向死槽=双重保护；本例用 carry=2 锚让 A→B 同槽
    // 且 B 的成功 load 只吸收一个（剩 carry=1 保槽），旧闭包 genNotice(slot, entryA) 落在活槽上——身份门是唯一防线。
    const r = new FakeReader();
    r.reads.push({ text, identity: "1:1" }, { text, identity: "9:9" }, { text, identity: "1:1" }, { text, identity: "1:1" });
    const h = harness({ reader: r });
    expect(await h.src.load("a.jsonl")).not.toBeNull(); // 代 A（读1）
    const stopA = h.src.observe("a.jsonl", makeSinks().s);
    h.src.release("a.jsonl");
    h.src.release("a.jsonl");
    h.src.release("a.jsonl"); // 3b2f-R3 勘正：超额释放压力例——单次 load 已被 observe 消费后再放两笔（非合法两他方 load）；合法路径同槽换代由 D4 固化
    h.watcher.handles[0]?.triggerNotice();
    await until(() => r.calls === 2); // 重扫 9:9 → replace 关代 A（读2；槽因 carry 存活）
    stopA?.();
    // 代 B：同槽新初扫（读3）+绑定
    const b = makeSinks();
    expect(await h.src.load("a.jsonl")).not.toBeNull();
    const stopB = h.src.observe("a.jsonl", b.s);
    await drain();
    const callsBefore = r.calls; // =3
    (h.watcher.handles[0] as FakeWatchHandle).rawNotice(); // 旧代原始通知（同槽活体）
    await drain(8);
    expect(r.calls).toBe(callsBefore); // 旧通知被身份门丢弃：不触发新代重扫
    expect(b.log.invalidates).toHaveLength(0);
    expect(b.log.unavailables).toHaveLength(0);
    stopB?.();
  });

  it("N6：旧代未配对引用的 release 扣旧账，不取消新代在飞装载", async () => {
    const r = new FakeReader();
    const heldB = new HeldRead();
    r.reads.push({ text, identity: "1:1" }, new Error("disk gone"), heldB);
    const h = harness({ reader: r });
    expect(await h.src.load("a.jsonl")).not.toBeNull(); // A 代 read#1
    const a = makeSinks();
    h.src.observe("a.jsonl", a.s);
    expect(await h.src.load("a.jsonl")).not.toBeNull(); // C：join 活跃代（awaitingBind=1）
    // A 代死于重扫读失败（read#2 Error → unavailable）
    (h.watcher.handles[0] as FakeWatchHandle).triggerNotice();
    await until(() => r.calls >= 2);
    await drain();
    expect(a.log.unavailables).toEqual(["unreadable"]);
    // B 新初扫挂起（read#3）
    const pB = h.src.load("a.jsonl");
    await drain();
    h.src.release("a.jsonl"); // C 的结算（旧账）
    heldB.resolve({ text, identity: "1:1" });
    const rowsB = await pB;
    expect(rowsB).not.toBeNull(); // 反例核心：新代装载不被旧 release 杀死
    expect(h.audits.some((l) => l.includes("release-carry"))).toBe(false); // 走的是计数扣减，非结转
    const bb = makeSinks();
    const stopB = h.src.observe("a.jsonl", bb.s);
    expect(stopB).not.toBeNull();
    stopB?.();
    await drain();
    expect(activeHandles(h.watcher)).toHaveLength(0); // 全配对后无泄漏
  });

  it("releaseCarry：无账可扣的 release 结转，由下一代成功 load 吸收（计数不为负、槽不泄漏）", async () => {
    const r = new FakeReader();
    r.reads.push({ text, identity: "1:1" });
    const h = harness({ reader: r });
    expect(await h.src.load("a.jsonl")).not.toBeNull();
    const a = makeSinks();
    const stopA = h.src.observe("a.jsonl", a.s); // observe 已消耗计数
    h.src.release("a.jsonl"); // 无账无票：结转 carry=1
    expect(h.audits.some((l) => l.includes("release-carry"))).toBe(true);
    expect(activeHandles(h.watcher)).toHaveLength(1); // 已绑定：结转不得关活观察
    // 下一代 load：carry 吸收（不增计数但快照正常给）
    const c = makeSinks();
    expect(await h.src.load("a.jsonl")).not.toBeNull();
    const stopC = h.src.observe("a.jsonl", c.s); // 绑定照常（clamp 不为负）
    expect(stopC).not.toBeNull();
    stopC?.();
    stopA?.();
    await drain();
    expect(activeHandles(h.watcher)).toHaveLength(0); // 全解绑后关闭
  });

  it("槽静默回收：失败装载结算后 slot-reaped；再 load=全新槽", async () => {
    const r = new FakeReader();
    r.reads.push(new Error("first boom"));
    const h = harness({ reader: r });
    expect(await h.src.load("a.jsonl")).toBeNull(); // 初扫失败
    expect(h.audits.some((l) => l.includes("slot-reaped"))).toBe(true); // 无主槽即时回收
    // 再 load：全新初扫（read#2 默认空文本→空快照）
    const rows2 = await h.src.load("a.jsonl");
    expect(rows2).toEqual([]);
  });
});

// ── 3b2e-C1/C2（GPT 3b2d D1/D2/D3/D4/D14/D15）：生命周期收口+同代重挂退役句柄 reg 门 ──
describe("FileHistorySource 3b2e-C1/C2——生命周期收口+watcher 注册身份", () => {
  it("C1/D1+D14：合法旧 held 引用保槽——同槽再起靠两行清零存活（错误+dirty 不跨代）", async () => {
    const text = `${jline(1)}\n`;
    const r = new FakeReader();
    const held3 = new HeldRead();
    r.reads.push({ text, identity: "1:1" }, new Error("rescan boom"), held3, { text, identity: "1:1" });
    const h = harness({ reader: r });
    await h.src.load("a.jsonl");                 // 初扫#1 → entryA
    const skA = makeSinks();
    const stopA = h.src.observe("a.jsonl", skA.s);
    void h.src.load("a.jsonl");                  // 他方 C 合法加入活代（awaitingBind=1——跨代延续）
    h.watcher.handles[0]!.triggerNotice();       // A 重扫读#2 失败 → unavailable → entryA 关
    await until(() => skA.log.unavailables.length === 1);
    stopA?.();                                   // no-op（代已关）
    expect(h.audits.some((l) => l.includes("slot-reaped"))).toBe(false); // C 引用在——同槽再起可达
    const auditsBeforeB = h.audits.length;         // D14 断言锚：只看 B 代之后日志
    const pB = h.src.load("a.jsonl");            // B 初扫（读#3 挂起）
    await until(() => h.watcher.handles.length === 2);
    h.watcher.handles[1]!.rawError(new Error("early boom 2")); // 本代早期错误（earlyWatchErrors=1+dirty 留痕）
    held3.resolve({ text, identity: "1:1" });
    await expect(pB).resolves.toBeNull();        // fail-closed（watch-error-early）
    expect(h.audits.some((l) => l.includes("slot-reaped"))).toBe(false); // 槽仍存活（C 在）
    const rowsD = await h.src.load("a.jsonl");   // 读#4——同槽新初扫：靠 earlyWatchErrors 清零存活（D1）
    expect(rowsD).not.toBeNull();
    // D14：定位恢复代日志段（3b2f 勘正——全量扫描可被首代 A 的 loaded 行满足）
    const auditsSinceB = h.audits.slice(auditsBeforeB);
    expect(auditsSinceB.some((l) => l.includes("loaded file=a.jsonl") && l.includes("dirty=false"))).toBe(true); // 旧 dirty 不继承
    const skD = makeSinks();
    const stopD = h.src.observe("a.jsonl", skD.s);
    await drain(8);
    expect(r.calls).toBe(4);                     // 新代无 notice 不得多读（激活无补扫）
    stopD?.();
  });

  it("C1/D2：挂起重扫终了收尾回收无主槽（不滞留 Map）", async () => {
    const text = `${jline(1)}\n`;
    const r = new FakeReader();
    const held2 = new HeldRead();
    r.reads.push({ text, identity: "1:1" }, held2);
    const h = harness({ reader: r });
    await h.src.load("a.jsonl");
    const sk = makeSinks();
    const stop = h.src.observe("a.jsonl", sk.s);
    h.watcher.handles[0]!.triggerNotice();       // 重扫挂起（读#2 held）
    await until(() => r.calls === 2);
    stop!();                                     // 最后 sink 离开——scanInFlight 在飞挡住回收
    expect(activeHandles(h.watcher)).toHaveLength(0); // 句柄全关（closeEntry）
    expect(h.audits.some((l) => l.includes("slot-reaped"))).toBe(false); // 在飞期不回收
    held2.resolve({ text, identity: "1:1" });    // 放行旧读（entry 已 disposed → 丢弃）
    await until(() => h.audits.some((l) => l.includes("slot-reaped")));   // 重扫 finally 补回收（D2 修复面）
  });

  it("C2/D15：同代 rearm 后旧句柄 rawNotice 不得多读（reg 注册身份门）", async () => {
    const text = `${jline(1)}\n`;
    const r = new FakeReader();
    r.reads.push({ text, identity: "1:1" }, { text, identity: "1:1" });
    const h = harness({ reader: r });
    await h.src.load("a.jsonl");
    const sk = makeSinks();
    const stop = h.src.observe("a.jsonl", sk.s);
    h.watcher.handles[0]!.triggerNotice();       // 重扫+rearm（新句柄=新 reg；旧句柄关）
    await until(() => r.calls === 2 && h.watcher.handles.length === 2);
    expect(h.watcher.handles[0]!.closed).toBe(true);
    h.watcher.handles[0]!.rawNotice();           // 旧注册闭包直调（绕句柄 closed 门）
    await drain(8);
    expect(r.calls).toBe(2);                     // 不得驱动读
    expect(sk.log.invalidates).toEqual([]);      // 不得触发换身份误判
    expect(h.audits.some((l) => l.includes("notice-stale-reg-dropped"))).toBe(true);
    stop?.();
  });

  it("C2/D3：同代旧句柄 rawError 不得驱动 rearm 杀当前观察", async () => {
    const text = `${jline(1)}\n`;
    const r = new FakeReader();
    r.reads.push({ text, identity: "1:1" }, { text, identity: "1:1" });
    const h = harness({ reader: r });
    await h.src.load("a.jsonl");
    const sk = makeSinks();
    const stop = h.src.observe("a.jsonl", sk.s);
    h.watcher.handles[0]!.triggerNotice();
    await until(() => r.calls === 2 && h.watcher.handles.length === 2);
    h.watcher.failNextSetup = true;              // 若被旧错误驱动 rearm → 建立失败 → watch-failed 杀观察
    h.watcher.handles[0]!.rawError(new Error("old handle error"));
    await drain(8);
    expect(sk.log.unavailables).toEqual([]);     // 当前观察不受旧句柄错误影响
    expect(activeHandles(h.watcher)).toHaveLength(1);
    expect(h.audits.some((l) => l.includes("watch-error-stale-reg-dropped"))).toBe(true);
    stop?.();
  });

  it("C2/D4（GPT 3b2d）：合法引用路径同槽换代——旧闭包直调不扰新代", async () => {
    const text = `${jline(1)}\n`;
    const r = new FakeReader();
    r.reads.push({ text, identity: "1:1" }, { text: `${text}${jline(2)}\n`, identity: "9:9" }, { text, identity: "1:1" });
    const h = harness({ reader: r });
    await h.src.load("a.jsonl");                 // entryA
    const skA = makeSinks();
    const stopA = h.src.observe("a.jsonl", skA.s);
    void h.src.load("a.jsonl");                  // 他方 C 合法 load 保槽（awaitingBind=1）
    h.watcher.handles[0]!.triggerNotice();       // 重扫 identity 9:9 → invalidate(replace) → entryA 关
    await until(() => skA.log.invalidates.length === 1);
    stopA?.();
    const rowsB = await h.src.load("a.jsonl");   // B 新初扫（读#3；同槽——C 引用在）
    expect(rowsB).not.toBeNull();
    expect(h.audits.some((l) => l.includes("slot-reaped"))).toBe(false);
    const skB = makeSinks();
    const stopB = h.src.observe("a.jsonl", skB.s);
    const callsBefore = r.calls;                 // =3
    h.watcher.handles[0]!.rawNotice();           // 旧代闭包直调（entry 票据门）
    h.watcher.handles[0]!.rawError(new Error("old gen error"));
    await drain(8);
    expect(r.calls).toBe(callsBefore);           // 新代不被驱动
    expect(skB.log.invalidates).toEqual([]);     // 新代不被杀伤
    expect(skB.log.unavailables).toEqual([]);
    stopB?.();
  });
});

// ── 3b2g-R1/R2（GPT 3b2f F4/F5/F10）：槽回收 Map 身份门 + 注册返回后重入保护 ──
describe("FileHistorySource 3b2g-R1/R2——回收身份门与注册提交重入", () => {
  it("R1/F10：slot-reaped 审计回调重入 load——旧回收第二次调用不得删新槽（幂等）", async () => {
    const text = `${jline(1)}\n`;
    const r = new FakeReader();
    r.reads.push({ text, identity: "1:1" }, { text, identity: "1:1" });
    const watcher = new FakeWatcher();
    let reentered = false;
    let nextLoad: Promise<readonly ScanRow[] | null> | null = null;
    // F10 排程：首次 slot-reaped 审计回调内同步重入 load——新槽 B 建立并登记初扫（公开审计面重入）
    const h = harness({
      reader: r, watcher,
      onAuditLine: (l) => {
        if (l.includes("slot-reaped") && !reentered) {
          reentered = true;
          nextLoad = h.src.load("a.jsonl");
        }
      },
    });
    const { src, audits } = h;
    await src.load("a.jsonl");        // 代 A（读#1；未 observe）
    src.release("a.jsonl");           // 关 A → 首次回收删 A → 审计重入建 B → 旧 release 的第二次回收不删 B
    expect(reentered).toBe(true);
    const rows = await nextLoad!;      // B 初扫正常完成（读#2）
    expect(rows).not.toBeNull();       // 旧代码：B 槽被第二次回收按文件名盲删
    const sk = makeSinks();
    const stop = src.observe("a.jsonl", sk.s); // B 仍登记——observe 必须绑定成功
    expect(stop).not.toBeNull();       // 旧代码：null（新 load 失去登记无法配对）
    stop?.();
    src.release("a.jsonl");            // B 引用结算
    await until(() => audits.filter((l) => l.includes("slot-reaped")).length >= 2);
    expect(watcher.handles.every((h) => h.closed)).toBe(true); // 全部句柄归零（无孤儿）
  });

  it("R2/F4：注册返回前嵌套错误+嵌套建立失败→watch-failed 且无孤儿句柄", async () => {
    const text = `${jline(1)}\n`;
    const r = new FakeReader();
    r.reads.push({ text, identity: "1:1" }, { text, identity: "1:1" });
    const h = harness({ reader: r });
    await h.src.load("a.jsonl");
    const sk = makeSinks();
    const stop = h.src.observe("a.jsonl", sk.s);
    h.watcher.errorOnRegBeforeReturn = 2; // 注册#2 建立后同步 onError → 嵌套 rearm（注册#3）
    h.watcher.failNestedSetup = true;      // 探针现场置位：嵌套注册#3 建立失败 → watch-failed → 代关闭
    h.watcher.handles[0]!.triggerError(new Error("watch error 1")); // 驱动 rearm（注册#2）
    await until(() => sk.log.unavailables.length === 1);
    expect(sk.log.unavailables[0]).toBe("watch-failed");
    await drain(8);
    expect(activeHandles(h.watcher)).toHaveLength(0); // 旧代码：#2 返回后推入已关代=孤儿 1
    expect(h.audits.some((l) => l.includes("watch-rearm-superseded"))).toBe(true);
    stop?.();
  });

  it("R2/F5：注册返回前嵌套错误+嵌套建立成功→新注册存活、外层返回句柄即关", async () => {
    const text = `${jline(1)}\n`;
    const r = new FakeReader();
    const held = new HeldRead();
    r.reads.push({ text, identity: "1:1" }, held, { text: `${jline(1)}\n${jline(2)}\n`, identity: "1:1" }); // 读#3=#3 通知折叠后的跟进重扫（同 identity+行数增长=前缀追加——append 交付路径）
    const h = harness({ reader: r });
    await h.src.load("a.jsonl");
    const sk = makeSinks();
    const stop = h.src.observe("a.jsonl", sk.s);
    h.watcher.errorOnRegBeforeReturn = 2; // 注册#2 建立后同步 onError → 嵌套 rearm 成功（注册#3=最新）
    h.watcher.handles[0]!.triggerError(new Error("watch error 1"));
    await until(() => h.watcher.handles.length >= 3);
    expect(h.watcher.handles.map((x) => x.closed)).toEqual([true, true, false]); // #1 旧关/#2 外层即关（R2）/#3 最新存活
    expect(sk.log.unavailables).toEqual([]);       // 无杀观察
    expect(h.audits.some((l) => l.includes("watch-rearm-superseded"))).toBe(true);
    await until(() => r.calls === 2);              // 外层 watch-error 的跟进重扫（挂起中）
    h.watcher.handles[1]!.rawNotice();             // #2 闭包直调——reg 门拒（stale）
    await drain(8);
    expect(r.calls).toBe(2);                        // 不再新增读调用
    // 最新注册 #3 仍有效：通知→在飞折叠 dirty；释放挂起读后收敛并重挂（新注册 #4=存活证明）
    h.watcher.handles[2]!.triggerNotice();
    await drain(8);
    held.resolve({ text, identity: "1:1" }); // 同基线：外层重扫收敛不换代（换代会 invalidate——replace 语义非本测目标）
    await until(() => h.watcher.handles.length >= 4); // 收敛即重挂=新注册链仍活
    await until(() => r.calls === 3);                 // 跟进重扫交付追加（#3 通知折叠的恰一次跟进）
    expect(sk.log.appends.map((x) => x.event.kind)).toContain("turn-enqueued"); // 追加行经活观察送达 sinks
    stop?.();
  });
});
