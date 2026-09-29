// M-OPS（v1.4）not-ready 响亮红条：write-ack outcome.kind==="not-ready"（进程启动失败）时呈现。
// cause 人话映射（服务端三源为主，未知源兜底）；detail=启动失败 stderr 尾行（服务端已 ≤500+strip
// 控制字符；明文政策显式裁决=docs/m-ops-design.md §4——知情价值>泄露风险）。
// 渲染红线：detail 纯文本节点（React 默认转义，永不 dangerouslySetInnerHTML）。
import type { NotReadyInfo } from "../ws/use-write";

/** cause→人话（未知/缺失源兜底通用文案；不透传原始 cause 串——服务端枚举面外的串只作 detail 线索）。 */
const CAUSE_TEXT: Readonly<Record<string, string>> = {
  "spawn-failed": "无法拉起 pi 进程（启动命令失败）",
  "spawn-exited": "pi 进程启动后立即退出——多半是模型 id 有误，请换模型重试",
  "readiness-timeout": "pi 进程就绪超时（未在时限内响应）",
  "not-running": "会话无运行中的 pi 进程",
};

function causeText(cause: string | null): string {
  if (cause !== null && cause in CAUSE_TEXT) return CAUSE_TEXT[cause]!;
  return "pi 进程启动失败";
}

export function NotReadyBanner({
  info,
  onRetry,
  onSwitchModel,
}: {
  info: NotReadyInfo;
  // exactOptionalPropertyTypes 仓规：可选 prop 显式携 undefined 合法（调用面条件传递）
  onRetry?: (() => void) | undefined;
  onSwitchModel?: (() => void) | undefined;
}): React.JSX.Element {
  return (
    <div className="not-ready-banner" role="alert">
      <strong>会话启动失败</strong>
      <p>{causeText(info.cause)}</p>
      {info.detail !== null ? (
        <details className="not-ready-detail" open>
          <summary>启动失败详情（stderr 尾行）</summary>
          <pre>{info.detail}</pre>
        </details>
      ) : null}
      {(onRetry !== undefined || onSwitchModel !== undefined) && (
        <div className="not-ready-actions">
          {onRetry !== undefined ? (
            <button type="button" onClick={onRetry}>
              重试
            </button>
          ) : null}
          {onSwitchModel !== undefined ? (
            <button type="button" onClick={onSwitchModel}>
              换模型
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
