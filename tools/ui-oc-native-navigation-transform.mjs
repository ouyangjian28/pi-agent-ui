// Build-only original navigation boundary. Source snapshot stays byte-identical.
const once = (source, anchor) => {
  if (source.split(anchor).length !== 2) throw new Error('Original native navigation anchor missing/duplicated: ' + anchor);
};
const marker = '// pi-native-source-navigation-overlay\n';
const callbackImport = "import { piNativeSelectSessionFromUser, piNativeNewDraftFromUser } from '@/sync/session-ui-store';\n";
export function nativeSourceNavigationTransform(source, kind) {
  if (source.includes(marker.trim())) throw new Error('Original native navigation already applied');
  if (kind === 'store') {
    const guards = [
      '  setCurrentSession: (id, directoryHint?: string | null, transition?: "submitted-draft") => {',
      '  restoreForRuntimeSwitch: (apiBaseUrl?: string | null) => {',
      '  openNewSessionDraft: (options) => {',
    ];
    let code = source;
    for (const anchor of guards) { once(code, anchor); code = code.replace(anchor, anchor + '\n    // Legacy selection/cache/draft effects never own native navigation.\n    if (piGetNativeHost()) return;'); }
    return marker + "import { getNativeSurfaceHost as piGetNativeHost } from '@pi-native/surface-host';\nimport { nativeNavigationActions as piNativeNavigationActions } from '@pi-native/navigation-actions';\n" + code + `
// Explicit user callbacks only. No subscription to Source selections or prefs.
function piNativeApplySelection(result: Extract<ReturnType<ReturnType<typeof piNativeNavigationActions>["open"]>, { status: "selected" }>): void {
  const old = useSessionUIStore.getState();
  useSessionUIStore.setState({
    currentSessionId: result.kind === 'session' ? result.file : null,
    currentSessionDirectory: result.kind === 'session' ? result.directory : null,
    materializedDraftSessionId: null,
    newSessionDraft: { ...DEFAULT_DRAFT, draftId: old.newSessionDraft.draftId + (result.kind === 'draft' ? 1 : 0), open: result.kind === 'draft', target: 'project', directoryOverride: result.directory, selectedProjectId: 'pi-native', openedAutomatically: false },
    error: null,
  });
  // Read activation only; never routeMessage/optimisticSend or Source caches.
  setActiveSession(result.kind === 'session' ? result.directory : '', result.kind === 'session' ? result.file : '');
}
export function piNativeSelectSessionFromUser(file: string, directoryHint?: string | null): false | 'selected' | 'rejected' {
  const host = piGetNativeHost(); if (!host) return false;
  const result = piNativeNavigationActions(host.port).open(file, directoryHint);
  if (result.status !== 'selected') { useSessionUIStore.setState({ error: result.message }); return 'rejected'; }
  piNativeApplySelection(result); return 'selected';
}
export function piNativeNewDraftFromUser(options?: Partial<NewSessionDraftState> & { automatic?: boolean }): false | 'selected' | 'rejected' {
  const host = piGetNativeHost(); if (!host) return false;
  const allowed = ['directoryOverride', 'selectedProjectId', 'target'];
  if (options && (Object.keys(options).some(key => !allowed.includes(key)) || (options.selectedProjectId != null && options.selectedProjectId !== 'pi-native') || (options.target !== undefined && options.target !== 'project'))) {
    useSessionUIStore.setState({ error: '此新建参数尚未接入 pi，原目标与草稿已保留。' }); return 'rejected';
  }
  const result = piNativeNavigationActions(host.port).newDraft(options?.directoryOverride);
  if (result.status !== 'selected') { useSessionUIStore.setState({ error: result.message }); return 'rejected'; }
  piNativeApplySelection(result); return 'selected';
}
`;
  }
  const replacements = {
    collection: [
      ["  const selectSessionForProject = React.useCallback((sessionId: string, sessionDirectory: string | null) => {", "\n    if (piNativeSelectSessionFromUser(sessionId, sessionDirectory)) return;"],
    ],
    mobile: [
      ['  const handleSelectSession = (session: Session) => {', "\n    const native = piNativeSelectSessionFromUser(session.id, getSessionDirectory(session) || null);\n    if (native) { if (native === 'selected') onOpenChange(false); return; }"],
      ['  const handleStartNewChat = () => {', "\n    const native = piNativeNewDraftFromUser();\n    if (native) { if (native === 'selected') onOpenChange(false); return; }"],
      ['  const handleNewSessionInProject = (project: ProjectMeta) => {', "\n    const native = piNativeNewDraftFromUser({ selectedProjectId: project.id, directoryOverride: project.path });\n    if (native) { if (native === 'selected') onOpenChange(false); return; }"],
    ],
    sidebar: [
      ['  const openNewSessionDraftFromTree = React.useCallback<typeof openNewSessionDraft>((options) => {', "\n    const native = piNativeNewDraftFromUser(options);\n    if (native) { if (native === 'selected') useUIStore.getState().closeMainSurfaces(); return; }"],
      ['  const handleOpenNewSessionDraftFromHeader = React.useCallback(() => {', "\n    const native = piNativeNewDraftFromUser();\n    if (native) { if (native === 'selected') { useUIStore.getState().closeMainSurfaces(); if (mobileVariant) setSessionSwitcherOpen(false); } return; }"],
    ],
    switcher: [
      ['  const handleNewSession = React.useCallback(() => {', "\n    const native = piNativeNewDraftFromUser();\n    if (native) { if (native === 'selected') onSelect(); return; }"],
      ['  const handleSelect = React.useCallback(() => {', "\n    const native = piNativeSelectSessionFromUser(session.id, resolveGlobalSessionDirectory(session) ?? null);\n    if (native) { if (native === 'selected') closeDropdown(); return; }"],
    ],
  };
  const entries = replacements[kind]; if (!entries) throw new Error('Unknown native navigation Source kind');
  let code = source;
  for (const [anchor, branch] of entries) { once(code, anchor); code = code.replace(anchor, anchor + branch); }
  return marker + callbackImport + code;
}
