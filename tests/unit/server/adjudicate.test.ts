// P0-1b 裁决持久化 v2（GPT r1 B1-B5 修复批）测试矩阵 R1-R10。
// v2 身份模型：subject（fragment/repair）=修复事务四元组（removedSha256/byteStart/byteEnd/at），
// fragment 另携归因目标 intentId——同内容新事务（不同 at）不被旧裁决解锁（B1/P3）；同事务换
// 目标=conflicting-verdict（B3/P2）；raw 全文不入裁决行（B5/P7 撕裂字节+L2 膨胀）。
// 工具四道门：realpath 实根门（B4/P11）→盘面门（B2/P4/P10：marker 在场=repair-pending、
// 坏行/撕裂尾=bad-tail，均零改盘）→身份门（四元组唯一匹配 repair 行+目标在重放范围）→
// 幂等/冲突终局。落盘=append+sync（失败=提交结果不确定，幂等重试收敛）；锚转移失败不阻断
// （P1：provider 验锚只查旧前缀，纯扩展允许，下轮捕获收敛）。读面：有效裁决（四元组在场
// repairLog）派生 resend（覆盖 unknown）/abandon（resumable 排除）+配对解锁；同四元组多目标
// =冲突组整组无效（阴影保留）；stale 裁决不派生不呈现（L3/P9）。
import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { adjudicateJournal, type AdjudicateSubject } from "../../../apps/server/src/runtime/adjudicate-journal.ts";
import { buildRecoverReport, parseJournalText, recoverFromSnapshot } from "../../../apps/server/src/runtime/recover.ts";
import { repairJournalTail } from "../../../apps/server/src/runtime/repair-tail.ts";
import { createRecoveryEvidenceProvider, isRecoverySnapshot, type RecoveryEvidenceSnapshot } from "../../../apps/server/src/runtime/recovery-evidence-source.ts";
import type { JournalLine } from "@pi-agent-ui/protocol";

const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
const jl = (i: string) => JSON.stringify({ t: "enqueue", intentId: i, sessionId: "q", generation: 1, leafId: "L", matchKey: { textHash: "h", attachmentIdentity: "a", ordinal: 1 }, payload: { kind: "prompt", rawText: "t", attachments: [], sentAt: "1" } });
const send = (i: string) => JSON.stringify({ t: "sending", intentId: i });
const unknown = (i: string) => JSON.stringify({ t: "unknown", intentId: i, reason: "r" });
const repairRow = (byteStart: number, byteEnd: number, removedSha256: string, at = "2026-10-05T00:00:00.000Z") =>
  JSON.stringify({ t: "repair", reason: "torn-tail", byteStart, byteEnd, removedSha256, buildId: "b1", contractVersion: 2, at });
const adjFrag = (removedSha256: string, byteStart: number, byteEnd: number, rat: string, intentId: string, verdict: "resend" | "abandon", at = "2026-10-06T00:00:00.000Z") =>
  JSON.stringify({ t: "adjudicate", subject: { kind: "fragment", removedSha256, byteStart, byteEnd, at: rat, intentId }, verdict, operator: "host", buildId: "b1", contractVersion: 2, at });
const adjRepair = (removedSha256: string, byteStart: number, byteEnd: number, rat = "2026-10-05T00:00:00.000Z", verdict: "resend" | "abandon" = "resend") =>
  JSON.stringify({ t: "adjudicate", subject: { kind: "repair", removedSha256, byteStart, byteEnd, at: rat }, verdict, operator: "host", buildId: "b1", contractVersion: 2, at: "2026-10-06T00:00:00.000Z" });
const fragSubject = (removedSha256: string, byteStart: number, byteEnd: number, at: string, intentId: string): AdjudicateSubject => ({ kind: "fragment", removedSha256, byteStart, byteEnd, at, intentId });
const repairSubject = (removedSha256: string, byteStart: number, byteEnd: number, at = "2026-10-05T00:00:00.000Z"): AdjudicateSubject => ({ kind: "repair", removedSha256, byteStart, byteEnd, at });
const opts = (e: Env, subject: AdjudicateSubject, verdict: "resend" | "abandon", extra: Partial<Parameters<typeof adjudicateJournal>[0]> = {}) => ({
  file: e.file, roots: [e.roots], evidenceDir: e.evidenceDir, subject, verdict, operator: "host", buildId: "b1", ...extra,
});

interface Env { roots: string; evidenceDir: string; file: string; abs: string }

/** 构造「修复后」盘面：journal 完整行+repair 行（\n 收尾）。撕裂原文由测试自持（宿主持证据）。 */
async function env(rows: string[], content?: string): Promise<Env> {
  const roots = await mkdtemp(join(tmpdir(), "adj-roots-"));
  const evidenceDir = await mkdtemp(join(tmpdir(), "adj-ev-"));
  const file = "q.jsonl";
  const abs = join(roots, file);
  await writeFile(abs, content ?? `${rows.join("\n")}\n`, "utf8");
  return { roots, evidenceDir, file, abs };
}
const cleanup = async (e: Env) => { await rm(e.roots, { recursive: true, force: true }); await rm(e.evidenceDir, { recursive: true, force: true }); };

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

/** crash 句柄：appendFile 抛（写前失败形）。 */
async function crashAppend(abs: string): Promise<{ fh: FileHandle; size: number }> {
  const real = await (await import("../../../apps/server/src/ws/safe-open.ts")).openSafeReadWrite(abs);
  const fh = real.fh as unknown as FileHandle;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (fh as any).appendFile = async () => { throw new Error("crash-before-append"); };
  return { fh, size: real.size };
}
/** crash 句柄：append 正常真写、sync 抛（r2 L2 修正——旧形 appendFile 内抛使 sync 永不可达，
 *  无法区分「写前失败」与「写后失败」；本形 append 已落盘+sync 崩=提交结果不确定真形）。 */
async function crashSync(abs: string): Promise<{ fh: FileHandle; size: number }> {
  const real = await (await import("../../../apps/server/src/ws/safe-open.ts")).openSafeReadWrite(abs);
  const fh = real.fh as unknown as FileHandle;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (fh as any).sync = async () => { throw new Error("crash-sync"); };
  return { fh, size: real.size };
}

describe("P0-1b 裁决持久化 v2（崩溃/重启矩阵 R1-R10）", () => {
  it("R1a 写前失败：appendFile 抛=write-failed 零裁决+盘面逐字节不变；重试收敛", async () => {
    const torn = `{"t":"sending","intentId":"i1","pay`;
    const e = await env([jl("i1"), send("i1"), repairRow(30, 66, sha(torn))]);
    await seedAnchor(e);
    const before = await readFile(e.abs);
    const subj = repairSubject(sha(torn), 30, 66);
    const r1 = await adjudicateJournal({ ...opts(e, subj, "resend"), openHandle: crashAppend, at: "2026-10-06T00:00:00.000Z" });
    expect(r1).toMatchObject({ kind: "aborted", reason: "write-failed" });
    expect((await readFile(e.abs)).equals(before)).toBe(true); // 逐字节不变（非仅文本级）
    const r2 = await adjudicateJournal(opts(e, subj, "resend"));
    expect(r2.kind).toBe("adjudicated");
    await cleanup(e);
  });

  it("R1b 写后失败：append 落盘+sync 抛=提交结果不确定（裁决已在盘）→重试幂等收敛不落第二行", async () => {
    const torn = `{"t":"sending","intentId":"i1","pay`;
    const e = await env([jl("i1"), send("i1"), repairRow(30, 66, sha(torn))]);
    await seedAnchor(e);
    const subj = repairSubject(sha(torn), 30, 66);
    const r1 = await adjudicateJournal({ ...opts(e, subj, "resend"), openHandle: crashSync, at: "2026-10-06T00:00:00.000Z" });
    expect(r1).toMatchObject({ kind: "aborted", reason: "write-failed" });
    const after = await readFile(e.abs, "utf8");
    expect(after).toContain('"t":"adjudicate"'); // 结果不确定：裁决可能已在盘（本形确实在）
    // 幂等重试收敛（不因「结果不确定」落第二行）
    const r2 = await adjudicateJournal(opts(e, subj, "resend"));
    expect(r2).toMatchObject({ kind: "idempotent", at: "2026-10-06T00:00:00.000Z" });
    expect((await readFile(e.abs, "utf8")).split("\n").filter((l) => l.includes('"t":"adjudicate"')).length).toBe(1);
    await cleanup(e);
  });

  it("R2 转锚崩溃窗（P1 收敛）：append+sync 成功、锚转移抛=裁决在盘 anchorMoved:false；锚前缀不漂移（纯扩展）；重试幂等；重读解锁", async () => {
    const torn = `{"t":"sending","intentId":"i1","pay`;
    const e = await env([jl("i1"), send("i1"), repairRow(30, 66, sha(torn))]);
    await seedAnchor(e);
    const anchorPath = join(e.evidenceDir, `${encodeURIComponent(e.file)}.evidence.json`);
    const anchorBefore = JSON.parse(await readFile(anchorPath, "utf8")) as { len: number; sha: string };
    const subj = fragSubject(sha(torn), 30, 66, "2026-10-05T00:00:00.000Z", "i1"); // r4 双证：解锁面用 fragment 裁决（归因 i1）；repair-only 恰是要堵的洞（B-r3-2）
    const r1 = await adjudicateJournal({
      ...opts(e, subj, "resend"), at: "2026-10-06T00:00:00.000Z",
      writeAnchorImpl: async () => { throw new Error("crash-transfer"); },
    });
    expect(r1).toMatchObject({ kind: "adjudicated", anchorMoved: false });
    // 锚文件未动；盘面=旧内容纯扩展（旧锚前缀复验成立——provider 允许捕获，无死锁）
    const anchorAfter = JSON.parse(await readFile(anchorPath, "utf8")) as { len: number; sha: string };
    expect(anchorAfter).toEqual(anchorBefore);
    const disk = await readFile(e.abs);
    expect(disk.byteLength).toBeGreaterThan(anchorBefore.len);
    expect(sha(disk.subarray(0, anchorBefore.len))).toBe(anchorBefore.sha);
    // 重试幂等（原时点，不落第二行）；全新 provider 重读→裁决在场+配对解锁+撕裂意图恒 unknown
    const r2 = await adjudicateJournal(opts(e, subj, "resend"));
    expect(r2).toMatchObject({ kind: "idempotent", at: "2026-10-06T00:00:00.000Z" });
    const report = recoverFromSnapshot(await recapture(e));
    expect(report.resumeBlocked).toBe(false); // 双证齐（repair 对账+fragment 归因 i1）→解锁
    expect(report.unknownEffect).toContain("i1"); // fragment 裁决授权 resend，但撕裂意图在旧快照仍是 unknown（授权≠已处理）
    expect(report.resumable).toEqual(["i1"]); // r4：归因 resend → i1 可重发
    await cleanup(e);
  });

  it("R3 幂等/冲突终局：同四元组同目标同 verdict=幂等原时点；反 verdict 或换归因目标=conflicting-verdict", async () => {
    const torn = `{"t":"sending","intentId":"i1","x`;
    const e = await env([jl("i1"), jl("i2"), repairRow(22 + jl("i2").length + 1, 50 + jl("i2").length + 1, sha(torn))]);
    await seedAnchor(e);
    const at = "2026-10-05T00:00:00.000Z";
    const start = 22 + jl("i2").length + 1, end = 50 + jl("i2").length + 1;
    const subj = fragSubject(sha(torn), start, end, at, "i1");
    const first = await adjudicateJournal({ ...opts(e, subj, "abandon"), at: "2026-10-06T00:00:00.000Z" });
    expect(first.kind).toBe("adjudicated");
    const dup = await adjudicateJournal({ ...opts(e, subj, "abandon"), at: "2026-10-06T00:01:00.000Z" });
    expect(dup).toMatchObject({ kind: "idempotent", at: "2026-10-06T00:00:00.000Z" });
    expect((await readFile(e.abs, "utf8")).split("\n").filter((l) => l.includes('"t":"adjudicate"')).length).toBe(1);
    const flip = await adjudicateJournal({ ...opts(e, subj, "resend"), at: "2026-10-06T00:02:00.000Z" });
    expect(flip).toMatchObject({ kind: "aborted", reason: "conflicting-verdict" }); // 终局不可翻转
    const swap = await adjudicateJournal({ ...opts(e, fragSubject(sha(torn), start, end, at, "i2"), "abandon"), at: "2026-10-06T00:03:00.000Z" });
    expect(swap).toMatchObject({ kind: "aborted", reason: "conflicting-verdict" }); // B3/P2：同事务换归因目标拒
    expect((await readFile(e.abs, "utf8")).split("\n").filter((l) => l.includes('"t":"adjudicate"')).length).toBe(1);
    await cleanup(e);
  });

  it("R4 四元组字段独立负例（B6）：sha/byteStart/byteEnd/at 任一错=subject-absent；歧义（多条同四元组 repair 行）拒；目标越界拒；全拒零落行", async () => {
    const e = await env([jl("i1"), repairRow(22, 50, sha("real-tail"))]);
    await seedAnchor(e);
    const good = { sha: sha("real-tail"), start: 22, end: 50, at: "2026-10-05T00:00:00.000Z" };
    expect(await adjudicateJournal(opts(e, repairSubject(sha("other"), 22, 50), "resend"))).toMatchObject({ kind: "aborted", reason: "subject-absent" });
    expect(await adjudicateJournal(opts(e, repairSubject(good.sha, 23, 50, good.at), "resend"))).toMatchObject({ kind: "aborted", reason: "subject-absent" });
    expect(await adjudicateJournal(opts(e, repairSubject(good.sha, 22, 51, good.at), "resend"))).toMatchObject({ kind: "aborted", reason: "subject-absent" });
    expect(await adjudicateJournal(opts(e, repairSubject(good.sha, 22, 50, "2026-10-05T09:00:00.000Z"), "resend"))).toMatchObject({ kind: "aborted", reason: "subject-absent" });
    expect(await adjudicateJournal(opts(e, fragSubject(good.sha, 22, 50, good.at, "i9"), "resend"))).toMatchObject({ kind: "aborted", reason: "subject-absent" }); // 目标不在重放范围
    expect(await readFile(e.abs, "utf8")).not.toContain('"t":"adjudicate"');
    // 歧义：手写盘面两条同四元组 repair 行→唯一匹配失败拒
    const e2 = await env([jl("i1"), repairRow(22, 50, sha("x")), repairRow(22, 50, sha("x"))]);
    await seedAnchor(e2);
    expect(await adjudicateJournal(opts(e2, repairSubject(sha("x"), 22, 50), "resend"))).toMatchObject({ kind: "aborted", reason: "subject-absent", detail: expect.stringContaining("歧义") });
    await cleanup(e); await cleanup(e2);
    // 读面 stale 裁决不解锁（四元组不在 repairLog）
    const base = [JSON.parse(jl("i1")), JSON.parse(repairRow(22, 50, sha("real-tail")))] as JournalLine[];
    expect(buildRecoverReport(base, "q", { fragments: [], blocked: false }).resumeBlocked).toBe(true);
    const stale = [...base, JSON.parse(adjRepair(sha("other"), 22, 50))] as JournalLine[];
    expect(buildRecoverReport(stale, "q", { fragments: [], blocked: false }).resumeBlocked).toBe(true);
    // r4 双证：repair-only 配对不解效果门（B-r3-2 冷捕获缝）——对账面闭合仍阻断
    const matchedRepairOnly = [...base, JSON.parse(adjRepair(sha("real-tail"), 22, 50))] as JournalLine[];
    expect(buildRecoverReport(matchedRepairOnly, "q", { fragments: [], blocked: false }).resumeBlocked).toBe(true);
    // 同四元组 fragment 裁决归因 i1（lines 需有 i1 重放范围在场）→双证齐才解锁
    const match = [...base, JSON.parse(send("i1")), JSON.parse(adjFrag(sha("real-tail"), 22, 50, "2026-10-05T00:00:00.000Z", "i1", "resend"))] as JournalLine[];
    expect(buildRecoverReport(match, "q", { fragments: [], blocked: false }).resumeBlocked).toBe(false);
  });

  it("R5 裁决行撕裂：bad-tail 拒（零改盘）→真跑 repairJournalTail 修复→重试成功；修复后盘面无坏行", async () => {
    const torn = `{"t":"sending","intentId":"i1","pay`;
    const good = `${jl("i1")}\n${send("i1")}\n${repairRow(30, 66, sha(torn))}\n`;
    const halfAdj = `{"t":"adjudicate","subject":{"kind":"repair","remov`; // 撕裂裁决行（无换行）
    const e = await env([], `${good}${halfAdj}`);
    await seedAnchor(e);
    // 撕裂裁决行在场：adjudicate 拒 bad-tail（不补换行——补了会把撕裂尾固化成中间坏行）
    const before = await readFile(e.abs);
    expect(await adjudicateJournal(opts(e, repairSubject(sha(torn), 30, 66), "resend"))).toMatchObject({ kind: "aborted", reason: "bad-tail" });
    expect((await readFile(e.abs)).equals(before)).toBe(true);
    // 真跑 repair-tail 修复（撕裂裁决行被移除=证据灭失后由宿主重裁决）
    const rep = await repairJournalTail({ file: e.file, roots: [e.roots], evidenceDir: e.evidenceDir, buildId: "b1" });
    expect(rep.kind).toBe("repaired");
    const after = await readFile(e.abs, "utf8");
    expect(after).not.toContain('"t":"adjudicate"');
    // 修复后盘面无坏行+无 marker→裁决重试成功
    expect(await adjudicateJournal(opts(e, repairSubject(sha(torn), 30, 66), "resend"))).toMatchObject({ kind: "adjudicated" });
    await cleanup(e);
  });

  it("R6 旧快照粘滞 vs 新快照配对解锁：repairUndecided 恒阻断（裁决不在旧 lines）；新快照裁决行在场解锁", async () => {
    const torn = `{"t":"sending","intentId":"i1","pay`;
    const e = await env([jl("i1"), send("i1"), repairRow(30, 66, sha(torn))]);
    await seedAnchor(e);
    const snap = await recapture(e); // 修复后（未裁决）快照
    const { recoverFromSnapshot } = await import("../../../apps/server/src/runtime/recover.ts");
    expect(recoverFromSnapshot(snap).resumeBlocked).toBe(true);
    // 旧快照粘滞：裁决后旧快照 lines 不变（无裁决行）→ repairUndecided 快照字段（r4 L-r3-2：写真字段而非被忽略的第二参数）恒阻断
    expect(recoverFromSnapshot({ ...snap, repairUndecided: true }).resumeBlocked).toBe(true);
    // 落裁决（r4 双证：fragment 归因 i1）→新快照（裁决行在场+双证齐）解锁
    expect((await adjudicateJournal(opts(e, fragSubject(sha(torn), 30, 66, "2026-10-05T00:00:00.000Z", "i1"), "resend"))).kind).toBe("adjudicated");
    const fresh = await recapture(e);
    const report = recoverFromSnapshot(fresh);
    expect(report.resumeBlocked).toBe(false);
    expect(report.resumable).toContain("i1"); // fragment resend 归因覆盖 unknown
    await cleanup(e);
  });

  it("R7 同内容双事务不串扰（B1/P3）：同 sha 不同 at 两事务——裁决其一，另一仍阻断；全部裁决才解锁；旧 fragment 裁决不解锁新事务", async () => {
    const tornA = `{"t":"sending","intentId":"i1","pay`;
    const at1 = "2026-10-05T00:00:00.000Z", at2 = "2026-10-05T12:00:00.000Z";
    const e = await env([jl("i1"), send("i1"), repairRow(30, 66, sha(tornA), at1), repairRow(30, 66, sha(tornA), at2)]);
    await seedAnchor(e);
    // 裁决事务一（fragment 归因 i1）
    expect((await adjudicateJournal(opts(e, fragSubject(sha(tornA), 30, 66, at1, "i1"), "resend"))).kind).toBe("adjudicated");
    // 事务二仍阻断（同 sha 不同 at——P3 杀点：旧裁决不得自动作用于新事务）
    const half = buildRecoverReport(
      [JSON.parse(jl("i1")), JSON.parse(send("i1")), JSON.parse(repairRow(30, 66, sha(tornA), at1)), JSON.parse(repairRow(30, 66, sha(tornA), at2)), JSON.parse(adjFrag(sha(tornA), 30, 66, at1, "i1", "resend"))] as JournalLine[],
      "q", { fragments: [], blocked: false },
    );
    expect(half.resumeBlocked).toBe(true);
    // 全部裁决→解锁（r4 双证：事务二也需 fragment 归因 i1；repair-only 对账不解效果门）
    expect((await adjudicateJournal(opts(e, fragSubject(sha(tornA), 30, 66, at2, "i1"), "resend"))).kind).toBe("adjudicated");
    const full = await recapture(e);
    expect(recoverFromSnapshot(full).resumeBlocked).toBe(false);
    await cleanup(e);
  });

  it("R8 marker 生命周期：marker 在场=repair-pending 拒（零改盘）；repair 行已落+marker 未清残局仍拒；清除后成功", async () => {
    const torn = `{"t":"sending","intentId":"i1","pay`;
    const e = await env([jl("i1"), send("i1"), repairRow(30, 66, sha(torn))]);
    await seedAnchor(e);
    const markerPath = join(e.evidenceDir, `${encodeURIComponent(e.file)}.repair-pending.json`);
    await writeFile(markerPath, JSON.stringify({ version: 1, file: e.file, byteStart: 30, byteEnd: 66, removedSha256: sha(torn), startedAt: "2026-10-05T00:00:00.000Z" }), "utf8");
    const before = await readFile(e.abs);
    expect(await adjudicateJournal(opts(e, repairSubject(sha(torn), 30, 66), "resend"))).toMatchObject({ kind: "aborted", reason: "repair-pending" });
    expect((await readFile(e.abs)).equals(before)).toBe(true); // 零改盘
    // 残局形：repair 行已在盘+marker 未清（clearMarker 失败崩溃）→仍拒（追加会让 marker 补完路径死）
    let markerStill = false;
    try { await stat(markerPath); markerStill = true; } catch { markerStill = false; }
    expect(markerStill).toBe(true);
    // 清除 marker（=repair-tail 收尾完成）→裁决成功
    await rm(markerPath, { force: true });
    expect((await adjudicateJournal(opts(e, repairSubject(sha(torn), 30, 66), "resend"))).kind).toBe("adjudicated");
    await cleanup(e);
  });

  it("R9 abandon 终局：解锁修复阴影但 resumable 排除该意图（残片归因 unknown 真源+无残片源正反对照杀点 r2 L2）", async () => {
    const torn = '{"t":"sending","intentId":"i1"';
    const e = await env([jl("i1"), repairRow(30, 66, sha(torn))]);
    await seedAnchor(e);
    expect((await adjudicateJournal(opts(e, fragSubject(sha(torn), 30, 66, "2026-10-05T00:00:00.000Z", "i1"), "abandon"))).kind).toBe("adjudicated");
    const { lines } = parseJournalText(await readFile(e.abs, "utf8"));
    // 真实 unknown 源：修复前残片（sending i1 撕裂）归因并入 unknown——abandon 排除才不虚空
    const report = buildRecoverReport(lines, "q", { fragments: [{ raw: torn, error: "撕裂尾", partialTail: true }], blocked: false });
    expect(report.unknownEffect).toContain("i1");
    expect(report.resumeBlocked).toBe(false); // 阴影解除（授权面通）
    expect(report.resumable).not.toContain("i1"); // abandon 终局放弃不重发（R9）
    // 杀点对照（r2 L2）：无残片源（无 unknown）时 abandon 排除是唯一阻力——门失效则 i1 可重发
    const plain = buildRecoverReport(lines, "q", { fragments: [], blocked: false });
    expect(plain.unknownEffect).toEqual([]);
    expect(plain.resumable).not.toContain("i1"); // enqueue 完整+无 sending+无 unknown：若 abandon 门失效即含 i1
    await cleanup(e);
  });

  it("R11 目录链 symlink 越界（B4/P11 杀点，r2 L2 修正——文件级 symlink 被 O_NOFOLLOW 兼底掩盖 realpath 门的独立效果）：目录链 symlink 引出根外=path-escape 拒零改盘；真实根内正常通过", async () => {
    const torn = '{"t":"sending","intentId":"i1"';
    const e = await env([jl("i1"), repairRow(30, 66, sha(torn))]);
    await seedAnchor(e);
    // 攻击面：授权根=真实目录，根内子目录是 symlink→根外真实位置（最终文件非 symlink：
    // O_NOFOLLOW 不挡目录链，只有 realpath 门能拦——本杀点独立于 O_NOFOLLOW）
    const outside = await mkdtemp(join(tmpdir(), "adj-out-"));
    const realJournal = join(outside, e.file);
    await writeFile(realJournal, await readFile(e.abs));
    const gate = await mkdtemp(join(tmpdir(), "adj-gate-")); // 授权根（词法内）
    const { symlink } = await import("node:fs/promises");
    await symlink(outside, join(gate, "sub")); // 目录链 symlink：gate/sub → outside
    const r = await adjudicateJournal({ file: "sub/q.jsonl", roots: [gate], evidenceDir: e.evidenceDir, subject: repairSubject(sha(torn), 30, 66), verdict: "resend", operator: "host", buildId: "b1" });
    expect(r).toMatchObject({ kind: "aborted", reason: "file-absent", detail: "path-escape" }); // 词法在根内、实路径在根外→拒
    expect(await readFile(realJournal, "utf8")).not.toContain('"t":"adjudicate"'); // 真实文件零改盘
    // 对照组：真实根（无 symlink）正常通过
    expect((await adjudicateJournal(opts(e, repairSubject(sha(torn), 30, 66), "resend"))).kind).toBe("adjudicated");
    await cleanup(e); await rm(outside, { recursive: true, force: true }); await rm(gate, { recursive: true, force: true });
  });

  it("R10 生产路径综合：resend 覆盖残片归因 unknown 进 resumable；derivedAdjudications 呈现有效裁决；stale/冲突组不呈现不派生", async () => {
    const torn = '{"t":"sending","intentId":"i1"';
    const at = "2026-10-05T00:00:00.000Z";
    const e = await env([jl("i1"), repairRow(30, 66, sha(torn))]);
    await seedAnchor(e);
    expect((await adjudicateJournal({ ...opts(e, fragSubject(sha(torn), 30, 66, at, "i1"), "resend"), at: "2026-10-06T00:00:00.000Z" })).kind).toBe("adjudicated");
    const { lines } = parseJournalText(await readFile(e.abs, "utf8"));
    // 真实 unknown 源：修复前残片归因并入 unknown——resend 覆盖才不虚空（r1 B6 虚空断言修复）
    const report = buildRecoverReport(lines, "q", { fragments: [{ raw: torn, error: "撕裂尾", partialTail: true }], blocked: false });
    expect(report.unknownEffect).toContain("i1");
    expect(report.resumeBlocked).toBe(false);
    expect(report.resumable).toContain("i1"); // resend=授权重发覆盖 unknown 排除（R10）
    expect(report.derivedAdjudications).toEqual([
      { kind: "fragment", repairKey: `${sha(torn)}|30|66|${at}`, intentId: "i1", verdict: "resend", at: "2026-10-06T00:00:00.000Z" },
    ]);
    // 读面防御（手写盘面，写面已拒）：stale 四元组不派生不呈现；同四元组双目标冲突组整组无效（阴影保留）
    const staleCase = buildRecoverReport(
      [JSON.parse(jl("i1")), JSON.parse(unknown("i1")), JSON.parse(repairRow(22, 50, sha("s1"))), JSON.parse(adjRepair(sha("gone"), 22, 50))] as JournalLine[],
      "q", { fragments: [], blocked: false },
    );
    expect(staleCase.resumeBlocked).toBe(true); // stale 不解锁
    expect(staleCase.derivedAdjudications).toEqual([]);
    const conflictCase = buildRecoverReport(
      [JSON.parse(jl("i1")), JSON.parse(jl("i2")), JSON.parse(repairRow(22, 50, sha("s2"))),
        JSON.parse(adjFrag(sha("s2"), 22, 50, "2026-10-05T00:00:00.000Z", "i1", "resend")),
        JSON.parse(adjFrag(sha("s2"), 22, 50, "2026-10-05T00:00:00.000Z", "i2", "resend"))] as JournalLine[],
      "q", { fragments: [], blocked: false },
    );
    expect(conflictCase.resumeBlocked).toBe(true); // 冲突组整组无效（P8 防御）
    expect(conflictCase.resumable).toEqual([]);
    expect(conflictCase.derivedAdjudications).toEqual([]);
    await cleanup(e);
  });

  it("R12 授权作用域（r2 B1）：同 sha 双事务只裁其一→旧 resend 不越事务授权新残片 unknown；全部事务同向裁决才覆盖；G2 新 raw 同 intentId 不消耗", async () => {
    const torn = '{"t":"sending","intentId":"i1"';
    const X = sha(torn);
    const at1 = "2026-10-05T00:00:00.000Z";
    const at2 = "2026-10-05T01:00:00.000Z";
    // 主负例（r4 重构，保 scopeCovers 独立杀点）：tx1=frag(i1,resend)，tx2=frag(i2,resend)——两事务归因面
    // 均满足（双证齐，归因门不阻断），但 i1 的新残片证据跨双事务：shasToTxKeys(X)={tx1,tx2} 中 tx2 的
    // 授权集={i2}不含 i1→scopeCovers 不覆盖→i1 留 unknown。若 tx2 换 repair-only 或不裁决，归因门先阻断，
    // 杀点就不再是 scopeCovers 本身（GPT r3 L-r3-3 同型批评）。
    const rows = [jl("i1"), jl("i2"), repairRow(30, 66, X, at1), repairRow(30, 66, X, at2),
      adjFrag(X, 30, 66, at1, "i1", "resend"), adjFrag(X, 30, 66, at2, "i2", "resend")];
    const { lines } = parseJournalText(`${rows.join("\n")}\n`);
    const report = buildRecoverReport(lines, "q", { fragments: [{ raw: torn, error: "撕裂尾", partialTail: true }], blocked: false });
    expect(report.resumeBlocked).toBe(false); // 双证齐（两事务均有归因裁决）→无阻断，杀点在作用域面
    expect(report.unknownEffect).toContain("i1");
    expect(report.resumable).not.toContain("i1"); // 旧裁决授权锢在 tx1 证据链——tx2 新证据未获同向裁决
    // 对照组：tx2 也 fragment resend i1（全部同 sha 事务同向裁决）→覆盖成立
    const rowsAll = [jl("i1"), repairRow(30, 66, X, at1), repairRow(30, 66, X, at2),
      adjFrag(X, 30, 66, at1, "i1", "resend"), adjFrag(X, 30, 66, at2, "i1", "resend")];
    const all = buildRecoverReport(parseJournalText(`${rowsAll.join("\n")}\n`).lines, "q", { fragments: [{ raw: torn, error: "撕裂尾", partialTail: true }], blocked: false });
    expect(all.resumeBlocked).toBe(false);
    expect(all.resumable).toContain("i1"); // 全事务同向→新残片证据链内授权成立
    // G2 负例（r2 B1 第二段）：快照人工归因 raw=OLD，盘面新残片 raw=torn（不同内容）→不消耗→阻断保留
    const g2 = buildRecoverReport(parseJournalText(`${[jl("i1"), repairRow(30, 66, X, at1)].join("\n")}\n`).lines, "q", {
      fragments: [{ raw: torn, error: "撕裂尾", partialTail: true }], blocked: false, attributedFragments: [{ raw: "OLD-FRAGMENT-CONTENT", intentId: "i1" }],
    });
    expect(g2.resumeBlocked).toBe(true); // 旧 raw 裁决匹配不到新残片→不消耗→unattributable 阻断
  });

  it("R13 marker 读错误非 ENOENT=marker-unreadable 保守拒零改盘（r2 B2）：真 EISDIR+注入 EACCES 两形；ENOENT 仍正常通过", async () => {
    const torn = '{"t":"sending","intentId":"i1"';
    const e = await env([jl("i1"), repairRow(30, 66, sha(torn))]);
    await seedAnchor(e);
    const subj = repairSubject(sha(torn), 30, 66);
    // 形一：真实 EISDIR——marker 路径是个目录
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(e.evidenceDir, `${encodeURIComponent(e.file)}.repair-pending.json`));
    const before = await readFile(e.abs);
    const r1 = await adjudicateJournal(opts(e, subj, "resend"));
    expect(r1).toMatchObject({ kind: "aborted", reason: "marker-unreadable" });
    expect((await readFile(e.abs)).equals(before)).toBe(true); // 零改盘
    // 形二：注入 EACCES（权限故障无在场证据）
    const { rm } = await import("node:fs/promises");
    await rm(join(e.evidenceDir, `${encodeURIComponent(e.file)}.repair-pending.json`), { recursive: true });
    const r2 = await adjudicateJournal({ ...opts(e, subj, "resend"), readMarker: async () => { const err = new Error("denied") as NodeJS.ErrnoException; err.code = "EACCES"; throw err; } });
    expect(r2).toMatchObject({ kind: "aborted", reason: "marker-unreadable" });
    // 对照：ENOENT（真缺失）正常通过
    const r3 = await adjudicateJournal({ ...opts(e, subj, "resend"), readMarker: async () => { const err = new Error("noent") as NodeJS.ErrnoException; err.code = "ENOENT"; throw err; } });
    expect(r3.kind).toBe("adjudicated");
    await cleanup(e);
  });

  it("R14 冲突组整组失效（r2 B3）：repair 裁决不可解除冲突阴影（两顺序）；写面矛盾裁决集拒（不信任首行）", async () => {
    const s2 = sha("s2");
    const mk = (order: "frag-first" | "repair-first") =>
      parseJournalText(`${[jl("i1"), jl("i2"), repairRow(22, 50, s2),
        ...(order === "frag-first"
          ? [adjFrag(s2, 22, 50, "2026-10-05T00:00:00.000Z", "i1", "resend"), adjFrag(s2, 22, 50, "2026-10-05T00:00:00.000Z", "i2", "resend"), adjRepair(s2, 22, 50)]
          : [adjRepair(s2, 22, 50), adjFrag(s2, 22, 50, "2026-10-05T00:00:00.000Z", "i1", "resend"), adjFrag(s2, 22, 50, "2026-10-05T00:00:00.000Z", "i2", "resend")])].join("\n")}\n`).lines;
    for (const order of ["frag-first", "repair-first"] as const) {
      const report = buildRecoverReport(mk(order), "q", { fragments: [], blocked: false });
      expect(report.resumeBlocked).toBe(true); // 冲突组非空→阴影恒在（repair 裁决也解不了）
      expect(report.resumable).toEqual([]);
      expect(report.derivedAdjudications).toEqual([]); // 矛盾证据不呈现
    }
    // 写面：既有矛盾集（同四元组双 verdict，手写盘面）→再裁决=conflicting-verdict 拒零落行
    const e = await env([jl("i1"), repairRow(30, 66, sha("s3")),
      adjRepair(sha("s3"), 30, 66, "2026-10-05T00:00:00.000Z", "resend"),
      adjRepair(sha("s3"), 30, 66, "2026-10-05T00:00:00.000Z", "abandon")]);
    await seedAnchor(e);
    const before = await readFile(e.abs);
    const r = await adjudicateJournal(opts(e, repairSubject(sha("s3"), 30, 66), "resend"));
    expect(r).toMatchObject({ kind: "aborted", reason: "conflicting-verdict" });
    expect((await readFile(e.abs)).equals(before)).toBe(true); // 矛盾集不追加
    await cleanup(e);
  });

  it("R15 raw 禁入运行时兑底（r2 B4）：schema 拒 subject.raw 与顶层 raw；写面 minimalSubject 白名单不透传额外属性", async () => {
    const { journalLineSchemaError } = await import("@pi-agent-ui/protocol");
    // 手写完整行带 subject.raw→schema 拒（手写盘面不得成为合法行）
    const withSubjRaw = JSON.parse(adjRepair(sha("s4"), 22, 50)) as Record<string, unknown>;
    (withSubjRaw.subject as Record<string, unknown>).raw = "泄露全文";
    expect(journalLineSchemaError(withSubjRaw)).toContain("raw");
    // 手写顶层 raw→同拒
    const withTopRaw = JSON.parse(adjRepair(sha("s4"), 22, 50)) as Record<string, unknown>;
    withTopRaw.raw = "泄露全文";
    expect(journalLineSchemaError(withTopRaw)).toContain("raw");
    // 工具面：opts.subject 夹带 raw（类型外属性）→落盘行无 raw（白名单拷贝）
    const torn = '{"t":"sending","intentId":"i1"';
    const e = await env([jl("i1"), repairRow(30, 66, sha(torn))]);
    await seedAnchor(e);
    const dirty = { ...repairSubject(sha(torn), 30, 66), raw: "泄露全文" } as unknown as AdjudicateSubject;
    expect((await adjudicateJournal(opts(e, dirty, "resend"))).kind).toBe("adjudicated");
    const after = await readFile(e.abs, "utf8");
    expect(after).not.toContain("泄露全文"); // 白名单拷贝——额外属性不落盘
    const { lines, bad } = parseJournalText(after);
    expect(bad).toEqual([]);
    const adj = lines.find((l) => l.t === "adjudicate");
    expect(adj).toBeDefined();
    expect(JSON.stringify(adj)).not.toContain('"raw"');
    await cleanup(e);
  });

  it("R16 锚预检+句柄确定性关闭（r2 L4/L1）：锚损坏=anchor-corrupt 写前拒零改盘；漂移锚不拒但不转移不承诺收敛；各路径句柄恰一次 close", async () => {
    const torn = '{"t":"sending","intentId":"i1"';
    // L4 形一：锚非法 JSON→写前拒
    const e = await env([jl("i1"), repairRow(30, 66, sha(torn))]);
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(e.evidenceDir, `${encodeURIComponent(e.file)}.evidence.json`), "{not-json", "utf8");
    const before = await readFile(e.abs);
    const r1 = await adjudicateJournal(opts(e, repairSubject(sha(torn), 30, 66), "resend"));
    expect(r1).toMatchObject({ kind: "aborted", reason: "anchor-corrupt" });
    expect((await readFile(e.abs)).equals(before)).toBe(true); // 写前拒零改盘
    await cleanup(e);
    // L4 形二：漂移锚（len 超盘面）→裁决落盘+跳过转移（不承诺自动收敛）
    const e2 = await env([jl("i1"), repairRow(30, 66, sha(torn))]);
    await wf(join(e2.evidenceDir, `${encodeURIComponent(e2.file)}.evidence.json`), JSON.stringify({ version: 1, file: e2.file, len: 999999, sha: sha("x"), capturedAt: "2026-10-05T00:00:00.000Z" }), "utf8");
    const r2 = await adjudicateJournal(opts(e2, repairSubject(sha(torn), 30, 66), "resend"));
    expect(r2).toMatchObject({ kind: "adjudicated", anchorMoved: false });
    await cleanup(e2);
    // L1：四路径（成功/幂等/盘面拒/写失败）各跑一次，句柄 close 恰各一次
    const e3 = await env([jl("i1"), repairRow(30, 66, sha(torn))]);
    await seedAnchor(e3);
    const counter = { opened: 0, closed: 0 };
    const openCounting = async (abs: string): Promise<{ fh: FileHandle; size: number }> => {
      counter.opened += 1;
      const real = await (await import("../../../apps/server/src/ws/safe-open.ts")).openSafeReadWrite(abs);
      const fh = real.fh as unknown as FileHandle;
      const realClose = fh.close.bind(fh);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (fh as any).close = async () => { counter.closed += 1; await realClose(); };
      return { fh, size: real.size };
    };
    // r4：写失败面同计数（open 计数+append 即抛）——句柄泄漏在写失败面同样可验
    const crashCounting = async (abs: string): Promise<{ fh: FileHandle; size: number }> => {
      const opened = await openCounting(abs);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (opened.fh as any).appendFile = async () => { throw new Error("crash-before-append"); };
      return opened;
    };
    const subj = repairSubject(sha(torn), 30, 66);
    // r4 L-r3-4 重写：逐次增量断言（每调用即验 opened===closed，中途泄漏立现）；五路径全部接计数句柄
    // （含写失败面）；写失败形=open 计数后 append 即抛。
    const runCounted = async (extra: Partial<Parameters<typeof adjudicateJournal>[0]>): Promise<string> => {
      const r = await adjudicateJournal({ ...opts(e3, subj, "resend"), openHandle: openCounting, ...extra });
      expect(counter.closed).toBe(counter.opened); // 逐次增量：本次调用无泄漏
      return r.kind;
    };
    expect(await runCounted({})).toBe("adjudicated");
    expect(await runCounted({})).toBe("idempotent");
    expect(await runCounted({ verdict: "abandon" })).toBe("aborted"); // conflicting（同四元组反 verdict）
    expect(await runCounted({ subject: { ...subj, at: "1999-01-01T00:00:00.000Z" } })).toBe("aborted"); // subject-absent
    expect(await runCounted({ subject: { ...subj, at: "1999-01-01T00:00:00.000Z" }, openHandle: crashCounting })).toBe("aborted"); // write-failed（同计数面）
    expect(counter.closed).toBe(counter.opened); // 计数面：每开必关，无泄漏
    await cleanup(e3);
  });

  it("R17 残片无事务映射不覆盖（r4 B-r3-1）：残片 sha 不在 repairLog（撕裂字节失配同形异容）→授权链不成立，resumable 排除；变异杀点=该门改 continue 放行", async () => {
    const torn = '{"t":"sending","intentId":"i1"';
    const X = sha(torn);
    const torn2 = '{"t":"sending","intentId":"i1","x":"y"'; // 同意图不同字节（完整闭合值+撕裂处干净）——sha≠X，repairLog 无对应事务
    // 归因裁决锢在 X 事务；残片证据链指向 Y=sha(torn2)——无事务可证被授权→不覆盖
    const rows = [jl("i1"), send("i1"), repairRow(30, 66, X), adjFrag(X, 30, 66, "2026-10-05T00:00:00.000Z", "i1", "resend")];
    const report = buildRecoverReport(parseJournalText(`${rows.join("\n")}\n`).lines, "q", { fragments: [{ raw: torn2, error: "撕裂尾", partialTail: true }], blocked: false });
    expect(report.resumeBlocked).toBe(false); // 双证齐（事务有归因裁决+无坏行未决）
    expect(report.unknownEffect).toContain("i1");
    expect(report.resumable).not.toContain("i1"); // B-r3-1 杀点：无映射→保守排除（旧实现空循环直达 return true=放行）
  });

  it("R18 锚严格 schema（r4 B-r3-3）：version≠1/file 错绑/len 负/len 非整数/sha 非小写hex——全部 anchor-corrupt 写前拒零改盘；合法锚不拒", async () => {
    const torn = '{"t":"sending","intentId":"i1"';
    const X = sha(torn);
    const anchorPathOf = (e: Env) => join(e.evidenceDir, `${encodeURIComponent(e.file)}.evidence.json`);
    const cases: Array<[string, Record<string, unknown>]> = [
      ["version=99", { version: 99, file: "q.jsonl", len: 0, sha: X }],
      ["file 错绑", { version: 1, file: "other.jsonl", len: 0, sha: X }],
      ["len 负", { version: 1, file: "q.jsonl", len: -1, sha: X }],
      ["len 非整数", { version: 1, file: "q.jsonl", len: 1.5, sha: X }],
      ["sha 大写", { version: 1, file: "q.jsonl", len: 0, sha: X.toUpperCase() }],
      ["sha 短", { version: 1, file: "q.jsonl", len: 0, sha: "abc" }],
    ];
    for (const [name, a] of cases) {
      const e = await env([jl("i1"), repairRow(30, 66, X)]);
      const { writeFile: wf } = await import("node:fs/promises");
      await wf(anchorPathOf(e), JSON.stringify(a), "utf8");
      const before = await readFile(e.abs);
      expect(await adjudicateJournal(opts(e, fragSubject(X, 30, 66, "2026-10-05T00:00:00.000Z", "i1"), "resend")), name).toMatchObject({ kind: "aborted", reason: "anchor-corrupt" });
      expect((await readFile(e.abs)).equals(before), name).toBe(true); // 写前拒零改盘
      await cleanup(e);
    }
    // 对照：合法锚（version=1+file 绑定+len 安全非负整数+sha 64 位小写 hex）不拒
    const e2 = await env([jl("i1"), repairRow(30, 66, X)]);
    await seedAnchor(e2);
    expect(await adjudicateJournal(opts(e2, fragSubject(X, 30, 66, "2026-10-05T00:00:00.000Z", "i1"), "resend"))).toMatchObject({ kind: "adjudicated" });
    await cleanup(e2);
  });

  it("R19 组一致性二维（r4 B-r3-4）：同四元组 verdict 混合/多目标任一>1→整组失效阻断（kind 维合法=双证共存）；写面拒的组合读面不得当有效授权", async () => {
    const torn = '{"t":"sending","intentId":"i1"';
    const X = sha(torn);
    const base = [jl("i1"), send("i1"), repairRow(30, 66, X)];
    const at = "2026-10-05T00:00:00.000Z";
    const run = (extra: string[]) =>
      buildRecoverReport(parseJournalText(`${[...base, ...extra].join("\n")}\n`).lines, "q", { fragments: [], blocked: false });
    // verdict 混合（跨 kind 形）：fragment(resend,i1)+repair(abandon) 同四元组——效果语义矛盾→组失效
    const mixedKind = run([adjFrag(X, 30, 66, at, "i1", "resend"), adjRepair(X, 30, 66, at, "abandon")]);
    expect(mixedKind.resumeBlocked).toBe(true);
    expect(mixedKind.derivedAdjudications).toEqual([]);
    // 对照：同 verdict 的 repair+fragment 双行=双证合法共存（kind 维不判矛盾）
    const dualCert = run([adjRepair(X, 30, 66, at, "resend"), adjFrag(X, 30, 66, at, "i1", "resend")]);
    expect(dualCert.resumeBlocked).toBe(false);
    expect(dualCert.resumable).toContain("i1");
    // verdict 混合：同 intentId 同四元组双 verdict（写面 conflicting 拒，手写盘面防御）
    const mixedVerdict = run([adjFrag(X, 30, 66, at, "i1", "resend"), adjFrag(X, 30, 66, at, "i1", "abandon")]);
    expect(mixedVerdict.resumeBlocked).toBe(true);
    expect(mixedVerdict.resumable).toEqual([]);
    // 多目标（r3 已有 P8/R11，此处三维归一）
    const multiTarget = run([adjFrag(X, 30, 66, at, "i1", "resend"), adjFrag(X, 30, 66, at, "i2", "resend")]);
    expect(multiTarget.resumeBlocked).toBe(true);
    // 对照：同 kind 同 verdict 单目标（双证齐）→组一致→解锁
    const ok = run([adjFrag(X, 30, 66, at, "i1", "resend")]);
    expect(ok.resumeBlocked).toBe(false);
    expect(ok.resumable).toContain("i1");
  });

  it("R20 冷捕获真实链回归（r4 B-r3-2/P7）：真撕裂→真 repair→裁决→重读；repair-only 仍阻断 vs fragment 归因解锁", async () => {
    const torn = `{"t":"sending","intentId":"i1","pay`;
    const good = `${jl("i1")}\n${send("i1")}`;
    const e = await env([], `${good}\n${torn}`); // 真撕裂尾（无换行）
    await seedAnchor(e);
    // 真 repair：撕裂尾移除→事务落盘
    const rep = await repairJournalTail({ file: e.file, roots: [e.roots], evidenceDir: e.evidenceDir, buildId: "b1" });
    expect(rep.kind).toBe("repaired");
    if (rep.kind !== "repaired") throw new Error("unreachable");
    const { byteStart, byteEnd, removedSha256: X, at: repAt } = rep; // 真实事务四元组（byteStart/End 由盘面决定，不硬编码）
    // 冷捕获缝对照（B-r3-2 核心负例）：repair-only 裁决=对账闭合，重读后不得解锁重发授权
    expect(await adjudicateJournal(opts(e, repairSubject(X, byteStart, byteEnd, repAt), "resend"))).toMatchObject({ kind: "adjudicated" });
    const afterRepairOnly = recoverFromSnapshot(await recapture(e));
    expect(afterRepairOnly.resumeBlocked).toBe(true); // 归因面缺席——重启后反而更宽的缝已闭合（B-r3-2）
    // 同四元组 fragment 归因 i1→双证齐→解锁+可重发
    expect(await adjudicateJournal(opts(e, fragSubject(X, byteStart, byteEnd, repAt, "i1"), "resend"))).toMatchObject({ kind: "adjudicated" });
    const dual = recoverFromSnapshot(await recapture(e));
    expect(dual.resumeBlocked).toBe(false);
    expect(dual.resumable).toContain("i1");
    await cleanup(e);
  });
});
