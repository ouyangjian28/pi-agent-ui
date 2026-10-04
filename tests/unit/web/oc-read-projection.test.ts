import { describe, expect, it } from "vitest";
import type { HistoryEvent, LiveEvent } from "@pi-agent-ui/protocol/src/contracts";
import { NativePiPort, type NativePiSnapshot } from "../../../apps/web/src/oc-bridge/native-pi-port";
import { DISPLAY_DEFAULT_MODEL, ocMessages, ocProviders, ocReadResponse } from "../../../apps/web/src/oc-bridge/oc-read-projection";
function facts(): NativePiSnapshot {
  const port = new NativePiPort("ws://127.0.0.1/ws", "fixture-only");
  const initial = port.getSnapshot(); port.dispose();
  return {
    ...initial, list: { ...initial.list, state: "ready", sessions: [],
      models: { status: "ok", items: [], cause: null }, roots: { status: "ok", items: ["/test/journal", "/test/workspace"], journalRoot: "/test/journal", cause: null } },
    detail: { ...initial.detail, connState: "ready" }, write: { ...initial.write, connState: "ready" },
  };
}
const message = (role: "user" | "assistant" | "toolCall" | "toolResult" | "system", text: string, seq = 1, truncated = false): HistoryEvent => ({
  kind: "message", seq, ts: null, generation: null, intentId: null, entryId: `e${seq}`, role, textPreview: { text, truncated }, final: true,
});
describe("OC display projection is not a second backend fact/write authority", () => {
  it("rejects every write even when all three native clients are ready", async () => {
    for (const path of ["/api/session", "/api/session/a.jsonl/prompt_async", "/api/session/a.jsonl/abort", "/api/config/settings", "/api/git/commit"]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect(ocReadResponse(path, method, facts()).status).toBe(501);
    }
  });
  it("never says healthy before each native handshake, including a lost write socket", async () => {
    const f = facts();
    for (const bad of [ { ...f, list: { ...f.list, state: "connecting" as const } }, { ...f, write: { ...f.write, connState: "closed" as const } }, { ...f, detail: { ...f.detail, connState: "error" as const } } ]) {
      expect(ocReadResponse("/health", "GET", bad).status).toBe(503);
    }
    expect(await ocReadResponse("/health", "GET", f).json()).toMatchObject({ healthy: true, nativePi: true, version: "pi-native" });
  });
  it("distinguishes loading catalogue and list from known empty native responses", async () => {
    const f = facts();
    expect(ocReadResponse("/api/session", "GET", { ...f, list: { ...f.list, sessions: null } }).status).toBe(503);
    expect(await ocReadResponse("/api/session", "GET", f).json()).toEqual([]);
    expect(ocReadResponse("/api/config/providers", "GET", { ...f, list: { ...f.list, models: { status: "failed", items: [], cause: "fixture-failure" } } }).status).toBe(503);
    expect(ocReadResponse("/api/config/providers", "GET", f).status).toBe(200);
  });
  it("does not invent prices, context, attachment/tool support or unknown thinking levels", () => {
    const values = ocProviders([{ provider: "test", id: "known", thinkingLevels: ["off", "high"] }, { provider: "test", id: "unknown", thinking: "yes" }]);
    const models = values.providers.find((provider) => provider.id === "test")!.models;
    expect(Object.keys(models.known!.variants)).toEqual(["off", "high"]);
    expect(models.unknown!.variants).toEqual({}); expect(models.unknown!.capabilities).not.toHaveProperty("reasoning");
    expect(models.known!.cost).toEqual({}); expect(models.known!.limit).toEqual({});
    expect(models.known!.capabilities).not.toHaveProperty("attachment"); expect(models.known!.capabilities).not.toHaveProperty("toolcall");
    expect(values.default).toEqual({ "pi-default": "default" }); expect(DISPLAY_DEFAULT_MODEL).toBe("pi-default/default");
  });
  it("preserves native uncertainty/identity, not fake session UUID or dates", async () => {
    const f = facts(); const changed = { ...f, list: { ...f.list, sessions: [{ sessionId: null, file: "actual.jsonl", title: { text: "partial title", truncated: true }, lastActiveMs: null, entryCount: 2, sizeBytes: 40, hasRecoveryNotice: true, listReliability: "partial" as const }] } };
    const result = await ocReadResponse("/api/session", "GET", changed).json();
    expect(result).toEqual([expect.objectContaining({ id: "actual.jsonl", time: {}, native: expect.objectContaining({ sessionId: null, titleTruncated: true, listReliability: "partial", hasRecoveryNotice: true }) })]);
    expect(ocReadResponse("/api/session/not-known.jsonl", "GET", changed).status).toBe(404);
  });
  it("does not subscribe or return another session's history to an SDK read", async () => {
    const f = facts(); const detail = { ...f.detail, file: "a.jsonl", phase: "live" as const, events: [message("user", "real text")] };
    expect(ocReadResponse("/api/session/b.jsonl/message", "GET", { ...f, detail }).status).toBe(503);
    const result = await ocReadResponse("/api/session/a.jsonl/message", "GET", { ...f, detail }).json();
    expect(result).toEqual([expect.objectContaining({ info: expect.objectContaining({ sessionID: "a.jsonl", role: "user" }), parts: [expect.objectContaining({ text: "real text" })] })]);
    expect(ocReadResponse("/api/session/%ZZ", "GET", f).status).toBe(400);
  });
  it("never leaks system messages; truncated previews and tool origins stay explicit", () => {
    const result = ocMessages([message("system", "private system"), message("toolResult", "tool output", 2), message("assistant", "preview", 3, true)], [], "a.jsonl");
    expect(JSON.stringify(result)).not.toContain("private system");
    expect(result[0]!.info.native.role).toBe("toolResult"); expect(result[0]!.parts[0]!.text).toContain("工具结果");
    expect(result[1]!.parts[0]!.text).toContain("内容已截断"); expect(result[1]!.info.native.truncated).toBe(true);
  });
  it("streamed final remains temporary until the native persisted history arrives", () => {
    const live: LiveEvent[] = [{ kind: "message-delta", part: "text", contentIndex: 0, delta: "abc" }, { kind: "message-final", role: "assistant", text: "abcd" }];
    const during = ocMessages([], live, "a.jsonl");
    expect(during[0]!.info.native.final).toBe(false); expect(during[0]!.parts[0]!.text).toBe("abcd");
    const after = ocMessages([message("assistant", "abcd", 2)], live, "a.jsonl");
    expect(after).toHaveLength(1); expect(after[0]!.info.native.final).toBe(true);
  });
  it("a new native turn retires stale live bytes before the new assistant starts", () => {
    const live: LiveEvent[] = [
      { kind: "turn-state", statusVersion: 1, turn: { state: "in-flight", intentId: "old" } },
      { kind: "message-final", role: "assistant", text: "old reply" },
      { kind: "turn-state", statusVersion: 2, turn: { state: "dispatching", intentId: "new" } },
    ];
    const result = ocMessages([message("assistant", "old reply", 1), message("user", "new question", 2)], live, "a.jsonl");
    expect(result).toHaveLength(2); expect(result.at(-1)?.info.role).toBe("user");
  });
  it("model discovery and an authorised landing directory do not prove provider auth, OS home or runtime cwd", async () => {
    expect(await ocReadResponse("/api/provider", "GET", facts()).json()).not.toHaveProperty("connected");
    expect(await ocReadResponse("/api/path", "GET", facts()).json()).toMatchObject({ nativeExecutionDirectoryKnown: false });
    expect(await ocReadResponse("/api/fs/home", "GET", facts()).json()).toMatchObject({ nativeOsHomeKnown: false });
  });
  it("disabled feature reads aren't fabricated empty successful backend catalogues", () => {
    for (const path of ["/api/command", "/api/permission", "/api/question", "/api/git/check", "/api/terminal/sessions", "/api/mcp", "/api/config/skills", "/api/fs/list"]) {
      expect(ocReadResponse(path, "GET", facts()).status).toBe(501);
    }
  });
});
