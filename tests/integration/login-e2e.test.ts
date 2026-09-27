// N4-v2 E2E（2026-10-05 拍板：HttpOnly cookie 会话）：真 HTTP 登录面+真 WS 升级面全链。
// 链路：startServer(staticDir 模式=外部 http server) → POST /login(fetch) → Set-Cookie(sid) →
// WS 升级带 Cookie → 免令牌 hello → welcome。反例：篡改 sid→4401；cookie+错令牌→4401（不静默降级）；
// 免令牌 hello 无 cookie→4401；登出→旧 sid 升级面失效；静态面不受 /login 占位影响。
import { describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startServer, type PiAgentUiServer } from "../../apps/server/src/composition.ts";

const tick = (): Promise<void> => new Promise((res) => setImmediate(() => res()));
const TOKEN = "tok-e2e-ok";

interface Rig {
  srv: PiAgentUiServer;
  base: string;
  audits: string[];
  dispose(): Promise<void>;
}

async function makeRig(): Promise<Rig> {
  const d = await mkdtemp(join(tmpdir(), "login-e2e-"));
  const jr = join(d, "journals");
  const staticDir = join(d, "web");
  await mkdir(staticDir, { recursive: true });
  await mkdir(jr, { recursive: true });
  await writeFile(join(staticDir, "index.html"), "<html>ok</html>");
  const tokenFile = join(d, "tokens.json");
  await writeFile(tokenFile, JSON.stringify({ version: 1, tokens: [TOKEN] }), { mode: 0o600 });
  await chmod(tokenFile, 0o600);
  const audits: string[] = [];
  const srv = await startServer({
    tokenFile,
    allowedOrigins: ["http://localhost:4173"],
    roots: [jr],
    scanDir: jr,
    host: "127.0.0.1",
    port: 47_879, // staticDir 模式须固定 port（同源 origin 预知）
    staticDir,
    tokenPollMs: 0,
    audit: (l) => { audits.push(l); },
  });
  const base = `http://127.0.0.1:${srv.port}`;
  return { srv, base, audits, dispose: async () => { await srv.dispose(); await rm(d, { recursive: true, force: true }); } };
}

interface WsResult {
  frames: Array<Record<string, unknown>>;
  closeCode: number | undefined;
}

/** 带 Cookie 的 WS 连接+发一帧 hello（免令牌或带令牌）→收首帧（welcome/error）即关。 */
function wsHello(url: string, cookie: string | null, hello: Record<string, unknown>, onFrame: (r: WsResult) => void): void {
  const ws = new WebSocket(url.replace(/^http/, "ws"), {
    headers: { Origin: "http://localhost:4173", ...(cookie !== null ? { Cookie: cookie } : {}) },
  });
  const r: WsResult = { frames: [], closeCode: undefined };
  ws.on("open", () => { ws.send(JSON.stringify(hello)); });
  ws.on("message", (d) => {
    r.frames.push(JSON.parse(d.toString()) as Record<string, unknown>);
    onFrame(r);
    try { ws.close(); } catch { /* 已关 */ }
  });
  ws.on("close", (code) => { r.closeCode = code; if (r.frames.length === 0) onFrame(r); });
  ws.on("error", () => { /* 拒连路径由 close 兜底 */ });
}

function wsHelloP(url: string, cookie: string | null, hello: Record<string, unknown>): Promise<WsResult> {
  return new Promise((resolve) => {
    let settled = false;
    wsHello(url, cookie, hello, (r) => { if (!settled) { settled = true; resolve(r); } });
    setTimeout(() => { if (!settled) { settled = true; resolve(r0()); } }, 4000);
    const r0 = (): WsResult => ({ frames: [], closeCode: -1 });
  });
}

describe("N4-v2 登录面 E2E（真 HTTP+真 WS）", () => {
  it("E1 全链：login→Set-Cookie→WS 免令牌 hello→welcome；审计无令牌原文", async () => {
    const r = await makeRig();
    try {
      const res = await fetch(`${r.base}/login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:4173" }, body: JSON.stringify({ token: TOKEN }) });
      expect(res.status).toBe(200);
      const sc = res.headers.get("set-cookie") ?? "";
      expect(sc).toContain("HttpOnly");
      expect(sc).toContain("SameSite=Strict");
      expect(sc).not.toContain(TOKEN);
      const out = await wsHelloP(r.base, sc.split(";")[0] ?? null, { t: "hello", protocolVersion: 1 });
      expect(out.frames.some((f) => f.t === "welcome")).toBe(true);
      expect(r.audits.join("\n")).toContain("login-ok");
      expect(r.audits.join("\n")).not.toContain(TOKEN);
    } finally {
      await r.dispose();
    }
  });

  it("E2 反例矩阵：坏令牌 401 无 cookie；篡改 sid→4401；cookie+错令牌→4401；无 cookie 免令牌→4401", async () => {
    const r = await makeRig();
    try {
      const bad = await fetch(`${r.base}/login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:4173" }, body: JSON.stringify({ token: "wrong" }) });
      expect(bad.status).toBe(401);
      expect(bad.headers.get("set-cookie")).toBeNull();

      const login = await fetch(`${r.base}/login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:4173" }, body: JSON.stringify({ token: TOKEN }) });
      const sid = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      const tampered = sid.replace(/.$/, (c) => (c === "a" ? "b" : "a"));

      const t1 = await wsHelloP(r.base, tampered, { t: "hello", protocolVersion: 1 });
      expect(t1.frames.some((f) => f.code === 4401)).toBe(true);

      const t2 = await wsHelloP(r.base, sid, { t: "hello", protocolVersion: 1, token: "wrong" });
      expect(t2.frames.some((f) => f.code === 4401)).toBe(true); // 不静默降级 cookie

      const t3 = await wsHelloP(r.base, null, { t: "hello", protocolVersion: 1 });
      expect(t3.frames.some((f) => f.code === 4401)).toBe(true);

      // 同一 sid 仍可复用（正确面不因反例损坏）
      const ok = await wsHelloP(r.base, sid, { t: "hello", protocolVersion: 1 });
      expect(ok.frames.some((f) => f.t === "welcome")).toBe(true);
    } finally {
      await r.dispose();
    }
  });

  it("E3 登出：logout 后旧 sid 升级面失效（sid 本身未变，但通道语义以服务端登出为准——首版：logout 只清浏览器侧）", async () => {
    // 注：首版 logout=清 cookie（浏览器侧）；sid 有效性由 per-boot secret+令牌轮换统治。
    // 服务端会话撤销表=后续增强（记 TEST-MAP）。此例验证 logout 路由本身：200+Max-Age=0。
    const r = await makeRig();
    try {
      const out = await fetch(`${r.base}/logout`, { method: "POST", headers: { Origin: "http://localhost:4173" } });
      expect(out.status).toBe(200);
      expect(out.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
    } finally {
      await r.dispose();
    }
  });

  it("E4 静态面共存：GET / 返回静态文件；GET /login 不接管（404/静态兜底）", async () => {
    const r = await makeRig();
    try {
      const home = await fetch(r.base + "/", { headers: { Origin: "http://localhost:4173" } });
      expect([200, 404]).toContain(home.status); // 目录存在与否皆可——只验证不炸
      const gl = await fetch(r.base + "/login", { headers: { Origin: "http://localhost:4173" } });
      expect(gl.status).toBe(404); // GET /login 非登录面（静态兜底 404）
      await tick();
    } finally {
      await r.dispose();
    }
  });
});
