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
import type { WriteSendOutcomeDTO, WriteStopOutcomeDTO, RetireOutcome } from "@pi-agent-ui/protocol";
import type { SessionSendResult } from "../runtime/rpc-session.ts";
import type { WriteHostPort } from "./write-host.ts";

/** 编码面所需的最小会话形状（结构化依赖：测试可替身，不锁 RpcSession 类）。 */
export interface RpcLikeSession {
  send(message: string): Promise<SessionSendResult>;
  stop(): Promise<RetireOutcome>;
}

export interface RpcWriteHostOpts {
  /** 宿主会话工厂：journal 绝对路径→会话实例（同 file 恰调一次=pending 共享；失败后允许重试）。 */
  sessionFor(file: string): RpcLikeSession | Promise<RpcLikeSession>;
  /** 宿主审计（内部异常/gate-failed 细节唯一出口；格式化与回调异常均被隔离）。 */
  audit?(line: string): void;
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
    case "not-ready": return r.cause === undefined ? { kind: "not-ready" } : { kind: "not-ready", cause: r.cause };
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

function stripped(op: "prompt" | "stop"): Error {
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
    async sendPrompt(file: string, text: string): Promise<WriteSendOutcomeDTO> {
      try {
        const raw = await (await sessionOf(file)).send(text);
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
  };
}
