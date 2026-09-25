// 切片4c：真 pi 进程端到端（GPT s4c 六项验收）。
// 守卫：默认 skip（防 npm test 每跑真调 LLM）；显式跑=PI_E2E=1 npm run test:e2e。
// 六项映射：①版本证据+启动参数 ②真管道 readiness/背压/双管道排空 ③连续两轮+耐久+通知恰一次
// ④SIGTERM 退役 ⑤SIGKILL 恢复重放（持久会话）+失败尾呈现 ⑥目录耐久职责模式+旧代退出后同会话重组装。
import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, appendFileSync, truncateSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PiProcessHost } from "../../apps/server/src/host/process-host.js";
import { FileDurability } from "../../apps/server/src/runtime/file-durability.js";
import { RpcSession } from "../../apps/server/src/runtime/rpc-session.js";
import { readJournalFile, recoverFromJournal } from "../../apps/server/src/runtime/recover.js";
import { ProcessSupervisor, type SupervisorCoordinatorPort, type SupervisorGatePort } from "@pi-agent-ui/protocol";
import type { ProcessHandle } from "@pi-agent-ui/protocol";

/** 锁定 pi 可执行（s4c 六项①：绝对路径+版本证据；s4e：exact 版本锁非前缀匹配——升级须显式改这里并复跑本套）。 */
const PI_BIN = "/home/yyj/.nvm/versions/node/v24.18.0/bin/pi";
const PI_VERSION = "0.86.1";
/** 真实参数面（TECH §24/§40；--no-extensions=受控环境，扩展 UI 面归后续 UI 接线层）。 */
const piArgsFor = (sessionFile: string): string[] => ["--mode", "rpc", "--no-extensions", "--session", sessionFile];

/** 目录耐久（s4c 六项⑥+s4e R3+s4f 口径收窄）：mkdir 后 fsync dir+parent 两层（非任意递归——
 *  更深新建祖先目录的条目耐久归宿主部署；journal 新建文件名的耐久由 FileDurability 首写后 syncDir 承担）。 */
function ensureDirDurable(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const parent = dirname(dir);
  for (const d of [dir, parent]) {
    const fd = openSync(d, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}

/** s4g：本轮 assistant 完成消息正文提取——只取 message_end 事件中 role==="assistant"
 *  且 content[].type==="text" 的文本段拼接（排除 user 输入/历史聚合/thinking 段/其它字段）。 */
function assistantBodyText(ev: unknown): string {
  if (typeof ev !== "object" || ev === null) return "";
  const e = ev as { type?: unknown; message?: { role?: unknown; content?: unknown } | null };
  if (e.type !== "message_end") return "";
  if (typeof e.message !== "object" || e.message === null || e.message.role !== "assistant") return "";
  const c = e.message.content;
  if (!Array.isArray(c)) return "";
  let out = "";
  for (const part of c) {
    if (typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text") {
      out += typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "";
    }
  }
  return out;
}

async function until(cond: () => boolean, what: string, timeoutMs = 90_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const dirs: string[] = [];
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await Promise.resolve(c()).catch(() => undefined);
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const running = process.env.PI_E2E === "1";

describe.skipIf(!running)("真 pi E2E（切片4c）", () => {
  beforeAll(() => {
    // 六项①版本证据：spawn 真二进制取 --version（证据随测试输出留档）。pi 是 node 脚本→shebang
    // /usr/bin/env node 需 PATH 含 node bin 目录（运行 vitest 的 shell 已含；此处再显式注入）。guard
    const v = spawnSync(PI_BIN, ["--version"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${join(PI_BIN, "..")}:${process.env.PATH ?? ""}` },
    });
    expect(v.status).toBe(0);
    const out = `${v.stdout}${v.stderr}`;
    console.log(`[e2e] pi 二进制=${PI_BIN} --version=${out.trim()}`);
    expect(out.trim()).toBe(PI_VERSION); // s4e①：exact 版本锁（前缀匹配会放行任意补丁版）
  });

  it("e2e-1 真管道 readiness 往返+SIGTERM 退役退出确认（六项①②④）", { timeout: 60_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "e2e1-"));
    dirs.push(dir);
    ensureDirDurable(dir);
    const host = new PiProcessHost({ piBin: PI_BIN });
    const dur = new FileDurability(join(dir, "journal.jsonl"));
    const s = new RpcSession({
      piArgs: piArgsFor(join(dir, "session.jsonl")),
      journalPath: join(dir, "journal.jsonl"),
      sessionId: "e2e",
      host,
      durability: dur,
      readinessTimeoutMs: 15_000,
    });
    // s4e Y-C2：异常路径也不留真 pi 子进程——running 则先退役确认退出，再 dispose
    cleanups.push(async () => {
      if ((s.getState().supervisor as { phase: string }).phase === "running") await s.stop().catch(() => undefined);
      await s.dispose();
    });
    const r = await s.start();
    expect(r).toMatchObject({ kind: "ready", generation: 1 }); // 真实 get_state 往返（受控面探针=生产同一条路径）
    const stop = await s.stop(); // SIGTERM→真实退出→exit 事件=唯一退出证据
    expect(stop).toMatchObject({ kind: "confirmed" });
    // 探针不入账本：start/stop 无 append → journal 文件未创建（惰性打开）
    expect(existsSync(join(dir, "journal.jsonl"))).toBe(false);
    await s.dispose();
  });

  it("e2e-2 连续两轮：prompt 帧+受理+settled 耐久+通知恰一次+真实事件流（六项②③）", { timeout: 180_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "e2e2-"));
    dirs.push(dir);
    ensureDirDurable(dir);
    const settledGens: number[] = [];
    const eventTypes = new Set<string>();
    const host = new PiProcessHost({ piBin: PI_BIN });
    const dur = new FileDurability(join(dir, "journal.jsonl"));
    const s = new RpcSession({
      piArgs: piArgsFor(join(dir, "session.jsonl")),
      journalPath: join(dir, "journal.jsonl"),
      sessionId: "e2e",
      host,
      durability: dur,
      readinessTimeoutMs: 15_000,
      responseTimeoutMs: 30_000,
      turnTimeoutMs: 120_000,
      timeoutPollMs: 100,
      onPiEvent: (ev) => {
        const t = (ev as { type?: unknown }).type;
        if (typeof t === "string") eventTypes.add(t);
      },
      onSettled: (g) => settledGens.push(g),
    });
    // s4e Y-C2：异常路径也不留真 pi 子进程——running 则先退役确认退出，再 dispose
    cleanups.push(async () => {
      if ((s.getState().supervisor as { phase: string }).phase === "running") await s.stop().catch(() => undefined);
      await s.dispose();
    });
    expect(await s.start()).toMatchObject({ kind: "ready" });

    const l1 = await s.send("请只回复两个字：收到");
    expect(l1.kind).toBe("launched");
    await until(() => settledGens.length === 1, "第一轮 settled 通知");
    expect(settledGens).toEqual([1]); // 恰一次
    await until(() => (s.getState().gate as { kind: string }).kind === "idle", "gate idle（新轮可发）");

    const l2 = await s.send("再只回复两个字：明白");
    expect(l2.kind).toBe("launched");
    await until(() => settledGens.length === 2, "第二轮 settled 通知");
    expect(settledGens).toEqual([1, 1]);

    // 真实事件流证据（六项②双管道排空）：非 response/agent_settled 之外至少见过 agent 事件
    expect([...eventTypes].some((t) => t.startsWith("agent_") && t !== "agent_settled")).toBe(true);

    // journal 耐久（六项③）：两轮 enqueue/sending/settled 全落盘，重放=两轮已结算、无效果未知
    const rep = await recoverFromJournal(join(dir, "journal.jsonl"), "e2e");
    expect(rep.bad).toEqual([]);
    expect(rep.intents).toHaveLength(2);
    expect(rep.settledCount).toBe(2);
    expect(rep.unknownEffect).toEqual([]);
    expect(rep.resumable).toEqual([]);
    expect((await s.stop()) as unknown).toMatchObject({ kind: "confirmed" });
  });

  it("e2e-3 SIGKILL 意外退出→同会话重组装→恢复重放呈现→撕裂尾识别（六项②⑤）", { timeout: 180_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "e2e3-"));
    dirs.push(dir);
    ensureDirDurable(dir);
    const settledGens: number[] = [];
    // s4g 证据补齐：口令化+**限定 assistant 正文**——从 message_end 事件取 role==="assistant"
    // 且 content[].type==="text" 的文本段（排除 user 输入/历史聚合/thinking 段/其它字段；谓词负例见文件尾受控 describe）。
    // gen1 捕获 assistant 确实回了口令，gen2 追问后回复同一口令=--session 历史恢复直接证据（两代正文一致）。
    const TOKEN = "PENGUIN-42";
    const gen1Hits: string[] = [];
    const gen2Hits: string[] = [];
    let curHandle: ProcessHandle | null = null;
    const host = new PiProcessHost({ piBin: PI_BIN });
    const dur = new FileDurability(join(dir, "journal.jsonl"));
    const s = new RpcSession({
      piArgs: piArgsFor(join(dir, "session.jsonl")), // 持久会话：kill 后 pi 侧上下文仍在（六项⑤）
      journalPath: join(dir, "journal.jsonl"),
      sessionId: "e2e",
      host,
      durability: dur,
      readinessTimeoutMs: 15_000,
      responseTimeoutMs: 30_000,
      turnTimeoutMs: 120_000,
      timeoutPollMs: 100,
      onSettled: (g) => settledGens.push(g),
      onPiEvent: (ev, gen) => {
        const text = assistantBodyText(ev); // 只取本轮 assistant 完成消息正文（s4g：事件整体含 TOKEN 不算证据）
        if (text.includes(TOKEN)) {
          if (gen === 1) gen1Hits.push(text);
          if (gen === 2) gen2Hits.push(text);
        }
      },
      onSpawned: (h) => {
        curHandle = h;
      },
    });
    // s4e Y-C2：异常路径也不留真 pi 子进程——running 则先退役确认退出，再 dispose
    cleanups.push(async () => {
      if ((s.getState().supervisor as { phase: string }).phase === "running") await s.stop().catch(() => undefined);
      await s.dispose();
    });
    expect(await s.start()).toMatchObject({ kind: "ready", generation: 1 });

    const l1 = await s.send(`请只回复这个口令，不要任何其它文字：${TOKEN}`);
    expect(l1.kind).toBe("launched");
    await until(() => settledGens.length === 1, "第一轮 settled（铺垫完整轮）");
    await until(() => gen1Hits.length > 0, "第一轮 assistant 正文含口令（捕获实际答案）");

    // 第二轮进行中注入真实 SIGKILL（六项⑤：kill -9 = 意外退出，非退役路径）
    const l2 = await s.send("这条消息会被进程死亡打断，请只回复：打断");
    expect(l2.kind).toBe("launched");
    if (curHandle === null) throw new Error("onSpawned 未触发（拿不到进程句柄）");
    host.stop(curHandle, "SIGKILL");
    await until(() => (s.getState().gate as { kind: string }).kind === "closed", "gate closed（意外退出→世代退役）");
    await until(() => (s.getState().supervisor as { phase: string }).phase === "idle", "supervisor idle（意外退出收口）");

    // 恢复重放（六项⑤）：第一轮=settled；第二轮=sending 无终态→效果未知（不谎报成功/失败）
    const rep = await recoverFromJournal(join(dir, "journal.jsonl"), "e2e");
    expect(rep.intents).toHaveLength(2);
    expect(rep.settledCount).toBe(1);
    expect(rep.unknownEffect).toEqual(["i-2"]); // 打断的一轮=效果未知（宿主保守呈现面）
    expect(rep.intents[1]?.sending).toBe(true);

    // 撕裂尾呈现（六项⑤）：手动补一段无换行半行→partialTail 识别、好行不受影响
    appendFileSync(join(dir, "journal.jsonl"), '{"t":"settled","intentId":"i-2"');
    const rep2 = await readJournalFile(join(dir, "journal.jsonl"));
    expect(rep2.lines).toHaveLength(rep.lines.length); // 好行数量不变
    expect(rep2.bad).toHaveLength(1);
    expect(rep2.bad[0]?.partialTail).toBe(true);

    // 失败尾修复（六项⑤宿主流程）：撕裂尾=写入中断面，须截到最后一个完整行边界才允许续写。
    // 本会话 durability 无失败态（撕裂为外部注入非 append 失败）→截尾即完成；append 失败态另须 markRepaired。
    const jpath = join(dir, "journal.jsonl");
    // 字节陷阱：lastIndexOf/truncate 均须用字节索引（rawText 含中文，字符数≠字节数，
    // 拿字符位置 truncate 会截在中途再造撕裂——readFile 不带 utf8 即 Buffer）
    const buf3 = await readFile(jpath);
    truncateSync(jpath, buf3.lastIndexOf(0x0a) + 1); // 半行丢弃（其效果未知已由重放呈现承载）
    // s4e R3：截尾修复=盘面变更，续写授权前同步文件（大小+数据耐久）；ftruncate 后 fsync
    const fd3 = openSync(jpath, "r+");
    try {
      fsyncSync(fd3);
    } finally {
      closeSync(fd3);
    }
    const repFix = await readJournalFile(jpath);
    expect(repFix.bad).toEqual([]);

    // 同一会话对象重组装（六项②readiness+连续两轮：服务不重启，世代 2 接管）
    const r2 = await s.start(); // gate closed→reopen→spawn gen2（持久 --session：pi 上下文延续）
    expect(r2).toMatchObject({ kind: "ready", generation: 2 });
    // s4e⑤+s4f：pi 侧会话历史恢复的直接证据——第三轮追问第一轮口令，gen2 回复同一口令（两代正文一致；上下文丢失则答不出）
    const l3 = await s.send("我第一轮请你回复过一个口令，那个口令是什么？只回口令本身。");
    expect(l3.kind).toBe("launched");
    await until(() => settledGens.length === 2, "第三代次首轮 settled");
    expect(gen1Hits.length).toBeGreaterThan(0); // gen1 实际答案已捕获（非零证据）
    expect(gen2Hits.length).toBeGreaterThan(0); // gen2 回复同一口令=历史延续直接证据
    // journal 续写（无失败态，append 模式接旧文件）：3 intents，i-2 仍=效果未知，i-3 settled
    const rep3 = await recoverFromJournal(join(dir, "journal.jsonl"), "e2e");
    expect(rep3.intents.map((r) => r.intentId)).toEqual(["i-1", "i-2", "i-3"]);
    expect(rep3.unknownEffect).toEqual(["i-2"]);
    expect(rep3.settledCount).toBe(2);
    expect((await s.stop()) as unknown).toMatchObject({ kind: "confirmed" });
  });

  // ---- s4e 六项②补强：受控 node 子进程真管道证据（无 LLM 费用） ----

  it("e2e-4 真子进程背压：4MB 写在子进程读前挂起（write false→等 cb），读后兑现且字节完整（六项②）", { timeout: 30_000 }, async () => {
    const host = new PiProcessHost({ piBin: process.execPath });
    // 128KB 实测一写即交（内核管道缓冲+libuv 队列），不足以证背压；4MB>全部缓冲面→write 返回 false→cb 等子进程真实消费
    const script = `
      process.stdin.pause();
      process.stdout.write('{"type":"ready"}\\n');
      let got = 0;
      setTimeout(() => {
        process.stdin.on("data", (c) => { got += c.length; });
        process.stdin.resume();
        setTimeout(() => { process.stdout.write(JSON.stringify({type:"count", got}) + "\\n"); process.exit(0); }, 400);
      }, 400);
    `;
    const events: Array<{ type?: string; got?: number }> = [];
    const h = host.spawn(["-e", script], { onEvent: (e) => events.push(e as { type?: string; got?: number }), onStderr: () => {}, onExit: () => {} });
    cleanups.push(() => host.stop(h, "SIGKILL")); // s4f：断言中途失败不留子进程
    await until(() => events.some((e) => e.type === "ready"), "ready 事件（背压前置）", 10_000);
    const big = "x".repeat(4 * 1024 * 1024) + "\n"; // 4MB+1B
    let resolved = false;
    let err: unknown = null;
    const t0 = Date.now();
    const p = host.writeStdin(h, big).then(
      () => {
        resolved = true;
      },
      (e) => {
        err = e;
      },
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(resolved).toBe(false); // 子进程未读：写未确认（真管道背压——cb 等真实消费）
    await p;
    expect(err).toBe(null);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250); // 确实等了子进程开始读
    await until(() => events.some((e) => e.type === "count"), "子进程计数报告", 10_000);
    expect(events.find((e) => e.type === "count")?.got).toBe(4 * 1024 * 1024 + 1); // 字节完整（背压不丢）
  });

  it("e2e-5 双管道排空：stdout+stderr 各超管道容量，两泵都排→子进程正常退出（任一不排空则死锁）", { timeout: 30_000 }, async () => {
    const host = new PiProcessHost({ piBin: process.execPath });
    // 注意：同步写完立即 process.exit 会丢未 flush 的异步写（实测丢半）→写完等回调齐+宽限再退
    const script = `
      const c = "y".repeat(65536);
      let done = 0;
      const fin = () => { if (++done === 8) setTimeout(() => process.exit(0), 200); };
      for (let i = 0; i < 4; i++) { process.stdout.write(c + "\\n", fin); process.stderr.write("E" + c + "\\n", fin); }
    `;
    const stderrLines: string[] = [];
    let exited = false;
    let exitCode: number | null = null;
    const h = host.spawn(["-e", script], {
      onEvent: () => {},
      onStderr: (t) => stderrLines.push(t),
      onExit: (c) => {
        exited = true;
        exitCode = c;
      },
    });
    cleanups.push(() => host.stop(h, "SIGKILL")); // s4f：断言中途失败不留子进程
    await until(() => exited, "子进程退出（任一管道不排空都会阻塞子进程写→死锁→超时）", 15_000);
    expect(exitCode).toBe(0);
    // s4f：分通道断言（合计≥8 会放行 7+1）——stdout 泵转送=「[stdout-nonjson] 前缀+原文」；stderr 泵=原文「E+64KB」。
    // 每通道恰 4 条且长度恒定（65536+换行内容完整不截）。
    const viaStdoutPump = stderrLines.filter((l) => l.startsWith("[stdout-nonjson] "));
    const viaStderrPump = stderrLines.filter((l) => l.startsWith("E"));
    expect(viaStdoutPump).toHaveLength(4);
    expect(viaStderrPump).toHaveLength(4);
    expect(viaStdoutPump.every((l) => l.length === "[stdout-nonjson] ".length + 65536)).toBe(true); // 行文本不含换行
    expect(viaStderrPump.every((l) => l.length === 65537)).toBe(true); // "E"+y×65536（拆行后不含换行）
  });

  it("e2e-6 旧代迟到输出不污染新代：真子进程退役前后输出只归因自己代次（六项⑥）", { timeout: 30_000 }, async () => {
    const scriptA = `
      process.stdout.write('{"type":"e","ev":"gen1-first"}\\n');
      process.on("SIGTERM", () => {
        // s4f：写完回调再退（process.exit 会丢未 flush 异步写）——gen1-late 必达，迟到证据非 best-effort
        process.stdout.write('{"type":"e","ev":"gen1-late"}\\n', () => process.exit(0));
      });
      setInterval(() => {}, 1000);
    `;
    const scriptB = `
      process.stdout.write('{"type":"e","ev":"gen2-first"}\\n');
      setInterval(() => {}, 1000);
    `;
    const routed: Array<{ ev: unknown; gen: number }> = [];
    const audits: string[] = [];
    const host = new PiProcessHost({ piBin: process.execPath });
    const coordinator = {
      submitTurn: async () => ({ kind: "rejected", stage: "enqueue" as const }),
      onGenerationRetired: () => ({ clearedCommands: 0, clearedEvents: 0 }),
      getState: () => ({ command: null }),
    } as unknown as SupervisorCoordinatorPort;
    const gate = {
      getState: () => ({ kind: "idle" as const }),
      close: () => {},
    } as unknown as SupervisorGatePort;
    const sup = new ProcessSupervisor({
      host,
      coordinator,
      gate,
      now: () => new Date().toISOString(),
      nowMs: () => performance.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      audit: (l) => audits.push(l),
      onProcessEvent: (ev, gen) => routed.push({ ev, gen }),
    });
    // s4g：清理注册提前到首次 spawn 前（scriptA 有 setInterval 常驻——等待首事件超时/首个 retire 断言失败
    // 的窗口也不能留子进程；旧版到 scriptB spawn 后才登记）。
    cleanups.push(async () => {
      const st = sup.getState() as { phase: string };
      if (st.phase !== "idle") await sup.retireCurrent().catch(() => undefined);
    });
    expect(sup.spawnNext(["-e", scriptA]).kind).toBe("spawned");
    await until(() => routed.some((x) => x.gen === 1), "gen1 首事件", 10_000);
    const ret = await sup.retireCurrent(); // SIGTERM→子进程 handler 写完 late 行才退→确认
    expect(ret).toMatchObject({ kind: "confirmed" });
    expect(sup.spawnNext(["-e", scriptB]).kind).toBe("spawned");
    await until(() => routed.some((x) => x.gen === 2), "gen2 首事件", 10_000);
    // 不污染断言：gen1 迟到输出只归因 gen1（stopping 期合法路由或 retired 丢弃），gen2 只见自己事件。
    // s4f：gen1-late 为强制迟到（SIGTERM handler 写完回调才 exit）——非空迟到证据非 best-effort。
    const gen1Evs = routed.filter((x) => x.gen === 1).map((x) => (x.ev as { ev?: string }).ev);
    expect(gen1Evs).toContain("gen1-late"); // 迟到行必达（写完回调才退）
    expect(gen1Evs.every((e) => e === "gen1-first" || e === "gen1-late")).toBe(true);
    expect(routed.filter((x) => x.gen === 2).map((x) => (x.ev as { ev?: string }).ev)).toEqual(["gen2-first"]);
    expect(audits.some((l) => l.includes("generation-retired"))).toBe(true);
    expect(await sup.retireCurrent()).toMatchObject({ kind: "confirmed" });
  });
});


// s4g：e2e-3 命中谓词的受控负例（不依赖真 LLM；PI_E2E 守卫外始终跑）——
// 「仅 user/元数据含 TOKEN、assistant 正文不含」必须不命中（旧 stringify(ev).includes 会假命中）。
describe("assistantBodyText 命中谓词（受控）", () => {
  const TOKEN = "PENGUIN-42";
  const userEv = { type: "message_end", message: { role: "user", content: [{ type: "text", text: `请只回复这个口令：${TOKEN}` }] } };
  const assistantEv = { type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "内含口令思考" }, { type: "text", text: TOKEN }] } };
  const assistantNoToken = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "别的回答" }] } };

  it("user 消息含 TOKEN（assistant 不含）→不命中（旧版事件整体匹配会假命中）", () => {
    expect(assistantBodyText(userEv).includes(TOKEN)).toBe(false);
    expect(assistantBodyText({ ...userEv, message: { ...userEv.message, role: "assistant", content: [{ type: "text", text: "别的回答" }] } }).includes(TOKEN)).toBe(false);
  });

  it("assistant 正文含 TOKEN（thinking 段口令不计，只认 text 段）→命中", () => {
    const t = assistantBodyText(assistantEv);
    expect(t.includes(TOKEN)).toBe(true);
    expect(assistantBodyText(assistantNoToken).includes(TOKEN)).toBe(false);
  });

  it("非 message_end / 非 assistant / content 非数组→空串", () => {
    expect(assistantBodyText({ type: "message_update" })).toBe("");
    expect(assistantBodyText({ type: "message_end", message: { role: "system", content: [] } })).toBe("");
    expect(assistantBodyText({ type: "message_end", message: { role: "assistant", content: null } })).toBe("");
  });

  it("e2e-7（切片5①）：闲置到期→真 EOF 自然退出（code 0）→send 冷启动 gen2 原会话续跑", { timeout: 180_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "e2e7-"));
    dirs.push(dir);
    ensureDirDurable(dir);
    const audits: string[] = [];
    const settledGens: number[] = [];
    const host = new PiProcessHost({ piBin: PI_BIN });
    const dur = new FileDurability(join(dir, "journal.jsonl"));
    const s = new RpcSession({
      piArgs: piArgsFor(join(dir, "session.jsonl")),
      journalPath: join(dir, "journal.jsonl"),
      sessionId: "e2e",
      host,
      durability: dur,
      readinessTimeoutMs: 15_000,
      timeoutPollMs: 100,
      idleMs: 2_500,
      eofGraceMs: 5_000,
      audit: (l) => audits.push(l),
      onSettled: () => settledGens.push(1),
    });
    cleanups.push(async () => {
      if ((s.getState().supervisor as { phase: string }).phase === "running") await s.stop().catch(() => undefined);
      await s.dispose();
    });
    const r1 = await s.start();
    expect(r1).toMatchObject({ kind: "ready", generation: 1 });
    const l1 = await s.send("请只回复：OK");
    expect(l1.kind).toBe("launched");
    await until(() => settledGens.length === 1, "第一轮 settled（双条件之一成立）");
    await until(() => audits.some((l) => l.includes("idle-reap-start")), "闲置到期触发回收", 20_000);
    await until(() => audits.some((l) => l.includes("idle-reap-done kind=confirmed")), "真 EOF 自然退出+回收确认", 20_000);
    expect((s.getState().supervisor as { phase: string }).phase).toBe("idle");
    expect(audits.some((l) => l.includes("process-retire-eof-timeout"))).toBe(false); // EOF 宽限内真退（未升级信号）
    // s5 首审补强：回收=真自然退出的结构证据（idle-reap-done exitCode=0）+会话文件跨代持久增长
    const reapDone = audits.filter((l) => l.includes("idle-reap-done"));
    expect(reapDone).toHaveLength(1);
    expect(reapDone[0]).toContain("kind=confirmed");
    expect(reapDone[0]).toContain("exitCode=0"); // EOF 自然退出（SIGTERM/SIGKILL 路径 signal 非空、code 多为 null）
    const sessionFile = join(dir, "session.jsonl");
    const sizeAfterGen1 = (await stat(sessionFile)).size;
    expect(sizeAfterGen1).toBeGreaterThan(0); // 第一代已有会话历史落盘
    // 回收≠销毁+journal 保留：send=明确申请执行→冷启动 gen2（原会话文件）→新一轮真往返
    const l2 = await s.send("请只回复：DONE");
    expect(l2.kind).toBe("launched");
    expect((s.getState().supervisor as { generation: number }).generation).toBe(2);
    await until(() => settledGens.length === 2, "冷启动第二轮 settled", 120_000);
    // s5 首审补强：gen2 仍接同一 --session 文件（持久身份）且历史继续增长（原上下文未被丢）
    const sizeAfterGen2 = (await stat(sessionFile)).size;
    expect(sizeAfterGen2).toBeGreaterThan(sizeAfterGen1);
    // s5c 报告 §7 补强：第一代唯一标记在回收+冷启动后仍完整存在于会话文件（持久历史保存）。
    // 口径注意：这是持久历史证据，不等同于「第二代内存上下文确已加载」——后者须等②只读
    // 历史读取口（get_messages 面）接入后方可断言；本例不冒充该结论。
    const gen1Marker = "OK-GEN1";
    const l1m = await s.send(`请只回复这个标记：${gen1Marker}`);
    expect(l1m.kind).toBe("launched");
    await until(() => settledGens.length === 3, "标记轮 settled", 120_000);
    const sessionText = await readFile(sessionFile, "utf8");
    expect(sessionText).toContain(`请只回复这个标记：${gen1Marker}`); // 用户指令原文入会话历史（第一代上下文留痕）
    const rep = await recoverFromJournal(join(dir, "journal.jsonl"), "e2e");
    expect(rep.bad).toEqual([]);
    expect(rep.intents).toHaveLength(3); // 两代三轮（含标记轮）
    expect(rep.settledCount).toBe(3);
    expect((await s.stop()) as unknown).toMatchObject({ kind: "confirmed" });
  });

  it("s4h 补：thinking-only（content 只有 thinking 段含口令）→不命中；metadata-only（message_update 带 metadata 含口令）→不命中", () => {
    const thinkingOnly = { type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: `口令思考 ${TOKEN}` }] } };
    expect(assistantBodyText(thinkingOnly)).toBe(""); // 无 text 段→空串→不命中
    const metaOnly = { type: "message_update", metadata: { text: TOKEN } };
    expect(assistantBodyText(metaOnly)).toBe(""); // 非 message_end→空串→不命中（旧版 stringify 整体匹配会假命中）
  });
});
