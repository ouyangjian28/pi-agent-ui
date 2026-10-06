// Preserve Source files; replace only browser entry execution at build time.
const once = (source, needle) => {
  if (source.split(needle).length !== 2) throw new Error('Original native startup anchor missing/duplicated: ' + needle);
};
export function nativeOriginalEntryTransform(source, kind) {
  if (source.includes('pi-native-original-startup-overlay')) throw new Error('Original native startup already applied');
  if (kind === 'mini') {
    once(source, "import { createConfiguredWebAPIs");
    return "// pi-native-original-startup-overlay\nconst root = document.getElementById('root'); if (root) root.textContent = '独立小聊天入口尚未接入；请使用主页面。';\n";
  }
  once(source, "import { createConfiguredWebAPIs");
  once(source, kind === 'desktop'
    ? 'window.__OPENCHAMBER_RUNTIME_APIS__ = createConfiguredWebAPIs(embeddedBootstrap);'
    : 'window.__OPENCHAMBER_RUNTIME_APIS__ = createConfiguredWebAPIs();');
  if (kind !== 'desktop' && kind !== 'mobile') throw new Error('Unknown original native surface');
  return `// pi-native-original-startup-overlay
import { startOriginalNativeSurface } from '@pi-native/original-startup';
const capturedNetworkFetch = window.fetch.bind(window);
const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');
const surface = ${kind === 'mobile' ? "'mobile'" : "window.matchMedia('(max-width: 767px)').matches ? 'mobile' : 'desktop'"};
// Original modules read/cache these facts while importing, not only on render.
window.__OPENCHAMBER_SURFACE__ = surface;
window.__OPENCHAMBER_API_BASE_URL__ = window.location.origin;
window.__OPENCHAMBER_LOCAL_ORIGIN__ = window.location.origin;
window.__OPENCHAMBER_CLIENT_TOKEN__ = undefined;
window.__OPENCHAMBER_RUNTIME_HEADERS__ = undefined;
window.__OPENCHAMBER_RELAY_HOST_ID__ = undefined;
const startup = startOriginalNativeSurface({ target: window, root, surface, capturedNetworkFetch,
  loadRenderer: () => import('@pi-native/original-renderer') });
window.addEventListener('pagehide', () => startup.dispose(), { once: true });
`;
}
export function nativeReadOnlyComposerTransform(source) {
  if (source.includes('pi-native-readonly-composer-overlay')) throw new Error('Original native composer overlay already applied');
  once(source, 'export const ChatInput = React.memo(ChatInputComponent);');
  return "// pi-native-readonly-composer-overlay\nimport { getNativeSurfaceHost as piGetNativeHost } from '@pi-native/surface-host';\n" + source.replace(
    'export const ChatInput = React.memo(ChatInputComponent);',
    `export const ChatInput = React.memo((props: ChatInputProps) => piGetNativeHost()
      ? <div role="status" className="px-4 py-3 text-sm text-muted-foreground">原生输入与发送正在接线，目前只读；不会执行原后台操作。</div>
      : <ChatInputComponent {...props} />);`,
  );
}
