// Native public history/status does not prove accepted-send/no-reply or carry
// legacy OpenCode notification errors. Keep original hooks and unbound body;
// actual native gateway/owner errors remain owned by NativeSurfaceHost/port.
const marker = '// pi-native-no-legacy-session-error-inference\n';
const header = marker + "import { getNativeSurfaceHost as piGetNativeHost } from '@pi-native/surface-host';\n";
const anchor = '  if (!reportedError && !unanswered) return null;';
const branch = '  if (piGetNativeHost()) return null; // All original hooks ran; legacy error inference is unavailable on native surfaces.\n\n';
export function nativeLegacySessionNoticeTransform(source) {
  if (source.includes(marker.trim())) throw new Error('Original native session notice already applied');
  if (source.split(anchor).length !== 2) throw new Error('Original native session notice anchor missing/duplicated');
  return header + source.replace(anchor, branch + anchor);
}
