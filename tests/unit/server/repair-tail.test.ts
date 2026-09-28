// P0-1a 修复留痕（PROJECT P0 冻结序①）测试矩阵 RT1-RT26（GPT r1 64 NO-GO 修复批扩展）。
// 覆盖：①repair 行 schema/重放/投影（protocol）②repairJournalTail 工具事务（截断+marker
// 先行+写循环+锚点合法转移+竞态/残局 fail-closed+realpath 实根门）③读面派生（repairLog/
// bad 消失/diskBlocked 解除/B1 修复阴影=重发授权保守阻断）④证据链接链（修复后可再捕获）。
// 真实 fs 临时目录（mkdtemp）+真 provider 建锚；竞态/锚写故障/短写用结构化接缝确定性注入。
import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, appendFile, symlink, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  repairJournalTail,
  type RepairTailResult,
} from "../../../apps/server/src/runtime/repair-tail.ts";
import { createRecoveryEvidenceProvider, isRecoverySnapshot, type FsLike } from "../../../apps/server/src/runtime/recovery-evidence-source.ts";
import { parseJournalText, buildRecoverReport, recoverFromJournal, recoverFromSnapshot } from "../../../apps/server/src/runtime/recover.ts";
import { journalLineSchemaError, replayIntents, journalToScanRows, type JournalLine, type RepairLine } from "@pi-agent-ui/protocol";

const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
const jl = (i: string) => JSON.stringify({ t: "enqueue", intentId: i, sessionId: "q", generation: 1, leafId: "L", matchKey: { textHash: "h", attachmentIdentity: "a", ordinal: 1 }, payload: { kind: "prompt", rawText: "t", attachments: [], sentAt: "1" } });
const legalRepairRow = (byteStart: number, byteEnd: number, removedSha256: string) =>
  JSON.stringify({ t: "repair", reason: "torn-tail", byteStart, byteEnd, removedSha256, buildId: "b1", contractVersion: 2, at: "2026-10-05T00:00:00.000Z" } satisfies RepairLine);

interface Env { roots: string; evidenceDir: string; file: string; abs: string }

async function env(lines: string[], tail = ""): Promise<Env> {
  const roots = await mkdtemp(join(tmpdir(), "rt-roots-"));
  const evidenceDir = await mkdtemp(join(tmpdir(), "rt-ev-"));
  const file = "q.jsonl"; // 快照 sessionId 从文件名派生→与 jl() 的 sessionId "q" 对齐
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

/** 锚点写抛但 marker 写放行（选择性故障：区分 marker 阶段与锚转移阶段）。 */
const anchorBoom: FsLike = {
  writeFile: async (p, d, e2) => { if (String(p).includes(".repair-pending")) { const { writeFile: w } = await import("node:fs/promises"); await w(p, d, e2); return; } throw new Error("disk full"); },
  rename: async (f, t) => { if (String(f).includes(".repair-pending")) { const { rename: rn } = await import("node:fs/promises"); await rn(f, t); return; } throw new Error("disk full"); },
  rm: async () => {},
};


describe("P0-1a repair 行 protocol 面", () => {
  const good = { t: "repair", reason: "torn-tail", byteStart: 10, byteEnd: 25, removedSha256: "a".repeat(64), buildId: "b1", contractVersion: 2, at: "2026-10-05T00:00:00.000Z" };
  it("RT13 合法 repair 行过 schema；六种坏形态判坏", () => {
    expect(journalLineSchemaError({ ...good })).toBeNull();
    expect(journalLineSchemaError({ ...good, byteEnd: 10 })).toMatch(/区间/);
    expect(journalLineSchemaError({ ...good, byteStart: -1 })).toMatch(/byteStart/);
    expect(journalLineSchemaError({ ...good, removedSha256: "xyz" })).toMatch(/removedSha256/);
    expect(journalLineSchemaError({ ...good, buildId: "" })).toMatch(/buildId/);
    expect(journalLineSchemaError({ ...good, contractVersion: 0 })).toMatch(/contractVersion/);
    expect(journalLineSchemaError({ ...good, reason: "other" })).toMatch(/reason/);
  });
  it("RT14 replayIntents 忽略 repair 行：插入前后聚合深度相等（GPT r1 B6 重写）", () => {
    const base: JournalLine[] = [
      JSON.parse(jl("i1")) as JournalLine,
      { t: "sending", intentId: "i1" },
      { t: "settled", intentId: "i1" },
    ];
    const repair: JournalLine = JSON.parse(legalRepairRow(100, 130, "b".repeat(64))) as JournalLine;
    const withRepair = [...base, repair];
    const a = replayIntents(base, "q");
    const b = replayIntents(withRepair, "q");
    expect([...b.keys()]).toEqual([...a.keys()]);
    for (const k of a.keys()) expect(JSON.stringify(b.get(k))).toBe(JSON.stringify(a.get(k)));
  });
  it("RT15 投影：journal-repair 事件带区间；撕裂 repair 行不发布", () => {
    const line = legalRepairRow(10, 25, "a".repeat(64));
    const rows = journalToScanRows(`${line}\n{"t":"repair","reason":"torn-t`);
    expect(rows).toHaveLength(1);
    expect(rows[0].event.kind).toBe("journal-repair");
    expect((rows[0].event as { repairByteStart?: number }).repairByteStart).toBe(10);
  });
});

describe("P0-1a repairJournalTail 工具事务", () => {
  it("RT1 happy：marker 先行+截尾+写循环+补行+锚点转移+可再捕获+读面认行+marker 清理", async () => {
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
    expect(r.via).toBe("fresh");
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
    expect(r.anchor?.len).toBe(anchor.len);
    expect(r.anchor?.sha).toBe(anchor.sha);
    // marker 清理：无 repair-pending 残留，锚点恰一份（seen.json 为登记表非 marker）
    const files = await readdir(e.evidenceDir);
    expect(files.filter((f) => f.includes("repair-pending"))).toHaveLength(0);
    expect(files.filter((f) => f.endsWith(".evidence.json"))).toHaveLength(1);
    // 死结闭合：修复后 provider 再捕获成功
    const p = createRecoveryEvidenceProvider({ roots: [e.roots], evidenceDir: e.evidenceDir });
    const cap = await p(e.file);
    expect(isRecoverySnapshot(cap)).toBe(true);
    // 读面：bad 空+repairLog 派生+diskBlocked 解除（B1 修复阴影单独断言见 RT19）
    const rec = await recoverFromJournal(e.abs, "q");
    expect(rec.bad).toHaveLength(0);
    expect(rec.repairLog).toHaveLength(1);
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

  it("RT3 无锚：修复照做但绝不建锚（首捕授权面不在此）；marker 清理后 sidecar 目录空", async () => {
    const e = await env([jl("i1")], `{"t":"send`);
    const r = await repairJournalTail(OPT(e));
    expect(r.kind).toBe("repaired");
    if (r.kind === "repaired") expect(r.anchor).toBeNull();
    const files = await readdir(e.evidenceDir);
    expect(files).toHaveLength(0);
    await rm(e.roots, { recursive: true, force: true });
    await rm(e.evidenceDir, { recursive: true, force: true });
  });

  it("RT4 锚不匹配（盘面已被改写）：拒绝动手，文件原样", async () => {
    const e = await env([jl("i1"), jl("i2")]);
    await seedAnchor(e);
    await writeFile(e.abs, `${jl("i9")}\n{"t":"sending","intentId":"i9","par`, "utf8");
    const before = await readFile(e.abs, "utf8");
    const r = await repairJournalTail(OPT(e));
    expect(r.kind).toBe("aborted");
    if (r.kind === "aborted") expect(r.reason).toBe("anchor-mismatch");
    expect(await readFile(e.abs, "utf8")).toBe(before);
    await rm(e.roots, { recursive: true, force: true });
    await rm(e.evidenceDir, { recursive: true, force: true });
  });

  it("RT5 读后竞态：复核杀（file-changed），文件不被工具改且无 marker 残留", async () => {
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
    expect(after).toBe(`${clean}{"t":"sendX`);
    const files = await readdir(e.evidenceDir);
    expect(files.filter((f) => f.includes("repair-pending"))).toHaveLength(0); // marker 只在复核通过后落盘
    await rm(e.roots, { recursive: true, force: true });
    await rm(e.evidenceDir, { recursive: true, force: true });
  });

  it("RT6 无 marker 残局（行已落盘+锚回退+marker 失踪）无授权：anchor-stale fail-closed", async () => {
    const e = await env([jl("i1")]);
    await seedAnchor(e);
    const oldAnchor = await readFile(join(e.evidenceDir, `${encodeURIComponent(e.file)}.evidence.json`), "utf8");
    await appendFile(e.abs, `{"t":"send`, "utf8");
    // 真修复成功后手工回退锚+删 marker=「marker 丢失的崩溃窗口 B」等价形态（纵深防御面）
    await repairJournalTail(OPT(e));
    await writeFile(join(e.evidenceDir, `${encodeURIComponent(e.file)}.evidence.json`), oldAnchor, "utf8");
    await rm(join(e.evidenceDir, `${encodeURIComponent(e.file)}.repair-pending.json`), { force: true });
    const r = await repairJournalTail(OPT(e));
    expect(r.kind).toBe("aborted");
    if (r.kind === "aborted") expect(r.reason).toBe("anchor-stale");
    await rm(e.roots, { recursive: true, force: true });
    await rm(e.evidenceDir, { recursive: true, force: true });
  });

  it("RT7 无 marker 残局+显式授权：reconciled 补完锚点（可再捕获）", async () => {
    const e = await env([jl("i1")]);
    await seedAnchor(e);
    const oldAnchor = await readFile(join(e.evidenceDir, `${encodeURIComponent(e.file)}.evidence.json`), "utf8");
    await appendFile(e.abs, `{"t":"send`, "utf8");
    await repairJournalTail(OPT(e));
    await writeFile(join(e.evidenceDir, `${encodeURIComponent(e.file)}.evidence.json`), oldAnchor, "utf8");
    await rm(join(e.evidenceDir, `${encodeURIComponent(e.file)}.repair-pending.json`), { force: true });
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

  it("RT8 锚曾覆盖被移除字节（marker 在场）：授权也永拒（前缀伪造不可排除）", async () => {
    const e = await env([jl("i1")]);
    await appendFile(e.abs, `{"t":"send`, "utf8");
    await seedAnchor(e); // 锚覆盖含撕裂尾的全文
    // 选择性故障：marker 落盘成功，锚转移抛 → 残局=行已补+marker 在+锚仍旧
    await expect(repairJournalTail(OPT(e, { fsLike: anchorBoom }))).rejects.toThrow("disk full");
    const r = await repairJournalTail(OPT(e, { authorizeStaleAnchorRepair: () => true }));
    expect(r.kind).toBe("aborted");
    if (r.kind === "aborted") expect(r.reason).toBe("anchor-stale");
    // marker 保留（fail-closed 证据留给宿主）
    expect((await readdir(e.evidenceDir)).some((f) => f.includes("repair-pending"))).toBe(true);
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
    const { lines } = parseJournalText(`${jl("i1")}\n${legalRepairRow(100, 130, "b".repeat(64))}\n`);
    expect(lines.filter((l) => l.t === "repair")).toHaveLength(1);
    const rep = buildRecoverReport(lines, "q", { fragments: [], blocked: false });
    expect(rep.repairLog).toHaveLength(1);
    expect(rep.repairLog[0]?.buildId).toBe("b1");
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

  it("RT18 错界伪行不触发无 marker reconcile，锚点不被搬动", async () => {
    const e = await env([jl("i1")]);
    await seedAnchor(e);
    const clean = await readFile(e.abs, "utf8");
    const row = legalRepairRow(Buffer.byteLength(clean, "utf8") + 3, Buffer.byteLength(clean, "utf8") + 99, "c".repeat(64));
    await writeFile(e.abs, `${clean}${row}\n`, "utf8");
    const r = await repairJournalTail(OPT(e, { authorizeStaleAnchorRepair: () => true }));
    expect(r.kind).toBe("no-torn-tail");
    const anchor = JSON.parse(await readFile(join(e.evidenceDir, `${encodeURIComponent(e.file)}.evidence.json`), "utf8")) as { len: number };
    expect(anchor.len).toBe(Buffer.byteLength(clean, "utf8"));
    await rm(e.roots, { recursive: true, force: true });
    await rm(e.evidenceDir, { recursive: true, force: true });
  });
});

describe("P0-1a GPT r1 阻断修复批（B1-B6）", () => {
  it("RT19-B1 修复不得解锁重发：修复前 unknown/blocked→修复后再捕获 resumable 恒空+resumeBlocked=true", async () => {
    const e = await env(
      [jl("i1"), JSON.stringify({ t: "sending", intentId: "i1" })],
      `{"t":"settled","intentId":"i1"`,
    ); // 完整 sending 行+torn settled 行→i1 效果未知
    await seedAnchor(e);
    // 修复前：真 provider 捕获（含坏尾证据）→ i1 效果未知+阻断
    const p0 = createRecoveryEvidenceProvider({ roots: [e.roots], evidenceDir: e.evidenceDir });
    const cap0 = await p0(e.file);
    if (!isRecoverySnapshot(cap0)) throw new Error("修复前捕获应成功");
    const before = recoverFromSnapshot(cap0);
    expect(before.unknownEffect).toContain("i1");
    expect(before.resumable).toHaveLength(0);
    // 修复+合法转锚
    expect((await repairJournalTail(OPT(e))).kind).toBe("repaired");
    // 新实例再捕获（旧内存快照不可依赖）→ 走真权威链
    const p1 = createRecoveryEvidenceProvider({ roots: [e.roots], evidenceDir: e.evidenceDir });
    const cap1 = await p1(e.file);
    if (!isRecoverySnapshot(cap1)) throw new Error("修复后捕获应成功（死结已闭合）");
    const after = recoverFromSnapshot(cap1);
    expect(after.repairLog).toHaveLength(1);
    expect(after.diskBlocked).toBe(false);
    expect(after.resumeBlocked).toBe(true); // B1：修复阴影——物理修复≠裁决
    expect(after.resumable).toHaveLength(0); // i1 不得从 unknown/blocked 降为可重发
    await rm(e.roots, { recursive: true, force: true });
    await rm(e.evidenceDir, { recursive: true, force: true });
  });

  it("RT20-B2 schema 非法 repair 行不得作为残局补完凭证（无 marker 面与 marker 面同界）", async () => {
    const e = await env([jl("i1")]);
    await seedAnchor(e);
    const clean = await readFile(e.abs, "utf8");
    // 缺字段非法行：共享 schema 判坏
    const bad = JSON.stringify({ t: "repair", byteStart: Buffer.byteLength(clean, "utf8") });
    expect(journalLineSchemaError(JSON.parse(bad))).not.toBeNull();
    await writeFile(e.abs, `${clean}${bad}\n`, "utf8");
    // 无 marker 残局面：不得 reconcile
    const r = await repairJournalTail(OPT(e, { authorizeStaleAnchorRepair: () => true }));
    expect(r.kind).toBe("no-torn-tail"); // 非法行不认=非未完成事务；且不得搬锚
    const anchor = JSON.parse(await readFile(join(e.evidenceDir, `${encodeURIComponent(e.file)}.evidence.json`), "utf8")) as { len: number };
    expect(anchor.len).toBe(Buffer.byteLength(clean, "utf8"));
    await rm(e.roots, { recursive: true, force: true });
    await rm(e.evidenceDir, { recursive: true, force: true });
  });

  it("RT21-B3 realpath 实根门：根外 symlink 逃逸拒修文件原样；根内 symlink 放行", async () => {
    const outsideRoot = await mkdtemp(join(tmpdir(), "rt-out-"));
    const roots = await mkdtemp(join(tmpdir(), "rt-roots-"));
    const evidenceDir = await mkdtemp(join(tmpdir(), "rt-ev-"));
    await mkdir(join(roots, "nested"));
    await symlink(outsideRoot, join(roots, "nested", "link")); // root/nested/link -> 根外
    const victim = join(outsideRoot, "victim.jsonl");
    await writeFile(victim, `${jl("i1")}\n{"t":"send`, "utf8");
    const before = await readFile(victim, "utf8");
    const r = await repairJournalTail({ file: "nested/link/victim.jsonl", roots: [roots], evidenceDir, buildId: "b" });
    expect(r.kind).toBe("aborted");
    if (r.kind === "aborted") expect(r.reason).toBe("path-escape");
    expect(await readFile(victim, "utf8")).toBe(before); // 根外文件未被截写
    // 根内 symlink：目标仍在授权根内 → 放行（实路径包含）
    const realDir = join(roots, "real");
    await mkdir(realDir);
    await writeFile(join(realDir, "in.jsonl"), `${jl("i1")}\n{"t":"send`, "utf8");
    await symlink(realDir, join(roots, "inlink"));
    const r2 = await repairJournalTail({ file: "inlink/in.jsonl", roots: [roots], evidenceDir, buildId: "b" });
    expect(r2.kind).toBe("repaired");
    await rm(roots, { recursive: true, force: true }); await rm(evidenceDir, { recursive: true, force: true }); await rm(outsideRoot, { recursive: true, force: true });
  });

  it("RT22-B4 短写推进：首写 8 字节仍补全行+锚=盘面事实；停滞抛锚不动", async () => {
    const e = await env([jl("i1")]);
    await seedAnchor(e);
    await appendFile(e.abs, `{"t":"send`, "utf8");
    const clean = (await readFile(e.abs, "utf8")).slice(0, -(await readFile(e.abs, "utf8")).length + Buffer.byteLength(jl("i1")) + 1);
    // 短写注入：真句柄包装——首调只写 8 字节返回短写结果，余走真写
    let first = true;
    const shortWriteHandle = async (abs: string) => {
      const real = await (await import("../../../apps/server/src/ws/safe-open.ts")).openSafeReadWrite(abs);
      const fh = real.fh as unknown as import("node:fs/promises").FileHandle;
      const orig = fh.write.bind(fh);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (fh as any).write = async (buf: Buffer, _off: number, len: number, pos: number) => {
        if (first && len > 8) { first = false; const slice = buf.subarray(_off, _off + 8); await orig(slice, 0, 8, pos); return { bytesWritten: 8, buffer: buf }; }
        return orig(buf, _off, len, pos);
      };
      return { fh, size: real.size };
    };
    const r = await repairJournalTail(OPT(e, { openHandle: shortWriteHandle }));
    expect(r.kind).toBe("repaired");
    const after = await readFile(e.abs, "utf8");
    expect(after.startsWith(clean)).toBe(true);
    const anchor = JSON.parse(await readFile(join(e.evidenceDir, `${encodeURIComponent(e.file)}.evidence.json`), "utf8")) as { len: number; sha: string };
    expect(anchor.len).toBe(Buffer.byteLength(after, "utf8")); // 锚=回读验证后的盘面，非虚构拼接
    expect(anchor.sha).toBe(sha(after));
    // 停滞注入：恒零进展 → 抛错+锚不动+marker 留存（重试可续）
    const e2 = await env([jl("i1")]);
    await seedAnchor(e2);
    await appendFile(e2.abs, `{"t":"send`, "utf8");
    const oldA2 = await readFile(join(e2.evidenceDir, `${encodeURIComponent(e2.file)}.evidence.json`), "utf8");
    const stallHandle = async (abs: string) => {
      const real = await (await import("../../../apps/server/src/ws/safe-open.ts")).openSafeReadWrite(abs);
      const fh = real.fh as unknown as import("node:fs/promises").FileHandle;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (fh as any).write = async (buf: Buffer) => ({ bytesWritten: 0, buffer: buf });
      return { fh, size: real.size };
    };
    await expect(repairJournalTail(OPT(e2, { openHandle: stallHandle }))).rejects.toThrow("write-stall");
    expect(await readFile(join(e2.evidenceDir, `${encodeURIComponent(e2.file)}.evidence.json`), "utf8")).toBe(oldA2); // 锚未动
    expect((await readdir(e2.evidenceDir)).some((f) => f.includes("repair-pending"))).toBe(true); // marker 留存
    // 重试（真写）→ marker 截断形补完（P5 链闭合）
    const rr = await repairJournalTail(OPT(e2));
    expect(rr.kind).toBe("repaired");
    if (rr.kind === "repaired") expect(rr.via).toBe("marker-complete");
    const rec = await recoverFromJournal(e2.abs, "q");
    expect(rec.repairLog).toHaveLength(1);
    expect(rec.resumable).toHaveLength(0); // B1 阴影同链生效
    await rm(e.roots, { recursive: true, force: true }); await rm(e.evidenceDir, { recursive: true, force: true });
    await rm(e2.roots, { recursive: true, force: true }); await rm(e2.evidenceDir, { recursive: true, force: true });
  });

  it("RT23-P5 截断后写行前崩溃（marker 在）：重试 marker 补完，不无痕回退", async () => {
    const e = await env([jl("i1")]);
    await seedAnchor(e);
    const cleanLen = Buffer.byteLength(jl("i1")) + 1;
    await appendFile(e.abs, `{"t":"send`, "utf8");
    const throwHandle = async (abs: string) => {
      const real = await (await import("../../../apps/server/src/ws/safe-open.ts")).openSafeReadWrite(abs);
      const fh = real.fh as unknown as import("node:fs/promises").FileHandle;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (fh as any).write = async () => { throw new Error("crash after truncate"); };
      return { fh, size: real.size };
    };
    await expect(repairJournalTail(OPT(e, { openHandle: throwHandle }))).rejects.toThrow("crash after truncate");
    // 截断已做（marker 落盘先于截断）：file=干净前缀
    expect((await readFile(e.abs, "utf8")).length).toBe(cleanLen); // jl("i1")+\n
    // 重试：marker 截断形补完（行补上+锚转移+marker 清）
    const r = await repairJournalTail(OPT(e));
    expect(r.kind).toBe("repaired");
    if (r.kind === "repaired") {
      expect(r.via).toBe("marker-complete");
      expect(r.removedSha256).toBe(sha(`{"t":"send`)); // 事实来自 marker（尾已物理消失）
    }
    expect((await readdir(e.evidenceDir)).some((f) => f.includes("repair-pending"))).toBe(false);
    const rec = await recoverFromJournal(e.abs, "q");
    expect(rec.repairLog).toHaveLength(1);
    expect(rec.resumable).toHaveLength(0); // 无痕回退不可能：repairLog 在场=阻断
    await rm(e.roots, { recursive: true, force: true });
    await rm(e.evidenceDir, { recursive: true, force: true });
  });

  it("RT24-P6 空行不截断扫描：前缀与 repair 行间的空行后仍能识别末行（授权补完）", async () => {
    const e = await env([jl("i1")]);
    await seedAnchor(e);
    const clean = await readFile(e.abs, "utf8");
    const rowOff = Buffer.byteLength(clean, "utf8") + 1; // 空行后
    const row = legalRepairRow(rowOff, rowOff + 10, "d".repeat(64));
    await writeFile(e.abs, `${clean}\n${row}\n`, "utf8"); // 干净前缀+空行+repair 行（无 marker 残局）
    const r = await repairJournalTail(OPT(e, { authorizeStaleAnchorRepair: () => true }));
    expect(r.kind).toBe("reconciled");
    await rm(e.roots, { recursive: true, force: true });
    await rm(e.evidenceDir, { recursive: true, force: true });
  });

  it("RT25-L5 maxBytes 非法值：NaN/0/Infinity 拒绝服务", async () => {
    const e = await env([jl("i1")], `{"t":"send`);
    await expect(repairJournalTail(OPT(e, { maxBytes: Number.NaN }))).rejects.toThrow("maxBytes");
    await expect(repairJournalTail(OPT(e, { maxBytes: 0 }))).rejects.toThrow("maxBytes");
    await expect(repairJournalTail(OPT(e, { maxBytes: Number.POSITIVE_INFINITY }))).rejects.toThrow("maxBytes");
    await rm(e.roots, { recursive: true, force: true });
    await rm(e.evidenceDir, { recursive: true, force: true });
  });

  it("RT26 marker 冲突：盘面与 marker 事实不吻合→fail-closed 保留 marker", async () => {
    const e = await env([jl("i1")]);
    await seedAnchor(e);
    // 伪造 marker（bounds 与盘面无关）
    const mp = join(e.evidenceDir, `${encodeURIComponent(e.file)}.repair-pending.json`);
    await writeFile(mp, JSON.stringify({ version: 1, file: e.file, byteStart: 999, byteEnd: 1040, removedSha256: "e".repeat(64), startedAt: "t" }), "utf8");
    const r = await repairJournalTail(OPT(e, { authorizeStaleAnchorRepair: () => true }));
    expect(r.kind).toBe("aborted");
    if (r.kind === "aborted") expect(r.reason).toBe("repair-marker-conflict");
    expect((await readdir(e.evidenceDir)).some((f) => f.includes("repair-pending"))).toBe(true); // marker 保留
    await rm(e.roots, { recursive: true, force: true });
    await rm(e.evidenceDir, { recursive: true, force: true });
  });
});

void ({} as unknown as RepairTailResult);

// P0-1a GPT r2 六阻断修复批（B1-B6；B1=provider 面见 recovery-evidence-source.test.ts RT27/RT28）。
describe("P0-1a GPT r2 阻断修复批（B2/B3/B4）", () => {
  /** marker 落盘后 truncate 抛（吻合形残局制造器：盘面尾仍在+marker 在场）。 */
  const truncateBoomHandle = async (abs: string) => {
    const real = await (await import("../../../apps/server/src/ws/safe-open.ts")).openSafeReadWrite(abs);
    const fh = real.fh as unknown as import("node:fs/promises").FileHandle;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fh as any).truncate = async () => { throw new Error("crash after marker"); };
    return { fh, size: real.size };
  };

  /** 行校验后、readBack 首块（position=0 全量读）前外部等长改写某字节（P7 篡改注入：readBack 事务后像窗口外）。 */
  const tamperAfterRowVerify = async (abs: string, mutate: (buf: Buffer) => void) => {
    const real = await (await import("../../../apps/server/src/ws/safe-open.ts")).openSafeReadWrite(abs);
    const fh = real.fh as unknown as import("node:fs/promises").FileHandle;
    const origSync = fh.datasync.bind(fh);
    const origRead = fh.read.bind(fh);
    let syncs = 0;
    let boomed = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fh as any).datasync = async () => { syncs++; return origSync(); };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fh as any).read = async (buf: Buffer, off: number, len: number, pos: number) => {
      if (!boomed && syncs >= 2 && pos === 0) { boomed = true; const cur = Buffer.from(await readFile(abs, "utf8"), "utf8"); mutate(cur); const { writeFile: w } = await import("node:fs/promises"); await w(abs, cur); }
      return origRead(buf, off, len, pos);
    };
    return { fh, size: real.size };
  };

  it("RT29-B2/P7 写后回读前等长篡改前缀→prefix-mismatch-after-repair 抛+锚不搬+marker 留（重试可续）", async () => {
    const e = await env([jl("i1")], `{"t":"sending","intentId":"i1","pa`);
    await seedAnchor(e);
    const oldAnchor = await readFile(join(e.evidenceDir, `${encodeURIComponent(e.file)}.evidence.json`), "utf8");
    const clean = await readFile(e.abs, "utf8");
    await expect(repairJournalTail(OPT(e, { openHandle: (abs) => tamperAfterRowVerify(abs, (buf) => { buf[0] = buf[0] === 0x7b ? 0x5b : 0x7b; }) })))
      .rejects.toThrow("prefix-mismatch-after-repair");
    // 锚未转移（仍=篡改前事实）+marker 在场（事务未完）+盘面已含 repair 行（物理修复完成）
    expect(await readFile(join(e.evidenceDir, `${encodeURIComponent(e.file)}.evidence.json`), "utf8")).toBe(oldAnchor);
    expect((await readdir(e.evidenceDir)).some((f) => f.includes("repair-pending"))).toBe(true);
    const now = await readFile(e.abs, "utf8");
    expect(now.length).toBeGreaterThan(clean.length); // 行已补（回读验证=篡改暴露而非回退）
    expect(now.includes(`"t":"repair"`)).toBe(true);
    // 等长篡改不可逆（首字节已坏）→重试走 anchor-mismatch 拒（fail-closed 交宿主）
    const r2 = await repairJournalTail(OPT(e));
    expect(r2.kind).toBe("aborted");
    await rm(e.roots, { recursive: true, force: true });
    await rm(e.evidenceDir, { recursive: true, force: true });

    // P7 行段版：等长改写 repair 行内字节（不动前缀）→row-mismatch-after-repair 抛（B6 专杀面：
    // R2-row-check-off 变异=删行段验证必须被此例杀死）
    const e2 = await env([jl("i1")], `{"t":"sending","intentId":"i1","pa`);
    await seedAnchor(e2);
    const clean2 = await readFile(e2.abs, "utf8");
    const bs2 = Buffer.byteLength(clean2, "utf8") - Buffer.byteLength(`{"t":"sending","intentId":"i1","pa`, "utf8");
    await expect(repairJournalTail(OPT(e2, { openHandle: (abs) => tamperAfterRowVerify(abs, (buf) => { buf[bs2] = buf[bs2] === 0x7b ? 0x5b : 0x7b; }) })))
      .rejects.toThrow("row-mismatch-after-repair");
    expect((await readdir(e2.evidenceDir)).some((f) => f.includes("repair-pending"))).toBe(true);
    await rm(e2.roots, { recursive: true, force: true });
    await rm(e2.evidenceDir, { recursive: true, force: true });
  });

  it("RT30-B2/P8 写后回读前截短→read-back-short 抛（不虚构锚）+marker 留", async () => {
    const e = await env([jl("i1")], `{"t":"sending","intentId":"i1","par`);
    await seedAnchor(e);
    const oldAnchor = await readFile(join(e.evidenceDir, `${encodeURIComponent(e.file)}.evidence.json`), "utf8");
    const truncateShortAfterWrite = async (abs: string) => {
      const real = await (await import("../../../apps/server/src/ws/safe-open.ts")).openSafeReadWrite(abs);
      const fh = real.fh as unknown as import("node:fs/promises").FileHandle;
      const origSync = fh.datasync.bind(fh);
      let syncs = 0;
      const origRead = fh.read.bind(fh);
      let boomed = false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (fh as any).datasync = async () => { syncs++; return origSync(); };
      // 校验后截短注入：行校验读之后、readBack 首块（position=0 的全量读）前——P8 原语义位
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (fh as any).read = async (buf: Buffer, off: number, len: number, pos: number) => {
        if (!boomed && syncs >= 2 && pos === 0) {
          boomed = true;
          const { truncate: t } = await import("node:fs/promises");
          await t(abs, 5);
        }
        return origRead(buf, off, len, pos);
      };
      return { fh, size: real.size };
    };
    await expect(repairJournalTail(OPT(e, { openHandle: truncateShortAfterWrite }))).rejects.toThrow("read-back-short");
    expect(await readFile(join(e.evidenceDir, `${encodeURIComponent(e.file)}.evidence.json`), "utf8")).toBe(oldAnchor);
    expect((await readdir(e.evidenceDir)).some((f) => f.includes("repair-pending"))).toBe(true);
    await rm(e.roots, { recursive: true, force: true });
    await rm(e.evidenceDir, { recursive: true, force: true });
  });

  it("RT31-B3/P5 有尾+marker 冲突（bounds 不吻合且非部分补行）→repair-marker-conflict 拒+marker 保留+盘面不动", async () => {
    const e = await env([jl("i1")], `{"t":"sending","intentId":"i9","x`);
    await seedAnchor(e);
    const before = await readFile(e.abs, "utf8");
    const mp = join(e.evidenceDir, `${encodeURIComponent(e.file)}.repair-pending.json`);
    await writeFile(mp, JSON.stringify({ version: 1, file: e.file, byteStart: 999, byteEnd: 1040, removedSha256: "e".repeat(64), startedAt: "t" }), "utf8");
    const r = await repairJournalTail(OPT(e, { authorizeStaleAnchorRepair: () => true }));
    expect(r.kind).toBe("aborted");
    if (r.kind === "aborted") expect(r.reason).toBe("repair-marker-conflict");
    expect(await readFile(e.abs, "utf8")).toBe(before); // 盘面一字不动（旧代码在此覆盖真 marker=P5）
    const markerAfter = JSON.parse(await readFile(mp, "utf8")) as { startedAt: string };
    expect(markerAfter.startedAt).toBe("t"); // marker 原文保留（不被重写）
    await rm(e.roots, { recursive: true, force: true });
    await rm(e.evidenceDir, { recursive: true, force: true });
  });

  it("RT32-B3/P10 部分补行形：行写一半崩溃→ftruncate 回截断形+marker 补完（原始删除事实保留）", async () => {
    const e = await env([jl("i1")]); // 无尾建锚（锚=干净前缀——不覆盖被移除字节）
    await seedAnchor(e);
    await appendFile(e.abs, `{"t":"sending","intentId":"i1","payload":{"kind":"prompt"`, "utf8");
    // 阶段一：真跑到截断完成+写抛（marker 落盘，startedAt=真值）
    const throwHandle = async (abs: string) => {
      const real = await (await import("../../../apps/server/src/ws/safe-open.ts")).openSafeReadWrite(abs);
      const fh = real.fh as unknown as import("node:fs/promises").FileHandle;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (fh as any).write = async () => { throw new Error("crash after truncate"); };
      return { fh, size: real.size };
    };
    await expect(repairJournalTail(OPT(e, { openHandle: throwHandle }))).rejects.toThrow("crash after truncate");
    const mp = join(e.evidenceDir, `${encodeURIComponent(e.file)}.repair-pending.json`);
    const marker = JSON.parse(await readFile(mp, "utf8")) as { byteStart: number; byteEnd: number; removedSha256: string; startedAt: string };
    // 阶段二：手工补「marker 构造行的严格前缀」= 行写一半崩溃形态（buildId/at 与重试参数一致）
    const mrow = Buffer.from(JSON.stringify({ t: "repair", reason: "torn-tail", byteStart: marker.byteStart, byteEnd: marker.byteEnd, removedSha256: marker.removedSha256, buildId: "build-rt", contractVersion: 2, at: marker.startedAt }) + "\n", "utf8");
    const tail = mrow.subarray(0, 30); // 30 字节严格前缀（< 区间长）
    await appendFile(e.abs, tail, "utf8");
    // 阶段三：重试→部分补行形→截回截断形→marker 补完（事实全部来自 marker）
    const r = await repairJournalTail(OPT(e));
    expect(r.kind).toBe("repaired");
    if (r.kind === "repaired") {
      expect(r.via).toBe("marker-complete");
      expect(r.removedSha256).toBe(marker.removedSha256); // 原始删除事实不被二次修复覆盖（P10）
      expect(r.at).toBe(marker.startedAt);
    }
    expect((await readdir(e.evidenceDir)).some((f) => f.includes("repair-pending"))).toBe(false);
    const rec = await recoverFromJournal(e.abs, "q");
    expect(rec.repairLog).toHaveLength(1);
    expect(rec.resumable).toHaveLength(0); // B1 阴影同链
    await rm(e.roots, { recursive: true, force: true });
    await rm(e.evidenceDir, { recursive: true, force: true });
  });

  it("RT33-B3 吻合形 marker 复用：truncate 前崩溃重试→fresh 完成+startedAt 保留原始时间戳", async () => {
    const e = await env([jl("i1")], `{"t":"sending","intentId":"i1","p`);
    await seedAnchor(e);
    await expect(repairJournalTail(OPT(e, { openHandle: truncateBoomHandle }))).rejects.toThrow("crash after marker");
    const mp = join(e.evidenceDir, `${encodeURIComponent(e.file)}.repair-pending.json`);
    const marker = JSON.parse(await readFile(mp, "utf8")) as { startedAt: string };
    const r = await repairJournalTail(OPT(e));
    expect(r.kind).toBe("repaired");
    if (r.kind === "repaired") {
      expect(r.via).toBe("fresh"); // 吻合形=续原事务（非新开）
      expect(r.at).toBe(marker.startedAt); // 事实链时间戳保留
    }
    expect((await readdir(e.evidenceDir)).some((f) => f.includes("repair-pending"))).toBe(false);
    const rec = await recoverFromJournal(e.abs, "q");
    expect(rec.repairLog).toHaveLength(1);
    expect(rec.resumable).toHaveLength(0);
    await rm(e.roots, { recursive: true, force: true });
    await rm(e.evidenceDir, { recursive: true, force: true });
  });

  it("RT34-B4/P6 幂等清理形+clearMarker 不吞错：rm 故障上浮→重试 marker-cleanup 补完（无需授权）", async () => {
    const e = await env([jl("i1")], `{"t":"sending","intentId":"i1","p`);
    await seedAnchor(e);
    const rmBoom: FsLike = {
      writeFile: async (p2, d, e2) => { const { writeFile: w } = await import("node:fs/promises"); await w(p2, d, e2); },
      rename: async (f, t) => { const { rename: rn } = await import("node:fs/promises"); await rn(f, t); },
      rm: async () => { throw new Error("marker-rm-boom"); },
    };
    await expect(repairJournalTail(OPT(e, { fsLike: rmBoom }))).rejects.toThrow("marker-rm-boom");
    // 物理修复已完成（行+锚转移）+marker 残留=clearMarker 崩溃窗（旧代码吞错=静默残局）
    const after = await readFile(e.abs, "utf8");
    expect(after.includes(`"t":"repair"`)).toBe(true);
    const anchor = JSON.parse(await readFile(join(e.evidenceDir, `${encodeURIComponent(e.file)}.evidence.json`), "utf8")) as { len: number; sha: string };
    expect(anchor.len).toBe(Buffer.byteLength(after, "utf8"));
    expect((await readdir(e.evidenceDir)).some((f) => f.includes("repair-pending"))).toBe(true);
    // 重试（真 fs+无授权）：幂等清理形——盘面新后像与锚全等→清 marker 返 marker-cleanup
    const r = await repairJournalTail(OPT(e));
    expect(r.kind).toBe("reconciled");
    if (r.kind === "reconciled") expect(r.via).toBe("marker-cleanup");
    expect((await readdir(e.evidenceDir)).some((f) => f.includes("repair-pending"))).toBe(false);
    const anchorAfter = JSON.parse(await readFile(join(e.evidenceDir, `${encodeURIComponent(e.file)}.evidence.json`), "utf8")) as { len: number; sha: string };
    expect(anchorAfter).toEqual(anchor); // 幂等：锚不重写
    await rm(e.roots, { recursive: true, force: true });
    await rm(e.evidenceDir, { recursive: true, force: true });
  });
});

describe("P0-1a GPT r3 阻断修复批（B3a/B3b/B6）", () => {
  /** 阶段一共用：真跑到 marker 落盘+truncate 完成+行写抛（marker 事实=真值）。 */
  const crashAfterTruncate = async (abs: string) => {
    const real = await (await import("../../../apps/server/src/ws/safe-open.ts")).openSafeReadWrite(abs);
    const fh = real.fh as unknown as import("node:fs/promises").FileHandle;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fh as any).write = async () => { throw new Error("crash after truncate"); };
    return { fh, size: real.size };
  };
  const markerOf = async (e: Env) => JSON.parse(await readFile(join(e.evidenceDir, `${encodeURIComponent(e.file)}.repair-pending.json`), "utf8")) as { byteStart: number; byteEnd: number; removedSha256: string; startedAt: string };
  const mrowOf = (m: { byteStart: number; byteEnd: number; removedSha256: string; startedAt: string }) =>
    Buffer.from(JSON.stringify({ t: "repair", reason: "torn-tail", byteStart: m.byteStart, byteEnd: m.byteEnd, removedSha256: m.removedSha256, buildId: "build-rt", contractVersion: 2, at: m.startedAt }) + "\n", "utf8");

  it("RT42-B6/r4 交叉起点：marker 起点后多一条完整合法行+尾恰为 repair 严格前缀→conflict+盘面逐字节不变（起点对齐杀手）", async () => {
    const e = await env([jl("i1")]);
    await seedAnchor(e);
    await appendFile(e.abs, `{"t":"sending"`, "utf8"); // 原尾 14 字节
    await expect(repairJournalTail(OPT(e, { openHandle: crashAfterTruncate }))).rejects.toThrow("crash after truncate");
    const m = await markerOf(e);
    // 攻击形盘面：截断处先插一整行合法 i2（当前撕裂尾起点≠marker.byteStart），再拼 repair 行严格前缀 11B
    await appendFile(e.abs, jl("i2") + "\n", "utf8");
    await appendFile(e.abs, mrowOf(m).subarray(0, 11), "utf8");
    const before = await readFile(e.abs);
    const markerBefore = await readFile(join(e.evidenceDir, `${encodeURIComponent(e.file)}.repair-pending.json`), "utf8");
    const r = await repairJournalTail(OPT(e));
    expect(r.kind).toBe("aborted");
    if (r.kind === "aborted") {
      expect(r.reason).toBe("repair-marker-conflict"); // 非起点对齐=非部分补行形——不得回截掉 i2 整行
    }
    expect((await readFile(e.abs)).equals(before)).toBe(true); // 盘面逐字节不变（i2 行保留）
    expect(await readFile(join(e.evidenceDir, `${encodeURIComponent(e.file)}.repair-pending.json`), "utf8")).toBe(markerBefore);
    await rm(e.roots, { recursive: true, force: true });
    await rm(e.evidenceDir, { recursive: true, force: true });
  });

  it("RT35-B3a/P3 部分补行形：前缀上界=修复行长度——等于原尾长/超过原尾长的合法前缀同样收敛（四态 5/14/40/100）", async () => {
    for (const n of [5, 14, 40, 100]) {
      const e = await env([jl("i1")]);
      await seedAnchor(e);
      await appendFile(e.abs, `{"t":"sending"`, "utf8"); // 原尾恰 14 字节
      await expect(repairJournalTail(OPT(e, { openHandle: crashAfterTruncate }))).rejects.toThrow("crash after truncate");
      const m = await markerOf(e);
      const mrow = mrowOf(m);
      expect(mrow.byteLength).toBeGreaterThan(100); // 行长于任何测试前缀（上界语义成立前提）
      await appendFile(e.abs, mrow.subarray(0, n), "utf8");
      const r = await repairJournalTail(OPT(e));
      expect(r.kind).toBe("repaired"); // n=14：bounds 全等但尾≠原尾（哈希不等）——不落 file-changed，仍判部分行
      if (r.kind === "repaired") {
        expect(r.via).toBe("marker-complete");
        expect(r.removedSha256).toBe(m.removedSha256); // 原始删除事实不被覆盖
        expect(r.at).toBe(m.startedAt);
      }
      expect((await readdir(e.evidenceDir)).some((f) => f.includes("repair-pending"))).toBe(false);
      await rm(e.roots, { recursive: true, force: true });
    await rm(e.evidenceDir, { recursive: true, force: true });
    }
  });

  it("RT36-B3b/P4 锚已写穿事务锚界：拒绝且盘面一字不动（aborted 契约，不先 truncate 后拒）", async () => {
    const e = await env([jl("i1")]);
    await seedAnchor(e);
    await appendFile(e.abs, `{"t":"sending","intentId":"i1","payload":{"kind":"prompt"`.slice(0, 100), "utf8"); // 100 字节原尾
    await expect(repairJournalTail(OPT(e, { openHandle: crashAfterTruncate }))).rejects.toThrow("crash after truncate");
    const m = await markerOf(e);
    await appendFile(e.abs, mrowOf(m).subarray(0, 20), "utf8"); // 部分行 20 字节=合法崩溃前缀
    // 模拟旧版 provider pending 捕获写穿锚的脏态：锚=len(当前盘面)+sha(全文)，覆盖事务锚界
    const raw233 = await readFile(e.abs);
    const apath = join(e.evidenceDir, `${encodeURIComponent(e.file)}.evidence.json`);
    await writeFile(apath, JSON.stringify({ version: 1, file: e.file, len: raw233.byteLength, sha: createHash("sha256").update(raw233).digest("hex") }), "utf8");
    const r = await repairJournalTail(OPT(e));
    expect(r.kind).toBe("aborted");
    if (r.kind === "aborted") {
      expect(r.reason).toBe("anchor-stale");
      expect(r.detail).toContain("锚已覆盖事务原始锚界");
    }
    expect((await readFile(e.abs)).equals(raw233)).toBe(true); // 盘面一字不动（旧代码先 truncate 后拒=违反 aborted 契约）
    expect((await readdir(e.evidenceDir)).some((f) => f.includes("repair-pending"))).toBe(true); // marker 保留
    await rm(e.roots, { recursive: true, force: true });
    await rm(e.evidenceDir, { recursive: true, force: true });
  });

  it("RT37-B6/r9 内容证据三形：真短写（身份值写一半=新行前缀）与旧行 `}` 无换形收敛重写；非前缀垃圾短尾/超界长尾仍拒", async () => {
    // 形一（N1 转正·身份值短写）：fresh marker 落盘后行写到 fragIntentId 值中途崩溃——尾是新行严格前缀
    const e = await env([jl("i1")]);
    await seedAnchor(e);
    await appendFile(e.abs, `{"t":"sending","intentId":"i1","x":"y"`, "utf8");
    await expect(repairJournalTail(OPT(e, { openHandle: crashAfterTruncate }))).rejects.toThrow("crash after truncate");
    const m = await markerOf(e);
    const mrow = mrowOf(m); // 旧形态构造（无 fragIntentId 字段）——fragIntentId 在最尾，新行=旧行+字段段
    const mrowF = Buffer.concat([mrow.subarray(0, mrow.byteLength - 2), Buffer.from(`,"fragIntentId":"${String(m.fragIntentId)}"}`), Buffer.from("\n")]); // 新形态行（含身份字段）
    await appendFile(e.abs, mrowF.subarray(0, mrowF.byteLength - 6), "utf8"); // 身份值写一半=新行严格前缀（缺尾部字节）
    const r1 = await repairJournalTail(OPT(e));
    expect(r1.kind).toBe("repaired"); // 真短写收敛（内容证据=新行前缀）
    if (r1.kind === "repaired") expect(r1.via).toBe("marker-complete");
    const rows1 = (await readFile(e.abs, "utf8")).trimEnd().split("\n");
    expect((JSON.parse(rows1[rows1.length - 1] as string) as { fragIntentId?: string | null }).fragIntentId).toBe("i1");
    await rm(e.roots, { recursive: true, force: true });
    await rm(e.evidenceDir, { recursive: true, force: true });
    // 形二（旧行形枚举兼容）：r7 前旧形态行写到 `}` 闭合无换行崩溃——旧行严格前缀
    const e2 = await env([jl("i1")]);
    await seedAnchor(e2);
    await appendFile(e2.abs, `{"t":"sending","intentId":"i1","x":"y"`, "utf8");
    await expect(repairJournalTail(OPT(e2, { openHandle: crashAfterTruncate }))).rejects.toThrow("crash after truncate");
    const m2 = await markerOf(e2);
    await appendFile(e2.abs, mrowOf(m2).subarray(0, mrowOf(m2).byteLength - 1), "utf8"); // 旧行全内容缺末换行
    const r2 = await repairJournalTail(OPT(e2));
    expect(r2.kind).toBe("repaired"); // legacy 枚举形收敛（旧行前缀）
    if (r2.kind === "repaired") expect(r2.via).toBe("marker-complete");
    await rm(e2.roots, { recursive: true, force: true });
    await rm(e2.evidenceDir, { recursive: true, force: true });
    // 形三（非前缀垃圾短尾+超界长尾）：内容证据不成立——拒（Mu-r8-4 上界杀点+前缀杀点）
    for (const [torn2] of [[`{"t":"send`]] as const) {
      const e3 = await env([jl("i1")]);
      await seedAnchor(e3);
      await appendFile(e3.abs, torn2, "utf8");
      await expect(repairJournalTail(OPT(e3, { openHandle: crashAfterTruncate }))).rejects.toThrow("crash after truncate");
      await appendFile(e3.abs, "NOT the repair row prefix at all: attacker padding bytes...", "utf8"); // 40 字节非前缀
      const before3 = await readFile(e3.abs);
      const r3 = await repairJournalTail(OPT(e3));
      expect(r3.kind).toBe("aborted"); // 非前缀短尾不再收敛（r9 收窄）
      if (r3.kind === "aborted") expect(r3.reason).toBe("repair-marker-conflict");
      expect((await readFile(e3.abs)).equals(before3)).toBe(true); // 盘面零动
      await rm(e3.roots, { recursive: true, force: true });
      await rm(e3.evidenceDir, { recursive: true, force: true });
      const e4 = await env([jl("i1")]);
      await seedAnchor(e4);
      await appendFile(e4.abs, torn2, "utf8");
      await expect(repairJournalTail(OPT(e4, { openHandle: crashAfterTruncate }))).rejects.toThrow("crash after truncate");
      await appendFile(e4.abs, "x".repeat(4096), "utf8"); // 超行长无关长尾
      const before4 = await readFile(e4.abs);
      const r4 = await repairJournalTail(OPT(e4));
      expect(r4.kind).toBe("aborted");
      expect((await readFile(e4.abs)).equals(before4)).toBe(true);
      await rm(e4.roots, { recursive: true, force: true });
      await rm(e4.evidenceDir, { recursive: true, force: true });
    }
  });
  it("RT38-B6/M-R 跨 build 已补行形：重试转锚不重写行——盘面原文逐字节保留", async () => {
    const e = await env([jl("i1")]);
    await seedAnchor(e);
    await appendFile(e.abs, `{"t":"sending"`, "utf8");
    await expect(repairJournalTail(OPT(e, { openHandle: crashAfterTruncate }))).rejects.toThrow("crash after truncate");
    const m = await markerOf(e);
    // old-build 完整合法行已落盘（buildId=b1≠重试 build-rt；at 也不同——rowAtBounds 不看 buildId/at）
    await appendFile(e.abs, legalRepairRow(m.byteStart, m.byteEnd, m.removedSha256) + "\n", "utf8"); // helper 不带换行——已补行形必须以 \n 收尾（否则成撕裂尾落有尾分支）
    const before = await readFile(e.abs);
    const r = await repairJournalTail(OPT(e)); // buildId=build-rt 重试
    expect(r.kind).toBe("reconciled"); // 已补行形→转锚（M-R 变异 expectedRow=builtRow 时 readBack 行不符→抛→本测试杀点）
    if (r.kind === "reconciled") expect(r.via).toBe("marker-reconcile");
    expect((await readFile(e.abs)).equals(before)).toBe(true); // 盘面原文（b1 行）一字不改
    const anchor = JSON.parse(await readFile(join(e.evidenceDir, `${encodeURIComponent(e.file)}.evidence.json`), "utf8")) as { len: number; sha: string };
    expect(anchor.len).toBe(before.byteLength); // 锚=新后像
    expect((await readdir(e.evidenceDir)).some((f) => f.includes("repair-pending"))).toBe(false);
    await rm(e.roots, { recursive: true, force: true });
    await rm(e.evidenceDir, { recursive: true, force: true });
  });
});

// r7（GPT r6 P1-r6-1）：repair 行结构归因留痕 fragIntentId 生成面——可归因撕裂尾记顶层
// 唯一身份，不可归因显式 null；读面 RepairFact 呈现；schema 认行。
describe("r7 repair 行 fragIntentId 结构归因留痕", () => {
  it("RT-r7-1 可归因撕裂尾：repair 行 fragIntentId=顶层唯一身份，repairLog 派生呈现", async () => {
    const e = await env([jl("i1")]);
    await seedAnchor(e);
    const clean = await readFile(e.abs, "utf8");
    const TORN = `{"t":"sending","intentId":"i1","x":"y"`; // 完整键值对后截断——顶层 intentId 唯一可证（未完成键/未闭合值会被拒，见 RT-r7-2）
    await appendFile(e.abs, TORN, "utf8");
    const r = await repairJournalTail(OPT(e));
    expect(r.kind).toBe("repaired");
    const after = await readFile(e.abs, "utf8");
    const row = JSON.parse(after.slice(Buffer.byteLength(clean, "utf8"))) as { t: string; fragIntentId?: string | null };
    expect(row.t).toBe("repair");
    expect(row.fragIntentId).toBe("i1"); // 结构归因留痕=顶层唯一身份
    const rec = await recoverFromJournal(e.abs, "q");
    expect(rec.repairLog[0]?.fragIntentId).toBe("i1"); // 读面 RepairFact 呈现
    expect(journalLineSchemaError(row as unknown as Record<string, unknown>)).toBeNull(); // schema 认行
    await rm(e.roots, { recursive: true, force: true });
    await rm(e.evidenceDir, { recursive: true, force: true });
  });
  it("RT-r7-2 不可归因撕裂尾：fragIntentId 显式 null（none）；schema 认行", async () => {
    const e = await env([jl("i1")]);
    await seedAnchor(e);
    const clean = await readFile(e.abs, "utf8");
    const TORN = `{"t":"sending","pay`; // 键名未闭合撕裂→conflict（未完成键拒绝）
    await appendFile(e.abs, TORN, "utf8");
    const r = await repairJournalTail(OPT(e));
    expect(r.kind).toBe("repaired");
    const after = await readFile(e.abs, "utf8");
    const row = JSON.parse(after.slice(Buffer.byteLength(clean, "utf8"))) as { t: string; fragIntentId?: string | null };
    expect(row.fragIntentId).toBeNull(); // 不可归因=显式 null（诚实留痕，非缺省）
    expect(journalLineSchemaError(row as unknown as Record<string, unknown>)).toBeNull();
    await rm(e.roots, { recursive: true, force: true });
    await rm(e.evidenceDir, { recursive: true, force: true });
  });
  it("RT-r7-3 存量行（无 fragIntentId 字段）schema 照认——向后兼容", () => {
    const legacy = JSON.parse(legalRepairRow(10, 25, "a".repeat(64))) as Record<string, unknown>;
    expect("fragIntentId" in legacy).toBe(false);
    expect(journalLineSchemaError(legacy)).toBeNull();
    expect(journalLineSchemaError({ ...legacy, fragIntentId: 42 })).toMatch(/fragIntentId/); // 非法类型拒
  });
});

// r8（GPT r7 P1-r7-1）：崩溃窗结构身份持久化。marker 在破坏前与 bounds/哈希同批携带
// fragIntentId——「截断后写行前崩溃」的补完行不再无条件 null（旧形：补完行丢结构身份→
// i2 归因落盘后 i1 越权重启资格）。旧版 marker（无字段）尾缺失形一律保守拒。
describe("r8 崩溃窗结构身份持久化（GPT r7 P1-r7-1）", () => {
  const crashAfterTruncate2 = async (abs: string) => {
    const real = await (await import("../../../apps/server/src/ws/safe-open.ts")).openSafeReadWrite(abs);
    const fh = real.fh as unknown as import("node:fs/promises").FileHandle;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fh as any).write = async () => { throw new Error("crash after truncate"); };
    return { fh, size: real.size };
  };
  it("RT-r8-1 marker 携带结构身份：fresh 写 marker 时 fragIntentId=破坏前扫描值（可归因 i1/不可归因 null 两形）", async () => {
    for (const [torn, want] of [[`{"t":"sending","intentId":"i1","x":"y"`, "i1"], [`{"t":"sending","pay`, null] as const]) {
      const e = await env([jl("i1")]);
      await seedAnchor(e);
      await appendFile(e.abs, torn, "utf8");
      await expect(repairJournalTail(OPT(e, { openHandle: crashAfterTruncate2 }))).rejects.toThrow("crash after truncate");
      const m = JSON.parse(await readFile(join(e.evidenceDir, `${encodeURIComponent(e.file)}.repair-pending.json`), "utf8")) as { fragIntentId?: string | null };
      expect(m.fragIntentId).toBe(want); // 破坏前取证——与 fresh 行同源（P1-r7-1 主杀点）
      await rm(e.roots, { recursive: true, force: true });
      await rm(e.evidenceDir, { recursive: true, force: true });
    }
  });
  it("RT-r8-2 真窗 resend 全链：补完行带 id→错误归因 i2 被一致门零落盘拦截→一致归因 i1 授权重发+i3 无关正对照", async () => {
    const e = await env([jl("i1"), jl("i2"), jl("i3")]);
    await seedAnchor(e);
    const torn = `{"t":"sending","intentId":"i1","x":"y"`;
    await appendFile(e.abs, torn, "utf8");
    await expect(repairJournalTail(OPT(e, { openHandle: crashAfterTruncate2 }))).rejects.toThrow("crash after truncate");
    // 重试：marker 补完——行带 fragIntentId="i1"（不再无条件 null=P1-r7-1 修复面）
    const r = await repairJournalTail(OPT(e));
    expect(r.kind).toBe("repaired");
    if (r.kind === "repaired") expect(r.via).toBe("marker-complete");
    const lines = (await readFile(e.abs, "utf8")).trimEnd().split("\n");
    const repair = JSON.parse(lines[lines.length - 1] as string) as { t: string; fragIntentId?: string | null };
    expect(repair.t).toBe("repair");
    expect(repair.fragIntentId).toBe("i1"); // 崩溃窗结构身份恢复
    // 执行路径（r9 表述勘误）：行留痕 i1→错误归因 i2 被一致门零落盘拦截（inconsistent-attribution）
    // →一致归因 i1 落盘→单事务全覆盖→授权成立。错误 abandon verdict 的拒绝由 R31 独立覆盖
    // （RT-r8-3 本身只执行一致 abandon 真窗）——两测试组合覆盖两 verdict，非各自双形。
    const { adjudicateJournal } = await import("../../../apps/server/src/runtime/adjudicate-journal");
    const before = await readFile(e.abs);
    const sub = (intentId: string) => ({ kind: "fragment", removedSha256: (r as { removedSha256: string }).removedSha256, byteStart: (r as { byteStart: number }).byteStart, byteEnd: (r as { byteEnd: number }).byteEnd, at: (r as { at: string }).at, intentId }) as const;
    const bad = await adjudicateJournal({ file: e.file, roots: [e.roots], evidenceDir: e.evidenceDir, subject: sub("i2"), verdict: "resend", operator: "host", buildId: "b1" });
    expect(bad).toMatchObject({ kind: "aborted", reason: "inconsistent-attribution" }); // 一致门有据（行带 i1）
    expect((await readFile(e.abs)).equals(before)).toBe(true);
    const ok = await adjudicateJournal({ file: e.file, roots: [e.roots], evidenceDir: e.evidenceDir, subject: sub("i1"), verdict: "resend", operator: "host", buildId: "b1" });
    expect(ok.kind).toBe("adjudicated");
    const { recoverFromJournal } = await import("../../../apps/server/src/runtime/recover");
    const rec = await recoverFromJournal(e.abs, "q");
    expect(rec.resendAuthorized).toContain("i1"); // 一致归因 i1→单事务全覆盖→授权成立（R28 补正形同构，经真窗 IO 链）
    expect(rec.resumable).toContain("i1"); // 覆盖成立→不排除（授权的目的即重发）；越权形（i2 裁决落盘后 i1 失忆重启）已被一致门在上文零落盘拦截
    expect(rec.resumable).toContain("i3"); // 无关意图不受影响
    await rm(e.roots, { recursive: true, force: true });
    await rm(e.evidenceDir, { recursive: true, force: true });
  });
  it("RT-r8-3 真窗 abandon：窗后行带 id+一致归因 abandon 裁决→冷态 i1 放弃（不可重发）", async () => {
    const e = await env([jl("i1"), jl("i2")]);
    await seedAnchor(e);
    await appendFile(e.abs, `{"t":"sending","intentId":"i1","x":"y"`, "utf8");
    await expect(repairJournalTail(OPT(e, { openHandle: crashAfterTruncate2 }))).rejects.toThrow("crash after truncate");
    const r = await repairJournalTail(OPT(e));
    expect(r.kind).toBe("repaired");
    const { adjudicateJournal } = await import("../../../apps/server/src/runtime/adjudicate-journal");
    const ok = await adjudicateJournal({ file: e.file, roots: [e.roots], evidenceDir: e.evidenceDir, subject: { kind: "fragment", removedSha256: (r as { removedSha256: string }).removedSha256, byteStart: (r as { byteStart: number }).byteStart, byteEnd: (r as { byteEnd: number }).byteEnd, at: (r as { at: string }).at, intentId: "i1" }, verdict: "abandon", operator: "host", buildId: "b1" });
    expect(ok.kind).toBe("adjudicated");
    const { recoverFromJournal } = await import("../../../apps/server/src/runtime/recover");
    const rec = await recoverFromJournal(e.abs, "q");
    expect(rec.resumable).not.toContain("i1"); // abandon=放弃：i1 永不可重发
    expect(rec.resumable).toContain("i2");
    await rm(e.roots, { recursive: true, force: true });
    await rm(e.evidenceDir, { recursive: true, force: true });
  });
  it("RT-r8-4 旧版 marker（无 fragIntentId）残局：保守拒+盘面零动+marker 保留（宿主清 marker 后 fresh 重做取证）", async () => {
    const e = await env([jl("i1")]);
    await seedAnchor(e);
    await appendFile(e.abs, `{"t":"sending","intentId":"i1","x":"y"`, "utf8");
    await expect(repairJournalTail(OPT(e, { openHandle: crashAfterTruncate2 }))).rejects.toThrow("crash after truncate");
    // 降级 marker 为旧版（去 fragIntentId 字段）——模拟 r8 前版本写入的残局
    const mp = join(e.evidenceDir, `${encodeURIComponent(e.file)}.repair-pending.json`);
    const m = JSON.parse(await readFile(mp, "utf8")) as Record<string, unknown>;
    delete m.fragIntentId;
    await writeFile(mp, JSON.stringify(m), "utf8");
    const before = await readFile(e.abs);
    const r2 = await repairJournalTail(OPT(e));
    expect(r2).toMatchObject({ kind: "aborted", reason: "repair-marker-conflict" });
    if (r2.kind === "aborted") expect(r2.detail).toContain("旧版 marker");
    expect((await readFile(e.abs)).equals(before)).toBe(true); // 盘面零动
    expect((await readdir(e.evidenceDir)).some((f) => f.includes("repair-pending"))).toBe(true); // marker 保留
    await rm(e.roots, { recursive: true, force: true });
    await rm(e.evidenceDir, { recursive: true, force: true });
    // 有尾+旧 marker 形：起点吻合尾在场但不可复扫取证（marker 无字段+尾≠原始尾哈希）→主函数入口门同拒
    const e2 = await env([jl("i1")]);
    await seedAnchor(e2);
    await appendFile(e2.abs, `{"t":"sending","intentId":"i1","x":"y"`, "utf8");
    await expect(repairJournalTail(OPT(e2, { openHandle: crashAfterTruncate2 }))).rejects.toThrow("crash after truncate");
    const mp2 = join(e2.evidenceDir, `${encodeURIComponent(e2.file)}.repair-pending.json`);
    const m2 = JSON.parse(await readFile(mp2, "utf8")) as Record<string, unknown>;
    delete m2.fragIntentId;
    await writeFile(mp2, JSON.stringify(m2), "utf8");
    await appendFile(e2.abs, `{"t":"send`, "utf8"); // 有尾（起点吻合、与 marker 原尾哈希不符）
    const before2 = await readFile(e2.abs);
    const r3 = await repairJournalTail(OPT(e2));
    expect(r3).toMatchObject({ kind: "aborted", reason: "repair-marker-conflict" });
    if (r3.kind === "aborted") expect(r3.detail).toContain("旧版 marker");
    expect((await readFile(e2.abs)).equals(before2)).toBe(true);
    expect((await readdir(e2.evidenceDir)).some((f) => f.includes("repair-pending"))).toBe(true);
    await rm(e2.roots, { recursive: true, force: true });
    await rm(e2.evidenceDir, { recursive: true, force: true });
  });
});

// r9（GPT r8 84 NO-GO 修复批）：P1-r8-1 缺证据残局指引洗白闭合（cleanup-only 分级+禁删指引）
// +P3-r8-1 加载器非空校验。N2/N5 探针转正式回归。
describe("r9 缺证据残局留置+cleanup 分级（GPT r8 P1-r8-1/P3-r8-1）", () => {
  const crashAfterTruncate3 = async (abs: string) => {
    const real = await (await import("../../../apps/server/src/ws/safe-open.ts")).openSafeReadWrite(abs);
    const fh = real.fh as unknown as import("node:fs/promises").FileHandle;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fh as any).write = async () => { throw new Error("crash after truncate"); };
    return { fh, size: real.size };
  };
  it("RT-r9-1 cleanup-only 分级（N5 转正）：行已落盘+锚匹配——旧版 marker 亦幂等清（事实在行+锚）；物理健康≠已授权（resumable=[]）", async () => {
    const e = await env([jl("i1")]);
    await seedAnchor(e);
    await appendFile(e.abs, `{"t":"sending","intentId":"i1","x":"y"`, "utf8");
    // 正常完成修复（行落盘+锚转移），但 marker 保留（模拟 clearMarker 前中断）→降级旧版
    const r0 = await repairJournalTail(OPT(e));
    expect(r0.kind).toBe("repaired");
    const mp = join(e.evidenceDir, `${encodeURIComponent(e.file)}.repair-pending.json`);
    if (r0.kind !== "repaired") throw new Error("unreachable");
    await writeFile(mp, JSON.stringify({ version: 1, file: e.file, byteStart: r0.byteStart, byteEnd: r0.byteEnd, removedSha256: r0.removedSha256, startedAt: r0.at }), "utf8"); // 旧版 marker（无 fragIntentId）
    // 新锚=修复后全文件（repairJournalTail 已转移锚）——reconcile 形重进：行在+锚匹配+marker 在场
    const before = await readFile(e.abs);
    const r = await repairJournalTail(OPT(e));
    expect(r.kind).toBe("reconciled"); // cleanup-only：事实完整存活于行+锚，清冗余屏障（旧版 marker 亦放行）
    if (r.kind === "reconciled") expect(r.via).toBe("marker-cleanup");
    expect((await readFile(e.abs)).equals(before)).toBe(true); // 盘面零动
    expect((await readdir(e.evidenceDir)).some((f) => f.includes("repair-pending"))).toBe(false); // marker 已清
    const { recoverFromJournal } = await import("../../../apps/server/src/runtime/recover");
    const rec = await recoverFromJournal(e.abs, "q");
    expect(rec.repairLog).toHaveLength(1); // 修复事实保留（行）
    expect(rec.resumable).toHaveLength(0); // 未裁决事务=repairShadow 阻断——物理健康≠已授权重发
    await rm(e.roots, { recursive: true, force: true });
    await rm(e.evidenceDir, { recursive: true, force: true });
  });
  it("RT-r9-2 缺证据留置（N2 转正）：旧 marker 截断形拒后幂等留置+detail 禁删指引；违规清 marker 的洗白后果如实呈现（红线演示）", async () => {
    const e = await env([jl("i1"), jl("i2")]);
    await seedAnchor(e);
    await appendFile(e.abs, `{"t":"sending","intentId":"i1","x":"y"`, "utf8");
    await expect(repairJournalTail(OPT(e, { openHandle: crashAfterTruncate3 }))).rejects.toThrow("crash after truncate");
    const mp = join(e.evidenceDir, `${encodeURIComponent(e.file)}.repair-pending.json`);
    const m = JSON.parse(await readFile(mp, "utf8")) as Record<string, unknown>;
    delete m.fragIntentId;
    await writeFile(mp, JSON.stringify(m), "utf8");
    const before = await readFile(e.abs);
    const r1 = await repairJournalTail(OPT(e));
    expect(r1).toMatchObject({ kind: "aborted", reason: "repair-marker-conflict" });
    if (r1.kind === "aborted") {
      expect(r1.detail).toContain("禁止仅删除 marker"); // 指引=留置，不再指引清 marker 后 fresh 重做
      expect(r1.detail).not.toContain("fresh 重做取证");
    }
    const r1b = await repairJournalTail(OPT(e)); // 幂等留置：重试仍拒（防自动化洗白循环）
    expect(r1b.kind).toBe("aborted");
    expect((await readFile(e.abs)).equals(before)).toBe(true);
    expect((await readdir(e.evidenceDir)).some((f) => f.includes("repair-pending"))).toBe(true);
    // 红线演示（N2 后果如实）：宿主违规仅删 marker→fresh=no-torn-tail（尾已消失）→
    // 冷捕获以无裁决恢复全部意图重启——这正是 detail 禁止此操作的原因
    await rm(mp);
    const r2 = await repairJournalTail(OPT(e));
    expect(r2.kind).toBe("no-torn-tail");
    const { recoverFromJournal } = await import("../../../apps/server/src/runtime/recover");
    const rec = await recoverFromJournal(e.abs, "q");
    expect(rec.repairLog).toHaveLength(0); // 修复事实被抹
    expect(rec.resumable).toContain("i1"); // 无裁决重启=洗白后果（红线演示，非安全断言）
    expect(rec.resumable).toContain("i2");
    await rm(e.roots, { recursive: true, force: true });
    await rm(e.evidenceDir, { recursive: true, force: true });
  });
  it("RT-r9-3 空 fragIntentId marker（P3）：加载器非空校验对齐行 schema——corrupt 拒+零改盘", async () => {
    const e = await env([jl("i1")]);
    await seedAnchor(e);
    await appendFile(e.abs, `{"t":"sending","intentId":"i1","x":"y"`, "utf8");
    await expect(repairJournalTail(OPT(e, { openHandle: crashAfterTruncate3 }))).rejects.toThrow("crash after truncate");
    const mp = join(e.evidenceDir, `${encodeURIComponent(e.file)}.repair-pending.json`);
    const m = JSON.parse(await readFile(mp, "utf8")) as Record<string, unknown>;
    await writeFile(mp, JSON.stringify({ ...m, fragIntentId: "" }), "utf8"); // 空串=非法（防补完写 schema 非法行）
    const before = await readFile(e.abs);
    const r = await repairJournalTail(OPT(e));
    expect(r).toMatchObject({ kind: "aborted", reason: "repair-marker-conflict" });
    if (r.kind === "aborted") expect(r.detail).toContain("损坏");
    expect((await readFile(e.abs)).equals(before)).toBe(true); // 零改盘
    await rm(e.roots, { recursive: true, force: true });
    await rm(e.evidenceDir, { recursive: true, force: true });
  });
});
