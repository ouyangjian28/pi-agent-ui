import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { nativeHistorySurfaceTransform } from '../../../tools/ui-oc-native-history-transform.mjs';
import { isNativeChronology, nativeChronologyWindow, nativeChronologyProjection, initializeNativeReadDirectory } from '../../../apps/web/src/oc-bridge/native-history-surface';
import { ocReadResponse } from '../../../apps/web/src/oc-bridge/oc-read-projection';
import type { NativePiSnapshot } from '../../../apps/web/src/oc-bridge/native-pi-port';
const binding = vi.hoisted(() => ({ host: null as null | { port: { getSnapshot: () => NativePiSnapshot } } }));
vi.mock('../../../apps/web/src/oc-bridge/native-surface-host', () => ({ getNativeSurfaceHost: () => binding.host }));
const ts: typeof import('typescript') = createRequire(resolve(process.cwd(), 'package.json'))('typescript');
const base = resolve(process.cwd(), 'vendor/openchamber-frontend/packages/ui/src');
const paths = { window: 'components/chat/lib/turns/windowTurns.ts', projection: 'components/chat/lib/turns/projectTurnRecords.ts', messages: 'components/chat/MessageList.tsx', bootstrap: 'sync/bootstrap.ts' };
const read = (kind: keyof typeof paths) => readFileSync(resolve(base, paths[kind]), 'utf8');
const helpers = { isNativeChronology, nativeChronologyWindow, nativeChronologyProjection, initializeNativeReadDirectory };
const getHost = () => binding.host;
const native = (id: string, role = 'assistant', seq: number | null = 1, temporary = false) => ({ info: { id: 'pi-' + id, role, native: { role, seq, temporary } }, parts: [] });
function ready() {
  // Deliberately bounded DTO fixture; not a real gateway/owner/runtime proof.
  const snapshot = { list: { state: 'ready', sessions: [], roots: { status: 'ok', items: ['/owned', '/journal'], journalRoot: '/journal' } }, write: { connState: 'ready' }, detail: { connState: 'ready', status: null } } as unknown as NativePiSnapshot;
  binding.host = { port: { getSnapshot: () => snapshot } }; return snapshot;
}
function transpile(source: string) {
  const result = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }, reportDiagnostics: true });
  expect(result.diagnostics ?? []).toEqual([]); return result.outputText;
}
function module(kind: 'window' | 'projection') {
  type Window = ReturnType<typeof nativeChronologyWindow>;
  type Projection = Omit<ReturnType<typeof nativeChronologyProjection>, 'turns'> & { turns: { assistantMessageIds: string[] }[] };
  const exports = {} as { buildTurnWindowModel(messages: unknown[]): Window; updateTurnWindowModelIncremental(previous: Window, previousMessages: unknown[], nextMessages: unknown[]): Window | null; projectTurnRecords(messages: unknown[]): Projection };
  const deps: Record<string, unknown> = {
    '@pi-native/history-surface': helpers, '@pi-native/surface-host': { getNativeSurfaceHost: getHost },
    '../../message/hiddenUserMessage': { isHiddenUserMessage: () => false },
    './projectTurnActivity': { projectTurnActivity: () => ({ activityParts: [], activitySegments: [], hasTools: false, hasReasoning: false }) },
    './projectTurnSummary': { projectTurnSummary: () => ({}), projectTurnChangedFiles: () => undefined, projectTurnDiffStats: () => undefined },
  };
  const indexes: Record<string, unknown> = {};
  runInNewContext(transpile(readFileSync(resolve(base, 'components/chat/lib/turns/projectTurnIndexes.ts'), 'utf8')), { exports: indexes }); deps['./projectTurnIndexes'] = indexes;
  runInNewContext(transpile(nativeHistorySurfaceTransform(read(kind), kind)), { exports, require: (name: string) => { if (!(name in deps)) throw new Error('Unmocked Source dependency: ' + name); return deps[name]; } });
  return exports;
}
function trailing(messages: ReturnType<typeof native>[], host: boolean) {
  binding.host = host ? ready() && binding.host : null;
  const source = nativeHistorySurfaceTransform(read('messages'), 'messages');
  const file = ts.createSourceFile('MessageList.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const nodes: string[] = []; const visit = (node: import('typescript').Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'trailingStreamingEntry' && node.initializer && ts.isCallExpression(node.initializer)) nodes.push(node.initializer.arguments[0].getText(file));
    ts.forEachChild(node, visit);
  }; visit(file); expect(nodes).toHaveLength(1);
  return runInNewContext(transpile('const fn = ' + nodes[0] + '; exports.result = fn();'), { exports: {}, piGetNativeHost: getHost, piIsNativeChronology: isNativeChronology, displayMessages: messages });
}
function initializer() {
  const source = nativeHistorySurfaceTransform(read('bootstrap'), 'bootstrap');
  const file = ts.createSourceFile('bootstrap.ts', source, ts.ScriptTarget.Latest, true);
  const node = file.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'initializeDirectory'); expect(node).toBeDefined();
  const exports: { fn?: (input: unknown) => Promise<string> } = {};
  runInNewContext(transpile(node!.getText(file) + '\nexports.fn = initializeDirectory;'), { exports, piGetNativeHost: getHost, piInitializeNativeReadDirectory: initializeNativeReadDirectory }); return exports.fn!;
}
describe('native history original Source AST/VM (not browser/Source tsc acceptance)', () => {
  it('native marker predicate rejects empty, mixed, nonnative and malformed seq records', () => {
    expect(isNativeChronology([])).toBe(false); expect(isNativeChronology([native('a')])).toBe(true);
    for (const rows of [[native('a'), { info: { id: 'old' } }], [{ info: { id: 'old', native: { role: 'assistant', seq: 1, temporary: false } } }], [{ info: { id: 'pi-a', native: { role: 'assistant', seq: -1, temporary: false } } }]]) expect(isNativeChronology(rows)).toBe(false);
  });
  it('flat native projection retains users, orphan assistants and tool cards without guessed parents', () => {
    const rows = [native('a'), native('u', 'user'), native('t', 'toolResult')]; const before = JSON.stringify(rows); const p = nativeChronologyProjection(rows);
    expect([...p.ungroupedMessageIds]).toEqual(['pi-a', 'pi-u', 'pi-t']); expect(p.turns).toEqual([]); expect(p.indexes.messageToTurnId.size).toBe(0); expect(JSON.stringify(rows)).toBe(before);
  });
  it('flat native window gives each record its own anchor and preserves input order', () => {
    const p = nativeChronologyWindow([native('a'), native('u', 'user'), native('b')]); expect(p.turnIds).toEqual(['pi-a', 'pi-u', 'pi-b']); expect(p.turnMessageStartIndexes).toEqual([0, 1, 2]); expect(p.messageToTurnId.get('pi-a')).toBe('pi-a'); expect(p.turnCount).toBe(3);
  });
  it('temporary and null-seq live bytes remain temporary, never finalized or assigned a parent', () => {
    const rows = [native('u', 'user'), native('live', 'assistant', null, true)]; expect(isNativeChronology(rows)).toBe(true); nativeChronologyWindow(rows); nativeChronologyProjection(rows); expect(rows[1].info.native).toEqual({ role: 'assistant', seq: null, temporary: true }); expect(rows[1].info).not.toHaveProperty('parentID'); expect(rows[1].info.native).not.toHaveProperty('final');
  });
  it('actual Source window keeps standalone native assistant without a visible parent', () => {
    ready(); const p = module('window').buildTurnWindowModel([native('a')]); expect(p.turnIds).toEqual(['pi-a']); expect(p.messageToTurnIndex.get('pi-a')).toBe(0);
  });
  it('actual Source native incremental path requests full rebuild rather than omitting an assistant', () => {
    ready(); const m = module('window'); const rows = [native('u', 'user')]; expect(m.updateTurnWindowModelIncremental(m.buildTurnWindowModel(rows), rows, [...rows, native('a')])).toBeNull();
  });
  it('unbound original window retains user-parent rules even if marker-shaped data appears', () => {
    binding.host = null; const m = module('window'); const a = { info: { id: 'a', role: 'assistant', parentID: 'u' }, parts: [] }; const p = m.buildTurnWindowModel([{ info: { id: 'u', role: 'user' }, parts: [] }, a]); expect(p.turnIds).toEqual(['u']); expect(p.messageToTurnId.get('a')).toBe('u'); expect(m.buildTurnWindowModel([native('a')]).turnCount).toBe(0);
  });
  it('actual Source projection preserves all native cards with zero invented grouping/summary', () => {
    ready(); const p = module('projection').projectTurnRecords([native('a'), native('u', 'user'), native('t', 'toolCall')]); expect([...p.ungroupedMessageIds]).toEqual(['pi-a', 'pi-u', 'pi-t']); expect(p.turns).toHaveLength(0); expect(p.lastTurnId).toBeNull();
  });
  it('unbound original projector still omits an orphan and groups a real parent exactly', () => {
    binding.host = null; const m = module('projection'); expect(m.projectTurnRecords([native('a')]).ungroupedMessageIds.size).toBe(0); const p = m.projectTurnRecords([{ info: { id: 'u', role: 'user' }, parts: [] }, { info: { id: 'a', role: 'assistant', parentID: 'u' }, parts: [] }]); expect(p.turns[0].assistantMessageIds).toEqual(['a']);
  });
  it('actual Source native trailing callback returns before duplicating a static record or old no-reply turn', () => {
    // Missing original dependencies deliberately throw if the early branch fails.
    expect(trailing([native('u', 'user'), native('a')], true)).toBeUndefined(); expect(() => trailing([native('a')], false)).toThrow();
  });
  it('actual Source initializer commits only real native read facts with native flags', async () => {
    ready(); const set = vi.fn(); expect(await initializer()({ directory: '/owned', set })).toBe('complete'); expect(set).toHaveBeenCalledOnce(); const patch = set.mock.calls[0][0]; expect(patch.project).toBe('pi-native'); expect(patch.path).toMatchObject({ directory: '/owned', nativePi: true, nativeExecutionDirectoryKnown: false }); expect(patch.config.nativePi).toBe(true); expect(Object.keys(patch).sort()).toEqual(['config', 'path', 'project', 'status']);
  });
  it('stale native initialization commits nothing, both before and after async fact reads', async () => {
    ready(); for (const stale of [() => true, vi.fn().mockReturnValueOnce(false).mockReturnValue(true)]) { const set = vi.fn(); expect(await initializeNativeReadDirectory('/owned', set, stale)).toBe('stale'); expect(set).not.toHaveBeenCalled(); }
  });
  it('closed/unready/wrong-directory initialization fails without clearing any old state', async () => {
    for (const mode of ['closed', 'unready', 'wrong']) { const s = ready(); if (mode === 'closed') binding.host = null; if (mode === 'unready') (s.write as { connState: string }).connState = 'disconnected'; const set = vi.fn(); expect(await initializeNativeReadDirectory(mode === 'wrong' ? '/outside' : '/owned', set)).toBe('failed'); expect(set).not.toHaveBeenCalled(); }
  });
  it('known native read subset never supplies empty authoritative unsupported capability results', async () => {
    const s = ready(); const set = vi.fn(); await initializeNativeReadDirectory('/owned', set); const patch = set.mock.calls[0][0]; for (const key of ['question', 'permission', 'command', 'mcp', 'lsp', 'vcs', 'session_status', 'sessionStatusReady']) expect(patch).not.toHaveProperty(key); for (const path of ['/api/question', '/api/permission', '/api/command', '/api/mcp', '/api/lsp', '/api/vcs']) expect(ocReadResponse(path, 'GET', s).status).toBe(501);
  });
  it('unbound original bootstrap retains all original question/permission reads and failure semantics', async () => {
    binding.host = null; const fn = initializer(); const getState = vi.fn(() => ({ config: {} })); await expect(fn({ directory: '/old', store: { getState }, global: { config: {}, projects: [] }, set: vi.fn() })).rejects.toThrow('projectID is not defined'); expect(getState).toHaveBeenCalledOnce(); const source = nativeHistorySurfaceTransform(read('bootstrap'), 'bootstrap'); for (const literal of ['sdk.question.list({ directory })', 'sdk.permission.list({ directory })', 'if (errors.length)', 'return "failed"']) expect(source).toContain(literal);
  });
  it('all four overlays preserve original bodies, reject repeat/anchor drift and parse actual Source', () => {
    for (const kind of Object.keys(paths) as (keyof typeof paths)[]) { const original = read(kind); const out = nativeHistorySurfaceTransform(original, kind); transpile(out); expect(() => nativeHistorySurfaceTransform(out, kind)).toThrow('already applied'); expect(() => nativeHistorySurfaceTransform('', kind)).toThrow('anchor'); const lines = out.split('\n'); const remaining = lines.filter(line => !line.includes('piGetNativeHost') && !line.includes('@pi-native/history-surface') && !line.includes('pi-native-history-read-surface-overlay')).join('\n'); expect(remaining).toBe(original); }
  });
});
