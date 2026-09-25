// 切片4c：真 pi 进程端到端（GPT s4c 六项验收）。
// 守卫：默认 skip（防 npm test 每跑真调 LLM）；显式跑=PI_E2E=1 npm run test:e2e。
// 六项映射：①版本证据+启动参数 ②真管道 readiness/背压/双管道排空 ③连续两轮+耐久+通知恰一次
// ④SIGTERM 退役 ⑤SIGKILL 恢复重放（持久会话）+失败尾呈现 ⑥目录耐久职责模式+旧代退出后同会话重组装。
import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, appendFileSync, truncateSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiProcessHost } from "../../apps/server/src/host/process-host.js";
import { FileDurability } from "../../apps/server/src/runtime/file-durability.js";
import { RpcSession } from "../../apps/server/src/runtime/rpc-session.js";
import { readJournalFile, recoverFromJournal } from "../../apps/server/src/runtime/recover.js";
import type { ProcessHandle } from "@pi-agent-ui/protocol";

/** 锁定 pi 可执行（s4c 六项①：绝对路径+版本证据；升级须显式改这里并复跑本套）。 */
const PI_BIN = "/home/yyj/.nvm/versions/node/v24.18.0/bin/pi";
const PI_VERSION_RE = /0\.86\.\d+/;
/** 真实参数面（TECH §24/§40；--no-extensions=受控环境，扩展 UI 面归后续 UI 接线层）。 */
const piArgsFor = (sessionFile: string): string[] => ["--mode", "rpc", "--no-extensions", "--session", sessionFile];

/** 目录耐久（s4c 六项⑥职责模式）：mkdir 后 fsync 目录——journal 首次创建的目录条目耐久归宿主初始化。 */
function ensureDirDurable(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
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
    expect(out).toMatch(PI_VERSION_RE);
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
    cleanups.push(() => s.dispose());
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
    cleanups.push(() => s.dispose());
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
      onSpawned: (h) => {
        curHandle = h;
      },
    });
    cleanups.push(() => s.dispose());
    expect(await s.start()).toMatchObject({ kind: "ready", generation: 1 });

    const l1 = await s.send("请只回复两个字：收到");
    expect(l1.kind).toBe("launched");
    await until(() => settledGens.length === 1, "第一轮 settled（铺垫完整轮）");

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
    const repFix = await readJournalFile(jpath);
    expect(repFix.bad).toEqual([]);

    // 同一会话对象重组装（六项②readiness+连续两轮：服务不重启，世代 2 接管）
    const r2 = await s.start(); // gate closed→reopen→spawn gen2（持久 --session：pi 上下文延续）
    expect(r2).toMatchObject({ kind: "ready", generation: 2 });
    const l3 = await s.send("进程重启过，继续，请只回复：恢复");
    expect(l3.kind).toBe("launched");
    await until(() => settledGens.length === 2, "第三代次首轮 settled");
    // journal 续写（无失败态，append 模式接旧文件）：3 intents，i-2 仍=效果未知，i-3 settled
    const rep3 = await recoverFromJournal(join(dir, "journal.jsonl"), "e2e");
    expect(rep3.intents.map((r) => r.intentId)).toEqual(["i-1", "i-2", "i-3"]);
    expect(rep3.unknownEffect).toEqual(["i-2"]);
    expect(rep3.settledCount).toBe(2);
    expect((await s.stop()) as unknown).toMatchObject({ kind: "confirmed" });
  });
});
