/**
 * D3 扩展问答（docs/d3-ui-passthrough-design.md §4-5）：网关→会话的答案回写端口。
 *
 * 分层：ws 层不 import runtime（同 write-host.ts 先例）——组装层把 session.answerUi
 * 适配成本端口注入网关。提问/作废/notify 三个反方向经网关公有方法
 * （broadcastUiRequest/broadcastUiClosed/broadcastLive）由组装层晚绑定调用。
 *
 * 答案回写走 pi 进程 stdin（extension_ui_response）——不触 journal、不经 writerEpoch
 * （docs §3.3：与写面身份链无关）。
 */

/** 答案载荷（三枝恰其一；形状门在协议校验器，方法级校验在网关带 options 上下文执行）。 */
export type UiAnswerPayloadGateway = { readonly value: string } | { readonly confirmed: boolean } | { readonly cancelled: true };

/** 会话面回写结果（与 runtime rpc-session 的 UiAnswerOutcome 同形；结构类型兼容）。 */
export type UiAnswerOutcomeGateway =
  | { readonly kind: "delivered" }
  | { readonly kind: "unknown" }
  | { readonly kind: "stale" }
  | { readonly kind: "write-failed" };

/** 网关面提问形（file 绑定后；字段=协议 ui-request 帧负载源）。 */
export interface UiAskGateway {
  readonly requestId: string;
  readonly method: "select" | "confirm" | "input" | "editor";
  readonly title?: string;
  readonly options?: readonly string[];
  readonly message?: string;
  readonly placeholder?: string;
  readonly prefill?: string;
  readonly timeoutMs?: number;
}

/** D3 答案端口：requestId 反查 file 由网关完成（跨文件答案已在网关 4404 拒绝）。 */
export interface UiHostPort {
  readonly answer: (file: string, requestId: string, payload: UiAnswerPayloadGateway) => Promise<UiAnswerOutcomeGateway>;
}
