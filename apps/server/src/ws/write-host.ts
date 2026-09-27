// 写侧宿主端口（3c-1）：网关唯一的写通道接缝。
// 设计约束（与读侧 HistorySourcePort 同风格）：
// - 宿主**不得抛错**——不可用/失败一律以 outcome kind 表达；网关对抛错按 4402（会话不可用，
//   retryable=true）处置并留审计（异常细节不跨此面，防内部路径/错误串泄入客户端帧）。
// - file 即 journal 文件路径（与读侧订阅 file 同一命名域——写哪个会话=订阅哪个会话）。
// - 生产实现=RpcSession 注册表适配（3c-2 接线：file→懒建 RpcSession，journalPath=file，
//   sessionFile=sessionFor(file)）；本片（3c-1）网关侧只依赖此接口，测试用假宿主。
// - 不在本层：并发队列化（宿主自决——RpcSession TurnGate 已有轮次串行语义）、statusFor 映射。
import type { WriteSendOutcomeDTO, WriteStopOutcomeDTO } from "@pi-agent-ui/protocol";

export interface WriteHostPort {
  /** 发一轮用户消息（prompt 帧）。 */
  sendPrompt(file: string, text: string): Promise<WriteSendOutcomeDTO>;
  /** 停止会话进程（stop 帧）。 */
  stop(file: string): Promise<WriteStopOutcomeDTO>;
}
