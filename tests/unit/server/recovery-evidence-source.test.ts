// 3b-4 恢复真读源 provider 单测 v2（fix11：B11-1 安全打开/B11-2 证据链/B11-3 读窗/B11-4 工厂自防御）。
// 预算边界用小预算（maxCombinedBytes 注入）做精确字节例；真 8MiB 默认档例证规模面。
// 增长竞态用 openLike 接缝确定性复现（真 fs 计时窗不可稳定命中）；安全打开（symlink/FIFO）用真 fs
// 实路径（openSafeFile 真旗标）；证据链（B11-2）用真 sidecar 目录跨实例续链。
import { describe, expect, it } from "vitest";
import { mkdtemp, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createRecoveryEvidenceProvider,
  isRecoverySnapshot,
  type OpenLike,
  type RecoveryEvidenceResult,
  type SafeHandleLike,
} from "../../../apps/server/src/runtime/recovery-evidence-source.ts";
import { SafeOpenError } from "../../../apps/server/src/ws/safe-open.ts";
import { snapshotEvidenceHash, type RecoveryEvidenceSnapshot } from "../../../apps/server/src/runtime/recover.ts";
import { matchKeyOf } from "@pi-agent-ui/protocol";

const MiB = 1024 * 1024;
const execFileP = promisify(execFile);

/** 合法 journal 行（enqueue 全形；parseJournalText schema 判定唯一权威=protocol/journal-schema） */
const jl = (i: string) => JSON.stringify({ t: "enqueue", intentId: i, sessionId: "q", generation: 1, leafId: "L", matchKey: matchKeyOf("t", [], 1), payload: { kind: "prompt", rawText: "t", attachments: [], sentAt: "1" } });

/** 三目录 rig：journal 根/session 根/证据链目录。 */
async function mkRig(prefix: string): Promise<{ jRoot: string; sRoot: string; evDir: string; cleanup: () => Promise<void> }> {
  const jRoot = await mkdtemp(join(tmpdir(), `${prefix}j-`));
  const sRoot = await mkdtemp(join(tmpdir(), `${prefix}s-`));
  const evDir = await mkdtemp(join(tmpdir(), `${prefix}e-`));
  return { jRoot, sRoot, evDir, cleanup: async () => {
    await rm(jRoot, { recursive: true, force: true });
    await rm(sRoot, { recursive: true, force: true });
    await rm(evDir, { recursive: true, force: true });
  } };
}

function snapOf(x: RecoveryEvidenceResult): RecoveryEvidenceSnapshot {
  if (!isRecoverySnapshot(x)) throw new Error(`期望快照，实得 ${JSON.stringify(x)}`);
  return x;
}

/** openLike 假件：按绝对路径给 {size, bytes}；read 计数；可覆盖 read 行为（增长/门控）。 */
function fakeOpen(files: Record<string, { size: number; bytes?: Buffer }>): {
  openLike: OpenLike; journalReads: () => number; opens: () => number;
} {
  let journalReads = 0;
  let opens = 0;
  const openLike: OpenLike = async (abs) => {
    opens++;
    const f = files[abs];
    if (f === undefined) throw new SafeOpenError("missing", abs, "ENOENT");
    const bytes = f.bytes ?? Buffer.alloc(f.size);
    const h: SafeHandleLike = {
      size: f.size,
      read: async () => { journalReads++; return Buffer.from(bytes); },
      close: async () => {},
    };
    return h;
  };
  return { openLike, journalReads: () => journalReads, opens: () => opens };
}

describe("recovery-evidence-source（fix11 v2：安全读+证据链）", () => {
  it("R1 预算边界：合计 −1 与恰等→快照；+1→oversized（真 fs 字节精确；追加序列过链）", async () => {
    const { jRoot, evDir, cleanup } = await mkRig("rec1-");
    try {
      const jp = join(jRoot, "a.jsonl");
      const base = jl("i-1") + "\n";
      const bl = Buffer.byteLength(base);
      const mk = (pad: number) => writeFile(jp, Buffer.concat([Buffer.from(base), Buffer.alloc(pad, "x")]));
      const p = createRecoveryEvidenceProvider({ roots: [jRoot], evidenceDir: evDir, maxCombinedBytes: 10_000 });
      await mk(10_000 - 1 - bl);
      const under = snapOf(await p("a.jsonl"));
      expect(snapshotEvidenceHash(under)).toMatch(/^[0-9a-f]{64}$/);
      await mk(10_000 - bl); // 纯追加扩展（同前缀）
      expect(isRecoverySnapshot(await p("a.jsonl"))).toBe(true);
      await mk(10_000 + 1 - bl);
      expect(await p("a.jsonl")).toEqual({ kind: "unavailable", reason: "oversized" });
    } finally { await cleanup(); }
  });

  it("R2 合计口径+零读：各文件未超但合计超→oversized 且 journal 零读（stat 层早拒独占面）", async () => {
    const { jRoot, sRoot, evDir, cleanup } = await mkRig("rec2-");
    try {
      const audits: string[] = [];
      const { openLike, journalReads } = fakeOpen({
        [join(jRoot, "b.jsonl")]: { size: 6_000 },
        [join(sRoot, "b.session.jsonl")]: { size: 4_001 },
      });
      const p = createRecoveryEvidenceProvider({
        roots: [jRoot], sessionRoots: [sRoot], sessionFor: () => "b.session.jsonl",
        evidenceDir: evDir, maxCombinedBytes: 10_000, openLike,
        audit: (l) => { audits.push(l); },
      });
      expect(await p("b.jsonl")).toEqual({ kind: "unavailable", reason: "oversized" }); // 6000+4001=10001>10000
      expect(journalReads()).toBe(0); // P14：stat 层早拒=零读（读窗纵深不作首拒）
      expect(audits.some((l) => l.includes("recovery-oversized file=b.jsonl") && l.includes("journal=6000") && l.includes("session=4001"))).toBe(true);
    } finally { await cleanup(); }
  });

  it("R3 UTF-8 字节口径：多字节字符按实际字节计入预算（真 fs）", async () => {
    const { jRoot, evDir, cleanup } = await mkRig("rec3-");
    try {
      const jp = join(jRoot, "c.jsonl");
      const row = JSON.stringify({ t: "enqueue", intentId: "i-中文-1", sessionId: "q", generation: 1, leafId: "L", matchKey: matchKeyOf("中文文本", [], 1), payload: { kind: "prompt", rawText: "中文文本", attachments: [], sentAt: "1" } });
      const body = row + "\n"; // 多字节字符按实际字节计入
      const n = Buffer.byteLength(body);
      const p = createRecoveryEvidenceProvider({ roots: [jRoot], evidenceDir: evDir, maxCombinedBytes: n });
      await writeFile(jp, body);
      const ok = snapOf(await p("c.jsonl"));
      expect(ok.lines).toHaveLength(1);
      // +1B 超限（追加半个多字节字符的填充）
      await writeFile(jp, body + "x");
      expect(await p("c.jsonl")).toEqual({ kind: "unavailable", reason: "oversized" });
    } finally { await cleanup(); }
  });

  it("R4 读窗增长：fstat 后读时变大（seam 返超限字节）→oversized-grew（读后字节复核）", async () => {
    const { jRoot, evDir, cleanup } = await mkRig("rec4-");
    try {
      const audits: string[] = [];
      const { openLike } = fakeOpen({ [join(jRoot, "d.jsonl")]: { size: 1_000, bytes: Buffer.alloc(1_001) } }); // 读窗内 +1B
      const p = createRecoveryEvidenceProvider({
        roots: [jRoot], evidenceDir: evDir, maxCombinedBytes: 1_000, openLike,
        audit: (l) => { audits.push(l); },
      });
      expect(await p("d.jsonl")).toEqual({ kind: "unavailable", reason: "oversized" });
      expect(audits.some((l) => l.includes("recovery-oversized-grew file=d.jsonl"))).toBe(true);
    } finally { await cleanup(); }
  });

  it("R5 session 同源：ENOENT 降级 journal-only；session symlink→file-unreadable（真安全打开）", async () => {
    const { jRoot, sRoot, evDir, cleanup } = await mkRig("rec5-");
    try {
      const jp = join(jRoot, "e.jsonl");
      await writeFile(jp, jl("i-1") + "\n");
      // ENOENT 降级（真 fs：session 不存在）
      const p1 = createRecoveryEvidenceProvider({ roots: [jRoot], sessionRoots: [sRoot], sessionFor: () => "e.session.jsonl", evidenceDir: evDir });
      const s1 = snapOf(await p1("e.jsonl"));
      expect(s1.lines).toHaveLength(1);
      // session=symlink→file-unreadable detail=symlink（O_NOFOLLOW 真旗标）
      const outside = await mkdtemp(join(tmpdir(), "rec5o-"));
      const target = join(outside, "x.jsonl");
      await writeFile(target, "x");
      await symlink(target, join(sRoot, "e.session.jsonl"));
      const p2 = createRecoveryEvidenceProvider({ roots: [jRoot], sessionRoots: [sRoot], sessionFor: () => "e.session.jsonl", evidenceDir: evDir });
      expect(await p2("e.jsonl")).toEqual({ kind: "file-unreadable", path: "e.jsonl", detail: "symlink" });
      await rm(outside, { recursive: true, force: true });
    } finally { await cleanup(); }
  });

  it("R6 读前取消：signal 已 abort→read-failed 且零打开", async () => {
    const { jRoot, evDir, cleanup } = await mkRig("rec6-");
    try {
      const { openLike, opens } = fakeOpen({ [join(jRoot, "f.jsonl")]: { size: 10 } });
      const p = createRecoveryEvidenceProvider({ roots: [jRoot], evidenceDir: evDir, openLike });
      const ac = new AbortController();
      ac.abort();
      expect(await p("f.jsonl", ac.signal)).toEqual({ kind: "unavailable", reason: "read-failed" });
      expect(opens()).toBe(0);
    } finally { await cleanup(); }
  });

  it("R7 撕裂尾：末行截断的残片入 bad（真撕裂样本——写入中断形态）", async () => {
    const { jRoot, evDir, cleanup } = await mkRig("rec7-");
    try {
      const jp = join(jRoot, "g.jsonl");
      await writeFile(jp, jl("i-1") + "\n" + '{"intentId":"i-2","t":"enq"'); // 末行无换行且 JSON 撕裂（中途截断）
      const p = createRecoveryEvidenceProvider({ roots: [jRoot], evidenceDir: evDir });
      const s = snapOf(await p("g.jsonl"));
      expect(s.lines).toHaveLength(1);
      expect(s.bad).toHaveLength(1);
      expect(s.repaired).toBe(false);
    } finally { await cleanup(); }
  });

  it("R8 真 8MiB 默认档：恰预算内→快照；+1→oversized（默认有界读真路径）", async () => {
    const { jRoot, evDir, cleanup } = await mkRig("rec8-");
    try {
      const jp = join(jRoot, "h.jsonl");
      const one = jl("i-1") + "\n";
      const row = Buffer.byteLength(one);
      const rows = Math.floor(8 * MiB / row) - 1; // 合计 <8MiB
      await writeFile(jp, one.repeat(rows));
      const p = createRecoveryEvidenceProvider({ roots: [jRoot], evidenceDir: evDir });
      const s = snapOf(await p("h.jsonl"));
      expect(s.lines).toHaveLength(rows);
      // 补齐到恰 8MiB+1 字节（重复行后接填充——撕裂尾，字节口径不受影响）
      await writeFile(jp, Buffer.concat([Buffer.from(one.repeat(rows)), Buffer.alloc(8 * MiB + 1 - rows * row, "x")]));
      expect(await p("h.jsonl")).toEqual({ kind: "unavailable", reason: "oversized" });
    } finally { await cleanup(); }
  });

  it("R9 锚点稳定：重复捕获同内容=零追加扩展（合法）；锚点文件落盘且形状正确", async () => {
    const { jRoot, evDir, cleanup } = await mkRig("rec9-");
    try {
      const jp = join(jRoot, "i.jsonl");
      await writeFile(jp, jl("i-1") + "\n");
      const p = createRecoveryEvidenceProvider({ roots: [jRoot], evidenceDir: evDir });
      const h1 = snapshotEvidenceHash(snapOf(await p("i.jsonl")));
      const h2 = snapshotEvidenceHash(snapOf(await p("i.jsonl")));
      expect(h1).toBe(h2); // 等长+同前缀=纯追加（零追加）→同哈希复算
      const { readFile } = await import("node:fs/promises");
      const anchor = JSON.parse(await readFile(join(evDir, "i.jsonl.evidence.json"), "utf8")) as { version: number; file: string; len: number; sha: string };
      expect(anchor.version).toBe(1);
      expect(anchor.file).toBe("i.jsonl");
      expect(anchor.len).toBe(Buffer.byteLength(jl("i-1") + "\n"));
      expect(anchor.sha).toMatch(/^[0-9a-f]{64}$/);
    } finally { await cleanup(); }
  });

  it("R10 读中取消：读挂起窗内 abort→读完成即 read-failed（门控读确定性，无计时依赖）", async () => {
    const { jRoot, evDir, cleanup } = await mkRig("rec10-");
    try {
      let release!: (b: Buffer) => void;
      const gated = new Promise<Buffer>((res) => { release = res; });
      const openLike: OpenLike = async (abs) => {
        if (!abs.endsWith("j.jsonl")) throw new SafeOpenError("missing", abs, "ENOENT");
        return {
          size: Buffer.byteLength(jl("i-1") + "\n"),
          read: () => gated,
          close: async () => {},
        };
      };
      const p = createRecoveryEvidenceProvider({ roots: [jRoot], evidenceDir: evDir, openLike });
      const ac = new AbortController();
      const fut = p("j.jsonl", ac.signal);
      await new Promise((r) => setImmediate(r));
      ac.abort(); // 读仍挂起（当前 I/O 不消费 signal——披露语义）
      release(Buffer.from(jl("i-1") + "\n")); // 读完成
      expect(await fut).toEqual({ kind: "unavailable", reason: "read-failed" }); // 读后取消检查点
    } finally { await cleanup(); }
  });

  it("R11 证据链改写：首捕后截尾/重写→concurrent-modification（bad 消失不得洗白）", async () => {
    const { jRoot, evDir, cleanup } = await mkRig("rec11-");
    try {
      const jp = join(jRoot, "k.jsonl");
      const torn = jl("i-1") + "\n" + jl("i-2") + "\n" + '{"intentId":"i-3","t":"enq"'; // 尾行撕裂
      await writeFile(jp, torn);
      const audits: string[] = [];
      const p = createRecoveryEvidenceProvider({ roots: [jRoot], evidenceDir: evDir, audit: (l) => { audits.push(l); } });
      const first = snapOf(await p("k.jsonl"));
      expect(first.bad).toHaveLength(1);
      // 「修复」：去掉撕裂尾→当前盘面干净——但已见证据被改写（缩+重写）→拒
      await writeFile(jp, jl("i-1") + "\n");
      expect(await p("k.jsonl")).toEqual({ kind: "unavailable", reason: "concurrent-modification" });
      expect(audits.some((l) => l.includes("recovery-evidence-rewritten file=k.jsonl"))).toBe(true);
      // 锚点不被改写结果覆盖：仍=首捕长度
      const { readFile } = await import("node:fs/promises");
      const anchor = JSON.parse(await readFile(join(evDir, "k.jsonl.evidence.json"), "utf8")) as { len: number };
      expect(anchor.len).toBe(Buffer.byteLength(torn));
    } finally { await cleanup(); }
  });

  it("R12 重启续链：新实例同 evidenceDir——纯追加过；重写拒（驱逐/重启不丢已见证据）", async () => {
    const { jRoot, evDir, cleanup } = await mkRig("rec12-");
    try {
      const jp = join(jRoot, "l.jsonl");
      await writeFile(jp, jl("i-1") + "\n");
      const pA = createRecoveryEvidenceProvider({ roots: [jRoot], evidenceDir: evDir });
      expect(isRecoverySnapshot(await pA("l.jsonl"))).toBe(true);
      const pB = createRecoveryEvidenceProvider({ roots: [jRoot], evidenceDir: evDir }); // 「重启」：全新实例
      await writeFile(jp, jl("i-1") + "\n" + jl("i-2") + "\n"); // 纯追加
      const grown = snapOf(await pB("l.jsonl"));
      expect(grown.lines).toHaveLength(2);
      await writeFile(jp, jl("i-9") + "\n"); // 非前缀重写（缩）
      expect(await pB("l.jsonl")).toEqual({ kind: "unavailable", reason: "concurrent-modification" });
    } finally { await cleanup(); }
  });

  it("R13 session 映射非法：绝对路径/越界→file-unreadable 响亮失败（禁静默 journal-only）；嵌套合法", async () => {
    const { jRoot, sRoot, evDir, cleanup } = await mkRig("rec13-");
    try {
      await writeFile(join(jRoot, "m.jsonl"), jl("i-1") + "\n");
      await mkdir(join(sRoot, "sub"));
      await writeFile(join(sRoot, "sub", "m.session.jsonl"), "x");
      const audits: string[] = [];
      const mk = (sessionFor: (f: string) => string) => createRecoveryEvidenceProvider({
        roots: [jRoot], sessionRoots: [sRoot], sessionFor, evidenceDir: evDir, audit: (l) => { audits.push(l); },
      });
      expect(await mk(() => "/etc/passwd")("m.jsonl")).toEqual({ kind: "file-unreadable", path: "m.jsonl", detail: "session 映射非法（绝对路径）" });
      expect(await mk(() => "../../etc/passwd")("m.jsonl")).toEqual({ kind: "file-unreadable", path: "m.jsonl", detail: "session 映射越界" });
      expect(audits.some((l) => l.includes("recovery-session-map-invalid file=m.jsonl"))).toBe(true);
      const nested = snapOf(await mk(() => "sub/m.session.jsonl")("m.jsonl")); // 嵌套合法（sessionRoots 内）
      expect(nested.lines).toHaveLength(1);
    } finally { await cleanup(); }
  });

  it("R14 锚点损坏：sidecar 被外部改写/垃圾→concurrent-modification（篡改面 fail-closed）", async () => {
    const { jRoot, evDir, cleanup } = await mkRig("rec14-");
    try {
      const jp = join(jRoot, "n.jsonl");
      await writeFile(jp, jl("i-1") + "\n");
      const p = createRecoveryEvidenceProvider({ roots: [jRoot], evidenceDir: evDir });
      expect(isRecoverySnapshot(await p("n.jsonl"))).toBe(true);
      await writeFile(join(evDir, "n.jsonl.evidence.json"), "{oops");
      expect(await p("n.jsonl")).toEqual({ kind: "unavailable", reason: "concurrent-modification" });
    } finally { await cleanup(); }
  });

  it("R15 锚点不可写：evidenceDir 不可创建/写入→read-failed（证据不落盘不得发结论）", async () => {
    const { jRoot, cleanup } = await mkRig("rec15-");
    try {
      const blocker = join(jRoot, "blocker"); // 用一个普通文件占住目录名→mkdir 失败
      await writeFile(blocker, "x");
      await writeFile(join(jRoot, "o.jsonl"), jl("i-1") + "\n");
      const audits: string[] = [];
      const p = createRecoveryEvidenceProvider({ roots: [jRoot], evidenceDir: blocker, audit: (l) => { audits.push(l); } });
      expect(await p("o.jsonl")).toEqual({ kind: "unavailable", reason: "read-failed" });
      expect(audits.some((l) => l.includes("recovery-evidence-store-failed file=o.jsonl"))).toBe(true);
    } finally { await cleanup(); }
  });

  it("R16 journal 安全打开：根外 symlink→symlink；FIFO→not-regular 且 open 不永挂（真旗标）", async () => {
    if (process.platform === "win32") return; // O_NOFOLLOW/O_NONBLOCK 与 mkfifo=POSIX 面；win32 退 0 旗标由部署文档限定
    const { jRoot, evDir, cleanup } = await mkRig("rec16-");
    try {
      const outside = await mkdtemp(join(tmpdir(), "rec16o-"));
      const target = join(outside, "real.jsonl");
      await writeFile(target, "x");
      await symlink(target, join(jRoot, "p.jsonl"));
      const p = createRecoveryEvidenceProvider({ roots: [jRoot], evidenceDir: evDir });
      expect(await p("p.jsonl")).toEqual({ kind: "file-unreadable", path: "p.jsonl", detail: "symlink" });
      await execFileP("mkfifo", [join(jRoot, "q.jsonl")]);
      // O_NONBLOCK：open 即返，fstat 拒非常规——若旗标丢失则 open 永挂（超时兜底=用例失败而非套件卡死）
      const r = await Promise.race([
        p("q.jsonl"),
        new Promise<{ kind: string }>((res) => setTimeout(() => res({ kind: "timeout-hang" }), 3_000)),
      ]);
      expect(r).toEqual({ kind: "file-unreadable", path: "q.jsonl", detail: "not-regular" });
      await rm(outside, { recursive: true, force: true });
    } finally { await cleanup(); }
  });

  it("R17 追加连续捕获：两次纯追加→两次快照哈希前进（I1 语义单测面）", async () => {
    const { jRoot, evDir, cleanup } = await mkRig("rec17-");
    try {
      const jp = join(jRoot, "r.jsonl");
      await writeFile(jp, jl("i-1") + "\n");
      const p = createRecoveryEvidenceProvider({ roots: [jRoot], evidenceDir: evDir });
      const h1 = snapshotEvidenceHash(snapOf(await p("r.jsonl")));
      await writeFile(jp, jl("i-1") + "\n" + jl("i-2") + "\n");
      const h2 = snapshotEvidenceHash(snapOf(await p("r.jsonl")));
      expect(h1).not.toBe(h2);
    } finally { await cleanup(); }
  });

  it("R18 工厂自防御：非法预算/相对 evidenceDir/相对 roots→工厂即抛（B11-4 纵深）", async () => {
    const { jRoot, evDir, cleanup } = await mkRig("rec18-");
    try {
      for (const bad of [NaN, Infinity, -Infinity, 0, -1, 1.5]) {
        expect(() => createRecoveryEvidenceProvider({ roots: [jRoot], evidenceDir: evDir, maxCombinedBytes: bad })).toThrow(/maxCombinedBytes/);
      }
      expect(() => createRecoveryEvidenceProvider({ roots: [jRoot], evidenceDir: "relative/dir" })).toThrow(/evidenceDir/);
      expect(() => createRecoveryEvidenceProvider({ roots: ["rel"], evidenceDir: evDir })).toThrow(/roots/);
    } finally { await cleanup(); }
  });

  it("R19 session 读窗增长（P07）：读后复核 session 变大→合计再验 oversized（fail-closed；seam 定序开）", async () => {
    const { jRoot, sRoot, evDir, cleanup } = await mkRig("rec19-");
    try {
      const audits: string[] = [];
      const sAbs = join(sRoot, "s.bin");
      const jAbs = join(jRoot, "r19.jsonl");
      const head = Buffer.from(jl("i-1") + "\n", "utf8");
      const jBytes = Buffer.concat([head, Buffer.alloc(600 - head.byteLength).fill("\n")]); // 恰 600B
      let sessionOpens = 0;
      const openLike: OpenLike = async (abs) => {
        if (abs === sAbs) {
          sessionOpens++;
          const size = sessionOpens === 1 ? 400 : 500; // 预检小、复核大=读窗内增长
          const h: SafeHandleLike = { size, read: async () => Buffer.alloc(0), close: async () => {} };
          return h;
        }
        if (abs === jAbs) {
          const h: SafeHandleLike = { size: jBytes.byteLength, read: async () => jBytes, close: async () => {} };
          return h;
        }
        throw new SafeOpenError("missing", abs, "ENOENT");
      };
      const p = createRecoveryEvidenceProvider({
        roots: [jRoot], sessionRoots: [sRoot], sessionFor: () => "s.bin",
        evidenceDir: evDir, maxCombinedBytes: 1_000, openLike,
        audit: (l) => { audits.push(l); },
      });
      // 预检 600+400=1000 恰过；读 journal 600B≤allowed；复核 600+500=1100>1000→oversized
      expect(await p("r19.jsonl")).toEqual({ kind: "unavailable", reason: "oversized" });
      expect(sessionOpens).toBe(2); // 复核确实发生
      expect(audits.some((l) => l.includes("recovery-oversized-grew") && l.includes("session=500"))).toBe(true);
    } finally { await cleanup(); }
  });
});
