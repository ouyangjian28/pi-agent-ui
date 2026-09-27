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
/** crash 句柄：append 真写、sync 抛（写后失败形——提交结果不确定）。 */
async function crashSync(abs: string): Promise<{ fh: FileHandle; size: number }> {
  const real = await (await import("../../../apps/server/src/ws/safe-open.ts")).openSafeReadWrite(abs);
  const fh = real.fh as unknown as FileHandle;
  const realAppend = fh.appendFile.bind(fh);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (fh as any).appendFile = async (data: unknown) => { await realAppend(data as never); throw new Error("crash-after-append"); };
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
    const subj = repairSubject(sha(torn), 30, 66);
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
    expect(report.resumeBlocked).toBe(false);
    expect(report.unknownEffect).toContain("i1"); // repair 裁决只解阴影不解效果
    expect(report.resumable).toEqual([]);
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
    const match = [...base, JSON.parse(adjRepair(sha("real-tail"), 22, 50))] as JournalLine[];
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
    expect((await import("../../../apps/server/src/runtime/recover.ts")).recoverFromSnapshot(snap).resumeBlocked).toBe(true);
    // 旧快照粘滞：裁决后旧快照 lines 不变（无裁决行）→repairUndecided 语义恒阻断
    expect((await import("../../../apps/server/src/runtime/recover.ts")).recoverFromSnapshot(snap, { repairUndecided: true }).resumeBlocked).toBe(true);
    // 落裁决→新快照（裁决行在场）解锁
    expect((await adjudicateJournal(opts(e, repairSubject(sha(torn), 30, 66), "resend"))).kind).toBe("adjudicated");
    const fresh = await recapture(e);
    const report = recoverFromSnapshot(fresh);
    expect(report.resumeBlocked).toBe(false);
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
    // 全部裁决→解锁
    expect((await adjudicateJournal(opts(e, repairSubject(sha(tornA), 30, 66, at2), "resend"))).kind).toBe("adjudicated");
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

  it("R9 abandon 终局：解锁修复阴影但 resumable 排除该意图（残片归因 unknown 真源）", async () => {
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
    await cleanup(e);
  });

  it("R11 祖先 symlink 越界（B4/P11 杀点）：实路径越出全部授权根=path-escape 拒零改盘；真实根内正常通过", async () => {
    const torn = '{"t":"sending","intentId":"i1"';
    const e = await env([jl("i1"), repairRow(30, 66, sha(torn))]);
    await seedAnchor(e);
    // 攻击面：授权根=普通目录，journal 通过祖先 symlink 引到根外真实位置
    const outside = await mkdtemp(join(tmpdir(), "adj-out-"));
    const realJournal = join(outside, e.file);
    await writeFile(realJournal, await readFile(e.abs));
    const gate = await mkdtemp(join(tmpdir(), "adj-gate-")); // 授权根（词法内）
    const { symlink } = await import("node:fs/promises");
    await symlink(realJournal, join(gate, e.file));
    const r = await adjudicateJournal({ file: e.file, roots: [gate], evidenceDir: e.evidenceDir, subject: repairSubject(sha(torn), 30, 66), verdict: "resend", operator: "host", buildId: "b1" });
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
});
