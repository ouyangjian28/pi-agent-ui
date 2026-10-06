import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { NativePiPort, type NativePiSnapshot } from '../../../apps/web/src/oc-bridge/native-pi-port';
const ROOT = resolve(process.cwd());
const ts = createRequire(resolve(ROOT, 'package.json'))('typescript') as typeof import('typescript');
const { nativeOriginalEntryTransform, nativeReadOnlyComposerTransform, nativeCompanionEventsTransform } = await import(resolve(ROOT, 'tools/ui-oc-native-startup-transform.mjs'));
function compile(path: string) {
  return ts.transpileModule(readFileSync(resolve(ROOT, path), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
}
class Element extends EventTarget {
  children: Element[] = []; value = ''; hidden = false; disabled = false; required = false;
  textContent = ''; type = ''; autocomplete = ''; style = { cssText: '' };
  constructor(readonly tag: string, readonly ownerDocument: FakeDocument) { super(); }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  setAttribute() {}
  find(tag: string): Element { return this.children.find(x => x.tag === tag) ?? this.children.map(x => { try { return x.find(tag); } catch { return null; } }).find(Boolean) ?? (() => { throw new Error('Missing fake DOM element: ' + tag); })(); }
}
class FakeDocument { createElement(tag: string) { return new Element(tag, this); } }
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function rig() {
  const p = new NativePiPort('ws://127.0.0.1/', 'fixture-only'); const initial = p.getSnapshot(); p.dispose();
  const ready: NativePiSnapshot = { ...initial,
    list: { ...initial.list, state: 'ready', models: { ...initial.list.models, status: 'ok' }, roots: { ...initial.list.roots, status: 'ok' } },
    write: { ...initial.write, connState: 'ready' }, detail: { ...initial.detail, connState: 'ready' },
  };
  let facts = initial;
  const listeners = new Set<() => void>();
  const host = { port: { getSnapshot: () => facts, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; } }, dispose: vi.fn(), reconnect: vi.fn() };
  const createHost = vi.fn(async (_options: unknown) => host);
  const disposeRenderer = vi.fn(); const render = vi.fn(async () => disposeRenderer);
  const loadRenderer = vi.fn(async () => ({ renderOriginalNativeSurface: render }));
  const exports: Record<string, any> = {};
  runInNewContext(compile('apps/web/src/oc-bridge/native-original-startup.ts'), { exports, WeakMap, AbortController, DOMException,
    require: (name: string) => { if (name === './native-surface-host') return { createNativeSurfaceHost: createHost }; throw new Error(name); },
  });
  const root = new FakeDocument().createElement('root'); const network = vi.fn(); const target = { fetch: network, location: { origin: 'http://127.0.0.1' } };
  const options = { target, root, surface: 'desktop', capturedNetworkFetch: network, loadRenderer };
  const start = () => exports.startOriginalNativeSurface(options);
  const login = async () => { root.find('input').value = 'fixture-only'; root.find('form').dispatchEvent(new Event('submit', { cancelable: true })); await flush(); };
  return { exports, ready, root, target, options, network, listeners, host, createHost, loadRenderer, render, disposeRenderer, start, login,
    update(value: NativePiSnapshot) { facts = value; for (const fn of [...listeners]) fn(); },
  };
}

describe('original native startup orchestration (fake DOM/host, not actual Source App render)', () => {
  it('does not import or authenticate before explicit submission; password is never copied to UI text', () => {
    const r = rig(); r.start(); expect(r.createHost).not.toHaveBeenCalled(); expect(r.loadRenderer).not.toHaveBeenCalled(); expect(r.network).not.toHaveBeenCalled(); expect(r.root.find('input').type).toBe('password');
  });
  it('clears credential field before auth and loads Source only after all native read gates', async () => {
    const r = rig(); const startup = r.start(); await r.login(); expect(r.root.find('input').value).toBe(''); expect(r.createHost).toHaveBeenCalledTimes(1);
    expect(r.createHost.mock.calls[0]?.[0]).toMatchObject({ token: 'fixture-only', capturedNetworkFetch: r.network, target: r.target });
    expect(r.loadRenderer).not.toHaveBeenCalled(); r.update(r.ready); await flush();
    expect(r.loadRenderer).toHaveBeenCalledTimes(1); expect(r.render).toHaveBeenCalledWith(r.host, 'desktop', r.root); startup.dispose();
  });
  it('requires actual model/root/list/write/detail ready, never promoting incomplete facts', () => {
    const r = rig(); expect(r.exports.originalNativeReadsReady(r.ready)).toBe(true);
    for (const value of [
      { ...r.ready, list: { ...r.ready.list, state: 'connecting' } },
      { ...r.ready, list: { ...r.ready.list, models: { ...r.ready.list.models, status: 'idle' } } },
      { ...r.ready, list: { ...r.ready.list, roots: { ...r.ready.list.roots, status: 'idle' } } },
      { ...r.ready, write: { ...r.ready.write, connState: 'closed' } },
      { ...r.ready, detail: { ...r.ready.detail, connState: 'closed' } },
    ]) expect(r.exports.originalNativeReadsReady(value)).toBe(false);
  });
  it('failed auth never imports Source and permits only another explicit submit, with fixed error copy', async () => {
    const r = rig(); r.createHost.mockRejectedValueOnce(new Error('fixture-secret-error')); r.start(); await r.login(); expect(r.loadRenderer).not.toHaveBeenCalled(); expect(r.root.find('p').textContent).not.toContain('fixture-secret-error'); expect(r.root.find('button').disabled).toBe(false);
    await r.login(); expect(r.createHost).toHaveBeenCalledTimes(2); expect(r.loadRenderer).not.toHaveBeenCalled();
  });
  it('duplicate starts/submits do not replace host; subsequent facts never rerender/import a second root', async () => {
    const r = rig(); const a = r.start(); expect(r.start()).toBe(a); await r.login(); await r.login(); expect(r.createHost).toHaveBeenCalledTimes(1);
    r.update(r.ready); await flush(); r.update(r.ready); await flush(); expect(r.render).toHaveBeenCalledTimes(1); a.dispose();
  });
  it('dispose removes listeners/renderer and does not revive on a repeated entry', async () => {
    const r = rig(); const s = r.start(); await r.login(); r.update(r.ready); await flush(); s.dispose(); s.dispose();
    expect(r.listeners.size).toBe(0); expect(r.host.dispose).toHaveBeenCalledTimes(1); expect(r.disposeRenderer).toHaveBeenCalledTimes(1); expect(r.root.children).toHaveLength(0); expect(r.start()).toBe(s); r.update(r.ready); await flush(); expect(r.render).toHaveBeenCalledTimes(1);
  });
  it('dispose while Source loader waits cannot mount a late renderer', async () => {
    const r = rig(); let finish!: (value: { renderOriginalNativeSurface: typeof r.render }) => void;
    r.loadRenderer.mockImplementationOnce(() => new Promise<{ renderOriginalNativeSurface: typeof r.render }>(resolve => { finish = resolve; })); const s = r.start(); await r.login(); r.update(r.ready); await flush(); s.dispose(); finish({ renderOriginalNativeSurface: r.render }); await flush(); expect(r.render).not.toHaveBeenCalled();
  });
  it('connection loss during import blocks mount, but confirmed reconnect keeps the same host', async () => {
    const r = rig(); let finish!: (value: { renderOriginalNativeSurface: typeof r.render }) => void;
    r.loadRenderer.mockImplementationOnce(() => new Promise<{ renderOriginalNativeSurface: typeof r.render }>(resolve => { finish = resolve; })); const s = r.start(); await r.login(); r.update(r.ready); await flush();
    r.update({ ...r.ready, write: { ...r.ready.write, connState: 'closed' } }); finish({ renderOriginalNativeSurface: r.render }); await flush(); expect(r.render).not.toHaveBeenCalled();
    r.update(r.ready); await flush(); expect(r.createHost).toHaveBeenCalledTimes(1); expect(r.render).toHaveBeenCalledTimes(1); s.dispose();
  });
  it('Source import failure closes the host and exposes no arbitrary transport error', async () => {
    const r = rig(); r.loadRenderer.mockRejectedValueOnce(new Error('fixture-secret-error')); r.start(); await r.login(); r.update(r.ready); await flush();
    expect(r.host.dispose).toHaveBeenCalledTimes(1); expect(r.render).not.toHaveBeenCalled(); expect(r.root.find('p').textContent).not.toContain('fixture-secret-error');
  });
});

function companionEventsRig(host: object | null, vscode = false) {
  const source = readFileSync(resolve(ROOT, 'vendor/openchamber-frontend/packages/ui/src/lib/openchamberEvents.ts'), 'utf8');
  const output = nativeCompanionEventsTransform(source);
  const exports: Record<string, any> = {};
  const runtimeUnsubscribe = vi.fn(); const runtimeSubscribe = vi.fn(() => runtimeUnsubscribe);
  const timers = vi.fn(() => 1); const clearTimer = vi.fn(); const sseUrl = vi.fn((path: string) => path);
  const created: FakeEvents[] = [];
  class FakeEvents {
    static CLOSED = 2;
    readonly readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    readonly close = vi.fn();
    constructor(readonly url: string) { created.push(this); }
  }
  const zod = createRequire(resolve(ROOT, 'vendor/openchamber-frontend/package.json'))('zod');
  const code = ts.transpileModule(output, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, { exports, window: {}, EventSource: FakeEvents, setTimeout: timers, clearTimeout: clearTimer,
    require: (name: string) => {
      if (name === '@pi-native/surface-host') return { getNativeSurfaceHost: () => host };
      if (name === './runtime-url') return { getRuntimeUrlResolver: () => ({ sse: sseUrl }) };
      if (name === './runtime-switch') return { subscribeRuntimeEndpointChanged: runtimeSubscribe };
      if (name === './desktop') return { isVSCodeRuntime: () => vscode };
      if (name === '@/stores/messageQueueStore') return { messageQueueUpdatedEventSchema: { safeParse: () => ({ success: false }) } };
      if (name === 'zod') return zod;
      throw new Error('Unexpected original companion dependency: ' + name);
    },
  });
  return { source, output, exports, created, timers, clearTimer, sseUrl, runtimeSubscribe, runtimeUnsubscribe };
}
describe('actual original companion stream module (VM execution, not actual Source Root)', () => {
  it.each(['open', 'closed'])('native %s host registers no companion listeners, timers, runtime callbacks, or old SSE', state => {
    const r = companionEventsRig({ state }); const listener = vi.fn();
    const unsubscribe = r.exports.subscribeOpenchamberEvents(listener); unsubscribe(); unsubscribe();
    expect(r.created).toHaveLength(0); expect(r.sseUrl).not.toHaveBeenCalled(); expect(r.runtimeSubscribe).not.toHaveBeenCalled();
    expect(r.timers).not.toHaveBeenCalled(); expect(r.clearTimer).not.toHaveBeenCalled(); expect(listener).not.toHaveBeenCalled();
  });
  it('retains original VSCode no-companion path when no native host exists', () => {
    const r = companionEventsRig(null, true); const listener = vi.fn(); r.exports.subscribeOpenchamberEvents(listener)();
    expect(r.created).toHaveLength(0); expect(r.runtimeSubscribe).not.toHaveBeenCalled(); expect(r.timers).not.toHaveBeenCalled(); expect(listener).not.toHaveBeenCalled();
  });
  it('retains actual nonnative companion connection/event/heartbeat and cleanup behavior', () => {
    const r = companionEventsRig(null); const listener = vi.fn(); const unsubscribe = r.exports.subscribeOpenchamberEvents(listener);
    expect(r.runtimeSubscribe).toHaveBeenCalledTimes(1); expect(r.created).toHaveLength(1); const connection = r.created[0]!;
    expect(connection.url).toBe('/api/openchamber/events'); connection.onopen!(); expect(r.timers).toHaveBeenCalledTimes(1);
    connection.onmessage!({ data: JSON.stringify({ type: 'openchamber:event-stream-ready', properties: {} }) });
    expect(listener).toHaveBeenCalledWith({ type: 'event-stream-ready' }); expect(r.timers).toHaveBeenCalledTimes(2);
    unsubscribe(); expect(connection.close).toHaveBeenCalledTimes(1); expect(r.runtimeUnsubscribe).toHaveBeenCalledTimes(1); expect(r.clearTimer).toHaveBeenCalled();
  });
  it('rejects drift, duplicate anchors or a second companion overlay instead of silently bypassing old SSE', () => {
    const r = companionEventsRig(null);
    expect(() => nativeCompanionEventsTransform(r.output)).toThrow('already applied');
    expect(() => nativeCompanionEventsTransform(r.source.replace('export const subscribeOpenchamberEvents =', 'export const renamedEvents ='))).toThrow('anchor');
    expect(() => nativeCompanionEventsTransform(r.source + '\nif (isVSCodeRuntime()) return () => undefined;')).toThrow('anchor');
  });
});

describe('actual original entry/composer overlays and runtime facade (syntax-only, not Source tsc)', () => {
  it.each(['desktop', 'mobile', 'mini'])('actual %s Source entry removes legacy bootstrap/relay/PWA/viewport imports', kind => {
    const filename = kind === 'desktop' ? 'main.tsx' : kind === 'mobile' ? 'mobile-main.tsx' : 'mini-chat-main.tsx';
    const source = readFileSync(resolve(ROOT, 'vendor/openchamber-frontend/packages/web/src/' + filename), 'utf8');
    const output = nativeOriginalEntryTransform(source, kind);
    expect(output).not.toContain('createConfiguredWebAPIs'); expect(output).not.toContain('runtimeConfig'); expect(output).not.toContain('registerSW'); expect(output).not.toContain('watchHostedSurfaceViewport');
    expect(() => nativeOriginalEntryTransform(output, kind)).toThrow('already applied');
    expect(() => nativeOriginalEntryTransform(source.replace('import { createConfiguredWebAPIs', 'import { driftedWebAPIs'), kind)).toThrow('anchor');
    if (kind !== 'mini') {
      expect(output).toContain('window.fetch.bind(window)'); expect(output).toContain('loadRenderer: () => import');
      const window: Record<string, any> = { fetch: vi.fn(), matchMedia: () => ({ matches: true }), location: { origin: 'http://127.0.0.1:7777' }, addEventListener: vi.fn(), __OPENCHAMBER_API_BASE_URL__: 'https://old.invalid', __OPENCHAMBER_CLIENT_TOKEN__: 'fixture-leftover', __OPENCHAMBER_RUNTIME_HEADERS__: { 'x-old': 'fixture-leftover' }, __OPENCHAMBER_RELAY_HOST_ID__: 'old' };
      const start = vi.fn(options => {
        expect(options.surface).toBe('mobile'); expect(window.__OPENCHAMBER_SURFACE__).toBe('mobile');
        expect(window.__OPENCHAMBER_API_BASE_URL__).toBe(window.location.origin); expect(window.__OPENCHAMBER_LOCAL_ORIGIN__).toBe(window.location.origin);
        for (const key of ['__OPENCHAMBER_CLIENT_TOKEN__','__OPENCHAMBER_RUNTIME_HEADERS__','__OPENCHAMBER_RELAY_HOST_ID__']) expect(window[key]).toBeUndefined();
        return { dispose: vi.fn() };
      });
      const requireModule = vi.fn(name => { if (name === '@pi-native/original-startup') return { startOriginalNativeSurface: start }; throw new Error('Original modules may not import before native startup'); });
      const code = ts.transpileModule(output, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
      runInNewContext(code, { exports: {}, window, document: { getElementById: () => ({}) }, require: requireModule });
      expect(start).toHaveBeenCalledTimes(1); expect(requireModule).toHaveBeenCalledTimes(1);
    } else expect(output).not.toContain('import');
  });
  it('native composer wrapper never executes original destructive hooks; null host preserves literal original component', () => {
    const original = readFileSync(resolve(ROOT, 'vendor/openchamber-frontend/packages/ui/src/components/chat/ChatInput.tsx'), 'utf8');
    const transformed = nativeReadOnlyComposerTransform(original); expect(transformed).toContain(': <ChatInputComponent {...props} />'); expect(transformed).toContain('piGetNativeHost()');
    expect(() => nativeReadOnlyComposerTransform(transformed)).toThrow('already applied'); expect(() => nativeReadOnlyComposerTransform(original.replace('export const ChatInput = React.memo(ChatInputComponent);', 'export const drift = 1;'))).toThrow('anchor');
    const parsed = ts.transpileModule(transformed, { fileName: 'ChatInput.tsx', reportDiagnostics: true, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext } }); expect(parsed.diagnostics ?? []).toHaveLength(0);
  });
  it('actual facade forwards only settings.load; all unbound APIs reject without calling their factories', async () => {
    const exports: Record<string, any> = {}; runInNewContext(compile('tools/ui-oc-native-runtime-apis.ts'), { exports, Proxy, Reflect, Error });
    const command = vi.fn(async () => 'should-never-run'); const original = { settings: { load: vi.fn(async () => ({ settings: {} })), save: command, restartOpenCode: command }, terminal: { attach: command }, git: { status: command }, files: { listDirectory: command }, permissions: { approve: command }, notifications: { canNotify: command, notifyAgentCompletion: command }, tools: { list: command }, github: { status: command }, push: { enable: command } };
    const apis = exports.sealOriginalRuntimeAPIs(original); expect(await apis.settings.load()).toEqual({ settings: {} }); expect(original.settings.load).toHaveBeenCalledTimes(1);
    expect(() => apis.terminal.attach()).toThrow('尚未接入');
    for (const run of [() => apis.settings.save({}), () => apis.git.status(), () => apis.files.listDirectory('/'), () => apis.permissions.approve(), () => apis.notifications.notifyAgentCompletion(), () => apis.tools.list()]) await expect(run()).rejects.toThrow('尚未接入');
    expect(command).not.toHaveBeenCalled(); expect(apis.notifications.canNotify()).toBe(false); expect(apis.settings.restartOpenCode).toBeUndefined(); expect(apis.git.unknown).toBeUndefined();
    for (const key of ['github','linear','push','diagnostics','clientAuth','editor','vscode','worktrees']) expect(apis[key]).toBeUndefined(); expect(apis.runtime).toMatchObject({ platform: 'web', isDesktop: false, isVSCode: false, label: 'pi-native' });
  });
});
