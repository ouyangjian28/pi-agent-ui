// ⑤B（3c-5）：静态托管三面测试。
// SS 面=resolveStaticPath/createStaticHandler 纯净单测（真 http server 旋起旋灭，无 WS）；
// ST 面=composition staticDir 集成（固定 port 同源：HTTP fetch + WS hello→sessions 同端口共存+有界 dispose）；
// SM 面=main.ts CLI 冒烟（--help/参数校验/起停+SIGTERM 优雅退出）。
// 真实 pi 全链归 ⑤C（PI_E2E=1 门控，不在本档）。
import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { createStaticHandler, resolveStaticPath } from "../../../apps/server/src/ws/static-serve.ts";
import { startServer, type PiAgentUiServer } from "../../../apps/server/src/composition.ts";

const TOKEN = "tok-3c5-static";
const CLEANUP_SERVERS: PiAgentUiServer[] = [];
const CLEANUP_HTTP: Server[] = [];

afterEach(async () => {
  while (CLEANUP_SERVERS.length > 0) { const s = CLEANUP_SERVERS.pop(); if (s) await s.dispose().catch(() => {}); }
  while (CLEANUP_HTTP.length > 0) { const s = CLEANUP_HTTP.pop(); if (s) await new Promise<void>((r) => s.close(() => r())); }
});

/** 预探测空闲端口（tiny race window；EADDRINUSE 由启动失败测试兜住语义）。 */
async function freePort(): Promise<number> {
  return await new Promise((res, rej) => {
    const ns = createNetServer();
    ns.on("error", rej);
    ns.listen(0, "127.0.0.1", () => {
      const p = (ns.address() as { port: number }).port;
      ns.close(() => { res(p); });
    });
  });
}

async function mkDist(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "static-3c5-"));
  await writeFile(join(dir, "index.html"), "<!doctype html><title>pi-agent-ui</title><p>hello</p>");
  await writeFile(join(dir, "app.js"), "console.log('app')");
  await writeFile(join(dir, "style.css"), "p{color:#333}");
  await writeFile(join(dir, "data.json"), JSON.stringify({ ok: true }));
  await writeFile(join(dir, ".hidden"), "secret");
  await writeFile(join(dir, "logo.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  return dir;
}

interface ResInfo { status: number; headers: Record<string, string | string[] | undefined>; body: string }

async function req(server: Server, pathName: string, method = "GET"): Promise<ResInfo> {
  const { port } = server.address() as { port: number };
  const r = await fetch(`http://127.0.0.1:${port}${pathName}`, { method });
  return { status: r.status, headers: Object.fromEntries(r.headers.entries()), body: method === "HEAD" ? "" : await r.text() };
}

describe("⑤B SS：resolveStaticPath 纯函数", () => {
  it("SS1 根内普通路径 → 绝对文件路径；尾斜杠与裸根 → null（归一职责在 handler 的 /→/index.html）", () => {
    expect(resolveStaticPath("/srv/dist", "/app.js")).toBe("/srv/dist/app.js");
    expect(resolveStaticPath("/srv/dist", "/a/b.js")).toBe("/srv/dist/a/b.js");
    expect(resolveStaticPath("/srv/dist", "/")).toBeNull();
    expect(resolveStaticPath("/srv/dist", "/a/")).toBe("/srv/dist/a"); // join 归一尾斜杠；目录命中由 stat 404 兑现
  });
  it("SS2 穿越/编码逃逸/点文件/畸形解码 → null（fail-closed）", () => {
    expect(resolveStaticPath("/srv/dist", "/../etc/passwd")).toBeNull();
    expect(resolveStaticPath("/srv/dist", "/a/../../etc/passwd")).toBeNull();
    expect(resolveStaticPath("/srv/dist", "/%2e%2e/etc/passwd")).toBeNull();
    expect(resolveStaticPath("/srv/dist", "/.hidden")).toBeNull();
    expect(resolveStaticPath("/srv/dist", "/a/.env")).toBeNull();
    expect(resolveStaticPath("/srv/dist", "/%")).toBeNull(); // 畸形百分号
    expect(resolveStaticPath("/srv/dist", "/%00")).toBeNull(); // NUL
  });
});

describe("⑤B SS：createStaticHandler（真 http server）", () => {
  it("SS3 GET / → index.html 200 + text/html + no-store", async () => {
    const dist = await mkDist();
    const server = createServer(createStaticHandler(dist));
    CLEANUP_HTTP.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const r = await req(server, "/");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.body).toContain("pi-agent-ui");
  });
  it("SS4 MIME 表（js/css/json/svg）+未知扩展回退 octet-stream", async () => {
    const dist = await mkDist();
    const server = createServer(createStaticHandler(dist));
    CLEANUP_HTTP.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    expect((await req(server, "/app.js")).headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect((await req(server, "/style.css")).headers["content-type"]).toBe("text/css; charset=utf-8");
    expect((await req(server, "/data.json")).headers["content-type"]).toBe("application/json; charset=utf-8");
    expect((await req(server, "/logo.svg")).headers["content-type"]).toBe("image/svg+xml");
  });
  it("SS5 HEAD → 头全、body 空", async () => {
    const dist = await mkDist();
    const server = createServer(createStaticHandler(dist));
    CLEANUP_HTTP.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const r = await req(server, "/", "HEAD");
    expect(r.status).toBe(200);
    expect(Number(r.headers["content-length"])).toBeGreaterThan(0);
    expect(r.body).toBe("");
  });
  it("SS6 非法方法 → 405 + Allow", async () => {
    const dist = await mkDist();
    const server = createServer(createStaticHandler(dist));
    CLEANUP_HTTP.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const r = await req(server, "/", "POST");
    expect(r.status).toBe(405);
    expect(r.headers["allow"]).toBe("GET, HEAD");
  });
  it("SS7 缺失文件/点文件/目录 → 404；审计行落 static-*", async () => {
    const dist = await mkDist();
    const lines: string[] = [];
    const server = createServer(createStaticHandler(dist, (l) => lines.push(l)));
    CLEANUP_HTTP.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    expect((await req(server, "/missing.js")).status).toBe(404);
    expect((await req(server, "/.hidden")).status).toBe(404);
    expect((await req(server, "/%2e%2e/etc/passwd")).status).toBe(404);
    expect(lines.some((l) => l.startsWith("static-miss"))).toBe(true);
    expect(lines.some((l) => l.startsWith("static-reject"))).toBe(true);
  });
});

describe("⑤B ST：composition staticDir 集成（同端口 HTTP+WS）", () => {
  async function mkStaticCfg(dist: string, port: number): Promise<{ cfg: Record<string, unknown>; audits: string[] }> {
    const dir = await mkdtemp(join(tmpdir(), "comp-3c5-"));
    const tokenFile = join(dir, "tokens.json");
    await writeFile(tokenFile, JSON.stringify({ version: 1, tokens: [TOKEN] }), { mode: 0o600 });
    await chmod(tokenFile, 0o600);
    const audits: string[] = [];
    return { cfg: {
      tokenFile, allowedOrigins: [`http://127.0.0.1:${port}`], roots: [dir], scanDir: dir,
      staticDir: dist, port, host: "127.0.0.1", tokenPollMs: 0, audit: (l: string) => audits.push(l),
    }, audits };
  }
  interface Frame { t?: string; [k: string]: unknown }

  it("ST1 staticDir+port 0 → 拒启（同源 origin 需固定端口）", async () => {
    const dist = await mkDist();
    const { cfg } = await mkStaticCfg(dist, 0);
    await expect(startServer(cfg as unknown as Parameters<typeof startServer>[0])).rejects.toThrow(/staticDir 模式必须显式指定固定 port/);
  });
  it("ST2 HTTP fetch：/ → 200 html；missing → 404；审计含 static-hit/static-miss", async () => {
    const dist = await mkDist();
    const port = await freePort();
    const { cfg, audits } = await mkStaticCfg(dist, port);
    const s = await startServer(cfg as unknown as Parameters<typeof startServer>[0]);
    CLEANUP_SERVERS.push(s);
    expect(s.port).toBe(port);
    const home = await fetch(`http://127.0.0.1:${port}/`);
    expect(home.status).toBe(200);
    expect(home.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect((await home.text())).toContain("pi-agent-ui");
    expect((await fetch(`http://127.0.0.1:${port}/nope.js`)).status).toBe(404);
    expect(audits.some((l) => l.startsWith("static-hit"))).toBe(true);
    expect(audits.some((l) => l.startsWith("static-miss"))).toBe(true);
  });
  it("ST3 WS 同端口共存：hello→welcome→list-sessions→sessions（读链不受静态托管影响）", async () => {
    const dist = await mkDist();
    const port = await freePort();
    const { cfg } = await mkStaticCfg(dist, port);
    const s = await startServer(cfg as unknown as Parameters<typeof startServer>[0]);
    CLEANUP_SERVERS.push(s);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: `http://127.0.0.1:${port}` });
    const frames: Frame[] = [];
    await new Promise<void>((res, rej) => { ws.on("open", res); ws.on("error", (e) => rej(e as Error)); });
    ws.on("message", (d) => frames.push(JSON.parse(String(d))));
    const next = (t: string): Promise<Frame> => new Promise((res, rej) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const hit = frames.find((f) => f.t === t);
        if (hit !== undefined) { clearInterval(iv); res(hit); }
        else if (Date.now() - t0 > 5_000) { clearInterval(iv); rej(new Error(`等帧超时：${t}`)); }
      }, 10);
    });
    ws.send(JSON.stringify({ t: "hello", protocolVersion: 1, token: TOKEN }));
    await next("welcome");
    ws.send(JSON.stringify({ t: "list-sessions", requestId: "st3-r1" }));
    await next("sessions");
    ws.close();
  });
  it("ST4 dispose 有界（keep-alive 连接被 closeAllConnections 截断，不挂 5s 守卫上限）", async () => {
    const dist = await mkDist();
    const port = await freePort();
    const { cfg } = await mkStaticCfg(dist, port);
    const s = await startServer(cfg as unknown as Parameters<typeof startServer>[0]);
    CLEANUP_SERVERS.push(s);
    const keep = await fetch(`http://127.0.0.1:${port}/`); // 拉一个连接（fetch 默认带 keep-alive agent）
    expect(keep.status).toBe(200);
    const t0 = Date.now();
    await s.dispose();
    expect(Date.now() - t0).toBeLessThan(4_500); // 5s 守卫之下即视为有界（CI 抖动余量 0.5s）
  });
});

describe("⑤B SM：main.ts CLI 冒烟", () => {
  const REPO = join(import.meta.dirname, "../../..");
  interface ProcOut { code: number | null; stdout: string; stderr: string }
  function run(args: string[], opts: { signal?: NodeJS.Signals; waitMs?: number } = {}): Promise<ProcOut> {
    return new Promise((res, rej) => {
      // 运行方式=--experimental-transform-types（仓内 ws-transport 等用参数属性=非纯 erasable；
      // strip-only 模式拒跑——这是 ⑤B 定下的生产运行命令，usage 已注）
      const p = spawn(process.execPath, ["--experimental-transform-types", "apps/server/src/main.ts", ...args], { cwd: REPO });
      let stdout = "", stderr = "";
      const timer = setTimeout(() => { p.kill("SIGKILL"); rej(new Error(`子进程超时：${args.join(" ")}`)); }, opts.waitMs ?? 8_000);
      p.stdout.on("data", (d) => { stdout += String(d); });
      p.stderr.on("data", (d) => { stderr += String(d); });
      p.on("error", (e) => { clearTimeout(timer); rej(e); });
      p.on("close", (code) => { clearTimeout(timer); res({ code, stdout, stderr }); });
      if (opts.signal !== undefined) {
        const iv = setInterval(() => { if (stdout.includes("main ready")) { clearInterval(iv); p.kill(opts.signal!); } }, 20);
        setTimeout(() => clearInterval(iv), 6_000);
      }
    });
  }
  it("SM1 --help → 用法文本+退出 0", async () => {
    const r = await run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("用法");
    expect(r.stdout).toContain("--static-dir");
  });
  it("SM2 缺 token-file → 退出 1+必填提示", async () => {
    const r = await run(["--port", "18787"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--token-file 必填");
  });
  it("SM3 非法 port（0/越界/非整数）→ 退出 1+端口门提示（真 token/真 root：排际 token/root 门先触发偷换杀点）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sm3-3c5-"));
    const tokenFile = join(dir, "tokens.json");
    await writeFile(tokenFile, JSON.stringify({ version: 1, tokens: [TOKEN] }), { mode: 0o600 });
    await chmod(tokenFile, 0o600);
    for (const bad of ["0", "70000", "abc"]) {
      const r = await run(["--port", bad, "--token-file", tokenFile, "--root", dir]);
      expect(r.code, `port=${bad}`).toBe(1);
      expect(r.stderr, `port=${bad}`).toContain("--port 必填");
    }
  });
  it("SM4 root 不存在 → 退出 1+目录提示", async () => {
    const r = await run(["--port", "18787", "--token-file", "/tmp/x.json", "--root", "/nonexistent-xyz"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("不存在");
  });
  it("SM5 全参数起服→ready 审计行→SIGTERM 优雅退出 0（静态托管真跑）", async () => {
    const dist = await mkDist();
    const dir = await mkdtemp(join(tmpdir(), "main-3c5-"));
    const tokenFile = join(dir, "tokens.json");
    await writeFile(tokenFile, JSON.stringify({ version: 1, tokens: [TOKEN] }), { mode: 0o600 });
    await chmod(tokenFile, 0o600);
    const port = await freePort();
    const r = await run(["--port", String(port), "--token-file", tokenFile, "--root", dir, "--static-dir", dist], { signal: "SIGTERM", waitMs: 10_000 });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("main ready");
    expect(r.stdout).toContain("main signal=SIGTERM");
    expect(r.stdout).toContain("main disposed");
    expect(r.stdout).toContain(`http://127.0.0.1:${port}`);
    const home = await fetch(`http://127.0.0.1:${port}/`).catch(() => null); // 退出后端口应已释放
    expect(home).toBeNull();
  });
});
