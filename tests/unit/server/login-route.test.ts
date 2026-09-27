// N4-v2 登录面单测 + r1 修复批矩阵（GPT 审 B1-B5/C2/C4）。
// 覆盖：POST /login 成功（cookie 旗标逐项）/坏令牌 401/限速（滑窗+退避+并发在途+满表淘汰）/登出/非面让路/
// 坏体（非 JSON/JSON null/超体/超时）/sid 身份（B2 sessionIdentityOf=摘要 hex）/parseSessionCookie（B3 同名重复拒）/
// B1 代理矩阵（XFF/XFP 采信与拒绝、Secure 派生、TLS 门、限速隔离、loopback 代理豁免陷阱）/
// B5 来源门（异源 403/缺 Origin 仅 loopback/非 JSON 媒体 415/异源 logout 403）。
import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { TLSSocket } from "node:tls";
import { Socket } from "node:net";
import { createLoginRoute, parseSessionCookie, deriveSid, type LoginRouteOpts } from "../../../apps/server/src/http/login-route.ts";
import { TokenAuthority } from "../../../apps/server/src/ws/token-auth.ts";
import { createHash } from "node:crypto";

const SECRET = Buffer.alloc(32, 7);
const ORIGIN = "http://localhost:4173";

/** 受控假请求：body 默认微任务自动投递；autoBody=false 时测试手动 data/end（B4 并发/超时例）。 */
class FakeReq extends EventEmitter {
  url: string;
  method: string;
  headers: Record<string, string>;
  socket: { remoteAddress: string };
  constructor(method: string, url: string, body: string, over: { tls?: boolean; headers?: Record<string, string>; remote?: string; autoBody?: boolean } = {}) {
    super();
    this.method = method;
    this.url = url;
    this.headers = { "content-type": "application/json", ...(over.headers ?? {}) };
    this.socket = over.tls === true ? new TLSSocket(new Socket()) : ({ remoteAddress: over.remote ?? "127.0.0.1" } as Socket);
    if (over.autoBody !== false) {
      queueMicrotask(() => {
        if (body.length > 0) this.emit("data", Buffer.from(body, "utf8"));
        this.emit("end");
      });
    }
  }
  destroy(): void { this.destroyed = true; }
  destroyed = false;
}

class FakeRes {
  code = 0;
  headers: Record<string, string | string[]> = {};
  body = "";
  headersSent = false;
  writeHead(code: number, headers: Record<string, string>): void {
    if (this.headersSent) throw new Error("headersSent 后再 writeHead");
    this.code = code;
    this.headers = headers;
  }
  end(payload?: string): void {
    this.headersSent = true;
    if (payload !== undefined) this.body = payload;
  }
}

interface Call { code: number; headers: Record<string, string>; body: string; }

async function callRoute(route: ReturnType<typeof createLoginRoute>, method: string, url: string, body: string, over: { tls?: boolean; headers?: Record<string, string>; remote?: string; autoBody?: boolean } = {}): Promise<Call | null> {
  const res = new FakeRes();
  const handled = route.handle(new FakeReq(method, url, body, over) as never, res as never);
  if (!handled) return null;
  await new Promise((r) => setTimeout(r, 15));
  return { code: res.code, headers: res.headers as Record<string, string>, body: res.body };
}

function makeRoute(over: Partial<LoginRouteOpts> = {}, tokens: readonly string[] = ["tok-ok"]): { route: ReturnType<typeof createLoginRoute>; audits: string[]; authority: TokenAuthority } {
  const audits: string[] = [];
  const authority = TokenAuthority.fromTokens(tokens);
  const route = createLoginRoute({ authority, sessionSecret: SECRET, audit: (l) => { audits.push(l); }, allowedOrigins: [ORIGIN], ...over });
  return { route, audits, authority };
}

const sidOfToken = (token: string): string => deriveSid(SECRET, createHash("sha256").update(token, "utf8").digest("hex"));
const digestOf = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");

describe("login-route N4-v2（r1 修复批后）", () => {
  it("L1 登录成功：200+Set-Cookie 逐旗标（HttpOnly/SameSite=Strict/Path=/；loopback 明文无 Secure）+sid 身份可验", async () => {
    const { route, audits } = makeRoute();
    const out = await callRoute(route, "POST", "/login", JSON.stringify({ token: "tok-ok" }));
    expect(out?.code).toBe(200);
    const sc = out?.headers["Set-Cookie"] as string;
    expect(sc).toContain("HttpOnly");
    expect(sc).toContain("SameSite=Strict");
    expect(sc).toContain("Path=/");
    expect(sc).not.toContain("Secure");
    expect(sc).not.toContain("tok-ok");
    expect(route.sessionIdentityOf(sc.split("=")[1]?.split(";")[0] ?? null)).toBe(digestOf("tok-ok")); // B2：身份=token 摘要 hex
    expect(audits.some((l) => l.startsWith("login-ok"))).toBe(true);
    expect(audits.join("\n")).not.toContain("tok-ok");
  });

  it("L2 TLS 事实→Secure 旗标（TLSSocket socket）", async () => {
    const { route } = makeRoute();
    const out = await callRoute(route, "POST", "/login", JSON.stringify({ token: "tok-ok" }), { tls: true, headers: { origin: ORIGIN } });
    expect(out?.code).toBe(200);
    expect(out?.headers["Set-Cookie"] as string).toContain("Secure");
  });

  it("L3 限速（r1-B4）：滑窗时间戳+退避——3 败后第 4 次 429；封锁期不延长；期满恢复；成功清户", async () => {
    let t = 0;
    const { route } = makeRoute({ rateMaxFailures: 3, rateWindowMs: 1_000, rateBaseBlockMs: 2_000, now: () => t });
    for (let i = 0; i < 3; i += 1) {
      const out = await callRoute(route, "POST", "/login", JSON.stringify({ token: "bad" }));
      expect(out?.code).toBe(401); // 触发封锁的那次仍是 401（记账后封锁）
    }
    t = 100; // 封锁期内：429 且不记账不延长
    expect((await callRoute(route, "POST", "/login", JSON.stringify({ token: "bad" })))?.code).toBe(429);
    t = 2_050; // 封锁期满（滑窗内失败已清空）→ 再失败重新计数
    expect((await callRoute(route, "POST", "/login", JSON.stringify({ token: "bad" })))?.code).toBe(401);
    t = 2_060;
    const ok = await callRoute(route, "POST", "/login", JSON.stringify({ token: "tok-ok" }));
    expect(ok?.code).toBe(200); // 成功清户：后续不受历史影响
    t = 2_070;
    expect((await callRoute(route, "POST", "/login", JSON.stringify({ token: "tok-ok" })))?.code).toBe(200);
  });

  it("L3b 滑窗边界：t=0/999/999 三败→t=1000 第 4 次 429（旧固定窗会放行 1ms 内五次）", async () => {
    let t = 0;
    const { route } = makeRoute({ rateMaxFailures: 3, rateWindowMs: 1_000, rateBaseBlockMs: 5_000, now: () => t });
    for (const at of [0, 999, 999]) {
      t = at;
      expect((await callRoute(route, "POST", "/login", JSON.stringify({ token: "bad" })))?.code).toBe(401);
    }
    t = 1000;
    expect((await callRoute(route, "POST", "/login", JSON.stringify({ token: "bad" })))?.code).toBe(429);
  });

  it("L4 登出：200+Max-Age=0+HttpOnly（清 cookie；属性随有效 TLS）", async () => {
    const { route, audits } = makeRoute();
    const out = await callRoute(route, "POST", "/logout", "");
    expect(out?.code).toBe(200);
    expect(out?.headers["Set-Cookie"] as string).toContain("Max-Age=0");
    expect(out?.headers["Set-Cookie"] as string).toContain("HttpOnly");
    expect(audits.some((l) => l.startsWith("logout"))).toBe(true);
  });

  it("L5 非面让路：GET /login 与 POST /other→null", async () => {
    const { route } = makeRoute();
    expect(await callRoute(route, "GET", "/login", "")).toBeNull();
    expect(await callRoute(route, "POST", "/other", "{}")).toBeNull();
  });

  it("L6 坏体：非 JSON→400；JSON null→400（r1-C2）；token 类型错→401；超体→413；body 超时→408", async () => {
    const { route } = makeRoute({ bodyTimeoutMs: 30 });
    expect((await callRoute(route, "POST", "/login", "not-json"))?.code).toBe(400);
    expect((await callRoute(route, "POST", "/login", "null"))?.code).toBe(400);
    expect((await callRoute(route, "POST", "/login", JSON.stringify({ token: 123 })))?.code).toBe(401);
    expect((await callRoute(route, "POST", "/login", JSON.stringify({ token: "x".repeat(5_000) })))?.code).toBe(413);
    // 超时：autoBody=false——不投递 body，30ms 后 408（直持 res 等超时窗过）
    const resT = new FakeRes();
    route.handle(new FakeReq("POST", "/login", "", { autoBody: false }) as never, resT as never);
    await new Promise((r) => setTimeout(r, 60));
    expect(resT.code).toBe(408);
  });

  it("L7 sid 身份（r1-B2）：真 sid→token 摘要 hex；篡改/形态/未知派生→null；热轮换后旧 sid 失效+新 sid 生效", async () => {
    const { route } = makeRoute();
    const sid = sidOfToken("tok-ok");
    expect(route.sessionIdentityOf(sid)).toBe(digestOf("tok-ok"));
    expect(route.sessionIdentityOf(sid.slice(0, 63))).toBeNull();
    expect(route.sessionIdentityOf("zz".repeat(32))).toBeNull();
    expect(route.sessionIdentityOf(sidOfToken("unknown"))).toBeNull();
    // 轮换：另一 authority（新集合 tok-new）
    const r2 = makeRoute({}, ["tok-new"]);
    expect(r2.route.sessionIdentityOf(sid)).toBeNull();
    expect(r2.route.sessionIdentityOf(sidOfToken("tok-new"))).toBe(digestOf("tok-new"));
    expect(route.validateSid(sid)).toBe(true); // 布尔包装仍可用
  });

  it("L8 异 secret 隔离：同 sid 异钥不认", async () => {
    const audits2: string[] = [];
    const route2 = createLoginRoute({ authority: TokenAuthority.fromTokens(["tok-ok"]), sessionSecret: Buffer.alloc(32, 9), audit: (l) => { audits2.push(l); }, allowedOrigins: [ORIGIN] });
    expect(route2.sessionIdentityOf(sidOfToken("tok-ok"))).toBeNull();
  });

  it("L9 弱钥：secret<32B 构造即抛", () => {
    expect(() => createLoginRoute({ authority: TokenAuthority.fromTokens(["t"]), sessionSecret: Buffer.alloc(16), audit: () => {}, allowedOrigins: [ORIGIN] })).toThrow();
  });

  it("L10 parseSessionCookie：缺/数组/空值/同名重复（r1-B3：同值重复也拒）/无关 cookie+具名恰一次 OK", () => {
    expect(parseSessionCookie(undefined)).toBeNull();
    expect(parseSessionCookie(["a=1"] as never)).toBeNull();
    expect(parseSessionCookie("pi-agent-ui-session=")).toBeNull();
    expect(parseSessionCookie("pi-agent-ui-session=abc; pi-agent-ui-session=abc")).toBeNull(); // 同名同值重复=歧义
    expect(parseSessionCookie("pi-agent-ui-session=abc; pi-agent-ui-session=def")).toBeNull(); // 同名异值重复
    expect(parseSessionCookie("other=1; pi-agent-ui-session=abc; foo=2")).toBe("abc"); // 恰一次
  });

  it("L11 审计面：rejected/limited 行落且无令牌原文", async () => {
    const { route, audits } = makeRoute({ rateMaxFailures: 1, rateWindowMs: 60_000, rateBaseBlockMs: 60_000 });
    await callRoute(route, "POST", "/login", JSON.stringify({ token: "bad-secret-token" }));
    await callRoute(route, "POST", "/login", JSON.stringify({ token: "bad-secret-token" })); // 第 2 次→429
    const joined = audits.join("\n");
    expect(joined).toContain("login-rejected");
    expect(joined).toContain("login-rate-limited");
    expect(joined).not.toContain("bad-secret-token");
  });
});

describe("login-route r1-B1：可信代理/Secure/TLS 门/限速隔离", () => {
  const proxyOver = { remote: "10.0.0.9", headers: { origin: ORIGIN, "x-forwarded-for": "203.0.113.7", "x-forwarded-proto": "https" } };

  it("B1a 可信代理 XFP=https→有效 TLS：200+Secure+login-ok clientIp=203.0.113.7", async () => {
    const { route, audits } = makeRoute({ trustedProxies: ["10.0.0.9"] });
    const out = await callRoute(route, "POST", "/login", JSON.stringify({ token: "tok-ok" }), proxyOver);
    expect(out?.code).toBe(200);
    expect(out?.headers["Set-Cookie"] as string).toContain("Secure");
    expect(audits.some((l) => l.includes("clientIp=203.0.113.7") && l.includes("secure=true"))).toBe(true);
  });

  it("B1b 可信代理 XFP=http→非 loopback 明文：403 tls-required（拒收令牌）", async () => {
    const { route, audits } = makeRoute({ trustedProxies: ["10.0.0.9"] });
    const out = await callRoute(route, "POST", "/login", JSON.stringify({ token: "tok-ok" }), { ...proxyOver, headers: { ...proxyOver.headers, "x-forwarded-proto": "http" } });
    expect(out?.code).toBe(403);
    expect(audits.some((l) => l.includes("login-tls-required"))).toBe(true);
  });

  it("B1c 不可信代理：XFF/XFP 不采信——对端 10.0.0.9 视为客户端，明文非 loopback→403", async () => {
    const { route } = makeRoute(); // 无 trustedProxies
    const out = await callRoute(route, "POST", "/login", JSON.stringify({ token: "tok-ok" }), proxyOver);
    expect(out?.code).toBe(403);
  });

  it("B1d 限速隔离：XFF=A 封锁后 XFF=B 不受影响（代理后不共桶）", async () => {
    let t = 0;
    const { route } = makeRoute({ trustedProxies: ["10.0.0.9"], rateMaxFailures: 1, rateWindowMs: 60_000, rateBaseBlockMs: 60_000, now: () => t });
    for (let i = 0; i < 2; i += 1) {
      await callRoute(route, "POST", "/login", JSON.stringify({ token: "bad" }), { ...proxyOver, headers: { ...proxyOver.headers, "x-forwarded-for": "198.51.100.1" } });
    }
    t = 10;
    const outB = await callRoute(route, "POST", "/login", JSON.stringify({ token: "tok-ok" }), { ...proxyOver, headers: { ...proxyOver.headers, "x-forwarded-for": "198.51.100.2" } });
    expect(outB?.code).toBe(200);
    const outA = await callRoute(route, "POST", "/login", JSON.stringify({ token: "tok-ok" }), { ...proxyOver, headers: { ...proxyOver.headers, "x-forwarded-for": "198.51.100.1" } });
    expect(outA?.code).toBe(429);
  });

  it("B1e 代理源=loopback 且 XFF 外部：不把代理源当外部用户的 localhost 豁免——TLS 需求按 XFP 判", async () => {
    const { route } = makeRoute({ trustedProxies: ["127.0.0.1"] });
    const over = { headers: { origin: ORIGIN, "x-forwarded-for": "8.8.8.8", "x-forwarded-proto": "https" } };
    const out = await callRoute(route, "POST", "/login", JSON.stringify({ token: "tok-ok" }), over);
    expect(out?.code).toBe(200); // XFP=https 满足 TLS 门→放行+Secure
    expect(out?.headers["Set-Cookie"] as string).toContain("Secure");
    const overHttp = { headers: { origin: ORIGIN, "x-forwarded-for": "8.8.8.8", "x-forwarded-proto": "http" } };
    const out2 = await callRoute(route, "POST", "/login", JSON.stringify({ token: "tok-ok" }), overHttp);
    expect(out2?.code).toBe(403); // 明文外部→拒
  });

  it("B1f 非 loopback 直连明文（无代理头）：403 tls-required", async () => {
    const { route } = makeRoute();
    const out = await callRoute(route, "POST", "/login", JSON.stringify({ token: "tok-ok" }), { remote: "192.168.1.5", headers: { origin: ORIGIN } });
    expect(out?.code).toBe(403);
  });
});

describe("login-route r1-B4：并发在途预算+读后复核", () => {
  it("B4a 在途预算：同 IP 第 3 个未完成 body→立即 429（不消耗失败记账）", async () => {
    const { route, audits } = makeRoute({ inflightBodies: 2 });
    const mk = (): FakeReq => new FakeReq("POST", "/login", "", { autoBody: false, headers: { origin: ORIGIN } });
    const res1 = new FakeRes(); const res2 = new FakeRes(); const res3 = new FakeRes();
    expect(route.handle(mk() as never, res1 as never)).toBe(true);
    expect(route.handle(mk() as never, res2 as never)).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(route.handle(mk() as never, res3 as never)).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(res3.code).toBe(429); // inflight-capped（早退——未读 body）
    expect(audits.some((l) => l.includes("login-inflight-capped"))).toBe(true);
  });

  it("B4b 读后复核：两并发同 IP，A 失败记账→B body 完成后同步复核→429（旧代码 B 也 401）", async () => {
    const { route } = makeRoute({ inflightBodies: 4, rateMaxFailures: 1, rateBaseBlockMs: 60_000 });
    const mk = (): FakeReq => new FakeReq("POST", "/login", "", { autoBody: false, headers: { origin: ORIGIN } });
    const reqA = mk(); const resA = new FakeRes();
    const reqB = mk(); const resB = new FakeRes();
    route.handle(reqA as never, resA as never);
    route.handle(reqB as never, resB as never);
    await new Promise((r) => setTimeout(r, 5));
    reqA.emit("data", Buffer.from(JSON.stringify({ token: "bad" }))); reqA.emit("end");
    await new Promise((r) => setTimeout(r, 10));
    expect(resA.code).toBe(401);
    reqB.emit("data", Buffer.from(JSON.stringify({ token: "tok-ok" }))); reqB.emit("end"); // 好令牌也过不了复核门
    await new Promise((r) => setTimeout(r, 15));
    expect(resB.code).toBe(429);
  });

  it("B4c 满表淘汰：rateMapMax=2，表满后新 IP 仍可登录（有界不炸）+封锁审计落", async () => {
    const { route, audits } = makeRoute({ rateMapMax: 2, rateMaxFailures: 1, rateBaseBlockMs: 60_000, trustedProxies: ["127.0.0.1"] });
    for (const ip of ["203.0.113.1", "203.0.113.2"]) {
      for (let i = 0; i < 2; i += 1) {
        await callRoute(route, "POST", "/login", JSON.stringify({ token: "bad" }), { headers: { origin: ORIGIN, "x-forwarded-for": ip, "x-forwarded-proto": "https" } });
      }
    }
    const out = await callRoute(route, "POST", "/login", JSON.stringify({ token: "tok-ok" }), { headers: { origin: ORIGIN, "x-forwarded-for": "203.0.113.3", "x-forwarded-proto": "https" } });
    expect(out?.code).toBe(200); // 第三 IP 正常（表有界不炸）
    expect(audits.some((l) => l.includes("login-rate-blocked"))).toBe(true);
  });
});

describe("login-route r1-B5：HTTP 来源门+媒体类型门", () => {
  it("B5a 异源 login（有效令牌）→403，不消耗失败记账", async () => {
    const { route, audits } = makeRoute();
    const out = await callRoute(route, "POST", "/login", JSON.stringify({ token: "tok-ok" }), { headers: { origin: "https://evil.invalid" } });
    expect(out?.code).toBe(403);
    expect(audits.some((l) => l.includes("login-origin-rejected"))).toBe(true);
    expect(audits.join("\n")).not.toContain("login-rejected"); // 未进令牌校验
  });

  it("B5b 缺 Origin：loopback 放行（本机 curl/开发面）；非 loopback→403", async () => {
    const { route } = makeRoute();
    const outLb = await callRoute(route, "POST", "/login", JSON.stringify({ token: "tok-ok" }), { headers: {} }); // 127.0.0.1
    expect(outLb?.code).toBe(200);
    const outExt = await callRoute(route, "POST", "/login", JSON.stringify({ token: "tok-ok" }), { remote: "192.168.1.5", headers: {} });
    expect(outExt?.code).toBe(403);
  });

  it("B5c Origin=null 字串（隐私强化浏览器）→非 loopback 拒", async () => {
    const { route } = makeRoute();
    const out = await callRoute(route, "POST", "/login", JSON.stringify({ token: "tok-ok" }), { remote: "192.168.1.5", headers: { origin: "null" } });
    expect(out?.code).toBe(403);
  });

  it("B5d text/plain 媒体类型（跨站简单请求载体）→415", async () => {
    const { route, audits } = makeRoute();
    const out = await callRoute(route, "POST", "/login", JSON.stringify({ token: "tok-ok" }), { headers: { origin: ORIGIN, "content-type": "text/plain" } });
    expect(out?.code).toBe(415);
    expect(audits.some((l) => l.includes("login-media-type-rejected"))).toBe(true);
  });

  it("B5e 异源 logout→403（SameSite cookie 限制不能充当端点来源校验）", async () => {
    const { route } = makeRoute();
    const out = await callRoute(route, "POST", "/logout", "", { headers: { origin: "https://evil.invalid" } });
    expect(out?.code).toBe(403);
  });
});
