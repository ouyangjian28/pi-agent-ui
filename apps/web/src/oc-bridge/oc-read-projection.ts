// Display-only translation for the original OpenChamber readers.
// It is NOT an OpenCode HTTP server, a second session registry, or a write API.
import type { HistoryEvent, LiveEvent, ModelInfoDTO, SessionSummaryDTO } from "@pi-agent-ui/protocol/src/contracts";
import type { NativePiSnapshot } from "./native-pi-port";

const DISPLAY_DEFAULT_PROVIDER = "pi-default";
export const DISPLAY_DEFAULT_MODEL = `${DISPLAY_DEFAULT_PROVIDER}/default`;
export function ocSession(row: SessionSummaryDTO, directory: string) {
  return { id: row.file, slug: row.file, projectID: "pi-native", directory, title: row.title.text,
    version: "pi-native", time: { created: row.lastActiveMs ?? undefined, updated: row.lastActiveMs ?? undefined },
    native: { file: row.file, sessionId: row.sessionId, titleTruncated: row.title.truncated, listReliability: row.listReliability, hasRecoveryNotice: row.hasRecoveryNotice },
  };
}
function displayModel(model: ModelInfoDTO) {
  const levels = model.thinkingLevels;
  return { id: model.id, providerID: model.provider, name: model.id,
    api: { id: model.id, npm: "pi-native-rpc", url: "" },
    capabilities: { ...(levels === undefined ? {} : { reasoning: levels.length > 0 }),
      input: { text: true }, output: { text: true } },
    variants: levels === undefined ? {} : Object.fromEntries(levels.map((level) => [level, {}])),
    // Absent native metadata stays absent: don't invent context, price or date.
    cost: {}, limit: {}, options: {}, headers: {}, status: "active",
    native: { capabilityKnown: levels !== undefined, thinkingLevels: levels, context: model.context, otherModelCapabilitiesKnown: false },
  };
}
export function ocProviders(models: readonly ModelInfoDTO[]) {
  const groups = new Map<string, ReturnType<typeof displayModel>[]>();
  const defaultModel = { ...displayModel({ provider: DISPLAY_DEFAULT_PROVIDER, id: "default" }), name: "pi 配置 · 保持当前/默认", native: { capabilityKnown: false, thinkingLevels: undefined, context: undefined, otherModelCapabilitiesKnown: false } };
  groups.set(DISPLAY_DEFAULT_PROVIDER, [defaultModel]);
  for (const model of models) {
    const group = groups.get(model.provider) ?? []; group.push(displayModel(model)); groups.set(model.provider, group);
  }
  const providers = [...groups].map(([id, values]) => ({ id, name: id === DISPLAY_DEFAULT_PROVIDER ? "pi 配置（展示适配）" : id,
    source: "custom", env: [], options: {}, models: Object.fromEntries(values.map((model) => [model.id, model])) }));
  return { providers, default: { [DISPLAY_DEFAULT_PROVIDER]: "default" } };
}
function historyMessage(event: Extract<HistoryEvent, { kind: "message" }>, file: string) {
  if (event.role === "system") return null; // No new system-prompt exposure.
  const id = `pi-${event.entryId}-${event.blockIndex ?? 0}`;
  const extra = event.role === "toolCall" ? "工具调用\n" : event.role === "toolResult" ? "工具结果\n" : "";
  const text = extra + (event.textPreview?.text ?? "") + (event.textPreview?.truncated ? "\n[pi 内容已截断；此展示未代替全文展开]" : "");
  return { info: { id, sessionID: file, role: event.role === "user" ? "user" : "assistant",
    time: { created: event.ts ?? undefined, ...(event.final ? { completed: event.ts ?? undefined } : {}) },
    agent: "pi", mode: "pi", model: { providerID: DISPLAY_DEFAULT_PROVIDER, modelID: "default" },
    path: { cwd: "", root: "" }, tokens: {}, native: { role: event.role, final: event.final, entryId: event.entryId, truncated: event.textPreview?.truncated ?? false } },
    parts: [{ id: `${id}-text`, sessionID: file, messageID: id, type: "text", text }],
  };
}
export function ocMessages(events: readonly HistoryEvent[], liveEvents: readonly LiveEvent[], file: string) {
  const messages = events.filter((event): event is Extract<HistoryEvent, { kind: "message" }> => event.kind === "message")
    .map((event) => historyMessage(event, file)).filter((message) => message !== null);
  // Only unpersisted assistant bytes are temporary. Don't promote them into a
  // completed/history reply. A durable assistant message retires that buffer.
  let text = ""; let thinking = ""; let liveIntent: string | null = null;
  for (const event of liveEvents) {
    if (event.kind === "turn-state" && (event.turn.state === "dispatching" || event.turn.state === "in-flight")) {
      if (liveIntent !== event.turn.intentId) { text = ""; thinking = ""; }
      liveIntent = event.turn.intentId;
    }
    if (event.kind === "pi-progress" && event.piType === "message_start") { text = ""; thinking = ""; }
    if (event.kind === "message-delta") { if (event.part === "text") text += event.delta; else thinking += event.delta; }
    if (event.kind === "message-final") text = event.text;
  }
  const last = messages[messages.length - 1];
  if ((text || thinking) && !(last?.info.role === "assistant" && last.info.native.final && last.parts[0]?.text === text)) {
    const id = `pi-live-${liveIntent ?? "unattributed"}-assistant`;
    const parts = [{ id: `${id}-text`, sessionID: file, messageID: id, type: "text", text }];
    if (thinking) parts.unshift({ id: `${id}-thinking`, sessionID: file, messageID: id, type: "reasoning", text: thinking });
    messages.push({ info: { id, sessionID: file, role: "assistant", time: { created: undefined }, agent: "pi", mode: "pi",
      model: { providerID: DISPLAY_DEFAULT_PROVIDER, modelID: "default" }, path: { cwd: "", root: "" }, tokens: {},
      native: { role: "assistant", final: false, entryId: "", truncated: false } }, parts });
  }
  return messages;
}
export function nativeDirectory(snapshot: NativePiSnapshot): string | null {
  return snapshot.list.roots.status === "ok" ? snapshot.list.roots.items.find((root) => root !== snapshot.list.roots.journalRoot) ?? null : null;
}
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
export function unavailable(message = "此 OpenChamber 操作尚未接入 pi。", status = 501): Response {
  return json({ error: { name: "PiSurfaceUnavailable", message }, nativeUnavailable: true }, status);
}
/** All writes are rejected here. Composer/stop/resume must call native owner
 * explicitly and keep its five-way results, never HTTP 2xx => launched.
 */
export function ocReadResponse(pathname: string, method: string, snapshot: NativePiSnapshot): Response {
  if (method !== "GET") return unavailable();
  if (snapshot.list.state !== "ready" || snapshot.write.connState !== "ready" || snapshot.detail.connState !== "ready") return unavailable("pi 连接尚未就绪。", 503);
  const directory = nativeDirectory(snapshot);
  const path = pathname.replace(/\/$/, "");
  if (["/health", "/api/opencode/health", "/api/global/health"].includes(path)) return json({ healthy: true, version: "pi-native", nativePi: true });
  if (path === "/auth/session") return json({ authenticated: true, nativePi: true });
  if (["/api/config/providers", "/api/provider"].includes(path)) {
    if (snapshot.list.models.status !== "ok") return unavailable("pi 模型清单未确认。", 503);
    const value = ocProviders(snapshot.list.models.items);
    return json(path === "/api/provider" ? { all: value.providers, default: value.default, nativeProviderAuthenticationKnown: false } : value);
  }
  // One fixed display label for the pi engine, NOT a discovered OpenCode agent.
  if (["/api/agent", "/api/app/agents"].includes(path)) return json([{ name: "pi", description: "pi 原生引擎（展示适配；非 OpenCode agent）", mode: "primary", native: true, hidden: false, permission: [], options: {} }]);
  if (["/api/config", "/api/global/config"].includes(path)) return json({ model: DISPLAY_DEFAULT_MODEL, default_agent: "pi", nativePi: true });
  if (path === "/api/session/status") {
    const result: Record<string, unknown> = {};
    const detail = snapshot.detail;
    if (detail.file && detail.status) result[detail.file] = { type: detail.status.turn.state === "idle" ? "idle" : "busy" };
    return json(result);
  }
  if (directory === null) return unavailable("pi 授权目录尚未确认。", 503);
  const project = { id: "pi-native", name: "pi 授权目录", worktree: directory, time: {}, sandboxes: [], nativePi: true };
  if (path === "/api/path") return json({ worktree: directory, directory, nativePi: true, nativeExecutionDirectoryKnown: false });
  // This is the surface's authorised landing directory, not the OS user's HOME.
  if (path === "/api/fs/home") return json({ home: directory, nativePi: true, nativeOsHomeKnown: false });
  if (path === "/api/config/settings") return json({ projects: [{ id: project.id, path: directory, label: project.name }], lastDirectory: directory, nativePi: true });
  if (path === "/api/project") return json([project]);
  if (path === "/api/project/current") return json(project);
  if (["/api/session", "/api/experimental/session"].includes(path)) {
    if (snapshot.list.sessions === null) return unavailable("pi 会话清单未确认。", 503);
    return json(snapshot.list.sessions.map((row) => ocSession(row, directory)));
  }
  const match = /^\/api\/session\/([^/]+)(\/message)?$/.exec(path);
  if (match) {
    let file: string;
    try { file = decodeURIComponent(match[1]!); } catch { return unavailable("会话标识无效。", 400); }
    if (match[2]) {
      if (snapshot.detail.file !== file || snapshot.detail.phase !== "live") return unavailable("目标 pi 历史尚未完成订阅。", 503);
      return json(ocMessages(snapshot.detail.events, snapshot.detail.liveEvents, file));
    }
    const row = snapshot.list.sessions?.find((item) => item.file === file);
    return row ? json(ocSession(row, directory)) : unavailable("pi 会话未在已确认清单中。", 404);
  }
  // These are disabled surface capabilities, not empty successful backend lists.
  return unavailable();
}
