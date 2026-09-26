// 3b-3① 生产组合根受控测试：配置门（fail-closed）+组装生命周期+真升级冒烟。
// 真网络行为只做最小冒烟（403 拒绝/hello 认证/dispose 告别码）；慢客户端矩阵归 ③ real-ws。
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, chmod, writeFile, rm } from "node:fs/promises";
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
  describe("R-04 配置门（非法数值/路径/Origin → 拒绝启动）", () => {
    it("maxScanBytes：NaN/±Infinity/负数/分数/超 1GiB → 拒绝启动", async () => {
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 0.5, 1024 * 1024 * 1024 + 1]) {
        const { cfg } = await mkCfg({ maxScanBytes: bad });
        await expect(startServer(cfg)).rejects.toThrow("maxScanBytes 非法");
      }
    });
    it("tokenPollMs：负数/分数/超定时器上限 → 拒绝启动；0 与合法正值 → 接受", async () => {
      for (const bad of [-1, 0.5, 2_147_483_648]) {
        const { cfg } = await mkCfg({ tokenPollMs: bad });
        await expect(startServer(cfg)).rejects.toThrow("tokenPollMs 非法");
      }
      // 0=禁用轮询合法（默认 makeCfg 即 0）；1ms 合法正值也接受（启动即关）
      const r0 = await mkCfg({ tokenPollMs: 0 });
      const s0 = await start(r0.cfg); await s0.dispose();
      const r1 = await mkCfg({ tokenPollMs: 1 });
      const s1 = await start(r1.cfg); await s1.dispose();
    });
    it("roots/sessionRoots/scanDir：相对路径 → 拒绝启动", async () => {
      const a = await mkCfg({ roots: ["relative/dir"] });
      await expect(startServer(a.cfg)).rejects.toThrow("roots 含非法元素");
      const b = await mkCfg({ sessionRoots: ["rel"] });
      await expect(startServer(b.cfg)).rejects.toThrow("sessionRoots 含非法元素");
      const c = await mkCfg({ scanDir: "rel/scan" });
      await expect(startServer(c.cfg)).rejects.toThrow("scanDir 非法");
    });
    it("allowedOrigins：空串/裸串（无 scheme） → 拒绝启动", async () => {
      for (const bad of ["", "localhost:3000"]) {
        const { cfg } = await mkCfg({ allowedOrigins: [bad] });
        await expect(startServer(cfg)).rejects.toThrow("allowedOrigins 含非法来源");
      }
    });
  });

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

  it("R-03 生产流身份随机：两实例首流不同 id；跨实例 cursor → 4404 拒绝", async () => {
    const cfgA = await mkCfg();
    const dir = cfgA.dir; // 公共 journal 根=A 的 dir；B 显式指到同一根
    const cfgB = await mkCfg({ roots: [dir], sessionRoots: undefined, scanDir: dir });
    // 公共 journal 根=dir（两实例同授权面）
    await writeFile(join(dir, "r3.jsonl"), `${JSON.stringify({ t: "session-init", sessionId: "sid-r3", leafId: "l0", ts: 1, cwd: dir })}\n${JSON.stringify({ t: "enqueue", intentId: "i-1", sessionId: "sid-r3", leafId: "l0", generation: 1, matchKey: { textHash: "th-r3-1", attachmentIdentity: "", ordinal: 0 }, payload: { kind: "prompt", rawText: "hello r3", attachments: [], sentAt: "2026-09-26T00:00:00Z" } })}\n`, "utf8");
    const a = await start(cfgA.cfg);
    const b = await start(cfgB.cfg);
    // 简易客户端：hello→welcome→subscribe→收集帧
    const openSub = async (port: number, file: string, cursor?: { streamId: string; seq: number }) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: ORIGIN });
      await new Promise<void>((res, rej) => { ws.on("open", res); ws.on("error", (e) => rej(e as Error)); });
      const got: { t?: string; streamId?: string; code?: number; requestId?: string }[] = [];
      ws.on("message", (d) => got.push(JSON.parse(String(d))));
      ws.send(JSON.stringify({ t: "hello", protocolVersion: 1, token: TOKEN }));
      await new Promise<void>((r) => setTimeout(r, 150));
      const reqId = `sub-${port}`;
      ws.send(JSON.stringify({ t: "subscribe", requestId: reqId, file, ...(cursor !== undefined ? { cursor } : {}) }));
      await new Promise<void>((r) => setTimeout(r, 300));
      ws.terminate();
      return got;
    };
    const fa = await openSub(a.port, "r3.jsonl");
    const fb = await openSub(b.port, "r3.jsonl");
    const snapA = fa.find((f) => f.t === "snapshot");
    const snapB = fb.find((f) => f.t === "snapshot");
    expect(snapA?.streamId).toBeDefined();
    expect(snapB?.streamId).toBeDefined();
    // 随机身份：base64url 16B（22 字符，非 id-N 计数器）
    expect(snapA?.streamId).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(snapA?.streamId).not.toBe(snapB?.streamId);
    // 跨实例 cursor：A 的 streamId 在 B 属未知流 → 4404（非快照洗白）
    const fc = await openSub(b.port, "r3.jsonl", { streamId: snapA!.streamId!, seq: 1 });
    expect(fc.some((f) => f.code === 4404)).toBe(true);
    expect(fc.some((f) => f.t === "snapshot" && f.streamId === snapA?.streamId)).toBe(false);
    await a.dispose();
    await b.dispose();
    await rm(cfgA.dir, { recursive: true, force: true });
    await rm(cfgB.dir, { recursive: true, force: true });
  });

  it("Y-05 tokenPollMs 轮询真实生效：无手动 reload，写新 token 文件后旧 token 自动失效", async () => {
    // GPT 3b-3 Y-05：注释曾称 mtime+size 增量检测（不存在）——实际口径=每次轮询全量读文件并整表
    // 应用。本用例固化「轮询自动重读」：不调 reloadTokens，仅靠 tokenPollMs 周期任务完成轮换。
    const { dir, cfg, audits } = await mkCfg({ tokenPollMs: 20 });
    const s = await start(cfg);
    await writeFile(cfg.tokenFile, JSON.stringify({ version: 1, tokens: ["tok-poll-2"] }), "utf8");
    const t0 = Date.now();
    // 等轮询任务把新表装上（每 20ms 一拍；上限 2s）
    while (Date.now() - t0 < 2000 && !audits.some((l) => l.includes("token-reloaded"))) await new Promise((r) => setTimeout(r, 20));
    expect(audits.some((l) => l.includes("token-reloaded"))).toBe(true);
    const ws1 = new WebSocket(`ws://127.0.0.1:${s.port}`, { origin: ORIGIN });
    await new Promise<void>((res, rej) => { ws1.on("open", res); ws1.on("error", (e) => rej(e as Error)); });
    const got: unknown[] = [];
    ws1.on("message", (d) => got.push(JSON.parse(String(d))));
    ws1.send(JSON.stringify({ t: "hello", protocolVersion: 1, token: TOKEN })); // 旧 token——轮询后应拒
    await new Promise<void>((res) => setTimeout(res, 300));
    expect(got.some((f) => (f as { t?: string; code?: number }).t === "error" && (f as { code?: number }).code === 4401)).toBe(true);
    ws1.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("Y-01 并发 dispose：两方同时收尾→都在完整关停后 resolve，收尾体恰执行一次", async () => {
    // GPT 3b-3 Y-01：布尔早退版第二个 dispose 在首个未完成时提前 resolve——「半关」窗口。
    const { cfg, audits } = await mkCfg();
    const s = await start(cfg);
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}`, { origin: ORIGIN, headers: { authorization: `Bearer ${TOKEN}` } });
    const closed = new Promise<number>((res) => { ws.on("close", (c) => res(c)); });
    await new Promise<void>((res, rej) => { ws.once("open", res); ws.once("error", rej); });
    const d1 = s.dispose();
    const d2 = s.dispose(); // 并发第二方：不等 d1 落定才调
    await Promise.all([d1, d2]);
    // 两方都已 resolve 且完整关停证据齐：告别帧（1000 server-shutdown）+ 收尾审计恰一次
    expect(await closed).toBe(1000);
    expect(audits.filter((l) => l === "composition disposed")).toHaveLength(1);
    const d3 = s.dispose(); // 收尾后再调：同 Promise 立即返回，无二次执行
    await d3;
    expect(audits.filter((l) => l === "composition disposed")).toHaveLength(1);
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
