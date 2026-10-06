import { createNativeSurfaceHost, type NativeSurfaceHost, type NativeSurfaceTarget } from './native-surface-host';
import type { NativePiSnapshot } from './native-pi-port';

export type OriginalSurface = 'desktop' | 'mobile';
export interface OriginalNativeRenderer {
  renderOriginalNativeSurface(host: NativeSurfaceHost, surface: OriginalSurface, root: HTMLElement): Promise<() => void>;
}
export interface OriginalNativeStartupOptions {
  readonly target: NativeSurfaceTarget;
  readonly root: HTMLElement;
  readonly surface: OriginalSurface;
  /** Must be captured by the entry before any Source import or global bridge. */
  readonly capturedNetworkFetch: typeof fetch;
  readonly loadRenderer: () => Promise<OriginalNativeRenderer>;
}
export interface OriginalNativeStartup { dispose(): void; }
const startups = new WeakMap<NativeSurfaceTarget, OriginalNativeStartup>();
export function originalNativeReadsReady(facts: NativePiSnapshot): boolean {
  return facts.list.state === 'ready' && facts.list.models.status === 'ok' && facts.list.roots.status === 'ok'
    && facts.write.connState === 'ready' && facts.detail.connState === 'ready';
}
/** Native DOM login precedes all original imports. Source cannot read an
 * injected token, restore its relay, or run composer before the host exists.
 * Closing retains the fail-closed host registry: no automatic owner revival.
 */
export function startOriginalNativeSurface(options: OriginalNativeStartupOptions): OriginalNativeStartup {
  const prior = startups.get(options.target);
  if (prior) return prior;
  const { target, root, surface, capturedNetworkFetch, loadRenderer } = options;
  const doc = root.ownerDocument;
  let closed = false;
  let host: NativeSurfaceHost | null = null;
  let importing = false;
  let unsubscribe = () => {};
  let unmount = () => {};
  const controller = new AbortController();
  const box = doc.createElement('section');
  box.style.cssText = 'max-width:32rem;margin:12vh auto;padding:1.5rem;font:16px system-ui;line-height:1.5';
  const title = doc.createElement('h1'); title.textContent = '连接 pi';
  const status = doc.createElement('p'); status.setAttribute('role', 'status');
  status.textContent = '输入本站 pi 登录令牌。不会启动原界面的后台连接。';
  const form = doc.createElement('form');
  const field = doc.createElement('input'); field.type = 'password'; field.autocomplete = 'off';
  field.required = true; field.setAttribute('aria-label', 'pi 登录令牌');
  const submit = doc.createElement('button'); submit.type = 'submit'; submit.textContent = '连接';
  const retry = doc.createElement('button'); retry.type = 'button'; retry.textContent = '重连'; retry.hidden = true;
  retry.addEventListener('click', () => { if (!closed && host) host.reconnect(); });
  form.append(field, submit); box.append(title, status, form, retry); root.replaceChildren(box);
  const renderIfReady = async () => {
    if (closed || !host || importing) return;
    if (!originalNativeReadsReady(host.port.getSnapshot())) {
      status.textContent = '等待 pi 会话、模型和连接确认；尚未加载原界面。'; return;
    }
    importing = true;
    status.textContent = '加载原版界面（输入发送仍在接线，目前只读）。';
    try {
      const renderer = await loadRenderer();
      if (closed || !host) return;
      if (!originalNativeReadsReady(host.port.getSnapshot())) {
        importing = false;
        status.textContent = '连接状态已变化；等待确认后再打开原界面。';
        return;
      }
      const stop = await renderer.renderOriginalNativeSurface(host, surface, root);
      if (closed) stop(); else unmount = stop;
    } catch {
      if (!closed) {
        // Source exceptions can contain arbitrary URLs/headers: fixed copy only.
        host?.dispose(); status.textContent = '原界面未启动；连接已关闭，请重新打开页面。'; retry.hidden = true;
        root.replaceChildren(box);
      }
    }
  };
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (closed || host || submit.disabled) return;
    const token = field.value; field.value = ''; submit.disabled = true;
    try {
      host = await createNativeSurfaceHost({ target, token, capturedNetworkFetch, signal: controller.signal });
      if (closed) { host.dispose(); return; }
      form.hidden = true; retry.hidden = false;
      unsubscribe = host.port.subscribe(() => { void renderIfReady(); });
      void renderIfReady();
    } catch {
      if (!closed) { status.textContent = '登录或连接未确认；没有加载原界面。可以重新输入后再试。'; submit.disabled = false; }
    }
  });
  const startup: OriginalNativeStartup = {
    dispose() {
      if (closed) return;
      closed = true; controller.abort(); unsubscribe(); unmount(); host?.dispose();
      root.replaceChildren();
    },
  };
  startups.set(target, startup);
  return startup;
}
