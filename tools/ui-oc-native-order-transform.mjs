const ANCHOR = "export const compareMessagesChronologically = (left: Message, right: Message): number => {";
export function nativeMessageOrderTransform(source) {
  if (source.includes("@pi-native/message-ordering") || source.split(ANCHOR).length !== 2) throw new Error("Native message order anchor missing/ambiguous");
  return 'import { compareNativeMessages } from "@pi-native/message-ordering"\n' + source.replace(ANCHOR, ANCHOR + '\n  const nativeDifference = compareNativeMessages(left, right)\n  if (nativeDifference !== undefined && nativeDifference !== 0) return nativeDifference');
}
