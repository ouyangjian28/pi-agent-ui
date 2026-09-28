// P0-1b 裁决持久化 v2 测试矩阵 R1-R28（r1 B1-B5 修复批起步，历轮扩谱；权威谱系=tests/fixtures/TEST-MAP.md）。
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
import { JOURNAL_CONTRACT_VERSION, type JournalLine } from "@pi-agent-ui/protocol";

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

describe("P0-1b 裁决持久化 v2（崩溃/重启矩阵 R1-R24+双证/覆盖 R25-R28）", () => {
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
    expect(report.resendAuthorized).toEqual(["i1"]); // r5：归因 resend 授权面（i1 sending 在途→不自动重发，P1-r4-3）
    expect(report.resumable).not.toContain("i1"); // r5：在途 sending 无执行静止证明→不进自动重发面
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
    expect(report.resendAuthorized).toContain("i1"); // fragment resend 归因覆盖 unknown（授权面）
    expect(report.resumable).not.toContain("i1"); // r5：i1 sending 在途→不自动重发（授权≠执行资格）
    // r5（GPT r4 P2-r4-2）：undecided 独立杀点——其他门全通（无修复事务/无残片/无裁决）的干净盘面上
    // repairUndecided true/false 成对断言（删生产 undecided 项则 true 断言红；旧夹具阻力来自未裁事务非本门）
    const cleanLines = parseJournalText(`${jl("i2")}\n`).lines;
    const cleanBase = { version: 1 as const, file: "q.jsonl", sessionId: "q", lines: cleanLines, bad: [], attributedFragments: [], repaired: false, pendingRepair: false, createdAt: 0 };
    expect(recoverFromSnapshot({ ...cleanBase, repairUndecided: false }).resumeBlocked).toBe(false);
    expect(recoverFromSnapshot({ ...cleanBase, repairUndecided: true }).resumeBlocked).toBe(true);
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
    expect(report.resendAuthorized).toContain("i1"); // resend=授权覆盖 unknown（R10，授权面）
    expect(report.resumable).toContain("i1"); // r5：i1 非在途（enqueue+残片，无完整 sending 行）→授权后可重发
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
    expect(all.resendAuthorized).toContain("i1"); // 全事务同向→新残片证据链内授权成立（授权面）
    expect(all.resumable).toContain("i1"); // r5：i1 非在途（无完整 sending 行）→授权后可重发
    // G2 负例（r2 B1 第二段）：快照人工归因 raw=OLD，盘面新残片 raw=torn（不同内容）→不消耗→阻断保留
    const g2 = buildRecoverReport(parseJournalText(`${[jl("i1"), repairRow(30, 66, X, at1)].join("\n")}\n`).lines, "q", {
      fragments: [{ raw: torn, error: "撕裂尾", partialTail: true }], blocked: false, attributedFragments: [{ raw: "OLD-FRAGMENT-CONTENT", intentId: "i1" }],
    });
    expect(g2.resumeBlocked).toBe(true); // 旧 raw 裁决匹配不到新残片→不消耗→unattributable 阻断
    // r5（GPT r4 P2-r4-2）：G2 真杀点——先满足 repair 对账门（adjRepair 在场），G2 消耗面独立可断言
    // （旧形阻力来自 repairShadow 未裁事务，G2 归因门未被测到）
    const OLD = `{"t":"sending","payload":"abc`; // 不可自动归因（无 intentId 结构）
    const g2Rows = [jl("i1"), repairRow(30, 66, sha(OLD), at1), adjRepair(sha(OLD), 30, 66, at1, "resend"), adjFrag(sha(OLD), 30, 66, at1, "i1", "resend")].join("\n");
    const g2Base = { fragments: [{ raw: OLD, error: "撕裂尾", partialTail: true }], blocked: false };
    const g2pre = buildRecoverReport(parseJournalText(`${g2Rows}\n`).lines, "q", g2Base);
    expect(g2pre.resumeBlocked).toBe(true); // 对账门已过但残片不可自动归因→unattributable=1 阻断
    expect(g2pre.unattributableFragments).toHaveLength(1);
    const g2ok = buildRecoverReport(parseJournalText(`${g2Rows}\n`).lines, "q", { ...g2Base, attributedFragments: [{ raw: OLD, intentId: "i1" }] });
    expect(g2ok.resumeBlocked).toBe(false); // G2 人工裁决消耗残片→归因门独立放行
    expect(g2ok.unattributableFragments).toHaveLength(0);
    // r6（GPT r5 P2-r5-1）：OLD≠NEW 错 raw 归因负例——归因 raw 与残片 raw 非全等→不消耗→阻断
    // （旧形只有"不给归因/给正确归因"两态，无"给错误 raw 归因"态；G2 忽略 raw 全等变异存活）
    const WRONG = `{"t":"sending","intentId":"i1","zzz":"other"`; // 与 OLD 同意图不同字节——raw 非全等
    const g2wrong = buildRecoverReport(parseJournalText(`${g2Rows}\n`).lines, "q", { ...g2Base, attributedFragments: [{ raw: WRONG, intentId: "i1" }] });
    expect(g2wrong.resumeBlocked).toBe(true); // raw 非全等→残片不被消耗→unattributable=1 阻断
    expect(g2wrong.unattributableFragments).toHaveLength(1);
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
    // L1：四路径（成功/幂等/盘面拒/写失败/读失败）各跑一次，句柄 close 恰各一次
    // r5（GPT r4 P2-r4-2）：盘面补事务二（同 sha 不同 at，未裁决）——第五次写失败形用真事务过身份门，
    // append 真达后抛（旧形 at=1999 在盘面门就拒，append 从未被调用=写失败未到达）
    const at2 = "2026-10-07T00:00:00.000Z";
    const e3 = await env([jl("i1"), repairRow(30, 66, sha(torn)), repairRow(30, 66, sha(torn), at2)]);
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
    // r5：写失败真形——事务二（未裁决）过盘面/身份门→append 真达后抛→write-failed；句柄计数面同步验证
    const r5write = await adjudicateJournal({ ...opts(e3, repairSubject(sha(torn), 30, 66, at2), "resend"), openHandle: crashCounting });
    expect(r5write).toMatchObject({ kind: "aborted", reason: "write-failed" });
    expect(counter.closed).toBe(counter.opened); // 写失败路径无泄漏
    // r5：读失败真形——open 成功后 fh.readFile 抛 EIO→file-absent+确定性 close（L-r3-1 独立例）
    const readFailCounting = async (abs: string): Promise<{ fh: FileHandle; size: number }> => {
      const opened = await openCounting(abs);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (opened.fh as any).readFile = async () => { throw Object.assign(new Error("EIO"), { code: "EIO" }); };
      return opened;
    };
    const r5read = await adjudicateJournal({ ...opts(e3, repairSubject(sha(torn), 30, 66, at2), "resend"), openHandle: readFailCounting });
    expect(r5read).toMatchObject({ kind: "aborted", reason: "file-absent" });
    expect(counter.closed).toBe(counter.opened); // 读失败路径同样无泄漏
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
    expect(report.resendAuthorized).not.toContain("i1"); // r6（GPT r5 P2-r5-1）：授权面独立杀点——!r.sending 门下 resumable 断言阻力已漂移（旧形无 send 行时被 sending 门遮蔽），无映射门须在 resendAuthorized 面可独立验杀
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
    expect(dualCert.resendAuthorized).toContain("i1"); // r5：授权面（sending 在途不自动重发）
    expect(dualCert.resumable).not.toContain("i1");
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
    expect(ok.resendAuthorized).toContain("i1"); // r5：授权面
    expect(ok.resumable).not.toContain("i1");
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
    // 同四元组 fragment 归因 i1→双证齐→解锁（r5 起授权与执行分层：resendAuthorized=授权面，在途 sending 不自动重发）
    expect(await adjudicateJournal(opts(e, fragSubject(X, byteStart, byteEnd, repAt, "i1"), "resend"))).toMatchObject({ kind: "adjudicated" });
    const dual = recoverFromSnapshot(await recapture(e));
    expect(dual.resumeBlocked).toBe(false);
    expect(dual.resendAuthorized).toContain("i1"); // r5：授权面（真撕裂链 sending 在途不自动重发）
    expect(dual.resumable).not.toContain("i1");
    await cleanup(e);
  });

  it("R21 冷热差分（r5 P1-r4-1）：双事务各归因一意图——热（残片在场）走 sha×事务全覆盖阻断，冷（丢 fragments）走归因全覆盖阻断；两态一致不放大", () => {
    const torn = '{"t":"sending","intentId":"i1","x":"y"';
    const X = sha(torn); const at1 = "2026-10-05T00:00:00.000Z"; const at2 = "2026-10-05T01:00:00.000Z";
    const rows = [jl("i1"), send("i1"), jl("i2"), repairRow(30, 66, X, at1), repairRow(30, 66, X, at2),
      adjRepair(X, 30, 66, at1, "resend"), adjFrag(X, 30, 66, at1, "i1", "resend"),
      adjRepair(X, 30, 66, at2, "resend"), adjFrag(X, 30, 66, at2, "i2", "resend")];
    const run = (fragments: { raw: string; error: string; partialTail: boolean }[]) =>
      buildRecoverReport(parseJournalText(`${rows.join("\n")}\n`).lines, "q", { fragments, blocked: false });
    const hot = run([{ raw: torn, error: "撕裂尾", partialTail: true }]);
    expect(hot.resumeBlocked).toBe(false); // 双证齐（两事务各有对账+归因裁决）
    expect(hot.resumable).not.toContain("i1"); // 热：i1 残片 need={X}→同 sha 双事务全覆盖失败（只裁 tx1）→阻断
    expect(hot.resendAuthorized).not.toContain("i1");
    const cold = run([]); // 冷捕获：快照丢 fragments
    expect(cold.resumeBlocked).toBe(false);
    expect(cold.resumable).not.toContain("i1"); // 冷：无残片源→归因全覆盖判定（tx2 无 i1 归因）→同样阻断，不比热态宽
    expect(cold.resendAuthorized).not.toContain("i1");
    expect(cold.resumable).not.toContain("i2"); // r6（P1-r5-1）：tx2 归因 i2→i2 在事务影响域，enqueue-only 也不免检——无源全覆盖不成立（tx1 归因 i1）→同样排除（旧形冷态 [i1,i2] 双进=冷比热宽的缺陷形态）
    expect(cold.resendAuthorized).not.toContain("i2");
  });

  it("R25 冷捕获 enqueue-only 执行面（r6 P1-r5-1）：无完整 sending/unknown 证据但事务归因在场——热冷两态 resumable 均须授权，不得因证据缺失免检", () => {
    const torn = '{"t":"sending","intentId":"i1"';
    const X = sha(torn); const at1 = "2026-10-05T00:00:00.000Z"; const at2 = "2026-10-05T01:00:00.000Z";
    const rows = [jl("i1"), jl("i2"), repairRow(30, 66, X, at1), repairRow(30, 66, X, at2),
      adjRepair(X, 30, 66, at1, "resend"), adjFrag(X, 30, 66, at1, "i1", "resend"),
      adjRepair(X, 30, 66, at2, "resend"), adjFrag(X, 30, 66, at2, "i2", "resend")]; // 双事务各归因一意图，双证齐→resumeBlocked=false
    const run = (fragments: { raw: string; error: string; partialTail: boolean }[]) =>
      buildRecoverReport(parseJournalText(`${rows.join("\n")}\n`).lines, "q", { fragments, blocked: false });
    const hot = run([{ raw: torn, error: "撕裂尾", partialTail: true }]);
    expect(hot.resumeBlocked).toBe(false);
    expect(hot.resumable).toEqual([]); // 热：i1 残片归因→unknown→须覆盖；i2 事务归因→影响域→须覆盖；全覆盖不成立→双排除
    const cold = run([]); // 冷：丢 fragments，无 send 行→unknown 空，但 txImpacted 在场（r6 门）
    expect(cold.resumeBlocked).toBe(false);
    expect(cold.resumable).toEqual([]); // r6 核心断言：enqueue-only 不再因 unknown 短路免检——冷不比热宽（r5 缺陷形态=[i1,i2]）
    expect(cold.resendAuthorized).toEqual([]); // 授权面同样不成立（无源全覆盖失败）
  });

  it("R26 abandon 增量不复活（r6 P1-r5-2）：txA abandon(i1) 后加入无关 txB(resend i2)——i1 保持排除，不受无源全覆盖收紧影响", () => {
    const tornA = '{"t":"sending","intentId":"i1","x":"a"';
    const tornB = '{"t":"sending","intentId":"i2","x":"b"';
    const HA = sha(tornA); const HB = sha(tornB); const at1 = "2026-10-05T00:00:00.000Z";
    const base = [jl("i1"), jl("i2"), repairRow(30, 62, HA, at1),
      adjRepair(HA, 30, 62, at1, "abandon"), adjFrag(HA, 30, 62, at1, "i1", "abandon")];
    const pre = buildRecoverReport(parseJournalText(`${base.join("\n")}\n`).lines, "q", { fragments: [], blocked: false });
    expect(pre.resumeBlocked).toBe(false);
    expect(pre.resumable).not.toContain("i1"); // i1 已放弃→终局排除（R9）
    expect(pre.resumable).toContain("i2"); // i2 与 txA 无关→不受影响
    const grown = [...base, repairRow(70, 104, HB, at1), adjRepair(HB, 70, 104, at1, "resend"), adjFrag(HB, 70, 104, at1, "i2", "resend")];
    const post = buildRecoverReport(parseJournalText(`${grown.join("\n")}\n`).lines, "q", { fragments: [], blocked: false });
    expect(post.resumeBlocked).toBe(false);
    expect(post.resumable).not.toContain("i1"); // r6 核心断言：无关事务加入不得撤销已证的放弃排除（r5 缺陷形态=i1 复活）
    expect(post.resumable).not.toContain("i2"); // i2 现在在 txB 影响域→须 resend 覆盖（无源全覆盖：txA 无 i2 归因→不成立）→排除
  });

  it("R22 G2 消耗补源（r5 P1-r4-1 第二缝）：旧事务 fragment resend(i1)+G2 人工归因新残片——新残片 sha 进覆盖判定 need，无事务映射→旧授权不越新来源", () => {
    const tornOld = '{"t":"sending","intentId":"i1","x":"y"';
    const X = sha(tornOld);
    const tornNew = `{"t":"sending","payload":"abc`; // 不可自动归因（无 intentId 结构）
    const rows = [jl("i1"), send("i1"), repairRow(30, 66, X), adjRepair(X, 30, 66), adjFrag(X, 30, 66, "2026-10-05T00:00:00.000Z", "i1", "resend")];
    const r = buildRecoverReport(parseJournalText(`${rows.join("\n")}\n`).lines, "q", {
      fragments: [{ raw: tornNew, error: "撕裂尾", partialTail: true }], blocked: false,
      attributedFragments: [{ raw: tornNew, intentId: "i1" }], // G2 人工归因新残片→i1
    });
    expect(r.resumeBlocked).toBe(false); // 双证齐+残片被 G2 消耗→全局门过
    expect(r.unattributableFragments).toHaveLength(0);
    expect(r.resendAuthorized).not.toContain("i1"); // 新残片 sha 无事务映射→覆盖失败→旧 tx 授权不越过新来源（旧形：G2 消耗不计 sha→直接放行）
    expect(r.resumable).not.toContain("i1"); // i1 sending 在途→本就不自动重发
  });

  it("R23 写面组一致性交叉矩阵（r5 P1-r4-2）：候选 verdict/targets 并入判定——跨 kind 反 verdict 拒、多目标组 repair 请求拒；合法双证追加对照", async () => {
    const torn = '{"t":"sending","intentId":"i1","x":"y"';
    const H = sha(torn); const at = "2026-10-05T00:00:00.000Z";
    const mk = async (rows: string[]) => { const e = await env(rows); await seedAnchor(e); return e; };
    // 形一：repair abandon 在场 + fragment resend 请求 → conflicting-verdict 零追加（旧形落行→读面整组剔除锁死恢复）
    const e1 = await mk([jl("i1"), repairRow(30, 66, H), adjRepair(H, 30, 66, at, "abandon")]);
    const before1 = await readFile(e1.abs);
    const r1 = await adjudicateJournal(opts(e1, fragSubject(H, 30, 66, at, "i1"), "resend"));
    expect(r1).toMatchObject({ kind: "aborted", reason: "conflicting-verdict" });
    expect((await readFile(e1.abs)).equals(before1)).toBe(true); // 零追加
    await cleanup(e1);
    // 形二：fragment abandon(i1) 在场 + repair resend 请求 → 拒（候选 verdict 并入后跨界矛盾）
    const e2 = await mk([jl("i1"), repairRow(30, 66, H), adjFrag(H, 30, 66, at, "i1", "abandon")]);
    const r2 = await adjudicateJournal(opts(e2, repairSubject(H, 30, 66, at), "resend"));
    expect(r2).toMatchObject({ kind: "aborted", reason: "conflicting-verdict" });
    await cleanup(e2);
    // 形三：多目标组（同四元组 fragment i1+i2，手写盘面）+ repair resend 请求 → 拒（多目标门不限定请求 kind）
    const e3 = await mk([jl("i1"), jl("i2"), repairRow(30, 66, H), adjFrag(H, 30, 66, at, "i1", "resend"), adjFrag(H, 30, 66, at, "i2", "resend")]);
    const before3 = await readFile(e3.abs);
    const r3 = await adjudicateJournal(opts(e3, repairSubject(H, 30, 66, at), "resend"));
    expect(r3).toMatchObject({ kind: "aborted", reason: "conflicting-verdict" });
    expect((await readFile(e3.abs)).equals(before3)).toBe(true);
    await cleanup(e3);
    // 合法对照：repair resend 在场 + fragment resend(i1) 追加 → adjudicated（双证合法共存）
    const e4 = await mk([jl("i1"), repairRow(30, 66, H), adjRepair(H, 30, 66, at, "resend")]);
    const r4 = await adjudicateJournal(opts(e4, fragSubject(H, 30, 66, at, "i1"), "resend"));
    expect(r4).toMatchObject({ kind: "adjudicated" });
    await cleanup(e4);
  });

  it("R24 锚安全整数边界（r5 P2-r4-1）：len=2^53（isInteger true 但非安全）→anchor-corrupt 零追加；MAX_SAFE_INTEGER 合法对照", async () => {
    const torn = '{"t":"sending","intentId":"i1"';
    const e = await env([jl("i1"), repairRow(30, 66, sha(torn))]);
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(e.evidenceDir, `${encodeURIComponent(e.file)}.evidence.json`),
      JSON.stringify({ version: 1, file: e.file, len: 9007199254740992, sha: sha(""), capturedAt: "2026-10-05T00:00:00.000Z" }), "utf8");
    const before = await readFile(e.abs);
    const r = await adjudicateJournal(opts(e, repairSubject(sha(torn), 30, 66), "resend"));
    expect(r).toMatchObject({ kind: "aborted", reason: "anchor-corrupt" });
    expect((await readFile(e.abs)).equals(before)).toBe(true); // 写前拒零改盘
    await cleanup(e);
    // 对照：MAX_SAFE_INTEGER=2^53-1 合法（漂移面：len 超盘面→过锚校验→裁决落盘不转移）
    const e2 = await env([jl("i1"), repairRow(30, 66, sha(torn))]);
    await wf(join(e2.evidenceDir, `${encodeURIComponent(e2.file)}.evidence.json`),
      JSON.stringify({ version: 1, file: e2.file, len: Number.MAX_SAFE_INTEGER, sha: sha("x"), capturedAt: "2026-10-05T00:00:00.000Z" }), "utf8");
    const r2 = await adjudicateJournal(opts(e2, repairSubject(sha(torn), 30, 66), "resend"));
    expect(r2).toMatchObject({ kind: "adjudicated", anchorMoved: false });
    await cleanup(e2);
  });
});

// r7（GPT r6 P1-r6-1）：结构一致门+影响域并入。repair 行 r7 起留痕结构归因 fragIntentId
// （生成面见 repair-tail.test.ts RT-r7-1/2）；写面据此强一致（矛盾裁决拒落盘），读面据此
// 并入影响域（冷捕获丢 raw 后结构归因不失忆——S5：结构 i1/持久裁决目标 i2→冷态 i1 放行的缝）。
describe("r7 结构一致门与影响域并入（GPT r6 P1-r6-1）", () => {
  const repairRowF = (byteStart: number, byteEnd: number, removedSha256: string, at: string, fragIntentId: string | null) =>
    JSON.stringify({ t: "repair", reason: "torn-tail", byteStart, byteEnd, removedSha256, buildId: "b1", contractVersion: 2, at, fragIntentId });
  it("R27 写面结构一致门：归因目标与 repair 行 fragIntentId 不一致→inconsistent-attribution 零追加；一致/无结构证据对照放行", async () => {
    const torn = '{"t":"sending","intentId":"i1","x":"y"';
    const H = sha(torn); const at = "2026-10-05T00:00:00.000Z";
    // 形一（S5 落盘前拦截）：结构 i1 留痕在场，fragment 裁决请求归因 i2 → 拒
    const e1 = await env([jl("i1"), jl("i2"), repairRowF(30, 66, H, at, "i1")]);
    await seedAnchor(e1);
    const before1 = await readFile(e1.abs);
    const r1 = await adjudicateJournal(opts(e1, fragSubject(H, 30, 66, at, "i2"), "resend"));
    expect(r1).toMatchObject({ kind: "aborted", reason: "inconsistent-attribution" });
    expect(await readFile(e1.abs)).toEqual(before1); // 零追加（盘面逐字节不变）
    // 形二：一致归因 i1 → 落行
    const r2 = await adjudicateJournal(opts(e1, fragSubject(H, 30, 66, at, "i1"), "resend"));
    expect(r2.kind).toBe("adjudicated");
    // 形三：fragIntentId=null（不可归因留痕）→无结构证据→不强一致（人工归因自由）
    const e3 = await env([jl("i1"), jl("i2"), repairRowF(30, 66, H, at, null)]);
    await seedAnchor(e3);
    const r3 = await adjudicateJournal(opts(e3, fragSubject(H, 30, 66, at, "i2"), "resend"));
    expect(r3.kind).toBe("adjudicated");
    // 形四：存量行（无字段）→现行为保持
    const e4 = await env([jl("i1"), jl("i2"), repairRow(30, 66, H, at)]);
    await seedAnchor(e4);
    const r4 = await adjudicateJournal(opts(e4, fragSubject(H, 30, 66, at, "i2"), "resend"));
    expect(r4.kind).toBe("adjudicated");
    for (const e of [e1, e3, e4]) await cleanup(e);
  });
  it("R28 读面影响域并入（S5 存量防御）：结构留痕 i1+持久裁决目标 i2——冷态 i1 不失忆（须覆盖判定）；热态对照+无关正对照", () => {
    const torn = '{"t":"sending","intentId":"i1","x":"y"';
    const H = sha(torn); const at = "2026-10-05T00:00:00.000Z";
    // S5 形（一致门前的存量已落库）：repair 行留痕 i1，fragment 裁决归因 i2（组内单目标，非冲突组）
    const rows = [jl("i1"), jl("i2"), jl("i3"), repairRowF(30, 66, H, at, "i1"),
      adjRepair(H, 30, 66, at, "resend"), adjFrag(H, 30, 66, at, "i2", "resend")];
    // 冷态（冷捕获丢 raw/fragments）：i1 因 fragIntentId 并入影响域→须 resendCovers(i1)（本事务归因 i2 无 i1→不覆盖）→排除（旧形：i1 失忆放行=S5 缺陷）
    const cold = buildRecoverReport(parseJournalText(`${rows.join("\n")}\n`).lines, "q", { fragments: [], blocked: false });
    expect(cold.resumeBlocked).toBe(false); // 事务有 fragment 裁决（i2）→非未归因事务，不全局阻断
    expect(cold.resumable).not.toContain("i1"); // 结构归因 i1 并入影响域——覆盖不成立→排除
    expect(cold.resumable).toContain("i2"); // 归因 i2 的 resend 裁决授权效果（单事务全覆盖成立）→合法重发
    expect(cold.resumable).toContain("i3"); // 无关意图正对照——影响域并入不得无差别封禁 enqueue
    // 热态对照：残片在场（结构归因 i1 进 unknown）→两态一致排除
    const hot = buildRecoverReport(parseJournalText(`${rows.join("\n")}\n`).lines, "q", {
      fragments: [{ raw: torn, error: "撕裂尾", partialTail: true }], blocked: false,
    });
    expect(hot.resumable).not.toContain("i1");
    expect(hot.resumable).toContain("i3");
    // 补正对照：一致归因（i1）落库后——冷态覆盖成立（单事务归因 i1 全覆盖）→授权成立且可重发（缝的修不是阻断重发，而是让覆盖判定拿到全部证据）
    const fixed = [jl("i1"), repairRowF(30, 66, H, at, "i1"),
      adjRepair(H, 30, 66, at, "resend"), adjFrag(H, 30, 66, at, "i1", "resend")];
    const ok = buildRecoverReport(parseJournalText(`${fixed.join("\n")}\n`).lines, "q", { fragments: [], blocked: false });
    expect(ok.resumeBlocked).toBe(false);
    expect(ok.resendAuthorized).toContain("i1"); // 结构留痕与归因一致→单事务全覆盖→授权成立
    expect(ok.resumable).toContain("i1"); // 覆盖成立→不排除；无 sending/终态→可重发（授权的目的即重发，与 resendAuthorized 一致）
  });
});

// r8（GPT r7 P2-r7-1）：N-abandon-official 转正——一致门不挑 verdict：fragment abandon 裁决
// 归因与 repair 行 fragIntentId 不一致同样拒（R27 只立了 resend 形，审人变异证明 abandon 形可绕）。
describe("r8 abandon verdict 一致门负例（N-abandon-official 转正）", () => {
  it("R31 fragment abandon 归因与行留痕不一致→inconsistent-attribution 零追加；一致对照放行", async () => {
    const repairRowF = (byteStart: number, byteEnd: number, removedSha256: string, at: string, fragIntentId: string | null) =>
      JSON.stringify({ t: "repair", reason: "torn-tail", byteStart, byteEnd, removedSha256, buildId: "b1", contractVersion: 2, at, fragIntentId });
    const torn = '{"t":"sending","intentId":"i1","x":"y"';
    const H = sha(torn); const at = "2026-10-05T00:00:00.000Z";
    const e = await env([jl("i1"), jl("i2"), repairRowF(30, 66, H, at, "i1")]);
    await seedAnchor(e);
    const before = await readFile(e.abs);
    const r1 = await adjudicateJournal(opts(e, fragSubject(H, 30, 66, at, "i2"), "abandon"));
    expect(r1).toMatchObject({ kind: "aborted", reason: "inconsistent-attribution" }); // abandon 同拦
    expect(await readFile(e.abs)).toEqual(before);
    const r2 = await adjudicateJournal(opts(e, fragSubject(H, 30, 66, at, "i1"), "abandon"));
    expect(r2.kind).toBe("adjudicated"); // 一致归因放行
    await cleanup(e);
  });
});

// r3（GPT r2 R2-F4）：默认契约版本精确断言—— adjudicate 默认写版本必须跟随常量
// （变异 `?? 2` 退回旧默认时本断言红；历史 fixture 的 v2 手造行不受影响）。
describe("r3 默认契约版本断言（Mu-extra-F4 锁）", () => {
  it("写出的 adjudicate 行 contractVersion===JOURNAL_CONTRACT_VERSION（默认路径无显式传入）", async () => {
    const torn = '{"t":"sending","intentId":"i1","x":"y"';
    const H = sha(torn); const at = "2026-10-05T00:00:00.000Z";
    const e = await env([jl("i1"), send("i1"), repairRow(30, 66, H)]);
    await seedAnchor(e);
    const r = await adjudicateJournal(opts(e, repairSubject(H, 30, 66), "resend"));
    expect(r.kind).toBe("adjudicated");
    const raw = await readFile(e.abs, "utf8");
    const adjLine = raw.split("\n").find((l) => l.includes('"t":"adjudicate"'));
    expect(adjLine).toBeTruthy();
    expect(JSON.parse(adjLine as string).contractVersion).toBe(JOURNAL_CONTRACT_VERSION);
    await cleanup(e);
  });
});
