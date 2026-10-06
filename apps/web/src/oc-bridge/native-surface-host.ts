import { authenticatedAttachmentUploader } from "../ws/conversation-state";
import type { WebSocketFactory, WebSocketLike } from "../ws/ws-client";
import { NativePiPort } from "./native-pi-port";
import { getNativeSdkFetch, installNativeSdkFetch, type NativeFetchTarget } from "./native-sdk-fetch";

export interface NativeSurfaceTarget extends NativeFetchTarget {
  readonly location: { readonly origin: string };
  WebSocket?: typeof WebSocket;
  EventSource?: typeof EventSource;
}
export interface NativeSurfaceHost {
  readonly port: NativePiPort;
  /** Explicit reconnect retains the same owner and SDK read seam. */
  reconnect(): void;
  dispose(): void;
}
export interface NativeSurfaceOptions {
  readonly target: NativeSurfaceTarget;
  readonly token: string;
  /** Captured BEFORE importing any original runtime/App module. */
  readonly capturedNetworkFetch: typeof fetch;
  /** Tests may inject sockets. In browser use the pre-Source constructor. */
  readonly createSocket?: WebSocketFactory;
  readonly signal?: AbortSignal;
}
const hosts = new WeakMap<NativeSurfaceTarget, NativeSurfaceHost | "authenticating">();
export function getNativeSurfaceHost(target?: NativeSurfaceTarget): NativeSurfaceHost | null {
  const scope = target ?? (typeof window === "undefined" ? undefined : window);
  const value = scope ? hosts.get(scope) : undefined;
  return value && value !== "authenticating" ? value : null;
}
const abortIfNeeded = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
};

/** Adapt actual DOM event signatures instead of asserting a DOM socket to the
 * narrower client interface. Methods retain native this; assigned callbacks
 * see only fields consumed by the existing clients. No constructor recapture.
 */
function browserSocketFactory(Ctor: typeof WebSocket): WebSocketFactory {
  return (url) => {
    const socket = new Ctor(url);
    let onopen: WebSocketLike["onopen"] = null;
    let onmessage: WebSocketLike["onmessage"] = null;
    let onclose: WebSocketLike["onclose"] = null;
    let onerror: WebSocketLike["onerror"] = null;
    return {
      get readyState() { return socket.readyState; },
      send(data) { socket.send(data); },
      close(code) { socket.close(code); },
      get onopen() { return onopen; },
      set onopen(value) { onopen = value; socket.onopen = value ? () => value() : null; },
      get onmessage() { return onmessage; },
      set onmessage(value) { onmessage = value; socket.onmessage = value ? (event) => value({ data: event.data }) : null; },
      get onclose() { return onclose; },
      set onclose(value) { onclose = value; socket.onclose = value ? (event) => value({ code: event.code }) : null; },
      get onerror() { return onerror; },
      set onerror(value) { onerror = value; socket.onerror = value ? () => value() : null; },
    };
  };
}

/** Authenticate before constructing owner/SDK/sockets. No Source runtime
 * restore, remote URL, source credentials, implicit retry or token in facts.
 * Failed initial auth permits explicit retry; a mounted/closed owner cannot be
 * silently replaced in the same scope. Source modules load only after return.
 */
export async function createNativeSurfaceHost(options: NativeSurfaceOptions): Promise<NativeSurfaceHost> {
  const { target, token, capturedNetworkFetch, signal } = options;
  if (!token || token.trim() !== token || typeof capturedNetworkFetch !== "function") throw new Error("原生登录参数无效。");
  if (hosts.has(target) || getNativeSdkFetch(target)) throw new Error("原生界面已启动；不可替换状态所有者。");
  let base: URL;
  try { base = new URL(target.location.origin); } catch { throw new Error("原生界面地址无效。"); }
  if (!['http:', 'https:'].includes(base.protocol) || base.origin !== target.location.origin || base.username || base.password || base.search || base.hash) throw new Error("原生界面仅支持本站地址。");
  const wsURL = `${base.protocol === 'https:' ? 'wss:' : 'ws:'}//${base.host}/`;
  const OriginalWebSocket = target.WebSocket;
  const createSocket = options.createSocket ?? (OriginalWebSocket ? browserSocketFactory(OriginalWebSocket) : null);
  if (!createSocket) throw new Error("原生连接不可用。");
  abortIfNeeded(signal);
  hosts.set(target, "authenticating");
  try {
    let reply: Response;
    try {
      reply = await capturedNetworkFetch(new URL('/login', base), {
        method: 'POST', credentials: 'same-origin', redirect: 'error',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
        ...(signal ? { signal } : {}),
      });
    } catch {
      abortIfNeeded(signal);
      // Do not echo arbitrary transport errors, auth bodies or credentials.
      throw new Error("原生登录未确认；未启动界面连接。");
    }
    abortIfNeeded(signal);
    if (!reply.ok || reply.redirected) throw new Error("原生登录失败；未启动界面连接。");
    if (target.location.origin !== base.origin) throw new Error("界面地址已变更；未启动连接。");
    if (getNativeSdkFetch(target)) throw new Error("登录期间读取接缝被替换；未启动连接。");
    let closed = false;
    const upload = authenticatedAttachmentUploader(() => closed ? null : token, capturedNetworkFetch);
    const port = new NativePiPort(wsURL, token, { createSocket, upload });
    let sdk: ReturnType<typeof installNativeSdkFetch>;
    try { sdk = installNativeSdkFetch(target, port, base.origin, capturedNetworkFetch); }
    catch {
      port.dispose();
      throw new Error("原生读取接缝未安装；未启动连接。");
    }
    const host: NativeSurfaceHost = {
      port,
      reconnect() { if (!closed) port.reconnect(); },
      dispose() {
        if (closed) return;
        closed = true;
        sdk.dispose();
        port.dispose();
        // Keep registry/SDK/global guards closed, never restore legacy paths.
      },
    };
    hosts.set(target, host);
    // Native transports captured their constructor above. Original terminal,
    // relay and direct SSE code cannot open an unreviewed second connection.
    try {
      if (target.WebSocket) {
        // SAFETY: deny-only facade, construction always throws; native clients use the captured constructor. Only constants remain readable.
        target.WebSocket = class {
          static readonly CONNECTING = 0; static readonly OPEN = 1;
          static readonly CLOSING = 2; static readonly CLOSED = 3;
          constructor() { throw new Error("旧后台连接未接入；请使用原生pi操作。"); }
        } as unknown as typeof WebSocket;
      }
      if (target.EventSource) {
        // SAFETY: deny-only facade, construction always throws; SDK SSE uses guarded fetch, never this constructor. Constants remain readable.
        target.EventSource = class {
          static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSED = 2;
          constructor() { throw new Error("旧后台事件连接未接入。"); }
        } as unknown as typeof EventSource;
      }
      port.connect();
    } catch {
      host.dispose();
      throw new Error("原生界面启动失败；连接已关闭。");
    }
    return host;
  } catch (error) {
    // Mounted/closed bindings are deliberately retained; initial auth failures
    // alone have no owner or global effects and permit a user-directed retry.
    if (hosts.get(target) === "authenticating") hosts.delete(target);
    throw error;
  }
}
