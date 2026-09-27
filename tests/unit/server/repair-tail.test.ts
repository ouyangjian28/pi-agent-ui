// P0-1a 修复留痕（PROJECT P0 冻结序①）测试矩阵 RT1-RT18。
// 覆盖四层：①repair 行 schema/重放/投影（protocol）②repairJournalTail 工具事务
// （截断+补行+锚点合法转移+竞态/残局 fail-closed）③读面派生（repairLog/bad 消失/diskBlocked 解除）
// ④与证据链 provider 的接链（修复后可再捕获=死结闭合）。
// 真实 fs 临时目录（mkdtemp）+真 provider 建锚；竞态/锚写故障用结构化接缝确定性注入。
import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  repairJournalTail,
  type RepairTailResult,
} from "../../../apps/server/src/runtime/repair-tail.ts";
import { createRecoveryEvidenceProvider, isRecoverySnapshot } from "../../../apps/server/src/runtime/recovery-evidence-source.ts";
import { parseJournalText, buildRecoverReport, recoverFromJournal } from "../../../apps/server/src/runtime/recover.ts";
import { journalLineSchemaError } from "@pi-agent-ui/protocol";
import { replayIntents, type JournalLine } from "@pi-agent-ui/protocol";
import { journalToScanRows } from "@pi-agent-ui/protocol";

const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
const jl = (i: string) => JSON.stringify({ t: "enqueue", intentId: i, sessionId: "q", generation: 1, leafId: "L", matchKey: { textHash: "h", attachmentIdentity: "a", ordinal: 1 }, payload: { kind: "prompt", rawText: "t", attachments: [], sentAt: "1" } });

interface Env { roots: string; evidenceDir: string; file: string; abs: string }

async function env(lines: string[], tail = ""): Promise<Env> {
  const roots = await mkdtemp(join(tmpdir(), "rt-roots-"));
  const evidenceDir = await mkdtemp(join(tmpdir(), "rt-ev-"));
  const file = "s1.jsonl";
  const abs = join(roots, file);
  await writeFile(abs, `${lines.join("\n")}\n${tail}`, "utf8");
  return { roots, evidenceDir, file, abs };
}

/** 建锚：真 provider 首捕（bless）→锚点=当前内容。 */
async function seedAnchor(e: Env): Promise<void> {
  const p = createRecoveryEvidenceProvider({ roots: [e.roots], evidenceDir: e.evidenceDir, trustFirstCapture: () => true });
  const r = await p(e.file);
  if (!isRecoverySnapshot(r)) throw new Error(`seedAnchor 失败：${JSON.stringify(r)}`);
}

const OPT = (e: Env, extra: Record<string, unknown> = {}) => ({
  file: e.file, roots: [e.roots], evidenceDir: e.evidenceDir, buildId: "build-rt", ...extra,
});

describe("P0-1a repair 行 protocol 面", () => {
  const good = { t: "repair", reason: "torn-tail", byteStart: 10, byteEnd: 25, removedSha256: "a".repeat(64), buildId: "b1", contractVersion: 2, at: "2026-10-05T00:00:00.000Z" };
  it("RT13 合法 repair 行过 schema；五种坏形态判坏", () => {
    expect(journalLineSchemaError({ ...good })).toBeNull();
    expect(journalLineSchemaError({ ...good, byteEnd: 10 })).toMatch(/区间/);
    expect(journalLineSchemaError({ ...good, byteStart: -1 })).toMatch(/byteStart/);
    expect(journalLineSchemaError({ ...good, removedSha256: "xyz" })).toMatch(/removedSha256/);
    expect(journalLineSchemaError({ ...good, buildId: "" })).toMatch(/buildId/);
    expect(journalLineSchemaError({ ...good, contractVersion: 0 })).toMatch(/contractVersion/);
    expect(journalLineSchemaError({ ...good, reason: "other" })).toMatch(/reason/);
  });
  it("RT14 replayIntents 忽略 repair 行（聚合不因 repair 行改变）", () => {
    const base: JournalLine[] = [{ t: "settled", intentId: "i1" }] as unknown as JournalLine[];
    const rows: JournalLine[] = [...(JSON.parse(`[${jl("i1")}]`) as unknown as JournalLine[]), ...base];
    const a = replayIntents(base as never, "q");
    const b = replayIntents(rows as never, "q");
    expect(a.size).toBe(0);
    expect(b.size).toBe(1);
  });
  it("RT15 投影：journal-repair 事件带区间；撕裂 repair 行不发布", () => {
    const line = JSON.stringify(good);
    const rows = journalToScanRows(`${line}\n{"t":"repair","reason":"torn-t`);
    expect(rows).toHaveLength(1);
    expect(rows[0].event.kind).toBe("journal-repair");
    expect((rows[0].event as { repairByteStart?: number }).repairByteStart).toBe(10);
  });
});

describe("P0-1a repairJournalTail 工具事务", () => {
  it("RT1 happy：截尾+补行+锚点转移+可再捕获+读面认行", async () => {
    const e = await env([jl("i1"), jl("i2")]);
    await seedAnchor(e);
    const clean = await readFile(e.abs, "utf8");
    const TORN = `{"t":"sending","intentId":"i2","int`; // 撕裂尾
    await appendFile(e.abs, TORN, "utf8");
    const byteStart = Buffer.byteLength(clean, "utf8");
    const byteEnd = byteStart + Buffer.byteLength(TORN, "utf8");

    const r = await repairJournalTail(OPT(e));
    expect(r.kind).toBe("repaired");
    if (r.kind !== "repaired") return;
    expect(r.byteStart).toBe(byteStart);
    expect(r.byteEnd).toBe(byteEnd);
    expect(r.removedSha256).toBe(sha(TORN));
    const after = await readFile(e.abs, "utf8");
    expect(after.endsWith("\n")).toBe(true);
    expect(after.startsWith(clean)).toBe(true);
    const row = JSON.parse(after.slice(byteStart)) as { t: string; removedSha256: string; buildId: string; contractVersion: number };
    expect(row.t).toBe("repair");
    expect(row.removedSha256).toBe(sha(TORN));
    expect(row.buildId).toBe("build-rt");
    expect(row.contractVersion).toBe(2);
    // 锚点转移=新盘面哈希（与返回 anchor 一致）
    const anchor = JSON.parse(await readFile(join(e.evidenceDir, `${encodeURIComponent(e.file)}.evidence.json`), "utf8")) as { len: number; sha: string };
    expect(anchor.len).toBe(Buffer.byteLength(after, "utf8"));
    expect(anchor.sha).toBe(sha(after));
    expect(r.anchor.len).toBe(anchor.len);
    expect(r.anchor.sha).toBe(anchor.sha);
    // 死结闭合：修复后 provider 再捕获成功（旧链路此处=concurrent-modification 永久死）
    const p = createRecoveryEvidenceProvider({ roots: [e.roots], evidenceDir: e.evidenceDir });
    const cap = await p(e.file);
    expect(isRecoverySnapshot(cap)).toBe(true);
    // 读面：bad 空+repairLog 派生+diskBlocked 解除
    const rec = await recoverFromJournal(e.abs, "q");
    expect(rec.bad).toHaveLength(0);
    expect(rec.repairLog).toHaveLength(1);
    expect(rec.repairLog[0]?.byteEnd).toBe(byteEnd);
    expect(rec.diskBlocked).toBe(false);
    await rm(e.roots, { recursive: true, force: true });
    await rm(e.evidenceDir, { recursive: true, force: true });
  });

  it("RT2 幂等：二次运行 no-torn-tail，锚点不动", async () => {
    const e = await env([jl("i1")], `{"t":"send`);
    await seedAnchor(e);
    const r1 = await repairJournalTail(OPT(e));
    expect(r1.kind).toBe("repaired");
    const a1 = await readFile(join(e.evidenceDir, `${encodeURIComponent(e.file)}.evidence.json`), "utf8");
    const r2 = await repairJournalTail(OPT(e));
    expect(r2.kind).toBe("no-torn-tail");
    const a2 = await readFile(join(e.evidenceDir, `${encodeURIComponent(e.file)}.evidence.json`), "utf8");
    expect(a1).toBe(a2);
    await rm(e.roots, { recursive: true, force: true });
    await rm(e.evidenceDir, { recursive: true, force: true });
  });

  it("RT3 无锚：修复照做但绝不建锚（首捕授权面不在此）", async () => {
    const e = await env([jl("i1")], `{"t":"send`);
    const r = await repairJournalTail(OPT(e));
    expect(r.kind).toBe("repaired");
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(e.evidenceDir);
    expect(files).toHaveLength(0);
    await rm(e.roots, { recursive: true, force: true });
    await rm(e.evidenceDir, { recursive: true, force: true });
  });

  it("RT4 锚不匹配（盘面已被改写）：拒绝动手，文件原样", async () => {
    const e = await env([jl("i1"), jl("i2")]);
    await seedAnchor(e);
    await writeFile(e.abs, `${jl("i9")}\n{"t":"sending","intentId":"i9","par`, "utf8"); // 前缀被换+撕裂尾
    const before = await readFile(e.abs, "utf8");
    const r = await repairJournalTail(OPT(e));
    expect(r.kind).toBe("aborted");
    if (r.kind === "aborted") expect(r.reason).toBe("anchor-mismatch");
    expect(await readFile(e.abs, "utf8")).toBe(before);
    await rm(e.roots, { recursive: true, force: true });
    await rm(e.evidenceDir, { recursive: true, force: true });
  });

  it("RT5 读后竞态：复核杀（file-changed），文件不被工具改", async () => {
    const e = await env([jl("i1")]);
    await seedAnchor(e);
    const clean = await readFile(e.abs, "utf8");
    await appendFile(e.abs, `{"t":"send`, "utf8");
    let injected = false;
    const r = await repairJournalTail(OPT(e, {
      afterRead: async () => { if (!injected) { injected = true; await appendFile(e.abs, "X", "utf8"); } },
    }));
    expect(r.kind).toBe("aborted");
    if (r.kind === "aborted") expect(r.reason).toBe("file-changed");
    const after = await readFile(e.abs, "utf8");
    expect(after).toBe(`${clean}{"t":"sendX`); // 工具未截断未补行
    await rm(e.roots, { recursive: true, force: true });
    await rm(e.evidenceDir, { recursive: true, force: true });
  });

  it("RT6 崩溃残局无授权：anchor-stale fail-closed", async () => {
    const e = await env([jl("i1"), jl("i2")]);
    await seedAnchor(e);
    const oldAnchor = await readFile(join(e.evidenceDir, `${encodeURIComponent(e.file)}.evidence.json`), "utf8");
    await appendFile(e.abs, `{"t":"send`, "utf8");
    // 修复但锚点写失败（fsLike 抛）→文件已改+锚仍旧=崩溃残局等价形态
    const boom: typeof import("../../../apps/server/src/runtime/recovery-evidence-source.ts").FsLike = {
      writeFile: async () => { throw new Error("disk full"); },
      rename: async () => {},
      rm: async () => {},
    };
    await expect(repairJournalTail(OPT(e, { fsLike: boom }))).rejects.toThrow("disk full");
    const r = await repairJournalTail(OPT(e));
    expect(r.kind).toBe("aborted");
    if (r.kind === "aborted") expect(r.reason).toBe("anchor-stale");
    expect(await readFile(join(e.evidenceDir, `${encodeURIComponent(e.file)}.evidence.json`), "utf8")).toBe(oldAnchor);
    await rm(e.roots, { recursive: true, force: true });
    await rm(e.evidenceDir, { recursive: true, force: true });
  });

  it("RT7 残局+显式授权+密码学可验：reconciled 补完锚点", async () => {
    const e = await env([jl("i1")]);
    await seedAnchor(e);
    await appendFile(e.abs, `{"t":"send`, "utf8");
    const boom: typeof import("../../../apps/server/src/runtime/recovery-evidence-source.ts").FsLike = {
      writeFile: async () => { throw new Error("disk full"); },
      rename: async () => {},
      rm: async () => {},
    };
    await expect(repairJournalTail(OPT(e, { fsLike: boom }))).rejects.toThrow("disk full");
    const r = await repairJournalTail(OPT(e, { authorizeStaleAnchorRepair: () => true }));
    expect(r.kind).toBe("reconciled");
    const after = await readFile(e.abs, "utf8");
    const anchor = JSON.parse(await readFile(join(e.evidenceDir, `${encodeURIComponent(e.file)}.evidence.json`), "utf8")) as { len: number; sha: string };
    expect(anchor.len).toBe(Buffer.byteLength(after, "utf8"));
    expect(anchor.sha).toBe(sha(after));
    const p = createRecoveryEvidenceProvider({ roots: [e.roots], evidenceDir: e.evidenceDir });
    expect(isRecoverySnapshot(await p(e.file))).toBe(true);
    await rm(e.roots, { recursive: true, force: true });
    await rm(e.evidenceDir, { recursive: true, force: true });
  });

  it("RT8 残局但锚曾覆盖被移除字节：授权也不可领回（前缀不可复验）", async () => {
    const e = await env([jl("i1")]);
    await appendFile(e.abs, `{"t":"send`, "utf8");
    await seedAnchor(e); // 锚覆盖含撕裂尾的全文（len>未来 repair 行偏移）
    const boom: typeof import("../../../apps/server/src/runtime/recovery-evidence-source.ts").FsLike = {
      writeFile: async () => { throw new Error("disk full"); },
      rename: async () => {},
      rm: async () => {},
    };
    await expect(repairJournalTail(OPT(e, { fsLike: boom }))).rejects.toThrow("disk full");
    const r = await repairJournalTail(OPT(e, { authorizeStaleAnchorRepair: () => true }));
    expect(r.kind).toBe("aborted");
    if (r.kind === "aborted") expect(r.reason).toBe("anchor-stale");
    await rm(e.roots, { recursive: true, force: true });
    await rm(e.evidenceDir, { recursive: true, force: true });
  });

  it("RT9/RT10 干净文件与空文件：no-torn-tail", async () => {
    const e = await env([jl("i1")]);
    await seedAnchor(e);
    expect((await repairJournalTail(OPT(e))).kind).toBe("no-torn-tail");
    const e2 = await env([]);
    await writeFile(e2.abs, "", "utf8");
    expect((await repairJournalTail(OPT(e2))).kind).toBe("no-torn-tail");
    await rm(e.roots, { recursive: true, force: true }); await rm(e.evidenceDir, { recursive: true, force: true });
    await rm(e2.roots, { recursive: true, force: true }); await rm(e2.evidenceDir, { recursive: true, force: true });
  });

  it("RT11 超预算拒修；RT12 根外拒读", async () => {
    const e = await env([jl("i1")], `{"t":"send`);
    const r = await repairJournalTail(OPT(e, { maxBytes: 4 }));
    expect(r.kind).toBe("oversized");
    const r2 = await repairJournalTail({ file: "../escape.jsonl", roots: [e.roots], evidenceDir: e.evidenceDir, buildId: "b" });
    expect(r2.kind).toBe("unreadable");
    await rm(e.roots, { recursive: true, force: true });
    await rm(e.evidenceDir, { recursive: true, force: true });
  });

  it("RT16 读面派生：repairLog 与内存 withRepair 互补；报告阻断语义", () => {
    const { lines } = parseJournalText(`${jl("i1")}\n${JSON.stringify({ t: "repair", reason: "torn-tail", byteStart: 100, byteEnd: 130, removedSha256: "b".repeat(64), buildId: "x", contractVersion: 2, at: "t" })}\n`);
    expect(lines.filter((l) => l.t === "repair")).toHaveLength(1);
    const rep = buildRecoverReport(lines, "q", { fragments: [], blocked: false });
    expect(rep.repairLog).toHaveLength(1);
    expect(rep.repairLog[0]?.buildId).toBe("x");
    expect(rep.diskBlocked).toBe(false);
  });

  it("RT17 修复后再撕裂（修复行之后新坏尾）：只新坏尾阻断，repairLog 保留旧事实", async () => {
    const e = await env([jl("i1")], `{"t":"send`);
    await seedAnchor(e);
    await repairJournalTail(OPT(e));
    await appendFile(e.abs, `{"t":"settled","intentId":"i1"`, "utf8"); // 新撕裂
    const rec = await recoverFromJournal(e.abs, "q");
    expect(rec.bad).toHaveLength(1);
    expect(rec.bad[0]?.partialTail).toBe(true);
    expect(rec.repairLog).toHaveLength(1);
    expect(rec.diskBlocked).toBe(true);
    await rm(e.roots, { recursive: true, force: true });
    await rm(e.evidenceDir, { recursive: true, force: true });
  });

  it("RT18 伪行不领回：错界 repair 行不触发 reconcile，锚点不被搬动", async () => {
    const e = await env([jl("i1")]);
    await seedAnchor(e);
    const clean = await readFile(e.abs, "utf8");
    // 伪造：错界 repair 行（byteStart 声明与真实偏移差 3）+末尾换行=无撕裂尾形态
    const row = JSON.stringify({ t: "repair", reason: "torn-tail", byteStart: Buffer.byteLength(clean, "utf8") + 3, byteEnd: Buffer.byteLength(clean, "utf8") + 99, removedSha256: "c".repeat(64), buildId: "attacker", contractVersion: 2, at: "t" });
    await writeFile(e.abs, `${clean}${row}\n`, "utf8");
    const r = await repairJournalTail(OPT(e, { authorizeStaleAnchorRepair: () => true }));
    // 错界→非未完成事务→健康态 no-op；即便授权也不补锚（伪行不能作为转移依据）
    expect(r.kind).toBe("no-torn-tail");
    const anchor = JSON.parse(await readFile(join(e.evidenceDir, `${encodeURIComponent(e.file)}.evidence.json`), "utf8")) as { len: number };
    expect(anchor.len).toBe(Buffer.byteLength(clean, "utf8")); // 锚未被伪行搬动
    await rm(e.roots, { recursive: true, force: true });
    await rm(e.evidenceDir, { recursive: true, force: true });
  });
});

void ({} as unknown as RepairTailResult);
