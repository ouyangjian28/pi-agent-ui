import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { nativeWebNotificationTransform } from '../../../tools/ui-oc-native-startup-transform.mjs';

const ROOT = process.cwd();
const ts = createRequire(resolve(ROOT, 'package.json'))('typescript');
const source = readFileSync(resolve(ROOT, 'vendor/openchamber-frontend/packages/ui/src/hooks/useWebNotificationStream.ts'), 'utf8');
function probe(nativeHost: object | null, desktop = false, web = true) {
  const exports: { useWebNotificationStream?: (options?: { enabled?: boolean }) => void } = {};
  let effect: (() => void | (() => void)) | null = null;
  let dependencies: unknown = null;
  const ctor = vi.fn(); const close = vi.fn(); const notify = vi.fn();
  const settings = { nativeNotificationsEnabled: true, notificationMode: 'always' };
  let stream: { onmessage?: (event: { data: string }) => void; close(): void } | null = null;
  const modules: Record<string, unknown> = {
    react: { default: { useEffect: (fn: typeof effect, deps: unknown) => { effect = fn; dependencies = deps; } } },
    '@pi-native/surface-host': { getNativeSurfaceHost: () => nativeHost },
    '@/contexts/runtimeAPIRegistry': { getRegisteredRuntimeAPIs: () => ({ notifications: { notifyAgentCompletion: notify } }) },
    '@/lib/desktop': { isDesktopShell: () => desktop, isWebRuntime: () => web },
    '@/lib/runtime-url': { getRuntimeUrlResolver: () => ({ sse: (path: string) => path }) },
    '@/stores/useUIStore': { useUIStore: { getState: () => settings } },
  };
  const code = ts.transpileModule(nativeWebNotificationTransform(source), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, {
    exports, window: {}, document: { visibilityState: 'visible', hasFocus: () => true },
    require: (name: string) => { if (!(name in modules)) throw new Error('Unmocked Source dependency: ' + name); return modules[name]; },
    EventSource: class {
      onmessage?: (event: { data: string }) => void;
      constructor(path: string) { ctor(path); stream = this; }
      close() { close(); }
    },
  });
  return {
    ctor, close, notify, settings,
    start(options?: { enabled?: boolean }) { exports.useWebNotificationStream!(options); expect(effect).not.toBeNull(); return effect!(); },
    dependencies: () => dependencies,
    message(data: string) { expect(stream).not.toBeNull(); stream!.onmessage?.({ data }); },
  };
}
describe('actual Source notification effect (VM/React hook capture, not browser/Source tsc)', () => {
  it('native active host retains hook order/deps but never creates an old notification stream', () => {
    const p = probe({}); expect(p.start()).toBeUndefined(); expect(p.dependencies()).toEqual([true]); expect(p.ctor).not.toHaveBeenCalled(); expect(p.notify).not.toHaveBeenCalled();
  });
  it('closed native host stays fail-closed, not a reason to fall back to the old server', () => {
    const p = probe({ closed: true }); expect(p.start({ enabled: true })).toBeUndefined(); expect(p.dependencies()).toEqual([true]); expect(p.ctor).not.toHaveBeenCalled();
  });
  it('unbound original web preserves stream/payload validation/settings/focus and cleanup', () => {
    const p = probe(null); const stop = p.start(); expect(p.ctor).toHaveBeenCalledExactlyOnceWith('/api/notifications/stream');
    p.message('bad-json'); p.message('{}'); expect(p.notify).not.toHaveBeenCalled();
    const data = JSON.stringify({ type: 'openchamber:notification', properties: { title: 'owned-title', body: 'owned-body', tag: 'owned-tag' } });
    p.settings.nativeNotificationsEnabled = false; p.message(data); expect(p.notify).not.toHaveBeenCalled();
    p.settings.nativeNotificationsEnabled = true; p.settings.notificationMode = 'when-hidden'; p.message(data); expect(p.notify).not.toHaveBeenCalled();
    p.settings.notificationMode = 'always'; p.message(data); expect(p.notify).toHaveBeenCalledExactlyOnceWith({ title: 'owned-title', body: 'owned-body', tag: 'owned-tag' });
    expect(typeof stop).toBe('function'); if (typeof stop === 'function') stop(); expect(p.close).toHaveBeenCalledTimes(1);
  });
  it('original disabled/desktop/nonweb branches still do not subscribe', () => {
    for (const [desktop, web, enabled] of [[false, true, false], [true, true, true], [false, false, true]]) {
      const p = probe(null, desktop, web); expect(p.start({ enabled })).toBeUndefined(); expect(p.dependencies()).toEqual([enabled]); expect(p.ctor).not.toHaveBeenCalled();
    }
  });
  it('actual effect/path anchors reject drift/duplicates and applying the overlay twice', () => {
    const out = nativeWebNotificationTransform(source); expect(() => nativeWebNotificationTransform(out)).toThrow('already applied');
    expect(() => nativeWebNotificationTransform(source.replace('  React.useEffect(() => {\n', '  React.useLayoutEffect(() => {\n')))).toThrow('anchor');
    expect(() => nativeWebNotificationTransform(source + '\n  React.useEffect(() => {\n')).toThrow('anchor');
    expect(() => nativeWebNotificationTransform(source.replace('/api/notifications/stream', '/api/drift'))).toThrow('anchor');
  });
});
