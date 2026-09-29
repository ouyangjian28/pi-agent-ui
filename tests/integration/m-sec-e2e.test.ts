// M-SEC 安全扩展实证 E2E（设计稿 docs/m-sec-design.md §4；PI_E2E=1 门）
// 三腿：S1 放行（确认→真执行）/S2 拒绝（取消→block）/S3 超时自答（不答→pi 自答 false→拒绝）。
// 每腿独立 server+会话+probe 目录；S3 env 腿内 set/delete 隔离。
import { mkdtemp, mkdir, writeFile, readdir, rm, readFile, chmod } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { describe, expect, it, afterAll } from "vitest";
import { startServer } from "../../apps/server/src/composition.ts";

const until = async (pred: () => boolean | Promise<boolean>, what: string, ms: number, diag?: () => string): Promise<void> => {
  const t0 = Date.now();
  while (!(await pred())) {
    if (Date.now() - t0 > ms) throw new Error(`等待超时：${what}${diag ? `；${diag()}` : ""}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

interface Frame {
  t?: string; requestId?: string; file?: string; reason?: string; method?: string; title?: string;
  outcome?: { kind?: string; exit?: number }; [k: string]: unknown;
}
const fr = (frames: unknown[]): Frame[] => frames as Frame[];

const RUN = process.env.PI_E2E === "1";
const d = describe.skipIf(!RUN);
const PI_BIN = process.env.PI_BIN ?? "pi";
const ORIGIN = "http://localhost:5173";
const FILE = "m-sec-e2e.jsonl";
const PROBE_ROOT = join(tmpdir(), "m-sec-e2e-probes");
const FIXTURE = join(process.cwd(), "tests/fixtures/m-sec-gate.mjs");

async function makeProbe(name: string): Promise<string> {
  const dir = join(PROBE_ROOT, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "sentinel.txt"), "probe", "utf8");
  return dir;
}
async function exists(path: string): Promise<boolean> {
  try { await readdir(path); return true; } catch { return false; }
}

async function startRig(dir: string, legs: number) {
  const frames: Frame[] = [];
  const audits: string[] = [];
  const tokenFile = join(dir, "tokens.json");
  await writeFile(tokenFile, JSON.stringify({ version: 1, tokens: [`tok-msec-${legs}`] }), "utf8");
  await chmod(tokenFile, 0o600);
  await mkdir(join(dir, "sessions"), { recursive: true });
  // journal 事实源必须在场（D4 批④教训：缺文件 load 整体 null fail-closed→snapshot 不回）
  await writeFile(join(dir, FILE), JSON.stringify({ t: "writer", epoch: 1, bootId: `msec-boot-${legs}`, at: new Date().toISOString() }) + "\n", "utf8");
  const server = await startServer({
    tokenFile,
    allowedOrigins: [ORIGIN],
    roots: [dir],
    scanDir: dir,
    tokenPollMs: 0,
    sessionFor: (f: string) => join(dir, "sessions", `${String(f).split("/").pop()}.session`),
    write: {
      sessionFor: (f: string) => join(dir, "sessions", `${String(f).split("/").pop()}.session`),
      piBin: PI_BIN,
      extraPiArgs: ["--no-extensions", "-e", FIXTURE],
      responseTimeoutMs: 60_000,
      turnTimeoutMs: 120_000,
      readinessTimeoutMs: 20_000,
    },
    audit: (l: string) => { audits.push(l); },
    trustFirstRecoveryCapture: true,
  });
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`, { origin: ORIGIN });
  await new Promise<void>((res, rej) => { ws.on("open", res); ws.on("error", (e) => rej(e as Error)); });
  ws.on("message", (data) => frames.push(JSON.parse(String(data)) as Frame));
  ws.send(JSON.stringify({ t: "hello", protocolVersion: 1, token: `tok-msec-${legs}` }));
  await until(() => fr(frames).some((f) => f.t === "welcome"), "welcome", 30_000);
  ws.send(JSON.stringify({ t: "subscribe", requestId: "sub", file: FILE }));
  await until(() => fr(frames).some((f) => f.t === "snapshot"), "snapshot", 30_000);
  return { server, ws, frames, audits };
}
type Rig = Awaited<ReturnType<typeof startRig>>;

async function sessionText(rig: Rig, dir: string): Promise<string> {
  return readFile(join(dir, "sessions", `${FILE}.session`), "utf8");
}

function diagnose(tag: string, frames: Frame[], dir: string): string {
  const lastMsg = frames.filter((f) => f.t === "events" && Array.isArray((f as { events?: unknown[] }).events))
    .slice(-1).map((f) => {
      const ev = (f as { events: Array<{ kind?: string; role?: string; text?: string }> }).events
        .filter((e) => e.kind === "message");
      return ev.map((e) => `[${e.role}] ${String(e.text).slice(0, 200)}`).join(" | ");
    }).join(" ;; ");
  // 设计稿 §4：区分「模型不配合 vs 管道断」补会话文件 tail（readFile 失败容错）
  let tail = "（无会话文件）";
  try { const t = readFileSync(join(dir, "sessions", `${FILE}.session`), "utf8"); tail = t.split("\n").slice(-4).join(" ⊕ ").slice(0, 400); } catch { /* 未建 */ }
  return `${tag}：最后消息=${lastMsg || "（无）"}；会话 tail=${tail}；帧类=${frames.map((f) => f.t).join(",")}`;
}

async function promptTurn(rig: Rig, text: string, legId: string) {
  rig.ws.send(JSON.stringify({ t: "prompt", requestId: legId, file: FILE, text }));
  await until(() => rig.frames.some((f) => f.t === "write-ack" && f.requestId === legId
    && f.outcome?.kind === "launched"), "write-ack launched", 90_000,
    () => diagnose(`${legId} write-ack 未到`, rig.frames, ""));
}

d("M-SEC 安全扩展实证", () => {
  const dirs: string[] = [];
  const rigs: Rig[] = [];
  afterAll(async () => {
    for (const r of rigs) { try { r.ws.close(); } catch { /* 已关 */ } await r.server.dispose().catch(() => {}); }
    await rm(PROBE_ROOT, { recursive: true, force: true });
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  it("S1 放行链：confirm 确认→命令真执行→审批行 allowed", { timeout: 420_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "msec-s1-")); dirs.push(dir);
    const probe = await makeProbe("s1");
    const rig = await startRig(dir, 1); rigs.push(rig);
    await promptTurn(rig, `这是 E2E 测试。请用 bash 工具精确执行这个命令：rm -rf ${probe}，然后说"done"。`, "s1");
    await until(() => rig.frames.some((f) => f.t === "ui-request" && f.method === "confirm"),
      "ui-request confirm 帧", 90_000, () => diagnose("S1 ui-request 未到（模型未调 bash？）", rig.frames, dir));
    const req = rig.frames.find((f) => f.t === "ui-request" && f.method === "confirm")!;
    rig.ws.send(JSON.stringify({ t: "ui-answer", requestId: req.requestId!, confirmed: true }));
    await until(async () => !(await exists(probe)), "probe 目录被删（命令真执行）", 90_000,
      () => diagnose("S1 probe 未删（命令未执行？）", rig.frames, dir));
    await until(async () => {
      const text = await sessionText(rig, dir).catch(() => "");
      return text.includes("\"customType\":\"m-sec-approval\"") && text.includes("\"decision\":\"allowed\"");
    }, "审批行 allowed", 60_000);
    await until(async () => {
      const text = await sessionText(rig, dir).catch(() => "");
      // K3 P3-1 收紧：toolResult 单锚（pi 真形独立行；旧 OR 形 toolCall 过宽+rm -rf 命中 prompt 自文本=永真面）
      return text.includes("\"type\":\"toolResult\"") && text.includes("rm -rf");
    }, "会话文件含 toolResult 行", 60_000);
  });

  it("S2 拒绝链：confirm 取消→目录仍在→审批行 denied→轮正常收口", { timeout: 420_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "msec-s2-")); dirs.push(dir);
    const probe = await makeProbe("s2");
    const rig = await startRig(dir, 2); rigs.push(rig);
    await promptTurn(rig, `这是 E2E 测试。请用 bash 工具精确执行这个命令：rm -rf ${probe}，无论结果如何然后说"done"。`, "s2");
    await until(() => rig.frames.some((f) => f.t === "ui-request" && f.method === "confirm"),
      "ui-request confirm 帧", 90_000, () => diagnose("S2 ui-request 未到", rig.frames, dir));
    const req = rig.frames.find((f) => f.t === "ui-request" && f.method === "confirm")!;
    rig.ws.send(JSON.stringify({ t: "ui-answer", requestId: req.requestId!, cancelled: true }));
    await until(async () => {
      const text = await sessionText(rig, dir).catch(() => "");
      return text.includes("\"decision\":\"denied\"");
    }, "审批行 denied", 90_000);
    expect(await exists(probe)).toBe(true); // block 证据：目录仍在
    rig.ws.send(JSON.stringify({ t: "stop", requestId: "s2-stop", file: FILE }));
    await until(() => rig.frames.some((f) => f.t === "write-stop-ack" && f.requestId === "s2-stop"), "write-stop-ack（轮收口不挂死）", 60_000);
  });

  it("S3 超时自答链：UI 不答→pi 2s 自答 false→denied→目录仍在+无 ui-closed（现状缺口登记）", { timeout: 420_000 }, async () => {
    process.env.SEC_E2E_CONFIRM_TIMEOUT_MS = "2000";
    try {
      const dir = await mkdtemp(join(tmpdir(), "msec-s3-")); dirs.push(dir);
      const probe = await makeProbe("s3");
      const rig = await startRig(dir, 3); rigs.push(rig);
      await promptTurn(rig, `这是 E2E 测试。请用 bash 工具精确执行这个命令：rm -rf ${probe}，无论结果如何然后说"done"。`, "s3");
      await until(() => rig.frames.some((f) => f.t === "ui-request" && f.method === "confirm"),
        "ui-request confirm 帧", 90_000, () => diagnose("S3 ui-request 未到", rig.frames, dir));
      // UI 不应答：等 pi 侧超时自答（2s）→扩展走拒绝分支→denied 审批行
      await until(async () => {
        const text = await sessionText(rig, dir).catch(() => "");
        return text.includes("\"decision\":\"denied\"");
      }, "超时自答→denied 审批行", 90_000,
        () => diagnose("S3 denied 未到", rig.frames, dir));
      expect(await exists(probe)).toBe(true);
      // 现状缺口（如实断言）：超时后无 ui-closed 帧（pi 不通知 client）
      await new Promise((r) => setTimeout(r, 3000));
      // 缺口哨兵（K3 实现审 P2-1）：宿主 pendingUi 无超时自清（删点仅 answerUi/换代）——修复后此断言须反转为 ui-closed 必达
      expect(rig.frames.some((f) => f.t === "ui-closed")).toBe(false);
      rig.ws.send(JSON.stringify({ t: "stop", requestId: "s3-stop", file: FILE }));
      await until(() => rig.frames.some((f) => f.t === "write-stop-ack" && f.requestId === "s3-stop"), "write-stop-ack（轮收口）", 60_000);
    } finally {
      delete process.env.SEC_E2E_CONFIRM_TIMEOUT_MS;
    }
  });
});
