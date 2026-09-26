// 3b-3① 生产组合根受控测试：配置门（fail-closed）+组装生命周期+真升级冒烟。
// 真网络行为只做最小冒烟（403 拒绝/hello 认证/dispose 告别码）；慢客户端矩阵归 ③ real-ws。
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, chmod, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpReq } from "node:http";
import WebSocket from "ws";
import { startServer, type PiAgentUiServer } from "../../../apps/server/src/composition.ts";

const ORIGIN = "http://localhost:5173";
const TOKEN = "tok-3b3a-1";
const CLEANUP: PiAgentUiServer[] = [];

async function mkCfg(extra: Partial<Parameters<typeof startServer>[0]> = {}): Promise<{
  dir: string;
  cfg: Parameters<typeof startServer>[0];
  audits: string[];
}> {
  const dir = await mkdtemp(join(tmpdir(), "comp-3b3a-"));
  const tokenFile = join(dir, "tokens.json");
  await writeFile(tokenFile, JSON.stringify({ version: 1, tokens: [TOKEN] }), { mode: 0o600 });
  await chmod(tokenFile, 0o600);
  const audits: string[] = [];
  const cfg: Parameters<typeof startServer>[0] = {
    tokenFile,
    allowedOrigins: [ORIGIN],
    roots: [dir],
    scanDir: dir,
    tokenPollMs: 0,
    audit: (l) => audits.push(l),
    ...extra,
  };
  return { dir, cfg, audits };
}

async function start(cfg: Parameters<typeof startServer>[0]): Promise<PiAgentUiServer> {
  const s = await startServer(cfg);
  CLEANUP.push(s);
  return s;
}

afterEach(async () => {
  while (CLEANUP.length > 0) {
    const s = CLEANUP.pop();
    if (s) await s.dispose().catch(() => {});
  }
});

describe("3b-3① composition", () => {
  it("空 allowedOrigins/空 roots → 拒绝启动（配置门）", async () => {
    const { cfg } = await mkCfg();
    await expect(startServer({ ...cfg, allowedOrigins: [] })).rejects.toThrow(/allowedOrigins/);
    await expect(startServer({ ...cfg, roots: [] })).rejects.toThrow(/roots/);
  });

  it("tokenFile 缺失/空 tokens → 拒绝启动（fail-closed）", async () => {
    const { cfg } = await mkCfg();
    await expect(startServer({ ...cfg, tokenFile: join(tmpdir(), "no-such-token-file.json") })).rejects.toThrow(/token-file/);
    const { dir } = await mkCfg();
    const emptyTokens = join(dir, "tokens-empty.json");
    await writeFile(emptyTokens, JSON.stringify({ version: 1, tokens: [] }), "utf8");
    await expect(startServer({ ...cfg, tokenFile: emptyTokens })).rejects.toThrow(/empty/);
  });

  it("启动→listen(0) 随机端口→dispose 后端口关闭（生命周期闭合）", async () => {
    const { dir, cfg } = await mkCfg();
    const s = await start(cfg);
    expect(s.port).toBeGreaterThan(0);
    expect(s.host).toBe("127.0.0.1");
    await s.dispose();
    await expect(
      new Promise<never>((_, rej) => {
        const ws = new WebSocket(`ws://127.0.0.1:${s.port}`, { origin: ORIGIN });
        ws.on("open", () => rej(new Error("dispose 后仍可连接")));
        ws.on("error", (e) => rej(e as Error)); // ECONNREFUSED=期望
      }),
    ).rejects.toThrow();
    await rm(dir, { recursive: true, force: true });
  });

  it("Origin 不在白名单 → HTTP 403（upgrade 前拒绝，无 WS）", async () => {
    const { cfg } = await mkCfg();
    const s = await start(cfg);
    const code = await new Promise<number>((resolve, reject) => {
      const req = httpReq({
        host: "127.0.0.1",
        port: s.port,
        path: "/",
        headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", Origin: "http://evil.example" },
      });
      req.on("response", (res) => { resolve(res.statusCode ?? 0); res.resume(); });
      req.on("error", reject);
      req.end();
    });
    expect(code).toBe(403);
  });

  it("真 ws 升级+hello 认证通过+会话列表往返（组装全链冒烟）", async () => {
    const { dir, cfg } = await mkCfg();
    // 造一个合法 journal（首行 header）供 list-sessions 扫到
    await writeFile(join(dir, "s1.jsonl"), `${JSON.stringify({ t: "session-init", sessionId: "sid-1", leafId: "l0", ts: 1, cwd: dir })}\n`, "utf8");
    const s = await start(cfg);
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}`, { origin: ORIGIN });
    const frames: unknown[] = [];
    const closed = new Promise<{ code: number; reason: string }>((res) => {
      ws.on("close", (code, reason) => res({ code, reason: reason.toString("utf8") }));
    });
    await new Promise<void>((res, rej) => { ws.on("open", res); ws.on("error", (e) => rej(e as Error)); });
    ws.on("message", (d) => frames.push(JSON.parse(String(d))));
    ws.send(JSON.stringify({ t: "hello", protocolVersion: 1, token: TOKEN }));
    await new Promise<void>((res) => {
      const t = setInterval(() => {
        if (frames.some((f) => (f as { t?: string }).t === "welcome")) { clearInterval(t); res(); }
      }, 10);
      setTimeout(() => { clearInterval(t); res(); }, 2_000);
    });
    expect(frames.some((f) => (f as { t?: string }).t === "welcome")).toBe(true);
    ws.send(JSON.stringify({ t: "list-sessions", requestId: "ls-1" }));
    await new Promise<void>((res) => {
      const t = setInterval(() => {
        if (frames.some((f) => (f as { t?: string }).t === "sessions")) { clearInterval(t); res(); }
      }, 10);
      setTimeout(() => { clearInterval(t); res(); }, 2_000);
    });
    const sess = frames.find((f) => (f as { t?: string }).t === "sessions") as { sessions?: unknown[] } | undefined;
    expect(Array.isArray(sess?.sessions)).toBe(true);
    // dispose：gateway 先于 adapter——客户端收 1000 "server-shutdown"（应用层告别码）而非 1001
    await s.dispose();
    const closedInfo = await closed;
    expect(closedInfo.code).toBe(1000);
    expect(closedInfo.reason).toBe("server-shutdown");
  });

  it("reloadTokens：写新 token 文件→轮换生效（旧 token 拒新 hello）", async () => {
    const { dir, cfg } = await mkCfg();
    const s = await start(cfg);
    // 轮换：旧 token 移除，新 token 加入
    await writeFile(cfg.tokenFile, JSON.stringify({ version: 1, tokens: ["tok-3b3a-2"] }), "utf8");
    await s.reloadTokens();
    const ws1 = new WebSocket(`ws://127.0.0.1:${s.port}`, { origin: ORIGIN });
    await new Promise<void>((res, rej) => { ws1.on("open", res); ws1.on("error", (e) => rej(e as Error)); });
    const got: unknown[] = [];
    ws1.on("message", (d) => got.push(JSON.parse(String(d))));
    ws1.on("close", () => {});
    ws1.send(JSON.stringify({ t: "hello", protocolVersion: 1, token: TOKEN })); // 旧 token
    ws1.send(JSON.stringify({ t: "hello", protocolVersion: 1, token: "tok-3b3a-2" })); // 新 token（未认证窗口内先后两帧——第一帧 4401 后 close 1008，第二帧到时已关）
    await new Promise<void>((res) => setTimeout(res, 300));
    const errFrames = got.filter((f) => (f as { t?: string }).t === "error");
    expect(errFrames.some((f) => (f as { code?: number }).code === 4401)).toBe(true);
    ws1.close();
    await rm(dir, { recursive: true, force: true });
  });
});
