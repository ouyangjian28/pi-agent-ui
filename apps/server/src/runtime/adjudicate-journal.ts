// P0-1b 裁决持久化写工具 v2（GPT r1 B1-B5 + r2 B2/B4/L1/L4 修复批）
//
// 职责：宿主人工裁决（resend/abandon）以 adjudicate 行追加进 journal（与 repair 行同机制），
// 重启后可重读配对解锁。五道门（任一拒=零改盘）：
//   ①实根包含门（r1 B4）：词法落根不够——稳定祖先 symlink 可把实文件引到根外；realpath 全链
//     解析后实路径包含判定（与 repair-tail 同界）。越界=aborted（reason=file-absent，detail=path-escape）。
//   ②盘面门（r1 B2 + r2 B2）：裁决追加的前提=盘面已愈且无在途修复事务——bad 行（含撕裂尾）非空=
//     aborted bad-tail（追加补换行会把撕裂尾变中间断行，repair-tail 只修尾→永久阻断）；repair-pending
//     marker 在场=aborted repair-pending；marker 读错误（非 ENOENT）=aborted marker-unreadable
//     （r2 B2：仅 ENOENT 视为缺失——权限/IO 故障时「无在途事务」没有证据，保守拒）。
//   ③身份门（r1 B1/B3/B5）：subject（fragment/repair）=修复事务四元组，须与恰一条 repair 行
//     唯一匹配（多条同四元组=歧义拒）；fragment 另验 intentId∈重放 enqueue∪sending 集。raw 全文
//     不入 subject（r2 B4：写面构造最小 subject 白名单拷贝，不透传额外属性；schema 拒 raw 的运行时
//     兑底在 protocol 层）。
//   ④幂等/冲突终局（r1 B3 + r2 B3 + r4 双证）：同四元组已有任一裁决→候选加入后统一二维判定：
//     verdicts（priors 全部+本次）>1 或归因目标（fragment 面）>1=conflicting-verdict（矛盾证据不
//     追加新裁决，不信任首行，r5 起不限定请求 kind）；同 verdict 的 repair+fragment 双行=双证合法
//     共存（对账+归因，kind 维不判矛盾）；kind 内同 verdict 同目标=idempotent 返回原时点。
//   ⑤锚预检门（r2 L4）：锚损坏/不可读=aborted anchor-corrupt 写前拒（证据链已坏，追加裁决不
//     修复证据链，需人工）。前缀漂移不拒（修复流程截尾使 byteLength<anchor.len 是常态），落盘后
//     跳过转移留审计，待 recapture/人工核验（不承诺自动收敛）。
// 落盘：append+sync（失败=write-failed，提交结果不确定——append 已完成的形裁决已在盘，
// 幂等重试收敛，非「零裁决」）；锚点转移失败不回滚不阻断。句柄全程 try/finally 确定性 close
// （r2 L1，不依赖 GC）。
//
// 信任域：宿主侧受信动作（操作者记名）；evidenceDir（锚+marker）为宿主专属，journal 写者无权触。
// 披露：前缀复验基于初读缓冲（串行前提内的追加窗校验，非并发检测）；marker/锚 tmp+rename
// 无目录 fsync（沿用 Q13 限制）。

import { randomBytes, createHash } from "node:crypto";
import { readFile, realpath, rename, writeFile } from "node:fs/promises";
import { isAbsolute, sep } from "node:path";
import type { FileHandle } from "node:fs/promises";
import { parseJournalText } from "./recover.ts";
import { journalLineSchemaError, type AdjudicateLine, type JournalLine, type IntentId } from "@pi-agent-ui/protocol";

export type AdjudicateSubject =
  | { kind: "fragment"; removedSha256: string; byteStart: number; byteEnd: number; at: string; intentId: IntentId }
  | { kind: "repair"; removedSha256: string; byteStart: number; byteEnd: number; at: string };

export interface AdjudicateOptions {
  /** journal 文件名（相对授权根）。 */
  readonly file: string;
  /** 授权根目录集（journal 只许落在这些根内）。 */
  readonly roots: readonly string[];
  /** 证据目录（锚点与 repair-pending marker 所在，宿主专属信任域）。 */
  readonly evidenceDir: string;
  readonly subject: AdjudicateSubject;
  readonly verdict: "resend" | "abandon";
  readonly operator: string;
  readonly buildId: string;
  readonly contractVersion?: number;
  readonly at?: string;
  /** 审计回调（结构化留痕，不阻断）。 */
  readonly audit?: (msg: string) => void;
  /** 测试接缝：打开句柄（默认 openSafeReadWrite）。 */
  readonly openHandle?: (abs: string) => Promise<{ fh: FileHandle; size: number }>;
  /** 测试接缝：读 marker 内容（默认 readFile）。 */
  readonly readMarker?: (path: string) => Promise<string>;
  /** 测试接缝：锚转移（默认 tmp+rename 原子写）。 */
  readonly writeAnchorImpl?: (path: string, body: string) => Promise<void>;
}

export type AdjudicateResult =
  | { kind: "adjudicated"; at: string; anchorMoved: boolean }
  | { kind: "idempotent"; at: string }
  | { kind: "aborted"; reason: "file-absent" | "path-escape" | "repair-pending" | "marker-unreadable" | "bad-tail" | "anchor-corrupt" | "subject-absent" | "conflicting-verdict" | "inconsistent-attribution" | "write-failed"; detail?: string };

interface AnchorFile {
  readonly version: 1;
  readonly file: string;
  readonly len: number;
  readonly sha: string;
  readonly capturedAt: string;
}

function anchorPath(evidenceDir: string, file: string): string {
  return `${evidenceDir}/${encodeURIComponent(file)}.evidence.json`;
}
function markerPath(evidenceDir: string, file: string): string {
  return `${evidenceDir}/${encodeURIComponent(file)}.repair-pending.json`;
}

async function loadAnchor(evidenceDir: string, file: string): Promise<AnchorFile | null | "corrupt" | "unreadable"> {
  let txt: string;
  try {
    txt = await readFile(anchorPath(evidenceDir, file), "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? null : "unreadable";
  }
  try {
    const a = JSON.parse(txt) as AnchorFile;
    // r4（GPT r3 B-r3-3）：严格锚 schema——与 repair-tail parseAnchor 逐项对齐（version=1+绑定
    // 当前 file+len 非负安全整数+sha 64 位小写 hex）。只验两个字段类型时非法身份锚可被新锚洗白。
    if (a !== null && typeof a === "object" && a.version === 1 && a.file === file &&
        typeof a.len === "number" && Number.isSafeInteger(a.len) && a.len >= 0 &&
        typeof a.sha === "string" && /^[0-9a-f]{64}$/.test(a.sha)) {
      return a;
    }
    return "corrupt";
  } catch {
    return "corrupt";
  }
}

async function resolveWithinRoots(file: string, roots: readonly string[]): Promise<string | null> {
  if (!isAbsolute(file)) {
    for (const r of roots) {
      if (isAbsolute(r)) {
        const abs = `${r.replace(/\/+$/, "")}/${file}`;
        return abs;
      }
    }
    return null;
  }
  return null; // 绝对路径一律不接受（只吃相对名）
}

function sha256HexBuf(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function repairKey(s: { removedSha256: string; byteStart: number; byteEnd: number; at: string }): string {
  return `${s.removedSha256}|${s.byteStart}|${s.byteEnd}|${s.at}`;
}

function knownIntentIds(lines: readonly JournalLine[]): Set<IntentId> {
  // 重放身份面：enqueue（入队意图）/sending（发送开栓）——归因目标须在重放范围内。
  const ids = new Set<IntentId>();
  for (const l of lines) if (l.t === "enqueue" || l.t === "sending") ids.add(l.intentId);
  return ids;
}

export async function adjudicateJournal(opts: AdjudicateOptions): Promise<AdjudicateResult> {
  const audit = opts.audit ?? (() => {});

  // ①实根包含门（r1 B4：词法解析后 realpath 全链验根，祖先 symlink 越界拒）。
  const abs = await resolveWithinRoots(opts.file, opts.roots);
  if (abs === null) return { kind: "aborted", reason: "file-absent", detail: "path-escape" };
  let jReal: string;
  try {
    jReal = await realpath(abs);
  } catch {
    audit(`adjudicate-aborted file=${opts.file} reason=file-absent detail=realpath-failed`);
    return { kind: "aborted", reason: "file-absent", detail: "realpath-failed" };
  }
  let insideRoots = false;
  for (const r of opts.roots) {
    let rReal: string;
    try {
      rReal = await realpath(r);
    } catch {
      continue;
    }
    if (jReal === rReal || jReal.startsWith(rReal + sep)) {
      insideRoots = true;
      break;
    }
  }
  if (!insideRoots) {
    audit(`adjudicate-aborted file=${opts.file} reason=file-absent detail=path-escape real=${jReal}`);
    return { kind: "aborted", reason: "file-absent", detail: "path-escape" };
  }

  const openHandle = opts.openHandle ?? (async (a: string) => {
    const { openSafeReadWrite } = await import("../ws/safe-open.ts");
    const real = await openSafeReadWrite(a);
    return { fh: real.fh as unknown as FileHandle, size: real.size };
  });
  let fh: FileHandle | null = null; // r4 L-r3-1：open 成功后即进入 try/finally——readFile 失败也确定性 close，不依赖 GC
  let rawBuf: Buffer;
  try {
    const opened = await openHandle(abs);
    fh = opened.fh;
    rawBuf = await fh.readFile();
  } catch {
    if (fh) await fh.close().catch((e) => audit(`adjudicate-fh-close-failed file=${opts.file} detail=${String(e)}`));
    audit(`adjudicate-aborted file=${opts.file} reason=file-absent`);
    return { kind: "aborted", reason: "file-absent", detail: "open-or-read-failed" };
  }
  // r2 L1：句柄确定性关闭——获得句柄后所有路径（含 return/throw）统一 finally close，不依赖 GC。
  try {
    return await adjudicateWithHandle(opts, audit, fh, rawBuf);
  } finally {
    await fh.close().catch((e) => audit(`adjudicate-fh-close-failed file=${opts.file} detail=${String(e)}`));
  }
}

async function adjudicateWithHandle(
  opts: AdjudicateOptions,
  audit: (msg: string) => void,
  fh: FileHandle,
  rawBuf: Buffer,
): Promise<AdjudicateResult> {
  const text = rawBuf.toString("utf8");
  const { lines, bad } = parseJournalText(text);

  // ②盘面门（r1 B2 + r2 B2）：marker 在场=修复事务未完→拒；bad 非空（含撕裂尾）=盘面未愈→拒。
  // r2 B2：仅 ENOENT 视为 marker 缺失——其他读错误（EACCES/EISDIR/EIO…）=「无在途事务」没有
  // 证据，保守拒（零改盘）；与 recovery-evidence-source 仅放过 ENOENT 同界。
  const readMarker = opts.readMarker ?? ((p: string) => readFile(p, "utf8"));
  let markerPresent: boolean;
  try {
    await readMarker(markerPath(opts.evidenceDir, opts.file));
    markerPresent = true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      audit(`adjudicate-aborted file=${opts.file} reason=marker-unreadable detail=${code ?? "unknown"}`);
      return { kind: "aborted", reason: "marker-unreadable", detail: `marker 读失败（${code ?? "unknown-error"}），在场性无证据→保守拒` };
    }
    markerPresent = false;
  }
  if (markerPresent) {
    audit(`adjudicate-aborted file=${opts.file} reason=repair-pending`);
    return { kind: "aborted", reason: "repair-pending", detail: "修复事务进行中（marker 在场），事务完成后再裁决" };
  }
  if (bad.length > 0) {
    audit(`adjudicate-aborted file=${opts.file} reason=bad-tail badCount=${bad.length}`);
    return { kind: "aborted", reason: "bad-tail", detail: "盘面存在坏行/撕裂尾（未愈），修复完成后再裁决" };
  }

  // ⑤锚预检门（r2 L4）：锚损坏/不可读=证据链已坏→写前拒（零改盘；追加裁决不修复证据链，需人工）。
  // 前缀漂移不在此拒（修复流程截尾使 byteLength<anchor.len 是常态），落盘后跳过转移。
  const anchor = await loadAnchor(opts.evidenceDir, opts.file);
  if (anchor === "corrupt" || anchor === "unreadable") {
    audit(`adjudicate-aborted file=${opts.file} reason=anchor-corrupt detail=${anchor}`);
    return { kind: "aborted", reason: "anchor-corrupt", detail: `锚证据链损坏（${anchor}），裁决不能替代人工处置` };
  }

  // ③身份门（r1 B1/B3/B5）：四元组与 repair 行唯一匹配；fragment 另验归因目标在重放范围。
  const subject = minimalSubject(opts.subject);
  const repairRows = lines.filter((l): l is Extract<JournalLine, { t: "repair" }> => l.t === "repair");
  const wantKey = repairKey(subject);
  const matches = repairRows.filter((l) => repairKey(l) === wantKey);
  if (matches.length !== 1) {
    return { kind: "aborted", reason: "subject-absent", detail: matches.length === 0 ? "四元组无匹配 repair 行" : "四元组匹配多条 repair 行（歧义拒）" };
  }
  if (subject.kind === "fragment" && !knownIntentIds(lines).has(subject.intentId)) {
    return { kind: "aborted", reason: "subject-absent", detail: "归因目标不在重放范围（enqueue∪sending 集）" };
  }
  // r7（GPT r6 P1-r6-1）：结构一致门——repair 行结构归因留痕（fragIntentId）与 fragment 裁决
  // 归因目标强一致。残片顶层身份可证时归因必须与之一致，否则拒：防「结构 i1/归因 i2」矛盾
  // 裁决落盘，冷捕获丢 raw 后读面失忆使 i1 越过影响域（审人 S5 反例）。缺省（存量）/null
  //（补完/不可归因）无结构证据→不强一致（读面未归因事务阻断门兜底）。
  const structuralId = matches[0]?.fragIntentId ?? null;
  if (subject.kind === "fragment" && structuralId !== null && subject.intentId !== structuralId) {
    return { kind: "aborted", reason: "inconsistent-attribution", detail: `归因目标 ${subject.intentId} 与残片结构身份 ${structuralId} 不一致（矛盾裁决拒落盘）` };
  }

  // ④幂等/冲突终局（r1 B3 + r2 B3）：收集该四元组全部既有裁决（两 kind），矛盾集检测——
  // 手写盘面/崩溃残局可产生多 verdict/多目标，矛盾在场即拒（不信任 find 首行）。
  const existing = lines.filter((l): l is JournalLine & { t: "adjudicate" } => l.t === "adjudicate");
  const priors = existing.filter((a) => repairKey(a.subject) === wantKey);
  if (priors.length > 0) {
    // r5（GPT r4 P1-r4-2）：候选加入后组一致性二维判定先于 kind 内幂等——verdicts 含本次请求、
    // targets 不限定请求 kind。旧形只验 priors 内部+新 kind 首行直接放行：repair abandon 在场+
    // fragment resend 追加=写入后读面整组剔除→恢复锁死；多目标组收到 repair 请求同样落行。
    const candVerdicts = new Set<string>([...priors.map((a) => a.verdict), opts.verdict]);
    if (candVerdicts.size > 1) {
      return { kind: "aborted", reason: "conflicting-verdict", detail: `候选加入后组矛盾（verdicts=${[...candVerdicts].join("/")}），终局不可翻转` };
    }
    const candTargets = new Set<IntentId>(priors.map((a) => (a.subject.kind === "fragment" ? a.subject.intentId : null)).filter((t): t is IntentId => t !== null));
    if (subject.kind === "fragment" && subject.intentId !== undefined) candTargets.add(subject.intentId);
    if (candTargets.size > 1) {
      return { kind: "aborted", reason: "conflicting-verdict", detail: `候选加入后组矛盾（归因目标=${[...candTargets].join("/")}），终局不可静默更换` };
    }
    const first = priors[0];
    const onlyTarget = candTargets.size === 1 ? [...candTargets][0] : undefined;
    if (first === undefined) return { kind: "aborted", reason: "conflicting-verdict", detail: "既有裁决集不可读（矛盾证据拒）" };
    // r4（GPT r3 B-r3-2 双证）：repair 裁决（对账）与 fragment 裁决（归因）同四元组同 verdict=合法共存
    // （不同 subject，互不构成翻转）；幂等/终局翻转判定按 kind 分域（组一致性已验，此处为 kind 内幂等面）。
    const sameKind = priors.filter((a) => a.subject.kind === subject.kind);
    const sameKindFirst = sameKind[0];
    if (sameKindFirst !== undefined) {
      if (sameKindFirst.verdict === opts.verdict && (subject.kind !== "fragment" || (onlyTarget !== undefined && onlyTarget === subject.intentId))) {
        return { kind: "idempotent", at: sameKindFirst.at };
      }
      // 防御保留（组一致性已拦同 kind 翻 verdict/换目标；此处不可达）
      if (subject.kind === "fragment" && onlyTarget !== undefined && onlyTarget !== subject.intentId) {
        return { kind: "aborted", reason: "conflicting-verdict", detail: `该修复事务已绑定归因目标 ${onlyTarget}（终局不可静默更换）` };
      }
      return { kind: "aborted", reason: "conflicting-verdict", detail: `已裁决 ${sameKindFirst.verdict}，终局不可翻转` };
    }
    // 该 kind 首行：跨 kind 双证追加（candVerdicts/candTargets 已验单一，无矛盾面）
  }

  // 落盘：盘面门保证无撕裂尾（sep 逻辑保留作防御）；append+sync。
  const line: AdjudicateLine = {
    t: "adjudicate",
    subject,
    verdict: opts.verdict,
    operator: opts.operator,
    buildId: opts.buildId,
    contractVersion: opts.contractVersion ?? 2,
    at: opts.at ?? new Date().toISOString(),
  };
  const schemaErr = journalLineSchemaError(line as unknown as Record<string, unknown>);
  if (schemaErr !== null) return { kind: "aborted", reason: "write-failed", detail: `schema: ${schemaErr}` };
  const body = JSON.stringify(line);
  const sepNeeded = rawBuf.byteLength === 0 || rawBuf[rawBuf.byteLength - 1] === 0x0a ? "" : "\n";
  const appended = Buffer.from(`${sepNeeded}${body}\n`, "utf8");
  try {
    await fh.appendFile(appended);
    await fh.sync();
  } catch (e) {
    // 提交结果不确定：append 已完成再抛（如 sync 失败）的形裁决已在盘——幂等重试收敛，非零裁决。
    audit(`adjudicate-aborted file=${opts.file} reason=write-failed detail=${String(e)}`);
    return { kind: "aborted", reason: "write-failed", detail: "append-or-sync-failed（提交结果不确定，幂等重试收敛）" };
  }

  // 锚点转移：前缀复验（初读缓冲内的追加窗校验，串行前提；非并发检测）→len/sha 前移。
  // 锚已在⑤门预检（corrupt/unreadable 已写前拒，此处必为合法锚或缺失）；漂移/转移失败不回滚
  // 不阻断——锚已过期待宿主 recapture 或人工核验（provider 对漂移锚保守拒，不承诺自动收敛）。
  let anchorMoved = false;
  if (anchor !== null) {
    const prefixOk = rawBuf.byteLength >= anchor.len && sha256HexBuf(rawBuf.subarray(0, anchor.len)) === anchor.sha;
    if (!prefixOk) {
      audit(`adjudicate-anchor-stale file=${opts.file}（锚前缀漂移，跳过转移；锚已过期，待 recapture/人工核验）`);
    } else {
      const next: AnchorFile = { version: 1, file: opts.file, len: rawBuf.byteLength + appended.byteLength, sha: sha256HexBuf(Buffer.concat([rawBuf, appended])), capturedAt: line.at };
      const writeAnchorImpl = opts.writeAnchorImpl ?? (async (p: string, b: string) => {
        const tmp = `${p}.tmp-${process.pid}-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
        await writeFile(tmp, b, "utf8");
        await rename(tmp, p);
      });
      try {
        await writeAnchorImpl(anchorPath(opts.evidenceDir, opts.file), JSON.stringify(next));
        anchorMoved = true;
      } catch (e) {
        audit(`adjudicate-anchor-transfer-failed file=${opts.file} detail=${String(e)}（裁决已落盘；锚待 recapture/人工核验）`);
      }
    }
  }
  return { kind: "adjudicated", at: line.at, anchorMoved };
}

// r2 B4：最小 subject 构造——白名单字段拷贝，不透传 opts.subject 引用（额外属性如 raw 不落盘；
// 运行时兑底=protocol schema 拒 raw，此为写面第二道）。
function minimalSubject(s: AdjudicateSubject): AdjudicateSubject {
  return s.kind === "fragment"
    ? { kind: "fragment", removedSha256: s.removedSha256, byteStart: s.byteStart, byteEnd: s.byteEnd, at: s.at, intentId: s.intentId }
    : { kind: "repair", removedSha256: s.removedSha256, byteStart: s.byteStart, byteEnd: s.byteEnd, at: s.at };
}
