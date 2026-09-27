// P0-1b 裁决持久化（PROJECT P0 冻结序②；设计=docs/p0-1b-adjudicate-design.md）测试矩阵 R1-R10。
// 核心语义：两种 subject（fragment={raw,intentId}/repair=四元组）身份统一锚在修复事务
// （sha256(raw)===removedSha256 或四元组全等）——裁决必须在物理修复后落盘（修复前追加会破坏
// 撕裂尾结构且裁决不可先于事实）。落盘=append+sync+锚点转移（否则下轮捕获 concurrent-modification
// 拒快照）。读面：repair 行配对裁决（四元组或 sha）解锁修复阴影；fragment 裁决派生
// resend（授权重发，覆盖 unknown 排除）/abandon（终局放弃，resumable 排除）；旧快照
// repairUndecided 粘滞恒阻断（换新快照配对解锁）。
import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { adjudicateJournal, type AdjudicateSubject } from "../../../apps/server/src/runtime/adjudicate-journal.ts";
import { buildRecoverReport, parseJournalText, recoverFromSnapshot } from "../../../apps/server/src/runtime/recover.ts";
import { createRecoveryEvidenceProvider, isRecoverySnapshot, type RecoveryEvidenceSnapshot } from "../../../apps/server/src/runtime/recovery-evidence-source.ts";
import { withRepair } from "../../../apps/server/src/runtime/recover.ts";
import type { JournalLine } from "@pi-agent-ui/protocol";

const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
const jl = (i: string) => JSON.stringify({ t: "enqueue", intentId: i, sessionId: "q", generation: 1, leafId: "L", matchKey: { textHash: "h", attachmentIdentity: "a", ordinal: 1 }, payload: { kind: "prompt", rawText: "t", attachments: [], sentAt: "1" } });
const send = (i: string) => JSON.stringify({ t: "sending", intentId: i });
const repairRow = (byteStart: number, byteEnd: number, removedSha256: string, at = "2026-10-05T00:00:00.000Z") =>
  JSON.stringify({ t: "repair", reason: "torn-tail", byteStart, byteEnd, removedSha256, buildId: "b1", contractVersion: 2, at });
const adjFrag = (raw: string, intentId: string, verdict: "resend" | "abandon", at = "2026-10-06T00:00:00.000Z") =>
  JSON.stringify({ t: "adjudicate", subject: { kind: "fragment", raw, intentId }, verdict, operator: "host", buildId: "b1", contractVersion: 2, at });
const adjRepair = (removedSha256: string, byteStart: number, byteEnd: number, rat = "2026-10-05T00:00:00.000Z", verdict: "resend" | "abandon" = "resend") =>
  JSON.stringify({ t: "adjudicate", subject: { kind: "repair", removedSha256, byteStart, byteEnd, at: rat }, verdict, operator: "host", buildId: "b1", contractVersion: 2, at: "2026-10-06T00:00:00.000Z" });
const fragSubject = (raw: string, intentId: string): AdjudicateSubject => ({ kind: "fragment", raw, intentId });
const repairSubject = (removedSha256: string, byteStart: number, byteEnd: number, at = "2026-10-05T00:00:00.000Z"): AdjudicateSubject => ({ kind: "repair", removedSha256, byteStart, byteEnd, at });

interface Env { roots: string; evidenceDir: string; file: string; abs: string }

/** 构造「修复后」盘面：journal 完整行+repair 行（\n 收尾）。撕裂原文由测试自持（宿主持证据）。 */
async function env(rows: string[]): Promise<Env> {
  const roots = await mkdtemp(join(tmpdir(), "adj-roots-"));
  const evidenceDir = await mkdtemp(join(tmpdir(), "adj-ev-"));
  const file = "q.jsonl";
  const abs = join(roots, file);
  await writeFile(abs, `${rows.join("\n")}\n`, "utf8");
  return { roots, evidenceDir, file, abs };
}

async function seedAnchor(e: Env): Promise<void> {
  const p = createRecoveryEvidenceProvider({ roots: [e.roots], evidenceDir: e.evidenceDir, trustFirstCapture: () => true });
  const r = await p(e.file);
  if (!isRecoverySnapshot(r)) throw new Error(`seedAnchor 失败：${JSON.stringify(r)}`);
}

/** 修复后重读（新 provider 实例=权威链）。 */
async function recapture(e: Env): Promise<RecoveryEvidenceSnapshot> {
  const p = createRecoveryEvidenceProvider({ roots: [e.roots], evidenceDir: e.evidenceDir, trustFirstCapture: () => false });
  const snap = await p(e.file);
  if (!isRecoverySnapshot(snap)) throw new Error(JSON.stringify(snap));
  return snap;
}

describe("P0-1b 裁决持久化（崩溃/重启矩阵 R1-R10）", () => {
  it("R1 裁决写失败：write-failed 零裁决落盘+锚不动；重试收敛（幂等安全）", async () => {
    const torn = `{"t":"sending","intentId":"i1","pay`;
    const e = await env([jl("i1"), send("i1"), repairRow(30, 66, sha(torn))]);
    await seedAnchor(e);
    const subj = repairSubject(sha(torn), 30, 66);
    const crash = async (abs: string) => {
      const real = await (await import("../../../apps/server/src/ws/safe-open.ts")).openSafeReadWrite(abs);
      const fh = real.fh as unknown as FileHandle;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (fh as any).appendFile = async () => { throw new Error("crash-before-sync"); };
      return { fh, size: real.size };
    };
    const r1 = await adjudicateJournal({ file: e.file, roots: [e.roots], evidenceDir: e.evidenceDir, subject: subj, verdict: "resend", operator: "host", buildId: "b1", at: "2026-10-06T00:00:00.000Z", openHandle: crash });
    expect(r1).toMatchObject({ kind: "aborted", reason: "write-failed" });
    expect(await readFile(e.abs, "utf8")).not.toContain('"t":"adjudicate"'); // 零裁决
    const snap = await recapture(e);
    expect(snap.lines.some((l) => l.t === "adjudicate")).toBe(false); // 盘面权威验证
    // 重试（真句柄）收敛
    const r2 = await adjudicateJournal({ file: e.file, roots: [e.roots], evidenceDir: e.evidenceDir, subject: subj, verdict: "resend", operator: "host", buildId: "b1", at: "2026-10-06T00:00:00.000Z" });
    expect(r2.kind).toBe("adjudicated");
    const after = await readFile(e.abs, "utf8");
    expect(after.trim().endsWith(adjRepair(sha(torn), 30, 66))).toBe(true);
    await rm(e.roots, { recursive: true, force: true }); await rm(e.evidenceDir, { recursive: true, force: true });
  });

  it("R2 已落盘未确认（重启重读）：裁决在场+配对解锁+撕裂意图恒 unknown", async () => {
    const torn = `{"t":"sending","intentId":"i1","pay`;
    const e = await env([jl("i1"), send("i1"), repairRow(30, 66, sha(torn))]);
    await seedAnchor(e);
    // 修复后未裁决：修复阴影阻断（RT19 语义）
    const before = recoverFromSnapshot(await recapture(e));
    expect(before.resumeBlocked).toBe(true);
    const r = await adjudicateJournal({ file: e.file, roots: [e.roots], evidenceDir: e.evidenceDir, subject: repairSubject(sha(torn), 30, 66), verdict: "resend", operator: "host", buildId: "b1", at: "2026-10-06T00:00:00.000Z" });
    expect(r.kind).toBe("adjudicated");
    // 「确认丢失后重启」：全新 provider 重读→裁决行在场→配对解锁
    const report = recoverFromSnapshot(await recapture(e));
    expect(report.resumeBlocked).toBe(false);
    expect(report.unknownEffect).toContain("i1"); // 撕裂 sending 恒效果未知（repair 裁决只解阴影不解效果）
    expect(report.resumable).toEqual([]); // unknown 意图不可重发
    await rm(e.roots, { recursive: true, force: true }); await rm(e.evidenceDir, { recursive: true, force: true });
  });

  it("R3 重复裁决：同 subject 同 verdict=idempotent 不落第二行；反 verdict=冲突拒（终局不可翻转）", async () => {
    const torn = `{"t":"sending","intentId":"i1","x`;
    const e = await env([jl("i1"), repairRow(22, 50, sha(torn))]);
    await seedAnchor(e);
    const subj = repairSubject(sha(torn), 22, 50);
    const first = await adjudicateJournal({ file: e.file, roots: [e.roots], evidenceDir: e.evidenceDir, subject: subj, verdict: "resend", operator: "host", buildId: "b1", at: "2026-10-06T00:00:00.000Z" });
    expect(first.kind).toBe("adjudicated");
    const dup = await adjudicateJournal({ file: e.file, roots: [e.roots], evidenceDir: e.evidenceDir, subject: subj, verdict: "resend", operator: "host", buildId: "b1", at: "2026-10-06T00:01:00.000Z" });
    expect(dup).toMatchObject({ kind: "idempotent", at: "2026-10-06T00:00:00.000Z" }); // 保留原裁决时点
    expect((await readFile(e.abs, "utf8")).split("\n").filter((l) => l.includes('"t":"adjudicate"')).length).toBe(1);
    const flip = await adjudicateJournal({ file: e.file, roots: [e.roots], evidenceDir: e.evidenceDir, subject: subj, verdict: "abandon", operator: "host", buildId: "b1", at: "2026-10-06T00:02:00.000Z" });
    expect(flip).toMatchObject({ kind: "aborted", reason: "conflicting-verdict" });
    await rm(e.roots, { recursive: true, force: true }); await rm(e.evidenceDir, { recursive: true, force: true });
  });

  it("R4 身份不在场：四元组/sha/intentId 不匹配均拒 subject-absent；读面 stale 裁决不解锁", async () => {
    const e = await env([jl("i1"), repairRow(22, 50, sha("real-tail"))]);
    await seedAnchor(e);
    // 写面三态拒
    expect(await adjudicateJournal({ file: e.file, roots: [e.roots], evidenceDir: e.evidenceDir, subject: repairSubject(sha("other"), 22, 50), verdict: "resend", operator: "host", buildId: "b1" })).toMatchObject({ kind: "aborted", reason: "subject-absent" });
    expect(await adjudicateJournal({ file: e.file, roots: [e.roots], evidenceDir: e.evidenceDir, subject: repairSubject(sha("real-tail"), 22, 51), verdict: "resend", operator: "host", buildId: "b1" })).toMatchObject({ kind: "aborted", reason: "subject-absent" });
    expect(await adjudicateJournal({ file: e.file, roots: [e.roots], evidenceDir: e.evidenceDir, subject: fragSubject(`{"t":"sending","intentId":"i2","x`, "i2"), verdict: "resend", operator: "host", buildId: "b1" })).toMatchObject({ kind: "aborted", reason: "subject-absent" }); // sha 不匹配 repair 行
    expect(await adjudicateJournal({ file: e.file, roots: [e.roots], evidenceDir: e.evidenceDir, subject: fragSubject("real-tail", "i9"), verdict: "resend", operator: "host", buildId: "b1" })).toMatchObject({ kind: "aborted", reason: "subject-absent" }); // sha 匹配但 intentId 不在重放范围
    expect(await readFile(e.abs, "utf8")).not.toContain('"t":"adjudicate"'); // 全拒零落行
    // 读面三态：无裁决/不匹配裁决阻断；匹配解锁
    const base = [JSON.parse(jl("i1")), JSON.parse(repairRow(22, 50, sha("real-tail")))] as JournalLine[];
    expect(buildRecoverReport(base, "q", { fragments: [], blocked: false }).resumeBlocked).toBe(true);
    const stale = [...base, JSON.parse(adjRepair(sha("other"), 22, 50))] as JournalLine[];
    expect(buildRecoverReport(stale, "q", { fragments: [], blocked: false }).resumeBlocked).toBe(true);
    const match = [...base, JSON.parse(adjRepair(sha("real-tail"), 22, 50))] as JournalLine[];
    expect(buildRecoverReport(match, "q", { fragments: [], blocked: false }).resumeBlocked).toBe(false);
    await rm(e.roots, { recursive: true, force: true }); await rm(e.evidenceDir, { recursive: true, force: true });
  });

  it("R5 裁决行撕裂：坏行阻断+残片证据保留（fail-closed，只多阻断不漏授权）", async () => {
    const tornAdj = adjFrag(`{"t":"sending"`, "i1", "resend").slice(0, 25);
    const { lines, bad } = parseJournalText(`${jl("i1")}\n${tornAdj}`);
    expect(lines.length).toBe(1);
    expect(bad.length).toBe(1);
    const report = buildRecoverReport(lines, "q", { fragments: bad, blocked: false });
    expect(report.resumeBlocked).toBe(true); // 未归因残片在场→阻断（裁决丢失不漏授权）
  });

  it("R6 repairUndecided 旧快照跨重启粘滞恒阻断；新捕获快照经配对解锁", async () => {
    const oldLines = [JSON.parse(jl("i1")), JSON.parse(send("i1"))] as JournalLine[];
    const oldSnap = { version: 1, file: "q.jsonl", sessionId: "q", lines: oldLines, bad: [], attributedFragments: [], repaired: false, pendingRepair: true, createdAt: "t" };
    const healed = withRepair(oldSnap as never);
    if (!isRecoverySnapshot(healed)) throw new Error("type");
    expect(recoverFromSnapshot(healed).resumeBlocked).toBe(true); // undecided 粘滞（裁决事实不在旧快照 lines——换新快照）
    const newLines = [...oldLines, JSON.parse(repairRow(10, 20, sha("tail-x"))), JSON.parse(adjRepair(sha("tail-x"), 10, 20))] as JournalLine[];
    const newSnap = { version: 1, file: "q.jsonl", sessionId: "q", lines: newLines, bad: [], attributedFragments: [], repaired: false, pendingRepair: false, createdAt: "t" };
    expect(recoverFromSnapshot(newSnap as never).resumeBlocked).toBe(false); // 配对解锁
  });

  it("R7 合法裁决只解锁对应事务：他事务未裁决仍阻断（事务间互不串扰）", async () => {
    const torn1 = `{"t":"sending","intentId":"i1","x`;
    const torn2 = `{"t":"sending","intentId":"i2","y`;
    // 两次独立修复事务（盘面最终态：两行 repair）
    const e = await env([jl("i1"), jl("i2"), repairRow(22, 50, sha(torn1)), repairRow(51, 79, sha(torn2), "2026-10-05T01:00:00.000Z")]);
    await seedAnchor(e);
    expect(recoverFromSnapshot(await recapture(e)).resumeBlocked).toBe(true); // 双事务均未裁决
    await adjudicateJournal({ file: e.file, roots: [e.roots], evidenceDir: e.evidenceDir, subject: repairSubject(sha(torn1), 22, 50), verdict: "resend", operator: "host", buildId: "b1", at: "2026-10-06T00:00:00.000Z" });
    expect(recoverFromSnapshot(await recapture(e)).resumeBlocked).toBe(true); // 事务2 阴影仍在
    await adjudicateJournal({ file: e.file, roots: [e.roots], evidenceDir: e.evidenceDir, subject: fragSubject(torn2, "i2"), verdict: "resend", operator: "host", buildId: "b1", at: "2026-10-06T00:01:00.000Z" }); // fragment subject（sha 锚）
    const final = recoverFromSnapshot(await recapture(e));
    expect(final.resumeBlocked).toBe(false); // 两事务均配对→解锁
    expect(final.resumable).toContain("i2"); // fragment resend 裁决=授权重发
    await rm(e.roots, { recursive: true, force: true }); await rm(e.evidenceDir, { recursive: true, force: true });
  });

  it("R8 修复事务未落盘（pending 期）：裁决 repair/fragment 对象均 subject-absent（裁决不可先于事实）", async () => {
    const e = await env([jl("i1"), send("i1")]); // 无 repair 行（marker 事务进行中）
    await seedAnchor(e);
    expect(await adjudicateJournal({ file: e.file, roots: [e.roots], evidenceDir: e.evidenceDir, subject: repairSubject(sha("pending"), 30, 66), verdict: "resend", operator: "host", buildId: "b1" })).toMatchObject({ kind: "aborted", reason: "subject-absent" });
    expect(await adjudicateJournal({ file: e.file, roots: [e.roots], evidenceDir: e.evidenceDir, subject: fragSubject(`{"t":"sending","intentId":"i1","x`, "i1"), verdict: "resend", operator: "host", buildId: "b1" })).toMatchObject({ kind: "aborted", reason: "subject-absent" });
    await rm(e.roots, { recursive: true, force: true }); await rm(e.evidenceDir, { recursive: true, force: true });
  });

  it("R9 abandon 裁决（fragment）：解锁阻断但 resumable 不含该意图（终局放弃）", async () => {
    const torn = `{"t":"sending","intentId":"i1","pay`;
    const e = await env([jl("i1"), jl("i2"), repairRow(30, 66, sha(torn))]);
    await seedAnchor(e);
    const r = await adjudicateJournal({ file: e.file, roots: [e.roots], evidenceDir: e.evidenceDir, subject: fragSubject(torn, "i1"), verdict: "abandon", operator: "host", buildId: "b1", at: "2026-10-06T00:00:00.000Z" });
    expect(r.kind).toBe("adjudicated");
    const report = recoverFromSnapshot(await recapture(e));
    expect(report.resumeBlocked).toBe(false); // 证据已消耗（abandon 也是裁决）
    expect(report.resumable).toEqual(["i2"]); // i1 终局放弃不重发；i2 无在途=安全可重发
    await rm(e.roots, { recursive: true, force: true }); await rm(e.evidenceDir, { recursive: true, force: true });
  });

  it("R10 生产路径派生：journal 行自派生（不依赖调用方内存归因）+resend 覆盖 unknown", async () => {
    const torn = `{"t":"sending","intentId":"i1","p`;
    const e = await env([jl("i1"), repairRow(22, 49, sha(torn))]);
    await seedAnchor(e);
    await adjudicateJournal({ file: e.file, roots: [e.roots], evidenceDir: e.evidenceDir, subject: fragSubject(torn, "i1"), verdict: "resend", operator: "host", buildId: "b1", at: "2026-10-06T00:00:00.000Z" });
    const snap = await recapture(e);
    expect(snap.attributedFragments).toEqual([]); // 快照面恒空（P0-1a 口径不变）
    const report = recoverFromSnapshot(snap); // 不传任何内存归因
    expect(report.resumeBlocked).toBe(false); // journal 行派生归因生效
    expect(report.resumable).toContain("i1"); // resend 裁决=授权重发（覆盖 unknown 排除）
    expect(report.attributedFragments).toContainEqual({ raw: torn, intentId: "i1" }); // 报告呈现派生裁决
    await rm(e.roots, { recursive: true, force: true }); await rm(e.evidenceDir, { recursive: true, force: true });
  });
});
