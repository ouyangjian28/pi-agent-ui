// 3c-2：RpcSession→WriteHostPort 适配（真实宿主映射首片）。
// 设计约束：
// - 编码器=契约面收窄：LaunchOutcome.launched.key{intentId,commandId,generation} 扁平化（generation
//   不跨面）；gate-failed.error:unknown 不跨面（细节留宿主审计，客户端只见 stage）；
//   not-ready.cause 透传（源可选则 DTO 可选）；SessionSendResult 无 rejected 来源→DTO 无此枝。
// - 注册表语义：同 file 恒同会话实例（Map 缓存）；会话工厂/生命周期归宿主（sessionFor 接缝）。
// - 内部异常（sessionFor/编码前意外抛错）：审计留细节后**剥离细节重抛** stripped Error
//   （"write-host-internal: prompt|stop"）——网关按 4402 retryable 处置（W9 已锁路径）；
//   不吞错不造 kind（编造 outcome 比异常更危险）。
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
  /** 宿主会话工厂：journal 绝对路径→会话实例（首次调用后按 file 缓存=注册表语义）。 */
  sessionFor(file: string): RpcLikeSession | Promise<RpcLikeSession>;
  /** 宿主审计（内部异常细节唯一出口；异常被隔离）。 */
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

function stripped(op: "prompt" | "stop"): Error {
  return new Error(`write-host-internal: ${op}`);
}

export function createRpcWriteHost(opts: RpcWriteHostOpts): WriteHostPort {
  const cache = new Map<string, RpcLikeSession>();
  const auditSafe = (line: string): void => { try { opts.audit?.(line); } catch { /* 审计异常隔离 */ } };
  const sessionOf = async (file: string): Promise<RpcLikeSession> => {
    const hit = cache.get(file);
    if (hit !== undefined) return hit;
    const s = await opts.sessionFor(file);
    cache.set(file, s);
    return s;
  };
  return {
    async sendPrompt(file: string, text: string): Promise<WriteSendOutcomeDTO> {
      try {
        return encodeSendOutcome(await (await sessionOf(file)).send(text));
      } catch (e: unknown) {
        auditSafe(`write-host-error op=prompt file=${file} ${e instanceof Error ? e.message : String(e)}`);
        throw stripped("prompt");
      }
    },
    async stop(file: string): Promise<WriteStopOutcomeDTO> {
      try {
        return encodeStopOutcome(await (await sessionOf(file)).stop());
      } catch (e: unknown) {
        auditSafe(`write-host-error op=stop file=${file} ${e instanceof Error ? e.message : String(e)}`);
        throw stripped("stop");
      }
    },
  };
}
