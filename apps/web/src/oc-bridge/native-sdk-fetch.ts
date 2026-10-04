import type { NativePiPort } from "./native-pi-port";
import { OcReadTransport } from "./oc-read-transport";
import { unavailable } from "./oc-read-projection";

type ReadPort = Pick<NativePiPort, "getSnapshot" | "subscribe">;
export interface NativeSdkInit extends RequestInit {
  query?: URLSearchParams | Record<string, unknown>;
}
export type NativeSdkFetch = (input: RequestInfo | URL, init?: NativeSdkInit) => Promise<Response>;
export interface NativeFetchTarget { fetch: typeof fetch }
export interface NativeSdkBinding {
  readonly fetch: NativeSdkFetch;
  dispose(): void;
}
const bindings = new WeakMap<NativeFetchTarget, NativeSdkBinding>();

/** Null keeps the unconnected source preview unchanged. Native bindings must be
 * installed before source runtime bootstrap. No token or owner mutation here. */
export function getNativeSdkFetch(target?: NativeFetchTarget): NativeSdkFetch | null {
  const scope = target ?? (typeof window === "undefined" ? undefined : window);
  return scope ? bindings.get(scope)?.fetch ?? null : null;
}

/** Bind SDK reads only; this NEVER installs an HTTP write adapter. The source
 * runtime overlay checks this before relay/legacy HTTP logic. Native login and
 * upload must use a fetch captured BEFORE any source runtime bridge or this
 * installation, not a legacy relay wrapper and not this seam. */
export function installNativeSdkFetch(target: NativeFetchTarget, port: ReadPort, baseURL: string, capturedNetworkFetch: typeof fetch): NativeSdkBinding {
  if (bindings.has(target)) throw new Error("pi SDK 读取接缝已安装；不可偷偷替换 owner 或复活已关闭界面。");
  if (typeof capturedNetworkFetch !== 'function') throw new Error("pi SDK 必须显式提供源运行时启动前捕获的网络读取函数。");
  let base: URL;
  try { base = new URL(baseURL); } catch { throw new Error("pi SDK 读取地址无效。"); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error("pi SDK 地址必须为无凭据、无查询参数的 HTTP(S) 地址。");
  }
  const transport = new OcReadTransport(port, base.href);
  let closed = false;
  let invokingCapturedFetch = false;
  const fetchNative: NativeSdkFetch = async (input, init) => {
    if (closed) return unavailable("pi SDK 界面已关闭。", 503);
    let url: URL;
    try { url = new URL(input instanceof Request ? input.url : String(input), base); }
    catch { return unavailable("读取地址无效。", 400); }
    if (url.origin !== base.origin || url.username || url.password || !['http:', 'https:'].includes(url.protocol)) {
      return unavailable("不允许读取外部地址。", 403);
    }
    const { query, ...options } = init ?? {};
    if (query instanceof URLSearchParams) {
      for (const [key, value] of query) url.searchParams.set(key, value);
    } else if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    const method = (options.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const signal = options.signal ?? (input instanceof Request ? input.signal : null);
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    // Reject before copying a streaming/consumed Request body. No SDK write
    // body (or source auth headers) needs decoding to refuse an operation.
    if (method !== 'GET') return unavailable();
    const request = input instanceof Request ? new Request(url, input) : url;
    const path = url.pathname;
    const sdkPath = path === '/api' || path.startsWith('/api/') || path === '/auth' || path.startsWith('/auth/') || path === '/health';
    if (sdkPath) return transport.fetch(request, options);
    // Only ordinary same-origin static resources may reach the captured fetch.
    // Unknown backend routes, native login/upload and every write fail closed.
    const staticPath = /^\/(assets|themes|fonts|icons)\//.test(path) || /^\/(favicon\.(ico|svg|png)|manifest\.webmanifest)$/.test(path);
    if (method === 'GET' && staticPath) {
      if (invokingCapturedFetch) return unavailable("网络读取捕获了 SDK 包装器；拒绝递归。", 503);
      // Guard synchronous source-wrapper re-entry; reset immediately after
      // invocation, not settlement, so independent static reads stay parallel.
      invokingCapturedFetch = true;
      try { return capturedNetworkFetch(request, options); }
      finally { invokingCapturedFetch = false; }
    }
    return unavailable();
  };
  const binding: NativeSdkBinding = {
    fetch: fetchNative,
    dispose() {
      if (closed) return;
      closed = true;
      transport.dispose();
      // Keep the global seam closed too. Restoring savedFetch would revive
      // direct legacy SDK/backend calls. Never replace a later source wrapper;
      // it may have captured our closed function. No owner disposal/recreation.
    },
  };
  bindings.set(target, binding);
  target.fetch = fetchNative;
  return binding;
}
