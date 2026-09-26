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
import { matchKeyOf } from "@pi-agent-ui/protocol";
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
  read(absPath: string): Promise<{ text: string; identity: string }> {
    this.readCalls.push(absPath);
    if (this.failPaths.has(absPath)) return Promise.reject(new Error(`read boom ${absPath}`));
    if (this.holdPaths.has(absPath)) {
      return new Promise((res, rej) => {
        this.heldFns.push(() => {
          const f = this.files.get(absPath);
          if (f === undefined) rej(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
          else res({ text: f.text, identity: f.identity });
        });
      });
    }
    const f = this.files.get(absPath);
    if (f === undefined) return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    return Promise.resolve({ text: f.text, identity: f.identity });
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
    // 任一源盘面换代（identity 变）→invalidate 转发（watch 瞬错=重挂自愈，不产失效——设计面）
    h.reader.set("/s/a", sUser("u1", USER_TEXT) + "\n" + sUser("u2", "second") + "\n", `dev-ino-${Date.now()}`);
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
