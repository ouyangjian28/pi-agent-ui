// 3b5-3 迁移执行面单测（evidence-migration.ts / migrateLegacyEvidence）——设计先写于此。
//
// API：migrateLegacyEvidence({roots, evidenceDir, sessionRoots?, sessionFor?, maxCombinedBytes?, now?})
//   → Promise<LegacyEvidenceMigrationRecord>
//   整体面：{evidenceDir, roots, startedAt, endedAt, files, counts{total,migrated,noop,rejected}, rejections}；
//   每文件面：{file, outcome, source, anchor:{len,sha}|null, registered, rejection?, audit}。
// 语义边界（实现与注释一致性断言依据）：
//   [B1] 迁移窗口=本工具运行期：trustFirstCapture 恒 true 仅存在于工具创建的 provider 实例内；
//        无锚未登记→source=fresh-capture；有锚未登记→legacy-anchor（provider 不询及 bless）；
//        已登记→noop/already-registered；拒绝→none。
//   [B2] 幂等判据=本次调用内 seen.json rename 归位（登记原子提交）：发生→migrated，未发生→noop。
//   [B3] 拒绝（截断/同长改写/越根/超预算/仓损坏/会话映射非法）绝不补登记、绝不动锚（provider
//        fail-closed 直通）：seen.json 原字节不变、锚原字节不变；拒绝文件照常入记录与 rejections。
//   [B4] registered=盘面 seen.json 读出：仓缺失=no，损坏/形状非法=unknown（不臆断）。
//   [B5] 枚举=roots 递归 *.jsonl（相对名，字典序去重）；symlink/FIFO 名交 provider safe-open 拒
//        （rejected/file-unreadable/detail=symlink）——工具不做二次判定。
// 审计行格式（provider 原文逐条断言；成功捕获无审计行=audit:[]）：
//   recovery-oversized file=X journal=N session=M budget=B
//   recovery-evidence-rewritten file=X oldLen=N newLen=M      ← 截断/同长改写（纯追加前缀验证拒）
//   recovery-session-map-invalid file=X detail=absolute-path|outside-session-roots
//   recovery-evidence-store-failed file=X detail=seen-load|…
//   rejection.detail：file-unreadable→成员 detail 字段；unavailable→最后一条审计行原文。
// 覆盖矩阵：MG1 正常迁移（含空仓先行）/MG2 旧锚补登记/MG3 幂等重跑 no-op（seen 原字节）/
//   MG4 截断拒（不补登记）/MG5 同长改写拒/MG6 越根拒（symlink，POSIX-only）/
//   MG7 审计行逐条断言（混合四文件）/MG8 session 映射越界拒/MG9 seen 仓损坏→registered=unknown/
//   MG10 嵌套目录枚举（锚名 encodeURIComponent）/MG11 超预算拒。
import { describe, expect, it } from "vitest";
import { mkdtemp, rm, symlink, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { matchKeyOf } from "@pi-agent-ui/protocol";
import { migrateLegacyEvidence } from "../../../apps/server/src/runtime/evidence-migration.ts";

/** 合法 journal 行（与 recovery-evidence-source.test.ts 同形；schema 判定权威=protocol/journal-schema） */
const jl = (i: string) => JSON.stringify({ t: "enqueue", intentId: i, sessionId: "q", generation: 1, leafId: "L", matchKey: matchKeyOf("t", [], 1), payload: { kind: "prompt", rawText: "t", attachments: [], sentAt: "1" } });

/** 两目录 rig：journal 根/证据仓目录（迁移工具不碰 session 仓，除 MG8 显式给）。 */
async function mkRig(prefix: string): Promise<{ jRoot: string; evDir: string; cleanup: () => Promise<void> }> {
  const jRoot = await mkdtemp(join(tmpdir(), `${prefix}j-`));
  const evDir = await mkdtemp(join(tmpdir(), `${prefix}e-`));
  return { jRoot, evDir, cleanup: async () => {
    await rm(jRoot, { recursive: true, force: true });
    await rm(evDir, { recursive: true, force: true });
  } };
}

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const anchorOf = (evDir: string, file: string) => join(evDir, `${encodeURIComponent(file)}.evidence.json`);

/** 旧锚 sidecar 种子：与 provider 写出同形（键序 version,file,len,sha）。 */
const seedAnchor = async (evDir: string, file: string, len: number, sha: string) => {
  await writeFile(anchorOf(evDir, file), JSON.stringify({ version: 1, file, len, sha }), "utf8");
};

describe("migrateLegacyEvidence（3b5-3 迁移执行面）", () => {
  it("MG1 正常迁移：空仓先行 no 文件；随后 fresh 首锚+登记+验收记录整体面", async () => {
    const rig = await mkRig("mg1");
    try {
      let t = 1000;
      const now = () => ++t;
      const empty = await migrateLegacyEvidence({ roots: [rig.jRoot], evidenceDir: rig.evDir, now });
      expect(empty.files).toEqual([]);
      expect(empty.counts).toEqual({ total: 0, migrated: 0, noop: 0, rejected: 0 });
      expect(empty.rejections).toEqual([]);
      expect(empty.startedAt).toBe(1001); // 工具层首时钟读数
      expect(empty.endedAt).toBeGreaterThan(empty.startedAt);

      const text = `${jl("a")}\n${jl("b")}\n`;
      await writeFile(join(rig.jRoot, "a.jsonl"), text, "utf8");
      const rec = await migrateLegacyEvidence({ roots: [rig.jRoot], evidenceDir: rig.evDir, now });
      expect(rec.evidenceDir).toBe(rig.evDir);
      expect(rec.roots).toEqual([rig.jRoot]);
      expect(rec.counts).toEqual({ total: 1, migrated: 1, noop: 0, rejected: 0 });
      const f = rec.files[0];
      expect(f?.file).toBe("a.jsonl");
      expect(f?.outcome).toBe("migrated");
      expect(f?.source).toBe("fresh-capture");
      expect(f?.anchor).toEqual({ len: Buffer.byteLength(text), sha: sha256(text) });
      expect(f?.registered).toBe("yes");
      expect(f?.audit).toEqual([]);
      expect(f?.rejection).toBeUndefined();
      // 盘面：锚 sidecar 与 seen 登记
      const anchor = JSON.parse(await readFile(anchorOf(rig.evDir, "a.jsonl"), "utf8")) as { len: number; sha: string };
      expect(anchor).toMatchObject({ len: Buffer.byteLength(text), sha: sha256(text) });
      const seen = JSON.parse(await readFile(join(rig.evDir, "seen.json"), "utf8")) as { files: string[] };
      expect(seen.files).toContain("a.jsonl");
      expect(rec.startedAt).toBeGreaterThan(1001);
      expect(rec.endedAt).toBeGreaterThan(rec.startedAt);
    } finally {
      await rig.cleanup();
    }
  });

  it("MG2 旧仓旧锚补登记：有锚未登记→legacy-anchor，锚 len/sha 不变，补 seen", async () => {
    const rig = await mkRig("mg2");
    try {
      const text = `${jl("x")}\n`;
      await writeFile(join(rig.jRoot, "b.jsonl"), text, "utf8");
      await seedAnchor(rig.evDir, "b.jsonl", Buffer.byteLength(text), sha256(text));
      await writeFile(join(rig.evDir, "seen.json"), JSON.stringify({ version: 1, files: [] }), "utf8");
      const rec = await migrateLegacyEvidence({ roots: [rig.jRoot], evidenceDir: rig.evDir });
      expect(rec.counts).toEqual({ total: 1, migrated: 1, noop: 0, rejected: 0 });
      const f = rec.files[0];
      expect(f?.outcome).toBe("migrated");
      expect(f?.source).toBe("legacy-anchor"); // bless 未被询及（provider 既有语义）
      expect(f?.registered).toBe("yes");
      expect(f?.audit).toEqual([]);
      expect(f?.anchor).toEqual({ len: Buffer.byteLength(text), sha: sha256(text) });
      const seen = JSON.parse(await readFile(join(rig.evDir, "seen.json"), "utf8")) as { files: string[] };
      expect(seen.files).toContain("b.jsonl");
    } finally {
      await rig.cleanup();
    }
  });

  it("MG3 幂等重跑：已登记文件 no-op，seen.json 原字节不变（未发生登记提交）", async () => {
    const rig = await mkRig("mg3");
    try {
      await writeFile(join(rig.jRoot, "a.jsonl"), `${jl("a")}\n`, "utf8");
      const first = await migrateLegacyEvidence({ roots: [rig.jRoot], evidenceDir: rig.evDir });
      expect(first.counts).toEqual({ total: 1, migrated: 1, noop: 0, rejected: 0 });
      const seenBefore = await readFile(join(rig.evDir, "seen.json"), "utf8");
      const anchorBefore = await readFile(anchorOf(rig.evDir, "a.jsonl"), "utf8");
      const second = await migrateLegacyEvidence({ roots: [rig.jRoot], evidenceDir: rig.evDir });
      expect(second.counts).toEqual({ total: 1, migrated: 0, noop: 1, rejected: 0 });
      const f = second.files[0];
      expect(f?.outcome).toBe("noop");
      expect(f?.source).toBe("already-registered");
      expect(f?.registered).toBe("yes");
      expect(f?.audit).toEqual([]);
      expect(f?.rejection).toBeUndefined();
      expect(await readFile(join(rig.evDir, "seen.json"), "utf8")).toBe(seenBefore); // 不补登记（原字节）
      const anchorAfter = JSON.parse(await readFile(anchorOf(rig.evDir, "a.jsonl"), "utf8")) as { len: number; sha: string };
      const anchorParsed = JSON.parse(anchorBefore) as { len: number; sha: string };
      expect(anchorAfter.len).toBe(anchorParsed.len);
      expect(anchorAfter.sha).toBe(anchorParsed.sha);
    } finally {
      await rig.cleanup();
    }
  });

  it("MG4 截断拒：recovery-evidence-rewritten，锚与 seen 原字节不动、不补登记", async () => {
    const rig = await mkRig("mg4");
    try {
      const full = `${jl("a")}\n${jl("b")}\n`;
      await writeFile(join(rig.jRoot, "c.jsonl"), full, "utf8");
      await seedAnchor(rig.evDir, "c.jsonl", Buffer.byteLength(full), sha256(full));
      const seenSeed = JSON.stringify({ version: 1, files: [] });
      await writeFile(join(rig.evDir, "seen.json"), seenSeed, "utf8");
      const anchorSeed = await readFile(anchorOf(rig.evDir, "c.jsonl"), "utf8");
      // 截断：journal 缩短 3 字节
      const trunc = full.slice(0, full.length - 3);
      await writeFile(join(rig.jRoot, "c.jsonl"), trunc, "utf8");
      const rec = await migrateLegacyEvidence({ roots: [rig.jRoot], evidenceDir: rig.evDir });
      expect(rec.counts).toEqual({ total: 1, migrated: 0, noop: 0, rejected: 1 });
      const f = rec.files[0];
      expect(f?.outcome).toBe("rejected");
      expect(f?.source).toBe("none");
      expect(f?.registered).toBe("no");
      expect(f?.rejection?.reason).toBe("concurrent-modification");
      const line = `recovery-evidence-rewritten file=c.jsonl oldLen=${Buffer.byteLength(full)} newLen=${Buffer.byteLength(trunc)}`;
      expect(f?.audit).toEqual([line]); // 逐条断言：唯一审计行原文
      expect(f?.rejection?.detail).toBe(line); // unavailable detail=最后一条审计行
      expect(rec.rejections[0]?.file).toBe("c.jsonl");
      expect(await readFile(anchorOf(rig.evDir, "c.jsonl"), "utf8")).toBe(anchorSeed); // 锚原字节
      expect(await readFile(join(rig.evDir, "seen.json"), "utf8")).toBe(seenSeed); // 不补登记
    } finally {
      await rig.cleanup();
    }
  });

  it("MG5 同长改写拒：oldLen==newLen 亦拒，锚与 seen 原字节不动", async () => {
    const rig = await mkRig("mg5");
    try {
      const full = `${jl("a")}\n${jl("b")}\n`;
      await writeFile(join(rig.jRoot, "c.jsonl"), full, "utf8");
      await seedAnchor(rig.evDir, "c.jsonl", Buffer.byteLength(full), sha256(full));
      const seenSeed = JSON.stringify({ version: 1, files: [] });
      await writeFile(join(rig.evDir, "seen.json"), seenSeed, "utf8");
      const anchorSeed = await readFile(anchorOf(rig.evDir, "c.jsonl"), "utf8");
      // 同长改写：改首行 intentId 首字符，字节数不变
      const bytes = Buffer.from(full, "utf8");
      bytes[bytes.indexOf("a")] = "z".charCodeAt(0);
      await writeFile(join(rig.jRoot, "c.jsonl"), bytes, "utf8");
      const rec = await migrateLegacyEvidence({ roots: [rig.jRoot], evidenceDir: rig.evDir });
      expect(rec.counts).toEqual({ total: 1, migrated: 0, noop: 0, rejected: 1 });
      const f = rec.files[0];
      expect(f?.outcome).toBe("rejected");
      expect(f?.rejection?.reason).toBe("concurrent-modification");
      const line = `recovery-evidence-rewritten file=c.jsonl oldLen=${Buffer.byteLength(full)} newLen=${Buffer.byteLength(full)}`;
      expect(f?.audit).toEqual([line]);
      expect(f?.rejection?.detail).toBe(line);
      expect(f?.registered).toBe("no");
      expect(await readFile(anchorOf(rig.evDir, "c.jsonl"), "utf8")).toBe(anchorSeed);
      expect(await readFile(join(rig.evDir, "seen.json"), "utf8")).toBe(seenSeed);
    } finally {
      await rig.cleanup();
    }
  });

  it("MG6 越根拒：root 内 symlink 指向 root 外→file-unreadable detail=symlink，不建锚不登记", async () => {
    if (process.platform === "win32") return; // symlink 旗标语义 POSIX-only（R16 先例）
    const rig = await mkRig("mg6");
    try {
      const outside = await mkdtemp(join(tmpdir(), "mg6out-"));
      try {
        await writeFile(join(outside, "secret.jsonl"), `${jl("s")}\n`, "utf8");
        await symlink(join(outside, "secret.jsonl"), join(rig.jRoot, "evil.jsonl"));
        const rec = await migrateLegacyEvidence({ roots: [rig.jRoot], evidenceDir: rig.evDir });
        expect(rec.counts).toEqual({ total: 1, migrated: 0, noop: 0, rejected: 1 });
        const f = rec.files[0];
        expect(f?.file).toBe("evil.jsonl");
        expect(f?.outcome).toBe("rejected");
        expect(f?.rejection?.reason).toBe("file-unreadable");
        expect(f?.rejection?.detail).toBe("symlink");
        expect(f?.anchor).toBeNull();
        expect(f?.registered).toBe("no"); // 仓缺失=no
        expect(f?.audit[0]).toContain("recovery-unreadable file=evil.jsonl detail=symlink");
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    } finally {
      await rig.cleanup();
    }
  });

  it("MG7 审计行逐条断言：混合四文件（fresh/legacy/截断/noop）计数+行归属+字典序", async () => {
    const rig = await mkRig("mg7");
    try {
      // 先行登记 d（幂等 no-op 的前提）
      await writeFile(join(rig.jRoot, "d.jsonl"), `${jl("d")}\n`, "utf8");
      const pre = await migrateLegacyEvidence({ roots: [rig.jRoot], evidenceDir: rig.evDir });
      expect(pre.counts).toEqual({ total: 1, migrated: 1, noop: 0, rejected: 0 });
      // a=无锚 fresh；b=有锚未登记 legacy；c=锚存在但 journal 截断→拒；d=已登记 noop
      const aText = `${jl("a")}\n`;
      const bText = `${jl("b")}\n`;
      const cFull = `${jl("c")}\n`;
      await writeFile(join(rig.jRoot, "a.jsonl"), aText, "utf8");
      await writeFile(join(rig.jRoot, "b.jsonl"), bText, "utf8");
      await writeFile(join(rig.jRoot, "c.jsonl"), cFull, "utf8");
      await seedAnchor(rig.evDir, "b.jsonl", Buffer.byteLength(bText), sha256(bText));
      await seedAnchor(rig.evDir, "c.jsonl", Buffer.byteLength(cFull), sha256(cFull));
      await writeFile(join(rig.jRoot, "c.jsonl"), cFull.slice(0, cFull.length - 2), "utf8");
      const rec = await migrateLegacyEvidence({ roots: [rig.jRoot], evidenceDir: rig.evDir });
      expect(rec.files.map((f) => f.file)).toEqual(["a.jsonl", "b.jsonl", "c.jsonl", "d.jsonl"]); // 字典序
      expect(rec.counts).toEqual({ total: 4, migrated: 2, noop: 1, rejected: 1 });
      const [a, b, c, d] = rec.files;
      expect(a?.audit).toEqual([]); // 成功捕获无审计行
      expect(a?.outcome).toBe("migrated");
      expect(a?.source).toBe("fresh-capture");
      expect(b?.audit).toEqual([]);
      expect(b?.outcome).toBe("migrated");
      expect(b?.source).toBe("legacy-anchor");
      expect(c?.outcome).toBe("rejected");
      expect(c?.audit).toEqual([`recovery-evidence-rewritten file=c.jsonl oldLen=${Buffer.byteLength(cFull)} newLen=${Buffer.byteLength(cFull) - 2}`]);
      expect(d?.audit).toEqual([]);
      expect(d?.outcome).toBe("noop");
      expect(d?.source).toBe("already-registered");
      expect(rec.rejections.map((f) => f.file)).toEqual(["c.jsonl"]);
    } finally {
      await rig.cleanup();
    }
  });

  it("MG8 session 映射越界拒：透传 file-unreadable detail=会话映射中文案，不建登记", async () => {
    const rig = await mkRig("mg8");
    const sRoot = await mkdtemp(join(tmpdir(), "mg8s-"));
    try {
      await writeFile(join(rig.jRoot, "a.jsonl"), `${jl("a")}\n`, "utf8");
      const rec = await migrateLegacyEvidence({
        roots: [rig.jRoot],
        sessionRoots: [sRoot],
        sessionFor: () => "../../etc/passwd",
        evidenceDir: rig.evDir,
      });
      expect(rec.counts).toEqual({ total: 1, migrated: 0, noop: 0, rejected: 1 });
      const f = rec.files[0];
      expect(f?.outcome).toBe("rejected");
      expect(f?.rejection?.reason).toBe("file-unreadable");
      expect(f?.rejection?.detail).toBe("session 映射越界");
      expect(f?.audit[0]).toContain("recovery-session-map-invalid file=a.jsonl detail=outside-session-roots");
      expect(f?.registered).toBe("no");
      expect(f?.anchor).toBeNull();
    } finally {
      await rig.cleanup();
      await rm(sRoot, { recursive: true, force: true });
    }
  });

  it("MG9 seen 仓损坏：registered=unknown（不臆断），拒绝 detail=seen-load，锚事实仍可读", async () => {
    const rig = await mkRig("mg9");
    try {
      const text = `${jl("a")}\n`;
      await writeFile(join(rig.jRoot, "a.jsonl"), text, "utf8");
      await seedAnchor(rig.evDir, "a.jsonl", Buffer.byteLength(text), sha256(text));
      await writeFile(join(rig.evDir, "seen.json"), "{oops", "utf8");
      const rec = await migrateLegacyEvidence({ roots: [rig.jRoot], evidenceDir: rig.evDir });
      expect(rec.counts).toEqual({ total: 1, migrated: 0, noop: 0, rejected: 1 });
      const f = rec.files[0];
      expect(f?.outcome).toBe("rejected");
      expect(f?.rejection?.reason).toBe("read-failed");
      expect(f?.rejection?.detail).toContain("recovery-evidence-store-failed file=a.jsonl detail=seen-load");
      expect(f?.audit[0]).toContain("recovery-evidence-store-failed");
      expect(f?.registered).toBe("unknown"); // B4：损坏仓→unknown
      expect(f?.anchor).toEqual({ len: Buffer.byteLength(text), sha: sha256(text) }); // 盘面锚仍可读
    } finally {
      await rig.cleanup();
    }
  });

  it("MG10 嵌套目录枚举：相对名保留路径，锚名=encodeURIComponent(相对名)", async () => {
    const rig = await mkRig("mg10");
    try {
      await mkdir(join(rig.jRoot, "sub"));
      await writeFile(join(rig.jRoot, "sub", "nested.jsonl"), `${jl("n")}\n`, "utf8");
      const rec = await migrateLegacyEvidence({ roots: [rig.jRoot], evidenceDir: rig.evDir });
      expect(rec.counts).toEqual({ total: 1, migrated: 1, noop: 0, rejected: 0 });
      const f = rec.files[0];
      expect(f?.file).toBe("sub/nested.jsonl");
      expect(f?.outcome).toBe("migrated");
      // 锚 sidecar 名=encodeURIComponent("sub/nested.jsonl")+".evidence.json"（provider 既有约定）
      const anchorRaw = await readFile(join(rig.evDir, `${encodeURIComponent("sub/nested.jsonl")}.evidence.json`), "utf8");
      expect((JSON.parse(anchorRaw) as { file: string }).file).toBe("sub/nested.jsonl");
    } finally {
      await rig.cleanup();
    }
  });

  it("MG11 超预算拒：recovery-oversized，不建锚不登记，锚=null", async () => {
    const rig = await mkRig("mg11");
    try {
      await writeFile(join(rig.jRoot, "big.jsonl"), `${jl("big")}\n`, "utf8");
      const rec = await migrateLegacyEvidence({
        roots: [rig.jRoot],
        evidenceDir: rig.evDir,
        maxCombinedBytes: 10, // 小预算精确字节例（jl 行远超 10B）
      });
      expect(rec.counts).toEqual({ total: 1, migrated: 0, noop: 0, rejected: 1 });
      const f = rec.files[0];
      expect(f?.outcome).toBe("rejected");
      expect(f?.rejection?.reason).toBe("oversized");
      expect(f?.rejection?.detail).toContain("recovery-oversized file=big.jsonl");
      expect(f?.audit[0]).toContain("recovery-oversized file=big.jsonl");
      expect(f?.anchor).toBeNull();
      expect(f?.registered).toBe("no");
    } finally {
      await rig.cleanup();
    }
  });
});
