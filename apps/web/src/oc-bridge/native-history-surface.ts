// Display-only chronology. Native public history has no OpenCode parentID:
// never fabricate ancestry or drop assistants from partial history windows.
import { getNativeSurfaceHost } from './native-surface-host';
import { nativeDirectory, ocReadResponse } from './oc-read-projection';
export type NativeDisplayEntry = { readonly info: { readonly id: string; readonly native?: { readonly role?: unknown; readonly seq?: unknown; readonly temporary?: unknown } } };
export function isNativeChronology(messages: readonly NativeDisplayEntry[]): boolean {
  return messages.length > 0 && messages.every(({ info }) => info.id.startsWith('pi-') && info.native !== undefined && typeof info.native.role === 'string' && typeof info.native.temporary === 'boolean' && (info.native.seq === null || (Number.isSafeInteger(info.native.seq) && Number(info.native.seq) >= 0)));
}
export function nativeChronologyWindow(messages: readonly NativeDisplayEntry[]) {
  const turnIds = messages.map(message => message.info.id);
  // Window anchors only, NOT native turns, parentage or completion claims.
  return { turnIds, turnMessageStartIndexes: messages.map((_, index) => index), turnIndexById: new Map(turnIds.map((id, index) => [id, index])), messageToTurnId: new Map(turnIds.map(id => [id, id])), messageToTurnIndex: new Map(turnIds.map((id, index) => [id, index])), turnCount: messages.length };
}
export function nativeChronologyProjection(messages: readonly NativeDisplayEntry[]) {
  // The original individual ChatMessage cards still render. No fake users,
  // inferred parent IDs, native retry/final promotion or old no-reply turns.
  return { turns: [], indexes: { turnById: new Map<string, never>(), messageToTurnId: new Map<string, string>(), messageMetaById: new Map<string, never>() }, lastTurnId: null, lastTurnMessageIds: new Set<string>(), ungroupedMessageIds: new Set(messages.map(message => message.info.id)) };
}
/** Only initialise the known native READ subset. Unsupported questions,
 * permissions, git, skills, commands, MCP and LSP stay unavailable; never
 * replace them with authoritative empty arrays or clear Source blocking maps.
 */
export async function initializeNativeReadDirectory(directory: string, set: (patch: Record<string, unknown>) => void, isStale?: () => boolean): Promise<'complete' | 'failed' | 'stale'> {
  if (isStale?.()) return 'stale';
  const host = getNativeSurfaceHost();
  const ready = () => {
    if (!host || getNativeSurfaceHost() !== host) return false;
    const snapshot = host.port.getSnapshot();
    return snapshot.list.state === 'ready' && snapshot.write.connState === 'ready' && snapshot.detail.connState === 'ready' && snapshot.list.sessions !== null && nativeDirectory(snapshot) === directory;
  };
  if (!ready()) return 'failed';
  try {
    const snapshot = host!.port.getSnapshot();
    const values: unknown[] = [];
    for (const path of ['/api/path', '/api/config', '/api/project/current', '/api/session/status']) {
      const response = ocReadResponse(path, 'GET', snapshot);
      if (!response.ok) return 'failed';
      values.push(await response.json());
    }
    if (isStale?.()) return 'stale';
    if (!ready()) return 'failed';
    const [path, config, project, status] = values as [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];
    if (path.nativePi !== true || config.nativePi !== true || project.nativePi !== true || project.id !== 'pi-native' || path.directory !== directory) return 'failed';
    set({ project: project.id, path, config, status: 'complete', ...(snapshot.detail.status === null || host!.port.getSnapshot().detail.status !== snapshot.detail.status ? {} : { session_status: status, sessionStatusReady: true }) });
    return 'complete'; // Native READ readiness, never old backend capability readiness.
  } catch { return isStale?.() ? 'stale' : 'failed'; }
}
