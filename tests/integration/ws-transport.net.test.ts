// 3b-1 真网络集成测试（GPT 3b-0 §V 验收七条对应）：
// ①Origin 变体+无 deflate 协商 ②wss 本地 CA 正例+XFP/XFF 伪造拒+可信代理正例 ③continuation+多字节分界+控制帧插入
// ④262,144/145B 应用门+1MiB 传输门独立出口 ⑤真 send 回调+清理 ⑥token 三态（组合 TokenAuthority）
// ⑦关闭竞态截止内释放无句柄悬挂（dispose 后同端口可再监听）
// 环境：真 node:http/https + ws 库客户端 + 真socket（受控替身仅用于时间预算注入）；openssl 现场生成自签证书（TEST-ONLY）。
import { describe, expect, it, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { createServer as createHttpsServer } from "node:https";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
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
async function makeHarness(opts?: { allowedOrigins?: string[]; token?: string; requireTlsOffLoopback?: boolean; trustedProxies?: string[]; authRate?: { limit?: number; windowMs?: number; baseBlockMs?: number; maxBlockMs?: number }; closeHandshakeMs?: number; disposeWaitMs?: number }): Promise<Harness> {
  const audits: string[] = [];
  const tokens = TokenAuthority.fromTokens([opts?.token ?? TOKEN]);
  const gateway = new WsGateway({
    tokens,
    allowedOrigins: opts?.allowedOrigins ?? [ORIGIN],
    source: { load: async () => null },
    audit: (l) => audits.push(l),
    idleMs: 60_000, maxLifetimeMs: 120_000,
    authRate: opts?.authRate,
  });
  const adapter = new WsServerAdapter({
    allowedOrigins: opts?.allowedOrigins ?? [ORIGIN],
    requireTlsOffLoopback: opts?.requireTlsOffLoopback ?? true,
    trustedProxies: opts?.trustedProxies ?? [],
    closeHandshakeMs: opts?.closeHandshakeMs,
    disposeWaitMs: opts?.disposeWaitMs,
    audit: (l) => audits.push(l),
  });
  adapter.onConnection((conn, meta) => {
    gateway.attach(conn, {
      onMessage: (cb) => conn.onMessage(cb),
      onClose: (cb) => conn.onClose(cb),
      onPong: (cb) => conn.onPong(cb),
      ping: () => conn.ping(),
    }, { origin: meta.origin ?? undefined, loopback: meta.loopback, tls: meta.tls, clientIp: meta.clientIp });
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
    // 🟡6：超时 timer 所有路径清理（成功/错误/超时）
    const to = setTimeout(() => { s.destroy(); reject(new Error("upgrade 探测超时")); }, 5_000);
    to.unref?.();
    s.connect(port, "127.0.0.1", () => {
      const lines = ["GET /ws HTTP/1.1", `Host: 127.0.0.1:${port}`, "Upgrade: websocket", "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13"];
      if (origin !== null) lines.push(`Origin: ${origin}`);
      s.write(lines.join("\r\n") + "\r\n\r\n");
    });
    s.on("data", (d) => {
      head += d.toString("latin1");
      const m = /HTTP\/1\.1 (\d{3})/.exec(head);
      if (m) { clearTimeout(to); resolve(Number(m[1])); s.destroy(); }
    });
    s.on("error", (e) => { clearTimeout(to); reject(e); });
    s.on("close", () => clearTimeout(to));
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

/** 轮询等待（真网络异步时序；有界）。 */
async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("until 超时");
    await new Promise((r) => { const t = setTimeout(r, 25); t.unref?.(); });
  }
}

/** 裸 101 握手：读响应头（证明服务端对压缩提议的协商结果；R05/3b-1）。 */
function raw101Headers(port: number, origin: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = new Socket();
    const to = setTimeout(() => { s.destroy(); reject(new Error("raw101 超时")); }, 5_000);
    to.unref?.();
    s.connect(port, "127.0.0.1", () => {
      const lines = ["GET /ws HTTP/1.1", `Host: 127.0.0.1:${port}`, "Upgrade: websocket", "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13", `Origin: ${origin}`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
      s.write(lines.join("\r\n") + "\r\n\r\n");
    });
    s.once("error", (e) => { clearTimeout(to); reject(e); });
    s.once("close", () => { clearTimeout(to); reject(new Error("提前关闭")); });
    s.once("data", (d) => { clearTimeout(to); s.destroy(); resolve(d.toString("latin1")); });
  });
}

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

  it("Origin 精确匹配 → 101 upgrade；客户端提 permessage-deflate → 服务端不协商（R05/3b-1 假绿修复）", async () => {
    const h = await makeHarness();
    await expect(rawUpgrade(h.port, ORIGIN)).resolves.toBe(101);
    // R05：查客户端协商结果 extensions（镜像请求头只能证明客户端提过，不能证明服务端未协商）
    const c = connect(h.url(), { headers: { Origin: ORIGIN }, perMessageDeflate: {} });
    await c.opened;
    expect((c.ws as unknown as { extensions: string }).extensions).toBe(""); // 协商结果=无扩展
    c.ws.close();
    await c.closed;
    // 直接证据：裸握手带扩展提议 → 101 响应不含 sec-websocket-extensions（服务端确实拒绝协商）
    const head = await raw101Headers(h.port, ORIGIN, { "Sec-WebSocket-Extensions": "permessage-deflate; client_max_window_bits" });
    expect(head).toContain("101");
    expect(head.toLowerCase()).not.toContain("sec-websocket-extensions");
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
    // 🟡6：超时 timer 所有路径清理——成功路径必须 clear（旧版 5s 后会销毁已返回给调用方的 socket）
    const to = setTimeout(() => { s.destroy(); reject(new Error("握手超时")); }, 5_000);
    to.unref?.();
    s.connect(port, "127.0.0.1", () => {
      s.write(["GET /ws HTTP/1.1", `Host: 127.0.0.1:${port}`, "Upgrade: websocket", "Connection: Upgrade",
        `Origin: ${origin}`, "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13"].join("\r\n") + "\r\n\r\n");
    });
    s.on("data", (d) => {
      head += d.toString("latin1");
      if (head.includes("\r\n\r\n")) {
        if (head.startsWith("HTTP/1.1 101")) { clearTimeout(to); resolve(s); }
        else { clearTimeout(to); s.destroy(); reject(new Error(`upgrade 失败: ${head.split("\r\n")[0]}`)); }
      }
    });
    s.on("error", (e) => { clearTimeout(to); reject(e); });
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
    // 碎在 😀 代理对中间（UTF-8 4 字节码点第 3 字节处）+ 再碎在「中」第 1B；中间插 ping 控制帧
    const cut1 = 3 + 2; // "前"=3B + 😀前2B
    const cut2 = cut1 + 2 + 1; // 😀后2B + 「中」第1B
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
    await Promise.race([ponged, new Promise((_, rej) => { const t = setTimeout(() => rej(new Error("pong 未触发")), 5_000); t.unref?.(); })]);
    c.ws.close();
    await c.closed;
  });
});

describe("3b-1 真网络：④双门尺寸（真网关组合）", () => {
  it("R05/3b-1 双门字节精度：262,143/262,144B 合法 ping→pong；262,145B → 恰一条新 4404（nonce 关联+基线计数，不靠历史帧充数）", async () => {
    const h = await makeHarness();
    const c = connect(h.url(), { headers: { Origin: ORIGIN }, maxPayload: 2 * 1024 * 1024 });
    await c.opened;
    c.ws.send(hello());
    await until(() => c.frames.some((f) => (f as { t?: string }).t === "welcome"));
    const pingTo = (n: number, tag: string): string => {
      const base = JSON.stringify({ t: "ping", nonce: tag });
      if (Buffer.byteLength(base) > n) throw new Error("填充目标小于基础帧");
      return base + " ".repeat(n - Buffer.byteLength(base)); // JSON 尾随空白合法，总字节恰=n
    };
    const awaitPong = async (tag: string): Promise<void> => {
      await until(() => c.frames.some((f) => (f as { t?: string; nonce?: string }).t === "pong" && (f as { nonce?: string }).nonce === tag));
    };
    c.ws.send(pingTo(LIMITS.frameMaxBytes - 1, "ok-143"));
    c.ws.send(pingTo(LIMITS.frameMaxBytes, "ok-144"));
    await awaitPong("ok-143");
    await awaitPong("ok-144"); // 两档合法字节上界均过应用门（非只免于报错）
    const errBefore = c.frames.filter((f) => (f as { t?: string }).t === "error").length;
    c.ws.send(pingTo(LIMITS.frameMaxBytes + 1, "over-145"));
    await until(() => c.frames.filter((f) => (f as { t?: string }).t === "error").length > errBefore);
    const errs = c.frames.filter((f) => (f as { t?: string }).t === "error");
    expect(errs.length).toBe(errBefore + 1); // 恰一条新 4404（旧历史不充数；删网关字节门变异必挂）
    expect(errs[errs.length - 1]).toMatchObject({ t: "error", code: 4404 });
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

  it("客户端暂停读 → done 不兑现（绑定真实 flush 非立即返回）；恢复读 → done 兑现", async () => {
    const h = await makeHarness();
    const connP = new Promise<WsConnectionPort>((resolve) => { h.adapter.onConnection((conn) => resolve(conn)); });
    const c = connect(h.url(), { headers: { Origin: ORIGIN } });
    await c.opened;
    const conn = await connP;
    const sock = (c.ws as unknown as { _socket: import("node:net").Socket })._socket;
    sock.pause(); // 客户端停读：内核/Node 缓冲堆满后 flush 真实受阻
    let doneCount = 0;
    let sentCount = 0;
    const big = "p".repeat(256 * 1024);
    let settle: (() => void) | undefined;
    const finish = (): void => { settle?.(); };
    const sendP = new Promise<void>((resolve) => { settle = resolve; });
    const sendSerial = (): void => {
      // 串行发直到 16MB 或传输缓冲堆高（4MiB）：暂停读下必然出现「已发出但未 flush」
      if (sentCount >= 64 || conn.bufferedAmount > 4 * 1024 * 1024) { finish(); return; }
      sentCount++;
      conn.send(big, () => { doneCount++; if (sentCount >= 64 || conn.bufferedAmount > 4 * 1024 * 1024) { finish(); return; } sendSerial(); });
    };
    sendSerial();
    await new Promise<void>((r) => setTimeout(r, 800));
    expect(doneCount).toBeLessThan(sentCount); // 存在未 flush 的发送：立即返回型实现在此暴露
    sock.resume();
    await Promise.race([sendP, new Promise((_, rej) => { const t = setTimeout(() => rej(new Error("恢复读后 done 未兑现")), 5_000); t.unref?.(); })]);
    expect(doneCount).toBeGreaterThanOrEqual(1);
    c.ws.close();
    await c.closed;
  });

  it("背压下 done 等真实 flush（64KB 大消息×多，客户端持续读取）", async () => {
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

  it("R01/3b-1 宿主回调抛错不退进程：message/pong/send-done 隔离+审计；连接不受影响", async () => {
    const audits: string[] = [];
    const adapter = new WsServerAdapter({ allowedOrigins: [ORIGIN], audit: (l) => audits.push(l) });
    const connP = new Promise<WsConnectionPort>((resolve) => {
      adapter.onConnection((conn) => {
        conn.onMessage(() => { throw new Error("message-cb-boom"); });
        conn.onPong(() => { throw new Error("pong-cb-boom"); });
        conn.onError(() => { throw new Error("error-cb-boom"); });
        resolve(conn);
      });
    });
    const { port } = await adapter.listen(0, "127.0.0.1");
    harnesses.push(async () => { await adapter.dispose(); });
    const c = connect(`ws://127.0.0.1:${port}`, { headers: { Origin: ORIGIN } });
    await c.opened;
    const conn = await connP;
    c.ws.send("text-frame"); // message 回调抛错→审计隔离，连接仍在
    conn.ping();
    await until(() => audits.some((l) => l.includes("message-cb-error")));
    await until(() => audits.some((l) => l.includes("pong-cb-error")));
    // send-done 抛错→隔离；后续 send 正常
    await new Promise<void>((resolve) => { conn.send("x", () => { throw new Error("done-cb-boom"); }); setTimeout(resolve, 150); });
    await until(() => audits.some((l) => l.includes("send-done-cb-error")));
    const ok = await new Promise<Error | null>((resolve) => conn.send("y", (err) => resolve(err ?? null)));
    expect(ok).toBeNull();
    c.ws.close();
    await c.closed;
  });

  it("R01/3b-1 超限触发接收器 error：error 回调抛错隔离不退进程，连接达终局（1009）；审计+触发计数可观测（3b1b 强化）", async () => {
    const audits: string[] = [];
    let errorCbFired = 0;
    const adapter = new WsServerAdapter({ allowedOrigins: [ORIGIN], audit: (l) => audits.push(l) });
    adapter.onConnection((conn) => {
      conn.onError(() => { errorCbFired += 1; throw new Error("error-cb-boom"); }); // 接收器 error 后的错误回调抛错也须隔离
    });
    const { port } = await adapter.listen(0, "127.0.0.1");
    harnesses.push(async () => { await adapter.dispose(); });
    const c = connect(`ws://127.0.0.1:${port}`, { headers: { Origin: ORIGIN } });
    await c.opened;
    c.ws.send("z".repeat(LIMITS.transportMaxPayloadBytes + 1));
    const info = await c.closed; // 超限→接收器 close 1009（回调抛错不得阻断终局）
    expect(info.code).toBe(1009);
    // 3b1b：不能只断终局——隔离审计与宿主回调触发本身也要可观测（防「删宿主 error 通知后仍存活」变异）
    expect(errorCbFired).toBeGreaterThanOrEqual(1);
    expect(audits.some((l) => l.includes("error-cb-error"))).toBe(true);
  });

  it("B3/3b1b 同轮交错：listen 启动中 dispose → 启动 Promise 显式拒绝，两 Promise 均收敛，无残留监听", async () => {
    const adapter = new WsServerAdapter({ allowedOrigins: [ORIGIN], disposeWaitMs: 200, audit: () => {} });
    const starting = adapter.listen(0, "127.0.0.1");
    const stopping = adapter.dispose();
    await expect(starting).rejects.toThrow(/监听启动中止|dispose/);
    await stopping; // dispose 正常收敛
    await expect(adapter.listen(0, "127.0.0.1")).rejects.toThrow(/dispose/); // 终态不复活
  });

  it("B3/3b1b 启动失败后 dispose：监听撞端口→拒绝；dispose 仍正常收敛；重复 dispose 幂等", async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", () => r()));
    const bp = (blocker.address() as AddressInfo).port;
    try {
      const adapter = new WsServerAdapter({ allowedOrigins: [ORIGIN], disposeWaitMs: 200, audit: () => {} });
      await expect(adapter.listen(bp, "127.0.0.1")).rejects.toThrow(/EADDRINUSE/);
      await adapter.dispose();
      await adapter.dispose(); // 幂等（同一 promise）
    } finally {
      blocker.close();
    }
  });

  it("C1/3b1c 单次取消：listen 启动中 dispose → 临时监听器全部摘除（error/listening 计数归零）", async () => {
    const adapter = new WsServerAdapter({ allowedOrigins: [ORIGIN], disposeWaitMs: 200, audit: () => {} });
    const server = (adapter as unknown as { ownServer: Server }).ownServer;
    const before = { err: server.listenerCount("error"), lis: server.listenerCount("listening") };
    const starting = adapter.listen(0, "127.0.0.1");
    const stopping = adapter.dispose();
    await expect(starting).rejects.toThrow(/监听启动中止|dispose/);
    await stopping;
    // GPT 3b1c C1 探针：旧实现残留 error +1/listening +1（取消分支不摘临时监听器）
    expect(server.listenerCount("error")).toBe(before.err);
    expect(server.listenerCount("listening")).toBe(before.lis);
  });

  it("C1/3b1c 重复启动拒绝：启动中/同步参数错误的二次 listen 均拒且不破坏首次启动的结算", async () => {
    const adapter = new WsServerAdapter({ allowedOrigins: [ORIGIN], disposeWaitMs: 200, audit: () => {} });
    const p = adapter.listen(0, "127.0.0.1");
    await expect(adapter.listen(0, "127.0.0.1")).rejects.toThrow(/启动中/); // 并发重复：拒绝（不覆盖槽）
    await expect(adapter.listen(-1, "127.0.0.1")).rejects.toThrow(/启动中/); // 同步参数错误同轮也不碰首次启动
    const stopping = adapter.dispose();
    await expect(p).rejects.toThrow(/监听启动中止/); // 首次启动仍可被 dispose 结算（不悬空）
    await stopping;
  });

  it("C1/3b1c 已监听后重复 listen 拒绝；失败后顺序重试可正常获得端口", async () => {
    // 同步参数错误自身拒绝（ERR_SOCKET_BAD_PORT 同步 throw 路径）→ 槽位清理 → 顺序重试成功
    const adapter = new WsServerAdapter({ allowedOrigins: [ORIGIN], disposeWaitMs: 200, audit: () => {} });
    await expect(adapter.listen(-1, "127.0.0.1")).rejects.toThrow(/port|RangeError/i);
    const r1 = await adapter.listen(0, "127.0.0.1"); // 失败后顺序重试：正常监听
    await expect(adapter.listen(0, "127.0.0.1")).rejects.toThrow(/已在监听/); // 成功后重复：拒绝
    await adapter.dispose();
    await expect(adapter.listen(r1.port, "127.0.0.1")).rejects.toThrow(/dispose/); // 终态不复活
  });

  it("R4/3b1b binary 真网络回归（真 adapter+真 gateway 组合）：已认证连接发二进制→error 4403+close 1003", async () => {
    const h = await makeHarness();
    const c = connect(h.url(), { headers: { Origin: ORIGIN } });
    await c.opened;
    c.ws.send(JSON.stringify({ t: "hello", protocolVersion: 1, token: TOKEN }));
    await until(() => c.frames.some((f) => f.t === "welcome"));
    c.ws.send(Buffer.from([0x01, 0x02, 0x03])); // 二进制帧→4403+close 1003（R4 冻结映射）
    await until(() => c.frames.some((f) => f.code === 4403));
    const info = await c.closed;
    expect(info.code).toBe(1003);
  });
});

describe("3b-1 真网络：⑥token 三态（真 TokenAuthority 组合）", () => {
  it("启动缺失令牌文件 → 构造失败（fail-closed 拒启动）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-token-"));
    tmpDirs.push(dir);
    await expect(TokenAuthority.fromFile(join(dir, "missing.json"))).rejects.toThrow();
  });

  it("R05/3b-1 真轮换：A/B 双令牌在线；撤销 A→A 连接 4401+close 1008、B 存活；重载失败→保守沿用旧基准", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-token2-"));
    tmpDirs.push(dir);
    const path = join(dir, "tokens.json");
    await writeFile(path, JSON.stringify({ version: 1, tokens: ["tok-A", "tok-B"] }), "utf8");
    const audits: string[] = [];
    const tokens = await TokenAuthority.fromFile(path, {}, (l) => audits.push(l));
    const gateway = new WsGateway({ tokens, allowedOrigins: [ORIGIN], source: { load: async () => null }, audit: (l) => audits.push(l), idleMs: 60_000, maxLifetimeMs: 120_000 });
    const adapter = new WsServerAdapter({ allowedOrigins: [ORIGIN], audit: (l) => audits.push(l) });
    adapter.onConnection((conn, meta) => {
      gateway.attach(conn, { onMessage: (cb) => conn.onMessage(cb), onClose: (cb) => conn.onClose(cb), onPong: (cb) => conn.onPong(cb), ping: () => conn.ping() }, { origin: meta.origin ?? undefined, loopback: meta.loopback, tls: meta.tls, clientIp: meta.clientIp });
    });
    const { port } = await adapter.listen(0, "127.0.0.1");
    harnesses.push(async () => { await adapter.dispose(); await gateway.dispose(); });
    const url = `ws://127.0.0.1:${port}`;
    // A/B 双连接均在线认证
    const cA = connect(url, { headers: { Origin: ORIGIN } });
    await cA.opened;
    cA.ws.send(hello("tok-A"));
    await until(() => cA.frames.some((f) => (f as { t?: string }).t === "welcome"));
    const cB = connect(url, { headers: { Origin: ORIGIN } });
    await cB.opened;
    cB.ws.send(hello("tok-B"));
    await until(() => cB.frames.some((f) => (f as { t?: string }).t === "welcome"));
    // welcome 含 serverBuildId（R6/3b-1 兼容条款）
    const wB = cB.frames.find((f) => (f as { t?: string }).t === "welcome") as { serverBuildId?: string };
    expect(typeof wB?.serverBuildId === "string" && wB.serverBuildId.length > 0).toBe(true);
    // 真轮换：撤 A 留 B → A 连接被关（4401+1008），B 存活且可交互
    await writeFile(path, JSON.stringify({ version: 1, tokens: ["tok-B"] }), "utf8");
    await gateway.applyTokenReload();
    const closeA = await cA.closed;
    expect(closeA.code).toBe(1008);
    expect(cA.frames.some((f) => (f as { t?: string; code?: number }).t === "error" && (f as { code?: number }).code === 4401)).toBe(true);
    cB.ws.send(JSON.stringify({ t: "ping", nonce: "after-revoke" }));
    await until(() => cB.frames.some((f) => (f as { t?: string; nonce?: string }).t === "pong" && (f as { nonce?: string }).nonce === "after-revoke"));
    // 重载失败（非法 JSON）→保守沿用旧基准（fail-soft：resolve {changed:false}+审计）：B 仍可认证，A 仍拒
    await writeFile(path, "{corrupt", "utf8");
    await expect(gateway.applyTokenReload()).resolves.toBeUndefined();
    await until(() => audits.some((l) => l.includes("token-reload-failed")));
    const cB2 = connect(url, { headers: { Origin: ORIGIN } });
    await cB2.opened;
    cB2.ws.send(hello("tok-B"));
    await until(() => cB2.frames.some((f) => (f as { t?: string }).t === "welcome"));
    const cA2 = connect(url, { headers: { Origin: ORIGIN } });
    await cA2.opened;
    cA2.ws.send(hello("tok-A"));
    await until(() => cA2.frames.some((f) => (f as { t?: string }).t === "error"));
    const closeA2 = await cA2.closed;
    expect(closeA2.code).toBe(1008);
    cB.ws.close(); cB2.ws.close();
    await Promise.all([cB.closed, cB2.closed]);
  });

  it("错令牌连接被拒：4401→close 1008（固定消息不回显令牌）", async () => {
    const h = await makeHarness();
    const c = connect(h.url(), { headers: { Origin: ORIGIN } });
    await c.opened;
    c.ws.send(hello("wrong-token-value"));
    const closed = await c.closed;
    expect(closed.code).toBe(1008);
    expect(c.frames.some((f) => (f as { t?: string; code?: number }).t === "error" && (f as { code?: number }).code === 4401)).toBe(true);
    expect(c.frames.every((f) => !JSON.stringify(f).includes("wrong-token-value"))).toBe(true); // 不回显
  });

  it("R6/3b-1 per-IP 认证失败限速+退避（真网络）：达限→封锁内正确令牌也拒；过期→恢复", async () => {
    const h = await makeHarness({ authRate: { limit: 3, windowMs: 60_000, baseBlockMs: 200, maxBlockMs: 400 } });
    // 三次失败（新连接各一次；同 IP=loopback）
    for (let i = 0; i < 3; i++) {
      const c = connect(h.url(), { headers: { Origin: ORIGIN } });
      await c.opened;
      c.ws.send(hello("bad"));
      const closed = await c.closed;
      expect(closed.code).toBe(1008);
    }
    await until(() => h.audits.some((l) => l.includes("auth-rate-blocked")));
    // 封锁内：正确令牌也拒（4401 限速）
    const c4 = connect(h.url(), { headers: { Origin: ORIGIN } });
    await c4.opened;
    c4.ws.send(hello()); // 正确令牌
    await until(() => c4.frames.some((f) => (f as { t?: string }).t === "error"));
    expect(c4.frames.some((f) => (f as { t?: string; message?: string }).t === "error" && String((f as { message?: string }).message).includes("限速"))).toBe(true);
    const closed4 = await c4.closed;
    expect(closed4.code).toBe(1008);
    // 过期后（200ms 封锁）→正常客户端可认证且不再受限
    await new Promise((r) => { const t = setTimeout(r, 260); t.unref?.(); });
    const c5 = connect(h.url(), { headers: { Origin: ORIGIN } });
    await c5.opened;
    c5.ws.send(hello());
    await until(() => c5.frames.some((f) => (f as { t?: string }).t === "welcome"));
    c5.ws.close();
    await c5.closed;
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

  it("R02/3b-1 普通 GET → 404 应答（自建 server 管未升级连接）；不读不关的裸 socket 不挂 dispose（整体有界）", async () => {
    const h = await makeHarness({ disposeWaitMs: 300 });
    // 普通 GET：立即 404+Connection: close（不留悬挂句柄）
    const got = await new Promise<string>((resolve, reject) => {
      const s = new Socket();
      const to = setTimeout(() => { s.destroy(); reject(new Error("GET 超时")); }, 5_000);
      to.unref?.();
      s.connect(h.port, "127.0.0.1", () => s.write(`GET / HTTP/1.1\r\nHost: x\r\n\r\n`));
      s.once("data", (d) => { clearTimeout(to); s.destroy(); resolve(d.toString("latin1")); });
      s.once("error", (e) => { clearTimeout(to); reject(e); });
    });
    expect(got).toContain("404");
    expect(got.toLowerCase()).toContain("connection: close");
    // 故意不读不关的裸连接（发半截请求后挂着）：dispose 不得被它拖住，且截止后须被强制销毁（不能只是忽略它）
    const hold = new Socket();
    await new Promise<void>((resolve) => { hold.connect(h.port, "127.0.0.1", () => resolve()); });
    hold.write("GET / HTTP/1.1\r\nHost: x\r\n"); // 不发完，也不关
    const holdClosed = new Promise<void>((resolve) => { hold.once("close", resolve); hold.once("error", resolve); });
    const t0 = Date.now();
    await h.dispose();
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(3_000); // 有界（300ms 预算+余量）；无管理时 server.close() 会永久 pending
    // 截止后 socket 被强制销毁（防「返回了但句柄泄着」：否则端口/连接泄漏仍在）
    await Promise.race([holdClosed, new Promise((_, rej) => { const t = setTimeout(() => rej(new Error("截止后未销毁持有的 socket")), 3_000); t.unref?.(); })]);
  });

  it("R02/3b-1 dispose 后 listen() 拒绝（终态不复活）", async () => {
    const adapter = new WsServerAdapter({ allowedOrigins: [ORIGIN], audit: () => {} });
    const { port } = await adapter.listen(0, "127.0.0.1");
    await adapter.dispose();
    await expect(adapter.listen(port, "127.0.0.1")).rejects.toThrow(/dispose/);
  });

  it("R02/3b-1 接收器自启关闭同截止：真暂停读的客户端在 closeHandshakeMs 内被 terminate（服务端终局时延）", async () => {
    const h = await makeHarness({ closeHandshakeMs: 400 });
    // GPT 3b1b B4：旧裸 socket 例的客户端会正常应答 FIN，TCP 层自然收口——不经过 ws closeTimeout，假绿。
    // 正确夹具：真 ws 客户端建立后暂停底层读（close 帧永远得不到应答），观测服务端终局时延与关闭码。
    let serverClosed: ((v: { at: number; code: number }) => void) | null = null;
    const serverClosedP = new Promise<{ at: number; code: number }>((r) => { serverClosed = r; });
    h.adapter.onConnection((conn) => { conn.onClose((code) => { serverClosed?.({ at: Date.now(), code }); }); });
    const c = connect(h.url(), { headers: { Origin: ORIGIN } });
    await c.opened;
    const sock = (c.ws as unknown as { _socket: Socket })._socket; // ws 客户端底层 socket
    sock.pause(); // 暂停读：服务端 close(1009) 握手永完不成，只能靠截止 terminate
    const t0 = Date.now();
    try {
      c.ws.send(Buffer.alloc(LIMITS.transportMaxPayloadBytes + 1, 0x61)); // 超限→服务端接收器 error→自启 close
      // C3（3b1c）：显式有界等待（vitest 5s 超时是兕底而非主证据；断言失败路径也走 finally 清理）
      const fin = await Promise.race([
        serverClosedP,
        new Promise<never>((_, rej) => { const to = setTimeout(() => rej(new Error("服务端终局未在 4s 内到达")), 4_000); to.unref?.(); }),
      ]);
      expect(fin.code).toBe(1006); // 异常关闭（terminate），非优雅握手收口
      const elapsed = fin.at - t0;
      // closeHandshakeMs=400：须在截止+余量内完成（closeTimeout→30s 变异在此被杀；实际失败方式=4s 有界等待超限）
      expect(elapsed).toBeLessThan(2_400);
      expect(elapsed).toBeGreaterThan(300); // 不是瞬时 TCP 收口（排除假绿路径：正常 FIN 应答会在毫秒级完成）
    } finally {
      // 失败/超时路径同样清理：恢复读+终止客户端，防已暂停的 socket 挂住夹具
      sock.resume();
      try { c.ws.terminate(); } catch { /* 已关 */ }
      await c.closed.catch(() => {});
    }
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
