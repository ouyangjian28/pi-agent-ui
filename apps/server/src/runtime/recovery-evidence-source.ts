// 3b-4 恢复真读源 v2（fix11：GPT 3b4 复审 69/100 B11-1..B11-5 重构）。
// 冻结依据不变：3b-0 对齐 §5 3b-4 四条+docs/ws-ui-contracts-v1.md §5.6 合计 8MiB 门。
// v2 五改（对应 B11-1..B11-5）：
//  B11-1 安全打开：journal/session 打开一律走 ws/safe-open（O_NOFOLLOW|O_NONBLOCK+同 fd fstat 常规验证），
//    根外 symlink/FIFO/设备不再可达或永挂；openLike 接缝保留可测性。
//  B11-2 权威证据链：evidenceDir sidecar 锚点（len+sha256(raw)）。已见证据只许纯追加扩展
//    （新 raw 前 len 字节 sha==锚 sha 且新长≥旧长）；缩/重写/替换→unavailable:concurrent-modification
//    （fail-closed：修复截尾后 bad 消失不得洗白成干净快照）；sidecar 损坏=篡改面→同拒；
//    sidecar 不可写→read-failed（证据锚点不落盘不得发结论）。驱逐/重启后锚点仍在（持久化）。
//  B11-3 读窗完整性：读侧=有界流式循环（EOF 才止+读中超限即败）+读后字节复核+读后 session 复核
//    （读窗内 session 增长→合计再验 fail-closed；session 缩/消失=已披露残余窗口，不回退结论）。
//  B11-4 工厂自防御：maxCombinedBytes 非有限正整数/超 1GiB→工厂即抛（composition 校验之外的纵深）。
//  B11-5 file-unreadable→网关 4402 retryable=true（契约 §5.2/§5.3/3b-0 §4F）；path 字段=逻辑 file
//    （绝对路径不出 provider——审计面不泄盘面布局，GPT P12）。
// v3（fix12：GPT 第12轮 78/100 B12-1/2/3）：
//  B12-1 冷启动权威门（Q02/Q03）：锚点缺失≠首捕授权——默认 no-evidence-snapshot（当前盘面不自行
//    成为权威：修复发生在首捕前的反例不可证）；仅宿主显式 trustFirstCapture 授权才建首锚；证据仓
//    seen 登记后锚点丢失→concurrent-modification（bless 不可越——已初始化仓丢条目≠可信新生）。
//  B12-2 session 首开 missing 不再抹掉映射（Q05）：s1=0 但 sAbs 保留，读后二开复核新建尺寸
//    （仍 missing=journal-only 降级不变）。
//  小修：零长锚点也验空摘要（去 len===0 直通特判）；非 SafeOpenError 的 detail 归受控分类不透传
//    message；同 file 串行 Map 所有权条件清理（Q14）；工厂补 roots 非空+sessionRoots 绝对校验。
//  披露边界：serialize=单实例内串行（跨进程无锁，部署禁重叠写者——Q16）；锚点 tmp+rename 原子
//    ≠掉电耐久（无 fsync——Q13）；读块固定 64KiB 探测（越限块不进结果但已读入临时 buffer）。
// v4（fix13：GPT 第13轮 80/100 B13-1/B13-2）：
//  B13-1 seen 丢更新闭合：捕获串行从 per-file Map 改为仓级单链（同实例内所有 file 串行——
//    seen 读改写整体事务化，跨 file 并行首捕不再整体覆盖丢登记）；tmp 名加 randomBytes 独占量
//    （同毫秒同名碰撞面消除）。
//  B13-2 登记不变量：「成功返回快照前 seen 登记已建立」。seen 恒读（有锚也读——损坏/不可读→
//    read-failed fail-closed，不再有锚跳过）；有锚而未登记（首捕 seen 写失败的 B13-2 残局、
//    fix11 旧锚迁移）→验证纯追加后补登记再返回（补登记失败=read-failed）。
//  部署前提（随 Q16）：evidenceDir 须为可信目录（seen/锚点 sidecar 本身不可被非信任方读写替换）；
//    快照「已见证据」语义以捕获/提交时点为准（Q12：窗口内并发截断属运行时干预面）。
// 取消语义（披露）：signal=各步骤间观察点+读后复核；当前挂起 I/O 本身不消费 signal（safe-open 读窗
// 有界+快，取消语义=迟到结果被网关连接态丢弃——st.closed 不入帧不回填缓存）。
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { parseJournalText } from "./recover.ts";
import type { RecoveryEvidenceSnapshot } from "./recover.ts";
import type { SessionId } from "@pi-agent-ui/protocol";
import { openSafeFile, readBounded, resolveWithinRoots } from "../ws/safe-open.ts";
import { SafeOpenError } from "../ws/safe-open.ts";

/** typed 失败/成功结果（3b-0 冻结三形；reason 枚举=契约 §4 unavailable reason 冻结集）。 */
export type RecoveryEvidenceResult =
  | RecoveryEvidenceSnapshot
  | { readonly kind: "unavailable"; readonly reason: "read-failed" | "concurrent-modification" | "oversized" | "no-evidence-snapshot" }
  | { readonly kind: "file-unreadable"; readonly path: string; readonly detail?: string };

/** 快照判别（snapshot 无 kind 字段；union 收窄用）。 */
export function isRecoverySnapshot(x: RecoveryEvidenceResult | null | undefined): x is RecoveryEvidenceSnapshot {
  return x !== null && x !== undefined && (x as { kind?: string }).kind === undefined;
}

/** 合计入口预算默认值（契约 §5.6：8MB=8*1024*1024）。 */
export const DEFAULT_RECOVERY_COMBINED_BYTES = 8 * 1024 * 1024;

/** 安全句柄接缝：size=open 后同句柄 fstat 尺寸；read 可返回超 maxBytes 的 Buffer（provider 复核
 *  ——seam 测试注入增长竞态的合法形态）；close 幂等。默认实现=safe-open readBounded（读中超限即抛）。 */
export interface SafeHandleLike {
  readonly size: number;
  read(maxBytes: number): Promise<Buffer>;
  close(): Promise<void>;
}
export type OpenLike = (abs: string) => Promise<SafeHandleLike>;

/** 默认安全打开：O_NOFOLLOW|O_NONBLOCK+fd fstat；read=有界流式循环（too-large 抛 SafeOpenError）。 */
const defaultOpenLike: OpenLike = async (abs) => {
  const { fh, size } = await openSafeFile(abs);
  return {
    size,
    read: (maxBytes: number) => readBounded(fh, maxBytes, abs),
    close: () => fh.close(),
  };
};

export interface RecoveryEvidenceSourceOptions {
  /** journal 授权根（与网关 roots 同源口径；必须绝对路径——composition 校验）。 */
  readonly roots: readonly string[];
  /** session 根（默认=roots）。 */
  readonly sessionRoots?: readonly string[];
  /** 逻辑 file→session 路径映射。返回值必须=可解析进 sessionRoots 的相对名（嵌套子目录合法；
   * 绝对路径/越界=配置错→file-unreadable 响亮失败，不静默 journal-only——GPT P10）。 */
  readonly sessionFor?: (file: string) => string;
  /** 证据链 sidecar 目录（必须绝对路径；锚点文件=<encodeURIComponent(file)>.evidence.json）。 */
  readonly evidenceDir: string;
  /** journal+session 合计入口预算（默认 8MiB；工厂自验：有限正整数≤1GiB）。 */
  readonly maxCombinedBytes?: number;
  /** 快照 sessionId 派生（默认=去 .jsonl 后缀）。 */
  readonly sessionIdFor?: (file: string) => SessionId;
  readonly now?: () => number;
  readonly audit?: (line: string) => void;
  /** 测试接缝：安全句柄注入（默认=safe-open 真路径）。 */
  readonly openLike?: OpenLike;
  /** 首捕授权（B12-1/Q02）：锚点缺失且仓未登记该 file 时，默认 no-evidence-snapshot（fail-closed）。
   * 仅宿主显式初始化路径（迁移/可信新建声明）返回 true 才建首锚；已登记 file 的锚点丢失
   * →concurrent-modification，本回调不可越（Q03）。抛错=read-failed（宿主面故障≠拒绝授权）。 */
  readonly trustFirstCapture?: (file: string) => boolean | Promise<boolean>;
}

/** sidecar 锚点（权威证据链：已见证据的字节长度+sha256；只许纯追加扩展）。 */
interface EvidenceAnchor {
  readonly version: 1;
  readonly file: string;
  readonly len: number;
  readonly sha: string; // hex
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function anchorPath(evidenceDir: string, file: string): string {
  return join(evidenceDir, `${encodeURIComponent(file)}.evidence.json`);
}

/** 证据仓登记（B12-1/Q03：曾建锚点的 file 集合——锚点丢失时区分「证据丢失」与「可信新生」）。 */
interface EvidenceSeen {
  readonly version: 1;
  readonly files: readonly string[];
}

function seenPath(evidenceDir: string): string {
  return join(evidenceDir, "seen.json");
}

/** 证据仓登记读取（B12-1/Q03）：ENOENT=空仓（可信新生候选）；损坏/不可读→抛（调用方 read-failed）。 */
async function loadSeen(sp: string): Promise<ReadonlySet<string>> {
  try {
    const txt = await readFile(sp, "utf8");
    const parsed = JSON.parse(txt) as Partial<EvidenceSeen>;
    if (parsed !== null && typeof parsed === "object" && parsed.version === 1 &&
        Array.isArray(parsed.files) && parsed.files.every((f) => typeof f === "string" && f.length > 0)) {
      return new Set(parsed.files);
    }
    throw new Error("seen.json 形状非法");
  } catch (e) {
    if (isIoErrno(e, "ENOENT")) return new Set<string>();
    throw e; // 损坏/不可读=fail-closed（不得把「仓状态未知」当空仓——防 Q03 洗白面）
  }
}

function isIoErrno(e: unknown, code: string): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === code;
}

/** safe-open 错误→typed file-unreadable（detail=kind，不带绝对路径——P12 审计面脱敏）。 */
function toUnreadable(file: string, e: unknown): { kind: "file-unreadable"; path: string; detail?: string } {
  if (e instanceof SafeOpenError) return { kind: "file-unreadable", path: file, detail: e.kind };
  // fix12：非 SafeOpenError 曾透传原始 message（扩展 openLike 抛带绝对路径的 Error 会泄入审计）——
  // 归受控分类（errno code / 构造名），不透传任意 message（GPT 第12轮 §七）。
  const code = typeof (e as { code?: unknown } | null)?.code === "string" ? (e as { code: string }).code : undefined;
  const detail = code ?? (e instanceof Error ? e.constructor.name : typeof e);
  return { kind: "file-unreadable", path: file, detail };
}

/**
 * 生产 provider 工厂。file=网关已授权的逻辑 file 名。同 file 并发捕获串行化（sidecar 锚点写竞争归一）。
 * 返回值：snapshot=新权威快照；unavailable/ file-unreadable 见类型注释（网关映射见 ws-gateway）。
 */
export function createRecoveryEvidenceProvider(
  opts: RecoveryEvidenceSourceOptions,
): (file: string, signal?: AbortSignal) => Promise<RecoveryEvidenceResult> {
  const maxBytes = opts.maxCombinedBytes ?? DEFAULT_RECOVERY_COMBINED_BYTES;
  if (!Number.isFinite(maxBytes) || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024 * 1024) {
    throw new Error(`maxCombinedBytes 非法（须有限正整数≤1GiB）：${String(maxBytes)}——拒绝创建 provider（B11-4 纵深）`);
  }
  if (!isAbsolute(opts.evidenceDir)) throw new Error("evidenceDir 非法（须绝对路径）——拒绝创建 provider");
  if (opts.roots.length === 0) throw new Error("roots 非法（不得为空）——拒绝创建 provider");
  if (!opts.roots.every(isAbsolute)) throw new Error("roots 非法（须绝对路径）——拒绝创建 provider");
  if (opts.sessionRoots !== undefined && !opts.sessionRoots.every(isAbsolute)) {
    throw new Error("sessionRoots 非法（须绝对路径）——拒绝创建 provider");
  }
  const sessionIdFor = opts.sessionIdFor ?? ((f: string) => f.replace(/\.jsonl$/, ""));
  const openLike = opts.openLike ?? defaultOpenLike;
  const now = opts.now ?? (() => Date.now());
  const audit = opts.audit ?? (() => {});
  const sessionRoots = opts.sessionRoots ?? opts.roots;
  const evidenceDir = opts.evidenceDir;
  let dirReady: Promise<void> | null = null; // 目录准备惰性一次
  const ensureDir = (): Promise<void> => {
    if (dirReady === null) dirReady = mkdir(evidenceDir, { recursive: true }).then(() => undefined, (e) => { dirReady = null; throw e; });
    return dirReady;
  };
  // B13-1 仓级单链：同实例内所有 file 的捕获串行（seen 读改写整体事务化——跨 file 并行首捕
  // 不再各自 loadSeen 旧集后整体覆盖写丢登记）。O(1) 单链尾，无 Map 无所有权清理（Q14 随之消解）。
  // 跨实例无锁（Q16 部署前提：禁重叠写者）。
  let chain: Promise<unknown> = Promise.resolve();
  const serialize = <T>(file: string, body: () => Promise<T>): Promise<T> => {
    void file; // 串行域=仓级（evidenceDir），file 仅入 body 闭包
    const next = chain.then(body, body);
    chain = next.then(() => undefined, () => undefined);
    return next;
  };
  const unavailable = (reason: "read-failed" | "concurrent-modification" | "oversized" | "no-evidence-snapshot") =>
    ({ kind: "unavailable" as const, reason });

  return (file: string, signal?: AbortSignal): Promise<RecoveryEvidenceResult> =>
    serialize(file, async () => {
      if (signal?.aborted) return unavailable("read-failed");
      // journal 解析（safe-open 口径：双根授权+目录分隔边界）
      const jAbs = resolveWithinRoots(file, opts.roots);
      if (jAbs === null) return { kind: "file-unreadable", path: file, detail: "journal 不在授权根内" };
      // session 映射（P10）：嵌套相对名合法；绝对路径/越界=响亮失败（禁静默 journal-only/禁绝对直通）
      let sAbs: string | null = null;
      if (opts.sessionFor !== undefined) {
        const s = opts.sessionFor(file);
        if (isAbsolute(s)) {
          audit(`recovery-session-map-invalid file=${file} detail=absolute-path`);
          return { kind: "file-unreadable", path: file, detail: "session 映射非法（绝对路径）" };
        }
        sAbs = resolveWithinRoots(s, sessionRoots);
        if (sAbs === null) {
          audit(`recovery-session-map-invalid file=${file} detail=outside-session-roots`);
          return { kind: "file-unreadable", path: file, detail: "session 映射越界" };
        }
      }
      // journal 安全打开（B11-1：symlink/FIFO/设备在此拒，同 fd fstat 取权威尺寸）
      let jh: SafeHandleLike;
      try {
        jh = await openLike(jAbs);
      } catch (e) {
        audit(`recovery-unreadable file=${file} detail=${e instanceof SafeOpenError ? e.kind : "open-failed"}`);
        return toUnreadable(file, e);
      }
      try {
        // session 安全打开（仅取尺寸；missing→journal-only 降级，其余→file-unreadable）
        let s1 = 0;
        if (sAbs !== null) {
          try {
            const sh = await openLike(sAbs);
            try { s1 = sh.size; } finally { await sh.close().catch(() => {}); }
          } catch (e) {
            if (e instanceof SafeOpenError && e.kind === "missing") {
              s1 = 0; // B12-2/Q05：保留 sAbs——读后二开复核新建尺寸；仍 missing=journal-only 降级
            }
            else {
              audit(`recovery-unreadable file=${file} detail=${e instanceof SafeOpenError ? e.kind : "session-stat-failed"}`);
              return toUnreadable(file, e);
            }
          }
        }
        if (signal?.aborted) return unavailable("read-failed");
        // 合计预算门（stat 层早拒=零读——R2 读计数断言的独占面）
        if (jh.size + s1 > maxBytes) {
          audit(`recovery-oversized file=${file} journal=${jh.size} session=${s1} budget=${maxBytes}`);
          return unavailable("oversized");
        }
        const allowed = maxBytes - s1;
        // journal 有界读（B11-3：默认=流式循环 EOF 止+读中超限即败；seam 可注入增长）
        let raw: Buffer;
        try {
          raw = await jh.read(allowed);
        } catch (e) {
          if (e instanceof SafeOpenError && e.kind === "too-large") {
            audit(`recovery-oversized-grew file=${file} journal=${jh.size} session=${s1} budget=${maxBytes}`);
            return unavailable("oversized");
          }
          audit(`recovery-unreadable file=${file} detail=read-failed`);
          return toUnreadable(file, e);
        }
        if (signal?.aborted) return unavailable("read-failed");
        // 读后字节复核（seam 违约/增长纵深——P04/P05：短读已由 EOF 循环闭合，超读在此必拒）
        if (raw.byteLength > allowed) {
          audit(`recovery-oversized-grew file=${file} journal=${jh.size} session=${s1} budget=${maxBytes} read=${raw.byteLength}`);
          return unavailable("oversized");
        }
        // session 读后复核（P07：读窗内增长→合计再验 fail-closed；缩/消失=已披露残余，不回退）
        if (sAbs !== null) {
          try {
            const sh2 = await openLike(sAbs);
            try {
              const s2 = sh2.size;
              if (raw.byteLength + s2 > maxBytes) {
                audit(`recovery-oversized-grew file=${file} journal=${jh.size} session=${s2} budget=${maxBytes}`);
                return unavailable("oversized");
              }
            } finally { await sh2.close().catch(() => {}); }
          } catch (e) {
            if (!(e instanceof SafeOpenError && e.kind === "missing")) {
              audit(`recovery-unreadable file=${file} detail=recheck-session-failed`);
              return toUnreadable(file, e);
            }
          }
        }
        // 权威证据链（B11-2）：锚点在→只许纯追加扩展；否则=已见证据被改写→concurrent-modification
        const apath = anchorPath(evidenceDir, file);
        let anchor: EvidenceAnchor | null = null;
        let anchorCorrupt = false;
        try {
          await ensureDir();
          const txt = await readFile(apath, "utf8");
          try {
            const parsed = JSON.parse(txt) as Partial<EvidenceAnchor>;
            if (parsed && parsed.version === 1 && typeof parsed.file === "string" && parsed.file === file &&
                typeof parsed.len === "number" && Number.isInteger(parsed.len) && parsed.len >= 0 &&
                typeof parsed.sha === "string" && /^[0-9a-f]{64}$/.test(parsed.sha)) {
              anchor = { version: 1, file, len: parsed.len, sha: parsed.sha };
            } else anchorCorrupt = true; // 形状非法
          } catch {
            anchorCorrupt = true; // 非法 JSON
          }
        } catch (e) {
          if (!isIoErrno(e, "ENOENT")) {
            audit(`recovery-evidence-store-failed file=${file} detail=load`);
            return unavailable("read-failed"); // 锚点不可读=证据完整性存疑→fail-closed（不静默当首捕）
          }
          // ENOENT=锚点缺失（≠首捕授权——下方 B12-1 权威门处理）
        }
        if (anchorCorrupt) {
          audit(`recovery-evidence-corrupt file=${file}`);
          return unavailable("concurrent-modification"); // 锚点损坏=篡改面（原子写防撕裂；坏=外部干预）
        }
        // B13-2 seen 恒读（有锚也读）：仓损坏/不可读=read-failed fail-closed（不静默放行）。
        let seen: ReadonlySet<string>;
        try {
          seen = await loadSeen(seenPath(evidenceDir));
        } catch {
          audit(`recovery-evidence-store-failed file=${file} detail=seen-load`);
          return unavailable("read-failed");
        }
        // B12-1 冷启动权威门（Q02/Q03）：锚点缺失时当前盘面不自行成为权威。已登记 file 锚点丢失
        // =证据丢失→concurrent-modification（bless 不可越）；未登记 file 默认 no-evidence-snapshot，
        // 仅宿主显式 trustFirstCapture=true（迁移/可信新建声明）才建立首锚。
        if (anchor === null) {
          if (seen.has(file)) {
            audit(`recovery-evidence-lost file=${file}`);
            return unavailable("concurrent-modification"); // Q03：已初始化仓丢条目≠可信新生
          }
          let trusted = false;
          if (opts.trustFirstCapture !== undefined) {
            try {
              trusted = await opts.trustFirstCapture(file);
            } catch {
              audit(`recovery-evidence-store-failed file=${file} detail=bless`);
              return unavailable("read-failed"); // 宿主面故障≠拒绝授权（与 false 区分）
            }
          }
          if (!trusted) {
            audit(`recovery-no-first-authority file=${file}`);
            return unavailable("no-evidence-snapshot"); // Q02：默认 fail-closed
          }
        }
        const sha = sha256Hex(raw);
        if (anchor !== null) {
          // fix12/Q17：去 len===0 直通特判——零长锚也须 sha==H(empty)（形似的 64 个 0 伪锚必拒）
          const pureExtension = raw.byteLength >= anchor.len &&
            sha256Hex(raw.subarray(0, anchor.len)) === anchor.sha;
          if (!pureExtension) {
            audit(`recovery-evidence-rewritten file=${file} oldLen=${anchor.len} newLen=${raw.byteLength}`);
            return unavailable("concurrent-modification"); // 已见证据被缩/重写/替换——修复残片消失≠干净
          }
        }
        // 锚点写穿（原子 tmp+rename；失败=证据不落盘不得发结论→read-failed）
        try {
          const tmp = `${apath}.tmp-${process.pid}-${now().toString(36)}-${randomBytes(6).toString("hex")}`;
          await writeFile(tmp, JSON.stringify({ version: 1, file, len: raw.byteLength, sha } satisfies EvidenceAnchor), "utf8");
          await rename(tmp, apath);
        } catch {
          audit(`recovery-evidence-store-failed file=${file} detail=store`);
          return unavailable("read-failed");
        }
        // B13-2 登记不变量：成功返回快照前 seen 登记已建立。未登记而至此=首捕（bless 已过）或
        // B13-2 残局（锚写成+seen 写败）或 fix11 旧锚迁移——一律补登记再返回（失败=fail-closed：
        // 仓登记不落盘不得发结论，杜绝重试绕登记直通快照）。Q03 防锚点丢失洗白同源。
        if (!seen.has(file)) {
          try {
            const nextSeen = { version: 1, files: [...new Set([...seen, file])].sort() } satisfies EvidenceSeen;
            const stmp = `${seenPath(evidenceDir)}.tmp-${process.pid}-${now().toString(36)}-${randomBytes(6).toString("hex")}`;
            await writeFile(stmp, JSON.stringify(nextSeen), "utf8");
            await rename(stmp, seenPath(evidenceDir));
          } catch {
            audit(`recovery-evidence-store-failed file=${file} detail=seen-store`);
            return unavailable("read-failed");
          }
        }
        const { lines, bad } = parseJournalText(raw.toString("utf8"));
        return { version: 1, file, sessionId: sessionIdFor(file), lines, bad, attributedFragments: [], repaired: false, createdAt: now() };
      } finally {
        await jh.close().catch(() => {});
      }
    });
}
