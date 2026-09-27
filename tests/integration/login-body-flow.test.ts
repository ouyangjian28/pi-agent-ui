// N4 r2-B3 真网络体流验证：408/413 必须作为真响应字节写回（r2 前 req.destroy() 后写=真网 0 字节断连）。
// 面向 createLoginRoute 直挂真 node:http server（bodyTimeoutMs 注入短窗），裸 TCP 客户端逐字节慢发。
import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLoginRoute } from "../../apps/server/src/http/login-route.ts";
import { TokenAuthority } from "../../apps/server/src/ws/token-auth.js";

const TOKEN = "tok-flow";
const ORIGIN = "http://localhost:4173";
const CRLF = "\r\n";

interface Rig {
  port: number;
  audits: string[];
  dispose: () => Promise<void>;
}

async function makeRig(over: { bodyTimeoutMs?: number; maxBodyBytes?: number } = {}): Promise<Rig> {
  const d = await mkdtemp(join(tmpdir(), "login-flow-"));
  const audits: string[] = [];
  const tokens = TokenAuthority.fromTokens([TOKEN]);
  const route = createLoginRoute({
    authority: tokens,
    sessionSecret: Buffer.alloc(32, 7),
    audit: (l) => { audits.push(l); },
    allowedOrigins: [ORIGIN],
    bodyTimeoutMs: over.bodyTimeoutMs ?? 200,
    maxBodyBytes: over.maxBodyBytes ?? 1_000_000,
  });
  const srv: Server = createServer((req, res) => { route.handle(req, res); });
  await new Promise<void>((res) => srv.listen(0, "127.0.0.1", () => res()));
  const { port } = srv.address() as { port: number };
  return {
    port,
    audits,
    dispose: async () => { await new Promise<void>((res) => srv.close(() => res())); await rm(d, { recursive: true, force: true }); },
  };
}

interface WireOut { status: string; bytes: number; body: string }

/** 裸 TCP POST：发完头+若干 body 片后停住不结尾——期望服务端把错误响应写字节回网（而非 0 字节断连）。 */
function slowBody(port: number, contentLength: number, chunks: string[]): Promise<WireOut> {
  return new Promise((resolve, reject) => {
    const s = new Socket();
    const to = setTimeout(() => { s.destroy(); reject(new Error("slowBody 超时")); }, 5_000);
    to.unref?.();
    s.connect(port, "127.0.0.1", () => {
      const head = [`POST /login HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Content-Type: application/json", `Origin: ${ORIGIN}`, `Content-Length: ${contentLength}`, "", ""].join(CRLF);
      s.write(head);
      for (const c of chunks) s.write(c);
      // 不发完——挂住等体流超时/超体
    });
    let buf = Buffer.alloc(0);
    s.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const idx = buf.indexOf(CRLF + CRLF);
      if (idx >= 0 && buf.byteLength > idx + 4) {
        clearTimeout(to);
        const head = buf.subarray(0, idx).toString("latin1");
        s.destroy();
        resolve({ status: head.split(CRLF)[0] ?? "", bytes: buf.byteLength, body: buf.toString("utf8") });
      }
    });
    s.once("error", (e) => { clearTimeout(to); reject(e); });
  });
}

/** 裸 TCP POST：完整发完（正常路径）。 */
function fullPost(port: number, body: string): Promise<WireOut> {
  return new Promise((resolve, reject) => {
    const s = new Socket();
    const to = setTimeout(() => { s.destroy(); reject(new Error("fullPost 超时")); }, 3_000);
    to.unref?.();
    s.connect(port, "127.0.0.1", () => {
      const head = [`POST /login HTTP/1.1`, "Host: 127.0.0.1", "Content-Type: application/json", `Origin: ${ORIGIN}`, `Content-Length: ${Buffer.byteLength(body)}`, "", ""].join(CRLF);
      s.write(head + body);
    });
    let buf = Buffer.alloc(0);
    s.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const idx = buf.indexOf(CRLF + CRLF);
      if (idx >= 0 && buf.byteLength > idx + 4) {
        clearTimeout(to);
        const head = buf.subarray(0, idx).toString("latin1");
        s.destroy();
        resolve({ status: head.split(CRLF)[0] ?? "", bytes: buf.byteLength, body: buf.toString("utf8") });
      }
    });
    s.once("error", (e) => { clearTimeout(to); reject(e); });
  });
}

/** r3-Y2 BF4：读完整响应（精确 Content-Length 字节）+等服务端主动 FIN——不精客户端先断，证真交付与有界关停。 */
function slowBodyFullClose(port: number, contentLength: number, chunks: string[]): Promise<WireOut & { serverFin: boolean; head: string; declared: number; bodyBytes: number }> {
  return new Promise((resolve, reject) => {
    const s = new Socket();
    const to = setTimeout(() => { s.destroy(); reject(new Error("slowBodyFullClose 超时")); }, 5_000);
    to.unref?.();
    s.connect(port, "127.0.0.1", () => {
      const head = [`POST /login HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Content-Type: application/json", `Origin: ${ORIGIN}`, `Content-Length: ${contentLength}`, "", ""].join(CRLF);
      s.write(head);
      for (const c of chunks) s.write(c);
    });
    let buf = Buffer.alloc(0);
    let serverFin = false;
    let bodyComplete = false;
    const finish = (): void => {
      clearTimeout(to);
      const idx = buf.indexOf(CRLF + CRLF);
      const head = buf.subarray(0, idx).toString("latin1");
      const m = /content-length:\s*(\d+)/i.exec(head);
      const declared = m === null ? -1 : Number(m[1]);
      const bodyBytes = buf.byteLength - (idx + 4);
      s.destroy();
      // r4-Y2：头内声明长度与实收字节双双返回（调用方断言精确等值，>= 不再放过长度错误）
      resolve({ status: head.split(CRLF)[0] ?? "", bytes: buf.byteLength, body: buf.subarray(idx + 4).toString("utf8"), head, declared, bodyBytes, serverFin });
    };
    s.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const idx = buf.indexOf(CRLF + CRLF);
      if (idx < 0) return;
      const m = /content-length:\s*(\d+)/i.exec(buf.subarray(0, idx).toString("latin1"));
      if (buf.byteLength === idx + 4 + Number(m?.[1] ?? "-1")) bodyComplete = true; // r4-Y2：恰等（声明与实收严格一致才算完整；>= 放过长度错误）
    });
    s.once("end", () => { serverFin = true; if (bodyComplete) finish(); }); // 服务端 FIN（有界关停 destroy）
    s.once("close", () => { if (serverFin && bodyComplete) finish(); });
    s.once("error", (e) => { clearTimeout(to); reject(e); });
  });
}

describe("N4 r2-B3：体流错误面真网络（408/413 字节在网）", () => {
  it("BF1 慢 body→408：真响应字节抵达客户端（状态行可解析），非 0 字节断连", async () => {
    const r = await makeRig({ bodyTimeoutMs: 150 });
    try {
      const out = await slowBody(r.port, 100, ['{"token":"']);
      expect(out.status).toContain("408");
      expect(out.bytes).toBeGreaterThan(0);
      expect(out.body).toContain("请求体不可用");
      expect(r.audits.some((l) => l.includes("login-body-timeout"))).toBe(true);
    } finally {
      await r.dispose();
    }
  });

  it("BF2 超体→413：真响应字节+审计（同关停面）", async () => {
    const r = await makeRig({ maxBodyBytes: 8 });
    try {
      const out = await slowBody(r.port, 100, ['{"token":"aaaaaaaa']);
      expect(out.status).toContain("413");
      expect(out.bytes).toBeGreaterThan(0);
      expect(r.audits.some((l) => l.includes("login-body-oversize"))).toBe(true);
    } finally {
      await r.dispose();
    }
  });

  it("BF4 408 错误面完整交付+服务端主动关：精确 Content-Length 字节在网且收到 FIN（r3-Y2，不靠客户端先断）", async () => {
    const r = await makeRig({ bodyTimeoutMs: 150 });
    try {
      const out = await slowBodyFullClose(r.port, 100, ['{"token":"']);
      expect(out.status).toContain("408");
      expect(out.serverFin).toBe(true); // 服务端写完即关（closeAfterReply 有界关停面）
      expect(out.declared).toBe(out.bodyBytes); // r4-Y2：头声明=实收（精确长度；Mu-BF4-length-one 杀点）
      expect(out.bodyBytes).toBeGreaterThan(0); // r4-Y2：非空响应体（Mu-BF4-empty-payload 杀点）
      expect(out.head.toLowerCase()).toContain("content-type: application/json"); // 媒体门
      const parsed = JSON.parse(out.body) as { ok?: unknown; error?: unknown };
      expect(parsed.ok).toBe(false); // JSON 语义正确（非 0 字节/截断体）
      expect(parsed.error).toBe("请求体不可用");
    } finally {
      await r.dispose();
    }
  });

  it("BF3 错误面后服务器不楔死：新连接正常登录 200", async () => {
    const r = await makeRig({ bodyTimeoutMs: 120 });
    try {
      await slowBody(r.port, 100, ['{"t']).catch(() => undefined);
      const ok = await fullPost(r.port, JSON.stringify({ token: TOKEN }));
      expect(ok.status).toContain("200");
    } finally {
      await r.dispose();
    }
  });
});
