import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { nativeSourceNavigationTransform as overlay } from '../../../tools/ui-oc-native-navigation-transform.mjs';
const ts: typeof import('typescript') = createRequire(resolve(process.cwd(), 'package.json'))('typescript');
const base = resolve(process.cwd(), 'vendor/openchamber-frontend/packages/ui/src');
const paths = { store: 'sync/session-ui-store.ts', collection: 'components/session/sidebar/list/SessionProjectCollection.tsx', mobile: 'apps/MobileSessionsSheet.tsx', sidebar: 'components/session/SessionSidebar.tsx', switcher: 'components/session/SessionSwitcherDropdown.tsx' };
const originals = Object.fromEntries(Object.entries(paths).map(([kind, path]) => [kind, readFileSync(resolve(base, path), 'utf8')]));
function parse(kind: keyof typeof paths) {
  const source = overlay(originals[kind], kind);
  const file = ts.createSourceFile(paths[kind], source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  expect(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }, reportDiagnostics: true }).diagnostics ?? []).toEqual([]);
  return file;
}
function helpers(host: object | null, selected = true, kind: 'session' | 'draft' = 'session') {
  const file = parse('store'); const functions: string[] = [];
  for (const node of file.statements) if (ts.isFunctionDeclaration(node) && node.name?.text.startsWith('piNative')) functions.push(node.getText(file));
  expect(functions).toHaveLength(3);
  const state = { currentSessionId: 'previous-file', currentSessionDirectory: '/native', materializedDraftSessionId: 'old-pointer', newSessionDraft: { draftId: 5, open: false }, error: null };
  const set = vi.fn((value: object) => Object.assign(state, value)); const active = vi.fn();
  const result = selected ? { status: 'selected', kind, slotId: 'native-slot', file: 'confirmed.jsonl', directory: '/native' } : { status: 'local', message: 'owned local refusal' };
  const open = vi.fn(() => result), draft = vi.fn(() => result), actions = vi.fn(() => ({ open, newDraft: draft }));
  const exports: { piNativeSelectSessionFromUser?: (file: string, directory?: string | null) => unknown; piNativeNewDraftFromUser?: (options?: object) => unknown } = {};
  const code = ts.transpileModule(functions.join('\n'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, { exports, piGetNativeHost: () => host, piNativeNavigationActions: actions, useSessionUIStore: { getState: () => state, setState: set }, DEFAULT_DRAFT: { draftId: 0, open: false, target: 'chat', parentID: null }, setActiveSession: active });
  return { exports, state, set, active, open, draft, actions };
}
function callback(kind: Exclude<keyof typeof paths, 'store'>, name: string, globals: Record<string, unknown>) {
  const file = parse(kind); const found: string[] = [];
  const visit = (node: import('typescript').Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === name && node.initializer) {
      const value = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer;
      expect(value && ts.isArrowFunction(value)).toBe(true); found.push(value!.getText(file));
    }
    ts.forEachChild(node, visit);
  };
  visit(file); expect(found).toHaveLength(1);
  const code = ts.transpileModule('globalThis.invoke = ' + found[0], { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const context: Record<string, unknown> = { ...globals }; runInNewContext(code, context); return context.invoke as (...args: unknown[]) => void;
}
describe('actual overlaid Source explicit navigation AST/VM, not real UI or Source tsc', () => {
  it('unbound helpers preserve original caller fallback without reading Source state', () => {
    const p = helpers(null); expect(p.exports.piNativeSelectSessionFromUser!('old', null)).toBe(false); expect(p.exports.piNativeNewDraftFromUser!()).toBe(false); expect(p.actions).not.toHaveBeenCalled(); expect(p.set).not.toHaveBeenCalled();
  });
  it('confirmed selection projects only native result and activates reads, no Source draft/cache ownership', () => {
    const p = helpers({}); expect(p.exports.piNativeSelectSessionFromUser!('confirmed.jsonl', '/native')).toBe('selected'); expect(p.open).toHaveBeenCalledExactlyOnceWith('confirmed.jsonl', '/native'); expect(p.state.currentSessionId).toBe('confirmed.jsonl'); expect(p.state.newSessionDraft.open).toBe(false); expect(p.state.materializedDraftSessionId).toBeNull(); expect(p.active).toHaveBeenCalledExactlyOnceWith('/native', 'confirmed.jsonl');
  });
  it('local refusal only changes error, preserves old view and never activates Source read', () => {
    const p = helpers({}, false); expect(p.exports.piNativeSelectSessionFromUser!('unconfirmed', null)).toBe('rejected'); expect(p.state.currentSessionId).toBe('previous-file'); expect(p.state.newSessionDraft).toEqual({ draftId: 5, open: false }); expect(p.set).toHaveBeenCalledExactlyOnceWith({ error: 'owned local refusal' }); expect(p.active).not.toHaveBeenCalled();
  });
  it('closed native host does not fall back to original callbacks or fabricate selection', () => {
    const p = helpers({ closed: true }, false); expect(p.exports.piNativeSelectSessionFromUser!('confirmed.jsonl')).toBe('rejected'); expect(p.exports.piNativeNewDraftFromUser!()).toBe('rejected'); expect(p.state.currentSessionId).toBe('previous-file'); expect(p.active).not.toHaveBeenCalled();
  });
  it('new helper projects local native draft, not a created durable session', () => {
    const p = helpers({}, true, 'draft'); expect(p.exports.piNativeNewDraftFromUser!({ selectedProjectId: 'pi-native', directoryOverride: '/native' })).toBe('selected'); expect(p.draft).toHaveBeenCalledExactlyOnceWith('/native'); expect(p.state.currentSessionId).toBeNull(); expect(p.state.newSessionDraft).toMatchObject({ open: true, draftId: 6, target: 'project', directoryOverride: '/native', selectedProjectId: 'pi-native', openedAutomatically: false }); expect(p.active).toHaveBeenCalledExactlyOnceWith('', '');
  });
  it('automatic/worktree/parent/system context/unbound project/chat target arguments never create native drafts', () => {
    const p = helpers({}, true, 'draft'); for (const options of [{ automatic: true }, { parentID: 'child' }, { initialPrompt: 'prefill' }, { syntheticParts: [] }, { pendingWorktreeRequestId: 'worktree' }, { selectedProjectId: 'legacy-project' }, { target: 'chat' }]) expect(p.exports.piNativeNewDraftFromUser!(options)).toBe('rejected'); expect(p.draft).not.toHaveBeenCalled(); expect(p.state.currentSessionId).toBe('previous-file');
  });
  it('three original store APIs active/closed return before ANY legacy cache/fetch/clear effect', () => {
    const file = parse('store'); const found = new Map<string, string>(); const keys = ['setCurrentSession', 'restoreForRuntimeSwitch', 'openNewSessionDraft'];
    const visit = (node: import('typescript').Node) => { if (ts.isPropertyAssignment(node) && keys.includes(node.name.getText(file)) && ts.isArrowFunction(node.initializer)) found.set(node.name.getText(file), node.initializer.getText(file)); ts.forEachChild(node, visit); }; visit(file); expect(found.size).toBe(3);
    for (const host of [{}, { closed: true }]) for (const text of found.values()) { const code = ts.transpileModule('globalThis.invoke = ' + text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText; const context: Record<string, unknown> = { piGetNativeHost: () => host }; runInNewContext(code, context); expect((context.invoke as (arg?: unknown) => unknown)()).toBeUndefined(); }
  });
  it('desktop actual row handles native first even when Source already considers it selected', () => {
    const select = vi.fn(() => 'selected'); callback('collection', 'selectSessionForProject', { piNativeSelectSessionFromUser: select })('confirmed', '/native'); expect(select).toHaveBeenCalledExactlyOnceWith('confirmed', '/native');
  });
  it('mobile actual row closes sheet only after native confirmed selection, not refusal', () => {
    for (const result of ['selected', 'rejected']) { const select = vi.fn(() => result), close = vi.fn(); callback('mobile', 'handleSelectSession', { piNativeSelectSessionFromUser: select, getSessionDirectory: () => '/native', onOpenChange: close })({ id: 'confirmed' }); expect(select).toHaveBeenCalledExactlyOnceWith('confirmed', '/native'); expect(close).toHaveBeenCalledTimes(result === 'selected' ? 1 : 0); }
  });
  it('desktop tree/header new callbacks only close surfaces on selected local native draft', () => {
    for (const result of ['selected', 'rejected']) { const newDraft = vi.fn(() => result), close = vi.fn(), switcher = vi.fn(); const globals = { piNativeNewDraftFromUser: newDraft, useUIStore: { getState: () => ({ closeMainSurfaces: close }) }, mobileVariant: true, setSessionSwitcherOpen: switcher }; callback('sidebar', 'openNewSessionDraftFromTree', globals)({ directoryOverride: '/native' }); callback('sidebar', 'handleOpenNewSessionDraftFromHeader', globals)(); expect(newDraft).toHaveBeenCalledTimes(2); expect(close).toHaveBeenCalledTimes(result === 'selected' ? 2 : 0); expect(switcher).toHaveBeenCalledTimes(result === 'selected' ? 1 : 0); }
  });
  it('mobile header/project new callbacks never alter active Source project on native path', () => {
    const newDraft = vi.fn(() => 'selected'), close = vi.fn(); const globals = { piNativeNewDraftFromUser: newDraft, onOpenChange: close }; callback('mobile', 'handleStartNewChat', globals)(); callback('mobile', 'handleNewSessionInProject', globals)({ id: 'pi-native', path: '/native' }); expect(newDraft.mock.calls).toEqual([[], [{ selectedProjectId: 'pi-native', directoryOverride: '/native' }]]); expect(close).toHaveBeenCalledTimes(2);
  });
  it('actual dropdown selection/new early native branches retain close-on-confirmation only', () => {
    for (const result of ['selected', 'rejected']) { const select = vi.fn(() => result), draft = vi.fn(() => result), close = vi.fn(); callback('switcher', 'handleSelect', { piNativeSelectSessionFromUser: select, session: { id: 'confirmed' }, resolveGlobalSessionDirectory: () => '/native', closeDropdown: close })(); callback('switcher', 'handleNewSession', { piNativeNewDraftFromUser: draft, onSelect: close })(); expect(close).toHaveBeenCalledTimes(result === 'selected' ? 2 : 0); }
  });
  it('unbound original row/new callback bodies still run rather than synthesize native success', () => {
    const sourceSelect = vi.fn(), close = vi.fn(); callback('mobile', 'handleSelectSession', { piNativeSelectSessionFromUser: () => false, getSessionDirectory: () => '/old', findExactProjectMatch: () => null, projectsMeta: [], setCurrentSession: sourceSelect, onOpenChange: close })({ id: 'old-session' }); expect(sourceSelect).toHaveBeenCalledExactlyOnceWith('old-session', '/old'); expect(close).toHaveBeenCalledExactlyOnceWith(false);
    const oldNew = vi.fn(); callback('switcher', 'handleNewSession', { piNativeNewDraftFromUser: () => false, onSelect: close, openNewSessionDraft: oldNew })(); expect(oldNew).toHaveBeenCalledTimes(1);
  });
  it('all five overlays reject unknown/drift/duplicate/reapply and preserve original body after guard removal', () => {
    for (const kind of Object.keys(paths) as (keyof typeof paths)[]) { const out = overlay(originals[kind], kind); expect(() => overlay(out, kind)).toThrow('already applied'); parse(kind); }
    const anchor = '  const handleSelectSession = (session: Session) => {'; expect(() => overlay(originals.mobile.replace(anchor, 'changed'), 'mobile')).toThrow('anchor'); expect(() => overlay(originals.mobile + '\n' + anchor, 'mobile')).toThrow('anchor'); expect(() => overlay('', 'unknown')).toThrow('Unknown');
    const out = overlay(originals.store, 'store'); const start = out.indexOf(originals.store.slice(0, 100)); const body = out.slice(start).split('\n// Explicit user callbacks only.')[0].trimEnd().replace(/\n    \/\/ Legacy selection\/cache\/draft effects never own native navigation\.\n    if \(piGetNativeHost\(\)\) return;/g, ''); expect(body).toBe(originals.store.trimEnd());
  });
});
