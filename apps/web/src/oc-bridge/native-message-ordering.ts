interface NativeOrderedMessage {
  readonly sessionID?: string;
  readonly native?: { readonly entryId?: string; readonly seq?: number | null; readonly temporary?: boolean };
}
/** Override the original timestamp sort ONLY for two verified native display
 * records in the same session. Journal order is not a made-up timestamp.
 * Unknown or original OpenCode records retain the original comparator.
 */
export function compareNativeMessages(left: NativeOrderedMessage, right: NativeOrderedMessage): number | undefined {
  const a = left.native; const b = right.native;
  if (!left.sessionID || left.sessionID !== right.sessionID || !a || !b || typeof a.entryId !== "string" || typeof b.entryId !== "string" || typeof a.temporary !== "boolean" || typeof b.temporary !== "boolean") return undefined;
  if (a.temporary !== b.temporary) return a.temporary ? 1 : -1;
  if (a.temporary) return 0;
  if (typeof a.seq !== "number" || typeof b.seq !== "number" || !Number.isSafeInteger(a.seq) || !Number.isSafeInteger(b.seq) || a.seq < 0 || b.seq < 0) return undefined;
  return a.seq - b.seq;
}
