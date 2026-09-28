// 写侧宿主端口（3c-1）：网关唯一的写通道接缝。
// 设计约束（与读侧 HistorySourcePort 同风格）：
// - 两层契约（第19轮 GPT 审后统一，与 rpc-write-host.ts/contracts.ts 同口径）：
//   ①可预期业务结果（busy/gate-rejected/not-ready…）→ outcome kind 表达，不抛错；
//   ②内部意外异常（宿主崩溃级）→ **剥离细节重抛**（RpcWriteHost 产 stripped Error，
//     无 cause 无内部字段）→网关 4402（retryable=true）处置并留审计。异常细节不跨此面。
// - file 即 journal 文件路径（与读侧订阅 file 同一命名域——写哪个会话=订阅哪个会话）。
// - 生产实现=RpcSession 注册表适配（3c-2 接线：file→懒建 RpcSession，journalPath=file，
//   sessionFile=sessionFor(file)）；本片（3c-1）网关侧只依赖此接口，测试用假宿主。
// - 不在本层：并发队列化（宿主自决——RpcSession TurnGate 已有轮次串行语义）、statusFor 映射。
import type { WriteSendOutcomeDTO, WriteStopOutcomeDTO, WriteResumeOutcomeDTO } from "@pi-agent-ui/protocol";

export interface WriteHostPort {
  /** 发一轮用户消息（prompt 帧）。generation=v1.1 可选进程代次（提供则身份门校验活代匹配）。 */
  sendPrompt(file: string, text: string, generation?: number): Promise<WriteSendOutcomeDTO>;
  /** 停止会话进程（stop 帧）。 */
  stop(file: string): Promise<WriteStopOutcomeDTO>;
  /** v1.1 恢复意图重发（resume 帧）。身份门三校验（恢复数据在场/未阻断/授权/代次）在宿主面；
   * 通过→execution-pending（重发执行面 r3b）；拒绝→identity-rejected（零副作用）。 */
  resume(file: string, intentId: string, generation: number): Promise<WriteResumeOutcomeDTO>;
}
