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
      expect(b.holder?.bootId).toBe("boot-a"); // holder 呈现（诊断面）
    }
    expect((await readFile(path, "utf8")).length).toBe(0); // 拒起方零字节写入
    await rm(dir, { recursive: true, force: true });
  });

  it("stale 锁（探活确认死）抢占成功；抢占后 release 归属校验只清自己的锁", async () => {
    const { dir, path } = await tmpJournal("");
    // 手造 stale 锁（模拟崩溃残留）
    await writeFile(`${path}.writer.lock`, `${JSON.stringify({ pid: 999999, bootId: "boot-dead", at: "x" })}\n`, "utf8");
    const a = await acquireJournalLock({ journalPath: path, bootId: "boot-a", alive: () => false });
    expect(a.ok).toBe(true);
    // 锁文件已被 boot-a 重写
    const lockBody = JSON.parse(await readFile(`${path}.writer.lock`, "utf8"));
    expect(lockBody.bootId).toBe("boot-a");
    if (a.ok) await a.release();
    // 被抢后他者持锁时 release 不误删（归属校验）
    await acquireJournalLock({ journalPath: path, bootId: "boot-b", alive: () => true });
    const c = await acquireJournalLock({ journalPath: path, bootId: "boot-c", alive: () => true });
    expect(c.ok).toBe(false);
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

describe("W-oath-3 写前守卫（FF-3 旧写者停写；冻结粘性）", () => {
  it("异已更高 epoch 宣誓→writer-superseded；粘性（后续 check 全拒）", async () => {
    const { dir, path } = await tmpJournal(`${writerRow(1, "boot-a")}\n`);
    const raw1 = await readFile(path, "utf8");
    const g = new WriterGuard(path, 1, "boot-a");
    g.noteSize(Buffer.byteLength(raw1, "utf8"));
    expect((await g.checkBeforeAppend()).ok).toBe(true); // 无变化=放行
    // 外部：新写者宣誓 epoch=2
    const fh = await import("node:fs/promises").then((m) => m.open(path, "a"));
    await fh.appendFile(`${writerRow(2, "boot-b")}\n`);
    await fh.close();
    const v = await g.checkBeforeAppend();
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("writer-superseded");
    // 粘性：即使盘面不再变化，后续 append 前检查仍拒
    const v2 = await g.checkBeforeAppend();
    expect(v2.ok).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  it("无宣誓他写（异常盘面）→foreign-write-detected 保守冻结", async () => {
    const { dir, path } = await tmpJournal(`${writerRow(1, "boot-a")}\n`);
    const g = new WriterGuard(path, 1, "boot-a");
    g.noteSize(Buffer.byteLength(await readFile(path, "utf8"), "utf8"));
    const fh = await import("node:fs/promises").then((m) => m.open(path, "a"));
    await fh.appendFile(`${settledRow("iX")}\n`); // 他写业务行无宣誓（违反 INV-1 的异常面）
    await fh.close();
    const v = await g.checkBeforeAppend();
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("foreign-write-detected");
    await rm(dir, { recursive: true, force: true });
  });

  it("journal 消失→journal-unreadable 冻结", async () => {
    const { dir, path } = await tmpJournal(`${writerRow(1, "boot-a")}\n`);
    const g = new WriterGuard(path, 1, "boot-a");
    g.noteSize(10);
    await rm(path, { force: true });
    const v = await g.checkBeforeAppend();
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("journal-unreadable");
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
