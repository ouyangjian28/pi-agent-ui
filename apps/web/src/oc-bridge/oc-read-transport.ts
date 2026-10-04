import type { NativePiPort } from "./native-pi-port";
import { nativeDirectory, ocReadResponse, unavailable } from "./oc-read-projection";
import { OcEventProjection } from "./oc-event-projection";

/** Browser-local SDK read seam, not an HTTP server/forward proxy.
 * Original SDK write requests always fail here; actual composer actions must
 * use the bound native owner. No credentials, ports, engines or retries added.
 */
export class OcReadTransport {
  private readonly base: URL;
  private readonly streams = new Set<() => void>();
  private closed = false;
  constructor(private readonly port: Pick<NativePiPort, "getSnapshot" | "subscribe">, baseURL: string, private readonly heartbeatMs = 15_000) {
    try { this.base = new URL(baseURL); }
    catch { throw new Error("pi 读取地址无效。"); }
    if (!["http:", "https:"].includes(this.base.protocol) || this.base.username || this.base.password) throw new Error("pi 读取地址必须是无凭据的 HTTP(S) 地址。");
    if (!Number.isFinite(heartbeatMs) || heartbeatMs < 1000) throw new Error("事件保活间隔无效。");
  }
  readonly fetch: typeof fetch = async (input, init) => {
    if (this.closed) return unavailable("pi 界面已关闭。", 503);
    let url: URL;
    try { url = new URL(input instanceof Request ? input.url : String(input), this.base); }
    catch { return unavailable("读取地址无效。", 400); }
    if (url.origin !== this.base.origin || url.username || url.password || !["http:", "https:"].includes(url.protocol)) return unavailable("不允许读取外部地址。", 403);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const path = url.pathname.replace(/\/$/, "");
    if (method === "GET" && (path === "/api/global/event" || path === "/api/event")) {
      const facts = this.port.getSnapshot();
      if (ocReadResponse("/health", "GET", facts).status !== 200 || nativeDirectory(facts) === null) return unavailable("pi 事件读取尚未就绪。", 503);
      return this.eventStream(signal);
    }
    // No real fetch/network fallback, including original terminal/Git/goal APIs.
    return ocReadResponse(path, method, this.port.getSnapshot());
  };
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const stop of [...this.streams]) stop();
  }
  private eventStream(signal: AbortSignal | null | undefined): Response {
    const projection = new OcEventProjection(); const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let detach: () => void = () => {}; let heartbeat: ReturnType<typeof setInterval> | undefined;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true; detach(); if (heartbeat !== undefined) clearInterval(heartbeat);
      signal?.removeEventListener("abort", stop); this.streams.delete(stop);
      controller.close();
    };
    const push = () => {
      if (stopped) return;
      const facts = this.port.getSnapshot();
      if (ocReadResponse("/health", "GET", facts).status !== 200 || nativeDirectory(facts) === null) { stop(); return; }
      for (const event of projection.project(facts)) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    };
    const body = new ReadableStream<Uint8Array>({
      start: (value) => {
        controller = value; this.streams.add(stop);
        detach = this.port.subscribe(push); signal?.addEventListener("abort", stop, { once: true });
        if (signal?.aborted || this.closed) { stop(); return; }
        push();
        if (!stopped) heartbeat = setInterval(() => {
          // Parser-level keepalive only, never a fabricated native success/status.
          if (!stopped) controller.enqueue(encoder.encode("event: heartbeat\ndata: {}\n\n"));
        }, this.heartbeatMs);
      },
      cancel: () => {
        // cancel already closes the controller; don't close it a second time.
        if (stopped) return;
        stopped = true; detach(); if (heartbeat !== undefined) clearInterval(heartbeat);
        signal?.removeEventListener("abort", stop); this.streams.delete(stop);
      },
    });
    return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" } });
  }
}
