import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { nativeLegacySessionNoticeTransform } from '../../../tools/ui-oc-native-session-error-transform.mjs';
const ts: typeof import('typescript') = createRequire(resolve(process.cwd(), 'package.json'))('typescript');
const original = readFileSync(resolve(process.cwd(), 'vendor/openchamber-frontend/packages/ui/src/components/chat/SessionErrorNotice.tsx'), 'utf8');
const source = nativeLegacySessionNoticeTransform(original);
function compile(text: string) {
  const result = ts.transpileModule(text, { fileName: 'SessionErrorNotice.tsx', compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }, reportDiagnostics: true });
  expect(result.diagnostics ?? []).toEqual([]); return result.outputText;
}
function component(native: boolean, latestError: null | { time: number; error: { name: string; message: string } } = null) {
  const calls: string[] = [];
  const host = { nativeError: { message: 'owned native transport error remains owned' } };
  const record = { role: 'user', time: { created: Date.now() - 60_000 } };
  const react = {
    useRef: (current: unknown) => { calls.push('ref'); return { current }; },
    useCallback: (fn: () => unknown) => { calls.push('callback'); return fn; },
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => { calls.push('externalStore'); return getSnapshot(); },
    useState: (initial: () => number) => { calls.push('state'); return [initial(), () => { throw new Error('Unexpected effect setter during render'); }]; },
    useEffect: (_effect: unknown) => { calls.push('effect'); },
  };
  const jsx = (type: unknown, props: unknown) => ({ type, props });
  const deps: Record<string, unknown> = {
    react: { default: react }, 'react/jsx-runtime': { jsx, jsxs: jsx },
    '@pi-native/surface-host': { getNativeSurfaceHost: () => native ? host : null },
    '@/components/icon/Icon': { Icon: 'Icon' },
    '@/lib/i18n': { useI18n: () => { calls.push('i18n'); return { t: (key: string) => key }; } },
    '@/sync/notification-store': { useLatestSessionError: () => { calls.push('latestError'); return latestError; } },
    '@/sync/sync-context': {
      useSessionStatus: () => { calls.push('status'); return undefined; }, // Unknown is NOT native accepted-send/no-reply evidence.
      useDirectoryStore: () => { calls.push('directory'); return { getState: () => ({ message: { s: [record] } }), subscribe: () => () => undefined }; },
    },
  };
  const exports = {} as { SessionErrorNotice: (props: { sessionId: string; directory: string }) => unknown };
  runInNewContext(compile(source), { exports, require: (name: string) => { if (!(name in deps)) throw new Error('Unmocked original Source import: ' + name); return deps[name]; }, Date });
  const result = exports.SessionErrorNotice({ sessionId: 's', directory: '/owned' });
  return { result, calls, host };
}
describe('native original SessionErrorNotice AST/VM (not main UI acceptance)', () => {
  it('native unknown-status aged user never invents accepted-send/no-reply and runs every original hook', () => {
    const { result, calls } = component(true);
    expect(result).toBeNull(); expect(calls).toEqual(['i18n', 'latestError', 'status', 'directory', 'ref', 'callback', 'callback', 'externalStore', 'state', 'effect']);
  });
  it('native ignores legacy error notifications without mutating native owner error state (not display proof)', () => {
    const legacy = { time: Date.now(), error: { name: 'Legacy', message: 'old notification' } }; const before = JSON.stringify(legacy);
    const { result, calls, host } = component(true, legacy);
    expect(result).toBeNull(); expect(calls.at(-1)).toBe('effect'); expect(JSON.stringify(legacy)).toBe(before); expect(host.nativeError.message).toBe('owned native transport error remains owned');
  });
  it('unbound original no-reply and reported-error rendering remain intact with the same hooks', () => {
    const noReply = component(false); expect(JSON.stringify(noReply.result)).toContain('chat.sessionError.noReply');
    const reported = component(false, { time: Date.now(), error: { name: 'Legacy', message: 'original real old error' } });
    expect(JSON.stringify(reported.result)).toContain('Legacy: original real old error'); expect(JSON.stringify(reported.result)).toContain('chat.sessionError.title'); expect(reported.calls).toEqual(noReply.calls);
  });
  it('overlay preserves the full unbound body, guards after hooks, rejects repeat/drift and parses actual TSX', () => {
    compile(source); const prefix = "// pi-native-no-legacy-session-error-inference\nimport { getNativeSurfaceHost as piGetNativeHost } from '@pi-native/surface-host';\n";
    const branch = '  if (piGetNativeHost()) return null; // All original hooks ran; legacy error inference is unavailable on native surfaces.\n\n';
    expect(source.startsWith(prefix)).toBe(true); expect(source.slice(prefix.length).replace(branch, '')).toBe(original);
    const file = ts.createSourceFile('SessionErrorNotice.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const fn = file.statements.flatMap(node => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : []).find(node => node.name.getText(file) === 'SessionErrorNotice'); expect(fn).toBeDefined();
    const body = (fn!.initializer as import('typescript').ArrowFunction).body as import('typescript').Block;
    const guard = body.statements.findIndex(node => ts.isIfStatement(node) && node.expression.getText(file) === 'piGetNativeHost()'); expect(guard).toBeGreaterThan(0);
    expect(body.statements.slice(guard + 1).map(node => node.getText(file)).join('\n')).not.toMatch(/React\.use[A-Z]/);
    expect(body.statements.slice(0, guard).map(node => node.getText(file)).join('\n')).toContain('React.useEffect');
    expect(() => nativeLegacySessionNoticeTransform(source)).toThrow('already applied'); expect(() => nativeLegacySessionNoticeTransform('')).toThrow('anchor'); expect(() => nativeLegacySessionNoticeTransform(original + '\n  if (!reportedError && !unanswered) return null;')).toThrow('anchor');
  });
});
