// P0-2 r1 W-asm-6 E2E：装配面真服务验证（设计稿 §5）。
// 守卫：默认 skip（真调 pi，成本面=3 轮小 prompt）；显式跑=PI_E2E=1 npx vitest run tests/integration/p02-assembly-e2e.test.ts。
// 与单元 W-asm-1..5 分工：单元证组件序；这里证**组合根真实生命周期**——
// A-1 真重启：server1 写轮→dispose（锁释放）→server2 同文件续写→journal 两代 writer 行（epoch 1→2）+两轮业务行共存。
// A-2 双实例活锁拒：server3 持锁在写→server4 同文件写→write-ack gate-failed(enqueue)+零新业务行+审计 lock-held。
// 不重复：stale 死锁/撕裂尾/oath 参数面（单元 W-asm-2/杂项已证）。
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startServer, type PiAgentUiServer } from "../../apps/server/src/composition.ts";

const PI_BIN = "/home/yyj/.nvm/versions/node/v24.18.0/bin/pi";
const PI_VERSION = "0.86.1"; // 与 pi-e2e/ws-write-e2e/composed-e2e 同锁（升级须显式改并复跑四处）
const RUN = process.env.PI_E2E === "1";
const TOKEN = "tok-p02-asm";
const ORIGIN = "http://localhost";

interface Frame { t?: string; requestId?: string; outcome?: { kind: string; stage?: string; intentId?: string }; [k: string]: unknown }
interface JLine { t?: string; intentId?: string; epoch?: number; bootId?: string; [k: string]: unknown }

function until(pred: () => boolean | Promise<boolean>, what: string, ms = 30_000): Promise<void> {
  const t0 = Date.now();
  return new Promise((res, rej) => {
    const tick = () => { Promise.resolve(pred()).then((ok) => {
      if (ok) res(); else if (Date.now() - t0 > ms) rej(new Error(`等待超时：${what}`)); else setTimeout(tick, 100);
    }); };
    tick();
  });
}

const d = describe.skipIf(!RUN)("P0-2 r1 W-asm-6 装配面 E2E（真服务重启+双实例）", () => {
  let dir = "";
  const audits: string[] = [];

  interface Live { server: PiAgentUiServer; ws: WebSocket; frames: Frame[] }
  async function boot(): Promise<Live> {
    const server = await startServer({
      tokenFile: join(dir, "tokens.json"),
      allowedOrigins: [ORIGIN],
      roots: [dir],
      scanDir: dir,
      tokenPollMs: 0,
      write: {
        sessionFor: (f) => join(dir, "sessions", `${f.split("/").pop()}.session`),
        piBin: PI_BIN,
        responseTimeoutMs: 60_000,
        turnTimeoutMs: 120_000,
        readinessTimeoutMs: 20_000,
      },
      audit: (l) => audits.push(l),
    });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`, { origin: ORIGIN });
    await new Promise<void>((res, rej) => { ws.on("open", res); ws.on("error", (e) => rej(e as Error)); });
    const frames: Frame[] = [];
    ws.on("message", (data) => frames.push(JSON.parse(String(data))));
    ws.send(JSON.stringify({ t: "hello", protocolVersion: 1, token: TOKEN }));
    await until(() => frames.some((f) => f.t === "welcome"), "welcome");
    return { server, ws, frames };
  }
  async function shutdown(l: Live | null): Promise<void> {
    try { l?.ws.close(); } catch { /* 已关 */ }
    await l?.server.dispose().catch(() => {});
  }
  async function promptRound(l: Live, file: string, rid: string, text: string): Promise<string> {
    l.ws.send(JSON.stringify({ t: "prompt", requestId: rid, file, text }));
    await until(() => l.frames.some((f) => f.t === "write-ack" && f.requestId === rid), `write-ack ${rid}`, 60_000);
    const ack = l.frames.find((f) => f.t === "write-ack" && f.requestId === rid)!;
    if (ack.outcome?.kind !== "launched") throw new Error(`write-ack 非 launched：${JSON.stringify(ack.outcome)}`);
    const intentId = ack.outcome.intentId!;
    await until(async () => (await readJournal(file)).some((x) => x.t === "settled" && x.intentId === intentId), `settled ${rid}`, 120_000);
    return intentId;
  }
  async function readJournal(file: string): Promise<JLine[]> {
    try {
      const raw = (await readFile(join(dir, file), "utf8")).split("\n").filter((l) => l.length > 0);
      return raw.map((l) => { try { return JSON.parse(l) as JLine; } catch { return { t: "<corrupt>" }; } });
    } catch { return []; }
  }

  beforeAll(async () => {
    const v = spawnSync(PI_BIN, ["--version"], { encoding: "utf8" });
    if (v.status !== 0 || v.stdout.trim() !== PI_VERSION) {
      throw new Error(`pi 版本漂移：期望 ${PI_VERSION}，status=${v.status}，stdout=${JSON.stringify(v.stdout)}`);
    }
    dir = await mkdtemp(join(tmpdir(), "e2e-p02asm-"));
    await mkdir(join(dir, "recovery-evidence"), { recursive: true });
    await mkdir(join(dir, "sessions"), { recursive: true });
    const tokenFile = join(dir, "tokens.json");
    await writeFile600(tokenFile, JSON.stringify({ version: 1, tokens: [TOKEN] }));
  });
  afterAll(async () => { if (dir !== "") await rm(dir, { recursive: true, force: true }).catch(() => {}); });

  it("A-1 真重启续写：两代 writer 行 epoch 1→2+两轮业务行共存+锁文件清", { timeout: 300_000 }, async () => {
    const f1 = "s1.jsonl";
    const l1 = await boot();
    const i1 = await promptRound(l1, f1, "a1-r1", "只回复两个字：收到");
    const ls1 = await readJournal(f1);
    const w1 = ls1.filter((l) => l.t === "writer");
    expect(w1).toHaveLength(1);
    const epoch1 = w1[0]!.epoch, boot1 = w1[0]!.bootId!;
    await shutdown(l1);
    // dispose 序释放锁：锁文件必清（下一实例可装配）；journal 本体留存（两代共存前提）
    expect(ls1.length).toBeGreaterThanOrEqual(4);
    await expect(readFile(join(dir, `${f1}.writer.lock`), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    // 重启（新进程身份）：同文件续写
    const l2 = await boot();
    const i2 = await promptRound(l2, f1, "a1-r2", "只回复三个字：收到了");
    const ls2 = await readJournal(f1);
    const writers = ls2.filter((l) => l.t === "writer");
    expect(writers).toHaveLength(2);
    expect(writers[1]!.epoch).toBe((epoch1 ?? 0) + 1); // INV-2：代次递增
    expect(writers[1]!.bootId).not.toBe(boot1); // 新进程身份
    // 两轮业务行共存（重启不丢旧轮）
    expect(ls2.some((l) => l.t === "settled" && l.intentId === i1)).toBe(true);
    expect(ls2.some((l) => l.t === "settled" && l.intentId === i2)).toBe(true);
    // 审计：两代 ready 行
    expect(audits.some((l) => l.startsWith("guarded-writer ready") && l.includes("epoch=1"))).toBe(true);
    expect(audits.some((l) => l.startsWith("guarded-writer ready") && l.includes("epoch=2"))).toBe(true);
    await shutdown(l2);
  });

  it("A-2 双实例活锁拒：他实例持锁→写 gate-failed(enqueue)+零新业务行", { timeout: 300_000 }, async () => {
    const f2 = "s2.jsonl";
    const l3 = await boot();
    await promptRound(l3, f2, "a2-r1", "只回复两个字：在的"); // server3 装配持锁+一轮业务
    const before = (await readJournal(f2)).length;
    const l4 = await boot(); // 第二实例（同 dir 同 roots）
    const audits4Start = audits.length;
    l4.ws.send(JSON.stringify({ t: "prompt", requestId: "a2-r2", file: f2, text: "只回复两个字：不行" }));
    await until(() => l4.frames.some((f) => f.t === "write-ack" && f.requestId === "a2-r2"), "write-ack a2-r2", 60_000);
    const ack = l4.frames.find((f) => f.t === "write-ack" && f.requestId === "a2-r2")!;
    expect(ack.outcome?.kind).toBe("gate-failed"); // 装配失败=门失败面（帧面身份语义归 r2）
    expect(ack.outcome?.stage).toBe("enqueue");
    // server4 零业务行；server3 旧轮完好
    await until(async () => (await readJournal(f2)).length === before, "journal 零新增", 10_000);
    const ls = await readJournal(f2);
    expect(ls.length).toBe(before);
    // 审计留痕（两处：guarded-writer lock-held + 宿主 gate-failed 细节）
    expect(audits.slice(audits4Start).some((l) => l.startsWith("guarded-writer lock-held"))).toBe(true);
    expect(audits.slice(audits4Start).some((l) => l.startsWith("write-host-gate-failed-detail") && l.includes("writer-lock-held"))).toBe(true);
    await shutdown(l4);
    await shutdown(l3); // 先关后来者再关持有者（顺序无假设，双关）
  });
});

async function writeFile600(p: string, content: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(p, content, { mode: 0o600 });
  await chmod(p, 0o600);
}

export { d };
