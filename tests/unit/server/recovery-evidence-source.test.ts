// 3b-4 恢复真读源 provider 单测（typed 结果+合计入口预算+取消语义；3b-0 §5 3b-4 验收①）。
// 预算边界用小预算（maxCombinedBytes 注入）做精确字节例；另有一条真实 8MiB 默认档例证规模面。
// 增长竞态用注入接缝（statLike/readLike）确定性复现（真 fs 计时窗不可稳定命中）。
import { describe, expect, it } from "vitest";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_RECOVERY_COMBINED_BYTES,
  createRecoveryEvidenceProvider,
  isRecoverySnapshot,
  type StatLike,
} from "../../../apps/server/src/runtime/recovery-evidence-source.ts";
import { snapshotEvidenceHash, type RecoveryEvidenceSnapshot } from "../../../apps/server/src/runtime/recover.ts";

const MiB = 1024 * 1024;

describe("recovery-evidence-source（3b-4 typed provider）", () => {
  it("R1 预算边界：合计 −1 与恰等→快照；+1→oversized（journal 单文件，字节精确）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rec1-"));
    try {
      const jp = join(dir, "a.jsonl");
      const mk = (pad: number) => {
        const base = '{"t":"note"}\n';
        // 直接按目标字节数构造：base 行 + 填充（无尾换行=撕裂尾，合法入 bad）
        const buf = Buffer.alloc(pad);
        buf.write(base, 0, "utf8");
        buf.fill("x", Buffer.byteLength(base));
        return writeFile(jp, buf);
      };
      const p = createRecoveryEvidenceProvider({ roots: [dir], maxCombinedBytes: 10_000 });
      await mk(10_000 - 1);
      const under = await p("a.jsonl");
      expect(isRecoverySnapshot(under)).toBe(true);
      expect(snapshotEvidenceHash(under as RecoveryEvidenceSnapshot)).toMatch(/^[0-9a-f]{64}$/);
      await mk(10_000);
      const exact = await p("a.jsonl");
      expect(isRecoverySnapshot(exact)).toBe(true);
      await mk(10_000 + 1);
      const over = await p("a.jsonl");
      expect(over).toEqual({ kind: "unavailable", reason: "oversized" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("R2 合计口径：journal/session 各自未超但合计超→oversized；session 在场扣减可用额", async () => {
    const jdir = await mkdtemp(join(tmpdir(), "rec2j-"));
    const sdir = await mkdtemp(join(tmpdir(), "rec2s-"));
    try {
      const jp = join(jdir, "b.jsonl");
      const sp = join(sdir, "b.session.jsonl");
      await writeFile(jp, Buffer.alloc(6_000));
      await writeFile(sp, Buffer.alloc(4_001));
      const audits: string[] = [];
      const p = createRecoveryEvidenceProvider({
        roots: [jdir], sessionRoots: [sdir], sessionFor: () => "b.session.jsonl", maxCombinedBytes: 10_000,
        audit: (l) => { audits.push(l); },
      });
      const over = await p("b.jsonl");
      expect(over).toEqual({ kind: "unavailable", reason: "oversized" }); // 6000+4001=10001>10000（各文件均<10000）
      // 独占杀伤面：stat 层早拒（未开文件即拒，审计带预算三元组）——读窗第二层（recovery-oversized-grew）不作首拒
      expect(audits.some((l) => l.includes("recovery-oversized file=b.jsonl") && l.includes("journal=6000") && l.includes("session=4001"))).toBe(true);
      // session 缩到恰好 → 6000+4000-1 合计 ≤10000 快照
      await writeFile(sp, Buffer.alloc(3_999));
      const ok = await p("b.jsonl");
      expect(isRecoverySnapshot(ok)).toBe(true);
    } finally {
      await rm(jdir, { recursive: true, force: true });
      await rm(sdir, { recursive: true, force: true });
    }
  });

  it("R3 UTF-8 字节口径：中文字符数未超但字节数超→oversized（非字符数计量）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rec3-"));
    try {
      const jp = join(dir, "c.jsonl");
      const zh = "中".repeat(3_400); // 3400 字符 / 10200 UTF-8 字节
      await writeFile(jp, zh, "utf8");
      const p = createRecoveryEvidenceProvider({ roots: [dir], maxCombinedBytes: 10_000 });
      expect(await p("c.jsonl")).toEqual({ kind: "unavailable", reason: "oversized" }); // 10200>10000（按字符数会误放行）
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("R4 检查后增长：预检 stat ≤ 预算、读窗超限（注入接缝）→oversized 不放行半截结论", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rec4-"));
    try {
      const jp = join(dir, "d.jsonl");
      await writeFile(jp, Buffer.alloc(100));
      const statLike: StatLike = { stat: async () => ({ size: 100 }) }; // 预检通过
      const grew = await createRecoveryEvidenceProvider({
        roots: [dir], maxCombinedBytes: 200, statLike,
        readLike: { readBounded: async (_p, max) => "x".repeat(max + 1) }, // 读窗返回允许额+1=增长到超限
      })("d.jsonl");
      expect(grew).toEqual({ kind: "unavailable", reason: "oversized" }); // 预检 100≤200 放行；读窗超允许额→拒（无半截结论）
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("R5 安全 open 失败：journal ENOENT/权限→file-unreadable（typed）；session ENOENT=降级非失败", async () => {
    const jdir = await mkdtemp(join(tmpdir(), "rec5j-"));
    const sdir = await mkdtemp(join(tmpdir(), "rec5s-"));
    try {
      const p = createRecoveryEvidenceProvider({ roots: [jdir], sessionRoots: [sdir], sessionFor: () => "ghost.session.jsonl" });
      const enoent = await p("ghost.jsonl");
      expect(enoent).toMatchObject({ kind: "file-unreadable", path: join(jdir, "ghost.jsonl") });
      // 权限面（POSIX）：存在但不可读
      if (process.platform !== "win32") {
        const jp = join(jdir, "perm.jsonl");
        await writeFile(jp, "x");
        await chmod(jp, 0o000);
        const denied = await p("perm.jsonl");
        expect(denied).toMatchObject({ kind: "file-unreadable" });
        await chmod(jp, 0o644).catch(() => {});
      }
    } finally {
      await rm(jdir, { recursive: true, force: true });
      await rm(sdir, { recursive: true, force: true });
    }
  });

  it("R6 取消语义：signal 已 abort→不触盘（readLike 不被调）→unavailable/read-failed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rec6-"));
    let reads = 0;
    try {
      const p = createRecoveryEvidenceProvider({
        roots: [dir], readLike: { readBounded: async () => { reads += 1; return ""; } },
      });
      const ctl = new AbortController();
      ctl.abort();
      expect(await p("f.jsonl", ctl.signal)).toEqual({ kind: "unavailable", reason: "read-failed" });
      expect(reads).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("R10 读中取消：abort 落在读窗内→read-failed（无半截快照）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rec10-"));
    try {
      const jp = join(dir, "e.jsonl");
      await writeFile(jp, "{\"t\":\"note\"}\n");
      const p = createRecoveryEvidenceProvider({
        roots: [dir], maxCombinedBytes: 10_000,
        readLike: { readBounded: async (_path: string, max: number) => {
          await new Promise<void>((res) => setTimeout(res, 30)); // 读窗 30ms
          return "x".repeat(Math.min(100, max)); // 窗后返回合法短串（若无读后取消检查→成快照）
        } },
      });
      const ac = new AbortController();
      const fut = p("e.jsonl", ac.signal);
      setTimeout(() => ac.abort(), 5); // 窗内取消
      const res = await fut;
      expect(res).toEqual({ kind: "unavailable", reason: "read-failed" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("R7 快照内容：撕裂尾/坏行入 bad（证据保留）；sessionId 默认=去后缀；文件名带 .jsonl 恒可判", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rec7-"));
    try {
      const jp = join(dir, "sid-9.jsonl");
      await writeFile(jp, '{"t":"note"}\nnot-json\n', "utf8"); // 末行无换行=撕裂尾；not-json=坏行
      const snap = await createRecoveryEvidenceProvider({ roots: [dir] })("sid-9.jsonl");
      expect(isRecoverySnapshot(snap)).toBe(true);
      if (isRecoverySnapshot(snap)) {
        expect(snap.bad.length).toBe(2); // 坏行+撕裂尾都保留
        expect(snap.sessionId).toBe("sid-9");
        expect(snap.file).toBe("sid-9.jsonl");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("R8 真实 8MiB 默认档：合计 −1→快照（默认预算 DEFAULT_RECOVERY_COMBINED_BYTES）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rec8-"));
    try {
      const jp = join(dir, "big.jsonl");
      const buf = Buffer.alloc(DEFAULT_RECOVERY_COMBINED_BYTES - 1);
      buf.fill("x", 0, Math.min(64, buf.length));
      await writeFile(jp, buf);
      expect(DEFAULT_RECOVERY_COMBINED_BYTES).toBe(8 * MiB);
      const snap = await createRecoveryEvidenceProvider({ roots: [dir] })("big.jsonl");
      expect(isRecoverySnapshot(snap)).toBe(true); // 8MiB−1 放行
      await writeFile(jp, Buffer.alloc(DEFAULT_RECOVERY_COMBINED_BYTES + 1));
      expect(await createRecoveryEvidenceProvider({ roots: [dir] })("big.jsonl")).toEqual({ kind: "unavailable", reason: "oversized" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("R9 stat 与真实 fs 一致性（默认 statLike 走 node:fs）：小文件尺寸对照", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rec9-"));
    try {
      const jp = join(dir, "s.jsonl");
      await writeFile(jp, "abcd", "utf8"); // 4 字节
      expect((await stat(jp)).size).toBe(4);
      const snap = await createRecoveryEvidenceProvider({ roots: [dir] })("s.jsonl");
      expect(isRecoverySnapshot(snap)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
