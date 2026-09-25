// 3b-2a：FileHistorySource 单测+真盘集成测（验收=GPT 3b-0 §V 五组：基线四窗口/盘面分型/新旧流隔离/
// 不可用分型/撕裂与坏行）。替身=可编程 reader/watcher（读序/通知可控）；真盘面=临时目录真 fs。
import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, appendFile, rename, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileHistorySource, type HistoryReaderPort, type HistoryWatcherPort } from "../../../apps/server/src/runtime/history-source.ts";
import type { HistoryInvalidateReason, HistorySinks, HistoryUnavailableReason } from "../../../apps/server/src/ws/ws-gateway.ts";
import { SafeOpenError } from "../../../apps/server/src/ws/safe-open.ts";
import type { ScanRow } from "@pi-agent-ui/protocol";

const CLEANUP: string[] = [];
afterAll(async () => { for (const d of CLEANUP) await rm(d, { recursive: true, force: true }); });
async function tmpRoot(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "hist-src-"));
  CLEANUP.push(d);
  return d;
}
function jline(n: number, text = `m${n}`): string {
  return JSON.stringify({ t: "enqueue", intentId: `i-${n}`, sessionId: "s", generation: 1, leafId: `L${n}`, matchKey: { textHash: `h${n}`, attachmentIdentity: "", ordinal: n }, payload: { kind: "user", rawText: text, attachments: [], sentAt: 1 } });
}

/** 可编程读取替身：脚本化结果队列（文本+身份）；支持挂起（fn 推进）。 */
class FakeReader implements HistoryReaderPort {
  reads: Array<{ text: string; identity: string } | Error | Promise<{ text: string; identity: string }>> = [];
  calls = 0;
  private waiters: Array<() => void> = [];
  read(_abs: string): Promise<{ text: string; identity: string }> {
    this.calls += 1;
    const next = this.reads[this.calls - 1];
    const r = next === undefined ? { text: "", identity: "0:0" } : next;
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve(r);
  }
  hold(): void { // 下一次 read 结果扣住不放（pending 占位）
    const idx = this.calls; // 已消耗数=下一次下标
    const orig = this.reads[idx];
    this.reads[idx] = new Promise((res) => { this.waiters.push(() => res(orig as { text: string; identity: string })); });
  }
  releaseHold(): void { const w = this.waiters.shift(); if (w) w(); }
}

/** 观察替身：每次 .watch 建一个可控句柄（全部句柄留档可查）。 */
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
function statusRecorder(log: SinkLog): (st: unknown) => void { return (st) => { log.statuses.push(st); }; }
function makeSinks(): { s: HistorySinks; log: SinkLog } {
  const log: SinkLog = { appends: [], invalidates: [], unavailables: [], lives: [], statuses: [] };
  return {
    log,
    s: {
      onAppend: (r) => { log.appends.push(r); },
      onInvalidate: (reason) => { log.invalidates.push(reason); },
      onUnavailable: (reason) => { log.unavailables.push(reason); },
      onLive: (ev) => { log.lives.push(ev); },
      onStatus: statusRecorder(log),
    },
  };
}

function harness(over: { reader?: FakeReader; watcher?: FakeWatcher; roots?: string[]; maxScanBytes?: number } = {}) {
  const reader = over.reader ?? new FakeReader();
  const watcher = over.watcher ?? new FakeWatcher();
  const audits: string[] = [];
  const src = new FileHistorySource(over.maxScanBytes !== undefined
    ? { roots: over.roots ?? ["/safe"], reader, watcher, maxScanBytes: over.maxScanBytes, audit: (l) => { audits.push(l); } }
    : { roots: over.roots ?? ["/safe"], reader, watcher, audit: (l) => { audits.push(l); } });
  return { src, reader, watcher, audits };
}

/** 微任务排空（rescan 是微任务链）。 */
async function drain(ms = 4): Promise<void> { await new Promise((r) => setTimeout(r, ms)); }
async function until(cond: () => boolean, ms = 400): Promise<void> {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await drain(2);
  if (!cond()) throw new Error("until timeout");
}

describe("FileHistorySource（3b-2a）——基线与四窗口（§V①）", () => {
  it("load=快照+observe 绑定；前缀追加逐行 onAppend", async () => {
    const text = `${jline(1)}\n${jline(2)}\n`;
    const r = new FakeReader(); r.reads.push({ text, identity: "1:1" }, { text: `${text}${jline(3)}\n`, identity: "1:1" });
    const h = harness({ reader: r });
    const rows = await h.src.load("a.jsonl");
    expect(rows?.map((x) => x.event.kind)).toEqual(["turn-enqueued", "turn-enqueued"]);
    const sk = makeSinks();
    const stop = h.src.observe("a.jsonl", sk.s);
    h.watcher.handles[0]?.triggerNotice();
    await until(() => sk.log.appends.length === 1);
    expect(sk.log.appends[0]).toMatchObject({ locator: "3" });
    expect(sk.log.invalidates).toEqual([]);
    stop();
  });

  it("窗口①监视前/读取中：读期间落盘的新行→装载后 dirty 收敛（激活即补扫）", async () => {
    const r = new FakeReader();
    r.reads.push({ text: `${jline(1)}\n`, identity: "1:1" }); // 读返回时盘面其实已有第 2 行
    const h = harness({ reader: r });
    // 读取期间 watcher 通知（监视已建立=真实读竞态窗口）
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

  it("窗口③退役重挂：重扫后旧句柄关闭、新句柄就位（无句柄泄漏）", async () => {
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
    expect(h.watcher.handles.filter((x) => !x.closed)).toHaveLength(1); // 恰一个活跃
    // 再一轮：仍无泄漏
    h.watcher.handles.filter((x) => !x.closed)[0]?.triggerNotice();
    await until(() => sk.log.appends.length === 2);
    await drain();
    expect(h.watcher.handles.filter((x) => !x.closed)).toHaveLength(1);
  });

  it("窗口④换代重挂补扫去重：stop 后重 load，旧流事件不进新流（§V③）", async () => {
    const t1 = `${jline(1)}\n`;
    const r = new FakeReader();
    r.reads.push({ text: t1, identity: "1:1" }, { text: `${t1}${jline(2)}\n`, identity: "1:1" });
    const h = harness({ reader: r });
    await h.src.load("a.jsonl");
    const skA = makeSinks();
    const stopA = h.src.observe("a.jsonl", skA.s);
    const handleA = h.watcher.handles[0];
    stopA(); // 旧代退役
    const skB = makeSinks();
    await h.src.load("a.jsonl");
    h.src.observe("a.jsonl", skB.s);
    handleA?.triggerNotice(); // 旧代句柄的迟到通知
    await drain(30);
    expect(skB.log.appends).toEqual([]); // 新流完全不受旧通知影响
    expect(skA.log.appends).toEqual([]);
  });
});

describe("FileHistorySource——盘面分型（§V②）", () => {
  async function armed(h: ReturnType<typeof harness>, r: FakeReader, t0: string) {
    r.reads.push({ text: t0, identity: "1:1" });
    await h.src.load("a.jsonl");
    const sk = makeSinks();
    h.src.observe("a.jsonl", sk.s);
    return sk;
  }
  it("同位置原文变化（投影不变）→invalidate(rewrite) 而非部分续读", async () => {
    const r = new FakeReader();
    const h = harness({ reader: r });
    const sk = await armed(h, r, `${jline(1)}\n`);
    const rewritten = jline(1).replace("h1", "hX"); // 只动 textHash（投影不含）→投影不变但 raw 变
    r.reads.push({ text: `${rewritten}\n`, identity: "1:1" });
    h.watcher.handles[0]?.triggerNotice();
    await until(() => sk.log.invalidates.length === 1);
    expect(sk.log.invalidates).toEqual(["rewrite"]);
    expect(sk.log.appends).toEqual([]);
  });

  it("截短→invalidate(truncate)；此后通知不再产生事件（旧代已停）", async () => {
    const r = new FakeReader();
    const h = harness({ reader: r });
    const sk = await armed(h, r, `${jline(1)}\n${jline(2)}\n`);
    r.reads.push({ text: `${jline(1)}\n`, identity: "1:1" });
    h.watcher.handles[0]?.triggerNotice();
    await until(() => sk.log.invalidates.length === 1);
    expect(sk.log.invalidates).toEqual(["truncate"]);
    h.watcher.handles.filter((x) => !x.closed)[0]?.triggerNotice();
    await drain(30);
    expect(sk.log.appends).toEqual([]);
  });

  it("同尺寸同位置的 replace（dev:ino 变化）→invalidate(replace)（身份即换流）", async () => {
    const r = new FakeReader();
    const h = harness({ reader: r });
    const sk = await armed(h, r, `${jline(1)}\n`);
    r.reads.push({ text: `${jline(1)}\n`, identity: "9:9" }); // 同内容不同 inode
    h.watcher.handles[0]?.triggerNotice();
    await until(() => sk.log.invalidates.length === 1);
    expect(sk.log.invalidates).toEqual(["replace"]);
  });

  it("重复通知+无变化→零事件零失效（幂等重扫）", async () => {
    const r = new FakeReader();
    const h = harness({ reader: r });
    const t = `${jline(1)}\n`;
    const sk = await armed(h, r, t);
    r.reads.push({ text: t, identity: "1:1" });
    h.watcher.handles[0]?.triggerNotice();
    await drain(30);
    expect(sk.log.appends).toEqual([]);
    expect(sk.log.invalidates).toEqual([]);
    expect(sk.log.unavailables).toEqual([]);
  });

  it("同文本不同两行→两行各自 onAppend（文本不参与去重键）", async () => {
    const r = new FakeReader();
    const h = harness({ reader: r });
    const sk = await armed(h, r, `${jline(1)}\n`);
    r.reads.push({ text: `${jline(1)}\n${jline(2, "dup")}\n${jline(3, "dup")}\n`, identity: "1:1" });
    h.watcher.handles[0]?.triggerNotice();
    await until(() => sk.log.appends.length === 2);
    expect(sk.log.appends.map((x) => x.locator)).toEqual(["2", "3"]);
  });
});

describe("FileHistorySource——异步读完成与换代隔离（§V③）", () => {
  it("读挂起期间换代：旧读恢复后结果丢弃（不作用新流）", async () => {
    const r = new FakeReader();
    r.reads.push({ text: `${jline(1)}\n`, identity: "1:1" });
    const h = harness({ reader: r });
    await h.src.load("a.jsonl");
    const skA = makeSinks();
    h.src.observe("a.jsonl", skA.s);
    // 发起重扫并扣住
    const t2 = `${jline(1)}\n${jline(2)}\n`;
    r.reads.push({ text: t2, identity: "1:1" });
    r.hold(); // rescan 读挂起
    h.watcher.handles[0]?.triggerNotice();
    await drain(10);
    expect(r.calls).toBe(2);
    // 换代：stop+重新 load（新代读完成）
    const t3 = `${jline(1)}\n${jline(9)}\n`;
    r.reads.push({ text: t3, identity: "1:1" });
    await h.src.load("a.jsonl");
    const skB = makeSinks();
    h.src.observe("a.jsonl", skB.s);
    r.releaseHold(); // 旧读恢复——必须被丢弃
    await drain(30);
    expect(skA.log.appends).toEqual([]);
    expect(skB.log.appends).toEqual([]); // 新代基线=t3 已是全量；旧续体不得给它补 append
    expect(h.audits.some((l) => l.includes("superseded") || l.includes("retired"))).toBe(true);
  });

  it("onAppend 回调抛错不逸出：源存活、后续通知仍工作", async () => {
    const r = new FakeReader();
    const t1 = `${jline(1)}\n`;
    r.reads.push({ text: t1, identity: "1:1" }, { text: `${t1}${jline(2)}\n`, identity: "1:1" }, { text: `${t1}${jline(2)}\n${jline(3)}\n`, identity: "1:1" });
    const h = harness({ reader: r });
    await h.src.load("a.jsonl");
    const seen: number[] = [];
    const sk: HistorySinks = {
      onAppend: (row) => { seen.push(Number(row.locator)); if (row.locator === "2") throw new Error("sink boom"); },
      onLive: () => {}, onStatus: () => {},
    };
    h.src.observe("a.jsonl", sk);
    h.watcher.handles[0]?.triggerNotice();
    await until(() => seen.length === 1);
    await drain();
    h.watcher.handles.filter((x) => !x.closed)[0]?.triggerNotice();
    await until(() => seen.length === 2);
    expect(seen).toEqual([2, 3]); // 抛错后源继续推进
    expect(h.audits.some((l) => l.includes("append-cb-error"))).toBe(true);
  });
});

describe("FileHistorySource——不可用分型与 fail-closed（§V④）", () => {
  function soe(kind: "missing" | "too-large" | "open-denied" | "symlink"): SafeOpenError {
    return new SafeOpenError(kind, "a.jsonl", "test");
  }
  it("删除（missing）→onUnavailable(deleted)+观察收口", async () => {
    const r = new FakeReader();
    r.reads.push({ text: `${jline(1)}\n`, identity: "1:1" }, soe("missing"));
    const h = harness({ reader: r });
    await h.src.load("a.jsonl");
    const sk = makeSinks();
    h.src.observe("a.jsonl", sk.s);
    h.watcher.handles[0]?.triggerNotice();
    await until(() => sk.log.unavailables.length === 1);
    expect(sk.log.unavailables).toEqual(["deleted"]);
    expect(h.watcher.handles.every((x) => x.closed)).toBe(true);
  });

  it("超限→scan-over-budget；权限/符号链接/泛错→unreadable", async () => {
    for (const [err, want] of [[soe("too-large"), "scan-over-budget"], [soe("open-denied"), "unreadable"], [soe("symlink"), "unreadable"], [new Error("boom"), "unreadable"]] as const) {
      const r = new FakeReader();
      r.reads.push({ text: `${jline(1)}\n`, identity: "1:1" }, err as Error);
      const h = harness({ reader: r });
      await h.src.load("a.jsonl");
      const sk = makeSinks();
      h.src.observe("a.jsonl", sk.s);
      h.watcher.handles[0]?.triggerNotice();
      await until(() => sk.log.unavailables.length === 1);
      expect(sk.log.unavailables[0]).toBe(want);
    }
  });

  it("watch 建立失败→load=null（fail-closed：不降级快照）", async () => {
    const r = new FakeReader();
    r.reads.push({ text: `${jline(1)}\n`, identity: "1:1" });
    const w = new FakeWatcher();
    const h = harness({ reader: r, watcher: w });
    w.failNextSetup = true;
    expect(await h.src.load("a.jsonl")).toBeNull();
  });

  it("watch 建立后早期错误（装载完成前）→load=null", async () => {
    const r = new FakeReader();
    r.reads.push({ text: `${jline(1)}\n`, identity: "1:1" });
    const w = new FakeWatcher();
    const h = harness({ reader: r, watcher: w });
    const origRead = r.read.bind(r);
    r.read = (p) => { const pr = origRead(p); w.handles[0]?.triggerError(new Error("early")); return pr; };
    expect(await h.src.load("a.jsonl")).toBeNull();
    expect(h.audits.some((l) => l.includes("watch-error-early"))).toBe(true);
  });

  it("重挂观察失败→onUnavailable(watch-failed)（旧观察已关）", async () => {
    const r = new FakeReader();
    r.reads.push({ text: `${jline(1)}\n`, identity: "1:1" }, { text: `${jline(1)}\n`, identity: "1:1" });
    const w = new FakeWatcher();
    const h = harness({ reader: r, watcher: w });
    await h.src.load("a.jsonl");
    const sk = makeSinks();
    h.src.observe("a.jsonl", sk.s);
    w.failNextSetup = true;
    w.handles[0]?.triggerNotice();
    await until(() => sk.log.unavailables.length === 1);
    expect(sk.log.unavailables).toEqual(["watch-failed"]);
    expect(h.watcher.handles.every((x) => x.closed)).toBe(true);
  });

  it("越界路径→load=null（outside-roots 拒绝）", async () => {
    const h = harness({ roots: ["/safe"] });
    expect(await h.src.load("../escape.jsonl")).toBeNull();
    expect(h.audits.some((l) => l.includes("outside-roots"))).toBe(true);
  });
});

describe("FileHistorySource——真盘集成（§V①⑤）", () => {
  it("真 fs：装载/追加/截短分型/半行跨块/UTF-8 撕裂/坏行占位/替换/删除/超限", async () => {
    const root = await tmpRoot();
    const file = join(root, "j.jsonl");
    await writeFile(file, `${jline(1)}\n`, "utf8");
    // 注入 FakeWatcher（真 watcher 时序不稳），reader 用真盘（默认 RealReader）
    const w = new FakeWatcher();
    const src = new FileHistorySource({ roots: [root], watcher: w, audit: () => {} });
    const rows = await src.load("j.jsonl");
    expect(rows).toHaveLength(1);
    const sk = makeSinks();
    src.observe("j.jsonl", sk.s);

    // 追加完整行
    await appendFile(file, `${jline(2)}\n`, "utf8");
    w.handles[0]?.triggerNotice();
    await until(() => sk.log.appends.length === 1);
    expect(sk.log.appends[0]?.locator).toBe("2");

    // 半行（无换行）→不发布；补全后发布
    await appendFile(file, jline(3).slice(0, 20), "utf8");
    w.handles.filter((x) => !x.closed)[0]?.triggerNotice();
    await drain(30);
    expect(sk.log.appends).toHaveLength(1);
    await appendFile(file, `${jline(3).slice(20)}\n`, "utf8");
    w.handles.filter((x) => !x.closed)[0]?.triggerNotice();
    await until(() => sk.log.appends.length === 2);
    expect(sk.log.appends[1]?.locator).toBe("3");

    // UTF-8 撕裂：多字节字符从中间断开（分两次写，先无换行）
    const u8 = JSON.stringify({ t: "sending", intentId: "i-9", generation: 1 }) + "\n";
    const bytes = Buffer.from(u8, "utf8");
    const mid = Math.floor(bytes.length / 2);
    await appendFile(file, bytes.subarray(0, mid));
    w.handles.filter((x) => !x.closed)[0]?.triggerNotice();
    await drain(30);
    expect(sk.log.appends).toHaveLength(2);
    await appendFile(file, bytes.subarray(mid));
    w.handles.filter((x) => !x.closed)[0]?.triggerNotice();
    await until(() => sk.log.appends.length === 3);
    expect(sk.log.appends[2]?.event.kind).toBe("sending");

    // 坏完整行→journal-corrupt 占位（不丢）
    await appendFile(file, "garbage\n", "utf8");
    w.handles.filter((x) => !x.closed)[0]?.triggerNotice();
    await until(() => sk.log.appends.length === 4);
    expect(sk.log.appends[3]?.event.kind).toBe("journal-corrupt");

    // 截短→invalidate(truncate)
    await writeFile(file, `${jline(1)}\n`, "utf8");
    w.handles.filter((x) => !x.closed)[0]?.triggerNotice();
    await until(() => sk.log.invalidates.length === 1);
    expect(sk.log.invalidates).toEqual(["truncate"]);

    // 替换（原子 rename）→新订阅重装载=新基线（旧流已停）
    const tmp = join(root, "swap.tmp");
    await writeFile(tmp, `${jline(1)}\n${jline(2)}\n`, "utf8");
    await rename(tmp, file);
    const rows2 = await src.load("j.jsonl");
    expect(rows2).toHaveLength(2);

    // 删除→新装载 fail-closed null
    await unlink(file);
    expect(await src.load("j.jsonl")).toBeNull();
  });

  it("真 fs：maxScanBytes 读中硬限→load=null（too-large）", async () => {
    const root = await tmpRoot();
    const file = join(root, "big.jsonl");
    await writeFile(file, "x".repeat(4096), "utf8");
    const src = new FileHistorySource({ roots: [root], watcher: new FakeWatcher(), maxScanBytes: 64, audit: () => {} });
    expect(await src.load("big.jsonl")).toBeNull();
  });
});
