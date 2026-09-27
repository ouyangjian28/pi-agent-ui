// N4-v2（2026-10-05 拍板）：HttpOnly cookie 会话登录面。
// - POST /login {token} → TokenAuthority 恒定时间校验 → Set-Cookie: sid（HttpOnly; SameSite=Strict; Path=/; [Secure]）
//   sid=HMAC-SHA256(per-boot secret, tokenDigestHex)——cookie 不含令牌原文；服务重启（新 secret）全会话失效（fail-closed）。
// - POST /logout → 清 cookie（Max-Age=0）。
// - per-IP 失败限速（滑窗；成功不计）；认证面零令牌日志。
// - 该面仅浏览器部署（composition staticDir 模式）；非浏览器客户端走 WS hello 令牌通道（契约 v1.1 双通道并存）。
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TokenAuthority } from "../ws/token-auth.ts";

export const SESSION_COOKIE_NAME = "pi-agent-ui-session";
const DEFAULT_MAX_BODY_BYTES = 4_096;
const DEFAULT_RATE_WINDOW_MS = 60_000;
const DEFAULT_RATE_MAX_FAILURES = 10;
const RATE_MAP_MAX = 10_000;

/** 派生 sid（HMAC(per-boot secret, digestHex)；hex 定长 64）。 */
export function deriveSid(secret: Buffer, digestHex: string): string {
  return createHmac("sha256", secret).update(digestHex, "utf8").digest("hex");
}

/** 从 Cookie 头解析具名值（多值 Cookie 头=歧义→null；无该名→null）。 */
export function parseSessionCookie(header: string | string[] | undefined, name: string = SESSION_COOKIE_NAME): string | null {
  if (header === undefined) return null;
  if (Array.isArray(header)) return null; // 多值/重复=歧义，默认拒（与 headerSingle 同口径）
  const target = `${name}=`;
  for (const part of header.split(";")) {
    const t = part.trim();
    if (t.startsWith(target)) {
      const v = t.slice(target.length);
      return v.length > 0 ? v : null;
    }
  }
  return null;
}

export interface LoginRouteOpts {
  readonly authority: TokenAuthority;
  readonly audit: (line: string) => void;
  /** 会话 HMAC 密钥（per-boot 32B random；同 boot 内 login 面与 WS 升级面必须同钥）。 */
  readonly sessionSecret: Buffer;
  /** Cookie 名（默认 pi-agent-ui-session）。 */
  readonly cookieName?: string;
  readonly maxBodyBytes?: number;
  /** per-IP 失败滑窗（默认 60s 内 10 次失败→429 至窗口滑过）。 */
  readonly rateWindowMs?: number;
  readonly rateMaxFailures?: number;
  readonly now?: () => number;
}

export interface LoginRoute {
  /** HTTP 请求处理器（非 POST /login|/logout 一律交还 false 由后续处理）。 */
  handle(req: IncomingMessage, res: ServerResponse): boolean;
  /** WS 升级面共用：呈递 sid 是否有效（对当前已知 token 摘要集逐项恒定时间比较）。 */
  validateSid(sid: string | null): boolean;
}

interface RateEntry { windowStart: number; failures: number; }

export function createLoginRoute(opts: LoginRouteOpts): LoginRoute {
  const name = opts.cookieName ?? SESSION_COOKIE_NAME;
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const windowMs = opts.rateWindowMs ?? DEFAULT_RATE_WINDOW_MS;
  const maxFailures = opts.rateMaxFailures ?? DEFAULT_RATE_MAX_FAILURES;
  const now = opts.now ?? Date.now;
  const failures = new Map<string, RateEntry>();

  if (opts.sessionSecret.byteLength < 32) throw new Error("sessionSecret 须 ≥32B（拒绝弱钥）");

  const sidOf = (token: string): string => deriveSid(opts.sessionSecret, createHash("sha256").update(token, "utf8").digest("hex"));

  const validateSid = (sid: string | null): boolean => {
    if (sid === null || !/^[0-9a-f]{64}$/.test(sid)) return false; // 形态门（长度/字符集）先行——恒定时间比较仅在定长 32B 缓冲间
    const presented = Buffer.from(sid, "hex");
    for (const digest of opts.authority.currentDigests()) {
      const expected = createHmac("sha256", opts.sessionSecret).update(digest.toString("hex"), "utf8").digest();
      if (timingSafeEqual(presented, expected)) return true;
    }
    return false;
  };

  const rateLimited = (ip: string): boolean => {
    const e = failures.get(ip);
    if (e === undefined) return false;
    if (now() - e.windowStart >= windowMs) { failures.delete(ip); return false; }
    return e.failures >= maxFailures;
  };

  const recordFailure = (ip: string): void => {
    const t = now();
    const e = failures.get(ip);
    if (e === undefined) {
      if (failures.size >= RATE_MAP_MAX) {
        // 先清过期项；全未过期=整表清（有界优先，防无界增长；审计留痕）
        let pruned = 0;
        for (const [k, v] of failures) {
          if (t - v.windowStart >= windowMs) { failures.delete(k); pruned++; }
        }
        if (pruned === 0) failures.clear();
        opts.audit(`login-rate-map-capped size=${failures.size}`);
      }
      failures.set(ip, { windowStart: t, failures: 1 });
      return;
    }
    if (t - e.windowStart >= windowMs) { e.windowStart = t; e.failures = 1; return; }
    e.failures += 1;
  };

  const readBody = (req: IncomingMessage): Promise<Buffer | null> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let done = false;
      const finish = (v: Buffer | null): void => { if (!done) { done = true; resolve(v); } };
      req.on("data", (c: Buffer) => {
        total += c.byteLength;
        if (total > maxBody) { finish(null); req.destroy(); return; }
        chunks.push(c);
      });
      req.on("end", () => finish(Buffer.concat(chunks)));
      req.on("error", () => finish(null));
    });

  const jsonReply = (res: ServerResponse, code: number, body: Record<string, unknown>, setCookie?: string): void => {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const headers: Record<string, string> = { "Content-Type": "application/json", "Content-Length": String(payload.byteLength), "Cache-Control": "no-store" };
    if (setCookie !== undefined) headers["Set-Cookie"] = setCookie;
    res.writeHead(code, headers);
    res.end(payload);
  };

  const clientIp = (req: IncomingMessage): string => req.socket.remoteAddress ?? "unknown";

  const handle = (req: IncomingMessage, res: ServerResponse): boolean => {
    const url = (req.url ?? "").split("?")[0];
    if (req.method !== "POST" || (url !== "/login" && url !== "/logout")) return false;
    const ip = clientIp(req);
    void (async () => {
      if (url === "/logout") {
        opts.audit(`logout clientIp=${ip}`);
        jsonReply(res, 200, { ok: true }, `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
        return;
      }
      if (rateLimited(ip)) {
        opts.audit(`login-rate-limited clientIp=${ip}`);
        jsonReply(res, 429, { ok: false, error: "尝试过于频繁，稍后再试" });
        return;
      }
      const body = await readBody(req);
      if (body === null) { jsonReply(res, 413, { ok: false, error: "请求体超限" }); return; }
      let parsed: unknown;
      try { parsed = JSON.parse(body.toString("utf8")); } catch { jsonReply(res, 400, { ok: false, error: "请求体须为 JSON" }); return; }
      const token = (parsed as { token?: unknown }).token;
      if (typeof token !== "string" || token.length === 0 || token.length > 1024) {
        recordFailure(ip);
        opts.audit(`login-rejected reason=format clientIp=${ip}`);
        jsonReply(res, 401, { ok: false, error: "令牌无效" });
        return;
      }
      if (!opts.authority.check(token)) {
        recordFailure(ip);
        opts.audit(`login-rejected reason=token clientIp=${ip}`);
        jsonReply(res, 401, { ok: false, error: "令牌无效" }); // 逐原因同文案（不给探测面区分信号）
        return;
      }
      failures.delete(ip); // 成功即清户（正常用户不受限速面影响）
      const secure = req.socket instanceof (await import("node:tls")).TLSSocket;
      const flags = ["Path=/", "HttpOnly", "SameSite=Strict", ...(secure ? ["Secure"] : [])];
      opts.audit(`login-ok clientIp=${ip} secure=${secure}`);
      jsonReply(res, 200, { ok: true }, `${name}=${sidOf(token)}; ${flags.join("; ")}`);
    })().catch(() => {
      try { if (!res.headersSent) jsonReply(res, 500, { ok: false, error: "内部错误" }); else res.end(); } catch { /* 已销毁 */ }
    });
    return true;
  };

  return { handle, validateSid };
}

/** per-boot 会话密钥（32B random；composition 每 boot 生成一次，login 面与 WS 升级面共享）。 */
export function newSessionSecret(): Buffer {
  return randomBytes(32);
}
