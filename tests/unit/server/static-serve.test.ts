// ⑤B（3c-5）：静态托管三面测试。
// SS 面=resolveStaticPath/createStaticHandler 纯净单测（真 http server 旋起旋灭，无 WS）；
// ST 面=composition staticDir 集成（固定 port 同源：HTTP fetch + WS hello→sessions 同端口共存+有界 dispose）；
// SM 面=main.ts CLI 冒烟（--help/参数校验/起停+SIGTERM 优雅退出）。
// 真实 pi 全链归 ⑤C（PI_E2E=1 门控，不在本档）。
import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { once } from "node:events";
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
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "dist-fixture" }));
  await writeFile(join(dir, "blob.bin"), "\0BIN");
  await mkdir(join(dir, "subdir"));
  await writeFile(join(dir, "subdir", "sub.txt"), "sub");
  return dir;
}

interface ResInfo { status: number; headers: Record<string, string | string[] | undefined>; body: string }

/** 原始 request-target 探针：不经 fetch/URL 预归一化（B2 语义：服务端收到的就是原样字节）。 */
function rawReq(server: Server, target: string): Promise<{ status: number; body: string }> {
  const { port } = server.address() as { port: number };
  return new Promise((res, rej) => {
    const q = httpRequest({ host: "127.0.0.1", port, path: target }, (r) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => res({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    q.on("error", rej);
    q.end();
  });
}

async function req(server: Server, pathName: string, method = "GET"): Promise<ResInfo> {
  const { port } = server.address() as { port: number };
  const r = await fetch(`http://127.0.0.1:${port}${pathName}`, { method });
  return { status: r.status, headers: Object.fromEntries(r.headers.entries()), body: method === "HEAD" ? "" : await r.text() };
}

describe("⑤B SS：resolveStaticPath 纯函数", () => {
  it("SS1 根内普通路径 → 绝对文件路径；/ → index.html；query 分手；空段/尾斜杠/非 origin-form → null", () => {
    expect(resolveStaticPath("/srv/dist", "/app.js")).toBe("/srv/dist/app.js");
    expect(resolveStaticPath("/srv/dist", "/a/b.js")).toBe("/srv/dist/a/b.js");
    expect(resolveStaticPath("/srv/dist", "/")).toBe("/srv/dist/index.html");
    expect(resolveStaticPath("/srv/dist", "/app.js?v=3&x=1")).toBe("/srv/dist/app.js");
    expect(resolveStaticPath("/srv/dist", "/a/")).toBeNull(); // 尾斜杠=空段
    expect(resolveStaticPath("/srv/dist", "/a//b")).toBeNull(); // 空段
    expect(resolveStaticPath("/srv/dist", "app.js")).toBeNull(); // 非 origin-form（无前导 /）
  });
  it("SS2 穿越/编码逃逸/点文件/畸形解码 → null（fail-closed）", () => {
    expect(resolveStaticPath("/srv/dist", "/../etc/passwd")).toBeNull();
    expect(resolveStaticPath("/srv/dist", "/a/../../etc/passwd")).toBeNull();
    expect(resolveStaticPath("/srv/dist", "/%2e%2e/etc/passwd")).toBeNull();
    expect(resolveStaticPath("/srv/dist", "/.hidden")).toBeNull();
    expect(resolveStaticPath("/srv/dist", "/a/.env")).toBeNull();
    expect(resolveStaticPath("/srv/dist", "/%")).toBeNull(); // 畸形百分号
    expect(resolveStaticPath("/srv/dist", "/%00")).toBeNull(); // NUL
    expect(resolveStaticPath("/srv/dist", "/a/./b")).toBeNull(); // 点段
    expect(resolveStaticPath("/srv/dist", "/x/%2e%2e/y")).toBeNull(); // 编码点段（r1：逐段解码后拒）
    expect(resolveStaticPath("/srv/dist", "/x%2f..%2fy")).toBeNull(); // 段内编码分隔符：解码后留在段内=拒
    expect(resolveStaticPath("/srv/dist", "/a#b")).toBeNull(); // # 不进 request-target
    // 单次解码策略（诚实边界）：%252e 解码一次=字面 "%2e"，非点段→按字面文件名解析，存在性由 handler stat 判
    expect(resolveStaticPath("/srv/dist", "/%252e%252e")).toBe("/srv/dist/%2e%2e");
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
    expect((await req(server, "/blob.bin")).headers["content-type"]).toBe("application/octet-stream"); // 未知扩展回退
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
    expect((await req(server, "/subdir")).status).toBe(404); // 目录命中：stat 非文件
    expect((await req(server, "/subdir/")).status).toBe(404); // 尾斜杠=空段
    expect(lines.some((l) => l.startsWith("static-miss"))).toBe(true);
    expect(lines.some((l) => l.startsWith("static-reject"))).toBe(true);
  });

  it("SS8 原始 request-target 点段族 → 全 404（B2：不经 fetch/URL 预归一化；对照=根内同名文件真实存在）", async () => {
    const dist = await mkDist(); // mkDist 含 package.json：排除「缺文件碰巧 404」
    const server = createServer(createStaticHandler(dist));
    CLEANUP_HTTP.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    expect((await rawReq(server, "/package.json")).status).toBe(200); // 对照：目标真实存在且可取
    for (const t of [
      "/../package.json",
      "/%2e%2e/package.json",
      "/.x/../package.json",
      "/x/%2e%2e/package.json",
      "/x%2f..%2fpackage.json",
    ]) {
      expect((await rawReq(server, t)).status, `target=${t}`).toBe(404);
    }
    // N1 口径锁定（GPT r2）：裸 # 仅拒路径部分；query 内 # 不拒（query 不参与磁盘解析）
    expect((await rawReq(server, "/package.json?x=#fragment")).status).toBe(200);
  });

  it("SS9 symlink 真实边界（B1）：根内链接指向根外文件/目录 → 404；根自身为 symlink → 口径一致可服务", async () => {
    const outside = await mkdtemp(join(tmpdir(), "static-out-3c5-"));
    await writeFile(join(outside, "secret.txt"), "TOPSECRET");
    const dist = await mkDist();
    await symlink(join(outside, "secret.txt"), join(dist, "leak.txt")); // 文件链接
    await symlink(outside, join(dist, "leakdir")); // 目录链接
    const server = createServer(createStaticHandler(dist));
    CLEANUP_HTTP.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    expect((await rawReq(server, "/index.html")).status).toBe(200); // 对照
    expect((await rawReq(server, "/leak.txt")).status).toBe(404); // 文件链接→根外
    expect((await rawReq(server, "/leakdir/secret.txt")).status).toBe(404); // 目录链接→根外
    // 根自身是 symlink：realRoot=解析后真实根，根内正常文件仍可服务（口径一致）
    const linkHome = await mkdtemp(join(tmpdir(), "static-rootlink-3c5-"));
    const rootLink = join(linkHome, "root-link");
    await symlink(dist, rootLink);
    const server2 = createServer(createStaticHandler(rootLink));
    CLEANUP_HTTP.push(server2);
    await new Promise<void>((r) => server2.listen(0, "127.0.0.1", r));
    expect((await rawReq(server2, "/index.html")).status).toBe(200);
    expect((await rawReq(server2, "/leak.txt")).status).toBe(404); // 根 symlink 不放松真实边界
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
  it("ST4 dispose 有界（正常快速路径；半截请求头的可区分证据在 ST6——不据本例声称守卫被验证）", async () => {
    const dist = await mkDist();
    const port = await freePort();
    const { cfg } = await mkStaticCfg(dist, port);
    const s = await startServer(cfg as unknown as Parameters<typeof startServer>[0]);
    CLEANUP_SERVERS.push(s);
    const keep = await fetch(`http://127.0.0.1:${port}/`); // 拉一个连接（fetch 默认带 keep-alive agent）
    expect(keep.status).toBe(200);
    const t0 = Date.now();
    await s.dispose();
    expect(Date.now() - t0).toBeLessThan(4_500); // 正常路径应即时；本例不构成对 closeAllConnections 的区分证据
  });

  it("ST5 Origin 白名单=构造期快照（B3）：startServer 后对原数组 push 新 origin → 不扩大授权面", async () => {
    const dist = await mkDist();
    const port = await freePort();
    const dir = await mkdtemp(join(tmpdir(), "st5-3c5-"));
    const tokenFile = join(dir, "tokens.json");
    await writeFile(tokenFile, JSON.stringify({ version: 1, tokens: [TOKEN] }), { mode: 0o600 });
    await chmod(tokenFile, 0o600);
    const origins = [`http://127.0.0.1:${port}`]; // 保留引用：事后热变更
    const s = await startServer({
      tokenFile, allowedOrigins: origins, roots: [dir], scanDir: dir,
      staticDir: dist, port, host: "127.0.0.1", tokenPollMs: 0,
    } as unknown as Parameters<typeof startServer>[0]);
    CLEANUP_SERVERS.push(s);
    origins.push("http://late.test"); // 热变更原数组（变异注入面）
    await new Promise<void>((res, rej) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: "http://late.test" });
      const timer = setTimeout(() => { ws.terminate(); rej(new Error("后推 origin 未被拒（5s 内无响应）")); }, 5_000);
      ws.on("open", () => { clearTimeout(timer); ws.terminate(); rej(new Error("后推 origin 竟握手成功：快照门失效")); });
      ws.on("unexpected-response", (_req, res2) => { clearTimeout(timer); expect(res2.statusCode).toBe(403); res2.resume(); ws.terminate(); res(); });
      ws.on("error", () => { /* unexpected-response 路径后 socket 关闭的余波；断言已在上面完成 */ });
    });
    // 对照：白名单内 origin 仍可正常握手
    await new Promise<void>((res, rej) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: `http://127.0.0.1:${port}` });
      ws.on("open", () => { ws.close(); res(); });
      ws.on("error", (e) => rej(e as Error));
      setTimeout(() => { ws.terminate(); rej(new Error("对照 origin 握手超时")); }, 5_000);
    });
  });

  it("ST6 半截请求头连接：dispose 被 closeAllConnections 截断（B4 可区分变异点；基线即时，拔除后落 5s 守卫）", async () => {
    const dist = await mkDist();
    const port = await freePort();
    const dir = await mkdtemp(join(tmpdir(), "st6-3c5-"));
    const tokenFile = join(dir, "tokens.json");
    await writeFile(tokenFile, JSON.stringify({ version: 1, tokens: [TOKEN] }), { mode: 0o600 });
    await chmod(tokenFile, 0o600);
    const s = await startServer({
      tokenFile, allowedOrigins: [`http://127.0.0.1:${port}`], roots: [dir], scanDir: dir,
      staticDir: dist, port, host: "127.0.0.1", tokenPollMs: 0,
    } as unknown as Parameters<typeof startServer>[0]);
    CLEANUP_SERVERS.push(s);
    const sock = connect(port, "127.0.0.1");
    sock.on("error", () => {}); // 服务端 RST 属预期（closeAllConnections 直接 destroy）；不让未监听 error 崩测试
    await once(sock, "connect");
    sock.write("GET / HTTP/1.1\r\nHost: localhost\r\n"); // 只发部分请求头——不进 handler，不受 Connection:close 保护
    await new Promise((r) => setImmediate(r));
    const closed = once(sock, "close"); // 先挂监听再 dispose；顺序=服务端终结在先、客户端清理在 finally（N2 纠偏）
    const t0 = Date.now();
    try {
      await s.dispose();
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(4_500); // 基线≈即时；拔 closeAllConnections 变异→落 5s 守卫=本断言杀点
    } finally {
      sock.destroy(); // 客户端兜底清理（无论断言成败不遗留连接）
    }
    await Promise.race([closed, new Promise((r) => setTimeout(r, 1_000))]); // 服务端 closeAllConnections 终结连接（1s 兜底防挂）
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
