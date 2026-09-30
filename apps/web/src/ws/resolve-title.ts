// M-UX D02：标题唯一解析器（列表/详情共享单一真值源，不许两处各算）。
// 三级：DTO title 非空 → file 名解析 auto-YYYYMMDD-HHmmss-… →「M月D日 HH:mm」；非 auto 前缀 → file 去扩展名。
// 不显示本地消息文本；时间戳派生名是临时占位（launch≠已命名），列表刷新后由 DTO 覆盖。

import type { SessionSummaryDTO } from "@pi-agent-ui/protocol/src/contracts";

// P2-03（GPT 审）：完整名式锚定（hex32+.jsonl 结尾）+日历校验（月 01-12/日 01-31/时≤ 23/分秒≤59）。
// 非本产品命名（manual 后缀等）/非法日期（13 月/99 时）不入派生分支，回退 file 去扩展名。
const AUTO_RE = /^auto-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-[0-9a-f]{32}\.jsonl$/;

export function resolveTitle(session: Pick<SessionSummaryDTO, "file" | "title">): string {
  if (session.title.text !== "") return session.title.text + (session.title.truncated ? "…" : "");
  const m = AUTO_RE.exec(session.file);
  if (m !== null) {
    const mo = parseInt(m[2] ?? "1", 10);
    const d = parseInt(m[3] ?? "1", 10);
    const h = m[4] ?? "00";
    const mi = m[5] ?? "00";
    const y = m[1] ?? "";
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return session.file.replace(/\.jsonl$/, "");
    // 精确日历（含 2 月 30 等非法日期）：UTC 构造回读比对，不一致回退 file 名。
    const dt = new Date(Date.UTC(y ? parseInt(y, 10) : 0, mo - 1, d, parseInt(h, 10), parseInt(mi, 10), parseInt(m[6] ?? "0", 10)));
    if (
      Number.isNaN(dt.getTime()) ||
      dt.getUTCMonth() !== mo - 1 ||
      dt.getUTCDate() !== d ||
      dt.getUTCHours() !== parseInt(h, 10) ||
      dt.getUTCMinutes() !== parseInt(mi, 10) ||
      dt.getUTCSeconds() !== parseInt(m[6] ?? "0", 10)
    ) {
      return session.file.replace(/\.jsonl$/, "");
    }
    return `${mo}月${d}日 ${h}:${mi}（${y}）`;
  }
  return session.file.replace(/\.jsonl$/, "");
}
