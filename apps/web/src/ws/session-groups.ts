import type { SessionSummaryDTO } from "@pi-agent-ui/protocol/src/contracts";
export const SESSION_GROUPS = ["今天", "昨天", "过去 7 天", "更早"] as const;
export function groupSessions(sessions: readonly SessionSummaryDTO[], now = new Date()): { label: typeof SESSION_GROUPS[number]; sessions: SessionSummaryDTO[] }[] {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  const week = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7).getTime();
  const groups = SESSION_GROUPS.map((label) => ({ label, sessions: [] as SessionSummaryDTO[] }));
  const sorted = [...sessions].sort((a, b) => (b.lastActiveMs ?? -Infinity) - (a.lastActiveMs ?? -Infinity) || a.file.localeCompare(b.file));
  for (const session of sorted) {
    const value = session.lastActiveMs;
    const valid = value !== null && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime());
    const index = !valid ? 3 : value >= day ? 0 : value >= yesterday ? 1 : value >= week ? 2 : 3;
    groups[index]!.sessions.push(session);
  }
  return groups;
}
