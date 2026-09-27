// N4-v2（2026-10-05 拍板）+ r1 修复批（GPT 审 2026-10-05，B1-B5）：
// - POST /login {token} → TokenAuthority 恒定时间校验 → Set-Cookie: sid（HttpOnly; SameSite=Strict; Path=/; [Secure]）
//   sid=HMAC-SHA256(per-boot secret, tokenDigestHex)——cookie 不含令牌原文；服务重启（新 secret）全会话失效（fail-closed）。
// - POST /logout → 清 cookie（Max-Age=0；属性与签发一致）。
// - B1：HTTP/WS 共用 deriveConnMeta 可信代理派生（XFF/XFP 仅可信对端采信）——Secure 按有效 TLS（含可信 XFP=https）；
//   非 loopback 明文登录拒绝（403 tls-required）；限速键=有效客户端 IP（代理后不共桶）。
// - B3：Cookie 单头内同名恰现一次（重复同值也拒=歧义）；多头由升级面 rawHeaders 计数拒（ws-transport）。
// - B4：失败滑窗时间戳队列+blockedUntil 指数退避+有界淘汰（保留封锁项）——与 WS R6 同口径；
//   body 读完+令牌校验前同步复核（复核→校验→记账无 await 间隙）；per-IP 在途 body 预算+超时。
// - B5：浏览器 HTTP 面-Origin 精确校验（login/logout 全覆盖；缺 Origin 仅 loopback 放行）+login 强制 JSON 媒体类型。
// - 该面仅浏览器部署（composition staticDir 模式）；非浏览器客户端走 WS hello 令牌通道（契约 v1.1 双通道并存）。
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { TLSSocket } from "node:tls";
import type { TokenAuthority } from "../ws/token-auth.ts";
import { deriveConnMeta } from "../ws/ws-transport.ts";

export const SESSION_COOKIE_NAME = "pi-agent-ui-session";
const DEFAULT_MAX_BODY_BYTES = 4_096;
const DEFAULT_RATE_WINDOW_MS = 60_000;
const DEFAULT_RATE_MAX_FAILURES = 10;
const DEFAULT_RATE_BASE_BLOCK_MS = 60_000;
const DEFAULT_RATE_MAX_BLOCK_MS = 600_000;
const DEFAULT_BODY_TIMEOUT_MS = 10_000;
const DEFAULT_INFLIGHT_BODIES = 2;
const RATE_MAP_MAX = 10_000;

/** 派生 sid（HMAC(per-boot secret, digestHex)；hex 定长 64）。 */
export function deriveSid(secret: Buffer, digestHex: string): string {
  return createHmac("sha256", secret).update(digestHex, "utf8").digest("hex");
}

/** 从 Cookie 头解析具名值（B3：同名恰现一次——重复（含同值重复）=歧义→null；无该名→null）。 */
export function parseSessionCookie(header: string | string[] | undefined, name: string = SESSION_COOKIE_NAME): string | null {
  if (header === undefined) return null;
  if (Array.isArray(header)) return null; // 多值/重复=歧义，默认拒（与 headerSingle 同口径）
  const target = `${name}=`;
  let hits = 0;
  let value: string | null = null;
  for (const part of header.split(";")) {
    const t = part.trim();
    if (t.startsWith(target)) {
      hits += 1;
      if (hits > 1) return null; // 同名第二现=歧义（同值也拒）
      value = t.slice(target.length);
    }
  }
  return hits === 1 && value !== null && value.length > 0 ? value : null;
}

/** B1 共享安全元数据（HTTP 请求面）：复用 WS 升级面同一派生（可信代理才采信 XFF/XFP）。 */
function connSecurityOf(req: IncomingMessage, trustedProxies: readonly string[]): { ip: string; loopback: boolean; tls: boolean } {
  const meta = deriveConnMeta(req, req.socket, trustedProxies);
  return { ip: meta.clientIp, loopback: meta.loopback, tls: meta.tls };
}

export interface LoginRouteOpts {
  readonly authority: TokenAuthority;
  readonly audit: (line: string) => void;
  /** 会话 HMAC 密钥（per-boot 32B random；同 boot 内 login 面与 WS 升级面必须同钥）。 */
  readonly sessionSecret: Buffer;
  /** B5：浏览器 HTTP 面精确 Origin 白名单（与 WS 升级面同表；缺 Origin 仅 loopback 放行）。 */
  readonly allowedOrigins: readonly string[];
  /** B1：可信代理精确来源（与 WS 升级面同表；非空才采信 XFF/XFP）。 */
  readonly trustedProxies?: readonly string[];
  /** Cookie 名（默认 pi-agent-ui-session）。 */
  readonly cookieName?: string;
  readonly maxBodyBytes?: number;
  /** B4：失败滑窗（默认 60s 内 10 次失败→封 60s 指数退避封顶 10min；与 WS R6 同口径）。 */
  readonly rateWindowMs?: number;
  readonly rateMaxFailures?: number;
  readonly rateBaseBlockMs?: number;
  readonly rateMaxBlockMs?: number;
  /** B4：防护表上界（默认 10_000；满表淘汰非封锁项优先）。 */
  readonly rateMapMax?: number;
  /** B4：per-IP 在途（未完成）body 预算（默认 2；超出→429）。 */
  readonly inflightBodies?: number;
  /** B4：单请求 body 完成时限（默认 10s；超时→408）。 */
  readonly bodyTimeoutMs?: number;
  readonly now?: () => number;
}

export interface LoginRoute {
  /** HTTP 请求处理器（非 POST /login|/logout 一律交还 false 由后续处理）。 */
  handle(req: IncomingMessage, res: ServerResponse): boolean;
  /** B2：呈递 sid → 有效则返回被认证身份（token 摘要 hex；恒定时间比较），无效返回 null。
   * 升级面注入 transport 派生 meta.sessionDigest——hello 复核+撤销链复用（不暴露原文）。 */
  sessionIdentityOf(sid: string | null): string | null;
  /** 兼容布尔包装（=sessionIdentityOf(...) !== null）。 */
  validateSid(sid: string | null): boolean;
}

interface RateEntry { fails: number[]; strikes: number; blockedUntil: number; }

type BodyResult = { ok: true; body: Buffer } | { ok: false; code: 400 | 408 | 413; reason: "error" | "timeout" | "oversize" };

export function createLoginRoute(opts: LoginRouteOpts): LoginRoute {
  const name = opts.cookieName ?? SESSION_COOKIE_NAME;
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const windowMs = opts.rateWindowMs ?? DEFAULT_RATE_WINDOW_MS;
  const maxFailures = opts.rateMaxFailures ?? DEFAULT_RATE_MAX_FAILURES;
  const baseBlockMs = opts.rateBaseBlockMs ?? DEFAULT_RATE_BASE_BLOCK_MS;
  const maxBlockMs = opts.rateMaxBlockMs ?? DEFAULT_RATE_MAX_BLOCK_MS;
  const mapMax = opts.rateMapMax ?? RATE_MAP_MAX;
  const inflightMax = opts.inflightBodies ?? DEFAULT_INFLIGHT_BODIES;
  const bodyTimeoutMs = opts.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS;
  // R2-B2：构造期快照冻结（调用方保留原数组引用也不可热变更授权面——与 WS 升级面 originSnapshot 同语义）。
  const trustedProxies = Object.freeze([...(opts.trustedProxies ?? [])]);
  const allowedOrigins = Object.freeze([...opts.allowedOrigins]);
  const now = opts.now ?? Date.now;
  const failures = new Map<string, RateEntry>();
  const inflight = new Map<string, number>();

  if (opts.sessionSecret.byteLength < 32) throw new Error("sessionSecret 须 ≥32B（拒绝弱钥）");

  // C3：审计异常隔离（与 gateway/authority 同口径——合法登录不得因日志故障 500）。
  const audit = (line: string): void => { try { opts.audit(line); } catch { /* 隔离 */ } };

  const sidOf = (token: string): string => deriveSid(opts.sessionSecret, createHash("sha256").update(token, "utf8").digest("hex"));

  // B2：返回被匹配的身份（token 摘要 hex）而非布尔——升级面经 meta 传 gateway，hello 复核+撤销链复用。
  const sessionIdentityOf = (sid: string | null): string | null => {
    if (sid === null || !/^[0-9a-f]{64}$/.test(sid)) return null; // 形态门先行——恒定时间比较仅在定长缓冲间
    const presented = Buffer.from(sid, "hex");
    for (const digest of opts.authority.currentDigests()) {
      const expected = createHmac("sha256", opts.sessionSecret).update(digest.toString("hex"), "utf8").digest();
      if (timingSafeEqual(presented, expected)) return digest.toString("hex");
    }
    return null;
  };

  // B4（R6 同口径）：封锁期或滑窗内失败数达限→拒（不动状态）。
  const rateLimited = (ip: string): boolean => {
    const e = failures.get(ip);
    if (e === undefined) return false;
    if (now() < e.blockedUntil) return true;
    const live = e.fails.filter((t) => now() - t < windowMs);
    return live.length >= maxFailures;
  };

  // B4（R6 同口径）：记账=滑窗时间戳队列；达限→strikes+1+blockedUntil 指数退避封顶；有界淘汰优先丢非封锁项。
  const recordFailure = (ip: string): void => {
    const t = now();
    let e = failures.get(ip);
    if (e === undefined) {
      if (failures.size >= mapMax) {
        let victim: string | null = null;
        for (const [k, v] of failures) { if (t >= v.blockedUntil) { victim = k; break; } } // 最旧非封锁项优先
        if (victim === null) {
          let minUntil = Infinity;
          for (const [k, v] of failures) { if (v.blockedUntil < minUntil) { minUntil = v.blockedUntil; victim = k; } }
          audit(`login-rate-table-evict-blocked ip=${victim} until=${Math.round(minUntil)} size=${failures.size}`);
        }
        if (victim !== null) failures.delete(victim);
      }
      e = { fails: [], strikes: 0, blockedUntil: 0 };
      failures.set(ip, e);
    }
    e.fails = e.fails.filter((ft) => t - ft < windowMs);
    e.fails.push(t);
    if (e.fails.length >= maxFailures) {
      e.strikes += 1;
      const backoff = Math.min(baseBlockMs * 2 ** (e.strikes - 1), maxBlockMs);
      e.blockedUntil = t + backoff;
      e.fails = [];
      audit(`login-rate-blocked ip=${ip} strikes=${e.strikes} backoffMs=${backoff}`);
    }
  };

  // B4：body 读取（限时+超体破坏性截断；结果带语义码）。
  const readBody = (req: IncomingMessage): Promise<BodyResult> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let done = false;
      const finish = (v: BodyResult): void => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
      const timer = setTimeout(() => { finish({ ok: false, code: 408, reason: "timeout" }); req.pause(); }, bodyTimeoutMs);
      req.on("data", (c: Buffer) => {
        total += c.byteLength;
        if (total > maxBody) { finish({ ok: false, code: 413, reason: "oversize" }); req.pause(); return; }
        chunks.push(c);
      });
      req.on("end", () => finish({ ok: true, body: Buffer.concat(chunks) }));
      req.on("error", () => finish({ ok: false, code: 400, reason: "error" }));
    });

  const jsonReply = (res: ServerResponse, code: number, body: Record<string, unknown>, setCookie?: string, close?: boolean): void => {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const headers: Record<string, string> = { "Content-Type": "application/json", "Content-Length": String(payload.byteLength), "Cache-Control": "no-store" };
    if (close === true) headers.Connection = "close"; // R2-B3：错误关停面不接 pipeline 复用
    if (setCookie !== undefined) headers["Set-Cookie"] = setCookie;
    res.writeHead(code, headers);
    res.end(payload);
  };

  // R2-B3+R3-Y1+R4-B1：有界关停——响应写完即销毁流（25ms 缓冲，不被慢发送方拖住），封顶 1s 强制；
  // 统一幂等 kill：finish/客户端放弃/错误任一路径先到先收口，并撤销全部兜底 timer（不悬挂）。
  // 声明序=先 kill 后 timer（R4-B1：setTimeout(kill) 传参即读 kill，置于声明前=同步 TDZ 抛错、关停器全不建立）。
  const closeAfterReply = (req: IncomingMessage, res: ServerResponse): void => {
    let killed = false;
    let soft: NodeJS.Timeout | undefined;
    const kill = (): void => {
      if (killed) return;
      killed = true;
      if (soft !== undefined) clearTimeout(soft);
      if (hard !== undefined) clearTimeout(hard);
      req.destroy();
    };
    const hard: NodeJS.Timeout = setTimeout(kill, 1_000); hard.unref?.();
    res.once("finish", () => { if (!killed) { soft = setTimeout(kill, 25); soft.unref?.(); } }); // 迟到 finish 不再新建 timer（R4-Y1）
    res.once("close", () => kill()); // 响应面 close：正常响应结束或对端提前断开皆收口（R4-Y1 勘正：非仅 RST）
    req.once("aborted", () => kill()); // B4a：未完成请求的主动清理
    req.once("error", () => kill());
  };

  // B5：媒体类型门——application/json（可带 charset 参数；大小写不敏感媒体类型）。
  const jsonMediaType = (req: IncomingMessage): boolean => {
    const ct = req.headers["content-type"];
    if (ct === undefined || Array.isArray(ct)) return false;
    return /^application\/json\s*(;|$)/i.test(ct.trim());
  };

  const handle = (req: IncomingMessage, res: ServerResponse): boolean => {
    const url = (req.url ?? "").split("?")[0];
    if (req.method !== "POST" || (url !== "/login" && url !== "/logout")) return false;
    const sec = connSecurityOf(req, trustedProxies); // B1：与 WS 升级面同一派生（有效 IP/loopback/有效 TLS）
    const rawOrigin = req.headers.origin;
    const originMissing = rawOrigin === undefined; // R2-B1：真缺失（无头）才可走 loopback 豁免
    const origin = typeof rawOrigin === "string" && rawOrigin.length > 0 && rawOrigin.toLowerCase() !== "null" ? rawOrigin : null;
    const rejectOrigin = (o: string | null): void => {
      audit(`login-origin-rejected origin=${o ?? "<missing>"} clientIp=${sec.ip} loopback=${sec.loopback}`);
      jsonReply(res, 403, { ok: false, error: "来源不被允许" });
    };
    void (async () => {
      // B5/R2-B1：来源门先于一切状态消耗。三态：白名单命中放行；真缺失仅 loopback 放行（本机 curl/开发面）；
      // 显式异常值（"null"/空串/数组）一律 403——不折叠成“缺失”去蹭 loopback 豁免（opaque/sandbox 来源即此形态）。
      if (origin !== null) {
        if (!allowedOrigins.includes(origin)) { rejectOrigin(origin); return; }
      } else if (originMissing) {
        if (!sec.loopback) { rejectOrigin(null); return; }
      } else { rejectOrigin(String(rawOrigin).slice(0, 64)); return; }
      // 注：白名单查冻结快照 allowedOrigins（R2-B2），不再直绑 opts 原数组。
      // B1：非 loopback 有效明文→拒绝提交令牌（WS TLS 门同口径；loopback=开发面豁免）。
      if (!sec.loopback && !sec.tls) {
        audit(`login-tls-required clientIp=${sec.ip}`);
        jsonReply(res, 403, { ok: false, error: "明文通道不接受登录" });
        return;
      }
      if (url === "/logout") {
        audit(`logout clientIp=${sec.ip}`);
        jsonReply(res, 200, { ok: true }, `${name}=; Path=/; HttpOnly; SameSite=Strict${sec.tls ? "; Secure" : ""}; Max-Age=0`);
        return;
      }
      if (rateLimited(sec.ip)) { // 门 1（早退：封锁期/已满窗）
        audit(`login-rate-limited clientIp=${sec.ip}`);
        jsonReply(res, 429, { ok: false, error: "尝试过于频繁，稍后再试" });
        return;
      }
      if ((inflight.get(sec.ip) ?? 0) >= inflightMax) { // B4：在途 body 预算（并发预开稀释绕过）
        audit(`login-inflight-capped clientIp=${sec.ip}`);
        jsonReply(res, 429, { ok: false, error: "尝试过于频繁，稍后再试" });
        return;
      }
      if (!jsonMediaType(req)) { // B5：登录体强制 JSON 媒体类型（text/plain 简单请求不得入）
        audit(`login-media-type-rejected contentType=${req.headers["content-type"] ?? "<missing>"} clientIp=${sec.ip}`);
        jsonReply(res, 415, { ok: false, error: "请求体须为 application/json" });
        return;
      }
      inflight.set(sec.ip, (inflight.get(sec.ip) ?? 0) + 1);
      const bodyR = await readBody(req);
      inflight.set(sec.ip, Math.max(0, (inflight.get(sec.ip) ?? 1) - 1));
      if (inflight.get(sec.ip) === 0) inflight.delete(sec.ip);
      if (!bodyR.ok) {
        // R2-B3：先写错误响应再关流（destroy 后写=真网 0 字节；有界关停：写完即关+封顶强制关）。
        audit(`login-body-${bodyR.reason} clientIp=${sec.ip} code=${bodyR.code}`);
        jsonReply(res, bodyR.code, { ok: false, error: "请求体不可用" }, undefined, true);
        closeAfterReply(req, res);
        return;
      }
      if (rateLimited(sec.ip)) { // B4 门 2：body 后同步复核（复核→解析→校验→记账无 await 间隙）
        audit(`login-rate-limited clientIp=${sec.ip} phase=post-body`);
        jsonReply(res, 429, { ok: false, error: "尝试过于频繁，稍后再试" });
        return;
      }
      let parsed: unknown;
      try { parsed = JSON.parse(bodyR.body.toString("utf8")); } catch { jsonReply(res, 400, { ok: false, error: "请求体须为 JSON" }); return; }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) { jsonReply(res, 400, { ok: false, error: "请求体须为 JSON 对象" }); return; } // r1-C2：null/非对象/数组防御
      const token = (parsed as { token?: unknown }).token;
      if (typeof token !== "string" || token.length === 0 || token.length > 1024) {
        recordFailure(sec.ip);
        audit(`login-rejected reason=format clientIp=${sec.ip}`);
        jsonReply(res, 401, { ok: false, error: "令牌无效" });
        return;
      }
      if (!opts.authority.check(token)) {
        recordFailure(sec.ip);
        audit(`login-rejected reason=token clientIp=${sec.ip}`);
        jsonReply(res, 401, { ok: false, error: "令牌无效" }); // 逐原因同文案（不给探测面区分信号）
        return;
      }
      failures.delete(sec.ip); // 成功即清户（正常用户不受限速面影响）
      const flags = ["Path=/", "HttpOnly", "SameSite=Strict", ...(sec.tls ? ["Secure"] : [])];
      audit(`login-ok clientIp=${sec.ip} secure=${sec.tls}`);
      jsonReply(res, 200, { ok: true }, `${name}=${sidOf(token)}; ${flags.join("; ")}`);
    })().catch(() => {
      try { if (!res.headersSent) jsonReply(res, 500, { ok: false, error: "内部错误" }); else res.end(); } catch { /* 已销毁 */ }
    });
    return true;
  };

  return { handle, sessionIdentityOf, validateSid: (sid) => sessionIdentityOf(sid) !== null };
}

/** per-boot 会话密钥（32B random；composition 每 boot 生成一次，login 面与 WS 升级面共享）。 */
export function newSessionSecret(): Buffer {
  return randomBytes(32);
}

/** 仅测试/工具用：TLSSocket 形态判定（与 deriveConnMeta 内部口径一致）。 */
export const tlsSocketRef = TLSSocket;
