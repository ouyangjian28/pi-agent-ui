import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { createNativeSurfaceHost, getNativeSurfaceHost, type NativeSurfaceHost, type NativeSurfaceTarget } from "../../../apps/web/src/oc-bridge/native-surface-host";
import { installNativeSdkFetch, getNativeSdkFetch } from "../../../apps/web/src/oc-bridge/native-sdk-fetch";
import { NativePiPort } from "../../../apps/web/src/oc-bridge/native-pi-port";
import type { WebSocketLike } from "../../../apps/web/src/ws/ws-client";
class Socket implements WebSocketLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: { readonly code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Record<string, unknown>[] = [];
  closed = 0;
  send(data: string) { this.sent.push(JSON.parse(data) as Record<string, unknown>); }
  close(code = 1000) { this.closed++; this.readyState = 3; this.onclose?.({ code }); }
  welcome() { this.readyState = 1; this.onopen?.(); this.onmessage?.({ data: JSON.stringify({ t: 'welcome', protocolVersion: 1, serverBootId: 'test', serverBuildId: 'test' }) }); }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const hosts: NativeSurfaceHost[] = [];
afterEach(() => { for (const host of hosts.splice(0)) host.dispose(); vi.unstubAllGlobals(); });
function rig() {
  const sockets: Socket[] = [];
  const OriginalWebSocket = class extends Socket { constructor(_url: string) { super(); sockets.push(this); } };
  const OriginalEventSource = vi.fn();
  const network = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
  const target: NativeSurfaceTarget = { fetch: network, location: { origin: 'http://127.0.0.1:7777' }, WebSocket: OriginalWebSocket as unknown as typeof WebSocket, EventSource: OriginalEventSource as unknown as typeof EventSource };
  const start = async (signal?: AbortSignal) => {
    const host = await createNativeSurfaceHost({ target, token: 'fixture-host-only', capturedNetworkFetch: network, ...(signal ? { signal } : {}) }); hosts.push(host); return host;
  };
  return { sockets, network, target, start, OriginalWebSocket, OriginalEventSource };
}

describe('Native surface lifecycle, actual owner/clients with controlled HTTP (not original App mount)', () => {
  it('creates no owner, SDK or sockets before login confirms, and ignores no original runtime bootstrap', async () => {
    const r = rig(), login = deferred<Response>(); r.network.mockImplementationOnce(() => login.promise);
    expect(getNativeSurfaceHost(r.target)).toBeNull(); const pending = r.start();
    expect(getNativeSurfaceHost(r.target)).toBeNull(); expect(getNativeSdkFetch(r.target)).toBeNull(); expect(r.sockets).toHaveLength(0); expect(r.target.WebSocket).toBe(r.OriginalWebSocket);
    expect(String(r.network.mock.calls[0]![0])).toBe('http://127.0.0.1:7777/login');
    expect(r.network.mock.calls[0]![1]).toMatchObject({ method: 'POST', credentials: 'same-origin', redirect: 'error', body: JSON.stringify({ token: 'fixture-host-only' }) });
    login.resolve(new Response(null, { status: 200 })); const host = await pending;
    expect(getNativeSurfaceHost(r.target)).toBe(host); expect(r.sockets).toHaveLength(3);
    for (const socket of r.sockets) socket.welcome(); expect(JSON.stringify(host.port.getSnapshot())).not.toContain('fixture-host-only');
    expect(r.sockets.flatMap(s => s.sent).filter(f => ['prompt', 'resume', 'stop'].includes(String(f.t)))).toEqual([]);
  });
  it('failed auth has no global/owner/socket effects, reads no response body, and permits explicit retry', async () => {
    const r = rig(), body = vi.fn(); const bad = new Response('private fixture error body', { status: 401 }); Object.defineProperty(bad, 'text', { value: body }); r.network.mockResolvedValueOnce(bad);
    await expect(r.start()).rejects.toThrow('原生登录失败'); expect(body).not.toHaveBeenCalled(); expect(r.sockets).toEqual([]); expect(r.target.fetch).toBe(r.network); expect(getNativeSdkFetch(r.target)).toBeNull();
    expect((await r.start()).port).toBeDefined(); expect(r.network).toHaveBeenCalledTimes(2);
  });
  it('does not echo transport exceptions, arbitrary response text, or credentials', async () => {
    const r = rig(); r.network.mockRejectedValueOnce(new Error('fixture-host-only private-url-details'));
    await expect(r.start()).rejects.toThrow('原生登录未确认；未启动界面连接。'); expect(r.sockets).toHaveLength(0); expect(getNativeSurfaceHost(r.target)).toBeNull();
  });
  it('refuses redirected auth, even when a controlled response says ok', async () => {
    const r = rig(); const reply = new Response(null); Object.defineProperty(reply, 'redirected', { value: true }); r.network.mockResolvedValueOnce(reply);
    await expect(r.start()).rejects.toThrow('原生登录失败'); expect(r.sockets).toHaveLength(0); expect(getNativeSdkFetch(r.target)).toBeNull();
  });
  it('already aborted login does not send HTTP, sockets or change globals', async () => {
    const r = rig(), abort = new AbortController(); abort.abort(); await expect(r.start(abort.signal)).rejects.toMatchObject({ name: 'AbortError' }); expect(r.network).not.toHaveBeenCalled(); expect(r.target.fetch).toBe(r.network);
  });
  it('abort while auth is pending rejects late success without constructing a root', async () => {
    const r = rig(), login = deferred<Response>(), abort = new AbortController(); r.network.mockImplementationOnce(() => login.promise);
    const pending = r.start(abort.signal); abort.abort(); login.resolve(new Response(null)); await expect(pending).rejects.toMatchObject({ name: 'AbortError' }); expect(r.sockets).toHaveLength(0); expect(getNativeSurfaceHost(r.target)).toBeNull();
  });
  it('invalid origin or login parameters cannot become a credential destination', async () => {
    const r = rig();
    for (const origin of ['file:///tmp/x', 'http://user:fixture@127.0.0.1:7777', 'http://127.0.0.1:7777/?a=x', 'broken']) {
      const target = { ...r.target, location: { origin } }; await expect(createNativeSurfaceHost({ target, token: 'fixture-only', capturedNetworkFetch: r.network })).rejects.toThrow();
    }
    await expect(createNativeSurfaceHost({ target: r.target, token: ' ', capturedNetworkFetch: r.network })).rejects.toThrow('参数无效'); expect(r.network).not.toHaveBeenCalled(); expect(r.sockets).toHaveLength(0);
  });
  it('origin change while pending is not adopted as a new native socket/SDK address', async () => {
    const r = rig(), login = deferred<Response>(); r.network.mockImplementationOnce(() => login.promise);
    const pending = r.start(); Object.defineProperty(r.target, 'location', { value: { origin: 'https://changed.invalid' } }); login.resolve(new Response(null)); await expect(pending).rejects.toThrow('地址已变更'); expect(r.sockets).toHaveLength(0); expect(getNativeSdkFetch(r.target)).toBeNull();
  });
  it('reserves startup across pending auth, refuses duplicate mounted/closed roots, never auto relogs', async () => {
    const r = rig(), login = deferred<Response>(); r.network.mockImplementationOnce(() => login.promise); const pending = r.start();
    await expect(r.start()).rejects.toThrow('不可替换'); expect(r.network).toHaveBeenCalledTimes(1); login.resolve(new Response(null)); const host = await pending;
    await expect(r.start()).rejects.toThrow('不可替换'); host.dispose(); await expect(r.start()).rejects.toThrow('不可替换'); expect(r.network).toHaveBeenCalledTimes(1);
  });
  it('source global Socket/SSE constructors are closed while captured native sockets still connect', async () => {
    const r = rig(), host = await r.start(); expect(r.sockets).toHaveLength(3);
    expect(() => new r.target.WebSocket!('wss://old.invalid')).toThrow('旧后台连接'); expect(() => new r.target.EventSource!('https://old.invalid')).toThrow('旧后台事件'); expect(r.OriginalEventSource).not.toHaveBeenCalled();
    const owner = host.port.owner, sdk = getNativeSdkFetch(r.target); const id = host.port.createDraft('owned.jsonl')!; owner.edit(id, 'keep me'); host.reconnect(); expect(r.sockets).toHaveLength(6);
    expect(host.port.owner).toBe(owner); expect(getNativeSdkFetch(r.target)).toBe(sdk); expect(owner.getSnapshot().drafts.get(id)?.text).toBe('keep me'); expect(r.network).toHaveBeenCalledTimes(1);
  });
  it('native attachment auth/upload uses captured HTTP despite the SDK global write gate', async () => {
    const r = rig(), host = await r.start(); for (const socket of r.sockets) socket.welcome();
    const item = { id: 'a'.repeat(32), name: 'code.ts', kind: 'text', mimeType: 'text/plain', size: 3, sha256: 'b'.repeat(64) };
    r.network.mockImplementation(async input => String(input).endsWith('/login') ? new Response(null) : new Response(JSON.stringify({ ok: true, attachment: item }), { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', r.target.fetch);
    expect((await r.target.fetch('/api/attachments', { method: 'POST' })).status).toBe(501); expect(r.network).toHaveBeenCalledTimes(1);
    const id = host.port.createDraft('owned.jsonl')!; host.port.owner.edit(id, 'text'); await host.port.owner.upload(id, [new File(['abc'], 'code.ts', { type: 'text/plain' })]);
    expect(host.port.owner.getSnapshot().drafts.get(id)).toMatchObject({ text: 'text', attachments: [item], uploadError: null }); expect(r.network.mock.calls.map(call => String(call[0]))).toEqual(['http://127.0.0.1:7777/login', '/login', '/api/attachments']);
  });
  it('dispose closes all sockets and SDK paths without restoring legacy globals or clearing another root', async () => {
    const r = rig(), host = await r.start(), sdk = getNativeSdkFetch(r.target)!; const other = rig(), otherHost = await other.start(); const guardedSocket = r.target.WebSocket;
    host.dispose(); host.dispose(); expect(r.sockets.every(s => s.closed === 1)).toBe(true); expect((await sdk('/health')).status).toBe(503); expect(r.target.WebSocket).toBe(guardedSocket); expect(getNativeSurfaceHost(other.target)).toBe(otherHost); expect(other.sockets.every(s => s.closed === 0)).toBe(true);
    host.reconnect(); expect(r.sockets).toHaveLength(3); expect(r.network).toHaveBeenCalledTimes(1);
  });
  it('nonwritable fetch refuses SDK install, leaks no connected owner and leaves the seam unbound', async () => {
    const r = rig(); Object.defineProperty(r.target, 'fetch', { writable: false }); await expect(r.start()).rejects.toThrow('读取接缝未安装'); expect(getNativeSdkFetch(r.target)).toBeNull(); expect(getNativeSurfaceHost(r.target)).toBeNull(); expect(r.sockets).toHaveLength(0);
  });
  it('native client constructor failure stays unready with the same owner, not legacy fallback or implicit retry', async () => {
    const r = rig(), attempts = vi.fn(); r.target.WebSocket = class { constructor() { attempts(); throw new Error('controlled fixture failure'); } } as unknown as typeof WebSocket;
    const host = await r.start(); expect(host.port.getSnapshot().write.connState).toBe('error'); expect((await r.target.fetch('/health')).status).toBe(503);
    expect(attempts).toHaveBeenCalledTimes(3); expect(r.network).toHaveBeenCalledTimes(1); await expect(r.start()).rejects.toThrow('不可替换');
    const owner = host.port.owner; host.reconnect(); expect(attempts).toHaveBeenCalledTimes(6); expect(host.port.owner).toBe(owner); expect(r.network).toHaveBeenCalledTimes(1);
  });
  it('pre-existing SDK owner cannot be adopted or replaced by a new authenticated surface', async () => {
    const r = rig(), port = new NativePiPort('ws://127.0.0.1:7777', 'local-only'); const sdk = installNativeSdkFetch(r.target, port, r.target.location.origin, r.network);
    try { await expect(r.start()).rejects.toThrow('不可替换'); expect(r.network).not.toHaveBeenCalled(); } finally { sdk.dispose(); port.dispose(); }
  });
  it('adapts real DOM-style Socket events against owned loopback HTTP/WS, without the injected socket shortcut', async () => {
    const server = createServer((request, response) => { response.writeHead(request.url === '/login' && request.method === 'POST' ? 200 : 404); response.end(); });
    const websocket = new WebSocketServer({ server }); const frameTypes: string[] = [];
    websocket.on('connection', client => client.on('message', bytes => {
      const frame = JSON.parse(bytes.toString()) as { t: string; requestId?: string }; frameTypes.push(frame.t);
      if (frame.t === 'hello') client.send(JSON.stringify({ t: 'welcome', protocolVersion: 1, serverBootId: 'loopback', serverBuildId: 'loopback' }));
      if (frame.t === 'get-models') client.send(JSON.stringify({ t: 'models-list', requestId: frame.requestId, models: [] }));
    }));
    let host: NativeSurfaceHost | null = null;
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Loopback fixture address unavailable');
      const target: NativeSurfaceTarget = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket, location: { origin: `http://127.0.0.1:${address.port}` } };
      host = await createNativeSurfaceHost({ target, token: 'local-dom-event-fixture-only', capturedNetworkFetch: globalThis.fetch.bind(globalThis) }); hosts.push(host);
      const port = host.port;
      await expect.poll(() => [port.getSnapshot().list.state, port.getSnapshot().write.connState, port.getSnapshot().detail.connState]).toEqual(['ready', 'ready', 'ready']);
      await expect.poll(() => port.getSnapshot().list.models.status).toBe('ok');
      expect(websocket.clients.size).toBe(3); expect(frameTypes.filter(t => t === 'hello')).toHaveLength(3); expect(frameTypes.filter(t => ['prompt', 'resume', 'stop'].includes(t))).toEqual([]);
      expect((await target.fetch('/auth/session')).status).toBe(200); expect(JSON.stringify(port.getSnapshot())).not.toContain('local-dom-event-fixture-only');
      expect(() => new target.WebSocket!(target.location.origin)).toThrow('旧后台连接');
    } finally {
      host?.dispose(); for (const client of websocket.clients) client.terminate();
      await new Promise<void>(resolve => websocket.close(() => resolve())); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
  it('HTTP login alone is not reported as ready native authentication/catalogue', async () => {
    const r = rig(), host = await r.start(); expect(host.port.getSnapshot().write.connState).not.toBe('ready'); expect((await r.target.fetch('/auth/session')).status).toBe(503); expect(host.port.getSnapshot().list.models.status).toBe('idle'); expect(host.port.getSnapshot().conversation.view.kind).toBe('list');
  });
});
