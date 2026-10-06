// @vitest-environment jsdom
// Fixed14: actual Source transform/parser/SSR and real React+NativePiPort
// binding with a REPLACEMENT editor, NOT mounted original CodeMirror/IME/UI proof.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nativeBoundComposerTransform as transform } from '../../../tools/ui-oc-native-composer-transform.mjs';
import { NativeSourceComposer, type NativeEditorProps } from '../../../apps/web/src/oc-bridge/native-source-composer';
import { NativePiPort, type NativePiPortOptions } from '../../../apps/web/src/oc-bridge/native-pi-port';
import { useNativeModelControls } from '../../../apps/web/src/oc-bridge/native-model-controls';
import type { NativeSurfaceHost } from '../../../apps/web/src/oc-bridge/native-surface-host';
import type { WebSocketLike } from '../../../apps/web/src/ws/ws-client';
import * as jsxRuntime from 'react/jsx-runtime';
// Vite rewrites new URL/import.meta.url as browser asset URLs under jsdom.
// These tests must read the literal on-disk Source, never that asset URL.
const sourceRoot = resolve('vendor/openchamber-frontend/packages/ui/src/components/chat');
const original = (path: string) => readFileSync(resolve(sourceRoot, path), 'utf8');
function compile(code: string) {
  const output = ts.transpileModule(code, { fileName: 'Source.tsx', reportDiagnostics: true, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } });
  expect(output.diagnostics?.filter(x => x.category === ts.DiagnosticCategory.Error)).toEqual([]); return output.outputText;
}
function sourceComponent(path: string, kind: 'footer' | 'actions', native: boolean) {
  const output = compile(transform(original(path), kind)); const module = { exports: {} as Record<string, React.ComponentType<Record<string, unknown>>> };
  const child = (name: string) => (props: Record<string, unknown>) => <span data-source-child={name}>{props.children as React.ReactNode}</span>;
  vm.runInNewContext(output, { exports: module.exports, module, require(name: string) {
    if (name === 'react') return React;
    if (name === 'react/jsx-runtime') return jsxRuntime;
    if (name === '@pi-native/surface-host') return { getNativeSurfaceHost: () => native ? {} : null };
    if (name === '@/lib/i18n') return { useI18n: () => ({ t: (key: string) => key }) };
    if (name === '@/lib/utils') return { cn: (...args: unknown[]) => args.filter(x => typeof x === 'string').join(' ') };
    return new Proxy({}, { get: (_, key) => child(String(key)) });
  } });
  return module.exports[kind === 'footer' ? 'ComposerFooter' : 'ComposerActionButtons']!;
}
class Socket implements WebSocketLike {
  readyState = 0; sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null; onmessage: ((e: { readonly data: unknown }) => void) | null = null;
  onclose: ((e: { readonly code: number }) => void) | null = null; onerror: (() => void) | null = null;
  send(data: string) { this.sent.push(JSON.parse(data) as Record<string, unknown>); }
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
  receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  welcome() { this.readyState = 1; this.onopen?.(); this.receive({ t: 'welcome', protocolVersion: 1, serverBootId: 'fixture', serverBuildId: 'fixture' }); }
}
const cleanups: (() => void)[] = [];
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.useRealTimers(); });
function rig(options: NativePiPortOptions = {}) {
  const sockets: Socket[] = [];
  const port = new NativePiPort('ws://127.0.0.1/ws', 'fixture-only', { ...options, createSocket: () => { const socket = new Socket(); sockets.push(socket); return socket; } });
  port.connect(); sockets.forEach(socket => socket.welcome());
  const list = sockets[0]!; list.receive({ t: 'models-list', requestId: list.sent.find(x => x.t === 'get-models')!.requestId, models: [{ provider: 'fixture', id: 'low', thinkingLevels: ['off', 'low'] }] });
  const id = port.createDraft('input.jsonl')!;
  const host: NativeSurfaceHost = { port, reconnect: () => port.reconnect(), dispose: () => port.dispose() };
  const container = document.createElement('div'); document.body.append(container); const root: Root = createRoot(container);
  let editorProps!: NativeEditorProps; let footerProps!: Record<string, unknown>; let modelBinding: ReturnType<typeof useNativeModelControls>;
  let mounts = 0; let flushed = '';
  function Editor(props: NativeEditorProps) { React.useEffect(() => { mounts++; }, []); props.bindEditor({ getValue: () => flushed }); return <div data-editor-key={props.editorKey}>{props.value}</div>; }
  function Footer(props: Record<string, unknown>) { modelBinding = useNativeModelControls(); footerProps = props; return <button type="button" onClick={props.onPrimaryAction as () => void}>fixture-send</button>; }
  act(() => root.render(<NativeSourceComposer host={host} isMobile={false} renderEditor={props => { editorProps = props; return <Editor key={props.editorKey} {...props} />; }} renderFooter={props => <Footer {...props} />} renderModels={() => <span>fixture-models</span>} />));
  cleanups.push(() => { act(() => root.unmount()); port.dispose(); container.remove(); });
  const frames = () => sockets.flatMap(socket => socket.sent).filter(x => x.t === 'prompt');
  const edit = (value: string) => { flushed = value; act(() => editorProps.onChange({ value })); };
  const send = () => act(() => { (footerProps.onPrimaryAction as () => void)(); });
  const ack = async () => { const frame = frames().at(-1)!; await act(async () => { sockets[1]!.receive({ t: 'write-ack', requestId: frame.requestId, file: frame.file, outcome: { kind: 'launched', intentId: 'fixture-intent', commandId: 1 } }); }); };
  return { port, sockets, id, container, frames, edit, send, ack, get editor() { return editorProps; }, get footer() { return footerProps; }, get models() { return modelBinding; }, get mounts() { return mounts; }, flush(value: string) { flushed = value; } };
}
describe('Original composer native binding (bounded replacement-editor proof)', () => {
  it('parses actual input overlay and preserves the entire legacy component body only in unbound branch', () => {
    const source = original('ChatInput.tsx'); const code = transform(source, 'input'); compile(code);
    const begin = source.indexOf('const ChatInputComponent:'); const end = source.indexOf('export const ChatInput = React.memo(ChatInputComponent);'); expect(begin).toBeGreaterThanOrEqual(0); expect(end).toBeGreaterThan(begin);
    expect(code).toContain(source.slice(begin, end));
    expect(code).toContain('if (!host) return <ChatInputComponent {...props} />'); expect(code).toContain('props.active === false'); expect(code).toContain('<ComposerEditor'); expect(code).toContain('<ComposerFooter'); expect(code).toContain('preserveDeferredEnterShift');
    const bound = code.slice(code.indexOf('const PiBoundChatInput'));
    expect(bound).toContain('placeholder="输入消息…"');
    expect(bound).not.toContain("placeholder={t('chat.chatInput.placeholder.chat')}");
  });
  it('actual Source footer parses and native SSR never mounts goals/dictation/old attachment menu, unbound still does', () => {
    for (const native of [false, true]) for (const mobile of [false, true]) {
      const Footer = sourceComponent('composer/ui/ComposerFooter.tsx', 'footer', native);
      const html = renderToStaticMarkup(<Footer isMobile={mobile} isBtw={false} canSend={false} />);
      expect(html.includes('data-source-child="SessionGoalButton"')).toBe(!native);
      expect(html.includes('data-source-child="SessionGoalObjectiveCounter"')).toBe(!native);
      expect(html.includes('data-source-child="ComposerAttachmentControls"')).toBe(!native);
      expect(html.includes('data-source-child="MemoComposerDictation"') || html.includes('data-source-child="ComposerDictation"') || html.includes('name="mic"')).toBe(!native && !mobile);
      if (mobile) expect(html.includes('chat.dictation.start')).toBe(!native);
      if (native) expect(html).toContain('chat.chatInput.actions.attachFiles');
    }
  });
  it('actual Source actions native SSR keeps stop but no unsupported queue, unbound keeps both', () => {
    for (const native of [false, true]) {
      const Actions = sourceComponent('composer/ui/ComposerActionButtons.tsx', 'actions', native);
      const html = renderToStaticMarkup(<Actions canAbort={true} hasContent={true} currentSessionId="input.jsonl" />);
      expect(html.includes('queueMessageAria')).toBe(!native); expect(html).toContain('stopGeneratingAria');
    }
  });
  it('all actual Source overlay kinds reject double apply and anchor drift', () => {
    for (const [path, kind] of [['ChatInput.tsx', 'input'], ['composer/ui/ComposerFooter.tsx', 'footer'], ['composer/ui/ComposerActionButtons.tsx', 'actions']] as const) {
      const source = original(path); expect(() => transform(transform(source, kind), kind)).toThrow('already applied'); expect(() => transform('', kind)).toThrow();
    }
  });
  it('build installs bound input and exactly two new Source targets, with compiler-only metadata', () => {
    const config = readFileSync(resolve('tools/ui-oc-native-vite.config.mjs'), 'utf8');
    expect(config).not.toContain('nativeReadOnlyComposerTransform'); expect(config.match(/\[path.join\(snapshot,/g)).toHaveLength(24);
    expect(config).toContain("nativeBoundComposerTransform(source, 'input')"); expect(config).toContain("nativeBoundComposerTransform(source, 'footer')"); expect(config).toContain("nativeBoundComposerTransform(source, 'actions')"); expect(config).toContain('nativeSourceComposerMounted: false'); expect(config).toContain('nativeSourceComposerReadOnly: false');
  });
  it('real React binding renders solely native raw bytes and reports edits without auto-send or model restore', () => {
    const r = rig(); const raw = '  中文 e\u0301 😀\n@literal /plain\n'; r.edit(raw);
    expect(r.container.querySelector('form')?.classList.contains('w-full')).toBe(true);
    expect(r.container.querySelector('[data-native-composer-column]')?.classList.contains('chat-input-column')).toBe(true);
    expect(r.editor.value).toBe(raw); expect(r.port.getSnapshot().conversation.drafts.get(r.id)?.text).toBe(raw); expect(r.frames()).toHaveLength(0);
    act(() => r.port.owner.edit(r.id, 'owner update')); expect(r.editor.value).toBe('owner update');
  });
  it('new-draft explicit send preserves bytes until matching ACK, then owner clears through transfer', async () => {
    const r = rig(); r.edit('new draft'); r.send(); expect(r.editor.value).toBe('new draft'); expect(r.frames()).toHaveLength(1); expect(r.frames()[0]).toMatchObject({ file: 'input.jsonl', text: 'new draft' });
    await r.ack(); expect(r.editor.value).toBe(''); expect(r.port.getSnapshot().conversation.view).toEqual({ kind: 'session', file: 'input.jsonl' });
  });
  it('same-file launched transfer preserves editor instance/key while late edits survive', async () => {
    const r = rig(); r.edit('first'); const key = r.editor.editorKey; const mounts = r.mounts; r.send(); r.edit('later'); await r.ack();
    expect(r.editor.value).toBe('later'); expect(r.editor.editorKey).toBe(key); expect(r.mounts).toBe(mounts); expect(r.port.getSnapshot().conversation.sessions.get('session:input.jsonl')?.text).toBe('later');
  });
  it('different-file navigation recreates the replacement editor and rejects stale captured events', () => {
    const r = rig(); r.edit('A'); const captured = r.editor; const key = captured.editorKey; const mounts = r.mounts;
    act(() => { const id = r.port.openSession('b.jsonl')!; r.port.owner.edit(id, 'B'); });
    expect(r.editor.editorKey).not.toBe(key); expect(r.mounts).toBe(mounts + 1); act(() => captured.onChange({ value: 'stale' })); expect(r.editor.value).toBe('B'); expect(r.frames()).toHaveLength(0);
  });
  it('composition touches version, blocks Enter229/button, survives transfer and bounded end flush without auto-send', async () => {
    vi.useFakeTimers(); const r = rig(); r.edit('first'); r.send(); const version = r.port.getSnapshot().conversation.drafts.get(r.id)!.version;
    const form = r.container.querySelector('form')!; act(() => form.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
    expect(r.port.getSnapshot().conversation.drafts.get(r.id)!.version).toBeGreaterThan(version); expect(r.footer.canSend).toBe(false);
    expect(r.editor.onKeyDown(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true }))).toBe(false);
    r.send(); expect(r.frames()).toHaveLength(1); await r.ack(); expect(r.editor.value).toBe('first');
    r.flush('first中文'); act(() => form.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))); expect(r.footer.canSend).toBe(false);
    act(() => vi.advanceTimersByTime(50)); expect(r.editor.value).toBe('first中文'); expect(r.frames()).toHaveLength(1);
    expect(r.editor.onKeyDown(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }))).toBe(false);
  });
  it('existing warm binding sends exact active file and blocks duplicate pending requests', async () => {
    const r = rig(); act(() => r.port.openSession('warm.jsonl')); r.edit('warm bytes'); r.send(); r.send(); expect(r.frames()).toHaveLength(1); expect(r.frames()[0]).toMatchObject({ file: 'warm.jsonl', text: 'warm bytes' }); expect(r.editor.value).toBe('warm bytes');
    await r.ack(); r.edit('next');
    const detail = r.sockets[2]!; const request = detail.sent.filter(x => x.t === 'subscribe').at(-1)!;
    const status = { session: { sessionId: 'fixture-session', file: 'warm.jsonl', adapterSessionId: null }, process: { phase: 'running', generation: 1, lastStartResult: null, lastStopResult: null, ready: true }, backgroundTasks: { availability: 'known', activeCount: null }, reap: { eligible: false, idleElapsedMs: null, idleRemainingMs: null, idleMs: 0 }, recovery: { availability: 'available', resumeBlocked: null, diskBlocked: null, unknownEffectCount: null, unattributableFragments: null, intentsCount: null, settledCount: null, evidenceHash: null }, serverTimeMs: 1730000000000 };
    act(() => detail.receive({ t: 'snapshot', requestId: request.requestId, subscriptionId: 'fixture-sub', streamId: 'fixture-stream', snapshotId: 'fixture-snapshot', barrier: 0, status: { ...status, turn: { state: 'idle' }, statusVersion: 1 }, page: [], historyNext: null, liveFrom: { streamId: 'fixture-stream', seq: 1 }, hasMore: false }));
    expect(r.port.getSnapshot().detail.status?.turn.state).toBe('idle'); expect(r.footer.canAbort).toBe(false);
    let version = 1;
    for (const state of ['dispatching', 'in-flight', 'settling', 'idle', 'closed']) {
      const turn = state === 'idle' ? { state } : state === 'closed' ? { state, reason: 'manual' } : { state, intentId: 'fixture-intent' };
      act(() => detail.receive({ t: 'status', subscriptionId: 'fixture-sub', status: { ...status, statusVersion: ++version, turn } }));
      expect(r.port.getSnapshot().detail.status?.turn.state).toBe(state); const busy = ['dispatching', 'in-flight', 'settling'].includes(state);
      expect(r.footer.canAbort).toBe(busy); expect(r.footer.canSend).toBe(!busy); expect(r.frames()).toHaveLength(1);
    }
  });
  it('model scope is actual owner-bound and custom invalid model remains visible without write', async () => {
    const r = rig(); r.edit('keep'); act(() => { expect(r.models?.actions.chooseModel('fixture', 'low')).toBe(true); expect(r.models?.actions.chooseThinking('low')).toBe(true); });
    expect(r.models?.selection).toMatchObject({ model: { providerId: 'fixture', modelId: 'low' }, variant: 'low' });
    const custom = r.container.querySelector<HTMLInputElement>('input[aria-label="自定义模型标识"]')!;
    act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(custom, 'bad model!'); custom.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(r.port.getSnapshot().conversation.drafts.get(r.id)?.freeText).toBe('bad model!'); r.send(); await act(async () => {}); expect(r.frames()).toHaveLength(0); expect(r.editor.value).toBe('keep'); expect(r.container.textContent).toContain('模型标识无效');
  });
  it('real owner upload pending disables send and sanitized failure keeps draft, never raw error', async () => {
    let fail!: (error: Error) => void; const r = rig({ upload: () => new Promise((_, reject) => { fail = reject; }) }); r.edit('keep');
    const file = r.container.querySelector('input[type=file]')!; Object.defineProperty(file, 'files', { configurable: true, value: [new File(['x'], 'a.ts', { type: 'text/plain' })] });
    act(() => file.dispatchEvent(new Event('change', { bubbles: true }))); expect(r.footer.canSend).toBe(false); r.send(); expect(r.frames()).toHaveLength(0);
    await act(async () => fail(new Error('private fixture raw error'))); expect(r.editor.value).toBe('keep'); expect(r.container.textContent).toContain('附件上传未完成'); expect(r.container.textContent).not.toContain('private fixture raw error');
  });
  it('unknown receipt never auto-resends and risk witness invalidates after draft version change', async () => {
    const r = rig(); r.edit('first'); r.send(); await act(async () => r.sockets[1]!.close()); expect(r.frames()).toHaveLength(1); expect(r.container.textContent).toContain('接受可能重复');
    act(() => { r.port.reconnect(); r.sockets.slice(3).forEach(socket => socket.welcome()); }); expect(r.frames()).toHaveLength(1); expect(r.footer.canSend).toBe(false);
    const checkbox = r.container.querySelector('input[type=checkbox]')!; act(() => checkbox.dispatchEvent(new MouseEvent('click', { bubbles: true }))); expect(r.footer.canSend).toBe(true);
    r.edit('changed'); expect(r.footer.canSend).toBe(false); expect((checkbox as HTMLInputElement).checked).toBe(false); expect(r.frames()).toHaveLength(1);
  });
});
