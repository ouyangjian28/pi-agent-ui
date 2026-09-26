// 3b-2b②：DualHistorySource 组合器——journal+session 双源合成单 HistorySourcePort。
// 证据面：路径键控读取替身（每路径独立状态）+路径键控观察替身；归因端到端
// （journal 盘面 enqueue 三元组→session user 条目 intentId）；降级矩阵（journal 失败/
// session 缺失/无映射/归因读失败）；observe/release 配对纪律。
import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DualHistorySource } from "../../../apps/server/src/runtime/dual-history-source.ts";
import type { HistoryReaderPort, HistoryWatcherPort } from "../../../apps/server/src/runtime/history-source.ts";
import type { HistoryInvalidateReason, HistorySinks, HistoryUnavailableReason } from "../../../apps/server/src/ws/ws-gateway.ts";
import { fnv1a64Hex, matchKeyOf } from "@pi-agent-ui/protocol";
import type { ScanRow } from "@pi-agent-ui/protocol";

const CLEANUP: string[] = [];
afterAll(async () => { for (const d of CLEANUP) await rm(d, { recursive: true, force: true }); });
async function tmpRoot(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "dual-hist-"));
  CLEANUP.push(d);
  return d;
}

/** 路径键控读取替身：每路径一份 {text, identity}；failPaths=读即拒；readCalls 留档；
 *  holdPaths=读挂起（R1 窗口控制）——releaseHold 时以**当时盘面**结算（窗口内 set 可见）。 */
class PathReader implements HistoryReaderPort {
  readonly files = new Map<string, { text: string; identity: string }>();
  readonly failPaths = new Set<string>();
  readonly holdPaths = new Set<string>();
  readCalls: string[] = [];
  private readonly heldFns: (() => void)[] = [];
  read(absPath: string): Promise<{ text: string; identity: string; fingerprint: string }> {
    this.readCalls.push(absPath);
    if (this.failPaths.has(absPath)) return Promise.reject(new Error(`read boom ${absPath}`));
    if (this.holdPaths.has(absPath)) {
      return new Promise((res, rej) => {
        this.heldFns.push(() => {
          const f = this.files.get(absPath);
          if (f === undefined) rej(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
          else res({ text: f.text, identity: f.identity, fingerprint: fnv1a64Hex(f.text) });
        });
      });
    }
    const f = this.files.get(absPath);
    if (f === undefined) return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    return Promise.resolve({ text: f.text, identity: f.identity, fingerprint: fnv1a64Hex(f.text) });
  }
  set(path: string, text: string, identity?: string): void { this.files.set(path, { text, identity: identity ?? `dev-ino-${path}` }); } // 同路径恒同身份（改写≠换身份；显式传 identity=换代）
  releaseHold(): void { this.holdPaths.clear(); const fns = this.heldFns.splice(0); for (const fn of fns) fn(); } // 一次性放行：后续读不再挂起（重装重读不挂）
  heldCount(): number { return this.heldFns.length; }
}

/** 路径键控观察替身：按路径留档句柄；触发定向。 */
class PathWatcher implements HistoryWatcherPort {
  readonly handles: { abs: string; closed: boolean; onNotice: () => void; onError: (e: unknown) => void }[] = [];
  failPaths = new Set<string>();
  watch(abs: string, onNotice: () => void, onError: (e: unknown) => void): { close(): void } {
    if (this.failPaths.has(abs)) throw new Error(`watch boom ${abs}`);
    const h = { abs, closed: false, onNotice, onError };
    this.handles.push(h);
    return { close: () => { h.closed = true; } };
  }
  active(abs: string) { return this.handles.filter((h) => h.abs === abs && !h.closed); }
  notice(abs: string): void { const h = [...this.active(abs)].pop(); if (h) h.onNotice(); }
  error(abs: string, e: unknown): void { const h = [...this.active(abs)].pop(); if (h) h.onError(e); }
}

interface SinkLog { appends: ScanRow[]; invalidates: HistoryInvalidateReason[]; unavailables: HistoryUnavailableReason[] }
function makeSinks(): { s: HistorySinks; log: SinkLog } {
  const log: SinkLog = { appends: [], invalidates: [], unavailables: [] };
  return { log, s: {
    onAppend: (r) => { log.appends.push(r); },
    onInvalidate: (reason) => { log.invalidates.push(reason); },
    onUnavailable: (reason) => { log.unavailables.push(reason); },
    onLive: () => {}, onStatus: () => {},
  } };
}

const USER_TEXT = "hello dual";
void 0;
function jEnqueue(intentId: string, text: string, ordinal: number): string {
  return JSON.stringify({ t: "enqueue", intentId, sessionId: "s", generation: 1, leafId: "L", matchKey: matchKeyOf(text, [], ordinal), payload: { kind: "prompt", rawText: text, attachments: [], sentAt: "1" } });
}
function sUser(id: string, text: string): string {
  return JSON.stringify({ type: "message", id, parentId: null, timestamp: 1, message: { role: "user", content: text } });
}

function harness(over: { sessionFor?: (f: string) => string; roots?: string[]; sessionRoots?: string[] } = {}) {
  const reader = new PathReader();
  const watcher = new PathWatcher();
  const audits: string[] = [];
  const jRoot = "/j";
  const sRoot = "/s";
  const src = new DualHistorySource({
    roots: over.roots ?? [jRoot],
    sessionRoots: over.sessionRoots ?? [sRoot],
    ...(over.sessionFor === undefined ? {} : { sessionFor: over.sessionFor }),
    reader, watcher,
    audit: (l) => { audits.push(l); },
  });
  return { src, reader, watcher, audits, jRoot, sRoot };
}

async function drain(ms = 4): Promise<void> { await new Promise((r) => setTimeout(r, ms)); }
async function until(cond: () => boolean, ms = 400): Promise<void> {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await drain(2);
  if (!cond()) throw new Error("until timeout");
}

describe("DualHistorySource 3b-2b②——合成与归因", () => {
  it("load=journal 全部在前 session 在后；session user 条目经 journal 盘面三元组归因得 intentId", async () => {
    const h = harness({ sessionFor: (f) => f.replace("/j/", "/s/") });
    h.reader.set("/j/a", jEnqueue("i-1", USER_TEXT, 0) + "\n");
    h.reader.set("/s/a", sUser("u1", USER_TEXT) + "\n");
    const rows = await h.src.load("/j/a");
    expect(rows).not.toBeNull();
    const r = rows ?? [];
    expect(r[0]?.source).toBe("journal");
    expect(r[0]?.event.kind).toBe("turn-enqueued");
    const sessionRows = r.filter((x) => x.source === "session");
    expect(sessionRows).toHaveLength(1);
    expect(sessionRows[0]?.event.kind).toBe("message");
    expect(sessionRows[0]?.event.intentId).toBe("i-1"); // 端到端归因
    h.src.release("/j/a");
  });

  it("归因完整行纪律：journal 撕裂尾中的 enqueue 不参与匹配（user 未匹配 intentId=null）", async () => {
    const h = harness({ sessionFor: (f) => f.replace("/j/", "/s/") });
    h.reader.set("/j/a", jEnqueue("i-1", USER_TEXT, 0)); // 无尾 \n=撕裂尾
    h.reader.set("/s/a", sUser("u1", USER_TEXT) + "\n");
    const rows = await h.src.load("/j/a");
    const sessionRows = (rows ?? []).filter((x) => x.source === "session");
    expect(sessionRows[0]?.event.intentId).toBeNull();
    h.src.release("/j/a");
  });

  it("journal 失败→load=null（fail-closed，4402 面）", async () => {
    const h = harness({ sessionFor: (f) => f.replace("/j/", "/s/") });
    h.reader.failPaths.add("/j/a");
    h.reader.set("/s/a", sUser("u1", USER_TEXT) + "\n");
    expect(await h.src.load("/j/a")).toBeNull();
  });

  it("session 缺失→journal-only 降级+审计 session-missing", async () => {
    const h = harness({ sessionFor: (f) => f.replace("/j/", "/s/") });
    h.reader.set("/j/a", jEnqueue("i-1", USER_TEXT, 0) + "\n");
    const rows = await h.src.load("/j/a"); // /s/a 不存在
    expect(rows).not.toBeNull();
    expect((rows ?? []).every((x) => x.source === "journal")).toBe(true);
    expect(h.audits.some((l) => l.includes("session-missing"))).toBe(true);
    h.src.release("/j/a");
  });

  it("无 sessionFor 映射→journal-only 模式+审计 no-session-mapping", async () => {
    const h = harness({});
    h.reader.set("/j/a", jEnqueue("i-1", USER_TEXT, 0) + "\n");
    const rows = await h.src.load("/j/a");
    expect((rows ?? []).every((x) => x.source === "journal")).toBe(true);
    expect(h.audits.some((l) => l.includes("journal-only") && l.includes("no-session-mapping"))).toBe(true);
    h.src.release("/j/a");
  });

  it("归因读失败（journal 读通道故障）→session 投影缺证降级 intentId=null+审计", async () => {
    const h = harness({ sessionFor: (f) => f.replace("/j/", "/s/") });
    // journal 首扫成功；归因读时故障：用「读完一次即坏」的路径状态
    h.reader.set("/j/a", jEnqueue("i-1", USER_TEXT, 0) + "\n");
    h.reader.set("/s/a", sUser("u1", USER_TEXT) + "\n");
    const origRead = h.reader.read.bind(h.reader);
    let calls = 0;
    h.reader.read = (p: string) => {
      calls += 1;
      if (p === "/j/a" && calls > 1) return Promise.reject(new Error("attribution boom"));
      return origRead(p);
    };
    const rows = await h.src.load("/j/a");
    const sessionRows = (rows ?? []).filter((x) => x.source === "session");
    expect(sessionRows[0]?.event.intentId).toBeNull();
    expect(h.audits.some((l) => l.includes("attribution-unreadable"))).toBe(true);
    h.src.release("/j/a");
  });

  it("observe 双子源：journal 追加→onAppend(journal 行)；session 追加→onAppend(session 行)；失效转发", async () => {
    const h = harness({ sessionFor: (f) => f.replace("/j/", "/s/") });
    h.reader.set("/j/a", jEnqueue("i-1", USER_TEXT, 0) + "\n");
    h.reader.set("/s/a", sUser("u1", USER_TEXT) + "\n");
    const rows = await h.src.load("/j/a");
    expect(rows).not.toBeNull();
    const { s, log } = makeSinks();
    const un = h.src.observe("/j/a", s);
    expect(un).not.toBeNull();
    // journal 追加
    h.reader.set("/j/a", jEnqueue("i-1", USER_TEXT, 0) + "\n" + jEnqueue("i-2", "second", 1) + "\n");
    h.watcher.notice("/j/a");
    await until(() => log.appends.some((r) => r.source === "journal"));
    // session 追加
    h.reader.set("/s/a", sUser("u1", USER_TEXT) + "\n" + sUser("u2", "second") + "\n");
    h.watcher.notice("/s/a");
    await until(() => log.appends.some((r) => r.source === "session"));
    // R-02 后语义：换 inode 纯追加=同流交接（前缀补发，不失效）——先证交接面
    h.reader.set("/s/a", sUser("u1", USER_TEXT) + "\n" + sUser("u2", "second") + "\n" + sUser("u3", "third") + "\n", `dev-ino-${Date.now()}`);
    h.watcher.notice("/s/a");
    await until(() => log.appends.some((r) => r.source === "session" && r.raw.includes("u3")));
    expect(log.invalidates).toEqual([]);
    // 任一源盘面改写换代（identity 变+前缀破）→invalidate("replace") 转发
    // （watch 瞬错=重挂自愈，不产失效——设计面；同字节换 inode 走指纹短路不失效——3b-3⑤）
    h.reader.set("/s/a", sUser("u1x", USER_TEXT) + "\n" + sUser("u2", "second") + "\n", `dev-ino-${Date.now() + 1}`);
    h.watcher.notice("/s/a");
    await until(() => log.invalidates.length > 0);
    expect(log.invalidates).toContain("replace");
    (un as () => void)();
  });

  it("release 配对：load 后 release（未 observe）→双子源 watcher 全关", async () => {
    const h = harness({ sessionFor: (f) => f.replace("/j/", "/s/") });
    h.reader.set("/j/a", jEnqueue("i-1", USER_TEXT, 0) + "\n");
    h.reader.set("/s/a", sUser("u1", USER_TEXT) + "\n");
    const rows = await h.src.load("/j/a");
    expect(rows).not.toBeNull();
    h.src.release("/j/a");
    await until(() => h.watcher.active("/j/a").length === 0 && h.watcher.active("/s/a").length === 0);
    expect(h.watcher.handles.every((x) => x.closed)).toBe(true);
  });

  it("session 路径越界（outside sessionRoots）→session 子源拒载→journal-only 降级+审计", async () => {
    const h = harness({ sessionFor: () => "/etc/passwd", sessionRoots: ["/s"] });
    h.reader.set("/j/a", jEnqueue("i-1", USER_TEXT, 0) + "\n");
    const rows = await h.src.load("/j/a");
    expect(rows).not.toBeNull();
    expect((rows ?? []).every((x) => x.source === "journal")).toBe(true);
    h.src.release("/j/a");
  });

  it("真盘冒烟（3b-2b②）：临时目录双文件装载+归因", async () => {
    const jr = await tmpRoot();
    const sr = await tmpRoot();
    const { mkdtemp: _m, ..._rest } = { mkdtemp: null };
    void _m; void _rest;
    const audits: string[] = [];
    const src = new DualHistorySource({
      roots: [jr], sessionRoots: [sr],
      sessionFor: (_f) => join(sr, "s.jsonl"),
      audit: (l) => { audits.push(l); },
    });
    const jp = join(jr, "j.jsonl");
    const sp = join(sr, "s.jsonl");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(jp, jEnqueue("i-9", "real disk", 0) + "\n", "utf8");
    await writeFile(sp, sUser("u9", "real disk") + "\n", "utf8");
    const rows = await src.load(jp);
    const sessionRows = (rows ?? []).filter((x) => x.source === "session");
    expect(sessionRows[0]?.event.intentId).toBe("i-9");
    src.release(jp);
  });
});

describe("DualHistorySource 3b2b-R1/R2——跨 await 复核与降级恢复（GPT 65→修复）", () => {
  const JP = "/j/a";
  const SP = "/s/a";

  it("R1a：session 读等待窗内 journal 合法追加→装载吸收增长（旧快照不得回滚索引）", async () => {
    const h = harness({ sessionFor: (f) => f.replace("/j/", "/s/") });
    h.reader.set(JP, jEnqueue("i-1", USER_TEXT, 0) + "\n");
    await h.src.load(JP); // journal 槽活跃 [J1]
    const { s, log } = makeSinks();
    const un = h.src.observe(JP, s); // journal 绑定（session 无槽→null→journal-only 观察）
    expect(un).not.toBeNull();
    // B 装载：session 读挂起（R1a 窗口）
    h.reader.set(SP, sUser("u1", USER_TEXT) + "\n");
    h.reader.holdPaths.add(SP);
    const ld = h.src.load(JP);
    await until(() => h.reader.heldCount() >= 1);
    // 等待窗内 journal 追加 J2（live 分发）
    h.reader.set(JP, jEnqueue("i-1", USER_TEXT, 0) + "\n" + jEnqueue("i-2", "second", 0) + "\n");
    h.watcher.notice(JP);
    await until(() => log.appends.some((r) => r.event.kind === "turn-enqueued" && r.event.intentId === "i-2"));
    h.reader.releaseHold();
    const rows = await ld;
    // 吸收增长：journal 部分=[J1,J2]+session [S1]（旧代码返回旧快照 [J1,S1]→网关误判改写 4409+J2 漏）
    const j = (rows ?? []).filter((r) => r.source === "journal");
    const s2 = (rows ?? []).filter((r) => r.source === "session");
    expect(j).toHaveLength(2);
    expect(s2).toHaveLength(1);
    expect(h.audits.some((l) => l.includes("load-revalidate"))).toBe(false); // 合法增长不触发重装
    // 清理：B 的 load 引用由 release 结算；联合解绑关两源句柄
    h.src.release(JP);
    un?.();
    await until(() => h.watcher.active(JP).length === 0 && h.watcher.active(SP).length === 0);
    expect(h.watcher.active(SP).length).toBe(0);
  });

  it("R1b：session 读等待窗内 journal 换代→旧副本作废，有界重装发布新代内容（不透旧快照）", async () => {
    const h = harness({ sessionFor: (f) => f.replace("/j/", "/s/") });
    h.reader.set(JP, jEnqueue("i-1", USER_TEXT, 0) + "\n", "id-j1");
    await h.src.load(JP);
    const { s, log } = makeSinks();
    const un = h.src.observe(JP, s);
    h.reader.set(SP, sUser("u1", USER_TEXT) + "\n");
    h.reader.holdPaths.add(SP);
    const ld = h.src.load(JP);
    await until(() => h.reader.heldCount() >= 1);
    // 等待窗内 journal 换代（identity 变→invalidate replace）
    h.reader.set(JP, jEnqueue("i-9", "replaced", 0) + "\n", "id-j2");
    h.watcher.notice(JP);
    await until(() => log.invalidates.includes("replace"));
    h.reader.releaseHold();
    const rows = await ld;
    expect(rows).not.toBeNull();
    const j = (rows ?? []).filter((r) => r.source === "journal");
    expect(j).toHaveLength(1);
    expect((j[0]?.event as { intentId?: string }).intentId).toBe("i-9"); // 新代内容（非旧 J1）
    expect(h.audits.some((l) => l.includes("load-revalidate") && l.includes("journal-generation-lost"))).toBe(true);
    h.src.release(JP);
    un?.();
    await until(() => h.watcher.active(JP).length === 0 && h.watcher.active(SP).length === 0);
  });

  it("R1c：sessionFor 同步抛错→journal 引用精确回滚（无孤儿 watcher），异常上抛", async () => {
    const h = harness({ sessionFor: () => { throw new Error("map boom"); } });
    h.reader.set(JP, jEnqueue("i-1", USER_TEXT, 0) + "\n");
    await expect(h.src.load(JP)).rejects.toThrow("map boom");
    expect(h.watcher.active(JP).length).toBe(0); // journal 槽已关（无孤儿）
    expect(h.audits.some((l) => l.includes("session-load-threw"))).toBe(true);
  });

  it("R1b-观察面：journal 活跃代已失效→新 observe=null（session 成功不得掩盖事实源失效）", async () => {
    const h = harness({ sessionFor: (f) => f.replace("/j/", "/s/") });
    h.reader.set(JP, jEnqueue("i-1", USER_TEXT, 0) + "\n", "id-j1");
    h.reader.set(SP, sUser("u1", USER_TEXT) + "\n");
    await h.src.load(JP);
    const a = makeSinks();
    const un = h.src.observe(JP, a.s); // A 先绑定（两源）
    expect(un).not.toBeNull();
    // journal 换代失效→代关闭（绑定 sinks 收 invalidate 通知）
    h.reader.set(JP, jEnqueue("i-9", "replaced", 0) + "\n", "id-j2");
    h.watcher.notice(JP);
    await until(() => a.log.invalidates.includes("replace"));
    // 新观察：journal 无活跃代→整组失败（旧代码：session 绑定成功→联合 stop 非 null→网关误判观察成立）
    const b = makeSinks();
    expect(h.src.observe(JP, b.s)).toBeNull();
    un?.();
    await until(() => h.watcher.active(JP).length === 0 && h.watcher.active(SP).length === 0);
  });

  it("R2：journal-only 降级→双源恢复：load 补接 session 观察（同 sinks），后续追加直达", async () => {
    const h = harness({ sessionFor: (f) => f.replace("/j/", "/s/") });
    h.reader.set(JP, jEnqueue("i-1", USER_TEXT, 0) + "\n");
    await h.src.load(JP);
    const { s, log } = makeSinks();
    const un = h.src.observe(JP, s); // journal-only 观察
    expect(h.watcher.active(SP).length).toBe(0);
    // session 出现（B 装载触发恢复）
    h.reader.set(SP, sUser("u1", USER_TEXT) + "\n");
    const rows = await h.src.load(JP);
    expect((rows ?? []).filter((r) => r.source === "session")).toHaveLength(1);
    // 补接：session 观察已绑定（同一 sinks）
    expect(h.watcher.active(SP).length).toBe(1);
    expect(h.audits.some((l) => l.includes("session-attached-late"))).toBe(true);
    // 后续 session 追加→onAppend 直达（不再漏）
    h.reader.set(SP, sUser("u1", USER_TEXT) + "\n" + sUser("u2", "second") + "\n");
    h.watcher.notice(SP);
    await until(() => log.appends.some((r) => r.source === "session"));
    h.src.release(JP);
    un?.();
    await until(() => h.watcher.active(JP).length === 0 && h.watcher.active(SP).length === 0);
  });

  it("R3：journal 坏 enqueue 行→attribution-schema-rejected 审计+归因不采信（session 投影 intentId=null）", async () => {
    const h = harness({ sessionFor: (f) => f.replace("/j/", "/s/") });
    const badEnqueue = JSON.stringify({ t: "enqueue", intentId: "BAD", generation: 1.5, matchKey: matchKeyOf(USER_TEXT, [], 0) }); // 缺 sessionId/leafId+generation 非整数
    h.reader.set(JP, badEnqueue + "\n");
    h.reader.set(SP, sUser("u1", USER_TEXT) + "\n");
    const rows = await h.src.load(JP);
    expect(rows).not.toBeNull();
    expect(h.audits.some((l) => l.includes("attribution-schema-rejected") && l.includes("count=1"))).toBe(true);
    const su = (rows ?? []).find((r) => r.source === "session");
    expect(su?.event.intentId).toBeNull(); // 坏行不采信——旧代码会拿 BAD 行归因
    h.src.release(JP);
    await until(() => h.watcher.active(JP).length === 0 && h.watcher.active(SP).length === 0);
  });
});

describe("DualHistorySource 3b2c-fix1——五阻断闭合（GPT 72→修复）", () => {
  const JP = "/j/a";
  const SP = "/s/a";

  it("F1-01：session 缺失等待窗内 journal 合法追加→降级出口也复核，返回吸收增长的 cur（不透旧快照）", async () => {
    const h = harness({ sessionFor: (f) => f.replace("/j/", "/s/") });
    h.reader.set(JP, jEnqueue("i-1", USER_TEXT, 0) + "\n");
    await h.src.load(JP); // journal 槽活跃 [J1]
    const { s, log } = makeSinks();
    const un = h.src.observe(JP, s);
    // B 装载：session 读挂起（F1-01 窗口：session 有文件但读挂起，窗口内撤文件→null 降级）
    h.reader.set(SP, sUser("u1", USER_TEXT) + "\n");
    h.reader.holdPaths.add(SP);
    const ld = h.src.load(JP);
    await until(() => h.reader.heldCount() >= 1);
    // 等待窗内 journal 追加 J2
    h.reader.set(JP, jEnqueue("i-1", USER_TEXT, 0) + "\n" + jEnqueue("i-2", "second", 0) + "\n");
    h.watcher.notice(JP);
    await until(() => log.appends.some((r) => r.event.kind === "turn-enqueued" && r.event.intentId === "i-2"));
    // 窗口内撤走 session 文件→releaseHold 结算为 ENOENT→session=null 降级路径
    h.reader.files.delete(SP);
    h.reader.releaseHold();
    const rows = await ld;
    // 降级出口复核：返回 cur=[J1,J2]（旧代码返回旧快照 [J1]→网关误判改写 4409+J2 丢）
    expect(rows).not.toBeNull();
    const j = (rows ?? []).filter((r) => r.source === "journal");
    expect(j).toHaveLength(2);
    expect(j.map((r) => (r.event as { intentId?: string }).intentId)).toEqual(["i-1", "i-2"]);
    expect(h.audits.some((l) => l.includes("session-missing"))).toBe(true);
    expect(h.audits.some((l) => l.includes("load-revalidate"))).toBe(false); // 合法增长≠换流
    h.src.release(JP);
    un?.();
    await until(() => h.watcher.active(JP).length === 0 && h.watcher.active(SP).length === 0);
  });

  it("F1-02（fix3 免扣模型）：晚附不消耗装载方引用——B release 结算自己的债；C 重开续流零静默断流", async () => {
    const h = harness({ sessionFor: (f) => f.replace("/j/", "/s/") });
    h.reader.set(JP, jEnqueue("i-1", USER_TEXT, 0) + "\n");
    await h.src.load(JP); // A 装载
    const a = makeSinks();
    const unA = h.src.observe(JP, a.s); // A 观察（journal-only）
    // session 出现→B 装载→晚附**免扣**绑 A（不消耗 B 的 session 装载引用——谁的 load 谁结算）
    h.reader.set(SP, sUser("u1", USER_TEXT) + "\n");
    await h.src.load(JP);
    expect(h.audits.some((l) => l.includes("session-attached-late") && l.includes("regs=1"))).toBe(true);
    // B release：结算 B 自己的 session 引用（旧 credit 模型在此双扣→carry→下一装载误关 watcher）
    h.src.release(JP);
    expect(h.watcher.active(SP).length).toBe(1); // session 句柄仍活（A 的免扣绑定持有）
    // A 先退出：双源句柄全关
    unA?.();
    await until(() => h.watcher.active(JP).length === 0 && h.watcher.active(SP).length === 0);
    // C 装载+观察：session 事件直达 C
    const rowsC = await h.src.load(JP);
    expect((rowsC ?? []).filter((r) => r.source === "session")).toHaveLength(1);
    const c = makeSinks();
    const unC = h.src.observe(JP, c.s);
    expect(unC).not.toBeNull();
    h.reader.set(SP, sUser("u1", USER_TEXT) + "\n" + sUser("u2", "second") + "\n");
    h.watcher.notice(SP);
    await until(() => c.log.appends.some((r) => r.source === "session"));
    unC?.();
    await until(() => h.watcher.active(JP).length === 0 && h.watcher.active(SP).length === 0);
    expect(h.audits.some((l) => l.includes("released-unobserved-carry"))).toBe(false);
    expect(h.audits.some((l) => l.includes("release-carry"))).toBe(false);
  });

  it("F2-01（fix3 免扣模型）：observe 出口结算自己的引用——零 carry；后继 C load/release 零孤儿", async () => {
    const h = harness({ sessionFor: (f) => f.replace("/j/", "/s/") });
    h.reader.set(JP, jEnqueue("i-1", USER_TEXT, 0) + "\n");
    await h.src.load(JP); // A 装载
    const a = makeSinks();
    const unA = h.src.observe(JP, a.s); // A 观察（journal-only；session 缺）
    // session 出现→B 装载→晚附免扣绑 A（B 的 session 引用原封不动留给 B 自己的结算出口）
    h.reader.set(SP, sUser("u1", USER_TEXT) + "\n");
    await h.src.load(JP);
    expect(h.audits.some((l) => l.includes("session-attached-late") && l.includes("regs=1"))).toBe(true);
    // B 走 **observe** 出口（端口契约：load→observe|release 二选一）——消耗自己那份引用
    // （旧 credit 模型：observe 先无条件消耗一笔真实引用再扣 credit=双扣→下一 caller 造 carry）
    const b = makeSinks();
    const unB = h.src.observe(JP, b.s);
    expect(unB).not.toBeNull();
    // A/B 全退：双源句柄归零
    unA?.();
    unB?.();
    await until(() => h.watcher.active(JP).length === 0 && h.watcher.active(SP).length === 0);
    // C load→release（合法配对）：正常结算，无残留→零孤儿
    await h.src.load(JP);
    h.src.release(JP);
    await until(() => h.watcher.active(SP).length === 0);
    expect(h.audits.some((l) => l.includes("release-carry"))).toBe(false);
    expect(h.audits.some((l) => l.includes("released-unobserved-carry"))).toBe(false);
  });

  it("F2-02：多注册登记——新注册先停、旧注册仍活→恢复晚附补接旧注册（不丢 session 事件）", async () => {
    const h = harness({ sessionFor: (f) => f.replace("/j/", "/s/") });
    h.reader.set(JP, jEnqueue("i-1", USER_TEXT, 0) + "\n");
    await h.src.load(JP);
    const a = makeSinks();
    const unA = h.src.observe(JP, a.s); // 旧注册 st-A（journal-only；session 缺）
    await h.src.load(JP);
    const b = makeSinks();
    const unB = h.src.observe(JP, b.s); // 新注册 st-B（仍 journal-only）——旧单条 Map 会覆盖 st-A
    // 新注册先停：登记列表回到 [st-A]（旧代码 Map 只存最后一条→st-A 丢恢复入口）
    unB?.();
    // session 出现→C 装载→晚附应补接 st-A（regs=1）
    h.reader.set(SP, sUser("u1", USER_TEXT) + "\n");
    await h.src.load(JP);
    expect(h.audits.some((l) => l.includes("session-attached-late") && l.includes("regs=1"))).toBe(true);
    h.src.release(JP); // C 配对 release：credit 消费，跳过 session 侧
    expect(h.watcher.active(SP).length).toBe(1); // st-A 的晚附仍持有
    // session 追加→**旧注册 A** 收到（旧代码：晚附找不到入口→A 永远收不到）
    h.reader.set(SP, sUser("u1", USER_TEXT) + "\n" + sUser("u2", "recovered") + "\n");
    h.watcher.notice(SP);
    await until(() => a.log.appends.some((r) => r.source === "session" && r.event.kind === "message"));
    expect(a.log.appends.filter((r) => r.source === "session").some((r) => r.event.kind === "message")).toBe(true);
    // 收尾：A 解绑→双源句柄全关
    unA?.();
    await until(() => h.watcher.active(JP).length === 0 && h.watcher.active(SP).length === 0);
  });

  it("F1-04/F2-02：同 sinks 合法重绑（各自有 load 配对）——包装身份隔离；旧 stop 迟到只关旧注册", async () => {
    const h = harness({ sessionFor: (f) => f.replace("/j/", "/s/") });
    h.reader.set(JP, jEnqueue("i-1", USER_TEXT, 0) + "\n", "id-j1");
    h.reader.set(SP, sUser("u1", USER_TEXT) + "\n");
    await h.src.load(JP); // A 装载（配对将走 observe）
    const { s, log } = makeSinks();
    const un1 = h.src.observe(JP, s); // 注册 st-1
    await h.src.load(JP); // B 装载（合法配对：每次成功 load 配对 observe 或 release 二选一）
    const un2 = h.src.observe(JP, s); // 同 sinks 对象再注册 st-2——旧代码直传 sinks：FH Set 按
    expect(un2).not.toBeNull(); // 对象身份，旧 stop 删 S→关掉新绑定→un2 成功但实际已失效。
    // FileHistorySource 同文件共享 watcher（引用计数）：句柄数=1，两条注册各自持 ref。
    expect(h.watcher.active(JP).length).toBe(1);
    expect(h.watcher.active(SP).length).toBe(1);
    // 并行注册语义：重叠期追加→两注册各交付一次（同一 sinks 收两次——网关从不重用 sinks，
    // 此处为端口级语义断言：两条独立注册=两个交付流）
    h.reader.set(JP, jEnqueue("i-1", USER_TEXT, 0) + "\n" + jEnqueue("i-2", "overlap", 0) + "\n", "id-j1");
    h.watcher.notice(JP);
    await until(() => log.appends.filter((r) => (r.event as { intentId?: string }).intentId === "i-2").length === 2);
    // 旧 stop 迟到：只收口 st-1（sinks 集只删 wrap1），st-2 的绑定不受影响（句柄仍活）
    un1?.();
    expect(h.watcher.active(JP).length).toBe(1);
    expect(h.watcher.active(SP).length).toBe(1);
    // st-2 仍活：后续追加恰交付一次（不双送不断流）
    h.reader.set(JP, jEnqueue("i-1", USER_TEXT, 0) + "\n" + jEnqueue("i-2", "overlap", 0) + "\n" + jEnqueue("i-3", "third", 0) + "\n", "id-j1");
    h.watcher.notice(JP);
    await until(() => log.appends.some((r) => (r.event as { intentId?: string }).intentId === "i-3"));
    expect(log.appends.filter((r) => (r.event as { intentId?: string }).intentId === "i-3")).toHaveLength(1);
    // 收口 st-2 + Y1：注册列表空→键删除（状态壳不滞留）；再开需新装载引用（引用纪律）
    un2?.();
    expect(h.watcher.active(JP).length).toBe(0);
    expect(h.watcher.active(SP).length).toBe(0);
    await h.src.load(JP);
    const un3 = h.src.observe(JP, s);
    expect(un3).not.toBeNull();
    un3?.();
    expect(h.watcher.active(JP).length).toBe(0);
    expect(h.watcher.active(SP).length).toBe(0);
    // Y3-02：末尾不再有多余无配对 release（载入已由 observe 配对——多余 release 会制造 carry 噪声）
    expect(h.audits.some((l) => l.includes("release-carry"))).toBe(false);
  });

  it("R1-耗尽：三窗口全换代→有界重试耗尽→load=null+审计 load-revalidate-exhausted", async () => {
    const h = harness({ sessionFor: (f) => f.replace("/j/", "/s/") });
    // session 读改为可控 deferred（arm 后生效——首次装载与 journal-only observe 不挂起）
    let arm = false;
    const held: Array<(v: { text: string; identity: string; fingerprint: string } | Error) => void> = [];
    const baseRead = h.reader.read.bind(h.reader);
    h.reader.read = (p: string) => {
      if (p === SP && arm) {
        return new Promise((res, rej) => { held.push((v) => { if (v instanceof Error) rej(v); else res(v); }); });
      }
      return baseRead(p);
    };
    h.reader.set(JP, jEnqueue("i-1", USER_TEXT, 0) + "\n", "id-j1");
    await h.src.load(JP);
    const { s, log } = makeSinks();
    const stops: Array<() => void> = [];
    stops.push(h.src.observe(JP, s) ?? (() => {})); // 绑定 gen1（journal-only：session 未设）
    h.reader.set(SP, sUser("u1", USER_TEXT) + "\n");
    arm = true;
    const ld = h.src.load(JP);
    // 每轮：窗口内换代+重绑观察（当前活跃代）+通知失效→本轮复核必 stale→下一轮
    for (let round = 2; round <= 4; round++) {
      await until(() => held.length >= 1);
      h.reader.set(JP, jEnqueue(`i-${round}`, "replaced", 0) + "\n", `id-j${round}`);
      stops.push(h.src.observe(JP, s) ?? (() => {})); // 绑定当前活跃代（换代通知可失效）
      h.watcher.notice(JP);
      await until(() => log.invalidates.includes("replace"));
      const settle = held.shift();
      settle?.({ text: sUser("u1", USER_TEXT) + "\n", identity: `id-s${round}`, fingerprint: fnv1a64Hex(sUser("u1", USER_TEXT) + "\n") });
      await drain(8); // 当前轮结算（复核 stale→release→下一轮）
    }
    expect(await ld).toBeNull();
    expect(h.audits.some((l) => l.includes("load-revalidate-exhausted"))).toBe(true);
    for (const st of stops) st();
    await until(() => h.watcher.active(JP).length === 0 && h.watcher.active(SP).length === 0);
  });

  describe("3b2c-fix3——引用守恒单账本（免扣晚附，GPT F3-01/02 反例）", () => {
    it("F3-01：晚附后交错结算（B observe + C release）无 carry；后继 D 双源观察+新行直达", async () => {
      const h = harness({ sessionFor: (f) => f.replace("/j/", "/s/") });
      h.reader.set(JP, jEnqueue("i-1", USER_TEXT, 0) + "\n");
      await h.src.load(JP); // A 装载
      const a = makeSinks();
      const unA = h.src.observe(JP, a.s); // A 观察（journal-only；session 缺）
      // session 出现→B 装载（晚附免扣绑 A；B 的 session 引用待结算）
      h.reader.set(SP, sUser("u1", USER_TEXT) + "\n");
      await h.src.load(JP); // B
      expect(h.audits.some((l) => l.includes("session-attached-late") && l.includes("regs=1"))).toBe(true);
      await h.src.load(JP); // C（另一笔待结算引用——GPT 探针的交错窗口）
      const b = makeSinks();
      const unB = h.src.observe(JP, b.s); // B 走 observe 出口
      h.src.release(JP); // C 走 release 出口
      // 两笔 load 恰被两笔结算配对：无 release-carry（旧 credit 模型在此双扣→carry→后继 session 断流）
      expect(h.audits.some((l) => l.includes("release-carry"))).toBe(false);
      // A/B 全退
      unA?.();
      unB?.();
      await until(() => h.watcher.active(JP).length === 0 && h.watcher.active(SP).length === 0);
      // D 重开：双源观察均建立（旧模型 carry 会吃掉 D 的 session 装载→只剩 journal watcher）
      await h.src.load(JP);
      const d = makeSinks();
      const unD = h.src.observe(JP, d.s);
      expect(unD).not.toBeNull();
      expect(h.watcher.active(JP).length).toBe(1);
      expect(h.watcher.active(SP).length).toBe(1);
      h.reader.set(SP, sUser("u1", USER_TEXT) + "\n" + sUser("u2", "fresh") + "\n");
      h.watcher.notice(SP);
      await until(() => d.log.appends.some((r) => r.source === "session"));
      unD?.();
      await until(() => h.watcher.active(JP).length === 0 && h.watcher.active(SP).length === 0);
      expect(h.audits.some((l) => l.includes("released-unobserved-carry"))).toBe(false);
    });

    it("F3-02：多注册×多 load——晚附双绑定免扣；C/D release 各结算；当前交付双达+后继周期双源", async () => {
      const h = harness({ sessionFor: (f) => f.replace("/j/", "/s/") });
      h.reader.set(JP, jEnqueue("i-1", USER_TEXT, 0) + "\n");
      await h.src.load(JP);
      const a = makeSinks();
      const unA = h.src.observe(JP, a.s);
      await h.src.load(JP);
      const b = makeSinks();
      const unB = h.src.observe(JP, b.s); // 两注册（journal-only）
      // session 出现→C/D 两笔装载→晚附免扣绑 A/B 两注册（regs=2；旧 credit 模型恒记 1 credit）
      h.reader.set(SP, sUser("u1", USER_TEXT) + "\n");
      await Promise.all([h.src.load(JP), h.src.load(JP)]);
      expect(h.audits.some((l) => l.includes("session-attached-late") && l.includes("regs=2"))).toBe(true);
      h.src.release(JP); // C
      h.src.release(JP); // D——两笔引用恰被两笔 release 结算：无 carry
      expect(h.audits.some((l) => l.includes("release-carry"))).toBe(false);
      // 当前交付：session 追加→A/B 各收（GPT 探针 delivery [1,1]）
      h.reader.set(SP, sUser("u1", USER_TEXT) + "\n" + sUser("u2", "both") + "\n");
      h.watcher.notice(SP);
      await until(() => a.log.appends.some((r) => r.source === "session") && b.log.appends.some((r) => r.source === "session"));
      // A/B 全退→后继 E 周期双源（旧模型 carry 会让 E 只剩 journal watcher）
      unA?.();
      unB?.();
      await until(() => h.watcher.active(JP).length === 0 && h.watcher.active(SP).length === 0);
      await h.src.load(JP);
      const e = makeSinks();
      const unE = h.src.observe(JP, e.s);
      expect(unE).not.toBeNull();
      expect(h.watcher.active(SP).length).toBe(1);
      // 后继周期新行交付：session 追加 u6→E 收（晚附链路在新周期仍活）
      h.reader.set(SP, sUser("u1", USER_TEXT) + "\n" + sUser("u2", "both") + "\n" + sUser("u6", "new-cycle") + "\n");
      h.watcher.notice(SP);
      await until(() => e.log.appends.some((r) => r.source === "session" && (r.event as { entryId?: string }).entryId === "u6"));
      unE?.();
      await until(() => h.watcher.active(JP).length === 0 && h.watcher.active(SP).length === 0);
      expect(h.audits.some((l) => l.includes("released-unobserved-carry"))).toBe(false);
    });

    it("F3-02b：多注册×单 load——晚附双绑定免扣；C observe 结算唯一引用；无任何 carry", async () => {
      const h = harness({ sessionFor: (f) => f.replace("/j/", "/s/") });
      h.reader.set(JP, jEnqueue("i-1", USER_TEXT, 0) + "\n");
      await h.src.load(JP);
      const a = makeSinks();
      const unA = h.src.observe(JP, a.s);
      await h.src.load(JP);
      const b = makeSinks();
      const unB = h.src.observe(JP, b.s);
      h.reader.set(SP, sUser("u1", USER_TEXT) + "\n");
      await h.src.load(JP); // C 单笔装载→晚附绑 A/B（regs=2，免扣）
      expect(h.audits.some((l) => l.includes("session-attached-late") && l.includes("regs=2"))).toBe(true);
      const c = makeSinks();
      const unC = h.src.observe(JP, c.s); // C 走 observe 出口结算唯一引用
      expect(unC).not.toBeNull();
      expect(h.audits.some((l) => l.includes("release-carry"))).toBe(false);
      h.reader.set(SP, sUser("u1", USER_TEXT) + "\n" + sUser("u2", "once") + "\n");
      h.watcher.notice(SP);
      await until(() => a.log.appends.some((r) => r.source === "session") && b.log.appends.some((r) => r.source === "session"));
      // C 同样收到本次追加（三条注册=三条交付流）
      await until(() => c.log.appends.some((r) => r.source === "session"));
      // 后继周期：A/B/C 全退后 D 装载+observe→双源句柄重开+新行交付
      unA?.();
      unB?.();
      unC?.();
      await until(() => h.watcher.active(JP).length === 0 && h.watcher.active(SP).length === 0);
      expect(h.audits.some((l) => l.includes("released-unobserved-carry"))).toBe(false);
      h.reader.set(SP, sUser("u1", USER_TEXT) + "\n" + sUser("u2", "once") + "\n" + sUser("u7", "d-cycle") + "\n");
      await h.src.load(JP);
      const dS = makeSinks();
      const unD = h.src.observe(JP, dS.s);
      expect(unD).not.toBeNull();
      expect(h.watcher.active(SP).length).toBe(1);
      h.reader.set(SP, sUser("u1", USER_TEXT) + "\n" + sUser("u2", "once") + "\n" + sUser("u7", "d-cycle") + "\n" + sUser("u8", "d-live") + "\n");
      h.watcher.notice(SP);
      await until(() => dS.log.appends.some((r) => r.source === "session" && (r.event as { entryId?: string }).entryId === "u8"));
      unD?.();
      await until(() => h.watcher.active(JP).length === 0 && h.watcher.active(SP).length === 0);
    });
  });
});

describe("DualHistorySource 3b-3⑤：fingerprints() 元数据面", () => {
  const FP_J1 = () => fnv1a64Hex(jEnqueue("i-1", USER_TEXT, 0) + "\n");
  const FP_S1 = () => fnv1a64Hex(sUser("u1", USER_TEXT) + "\n");
  it("未装载→null；双源活跃→两指纹；journal-only→session=\"\"（契约 §1.3 信息性元数据）", async () => {
    const h = harness({ sessionFor: (f) => f.replace("/j/", "/s/") });
    expect(h.src.fingerprints("/j/a")).toBeNull(); // 无活跃代
    h.reader.set("/j/a", jEnqueue("i-1", USER_TEXT, 0) + "\n");
    h.reader.set("/s/a", sUser("u1", USER_TEXT) + "\n");
    await h.src.load("/j/a");
    expect(h.src.fingerprints("/j/a")).toEqual({ journal: FP_J1(), session: FP_S1() });
    const h2 = harness({ sessionFor: (f) => f.replace("/j/", "/s/") });
    h2.reader.set("/j/a", jEnqueue("i-1", USER_TEXT, 0) + "\n"); // session 缺失
    await h2.src.load("/j/a");
    expect(h2.src.fingerprints("/j/a")).toEqual({ journal: FP_J1(), session: "" }); // journal-only 降级面
  });
});
