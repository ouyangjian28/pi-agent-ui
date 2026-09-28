// P0-3 journal 写权代次（PROJECT P0 冻结序③）测试矩阵 W-oath-1..5（设计稿 docs/p0-3-writer-epoch-design.md FF-1..5）。
// 覆盖：①排他锁文件（单例互斥/stale 抢占/零字节写入）②宣誓 append 硬序+盘面门（bad-tail 拒）
// ③写前守卫（异已宣誓=writer-superseded 冻结粘性/无宣誓他写=foreign-write-detected）
// ④重放聚合兼容+schema 正负例+读面 writerState 呈现（INV-2/INV-3 异常盘面不崩溃）
// ⑤legacy v2 盘面兼容读+补宣誓转 v3 域。
import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireJournalLock,
  appendWriterOath,
  WriterGuard,
  type LockHolderInfo,
} from "../../../apps/server/src/runtime/writer-oath.ts";
import { parseJournalText, buildRecoverReport } from "../../../apps/server/src/runtime/recover.ts";
import { journalLineSchemaError, replayIntents, scanWriterEpoch, type JournalLine } from "@pi-agent-ui/protocol";

const settledRow = (i: string) => JSON.stringify({ t: "settled", intentId: i });
const writerRow = (epoch: number, bootId: string) => JSON.stringify({ t: "writer", epoch, bootId, at: "2026-10-08T00:00:00.000Z" });

async function tmpJournal(initial = ""): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "woath-"));
  const path = join(dir, "q.jsonl");
  await writeFile(path, initial, "utf8"); // 空串也建文件（锁/宣誓路径都从存在文件出发）
  return { dir, path };
}

describe("W-oath-1 排他锁（FF-1 单例互斥；O_EXCL+pid 探活）", () => {
  it("第二实例拒起且 journal 零字节写入", async () => {
    const { dir, path } = await tmpJournal("");
    const a = await acquireJournalLock({ journalPath: path, bootId: "boot-a" });
    expect(a.ok).toBe(true);
    const b = await acquireJournalLock({ journalPath: path, bootId: "boot-b", alive: () => true });
    expect(b.ok).toBe(false);
    if (!b.ok) {
      expect(b.reason).toBe("held");
      expect(b.stale).toBe(false); // 活持有者：非 stale 诊断（r2/F1 语义分面）
      expect(b.holder?.bootId).toBe("boot-a"); // holder 呈现（诊断面）
    }
    expect((await readFile(path, "utf8")).length).toBe(0); // 拒起方零字节写入
    await rm(dir, { recursive: true, force: true });
  });

  it("stale 锁（探活确认死）仍拒起+stale 诊断；锁文件原样保留（fail-closed 不抢占，恢复=显式清锁）", async () => {
    const { dir, path } = await tmpJournal("");
    const staleBody = `${JSON.stringify({ pid: 999999, bootId: "boot-dead", at: "x" })}\n`;
    await writeFile(`${path}.writer.lock`, staleBody, "utf8");
    const a = await acquireJournalLock({ journalPath: path, bootId: "boot-a", alive: () => false });
    expect(a.ok).toBe(false);
    if (!a.ok) {
      expect(a.reason).toBe("held");
      expect(a.stale).toBe(true); // 诊断=可人工清理（前提：停服务+禁并发拉起+同命名空间，见设计稿 §3）
      expect(a.holder?.bootId).toBe("boot-dead");
    }
    // 锁文件一字未动（无人 unlink——r1 探活→unlink→重建的 TOCTOU 抢占窗已删）
    expect(await readFile(`${path}.writer.lock`, "utf8")).toBe(staleBody);
    expect((await readFile(path, "utf8")).length).toBe(0); // 拒起方零字节写入
    await rm(dir, { recursive: true, force: true });
  });

  it("锁文件不可读/损坏=保守拒起（无证据判死不抢）", async () => {
    const { dir, path } = await tmpJournal("");
    await writeFile(`${path}.writer.lock`, "not-json", "utf8");
    const a = await acquireJournalLock({ journalPath: path, bootId: "boot-a", alive: () => false });
    expect(a.ok).toBe(false);
    if (!a.ok) {
      expect(a.reason).toBe("held");
      expect(a.holder).toBe(null); // 读/解析失败=holder 不可知
    }
    await rm(dir, { recursive: true, force: true });
  });
});

describe("W-oath-2 宣誓 append 硬序（FF-2）", () => {
  it("空 journal 首行=宣誓；重启 N 次得 N 条递增 writer 行", async () => {
    const { dir, path } = await tmpJournal("");
    const r1 = await appendWriterOath({ journalPath: path, epoch: 1, bootId: "boot-a", at: "T1" });
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.byteStart).toBe(0);
    const r2 = await appendWriterOath({ journalPath: path, epoch: 2, bootId: "boot-b", at: "T2" });
    expect(r2.ok).toBe(true);
    const raw = await readFile(path, "utf8");
    const parsed = parseJournalText(raw);
    expect(parsed.bad.length).toBe(0);
    expect(parsed.lines.map((l) => (l.t === "writer" ? l.epoch : -1))).toEqual([1, 2]);
    const scan = scanWriterEpoch(parsed.lines);
    expect(scan.maxEpoch).toBe(2);
    expect(scan.latestBootId).toBe("boot-b");
    expect(scan.anomalies.length).toBe(0);
    expect(scan.legacyHead).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  it("撕裂尾在场=bad-tail 拒（零改盘）", async () => {
    const torn = `${writerRow(1, "boot-a")}\n${settledRow("i1")}\n${JSON.stringify({ t: "settled", intentId: "i2" }).slice(0, 12)}`;
    const { dir, path } = await tmpJournal(torn);
    const before = await readFile(path, "utf8");
    const r = await appendWriterOath({ journalPath: path, epoch: 2, bootId: "boot-b" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad-tail");
    expect(await readFile(path, "utf8")).toBe(before); // 零改盘
    await rm(dir, { recursive: true, force: true });
  });
});

describe("W-oath-3 写前守卫（FF-3 旧写者停写；冻结粘性；增量基线）", () => {
  it("异已更高 epoch 宣誓→writer-superseded；粘性（后续 check 全拒，initialize 不解冻）", async () => {
    const { dir, path } = await tmpJournal(`${writerRow(1, "boot-a")}\n`);
    const raw1 = await readFile(path, "utf8");
    const g = new WriterGuard(path, 1, "boot-a");
    g.initialize({ byteEnd: Buffer.byteLength(raw1, "utf8") });
    expect((await g.checkBeforeAppend()).ok).toBe(true); // 无变化=放行
    // 外部：新写者宣誓 epoch=2
    const fh = await import("node:fs/promises").then((m) => m.open(path, "a"));
    await fh.appendFile(`${writerRow(2, "boot-b")}\n`);
    await fh.close();
    const v = await g.checkBeforeAppend();
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("writer-superseded");
    // 粘性：盘面不再变化后续 check 仍拒；initialize/noteAppended 不解冻不重置
    expect(g.initialize({ byteEnd: 99999 })).toBe(false);
    g.noteAppended(5);
    const v2 = await g.checkBeforeAppend();
    expect(v2.ok).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  it("F2 回归：写后全盘 stat 重建基线不再可能——noteAppended 增量记账不吞他者宣誓字节", async () => {
    const { dir, path } = await tmpJournal(`${writerRow(1, "boot-a")}\n`);
    const g = new WriterGuard(path, 1, "boot-a");
    const raw0 = await readFile(path, "utf8");
    g.initialize({ byteEnd: Buffer.byteLength(raw0, "utf8") });
    expect((await g.checkBeforeAppend()).ok).toBe(true);
    // B 宣誓 epoch=2（并发他写）
    const fh = await import("node:fs/promises").then((m) => m.open(path, "a"));
    await fh.appendFile(`${writerRow(2, "boot-b")}\n`);
    await fh.close();
    // A 自己 append 业务行后按增量记账（r1 缺陷形：按全盘 stat 回写会把 B 的宣誓吞进基线；
    // 注：本测试 append 后仅 close 未 sync——逻辑记账覆盖即有效，不作为 fsync 顺序证据）
    const myRow = `${settledRow("i1")}\n`;
    const fh2 = await import("node:fs/promises").then((m) => m.open(path, "a"));
    await fh2.appendFile(myRow);
    await fh2.close();
    g.noteAppended(Buffer.byteLength(myRow, "utf8"));
    const v = await g.checkBeforeAppend();
    expect(v.ok).toBe(false); // 基线不含 B 字节→sizeNow≠基线→重扫→superseded
    if (!v.ok) expect(v.reason).toBe("writer-superseded");
    await rm(dir, { recursive: true, force: true });
  });

  it("未 initialize=拒（uninitialized 粘性）；journal 消失→journal-unreadable", async () => {
    const { dir, path } = await tmpJournal(`${writerRow(1, "boot-a")}\n`);
    const g = new WriterGuard(path, 1, "boot-a");
    const v0 = await g.checkBeforeAppend();
    expect(v0.ok).toBe(false);
    if (!v0.ok) expect(v0.reason).toBe("uninitialized"); // r1 缺陷形：未初始化默认放行
    const v0b = await g.checkBeforeAppend();
    expect(v0b.reason).toBe("uninitialized"); // 粘性（与吞字节同界：冻结后不再演化）
    // 冻结后 initialize 同样无效（r3/GPT r2 R2-F2 杀点：若可重置，未宣誓实例可绕过 uninitialized 拒起）
    const sizeNow = (await import("node:fs/promises").then((m) => m.stat(path))).size;
    expect(g.initialize({ byteEnd: sizeNow })).toBe(false);
    const v0c = await g.checkBeforeAppend();
    expect(v0c.ok).toBe(false);
    if (!v0c.ok) expect(v0c.reason).toBe("uninitialized"); // 仍是原冻结判定，非重扫结果
    // 独立实例：正常建基线后 journal 消失
    const g2 = new WriterGuard(path, 1, "boot-a");
    g2.initialize({ byteEnd: 10 });
    await rm(path, { force: true });
    const v = await g2.checkBeforeAppend();
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("journal-unreadable");
    await rm(dir, { recursive: true, force: true });
  });

  it("无宣誓他写（异常盘面）→foreign-write-detected 保守冻结", async () => {
    const { dir, path } = await tmpJournal(`${writerRow(1, "boot-a")}\n`);
    const g = new WriterGuard(path, 1, "boot-a");
    g.initialize({ byteEnd: Buffer.byteLength(await readFile(path, "utf8"), "utf8") });
    const fh = await import("node:fs/promises").then((m) => m.open(path, "a"));
    await fh.appendFile(`${settledRow("iX")}\n`); // 他写业务行无宣誓（违反 INV-1 的异常面）
    await fh.close();
    const v = await g.checkBeforeAppend();
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("foreign-write-detected");
    await rm(dir, { recursive: true, force: true });
  });
});

describe("W-oath-4 重放兼容+schema+读面呈现（FF-4）", () => {
  it("writer 行不炸重放聚合；schema 正负例", async () => {
    const lines: JournalLine[] = [
      { t: "writer", epoch: 1, bootId: "boot-a", at: "T1" },
      { t: "settled", intentId: "i1" },
      { t: "writer", epoch: 2, bootId: "boot-b", at: "T2" },
      { t: "settled", intentId: "i2" },
    ];
    const m = replayIntents(lines, "q"); // 不抛=通过（writer 行聚合无操作）
    expect(m.size).toBe(0); // settled 无 enqueue 记录不建行——只证不炸
    // schema 正例
    expect(journalLineSchemaError({ t: "writer", epoch: 1, bootId: "b", at: "T" })).toBe(null);
    // 负例：epoch 0/非整数、bootId 空/缺、at 缺
    expect(journalLineSchemaError({ t: "writer", epoch: 0, bootId: "b", at: "T" })).toContain("epoch");
    expect(journalLineSchemaError({ t: "writer", epoch: 1.5, bootId: "b", at: "T" })).toContain("epoch");
    expect(journalLineSchemaError({ t: "writer", epoch: 1, bootId: "", at: "T" })).toContain("bootId");
    expect(journalLineSchemaError({ t: "writer", epoch: 1, bootId: "b" })).toContain("at");
    // r3 尾债（GPT r3 R3-F2）：at 空串直接 schema 负例——Mu-extra-F7（放宽 schema 的 length 检查）
    // 靠写门 io 断言锁不住（空 at 根本到不了 schema），本例锁读面本身
    expect(journalLineSchemaError({ t: "writer", epoch: 1, bootId: "b", at: "" })).toContain("at");
    // 同面：空 at 行进 parseJournalText 判 bad（读面与写面同源拒）
    const badTail = parseJournalText(`${JSON.stringify({ t: "writer", epoch: 1, bootId: "b", at: "" })}\n`);
    expect(badTail.bad.length).toBe(1);
  });

  it("INV-2/INV-3 违反盘面：报告呈现不崩溃", () => {
    const raw = [writerRow(1, "boot-a"), writerRow(3, "boot-c"), writerRow(2, "boot-d"), writerRow(2, "boot-e"), `${settledRow("i1")}\n`].join("\n");
    const parsed = parseJournalText(raw);
    const report = buildRecoverReport(parsed.lines, "q", { fragments: [], blocked: false });
    expect(report.writerState.maxEpoch).toBe(3);
    expect(report.writerState.anomalies.map((a) => a.kind)).toContain("epoch-non-monotonic"); // 2 在 3 后
    expect(report.writerState.anomalies.map((a) => a.kind)).toContain("same-epoch-two-boots"); // epoch2 两 bootId
  });

  it("writer 行与业务行混排：writerState 正确（INV-1 成立→legacyHead=false）", () => {
    const raw = `${writerRow(1, "boot-a")}\n${settledRow("i1")}\n${writerRow(2, "boot-b")}\n`;
    const parsed = parseJournalText(raw);
    expect(parsed.bad.length).toBe(0);
    const report = buildRecoverReport(parsed.lines, "q", { fragments: [], blocked: false });
    expect(report.writerState.legacyHead).toBe(false);
    expect(report.writerState.maxEpoch).toBe(2);
  });
});

describe("W-r3-1 release 单次共享（GPT r2 R2-F1 回归）", () => {
  it("重叠调用至多一次读-删序列：B 持有时重复/并发 release 不删 B 的锁→C 拒起", async () => {
    const { dir, path } = await tmpJournal("");
    let holderCalls = 0;
    let releaseFirst!: (h: LockHolderInfo | null) => void;
    // 真读（测试内联：读锁文件+解析；与模块内实现同形）
    const realRead = async (p: string): Promise<LockHolderInfo | null> => {
      try {
        const parsed = JSON.parse(await readFile(p, "utf8")) as Record<string, unknown>;
        if (typeof parsed.pid !== "number" || typeof parsed.bootId !== "string") return null;
        return { pid: parsed.pid, bootId: parsed.bootId, at: typeof parsed.at === "string" ? parsed.at : null };
      } catch {
        return null;
      }
    };
    // 接缝：首次读锁挂起（模拟 release-1 在读回后 unlink 前被调度暂停）
    const deferredRead = (p: string): Promise<LockHolderInfo | null> => {
      if (p !== `${path}.writer.lock`) return realRead(p);
      holderCalls += 1;
      if (holderCalls === 1) return new Promise((res) => { releaseFirst = (h) => res(h); });
      return realRead(p);
    };
    const a = await acquireJournalLock({ journalPath: path, bootId: "boot-a", readLockHolder: deferredRead });
    expect(a.ok).toBe(true);
    if (!a.ok) throw new Error("unreachable");
    const p1 = a.release(); // 进入读回，挂起
    await new Promise((r) => setTimeout(r, 5));
    const p2 = a.release(); // 重叠调用——共享在途，不发起第二次读回
    await new Promise((r) => setTimeout(r, 5));
    expect(holderCalls).toBe(1); // 杀点：无共享时此处已 2 次
    releaseFirst({ pid: 1, bootId: "boot-a", at: "T" }); // release-1 恢复：归属校验过→unlink A 锁（仅一次）
    await Promise.all([p1, p2]);
    const b = await acquireJournalLock({ journalPath: path, bootId: "boot-b" });
    expect(b.ok).toBe(true); // A 释放后 B 可拿
    const p3 = a.release(); // 完成后重复调用——不再发起读-删
    await p3;
    expect(holderCalls).toBe(1); // 杀点：无共享时重复调用再读回
    const c = await acquireJournalLock({ journalPath: path, bootId: "boot-c" });
    expect(c.ok).toBe(false); // B 仍持有——A 的 release 不得删到 B 的锁（交错双持有反例正式化）
    if (!c.ok) expect(c.holder?.bootId).toBe("boot-b");
    await rm(dir, { recursive: true, force: true });
  });
});

describe("W-r3-2 初始化绑定宣誓边界（GPT r2 R2-F2 回归）", () => {
  it("A 宣誓→B 并发宣誓→A 按自身 byteEnd 建基线→check 杀出 superseded（吞字节无限 ok 反例转正）", async () => {
    const { dir, path } = await tmpJournal("");
    const oathA = await appendWriterOath({ journalPath: path, epoch: 1, bootId: "boot-a", at: "TA" });
    expect(oathA.ok).toBe(true);
    const oathB = await appendWriterOath({ journalPath: path, epoch: 2, bootId: "boot-b", at: "TB" }); // 并发他者宣誓（模拟）
    expect(oathB.ok).toBe(true);
    if (!oathA.ok || !oathB.ok) throw new Error("unreachable");
    const g = new WriterGuard(path, 1, "boot-a");
    expect(g.initialize(oathA)).toBe(true); // 基线=自身宣誓边界（不含 B 字节）
    // 拒重复重置（未冻结时）：二次 initialize 不重置基线——若可重置，基线含 B 字节→check 放行（杀点）
    expect(g.initialize({ byteEnd: oathB.byteEnd })).toBe(false);
    const v = await g.checkBeforeAppend();
    expect(v.ok).toBe(false); // 杀点①：全盘 stat 基线含 B 字节→sizeNow==基线→ok（无限放行）
    if (!v.ok) expect(v.reason).toBe("writer-superseded");
    // 冻结后同样无效（粘性）
    expect(g.initialize({ byteEnd: oathB.byteEnd })).toBe(false);
    const v2 = await g.checkBeforeAppend();
    expect(v2.ok).toBe(false); // 冻结粘性
    await rm(dir, { recursive: true, force: true });
  });
});

describe("W-r3-3 at 写读一致（GPT r2 R2-F3 回归）", () => {
  it("at 空串→invalid-oath 且零 I/O（读盘前拦）；缺省 at 可写可读", async () => {
    const { dir, path } = await tmpJournal(`${writerRow(1, "boot-a")}\n`);
    let reads = 0;
    const spyRead = async (p: string) => {
      reads += 1;
      return readFile(p, "utf8");
    };
    const r = await appendWriterOath({ journalPath: path, epoch: 2, bootId: "boot-b", at: "", readFile: spyRead });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid-oath");
    expect(reads).toBe(0); // 杀点：显式校验删除时 selfCheck 兜底仍拦但 reads≥1（分层证明）
    // 缺省 at：默认 ISO 时间戳，写出行 schema 可读
    const r2 = await appendWriterOath({ journalPath: path, epoch: 2, bootId: "boot-b", readFile: spyRead });
    expect(r2.ok).toBe(true);
    const parsed = parseJournalText(await readFile(path, "utf8"));
    expect(parsed.bad.length).toBe(0);
    const writerRows = parsed.lines.filter((l) => l.t === "writer");
    expect(writerRows.at(-1)?.at).toBeTruthy();
    await rm(dir, { recursive: true, force: true });
  });
});

describe("W-oath-6 宣誓参数校验（F5：写前拒零改盘）", () => {
  it("epoch 耗尽/0/非整数/bootId 空→invalid-oath+盘面零变", async () => {
    const { dir, path } = await tmpJournal(`${writerRow(1, "boot-a")}\n`);
    const before = await readFile(path, "utf8");
    const bad: Array<{ epoch: number; bootId: string }> = [
      { epoch: Number.MAX_SAFE_INTEGER + 1, bootId: "boot-b" }, // 代次耗尽（合法 max 的 N+1）
      { epoch: 0, bootId: "boot-b" },
      { epoch: 1.5, bootId: "boot-b" },
      { epoch: 2, bootId: "" },
    ];
    for (const args of bad) {
      const r = await appendWriterOath({ journalPath: path, ...args });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("invalid-oath");
    }
    expect(await readFile(path, "utf8")).toBe(before); // 全部写前拒零改盘
    await rm(dir, { recursive: true, force: true });
  });
});

describe("W-oath-5 legacy v2 盘面兼容（FF-5）", () => {
  it("无 writer 行盘面正常读+legacyHead=true；补宣誓后转 v3 域", async () => {
    const legacy = `${settledRow("i1")}\n${settledRow("i2")}\n`;
    const { dir, path } = await tmpJournal(legacy);
    const parsed = parseJournalText(await readFile(path, "utf8"));
    expect(parsed.bad.length).toBe(0); // legacy 行不受影响
    const scanBefore = scanWriterEpoch(parsed.lines);
    expect(scanBefore.maxEpoch).toBe(null);
    expect(scanBefore.legacyHead).toBe(true);
    // 恢复流程补宣誓：maxEpoch=null → epoch=1
    const oath = await appendWriterOath({ journalPath: path, epoch: 1, bootId: "boot-new", at: "T" });
    expect(oath.ok).toBe(true);
    const after = parseJournalText(await readFile(path, "utf8"));
    const scanAfter = scanWriterEpoch(after.lines);
    expect(scanAfter.maxEpoch).toBe(1);
    expect(scanAfter.legacyHead).toBe(true); // legacy 段仍在首——呈现 legacy 头，非错误
    expect(after.bad.length).toBe(0);
    await rm(dir, { recursive: true, force: true });
  });
});
