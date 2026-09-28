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
import { FileDurability } from "../../../apps/server/src/runtime/file-durability.ts";

import { spawnSync } from "node:child_process";
import { chmod, mkdir as mkdirRaw } from "node:fs/promises";
async function mkdirRecursive(p: string): Promise<void> { await mkdirRaw(p, { recursive: true }); }
function spawnSyncNode(script: string, args: string[]): { status: number | null; stdout: string } {
  const r = spawnSync(process.execPath, ["--experimental-transform-types", script, ...args], { encoding: "utf8", timeout: 45_000 });
  return { status: r.status, stdout: String(r.stdout ?? "") + String(r.stderr ?? "") };
}


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

describe("r2 根修：生命周期队列（GPT r1 审 R1/R2/R3 杀点）", () => {
  it("R1-交错1 boot 在途 dispose：检查点中止零宣誓+锁当场释放+后继工厂可写", async () => {
    // 放大窗口：readJournal 暂停（acquire 已完成、oath 未跑——检查点②拦截位）
    let resumeRead: (() => void) | null = null;
    const gate = new Promise<void>((res) => { resumeRead = res; });
    const f = createGuardedJournalWriterFactory({
      bootId: "boot-a", now: () => "2026-10-09T00:00:00.000Z",
      readJournal: async (p) => { if (p === journal) await gate; return readFile(p, "utf8").catch(() => ""); },
    });
    const w = f.writerFor(journal);
    const bootP = (w as unknown as { writerBooted: Promise<unknown> }).writerBooted; // 观察在途
    const disposing = f.dispose(); // boot 在途时关停（不 await——观察交错）
    await new Promise((r) => setTimeout(r, 20)); // dispose 置位+drainAndClose 入队等待
    resumeRead!(); // 放行 boot：恢复后见 disposed → 检查点② 中止
    await Promise.all([bootP, disposing]);
    // 断言：零宣誓（journal 不存在或空）+锁已清
    await expect(readFile(journal, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(`${journal}.writer.lock`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    // 后继工厂可正常装配写（无锁污染）
    const g = createGuardedJournalWriterFactory({ bootId: "boot-b", now: () => "2026-10-09T00:00:01.000Z" });
    await g.writerFor(journal).append(businessLine);
    const ls = await lines(journal);
    expect(ls.filter((l) => l.t === "writer")).toHaveLength(1); // 恰一代（无旧 boot 污染）
    expect(ls.some((l) => l.t === "enqueue" && l.intentId === "i1")).toBe(true); // businessLine 落盘
    await g.dispose();
  });

  it("R1-交错2 旧 boot 恢复不污染新持有者：read 暂停→dispose 完成→新工厂写→旧 boot 只得 failed", async () => {
    let resumeRead: (() => void) | null = null;
    let signalEntered: (() => void) | null = null;
    const gate = new Promise<void>((res) => { resumeRead = res; });
    const enteredRead = new Promise<void>((res) => { signalEntered = res; });
    const fA = createGuardedJournalWriterFactory({
      bootId: "boot-a", now: () => "2026-10-09T00:00:00.000Z",
      readJournal: async (p) => { if (p === journal) { signalEntered!(); await gate; } return readFile(p, "utf8").catch(() => ""); },
    });
    const wA = fA.writerFor(journal);
    await enteredRead; // 时序锚：boot 已进 readJournal（检查点①已过、disposed 尚 false）——本杀点真走检查点②
    const disposed = fA.dispose(); // 置位 disposed（汇合挂起等 boot）；放行不依赖 dispose 完成（自造死锁=接缝反模式）
    resumeRead!();
    await disposed;
    // 新工厂 B 接管同文件：锁可获取+正常写一轮
    const fB = createGuardedJournalWriterFactory({ bootId: "boot-b", now: () => "2026-10-09T00:00:01.000Z" });
    const wB = fB.writerFor(journal);
    await wB.append(businessLine);
    // 旧 boot 恢复：检查点②（disposed 已置）→failed 零宣誓——B 的盘面不被污染
    const bootA = (wA as unknown as { writerBooted: Promise<{ kind: string }> }).writerBooted;
    await expect(bootA).resolves.toMatchObject({ kind: "failed" });
    const ls = await lines(journal);
    expect(ls.filter((l) => l.t === "writer")).toHaveLength(1); // 恰 B 一代（无 A 旧 epoch 污染）
    // B 后续仍可写（未被 foreign 冻结）
    await wB.append({ t: "settled", intentId: "i-b2" });
    expect((await lines(journal)).some((l) => l.t === "settled" && l.intentId === "i-b2")).toBe(true);
    await fB.dispose();
  });

  it("R2 同写者并发 append 不自冻：A 在 datasync 窗口 B 紧随——两行都成+无 foreign 冻结", async () => {
    // 真底座包延迟层放大窗口：首 append 落盘慢返（替身不写盘会致记账/盘面脱节——真 fdatasync 语义）
    let firstInFlight: (() => void) | null = null;
    const release = new Promise<void>((res) => { firstInFlight = res; });
    const real = new FileDurability(journal);
    const origAppend = real.append.bind(real);
    let appendCount = 0;
    const appended: JournalLine[] = [];
    real.append = async (l: JournalLine): Promise<void> => {
      appendCount += 1;
      if (appendCount === 1) { firstInFlight!(); await new Promise<void>((r) => setTimeout(r, 40)); } // 首行慢返（落盘前）
      await origAppend(l);
      appended.push(l);
    };
    const f = createGuardedJournalWriterFactory({
      bootId: "boot-a", now: () => "2026-10-09T00:00:00.000Z",
      durabilityFor: () => real,
    });
    const w = f.writerFor(journal);
    const p1 = w.append({ t: "settled", intentId: "i-1" });
    await release; // 首行已进底座未返回
    const p2 = w.append({ t: "settled", intentId: "i-2" }); // 紧随（r1 版此处自冻）
    await Promise.all([p1, p2]);
    expect(appended.map((l) => (l as { intentId?: string }).intentId)).toEqual(["i-1", "i-2"]);
    await w.append({ t: "settled", intentId: "i-3" }); // 无粘性冻结：第三行仍可写
    expect(appended).toHaveLength(3);
    await f.dispose();
  });

  it("R3 装配 I/O 异常不杀进程（无 append 消费者）：子进程实跑 exit=0+后续 append 恒拒", { timeout: 60_000 }, async () => {
    // GPT boot-reject 探针复现口径：writerFor 后不 await 不 append——若 bootP rejection 逃逸=unhandled 杀进程（r1 实锤 exit=1）
    const script = join(dir, "boot-reject-probe.mts");
    await writeFile(script, `import { createGuardedJournalWriterFactory } from ${JSON.stringify(new URL("file:///home/yyj/ai/repos/pi-agent-ui/apps/server/src/runtime/guarded-journal-writer.ts").href)};
const f = createGuardedJournalWriterFactory({ bootId: "boot-a", now: () => "2026-10-09T00:00:00.000Z" });
const w = f.writerFor(process.argv[2]!); // 父目录 EACCES：取锁 I/O 失败
await new Promise((r) => setTimeout(r, 200)); // 给 unhandled rejection 逃逸窗口
try { await w.append({ t: "settled", intentId: "x" }); console.log("APPEND-OK（意外）"); } catch (e) { console.log("APPEND-REJECT " + String(e).slice(0, 60)); }
await f.dispose();
console.log("SURVIVED");
`, "utf8");
    const locked = join(dir, "noaccess", "s.jsonl");
    await mkdirRecursive(join(dir, "noaccess"));
    await chmod(join(dir, "noaccess"), 0o555); // 无写：acquire open(O_EXCL|O_CREAT) EACCES
    const r = spawnSyncNode(script, [locked]);
    expect(r.status).toBe(0); // r1 版此处 exit=1（unhandled rejection 杀进程）
    expect(r.stdout).toContain("SURVIVED");
    expect(r.stdout).toContain("APPEND-REJECT"); // fail-closed：写面恒拒
  });
});
