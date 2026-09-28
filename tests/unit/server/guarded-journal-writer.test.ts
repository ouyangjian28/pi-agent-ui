// P0-2 r1 装配面测试（W-asm-1..5；设计稿 §5；E2E W-asm-6/7 见 tests/e2e/p02-writer-assembly.e2e.ts）
// 变异纪律（M-245 家族）：基线先提交→注入→定向红→checkout 还原→复绿；杀点必须点验真经过被改行。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanWriterEpoch, type DurabilityPort, type JournalLine } from "@pi-agent-ui/protocol";
import { parseJournalText } from "../../../apps/server/src/runtime/recover.ts";
import { createGuardedJournalWriterFactory } from "../../../apps/server/src/runtime/guarded-journal-writer.ts";
import { acquireJournalLock } from "../../../apps/server/src/runtime/writer-oath.ts";

let dir: string;
let journal: string;
const lines = (p: string) => readFile(p, "utf8").then((raw) => parseJournalText(raw).lines);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "p02-asm-"));
  journal = join(dir, "session-a.jsonl");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const businessLine: JournalLine = { t: "enqueue", intentId: "i1", sessionId: "s1", generation: 1, leafId: "l1",
  matchKey: { textHash: "ab12", attachmentIdentity: "", ordinal: 0 },
  payload: { kind: "prompt", rawText: "hi", attachments: [], sentAt: "2026-10-09T00:00:00.000Z" } };

describe("W-asm-1 装配硬序：首 append 前 writer 行已在盘；装配失败=零业务行", () => {
  it("首 append 前盘面已有本进程 writer 行（epoch=1 新建）；业务行紧随其后", async () => {
    const f = createGuardedJournalWriterFactory({ bootId: "boot-1", now: () => "2026-10-09T00:00:00.000Z" });
    const w = f.writerFor(journal);
    await w.append(businessLine);
    const got = await lines(journal);
    expect(got[0]?.t).toBe("writer");
    const scan = scanWriterEpoch(got);
    expect(scan.maxEpoch).toBe(1);
    expect(scan.latestBootId).toBe("boot-1");
    expect(got[1]).toMatchObject({ t: "enqueue", intentId: "i1" });
    await f.dispose();
    // dispose 后锁文件已清（释放成功）
    await expect(readFile(`${journal}.writer.lock`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("既有 journal：epoch=maxEpoch+1 递增（INV-2）", async () => {
    await writeFile(journal, `${JSON.stringify({ t: "writer", epoch: 3, bootId: "old", at: "2026-10-01T00:00:00.000Z" })}\n`, "utf8");
    const f = createGuardedJournalWriterFactory({ bootId: "boot-2", now: () => "2026-10-09T00:00:00.000Z" });
    await f.writerFor(journal).append(businessLine);
    const scan = scanWriterEpoch(await lines(journal));
    expect(scan.maxEpoch).toBe(4);
    expect(scan.latestBootId).toBe("boot-2");
    await f.dispose();
  });
});

describe("W-asm-2 锁失败零写：EEXIST 活/死同拒+零业务行", () => {
  it("他进程持锁（活）→append 恒拒+盘面零业务行", async () => {
    const holder = await acquireJournalLock({ journalPath: journal, bootId: "holder-boot" });
    expect(holder.ok).toBe(true);
    const f = createGuardedJournalWriterFactory({ bootId: "boot-2", now: () => "2026-10-09T00:00:00.000Z" });
    await expect(f.writerFor(journal).append(businessLine)).rejects.toThrow("guarded-writer:writer-lock-held");
    await expect(readFile(journal, "utf8")).rejects.toMatchObject({ code: "ENOENT" }); // 零字节写入（含 oath）
    await f.dispose(); // 未获锁：无释放副作用（holder 锁仍在）
    if (holder.ok) await holder.release();
  });

  it("崩溃残留锁（stale 死 pid）→同拒 fail-closed", async () => {
    await writeFile(`${journal}.writer.lock`, JSON.stringify({ pid: 999_999_999, bootId: "dead-boot", at: "2026-10-09T00:00:00.000Z" }), "utf8");
    const f = createGuardedJournalWriterFactory({ bootId: "boot-2", now: () => "2026-10-09T00:00:00.000Z" });
    await expect(f.writerFor(journal).append(businessLine)).rejects.toThrow("guarded-writer:writer-lock-held");
    await expect(readFile(journal, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await f.dispose();
  });
});

describe("W-asm-3 守卫接线：冻结后 append 拒（superseded）", () => {
  it("异已宣誓行注入盘面→check 冻结→append 拒", async () => {
    const f = createGuardedJournalWriterFactory({ bootId: "boot-1", now: () => "2026-10-09T00:00:00.000Z" });
    const w = f.writerFor(journal);
    await w.append(businessLine);
    // 绕过守卫直写盘面模拟异已宣誓（epoch=2 别的 bootId）——真实面=L1 锁被绕过+L2 检测
    const { appendFile } = await import("node:fs/promises");
    await appendFile(journal, `${JSON.stringify({ t: "writer", epoch: 2, bootId: "intruder", at: "2026-10-09T00:01:00.000Z" })}\n`);
    await expect(w.append({ ...businessLine, intentId: "i2" })).rejects.toThrow("guarded-writer:writer-superseded");
    // 冻结粘性：后续 append 全拒
    await expect(w.append({ ...businessLine, intentId: "i3" })).rejects.toThrow("guarded-writer:writer-superseded");
    await f.dispose();
  });

  it("盘面他写但无异已宣誓→foreign-write-detected 保守冻结", async () => {
    const f = createGuardedJournalWriterFactory({ bootId: "boot-1", now: () => "2026-10-09T00:00:00.000Z" });
    const w = f.writerFor(journal);
    await w.append(businessLine);
    const { appendFile } = await import("node:fs/promises");
    await appendFile(journal, `${JSON.stringify({ t: "settled", intentId: "x1" })}\n`); // 无宣誓的他写（绕锁直写）
    await expect(w.append({ ...businessLine, intentId: "i2" })).rejects.toThrow("guarded-writer:foreign-write-detected");
    await f.dispose();
  });
});

describe("W-asm-4 字节记账：noteAppended=serializeJournalLine 实长（P02-D1 同源）", () => {
  it("多行 append 后盘面 size 与守卫基线一致（下一 check ok=记账无漂移）", async () => {
    const f = createGuardedJournalWriterFactory({ bootId: "boot-1", now: () => "2026-10-09T00:00:00.000Z" });
    const w = f.writerFor(journal);
    for (let i = 0; i < 5; i++) {
      await w.append({ ...businessLine, intentId: `i${i}` });
    }
    // 第 6 次 check 仍 ok（size 漂移会 foreign-write 拒——记账错位即暴露于此）
    await w.append({ ...businessLine, intentId: "i5" });
    const got = await lines(journal);
    expect(got.filter((l) => l.t === "enqueue")).toHaveLength(6);
    await f.dispose();
  });
});

describe("W-asm-5 关停序：dispose 后 append 拒+锁已清+工厂拒新构造", () => {
  it("全序：写→dispose（释放）→append 拒→writerFor 抛", async () => {
    const f = createGuardedJournalWriterFactory({ bootId: "boot-1", now: () => "2026-10-09T00:00:00.000Z" });
    const w = f.writerFor(journal);
    await w.append(businessLine);
    await f.dispose();
    await expect(w.append({ ...businessLine, intentId: "i2" })).rejects.toThrow();
    expect(() => f.writerFor(journal)).toThrow("已销毁");
    // 锁已释放：新工厂可正常装配（新 epoch 递增=重启面 W-asm-6 单元缩影）
    const f2 = createGuardedJournalWriterFactory({ bootId: "boot-2", now: () => "2026-10-09T00:02:00.000Z" });
    await f2.writerFor(journal).append({ ...businessLine, intentId: "i3" });
    const scan = scanWriterEpoch(await lines(journal));
    expect(scan.maxEpoch).toBe(2); // 新工厂 epoch=2
    expect(scan.latestBootId).toBe("boot-2");
    await f2.dispose();
  });
});

describe("W-asm-7 双实例拒：同 journal 第二工厂（第二实例）锁拒+零写", () => {
  it("实例 A 在写，实例 B 全拒且不破坏 A", async () => {
    const fa = createGuardedJournalWriterFactory({ bootId: "boot-a", now: () => "2026-10-09T00:00:00.000Z" });
    const wa = fa.writerFor(journal);
    await wa.append(businessLine);
    const fb = createGuardedJournalWriterFactory({ bootId: "boot-b", now: () => "2026-10-09T00:00:00.000Z" });
    await expect(fb.writerFor(journal).append({ ...businessLine, intentId: "i2" })).rejects.toThrow("guarded-writer:writer-lock-held");
    // A 不受影响（B 零副作用）
    await wa.append({ ...businessLine, intentId: "i3" });
    await fb.dispose();
    await fa.dispose();
  });
});

describe("守卫壳杂项（bad-tail 面+同实例幂等）", () => {
  it("撕裂尾 journal→writer-bad-tail 恒拒（oath 门拒，修复走 1a 面不入装配链）", async () => {
    await writeFile(journal, `${JSON.stringify({ t: "settled", intentId: "x1" })}` , "utf8"); // 无换行=撕裂尾
    const f = createGuardedJournalWriterFactory({ bootId: "boot-1", now: () => "2026-10-09T00:00:00.000Z" });
    await expect(f.writerFor(journal).append(businessLine)).rejects.toThrow("guarded-writer:writer-bad-tail");
    await f.dispose();
  });

  it("同文件 writerFor 幂等同实例（TurnGate/Coordinator 共用）", async () => {
    const f = createGuardedJournalWriterFactory({ bootId: "boot-1", now: () => "2026-10-09T00:00:00.000Z" });
    const w1 = f.writerFor(journal);
    const w2 = f.writerFor(journal);
    expect(w1).toBe(w2);
    await f.dispose();
  });

  it("durabilityFor 接缝注入替身（单元可控底座）", async () => {
    const appended: JournalLine[] = [];
    const fake: DurabilityPort = { append: async (l) => { appended.push(l); } };
    const f = createGuardedJournalWriterFactory({ bootId: "boot-1", durabilityFor: () => fake, now: () => "2026-10-09T00:00:00.000Z" });
    const w = f.writerFor(journal);
    await w.append(businessLine);
    expect(appended).toEqual([businessLine]); // 守卫门外底座恰收一行
    await f.dispose();
  });
});
