// 认证令牌权威（切片③ w0 对齐 A4/A5 + §5.5 契约：静态令牌+热轮换+fail-closed）
// 设计：
// - 内存只保留 sha256 摘要（32B 定长），比较走 timingSafeEqual——不存原文、零日志。
// - tokenFile：0600、版本化 JSON {version:1, tokens:[...]}；整文件验证后**原子替换**集合；拒绝空/超长/错类型。
// - 初始（fromFile）缺失/不可读/非法→构造失败（fail-closed 拒绝启动）；运行期 reload 失败→**沿用旧基准**+审计（不误当空集合）。
// - 成功轮换返回 revoked=旧∩¬新，调用方据此撤销既有连接（不只拒新 hello）。
// - reload 串行+版本化：乱序完成的异步 reload 按序号丢弃（不回退旧版本）。
// - mtime 轮询（原子 rename 兼顾：mtime+size 双指纹）+宿主 SIGHUP 钩子（注册/卸载归宿主，本模块只暴露 requestReload）。
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

export interface TokenFileDeps {
  readonly readFile?: (p: string) => Promise<Buffer>;
  readonly stat?: (p: string) => Promise<{ mtimeMs: number; size: number }>;
}

export interface TokenReloadResult {
  readonly changed: boolean;
  /** 被撤销的摘要（旧集合−新集合）；调用方比对连接登记摘要执行撤销。 */
  readonly revoked: readonly string[];
}

const TOKEN_MAX_CHARS = 512;
const TOKEN_FILE_MAX_BYTES = 64 * 1024;

function digest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export class TokenAuthority {
  private digests = new Set<string>(); // hex 摘要（展示/撤销比对用）
  private digestBufs: Buffer[] = [];
  private fingerprint = "";
  private reloadSeq = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  private constructor(private readonly tokenFile: string | null, private readonly deps: TokenFileDeps, private readonly auditFn: (line: string) => void) {}
  /** 审计隔离（W1-08）：回调同步抛错不得影响鉴权/轮换状态机——吞并即可（审计非关键路径）。 */
  private audit(line: string): void { try { this.auditFn(line); } catch { /* 隔离 */ } }

  /** 测试/受控注入（与 fromFile 互斥；空集合永不放行）。 */
  static fromTokens(tokens: readonly string[], deps: TokenFileDeps = {}, audit: (line: string) => void = () => {}): TokenAuthority {
    const a = new TokenAuthority(null, deps, audit);
    a.install(tokens); // 空数组=合法构造但 check 恒 false（fail-closed：受控注入空集=显式拒绝一切）
    return a;
  }

  /** 生产：tokenFile 必须可读且合法，否则抛错（拒绝启动）。 */
  static async fromFile(path: string, deps: TokenFileDeps = {}, audit: (line: string) => void = () => {}): Promise<TokenAuthority> {
    const a = new TokenAuthority(path, deps, audit);
    const tokens = await a.parseFile("initial");
    a.install(tokens); // parseFile 失败即抛——fail-closed
    return a;
  }

  private async parseFile(phase: string): Promise<string[]> {
    if (this.tokenFile === null) throw new Error("in-memory authority has no file");
    const rf = this.deps.readFile ?? ((p: string) => readFile(p));
    let raw: Buffer;
    try {
      raw = await rf(this.tokenFile);
    } catch (e) {
      throw new Error(`token-file ${phase} unreadable: ${(e as NodeJS.ErrnoException).code ?? String(e)}`);
    }
    if (raw.byteLength > TOKEN_FILE_MAX_BYTES) throw new Error(`token-file ${phase} >${TOKEN_FILE_MAX_BYTES}B`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new Error(`token-file ${phase} invalid JSON`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`token-file ${phase} not an object`);
    const v = parsed as { version?: unknown; tokens?: unknown };
    if (v.version !== 1) throw new Error(`token-file ${phase} unsupported version`);
    if (!Array.isArray(v.tokens) || v.tokens.length === 0) throw new Error(`token-file ${phase} empty/invalid tokens`);
    for (const t of v.tokens) {
      if (typeof t !== "string" || t.length === 0 || t.length > TOKEN_MAX_CHARS) throw new Error(`token-file ${phase} invalid token entry`);
    }
    return v.tokens as string[];
  }

  private install(tokens: readonly string[]): void {
    const next = new Set<string>();
    const bufs: Buffer[] = [];
    for (const t of tokens) {
      const h = digest(t).toString("hex");
      if (!next.has(h)) {
        next.add(h);
        bufs.push(digest(t));
      }
    }
    this.digests = next;
    this.digestBufs = bufs;
  }

  /** 恒定时间校验（sha256 定长→timingSafeEqual）。 */
  check(token: string): boolean {
    if (token.length === 0 || token.length > TOKEN_MAX_CHARS) return false;
    const d = digest(token);
    for (const b of this.digestBufs) if (timingSafeEqual(d, b)) return true;
    return false;
  }

  /** 运行期热轮换：失败沿用旧基准（审计，无秘密泄漏）；成功返回 revoked 供连接撤销。 */
  async reload(): Promise<TokenReloadResult> {
    if (this.tokenFile === null) return { changed: false, revoked: [] };
    const seq = ++this.reloadSeq;
    let tokens: string[];
    try {
      tokens = await this.parseFile(`reload#${seq}`);
    } catch {
      this.audit(`token-reload-failed keep=old seq=${seq}`); // 不带异常原文（可能含路径细节）——只带序号
      return { changed: false, revoked: [] };
    }
    if (seq !== this.reloadSeq) {
      this.audit(`token-reload-stale seq=${seq} latest=${this.reloadSeq}`); // 乱序完成丢弃
      return { changed: false, revoked: [] };
    }
    const nextSet = new Set(tokens.map((t) => digest(t).toString("hex")));
    const revoked = [...this.digests].filter((h) => !nextSet.has(h));
    this.install(tokens);
    this.audit(`token-reloaded count=${this.digests.size} revoked=${revoked.length}`);
    return { changed: true, revoked };
  }

  /** mtime+size 轮询（原子 rename 兼顾）。返回停止函数。 */
  startPolling(intervalMs: number): () => void {
    const st = this.deps.stat ?? ((p: string) => stat(p));
    const tick = (): void => {
      void st(this.tokenFile as string)
        .then((s) => {
          const fp = `${s.mtimeMs}:${s.size}`;
          if (this.fingerprint !== "" && fp !== this.fingerprint) void this.reload();
          this.fingerprint = fp;
        })
        .catch(() => {}); // stat 失败=静默（reload 语义由显式调用兜底）
    };
    tick(); // 建立基线
    this.pollTimer = setInterval(tick, intervalMs);
    this.pollTimer.unref?.();
    return () => {
      if (this.pollTimer !== null) clearInterval(this.pollTimer);
      this.pollTimer = null;
    };
  }

  dispose(): void {
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  get size(): number {
    return this.digests.size;
  }
}
