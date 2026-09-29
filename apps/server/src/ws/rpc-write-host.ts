// 3c-2：RpcSession→WriteHostPort 适配（真实宿主映射首片；第19轮 GPT 审读修复版）。
// 设计约束：
// - 编码器=契约面收窄：LaunchOutcome.launched.key{intentId,commandId,generation} 扁平化（generation
//   不跨面）；gate-failed.error:unknown 不跨面（**细节先落宿主审计**再截断，见 gateFailedDetail）；
//   not-ready.cause 透传（源可选则 DTO 可选）；SessionSendResult 无 rejected 来源→DTO 无此枝。
// - 注册表语义（第19轮 F1 修复）：同 file 恰建一次——pending 共享（single-flight）保证首次并发
//   （含同步工厂重入）共享同一次创建；工厂失败→占位按操作身份删除→允许健康重试；成功后永久
//   缓存（无失效 API=首片承诺；实例寿命/统一销毁属 3c-3 composition 面）。
// - 内部异常（sessionFor/send/stop 意外抛错/拒绝）：**格式化纳入隔离**（auditSafe 收 thunk，
//   恶意 toString/message getter 再抛也不逃逸）后**剥离细节重抛** stripped Error
//   （"write-host-internal: prompt|stop"，无 cause 无附带字段）→网关按 4402 retryable 处置
//   （W9 已锁路径）；不吞错不造 kind（编造 outcome 比异常更危险）。
// - 两层契约（与 write-host.ts:3-4 端口注统一）：可预期业务结果→outcome kind；内部异常→剥离重抛→4402。
// - 不在本层：RpcSession 实例构造（composition 接线）、statusFor 映射、并发队列（TurnGate 已有）。
import type { WriteSendOutcomeDTO, WriteStopOutcomeDTO, WriteResumeOutcomeDTO, RetireOutcome } from "@pi-agent-ui/protocol";
import type { SessionSendResult } from "../runtime/rpc-session.ts";
import type { WriteHostPort } from "./write-host.ts";
import { ComputeGateQueueTimeout } from "./compute-semaphore.ts";

/** 编码面所需的最小会话形状（结构化依赖：测试可替身，不锁 RpcSession 类）。 */
export interface RpcLikeSession {
  send(message: string, expectedGeneration?: number, model?: string): Promise<SessionSendResult>; // r3c：期望代次断言（live=null 冷启动面传 undefined）；model=M-OPS v1.4 会话级模型记忆
  stop(): Promise<RetireOutcome>;
}

export interface RpcWriteHostOpts {
  /** 宿主会话工厂：journal 绝对路径→会话实例（同 file 恰调一次=pending 共享；失败后允许重试）。 */
  sessionFor(file: string): RpcLikeSession | Promise<RpcLikeSession>;
  /** 宿主审计（内部异常/gate-failed 细节唯一出口；格式化与回调异常均被隔离）。 */
  audit?(line: string): void;
  /** v1.1 帧身份权威源（r3a）：resume/prompt-generation 身份门数据。缺省=恒拒（fail-closed）
   * ——resume 面恒 no-recovery-data；prompt.generation 缺省不受影响，提供则拒（无权威源→
   * no-recovery-data；有权威源旧代→generation-mismatch；K3 审 P2-1 口径）。 */
  resumeAuthority?: ResumeAuthority;
}

/** v1.1 帧身份权威源（r3a 身份门接缝；真源=composition 接线恢复报告+活进程代次）。 */
export interface ResumeAuthority {
  /** 恢复面数据（授权集/阻断位）；无该 file 数据=null。signal=r3c 连接级取消信号（断连→排
   * 队中取消+读中停读；语义同 get-recovery provider——provider 只在步骤间观察，不中断挂起 I/O）。 */
  reportFor(file: string, signal?: AbortSignal): { readonly resendAuthorized: readonly string[]; readonly resumeBlocked: boolean } | null | Promise<{ readonly resendAuthorized: readonly string[]; readonly resumeBlocked: boolean } | null>;
  /** 当前活进程代次；无活进程=null（resume 放行至执行面——拉起时新代；prompt 校验跳过）。 */
  generationFor(file: string): number | null;
  /** r3b 执行点读：同一快照同出复核报告+目标载荷（门序→执行间隔的授权撤销/代次变化在此收敛；
   * payload=授权在但 enqueue 载荷读不回时 null——证据不完整非身份错）。signal=r3c 连接级取消信号
   * （语义同 reportFor）。 */
  executeFor(file: string, intentId: string, signal?: AbortSignal): {
    readonly report: { readonly resendAuthorized: readonly string[]; readonly resumeBlocked: boolean };
    readonly payload: { readonly rawText: string } | null;
  } | null | Promise<{
    readonly report: { readonly resendAuthorized: readonly string[]; readonly resumeBlocked: boolean };
    readonly payload: { readonly rawText: string } | null;
  } | null>;
}

/** SessionSendResult→WriteSendOutcomeDTO（穷尽映射；error/generation 在此截断）。 */
export function encodeSendOutcome(r: SessionSendResult): WriteSendOutcomeDTO {
  switch (r.kind) {
    case "launched": return { kind: "launched", intentId: r.key.intentId, commandId: r.key.commandId };
    case "busy":
    case "gate-rejected":
      return r;
    case "gate-failed": return { kind: "gate-failed", stage: r.stage };
    case "invalidated": return { kind: "invalidated", stage: r.stage };
    case "no-process": return { kind: "no-process" };
    case "not-ready": {
      // M-OPS（v1.4）：detail 三路附带（契约 not-ready.detail?；无 detail 保持原形——exactOptionalPropertyTypes 禁 ??undefined）
      const base = r.cause === undefined ? { kind: "not-ready" as const } : { kind: "not-ready" as const, cause: r.cause };
      return r.detail === undefined ? base : { ...base, detail: r.detail };
    }
  }
}

/** RetireOutcome→WriteStopOutcomeDTO（同构透传；显式穷尽防漂移）。 */
export function encodeStopOutcome(r: RetireOutcome): WriteStopOutcomeDTO {
  switch (r.kind) {
    case "confirmed": return { kind: "confirmed", exit: { code: r.exit.code, signal: r.exit.signal } };
    case "deadline-exceeded":
    case "no-process":
    case "stopping":
      return r;
  }
}

/** gate-failed 细节审计行（截断前的宿主侧留痕；error:unknown 不跨契约面≠不留档）。非 gate-failed→null。 */
export function gateFailedDetail(r: SessionSendResult): string | null {
  if (r.kind !== "gate-failed") return null;
  let d: string;
  try { d = r.error instanceof Error ? r.error.message : String(r.error); } catch { d = "unstringifiable"; }
  return `write-host-gate-failed-detail stage=${r.stage} detail=${d}`;
}

function stripped(op: "prompt" | "stop" | "resume"): Error {
  return new Error(`write-host-internal: ${op}`);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createRpcWriteHost(opts: RpcWriteHostOpts): WriteHostPort {
  const settled = new Map<string, RpcLikeSession>();
  const pending = new Map<string, Promise<RpcLikeSession>>();
  // 第19轮加固：收 thunk——字符串化/格式化（含恶意 toString/message getter 再抛）也在隔离域内，
  // 最后无条件抛固定 stripped Error（剥离承诺不依赖被拒绝值的行为）。
  const auditSafe = (make: () => string): void => { try { opts.audit?.(make()); } catch { /* 审计+格式化异常隔离 */ } };
  const sessionOf = (file: string): Promise<RpcLikeSession> => {
    const hit = settled.get(file);
    if (hit !== undefined) return Promise.resolve(hit);
    const inflight = pending.get(file);
    if (inflight !== undefined) return inflight; // single-flight：首次并发共享同一次创建
    // 槽对象持引用：身份校验不自引用 let/const（tsc 赋前使用与 eslint prefer-const 两难）；
    // 工厂压微任务后 pending.set 必先于工厂执行——同步 throw 也能正确走身份删除（防陈旧占位）。
    const slot: { p?: Promise<RpcLikeSession> } = {};
    slot.p = (async () => {
      try {
        const s = await Promise.resolve().then(() => opts.sessionFor(file));
        settled.set(file, s);
        return s;
      } finally {
        // 失败清占位（身份校验：仅本操作仍是该 file 在途创建时才删），下次调用=健康重试
        if (slot.p !== undefined && pending.get(file) === slot.p) pending.delete(file);
      }
    })();
    const creating = slot.p;
    pending.set(file, creating);
    return creating;
  };
  return {
    async sendPrompt(file: string, text: string, generation?: number, model?: string): Promise<WriteSendOutcomeDTO> {
      try {
        // v1.1 帧身份门（prompt 面）：客户端携带代次≠当前活代→恒拒（零副作用：不触 sessionFor/send）
        let liveGen: number | null = null; // r3c：门验过的活代传给 send（期望代次断言收窗；live=null 冷启动放行）
        if (generation !== undefined) {
          // K3 审 P2-1：无权威源=身份断言不可验证→fail-closed（对齐端口注释承诺；v1 缺省 generation 不受影响）。
          const auth0 = opts.resumeAuthority;
          if (auth0 === undefined) {
            auditSafe(() => `write-identity-reject op=prompt file=${file} cause=no-recovery-data source=absent`);
            return { kind: "identity-rejected", cause: "no-recovery-data" };
          }
          liveGen = auth0.generationFor(file);
          if (liveGen !== null && liveGen !== generation) {
            auditSafe(() => `write-identity-reject op=prompt file=${file} cause=generation-mismatch frame=${generation} live=${liveGen}`);
            return { kind: "identity-rejected", cause: "generation-mismatch" };
          }
        }
        const raw = await (await sessionOf(file)).send(text, liveGen ?? undefined, model); // r3c：期望代次=门验活代（null=无断言，冷启动拉起兼容）；model=M-OPS v1.4 会话级模型记忆
        const g = gateFailedDetail(raw);
        if (g !== null) auditSafe(() => g);
        return encodeSendOutcome(raw);
      } catch (e: unknown) {
        auditSafe(() => `write-host-error op=prompt file=${file} ${errText(e)}`);
        throw stripped("prompt");
      }
    },
    async stop(file: string): Promise<WriteStopOutcomeDTO> {
      try {
        return encodeStopOutcome(await (await sessionOf(file)).stop());
      } catch (e: unknown) {
        auditSafe(() => `write-host-error op=stop file=${file} ${errText(e)}`);
        throw stripped("stop");
      }
    },
    async resume(file: string, intentId: string, generation: number, signal?: AbortSignal): Promise<WriteResumeOutcomeDTO> {
      // v1.1 身份门（r3a）：校验序=恢复数据在场→未阻断→授权→代次；任何拒绝=零副作用（不触 sessionFor）。
      // 执行面（r3b）：门序通过→executeFor 执行点读（同快照出复核+载荷）→generationFor 重查→send。
      const authority = opts.resumeAuthority;
      if (authority === undefined) {
        auditSafe(() => `write-resume file=${file} intentId=${intentId} outcome=identity-rejected cause=no-recovery-data source=absent`);
        return { kind: "identity-rejected", cause: "no-recovery-data" };
      }
      let report: Awaited<ReturnType<ResumeAuthority["reportFor"]>>;
      try {
        report = await authority.reportFor(file, signal);
      } catch (e: unknown) {
        if (e instanceof ComputeGateQueueTimeout) throw e; // r3b-fix：闸忙≠宿主错——网关转 4409 retryable
        auditSafe(() => `write-host-error op=resume file=${file} ${errText(e)}`);
        throw stripped("resume");
      }
      if (report === null) {
        auditSafe(() => `write-resume file=${file} intentId=${intentId} outcome=identity-rejected cause=no-recovery-data`);
        return { kind: "identity-rejected", cause: "no-recovery-data" };
      }
      if (report.resumeBlocked) {
        auditSafe(() => `write-resume file=${file} intentId=${intentId} outcome=identity-rejected cause=resume-blocked`);
        return { kind: "identity-rejected", cause: "resume-blocked" };
      }
      if (!report.resendAuthorized.includes(intentId)) {
        auditSafe(() => `write-resume file=${file} intentId=${intentId} outcome=identity-rejected cause=resume-not-authorized`);
        return { kind: "identity-rejected", cause: "resume-not-authorized" };
      }
      let live: number | null;
      try {
        live = authority.generationFor(file);
      } catch (e: unknown) {
        auditSafe(() => `write-host-error op=resume file=${file} ${errText(e)}`);
        throw stripped("resume"); // K3 审 P3：generationFor 与 reportFor 同 stripped 口径（宿主两层契约一致）
      }
      if (live !== null && live !== generation) {
        auditSafe(() => `write-resume file=${file} intentId=${intentId} outcome=identity-rejected cause=generation-mismatch frame=${generation} live=${live}`);
        return { kind: "identity-rejected", cause: "generation-mismatch" };
      }
      // ── r3b 执行面 ─────────────────────────────────────────────────────
      // 执行点读：同快照出复核报告+载荷（门序→执行间隔内新裁决/阻断到达在此收敛；残余窗口=读完成→send
      // 提交，彻底闭环属写面原子化（P0-4 后 TECH 债条目），本批明示窄窗+审计留痕。
      let exec: Awaited<ReturnType<ResumeAuthority["executeFor"]>>;
      try {
        exec = await authority.executeFor(file, intentId, signal);
      } catch (e: unknown) {
        if (e instanceof ComputeGateQueueTimeout) throw e; // r3b-fix：闸忙≠宿主错
        auditSafe(() => `write-host-error op=resume file=${file} ${errText(e)}`);
        throw stripped("resume");
      }
      if (exec === null) {
        auditSafe(() => `write-resume file=${file} intentId=${intentId} outcome=identity-rejected cause=no-recovery-data source=execute`);
        return { kind: "identity-rejected", cause: "no-recovery-data" };
      }
      if (exec.report.resumeBlocked) {
        auditSafe(() => `write-resume file=${file} intentId=${intentId} outcome=identity-rejected cause=resume-blocked source=execute-recheck`);
        return { kind: "identity-rejected", cause: "resume-blocked" };
      }
      if (!exec.report.resendAuthorized.includes(intentId)) {
        auditSafe(() => `write-resume file=${file} intentId=${intentId} outcome=identity-rejected cause=resume-not-authorized source=execute-recheck`);
        return { kind: "identity-rejected", cause: "resume-not-authorized" };
      }
      if (exec.payload === null) {
        auditSafe(() => `write-resume file=${file} intentId=${intentId} outcome=execution-failed cause=payload-unavailable`);
        return { kind: "execution-failed", cause: "payload-unavailable" };
      }
      // 执行点代次复核：拦「门序→send 间进程重启换代」（内存查；换代后 send 会打到新进程=语义错配）。
      let live2: number | null;
      try {
        live2 = authority.generationFor(file);
      } catch (e: unknown) {
        auditSafe(() => `write-host-error op=resume file=${file} ${errText(e)}`);
        throw stripped("resume");
      }
      if (live2 !== null && live2 !== generation) {
        auditSafe(() => `write-resume file=${file} intentId=${intentId} outcome=identity-rejected cause=generation-mismatch frame=${generation} live=${live2} source=execute-recheck`);
        return { kind: "identity-rejected", cause: "generation-mismatch" };
      }
      // 执行：send 接线（TurnGate 交涉天然在 session.send 内；结果映射同 prompt 面——launched.intentId
      // =重发新意图，原意图关联在审计行；journal 面不因 resume 加行型，新 enqueue 即无辜新意图）。
      // r3c：send 期望代次=执行点重查活代 live2（≠null 时断言收窗；live2=null=无活进程冷启动拉起，
      // 无断言放行——与门序⑥「live=null 放行至执行面」语义同源，非回归）。
      try {
        const raw = await (await sessionOf(file)).send(exec.payload.rawText, live2 ?? undefined);
        const g = gateFailedDetail(raw);
        if (g !== null) auditSafe(() => g);
        if (raw.kind === "launched") {
          auditSafe(() => `write-resume file=${file} intentId=${intentId} outcome=launched newIntentId=${raw.key.intentId}`);
        } else {
          auditSafe(() => `write-resume file=${file} intentId=${intentId} outcome=${raw.kind}`);
        }
        return encodeSendOutcome(raw); // 同构自证：WriteSendOutcomeDTO 全枝（含 prompt 面 identity-rejected 子集）可赋 WriteResumeOutcomeDTO，无 as
      } catch (e: unknown) {
        auditSafe(() => `write-host-error op=resume file=${file} ${errText(e)}`);
        throw stripped("resume");
      }
    },
  };
}
