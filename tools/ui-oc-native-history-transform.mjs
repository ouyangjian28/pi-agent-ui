// Literal Source build overlays; preserve unbound bodies and original bytes.
const marker = '// pi-native-history-read-surface-overlay\n';
const header = marker + "import { getNativeSurfaceHost as piGetNativeHost } from '@pi-native/surface-host';\nimport { isNativeChronology as piIsNativeChronology, nativeChronologyWindow as piChronologyWindow, nativeChronologyProjection as piChronologyProjection, initializeNativeReadDirectory as piInitializeNativeReadDirectory } from '@pi-native/history-surface';\n";
export function nativeHistorySurfaceTransform(source, kind) {
  if (source.includes(marker.trim())) throw new Error('Original native history surface already applied');
  const edits = {
    window: [
      ['export const buildTurnWindowModel = (messages: ChatMessageEntry[]): TurnWindowModel => {', '\n    if (piGetNativeHost() && piIsNativeChronology(messages)) return piChronologyWindow(messages);'],
      ['): TurnWindowModel | null => {', '\n    if (piGetNativeHost() && piIsNativeChronology(nextMessages)) return null; // Full native rebuild, never old parent/user append assumptions.'],
    ],
    projection: [
      ['): TurnProjectionResult => {', '\n    if (piGetNativeHost() && piIsNativeChronology(messages)) return piChronologyProjection(messages);'],
    ],
    messages: [
      ['    const trailingStreamingEntry = React.useMemo<RenderEntry | undefined>(() => {', '\n        if (piGetNativeHost() && piIsNativeChronology(displayMessages)) return undefined; // All native cards already occur once in static entries.'],
    ],
    bootstrap: [
      ['async function initializeDirectory(input: DirectoryBootstrapInput): Promise<BootstrapResult> {', '\n  if (piGetNativeHost()) return piInitializeNativeReadDirectory(input.directory, patch => input.set(patch as Partial<State>), input.isStale);'],
    ],
  };
  const entries = edits[kind]; if (!entries) throw new Error('Unknown native history surface kind');
  let code = source;
  for (const [anchor, branch] of entries) {
    if (code.split(anchor).length !== 2) throw new Error('Original native history surface anchor missing/duplicated: ' + anchor);
    code = code.replace(anchor, anchor + branch);
  }
  return header + code;
}
