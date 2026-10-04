import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compareNativeMessages } from "../../../apps/web/src/oc-bridge/native-message-ordering";
import { ocMessages } from "../../../apps/web/src/oc-bridge/oc-read-projection";
import { nativeMessageOrderTransform } from "../../../tools/ui-oc-native-order-transform.mjs";
const path = resolve("vendor/openchamber-frontend/packages/ui/src/sync/message-ordering.ts");
function comparator() {
  const original = readFileSync(path, "utf8"); const patched = nativeMessageOrderTransform(original);
  const compiled = ts.transpileModule(patched, { compilerOptions: { module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
  expect(compiled.diagnostics?.filter((d) => d.category === ts.DiagnosticCategory.Error)).toEqual([]);
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", compiled.outputText)((id: string) => {
    if (id !== "@pi-native/message-ordering") throw new Error(`Unexpected fixture import: ${id}`);
    return { compareNativeMessages };
  }, exports);
  return { original, compare: exports.compareMessagesChronologically as (a: unknown, b: unknown) => number };
}
describe("literal original order module plus bounded native order hook", () => {
  it("orders known native sequence, not nullable/clock-skewed dates or random entry ids; live remains last", () => {
    const { compare } = comparator();
    const rows = ocMessages([
      { kind: "message", seq: 1, ts: 100, generation: null, intentId: null, entryId: "z-random", role: "user", textPreview: { text: "first", truncated: false }, final: true },
      { kind: "message", seq: 2, ts: null, generation: null, intentId: null, entryId: "a-random", role: "assistant", textPreview: { text: "second", truncated: false }, final: true },
    ], [{ kind: "message-delta", part: "text", contentIndex: 0, delta: "third temporary" }], "a.jsonl");
    expect([rows[2]!.info, rows[1]!.info, rows[0]!.info].sort(compare).map((info) => info.id)).toEqual(rows.map((r) => r.info.id));
    expect(rows[1]!.info.time.created).toBeUndefined(); expect(rows[2]!.info.native).toMatchObject({ seq: null, temporary: true });
  });
  it("declines cross-session/unverified metadata and keeps original OpenCode date/id behavior", () => {
    const { compare } = comparator(); const first = { id: "zzz", sessionID: "a", time: { created: 1 } }; const later = { id: "aaa", sessionID: "a", time: { created: 2 } };
    expect(compare(first, later)).toBeLessThan(0); expect(compare({ ...first, time: {} }, { ...later, time: {} })).toBeGreaterThan(0);
    expect(compareNativeMessages({ sessionID: "a", native: { entryId: "x", temporary: false, seq: 1 } }, { sessionID: "b", native: { entryId: "y", temporary: false, seq: 2 } })).toBeUndefined();
    expect(compareNativeMessages({ sessionID: "a", native: { entryId: "x", temporary: false, seq: NaN } }, { sessionID: "a", native: { entryId: "y", temporary: false, seq: 2 } })).toBeUndefined();
  });
  it("never changes snapshot bytes and fails closed on missing/duplicated/reapplied source anchors", () => {
    const { original } = comparator(); expect(readFileSync(path, "utf8")).toBe(original);
    expect(() => nativeMessageOrderTransform("")).toThrow("anchor missing/ambiguous");
    expect(() => nativeMessageOrderTransform(original + original)).toThrow("anchor missing/ambiguous");
    expect(() => nativeMessageOrderTransform(nativeMessageOrderTransform(original))).toThrow("anchor missing/ambiguous");
  });
});
