// D4 批④ E2E（E-d4-1）：真组合根 entry-get 整链（composition entryAbsFor 注入+DualHistorySource 真扫描
// 装载+网关读链+真 WebSocket）。无真 pi——entry 纯读面（读链不碰 pi 进程）；session 文件手写 fixture
// （pi message 行格式，同批②单测 seeded 模式）。设计稿 v5.1 §5 E2E。
// 腿：1a ok 同形（text+toolCall 块；thinking 门关无 thinking 块；history 事件 blockCount 同源）
//     1b truncated（块级 truncatedAt+wire 无 rawBytes+totalBlockCount 在场）
//     1c 装载后改写行→4414 stale（digest 对账 E2E 面；retryable=true）
//     1d thinkingVisible:true 门开三面同源（entry 帧含 thinking 块+事件 hasThinking===true——独立 server 实例）。
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startServer, type PiAgentUiServer } from "../../apps/server/src/composition.ts";

const ORIGIN = "http://localhost:5173";
const TOKEN = "tok-d4e";
const FILE = "s1.jsonl"; // 逻辑 file（扁平名——网关 file 正则拒目录段）
const SESSION_SUFFIX = ".session";

const until = async (pred: () => boolean, what: string, ms = 10_000): Promise<void> => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

interface Frame {
  t?: string; requestId?: string; entryId?: string; state?: string; code?: number; reason?: string;
  blocks?: Array<Record<string, unknown>>; rawBytes?: number; totalBlockCount?: number; stopReason?: string;
  events?: Array<Record<string, unknown>>; [k: string]: unknown;
}

function msgLine(id: string, role: string, content: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "message", id, parentId: null, timestamp: "2026-10-10T12:00:00.000Z", message: { role, content, ...extra } });
}

/** E2E 装置：真 composition server（write 段自建=entryAbsFor 注入源）+真 ws 客户端+frame 收集。 */
async function makeRig(thinkingVisible = false): Promise<{
  server: PiAgentUiServer; ws: WebSocket; frames: Frame[]; audits: string[];
  sessionAbs: string; dispose(): Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "d4-e2e-"));
  await mkdir(join(dir, "sessions"), { recursive: true });
  const tokenFile = join(dir, "tokens.json");
  await writeFile(tokenFile, JSON.stringify({ version: 1, tokens: [TOKEN] }), "utf8");
  await chmod(tokenFile, 0o600);
  const sessionAbs = join(dir, "sessions", FILE + SESSION_SUFFIX);
  await writeFile(join(dir, FILE), "", "utf8"); // journal=事实源：缺 journal 文件→load 整体 null（fail-closed）——空文件放行
  const audits: string[] = [];
  const server = await startServer({
    tokenFile,
    allowedOrigins: [ORIGIN],
    roots: [dir],
    scanDir: dir,
    tokenPollMs: 0,
    sessionFor: () => sessionAbs, // D4：扫描面 session 子源+entryAbsFor 同源（composition :366 config.sessionFor）
    thinkingVisible: thinkingVisible === true ? true : undefined,
    write: {
      sessionFor: () => sessionAbs,
      piBin: "/home/yyj/.nvm/versions/node/v24.18.0/bin/pi",
    },
    audit: (l) => audits.push(l),
  });
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`, { origin: ORIGIN });
  await new Promise<void>((res, rej) => { ws.on("open", res); ws.on("error", (e) => rej(e as Error)); });
  const frames: Frame[] = [];
  ws.on("message", (data) => frames.push(JSON.parse(String(data)) as Frame));
  ws.send(JSON.stringify({ t: "hello", protocolVersion: 1, token: TOKEN }));
  await until(() => frames.some((f) => f.t === "welcome"), "welcome");
  return {
    server, ws, frames, audits, sessionAbs,
    dispose: async () => {
      ws.close();
      await server.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function subscribe(r: { ws: WebSocket; frames: Frame[] }, requestId: string): Promise<void> {
  r.ws.send(JSON.stringify({ t: "subscribe", requestId, file: FILE }));
  await until(() => r.frames.some((f) => f.t === "snapshot" && f.requestId === requestId), `snapshot ${requestId}`);
}

async function entryGet(r: { ws: WebSocket; frames: Frame[] }, requestId: string, entryId: string): Promise<Frame> {
  r.ws.send(JSON.stringify({ t: "entry-get", requestId, file: FILE, entryId }));
  const want = (f: Frame) => (f.t === "entry" || (f.t === "error" && f.code === 4414)) && f.requestId === requestId;
  await until(() => r.frames.some(want), `entry 终帧 ${requestId}`);
  return r.frames.find(want)!;
}

describe("D4 批④ E-d4-1：真组合根 entry-get 整链（门关实例）", () => {
  let r!: Awaited<ReturnType<typeof makeRig>>;

  beforeAll(async () => {
    r = await makeRig(false);
    await writeFile(r.sessionAbs, [
      msgLine("m1", "assistant", [
        { type: "text", text: "正文第一块" },
        { type: "toolCall", id: "tc-1", name: "bash", arguments: { cmd: "ls -la", apiKey: "sk-secret-abcdef" } },
        { type: "thinking", thinking: "内部推理不应外泄" },
      ], { stopReason: "stop" }),
      msgLine("m2", "assistant", [
        { type: "text", text: "长".repeat(26_000) },
        { type: "text", text: "尾块" },
      ], { stopReason: "length" }),
    ].map((l) => `${l}\n`).join(""), "utf8");
  });

  afterAll(async () => { await r.dispose(); });

  it("E-d4-1a ok 同形：blocks text+toolCall（argsPreview 净化 apiKey）；thinking 门关无 thinking 块；事件 blockCount 同源", async () => {
    await subscribe(r, "sub-1");
    const snap = r.frames.find((f) => f.t === "snapshot")!;
    const m1 = (snap.page as Array<Record<string, unknown>>).find((e) => (e as { entryId?: string }).entryId === "m1");
    expect(m1).toBeDefined();
    expect(m1!.blockCount).toBe(2); // text+toolCall 可见口径（thinking 不计）
    expect("hasThinking" in m1!).toBe(false); // 门关=存在性不泄露
    const f = await entryGet(r, "e1", "m1");
    expect(f.t).toBe("entry");
    expect(f.state).toBe("ok");
    expect(f.rawBytes).toBeGreaterThan(0);
    expect(f.stopReason).toBe("stop");
    const kinds = (f.blocks as Array<Record<string, unknown>>).map((b) => b.kind);
    expect(kinds).toEqual(["text", "toolCall"]); // 门关：thinking 块不产
    const tc = (f.blocks as Array<Record<string, unknown>>)[1]!;
    expect(tc.toolName).toBe("bash");
    expect(String(tc.argsPreview)).toContain("[redacted]"); // denylist E2E 面（apiKey）
    expect(String(tc.argsPreview)).not.toContain("sk-secret");
  });

  it("E-d4-1b truncated：超预算长行→块级 truncatedAt+wire 无 rawBytes+totalBlockCount 在场", async () => {
    const f = await entryGet(r, "e2", "m2");
    expect(f.t).toBe("entry");
    expect(f.state).toBe("truncated");
    expect("rawBytes" in f).toBe(false); // truncated 帧 wire 级缺席
    expect(typeof f.totalBlockCount).toBe("number");
    const blocks = f.blocks as Array<Record<string, unknown>>;
    expect(blocks.some((b) => typeof b.truncatedAt === "number")).toBe(true); // 块级截断标记
  });

  it("E-d4-1c stale：装载后改写行→4414 digest 对账拒（retryable=true）+audit 行", async () => {
    // 改写 m1 行内容（等长前缀替换：正文第一块→正文第二块——行边界不变，digest 必变）
    const text = await import("node:fs/promises").then((m) => m.readFile(r.sessionAbs, "utf8"));
    const rewritten = text.replace("正文第一块", "正文第二块");
    expect(rewritten).not.toBe(text);
    await writeFile(r.sessionAbs, rewritten, "utf8");
    const f = await entryGet(r, "e3", "m1");
    expect(f.t).toBe("error");
    expect(f.code).toBe(4414);
    expect(f.reason).toBe("stale");
    expect(f.retryable).toBe(true);
    expect(r.audits.some((l) => l.includes("entry-get") && l.includes("state=err:4414/stale"))).toBe(true);
  });
});

describe("D4 批④ E-d4-1d：thinkingVisible:true 门开三面同源", () => {
  let r!: Awaited<ReturnType<typeof makeRig>>;

  beforeAll(async () => {
    r = await makeRig(true);
    await writeFile(r.sessionAbs, [
      msgLine("t1", "assistant", [
        { type: "thinking", thinking: "推理过程可见" },
        { type: "text", text: "答案" },
      ], { stopReason: "stop" }),
    ].map((l) => `${l}\n`).join(""), "utf8");
  });

  afterAll(async () => { await r.dispose(); });

  it("门开：entry 帧含 thinking 块（前置）+事件 hasThinking===true（扫描面同源）", async () => {
    await subscribe(r, "sub-1");
    const snap = r.frames.find((f) => f.t === "snapshot")!;
    const t1 = (snap.page as Array<Record<string, unknown>>).find((e) => (e as { entryId?: string }).entryId === "t1");
    expect(t1!.hasThinking).toBe(true); // 扫描面
    expect(t1!.blockCount).toBe(1); // 可见口径=text 一块
    const f = await entryGet(r, "e1", "t1");
    expect(f.t).toBe("entry");
    const kinds = (f.blocks as Array<Record<string, unknown>>).map((b) => b.kind);
    expect(kinds).toEqual(["thinking", "text"]); // entry 面含 thinking 块（门开）
    expect((f.blocks as Array<Record<string, unknown>>)[0]!.text).toBe("推理过程可见");
  });
});
