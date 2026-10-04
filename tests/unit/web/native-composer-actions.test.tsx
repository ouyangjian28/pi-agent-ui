// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { NativePiPort } from "../../../apps/web/src/oc-bridge/native-pi-port";
import { activeEditor, nativeComposerActions, supportedThinking } from "../../../apps/web/src/oc-bridge/native-composer-actions";
import { NativeModelControlsScope, useNativeModelControls } from "../../../apps/web/src/oc-bridge/native-model-controls";
import { nativeModelControlsTransform } from "../../../tools/ui-oc-native-model-transform.mjs";
import type { WebSocketLike } from "../../../apps/web/src/ws/ws-client";
class Socket implements WebSocketLike {
  readyState = 0; sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null; onmessage: ((e: { readonly data: unknown }) => void) | null = null;
  onclose: ((e: { readonly code: number }) => void) | null = null; onerror: (() => void) | null = null;
  send(data: string) { this.sent.push(JSON.parse(data) as Record<string, unknown>); }
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
  receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  welcome() { this.readyState = 1; this.onopen?.(); this.receive({ t: "welcome", protocolVersion: 1, serverBootId: "fixture", serverBuildId: "fixture" }); }
}
const ports: NativePiPort[] = [];
afterEach(() => { cleanup(); for (const p of ports.splice(0)) p.dispose(); });
function rig() {
  const sockets: Socket[] = [];
  const port = new NativePiPort("ws://127.0.0.1/ws", "fixture-only", { createSocket: () => { const s = new Socket(); sockets.push(s); return s; } });
  ports.push(port); port.connect(); sockets.forEach((s) => s.welcome());
  const list = sockets[0]!;
  list.receive({ t: "models-list", requestId: list.sent.find((f) => f.t === "get-models")!.requestId, models: [
    { provider: "fixture", id: "low", thinkingLevels: ["off", "low"] }, { provider: "fixture", id: "high", thinkingLevels: ["off", "high"] },
    { provider: "other", id: "low", thinking: "yes" },
  ] });
  const id = port.createDraft("a.jsonl")!; const actions = nativeComposerActions(port, id);
  return { port, sockets, id, actions };
}
describe("original controls bind only explicit actions to the native owner", () => {
  it("projects actual choices without render-driven configuration or another draft store", () => {
    const r = rig(); const before = activeEditor(r.port)!;
    function Probe() { const c = useNativeModelControls()!; return <button onClick={() => c.actions.chooseModel("fixture", "low")}>{c.selection.model.providerId}/{c.selection.model.modelId}</button>; }
    const view = render(<NativeModelControlsScope port={r.port} targetId={r.id}><Probe /></NativeModelControlsScope>);
    expect(activeEditor(r.port)).toBe(before); expect(screen.getByRole("button").textContent).toBe("pi-default/default");
    act(() => { screen.getByRole("button").click(); }); expect(screen.getByRole("button").textContent).toBe("fixture/low");
    const after = activeEditor(r.port); view.rerender(<NativeModelControlsScope port={r.port} targetId={r.id}><Probe /></NativeModelControlsScope>);
    expect(activeEditor(r.port)).toBe(after); expect(r.sockets[1]!.sent.filter((f) => f.t === "prompt")).toHaveLength(0);
  });
  it("model-only switch retains unsupported effort and blocks send instead of silently clamping", async () => {
    const r = rig(); r.actions.edit("my draft"); expect(r.actions.chooseModel("fixture", "low")).toBe(true);
    expect(r.actions.chooseThinking("low")).toBe(true); expect(r.actions.chooseThinking("max")).toBe(false);
    expect(r.actions.chooseModel("fixture", "high")).toBe(true);
    expect(activeEditor(r.port)).toMatchObject({ text: "my draft", thinkingLevel: "low", modelChoice: "fixture/high" });
    expect(await r.actions.send()).toMatchObject({ status: "local" });
    expect(r.sockets[1]!.sent.filter((f) => f.t === "prompt")).toHaveLength(0);
  });
  it("mobile combined selection validates all before changing model/custom draft/version", () => {
    const r = rig(); r.actions.edit("keep"); r.actions.setCustomModel("custom/id"); const before = activeEditor(r.port);
    expect(r.actions.chooseModelAndThinking("fixture", "low", "high")).toBe(false); expect(activeEditor(r.port)).toBe(before);
    expect(r.actions.chooseModelAndThinking("missing", "one", null)).toBe(false); expect(activeEditor(r.port)).toBe(before);
    expect(r.actions.chooseModelAndThinking("fixture", "high", "high")).toBe(true);
    expect(activeEditor(r.port)).toMatchObject({ text: "keep", modelChoice: "fixture/high", freeText: "", thinkingLevel: "high" });
    expect(r.actions.chooseModelAndThinking("pi-default", "default", null)).toBe(true); expect(activeEditor(r.port)?.thinkingLevel).toBeNull();
  });
  it("ambiguous short id/unknown model do not gain fabricated effort capability", () => {
    const r = rig(); r.actions.setCustomModel("low"); expect(supportedThinking(r.port, activeEditor(r.port)!)).toBeUndefined();
    expect(r.actions.chooseThinking("low")).toBe(false); r.actions.setCustomModel("unknown/id"); expect(r.actions.chooseThinking("high")).toBe(false);
    expect(r.actions.chooseThinking(null)).toBe(true); expect(r.actions.chooseModel("missing", "model")).toBe(false);
  });
  it("stale reused control cannot edit/configure/send another active session", async () => {
    const r = rig(); r.actions.edit("A"); const b = r.port.openSession("b.jsonl")!; r.port.owner.edit(b, "B");
    expect(r.actions.edit("stale")).toBe(false); expect(r.actions.chooseModel("fixture", "low")).toBe(false);
    expect(r.actions.chooseThinking(null)).toBe(false); expect(await r.actions.send()).toMatchObject({ status: "local" });
    expect(r.port.getSnapshot().conversation.drafts.get(r.id)?.text).toBe("A"); expect(activeEditor(r.port)?.text).toBe("B");
    expect(r.sockets[1]!.sent.filter((f) => f.t === "prompt")).toHaveLength(0);
  });
  it("send carries native model/effort, no optimistic clear; pending config is refused and late ACK keeps new edit", async () => {
    const r = rig(); r.actions.chooseModelAndThinking("fixture", "low", "low"); r.actions.edit("first");
    const pending = r.actions.send(); const frame = r.sockets[1]!.sent.find((f) => f.t === "prompt")!;
    expect(frame).toMatchObject({ file: "a.jsonl", text: "first", model: "fixture/low", thinkingLevel: "low" });
    expect(activeEditor(r.port)?.text).toBe("first"); expect(r.actions.chooseModel("fixture", "high")).toBe(false);
    expect(r.actions.chooseThinking(null)).toBe(false); r.actions.edit("second");
    r.sockets[1]!.receive({ t: "write-ack", requestId: frame.requestId, file: frame.file, outcome: { kind: "launched", intentId: "fixture-intent", commandId: 1 } });
    expect((await pending).status).toBe("launched"); expect(activeEditor(r.port)?.text).toBe("second");
  });
  it("existing-session controls resolve the owner id and send actual next-prompt parameters", async () => {
    const r = rig(); const id = r.port.openSession("existing.jsonl")!;
    const actions = nativeComposerActions(r.port, id);
    expect(activeEditor(r.port)).toMatchObject({ id, file: "existing.jsonl", isNew: false });
    expect(actions.chooseModelAndThinking("fixture", "high", "high")).toBe(true);
    expect(actions.edit("next turn")).toBe(true);
    const pending = actions.send(); const frame = r.sockets[1]!.sent.find((f) => f.t === "prompt")!;
    expect(frame).toMatchObject({ file: "existing.jsonl", text: "next turn", model: "fixture/high", thinkingLevel: "high" });
    expect(activeEditor(r.port)?.text).toBe("next turn");
    r.sockets[1]!.receive({ t: "write-ack", requestId: frame.requestId, file: frame.file, outcome: { kind: "launched", intentId: "existing-intent", commandId: 2 } });
    expect((await pending).status).toBe("launched");
    expect(activeEditor(r.port)).toMatchObject({ id, file: "existing.jsonl", text: "", modelChoice: "fixture/high", thinkingLevel: "high" });
  });
  it("unknown after reconnect never auto-retries through reused user controls", async () => {
    const r = rig(); r.actions.edit("keep"); const pending = r.actions.send(); r.port.reconnect(); r.sockets.forEach((s) => { if (s.readyState === 0) s.welcome(); });
    expect((await pending).status).toBe("unknown"); expect(await r.actions.send()).toMatchObject({ status: "local" });
    expect(r.sockets.flatMap((s) => s.sent).filter((f) => f.t === "prompt")).toHaveLength(1); expect(activeEditor(r.port)?.text).toBe("keep");
  });
});
describe("immutable original ModelControls build overlay", () => {
  const sourcePath = resolve("vendor/openchamber-frontend/packages/ui/src/components/chat/ModelControls.tsx");
  const source = readFileSync(sourcePath, "utf8");
  it("transforms the literal original component, keeps menu markup, and parses as TSX", () => {
    const result = nativeModelControlsTransform(source);
    expect(result).toContain("nativeModelControls?.selection ?? originalSelection");
    expect(result).toContain("[nativeModelControls, commitVariantSelectionForModel");
    for (const className of ["rounded-xl border border-border/40 bg-sidebar/30 px-2 py-1.5", "typography-meta text-foreground font-medium"]) expect(result).toContain(className);
    const parsed = ts.transpileModule(result, { fileName: "ModelControls.tsx", reportDiagnostics: true, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
    expect(parsed.diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error) ?? []).toEqual([]);
    expect(readFileSync(sourcePath, "utf8")).toBe(source);
  });
  it("source drift, duplicate anchors and repeated transformation reject before a partial build", () => {
    expect(() => nativeModelControlsTransform(source.replace("const handleMobileModelApply =", "const renamed ="))).toThrow("anchor missing/ambiguous");
    expect(() => nativeModelControlsTransform(source + "\n    const { t } = useI18n();")).toThrow("anchor missing/ambiguous");
    expect(() => nativeModelControlsTransform(nativeModelControlsTransform(source))).toThrow("anchor missing/ambiguous");
  });
});
