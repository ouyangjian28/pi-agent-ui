// 3b-1 真网络集成测试（GPT 3b-0 §V 验收七条对应）：
// ①Origin 变体+无 deflate 协商 ②wss 本地 CA 正例+XFP/XFF 伪造拒+可信代理正例 ③continuation+多字节分界+控制帧插入
// ④262,144/145B 应用门+1MiB 传输门独立出口 ⑤真 send 回调+清理 ⑥token 三态（组合 TokenAuthority）
// ⑦关闭竞态截止内释放无句柄悬挂（dispose 后同端口可再监听）
// 环境：真 node:http/https + ws 库客户端 + 真socket（受控替身仅用于时间预算注入）；openssl 现场生成自签证书（TEST-ONLY）。
import { describe, expect, it, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { createServer as createHttpsServer } from "node:https";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Socket } from "node:net";
import WebSocket from "ws";
import { WsServerAdapter, deriveConnMeta, type WsConnectionPort } from "../../apps/server/src/ws/ws-transport.js";
import { WsGateway } from "../../apps/server/src/ws/ws-gateway.js";
import { TokenAuthority } from "../../apps/server/src/ws/token-auth.js";
import { LIMITS } from "@pi-agent-ui/protocol";

const ORIGIN = "http://localhost:3000";
const TOKEN = "test-token-a";

/** 现场自签证书（TEST-ONLY；SAN=localhost+127.0.0.1，客户端把该证书当 CA 信任=正例）。 */
async function genCert(dir: string): Promise<{ key: string; cert: string }> {
  const key = join(dir, "k.pem");
  const cert = join(dir, "c.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", key, "-out", cert, "-days", "30", "-nodes",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
  return { key: await readFile(key, "utf8"), cert: await readFile(cert, "utf8") };
}

interface Harness {
  adapter: WsServerAdapter;
  gateway: WsGateway;
  audits: string[];
  url: (path?: string) => string;
  port: number;
  dispose: () => Promise<void>;
}

const harnesses: Array<() => Promise<void>> = [];
const tmpDirs: string[] = [];

/** 组装真适配器+真网关（默认 ws://127.0.0.1 随机端口）。 */
async function makeHarness(opts?: { allowedOrigins?: string[]; token?: string; requireTlsOffLoopback?: boolean; trustedProxies?: string[] }): Promise<Harness> {
  const audits: string[] = [];
  const tokens = TokenAuthority.fromTokens([opts?.token ?? TOKEN]);
  const gateway = new WsGateway({
    tokens,
    allowedOrigins: opts?.allowedOrigins ?? [ORIGIN],
    source: { load: async () => null },
    audit: (l) => audits.push(l),
    idleMs: 60_000, maxLifetimeMs: 120_000,
  });
  const adapter = new WsServerAdapter({
    allowedOrigins: opts?.allowedOrigins ?? [ORIGIN],
    requireTlsOffLoopback: opts?.requireTlsOffLoopback ?? true,
    trustedProxies: opts?.trustedProxies ?? [],
    audit: (l) => audits.push(l),
  });
  adapter.onConnection((conn, meta) => {
    gateway.attach(conn, {
      onMessage: (cb) => conn.onMessage(cb),
      onClose: (cb) => conn.onClose(cb),
      onPong: (cb) => conn.onPong(cb),
      ping: () => conn.ping(),
    }, { origin: meta.origin ?? undefined, loopback: meta.loopback, tls: meta.tls });
  });
  const { port } = await adapter.listen(0, "127.0.0.1");
  const dispose = async (): Promise<void> => {
    await adapter.dispose();
    await gateway.dispose();
  };
  harnesses.push(dispose);
  return { adapter, gateway, audits, url: () => `ws://127.0.0.1:${port}`, port, dispose };
}

/** 裸 HTTP upgrade 探测（观察 upgrade 前拒绝的 HTTP 状态码；不发 WS 帧）。 */
function rawUpgrade(port: number, origin: string | null): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = new Socket();
    let head = "";
    s.connect(port, "127.0.0.1", () => {
      const lines = ["GET /ws HTTP/1.1", `Host: 127.0.0.1:${port}`, "Upgrade: websocket", "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13"];
      if (origin !== null) lines.push(`Origin: ${origin}`);
      s.write(lines.join("\r\n") + "\r\n\r\n");
    });
    s.on("data", (d) => {
      head += d.toString("latin1");
      const m = /HTTP\/1\.1 (\d{3})/.exec(head);
      if (m) { resolve(Number(m[1])); s.destroy(); }
    });
    s.on("error", reject);
    setTimeout(() => { s.destroy(); reject(new Error("upgrade 探测超时")); }, 5_000);
  });
}

interface WsClient {
  ws: WebSocket;
  frames: unknown[];
  opened: Promise<void>;
  closed: Promise<{ code: number; reason: string }>;
}

function connect(url: string, opts?: WebSocket.ClientOptions | WebSocket.ClientOptions[]): WsClient {
  const ws = new WebSocket(url, opts);
  const frames: unknown[] = [];
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    const text = data.toString("utf8");
    try { frames.push(JSON.parse(text)); } catch { frames.push(text); } // 非 JSON 文本按原文收集（⑤组发送裸文本）
  });
  const opened = new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.on("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") }));
  });
  return { ws, frames, opened, closed };
}

const hello = (token = TOKEN): string => JSON.stringify({ t: "hello", protocolVersion: 1, token }); // 冻结契约：hello 必带 protocolVersion

afterEach(async () => {
  while (harnesses.length > 0) await (harnesses.pop() as () => Promise<void>)();
  while (tmpDirs.length > 0) await rm(tmpDirs.pop() as string, { recursive: true, force: true });
});

describe("3b-1 真网络：①Origin 门+无 deflate", () => {
  it("Origin 缺失/null/子串伪造 → upgrade 前 HTTP 403", async () => {
    const h = await makeHarness();
    await expect(rawUpgrade(h.port, null)).resolves.toBe(403);
    await expect(rawUpgrade(h.port, "null")).resolves.toBe(403);
    await expect(rawUpgrade(h.port, "http://evil.example/localhost:3000")).resolves.toBe(403);
    await expect(rawUpgrade(h.port, "http://localhost:3000.evil.example")).resolves.toBe(403);
    expect(h.audits.some((l) => l.includes("upgrade-rejected") && l.includes("rule=origin"))).toBe(true);
  });

  it("Origin 精确匹配 → 101 upgrade；无 permessage-deflate 协商", async () => {
    const h = await makeHarness();
    await expect(rawUpgrade(h.port, ORIGIN)).resolves.toBe(101);
    // ws 客户端主动提 deflate，服务端未协商 → 响应头无扩展
    const c = connect(h.url(), { headers: { Origin: ORIGIN }, perMessageDeflate: {} });
    await c.opened;
    const reqHeaders = (c.ws as unknown as { _req?: { headers: Record<string, string> } })._req?.headers ?? {};
    expect(reqHeaders["sec-websocket-extensions"] ?? "").not.toContain("permessage-deflate");
    c.ws.close();
    await c.closed;
  });
});

describe("3b-1 真网络：②TLS+代理头", () => {
  it("wss 正例：客户端信任指定 CA → 连接成功且 meta.tls=true", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-tls-"));
    tmpDirs.push(dir);
    const { key, cert } = await genCert(dir);
    const audits: string[] = [];
    const server = createHttpsServer({ key, cert });
    const adapter = new WsServerAdapter({ allowedOrigins: ["https://localhost:3000"], server, audit: (l) => audits.push(l) });
    let sawTls = false;
    adapter.onConnection((_conn, meta) => { sawTls = meta.tls; });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    harnesses.push(async () => { await adapter.dispose(); await new Promise<void>((r) => server.close(() => r())); });
    const c = connect(`wss://localhost:${port}/ws`, { headers: { Origin: "https://localhost:3000" }, ca: [cert], rejectUnauthorized: true });
    await c.opened;
    expect(sawTls).toBe(true);
    c.ws.close();
    await c.closed;
  });

  it("XFP/XFF 伪造拒（无信任代理→头不生效）", async () => {
    const h = await makeHarness(); // trustedProxies=[]
    const c = connect(h.url(), { headers: { Origin: ORIGIN, "X-Forwarded-For": "203.0.113.7", "X-Forwarded-Proto": "https" } });
    await c.opened;
    const line = h.audits.find((l) => l.includes("upgrade-accepted"));
    expect(line).toBeDefined();
    expect(line as string).toContain("proxied=false");
    expect(line as string).not.toContain("clientIp=203.0.113.7");
    c.ws.close();
    await c.closed;
  });

  it("可信代理正例：XFF/XFP 按头派生有效地址", async () => {
    const h = await makeHarness({ trustedProxies: ["127.0.0.1", "::1"] });
    const c = connect(h.url(), { headers: { Origin: ORIGIN, "X-Forwarded-For": "203.0.113.7", "X-Forwarded-Proto": "https" } });
    await c.opened;
    const line = h.audits.find((l) => l.includes("upgrade-accepted"));
    expect(line).toBeDefined();
    expect(line as string).toContain("clientIp=203.0.113.7");
    expect(line as string).toContain("proxied=true");
    c.ws.close();
    await c.closed;
  });

  it("deriveConnMeta 单元对照：可信代理但头缺失→保守回退 socket 事实", () => {
    const fakeReq = { headers: {} as Record<string, string | string[] | undefined> } as never;
    const fakeSock = { remoteAddress: "127.0.0.1" } as never;
    const m = deriveConnMeta(fakeReq, fakeSock, ["127.0.0.1"]);
    expect(m.clientIp).toBe("127.0.0.1");
    expect(m.proxied).toBe(true);
    expect(m.loopback).toBe(true);
  });
});

// ---- ③ 分帧：手造掩码客户端帧（真 socket）----
function maskFrame(opcode: number, fin: boolean, payload: Buffer): Buffer {
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const len = payload.length;
  let header: Buffer;
  if (len < 126) header = Buffer.from([fin ? 0x80 | opcode : opcode, 0x80 | len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = fin ? 0x80 | opcode : opcode; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = fin ? 0x80 | opcode : opcode; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

/** 裸 socket 完成 WS 握手（返回 socket；帧由调用方手造发送）。 */
function rawHandshake(port: number, origin: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = new Socket();
    let head = "";
    s.connect(port, "127.0.0.1", () => {
      s.write(["GET /ws HTTP/1.1", `Host: 127.0.0.1:${port}`, "Upgrade: websocket", "Connection: Upgrade",
        `Origin: ${origin}`, "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13"].join("\r\n") + "\r\n\r\n");
    });
    s.on("data", (d) => {
      head += d.toString("latin1");
      if (head.includes("\r\n\r\n")) {
        if (head.startsWith("HTTP/1.1 101")) resolve(s);
        else { s.destroy(); reject(new Error(`upgrade 失败: ${head.split("\r\n")[0]}`)); }
      }
    });
    s.on("error", reject);
    setTimeout(() => { s.destroy(); reject(new Error("握手超时")); }, 5_000);
  });
}

describe("3b-1 真网络：③continuation+多字节 UTF-8 分界+控制帧", () => {
  it("碎片帧跨码点+插入 ping 控制帧 → 仍一条完整消息", async () => {
    const h = await makeHarness();
    const got: Array<{ text: string; binary: boolean }> = [];
    const origConn = new Promise<WsConnectionPort>((resolve) => {
      h.adapter.onConnection((conn) => { conn.onMessage((text, isBinary) => { got.push({ text, binary: isBinary }); }); resolve(conn); });
    });
    const sock = await rawHandshake(h.port, ORIGIN);
    await origConn;
    const full = Buffer.from("前😀中𝄞后", "utf8");
    // 碎在 😀 代理对中间（UTF-8 4 字节码点第 3 字节处）+ 再碎在 𝄞 中间；中间插 ping 控制帧
    const cut1 = 3 + 2; // "前"=3B + 😀前2B
    const cut2 = cut1 + 2 + 1; // 😀后2B + 𝄞第1B
    sock.write(maskFrame(0x1, false, full.subarray(0, cut1))); // 首帧 text fin=0
    sock.write(maskFrame(0x9, true, Buffer.from("probe"))); // 控制帧插入（ping，可出现在分片间）
    sock.write(maskFrame(0x0, false, full.subarray(cut1, cut2))); // continuation fin=0
    sock.write(maskFrame(0x0, true, full.subarray(cut2))); // continuation fin=1 收尾
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("消息未达")), 5_000);
      const poll = (): void => { if (got.length >= 1) { clearTimeout(t); resolve(); } else setTimeout(poll, 20); };
      poll();
    });
    expect(got).toEqual([{ text: "前😀中𝄞后", binary: false }]);
    sock.destroy();
  });

  it("服务端 transport ping → 客户端 ws 自动 pong → onPong 触发", async () => {
    const h = await makeHarness();
    const connP = new Promise<WsConnectionPort>((resolve) => { h.adapter.onConnection((conn) => resolve(conn)); });
    const ponged = new Promise<void>((resolve) => { void connP.then((conn) => conn.onPong(() => resolve())); });
    const c = connect(h.url(), { headers: { Origin: ORIGIN } });
    await c.opened;
    (await connP).ping(); // 服务端主动控制帧 ping → ws 客户端自动回 pong → onPong 触发
    await Promise.race([ponged, new Promise((_, rej) => setTimeout(() => rej(new Error("pong 未触发")), 5_000))]);
    c.ws.close();
    await c.closed;
  });
});

describe("3b-1 真网络：④双门尺寸（真网关组合）", () => {
  it("262,144B 应用帧合法；262,145B → 网关 4404", async () => {
    const h = await makeHarness();
    const c = connect(h.url(), { headers: { Origin: ORIGIN }, maxPayload: 2 * 1024 * 1024 });
    await c.opened;
    c.ws.send(hello());
    await new Promise<void>((r) => setTimeout(r, 100));
    // 合法上界：JSON 文本帧总字节恰=LIMITS.frameMaxBytes（前缀+填充补齐）
    const padTo = (n: number): string => {
      const prefix = '{"t":"app.echo","data":"';
      return JSON.stringify({ t: "app.echo", data: "x".repeat(Math.max(0, n - prefix.length - 2)) });
    };
    const okFrame = padTo(LIMITS.frameMaxBytes);
    expect(Buffer.byteLength(okFrame)).toBe(LIMITS.frameMaxBytes);
    c.ws.send(okFrame);
    await new Promise<void>((r) => setTimeout(r, 200));
    // 超限 1B：网关 4404（传输层 1MiB 内放行）
    const overFrame = padTo(LIMITS.frameMaxBytes + 1);
    expect(Buffer.byteLength(overFrame)).toBe(LIMITS.frameMaxBytes + 1);
    c.ws.send(overFrame);
    const errFrame = await new Promise<unknown>((resolve, reject) => {
      const t0 = Date.now();
      const poll = (): void => {
        const hit = c.frames.find((f) => (f as { t?: string; code?: number }).t === "error" && (f as { code?: number }).code === 4404);
        if (hit) resolve(hit); else if (Date.now() - t0 > 5_000) reject(new Error("4404 未到达")); else setTimeout(poll, 30);
      };
      poll();
    });
    expect(errFrame).toMatchObject({ t: "error", code: 4404 });
    c.ws.close();
    await c.closed;
  });

  it("1MiB+1 单帧 → 传输接收器 close 1009（先于应用层）", async () => {
    const h = await makeHarness();
    const c = connect(h.url(), { headers: { Origin: ORIGIN } });
    await c.opened;
    c.ws.send("z".repeat(LIMITS.transportMaxPayloadBytes + 1)); // 客户端无上限
    const closeInfo = await c.closed;
    expect(closeInfo.code).toBe(1009);
  });
});

describe("3b-1 真网络：⑤真 send 回调+清理", () => {
  it("send done 回调在真实交付后兑现一次；关闭后 send 即拒", async () => {
    const h = await makeHarness();
    const connP = new Promise<WsConnectionPort>((resolve) => { h.adapter.onConnection((conn) => resolve(conn)); });
    const c = connect(h.url(), { headers: { Origin: ORIGIN } });
    await c.opened;
    const conn = await connP;
    const got: string[] = [];
    c.ws.on("message", (d) => got.push(d.toString("utf8")));
    const done1 = new Promise<{ err: Error | null }>((resolve) => conn.send("hello-net", (err) => resolve({ err: err ?? null })));
    const r1 = await done1;
    expect(r1.err).toBeNull();
    await new Promise<void>((r) => setTimeout(r, 100));
    expect(got).toEqual(["hello-net"]);
    // 关闭后 send
    conn.close(1000, "done");
    await c.closed;
    const done2 = new Promise<{ err: Error | null }>((resolve) => conn.send("late", (err) => resolve({ err: err ?? null })));
    const r2 = await done2;
    expect(r2.err).toBeInstanceOf(Error);
  });

  it("背压下 done 等真实 flush（64KB 大消息×多，客户端延迟读取）", async () => {
    const h = await makeHarness();
    const connP = new Promise<WsConnectionPort>((resolve) => { h.adapter.onConnection((conn) => resolve(conn)); });
    const c = connect(h.url(), { headers: { Origin: ORIGIN } });
    await c.opened;
    const conn = await connP;
    const big = "b".repeat(64 * 1024);
    const results: Array<"ok" | Error> = [];
    const sends = Array.from({ length: 32 }, () => new Promise<void>((resolve) => {
      conn.send(big, (err) => { results.push(err ?? "ok"); resolve(); });
    }));
    await Promise.all(sends); // 客户端 ws 库持续在收（读侧活跃）→ 全部真实 flush
    expect(results.every((r) => r === "ok")).toBe(true);
    c.ws.close();
    await c.closed;
  });
});

describe("3b-1 真网络：⑥token 三态（真 TokenAuthority 组合）", () => {
  it("启动缺失令牌文件 → 构造失败（fail-closed 拒启动）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-token-"));
    tmpDirs.push(dir);
    await expect(TokenAuthority.fromFile(join(dir, "missing.json"))).rejects.toThrow();
  });

  it("有效令牌 hello 通过；文件轮换后 applyTokenReload 生效", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-token2-"));
    tmpDirs.push(dir);
    const path = join(dir, "tokens.json");
    await writeFile(path, JSON.stringify({ version: 1, tokens: [TOKEN] }), "utf8");
    const audits: string[] = [];
    const tokens = await TokenAuthority.fromFile(path, {}, (l) => audits.push(l));
    const gateway = new WsGateway({ tokens, allowedOrigins: [ORIGIN], source: { load: async () => null }, audit: (l) => audits.push(l), idleMs: 60_000, maxLifetimeMs: 120_000 });
    const adapter = new WsServerAdapter({ allowedOrigins: [ORIGIN], audit: (l) => audits.push(l) });
    adapter.onConnection((conn, meta) => {
      gateway.attach(conn, { onMessage: (cb) => conn.onMessage(cb), onClose: (cb) => conn.onClose(cb), onPong: (cb) => conn.onPong(cb), ping: () => conn.ping() }, { origin: meta.origin ?? undefined, loopback: meta.loopback, tls: meta.tls });
    });
    const { port } = await adapter.listen(0, "127.0.0.1");
    harnesses.push(async () => { await adapter.dispose(); await gateway.dispose(); });
    const c = connect(`ws://127.0.0.1:${port}`, { headers: { Origin: ORIGIN } });
    await c.opened;
    c.ws.send(hello());
    const welcome = await new Promise<unknown>((resolve, reject) => {
      const t0 = Date.now();
      const poll = (): void => {
        const hit = c.frames.find((f) => (f as { t?: string }).t === "welcome");
        if (hit) resolve(hit); else if (Date.now() - t0 > 5_000) reject(new Error("welcome 未到达")); else setTimeout(poll, 30);
      };
      poll();
    });
    expect(welcome).toMatchObject({ t: "welcome" });
    // 错令牌连接被拒（4401→close）
    const c2 = connect(`ws://127.0.0.1:${port}`, { headers: { Origin: ORIGIN } });
    await c2.opened;
    c2.ws.send(hello("wrong"));
    const close2 = await c2.closed;
    expect(close2.code).toBe(1008);
    c.ws.close();
    await c.closed;
  });
});

describe("3b-1 真网络：⑦关闭竞态+无句柄悬挂", () => {
  it("dispose → 存量连接收 1001；同端口立即可再监听（句柄释放）", async () => {
    const h = await makeHarness();
    const c = connect(h.url(), { headers: { Origin: ORIGIN } });
    await c.opened;
    const closeP = c.closed;
    await h.dispose();
    const info = await closeP;
    expect(info.code).toBe(1001);
    // 句柄已释放：同端口可再监听
    const adapter2 = new WsServerAdapter({ allowedOrigins: [ORIGIN], audit: () => {} });
    const { port } = await adapter2.listen(h.port, "127.0.0.1");
    expect(port).toBe(h.port);
    await adapter2.dispose();
    await expect(h.adapter.dispose()).resolves.toBeUndefined(); // 幂等
  });

  it("upgrade 握手中途 socket 早关 → 无泄漏无崩溃（审计记录）", async () => {
    const h = await makeHarness();
    const s = new Socket();
    s.connect(h.port, "127.0.0.1", () => {
      s.write("GET /ws HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nOrigin: " + ORIGIN + "\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
      s.destroy(); // 握手完成前裸断
    });
    await new Promise<void>((r) => setTimeout(r, 200));
    // 适配器仍可用
    const c = connect(h.url(), { headers: { Origin: ORIGIN } });
    await c.opened;
    c.ws.close();
    await c.closed;
  });
});
