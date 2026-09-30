// M-UX D02：标题唯一解析器（列表/详情共享单一真值源，不许两处各算）。
// 三级：DTO title 非空 → file 名解析 auto-YYYYMMDD-HHmmss-… →「M月D日 HH:mm」；非 auto 前缀 → file 去扩展名。
// 不显示本地消息文本；时间戳派生名是临时占位（launch≠已命名），列表刷新后由 DTO 覆盖。

import type { SessionSummaryDTO } from "@pi-agent-ui/protocol/src/contracts";

const AUTO_RE = /^auto-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/;

export function resolveTitle(session: Pick<SessionSummaryDTO, "file" | "title">): string {
  if (session.title.text !== "") return session.title.text + (session.title.truncated ? "…" : "");
  const m = AUTO_RE.exec(session.file);
  if (m !== null) {
    const mo = parseInt(m[2] ?? "1", 10);
    const d = parseInt(m[3] ?? "1", 10);
    const h = m[4] ?? "00";
    const mi = m[5] ?? "00";
    const y = m[1] ?? "";
    return `${mo}月${d}日 ${h}:${mi}（${y}）`;
  }
  return session.file.replace(/\.jsonl$/, "");
}
