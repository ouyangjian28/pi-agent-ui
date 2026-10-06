// @vitest-environment jsdom
// Controlled native clients/owner only; NOT mounted original CodeMirror or a
// physical IME/browser/provider acceptance. Sixteen fixed adapter contracts.
import { afterEach, describe, expect, it } from 'vitest';
import { NativePiPort, type NativePiPortOptions } from '../../../apps/web/src/oc-bridge/native-pi-port';
import { NativeComposerInput } from '../../../apps/web/src/oc-bridge/native-composer-input';
import type { WebSocketLike } from '../../../apps/web/src/ws/ws-client';
class Socket implements WebSocketLike {
  readyState = 0; sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null; onmessage: ((e: { readonly data: unknown }) => void) | null = null;
  onclose: ((e: { readonly code: number }) => void) | null = null; onerror: (() => void) | null = null;
  send(data: string) { this.sent.push(JSON.parse(data) as Record<string, unknown>); }
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
  receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  welcome() { this.readyState = 1; this.onopen?.(); this.receive({ t: 'welcome', protocolVersion: 1, serverBootId: 'fixture', serverBuildId: 'fixture' }); }
}
const ports: NativePiPort[] = [];
afterEach(() => { for (const p of ports.splice(0)) p.dispose(); });
function rig(options: NativePiPortOptions = {}) {
  const sockets: Socket[] = [];
  const port = new NativePiPort('ws://127.0.0.1/ws', 'fixture-only', { ...options, createSocket: () => { const s = new Socket(); sockets.push(s); return s; } });
  ports.push(port); port.connect(); sockets.forEach(s => s.welcome());
  const list = sockets[0]!;
  list.receive({ t: 'models-list', requestId: list.sent.find(f => f.t === 'get-models')!.requestId, models: [{ provider: 'fixture', id: 'low', thinkingLevels: ['off', 'low'] }, { provider: 'fixture', id: 'high', thinkingLevels: ['off', 'high'] }] });
  const id = port.createDraft('input.jsonl')!; const input = new NativeComposerInput(port, id);
  const frames = () => sockets.flatMap(s => s.sent).filter(f => f.t === 'prompt');
  const ack = (outcome: unknown = { kind: 'launched', intentId: 'fixture-intent', commandId: 1 }) => {
    const frame = frames().at(-1)!;
    sockets[1]!.receive({ t: 'write-ack', requestId: frame.requestId, file: frame.file, outcome });
  };
  return { port, sockets, id, input, frames, ack };
}
const enter = { key: 'Enter', shiftKey: false } as const;
describe('NativeComposerInput sole-owner event adapter (not UI acceptance)', () => {
  it('has no shadow text and preserves raw Unicode, spaces and newlines in the native owner', () => {
    const r = rig(); const raw = '  中文 e\u0301 😀\nconst x = "@literal";\n';
    expect(r.input.change(raw)).toBe(true); expect(r.input.slot).toBe(r.port.getSnapshot().conversation.drafts.get(r.id));
    expect(r.input.slot?.text).toBe(raw); r.port.owner.edit(r.id, 'external owner edit'); expect(r.input.slot?.text).toBe('external owner edit'); expect(r.frames()).toHaveLength(0);
  });
  it('resolves existing warm editor by native id rather than filename and never reconfigures during construction', () => {
    const r = rig(); const id = r.port.openSession('existing.jsonl')!; r.port.owner.edit(id, 'warm');
    const before = r.port.getSnapshot().conversation.sessions.get(id); const input = new NativeComposerInput(r.port, id);
    expect(input.slot).toBe(before); expect(input.slot).toMatchObject({ id, file: 'existing.jsonl', isNew: false, text: 'warm' }); expect(r.frames()).toHaveLength(0);
  });
  it('refuses stale edits, composition and Enter after the active target changes', async () => {
    const r = rig(); r.input.change('A'); const b = r.port.openSession('b.jsonl')!; r.port.owner.edit(b, 'B');
    expect(r.input.slot).toBeNull(); expect(r.input.change('late')).toBe(false); expect(r.input.beginComposition()).toBe(false); expect(r.input.endComposition('late IME')).toBe(false);
    expect(r.input.keyAction(enter)).toBe('editor'); expect(await r.input.send()).toMatchObject({ status: 'local' });
    expect(r.port.getSnapshot().conversation.drafts.get(r.id)?.text).toBe('A'); expect(r.port.getSnapshot().conversation.sessions.get(b)?.text).toBe('B'); expect(r.frames()).toHaveLength(0);
  });
  it('Enter is an explicit send decision only, never an automatic request', () => {
    const r = rig(); r.input.change('hello'); expect(r.input.keyAction(enter)).toBe('send'); expect(r.frames()).toHaveLength(0); expect(r.input.slot?.text).toBe('hello');
  });
  it('Shift+Enter and non-Enter keys remain with the original editor', () => {
    const r = rig(); expect(r.input.keyAction({ ...enter, shiftKey: true })).toBe('editor'); expect(r.input.keyAction({ key: 'a', shiftKey: false })).toBe('editor'); expect(r.frames()).toHaveLength(0);
  });
  it('composition start touches the owner version and publishes an already-set transient flag', () => {
    const r = rig(); r.input.change('draft'); const before = r.input.slot!; let observed = false;
    const stop = r.port.subscribe(() => { observed = r.input.composing; });
    expect(r.input.beginComposition()).toBe(true); stop(); expect(observed).toBe(true);
    expect(r.input.slot?.version).toBe(before.version + 1); expect(r.input.slot?.text).toBe(before.text); expect(r.input.keyAction(enter)).toBe('editor'); expect(r.frames()).toHaveLength(0);
  });
  it('native keyboard isComposing blocks submit without mutating draft facts', () => {
    const r = rig(); const before = r.input.slot; expect(r.input.keyAction({ ...enter, isComposing: true })).toBe('editor'); expect(r.input.slot).toBe(before); expect(r.frames()).toHaveLength(0);
  });
  it('legacy IME key229 blocks submit without fabricating composition or draft changes', () => {
    const r = rig(); const before = r.input.slot; expect(r.input.keyAction({ ...enter, keyCode: 229 })).toBe('editor'); expect(r.input.composing).toBe(false); expect(r.input.slot).toBe(before); expect(r.frames()).toHaveLength(0);
  });
  it('an explicit button send also refuses during composition and preserves bytes', async () => {
    const r = rig(); r.input.change('正在组字'); r.input.beginComposition(); expect(await r.input.send()).toMatchObject({ status: 'local', kind: 'local-invalid' }); expect(r.input.slot?.text).toBe('正在组字'); expect(r.frames()).toHaveLength(0);
  });
  it('composition end commits only the supplied flushed raw editor value with no normalisation', () => {
    const r = rig(); r.input.beginComposition(); const raw = '  已提交\n第二行😀\n'; expect(r.input.endComposition(raw)).toBe(true);
    expect(r.input.composing).toBe(false); expect(r.input.slot?.text).toBe(raw); expect(r.input.keyAction(enter)).toBe('send'); expect(r.frames()).toHaveLength(0);
  });
  it('composition version touch protects not-yet-flushed bytes from a late launched ACK', async () => {
    const r = rig(); r.input.change('first'); const pending = r.input.send(); r.input.beginComposition(); r.ack();
    expect((await pending).status).toBe('launched'); expect(r.input.slot?.text).toBe('first'); expect(r.input.composing).toBe(true);
    expect(r.input.endComposition('first中文')).toBe(true); expect(r.input.slot?.text).toBe('first中文'); expect(r.frames()).toHaveLength(1);
  });
  it('matching normal launched ACK clears through the native owner, never optimistically', async () => {
    const r = rig(); r.input.change('normal'); const pending = r.input.send(); expect(r.input.slot?.text).toBe('normal'); expect(r.frames()[0]).toMatchObject({ file: 'input.jsonl', text: 'normal' });
    r.ack(); expect(await pending).toMatchObject({ status: 'launched', outcome: { kind: 'launched' } }); expect(r.input.slot?.text).toBe('');
  });
  it('pending requests refuse duplicate sends while later owner edits survive receipt', async () => {
    const r = rig(); r.input.change('first'); const pending = r.input.send(); expect(await r.input.send()).toMatchObject({ status: 'local', kind: 'in-flight' }); r.input.change('next'); r.ack();
    expect((await pending).status).toBe('launched'); expect(r.input.slot?.text).toBe('next'); expect(r.frames()).toHaveLength(1);
  });
  it('unknown after explicit reconnect never auto-retries or loses draft bytes', async () => {
    const r = rig(); r.input.change('keep'); const pending = r.input.send(); r.port.reconnect(); r.sockets.forEach(s => { if (s.readyState === 0) s.welcome(); });
    expect((await pending).status).toBe('unknown'); expect(await r.input.send()).toMatchObject({ status: 'local' }); expect(r.input.slot?.text).toBe('keep'); expect(r.frames()).toHaveLength(1);
  });
  it('uploading blocks sends through the owner and preserves truthful upload failure', async () => {
    let fail!: (error: Error) => void;
    const r = rig({ upload: () => new Promise((_resolve, reject) => { fail = reject; }) }); r.input.change('keep');
    const pending = r.input.actions.upload([new File(['code'], 'fixture.ts', { type: 'text/plain' })]); expect(r.input.slot?.uploading).toBe(true);
    expect(await r.input.send()).toMatchObject({ status: 'local' }); expect(r.frames()).toHaveLength(0);
    fail(new Error('fixture upload failure')); await pending; expect(r.input.slot).toMatchObject({ text: 'keep', uploading: false, uploadError: 'fixture upload failure' });
  });
  it('unsupported model/effort remains a draft fact and actual rejected outcomes are not swallowed', async () => {
    const r = rig(); r.input.change('keep'); r.input.actions.chooseModelAndThinking('fixture', 'low', 'low'); r.input.actions.chooseModel('fixture', 'high');
    expect(await r.input.send()).toMatchObject({ status: 'local' }); expect(r.input.slot).toMatchObject({ text: 'keep', modelChoice: 'fixture/high', thinkingLevel: 'low' }); expect(r.frames()).toHaveLength(0);
    r.input.actions.chooseThinking(null); r.input.actions.setCustomModel('not valid model'); expect(await r.input.send()).toMatchObject({ status: 'local' }); expect(r.frames()).toHaveLength(0);
    r.input.actions.setCustomModel(''); const pending = r.input.send(); r.ack({ kind: 'busy' });
    expect(await pending).toEqual({ status: 'rejected', outcome: { kind: 'busy' } }); expect(r.input.slot?.text).toBe('keep'); expect(r.frames()).toHaveLength(1);
  });
});
