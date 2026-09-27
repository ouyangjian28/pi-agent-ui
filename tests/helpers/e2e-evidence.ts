// 3c-3（20b B2）：E2E 证据推导助手——纯函数，供 ws-write-e2e E4 断言与单元负例共用。
// 存在理由：20b 裁决要求「在飞/身份/窗口」不靠事后反推——
// - 身份=onSpawned 在 spawn 时记录（findSpawnFor）；
// - 在飞=snapshot 时刻 sending 已现且 settled 未现（inFlightAt）；
// - 销毁链=绑定 handle 的 stop<exit<registry<composition 结构化索引比较（disposeChain）；
// - 出口形状=code/signal 字段类型严格校验（assertExitShape）。
// 负例（先完成不算在飞/借 s1 过/坏形状拒收）在 tests/unit/server/e2e-evidence-helpers.test.ts。

export interface SpawnRecord {
  readonly file: string;
  readonly id: string;
  readonly generation: number;
}

export interface JLineLike {
  readonly t?: string;
  readonly intentId?: string;
  readonly generation?: number;
}

/** 从 onSpawned 记录里取指定 journal 文件的身份（严格相等；找不到=抛错，不猜最近的）。 */
export function findSpawnFor(spawns: readonly SpawnRecord[], file: string): SpawnRecord {
  const hits = spawns.filter((s) => s.file === file);
  const last = hits.length > 0 ? hits[hits.length - 1] : undefined;
  if (last === undefined) throw new Error(`findSpawnFor：无 ${file} 的 spawn 记录（身份不得事后反推）`);
  return last; // 同文件多代取最新（generation 语义=当前代）
}

/** 在飞判定（snapshot 时刻）：sending 已现（轮次真在执行）且 settled 未现（未收口）。
 * 先完成的轮（settled 已现）=false——「数到一百」型历史行不能冒充当前运行态。 */
export function inFlightAt(lines: readonly JLineLike[], intentId: string): boolean {
  const sending = lines.some((l) => l.t === "sending" && l.intentId === intentId);
  const settled = lines.some((l) => l.t === "settled" && l.intentId === intentId);
  return sending && !settled;
}

export interface DisposeChainIdx {
  readonly stop: number;
  readonly exit: number;
  readonly registry: number;
  readonly composition: number;
}

/** 审计行 token 匹配：行内（含模块前缀，如 `process-host stop handle=proc-1 signal=SIGTERM`）
 * 以空白为界的完整 token `stop handle=X`/`exit handle=X`——前缀无关、proc-1 不误配 proc-11（token 边界）。 */
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const stopLineFor = (handle: string): RegExp => new RegExp(`(?:^|\\s)stop handle=${esc(handle)}(?=\\s|$)`);
export const exitLineFor = (handle: string): RegExp => new RegExp(`(?:^|\\s)exit handle=${esc(handle)}(?=\\s|$)`);
/** 取行内 stop handle 身份（无则 null）——绑定 stop 的 handle 提取，容忍任意模块前缀。 */
export function stopHandleOf(line: string): string | null {
  const m = /(?:^|\s)stop handle=([\w.-]+)(?=\s|$)/.exec(line);
  return m === null ? null : m[1]!;
}

/** 销毁链断言（绑定身份的结构化比较）：fromIdx 之后须有
 * stop handle=X → exit handle=X → session-registry disposed → composition disposed（索引递增）。
 * 全部 token 级匹配（前缀无关+token 边界），不做子串冒充；exit 先于 stop=自退/借用 → 抛错。 */
export function disposeChain(audits: readonly string[], handle: string, fromIdx: number): DisposeChainIdx {
  const stop = audits.findIndex((l, i) => i >= fromIdx && stopLineFor(handle).test(l));
  const exit = audits.findIndex((l, i) => i >= fromIdx && exitLineFor(handle).test(l));
  if (stop < 0) throw new Error(`disposeChain：fromIdx=${fromIdx} 后无 stop handle=${handle}（目标进程未被停）`);
  if (exit < 0) throw new Error(`disposeChain：无 exit handle=${handle}（目标进程退出证据缺失）`);
  if (exit < stop) throw new Error(`disposeChain：handle=${handle} 的 exit(${exit}) 先于 stop(${stop})——自退或借用，不算在飞击杀`);
  const registry = audits.findIndex((l, i) => i > exit && l.includes("session-registry disposed"));
  if (registry < 0) throw new Error("disposeChain：exit 后无 session-registry disposed");
  const composition = audits.findIndex((l, i) => i > registry && l.includes("composition disposed"));
  if (composition < 0) throw new Error("disposeChain：registry 后无 composition disposed");
  return { stop, exit, registry, composition };
}

/** confirmed.exit 形状严格校验：{code:number|null, signal:string|null}，至少一者非空；
 * {}/[]/缺字段/错类型一律抛错（20b 尾项：{}、[]、缺字段反例）。 */
export function assertExitShape(exit: unknown): { code: number | null; signal: string | null } {
  if (exit === null || typeof exit !== "object" || Array.isArray(exit)) {
    throw new Error(`assertExitShape：exit 须为对象，实值=${JSON.stringify(exit)}`);
  }
  const e = exit as Record<string, unknown>;
  const hasCode = Object.prototype.hasOwnProperty.call(e, "code");
  const hasSignal = Object.prototype.hasOwnProperty.call(e, "signal");
  if (!hasCode || !hasSignal) throw new Error(`assertExitShape：缺字段（code/signal），实值=${JSON.stringify(exit)}`);
  const codeOk = e.code === null || typeof e.code === "number";
  const signalOk = e.signal === null || typeof e.signal === "string";
  if (!codeOk || !signalOk) throw new Error(`assertExitShape：字段类型错（code:number|null, signal:string|null），实值=${JSON.stringify(exit)}`);
  if (e.code === null && e.signal === null) throw new Error("assertExitShape：code/signal 双空——非真进程退出证据");
  return { code: e.code as number | null, signal: e.signal as string | null };
}
