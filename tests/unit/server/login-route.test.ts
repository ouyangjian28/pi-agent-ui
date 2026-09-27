// N4-v2 登录面单测（2026-10-05 拍板：HttpOnly cookie 会话）。
// 覆盖：POST /login 成功（cookie 旗标逐项）/坏令牌 401/限速 429/登出清 cookie/方法与路径非面/超体/坏 JSON；
// validateSid（真 sid 过/篡改拒/形态拒）；parseSessionCookie（缺/多值/具名/空值）；Secure 旗标（TLSSocket 事实）。
import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { TLSSocket } from "node:tls";
import { Socket } from "node:net";
import { createLoginRoute, parseSessionCookie, deriveSid, type LoginRouteOpts } from "../../../apps/server/src/http/login-route.ts";
import { TokenAuthority } from "../../../apps/server/src/ws/token-auth.ts";
import { createHash } from "node:crypto";

const SECRET = Buffer.alloc(32, 7);

class FakeReq extends EventEmitter {
  url: string;
  method: string;
  socket: { remoteAddress: string };
  constructor(method: string, url: string, body: string, over: { tls?: boolean } = {}) {
    super();
    this.method = method;
    this.url = url;
    this.socket = over.tls === true ? new TLSSocket(new Socket()) : ({ remoteAddress: "127.0.0.1" } as Socket);
    queueMicrotask(() => {
      if (body.length > 0) this.emit("data", Buffer.from(body, "utf8"));
      this.emit("end");
    });
  }
  destroy(): void { /* no-op */ }
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

async function call(route: ReturnType<typeof createLoginRoute>, method: string, url: string, body: string, over: { tls?: boolean } = {}): Promise<Call | null> {
  const handled = route.handle(new FakeReq(method, url, body, over) as never, new FakeRes() as never);
  if (!handled) return null;
  await new Promise((r) => setTimeout(r, 10));
  const req = arguments;
  void req;
  return null; // placeholder, overwritten below
}

// 上面 call 简化重写：直接持引用
async function callRoute(route: ReturnType<typeof createLoginRoute>, method: string, url: string, body: string, over: { tls?: boolean } = {}): Promise<Call | null> {
  const res = new FakeRes();
  const handled = route.handle(new FakeReq(method, url, body, over) as never, res as never);
  if (!handled) return null;
  await new Promise((r) => setTimeout(r, 15));
  return { code: res.code, headers: res.headers as Record<string, string>, body: res.body };
}

function makeRoute(over: Partial<LoginRouteOpts> = {}, tokens: readonly string[] = ["tok-ok"]): { route: ReturnType<typeof createLoginRoute>; audits: string[]; authority: TokenAuthority } {
  const audits: string[] = [];
  const authority = TokenAuthority.fromTokens(tokens);
  const route = createLoginRoute({ authority, sessionSecret: SECRET, audit: (l) => { audits.push(l); }, ...over });
  return { route, audits, authority };
}

const sidOfToken = (token: string): string => deriveSid(SECRET, createHash("sha256").update(token, "utf8").digest("hex"));

describe("login-route N4-v2", () => {
  it("L1 登录成功：200+Set-Cookie 逐旗标（HttpOnly/SameSite=Strict/Path=/；明文 socket 无 Secure）+sid 可验", async () => {
    const { route } = makeRoute();
    const r = await callRoute(route, "POST", "/login", JSON.stringify({ token: "tok-ok" }));
    expect(r?.code).toBe(200);
    const sc = r?.headers["Set-Cookie"] as string | undefined;
    expect(sc).toContain("pi-agent-ui-session=");
    expect(sc).toContain("HttpOnly");
    expect(sc).toContain("SameSite=Strict");
    expect(sc).toContain("Path=/");
    expect(sc).not.toContain("Secure"); // 明文 loopback 事实
    expect(sc).not.toContain("tok-ok"); // cookie 不含令牌原文
    const sid = (sc ?? "").match(/pi-agent-ui-session=([0-9a-f]{64})/)?.[1];
    expect(sid).toBe(sidOfToken("tok-ok"));
    expect(route.validateSid(sid ?? "")).toBe(true);
  });

  it("L2 TLS 事实→Secure 旗标（TLSSocket socket）", async () => {
    const { route } = makeRoute();
    const r = await callRoute(route, "POST", "/login", JSON.stringify({ token: "tok-ok" }), { tls: true });
    expect(r?.code).toBe(200);
    expect((r?.headers["Set-Cookie"] as string | undefined)).toContain("Secure");
  });

  it("L3 坏令牌→401 无 Set-Cookie；限速滑窗满→429；窗口滑过→再可试", async () => {
    let t = 1_000;
    const { route } = makeRoute({ rateWindowMs: 1_000, rateMaxFailures: 3, now: () => t });
    for (let i = 0; i < 3; i++) {
      const r = await callRoute(route, "POST", "/login", JSON.stringify({ token: "bad" }));
      expect(r?.code).toBe(401);
      expect(r?.headers["Set-Cookie"]).toBeUndefined();
    }
    const blocked = await callRoute(route, "POST", "/login", JSON.stringify({ token: "tok-ok" }));
    expect(blocked?.code).toBe(429); // 封锁期正确令牌也拒（与网关 B1 同口径：不记账不延长）
    t += 1_001; // 窗口滑过
    const ok = await callRoute(route, "POST", "/login", JSON.stringify({ token: "tok-ok" }));
    expect(ok?.code).toBe(200);
  });

  it("L4 登出：Max-Age=0 清 cookie", async () => {
    const { route } = makeRoute();
    const r = await callRoute(route, "POST", "/logout", "");
    expect(r?.code).toBe(200);
    const sc = r?.headers["Set-Cookie"] as string | undefined;
    expect(sc).toContain("Max-Age=0");
    expect(sc).toContain("HttpOnly");
  });

  it("L5 非面请求：GET /login 与 POST /other → 不接管（返回 null 交还静态面）", async () => {
    const { route } = makeRoute();
    expect(await callRoute(route, "GET", "/login", "")).toBeNull();
    expect(await callRoute(route, "POST", "/other", "{}")).toBeNull();
  });

  it("L6 坏体：非 JSON→400；token 类型错→401；超体→413", async () => {
    const { route } = makeRoute({ maxBodyBytes: 16 });
    expect((await callRoute(route, "POST", "/login", "not-json"))?.code).toBe(400);
    expect((await callRoute(route, "POST", "/login", JSON.stringify({ token: 42 })))?.code).toBe(401);
    expect((await callRoute(route, "POST", "/login", JSON.stringify({ token: "x".repeat(64) })))?.code).toBe(413);
  });

  it("L7 validateSid：篡改/形态非法/null→false；令牌轮换后旧 sid 失效", async () => {
    const { route, authority } = makeRoute();
    const sid = sidOfToken("tok-ok");
    expect(route.validateSid(sid)).toBe(true);
    expect(route.validateSid(sid.slice(0, 63))).toBe(false); // 形态（63 hex）
    expect(route.validateSid("z".repeat(64))).toBe(false); // 非 hex
    expect(route.validateSid(sidOfToken("unknown-token"))).toBe(false); // 未知令牌派生
    expect(route.validateSid(null)).toBe(false);
    // 轮换：同一 authority 换基准（fromTokens 不可变——用第二 authority 模拟换钥后新基准）
    const other = TokenAuthority.fromTokens(["tok-next"]);
    expect(createLoginRoute({ authority: other, sessionSecret: SECRET, audit: () => {} }).validateSid(sid)).toBe(false);
    expect(createLoginRoute({ authority: other, sessionSecret: SECRET, audit: () => {} }).validateSid(sidOfToken("tok-next"))).toBe(true);
  });

  it("L8 per-boot secret 隔离：异钥同令牌→sid 不同且互不认", async () => {
    const a = makeRoute();
    const b: LoginRouteOpts = { authority: TokenAuthority.fromTokens(["tok-ok"]), sessionSecret: Buffer.alloc(32, 9), audit: () => {} };
    const routeB = createLoginRoute(b);
    const sidA = sidOfToken("tok-ok");
    expect(routeB.validateSid(sidA)).toBe(false);
    expect(routeB.validateSid(deriveSid(Buffer.alloc(32, 9), createHash("sha256").update("tok-ok", "utf8").digest("hex")))).toBe(true);
  });

  it("L9 弱钥拒启（<32B sessionSecret 抛错）", () => {
    expect(() => makeRoute({ sessionSecret: Buffer.alloc(16) })).toThrow();
  });

  it("L10 parseSessionCookie：具名提取/缺失/多值拒/空值拒", () => {
    expect(parseSessionCookie("a=1; pi-agent-ui-session=abc", )).toBe("abc");
    expect(parseSessionCookie(undefined)).toBeNull();
    expect(parseSessionCookie(["x=1", "y=2"] as unknown as string)).toBeNull();
    expect(parseSessionCookie("pi-agent-ui-session=")).toBeNull();
    expect(parseSessionCookie("other=pi-agent-ui-session=zz")).toBeNull(); // 名不对=无关值
  });

  it("L11 审计面：ok/rejected/limited 行落，无令牌原文", async () => {
    const { route, audits } = makeRoute({ rateMaxFailures: 2, rateWindowMs: 60_000 });
    await callRoute(route, "POST", "/login", JSON.stringify({ token: "bad-secret-token" }));
    await callRoute(route, "POST", "/login", JSON.stringify({ token: "bad-secret-token" }));
    await callRoute(route, "POST", "/login", JSON.stringify({ token: "tok-ok" })); // 触发 429
    const joined = audits.join("\n");
    expect(joined).toContain("login-rejected");
    expect(joined).toContain("login-rate-limited");
    expect(joined).not.toContain("bad-secret-token");
    expect(joined).not.toContain("tok-ok");
  });
});
