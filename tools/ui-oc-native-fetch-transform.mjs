// Build-only native SDK read seam; immutable literal source is never edited.
export function nativeRuntimeFetchTransform(source) {
  if (source.includes('@pi-native/sdk-fetch')) throw new Error('Native SDK fetch overlay already applied');
  const anchors = [
    ['export const runtimeFetch = async (input: string | URL | Request, init: RuntimeFetchOptions = {}): Promise<Response> => {',
     'export const runtimeFetch = async (input: string | URL | Request, init: RuntimeFetchOptions = {}): Promise<Response> => {\n  const nativeSdkFetch = getNativeSdkFetch();\n  if (nativeSdkFetch) return nativeSdkFetch(input, init);'],
    ['export const installRuntimeFetchBridge = (): void => {',
     'export const installRuntimeFetchBridge = (): void => {\n  if (getNativeSdkFetch()) return;'],
    ['  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {',
     '  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {\n    const nativeSdkFetch = getNativeSdkFetch();\n    if (nativeSdkFetch) return nativeSdkFetch(input, init);'],
  ];
  for (const [before, after] of anchors) {
    if (source.split(before).length !== 2) throw new Error('Original SDK fetch anchor missing/duplicated: ' + before);
    source = source.replace(before, after);
  }
  return "import { getNativeSdkFetch } from '@pi-native/sdk-fetch';\n" + source;
}
