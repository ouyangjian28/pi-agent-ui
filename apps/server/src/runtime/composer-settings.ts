import { isThinkingLevel, LIMITS, type ThinkingLevel } from "@pi-agent-ui/protocol";
import { RpcSettingsChannel, SettingsRpcError } from "./rpc-settings-channel.ts";
export interface ComposerModel {
  readonly id: string;
  readonly provider: string;
  readonly modelId: string;
  readonly name: string;
  readonly imageInput: boolean;
}
export interface ConfirmedComposerSettings {
  readonly model: ComposerModel;
  readonly thinkingLevel: ThinkingLevel;
  readonly thinkingLevels: readonly ThinkingLevel[];
}
const object = (v: unknown): Record<string, unknown> => {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new SettingsRpcError("malformed");
  return v as Record<string, unknown>;
};
function modelOf(value: unknown): ComposerModel {
  const m = object(value);
  if (typeof m.provider !== "string" || typeof m.id !== "string") throw new SettingsRpcError("malformed");
  const id = `${m.provider}/${m.id}`;
  if (m.provider.length === 0 || m.id.length === 0 || id.length > 128 || !LIMITS.modelPattern.test(id)) throw new SettingsRpcError("malformed");
  if (!Array.isArray(m.input) || !m.input.every((item: unknown) => item === "text" || item === "image") || !m.input.includes("text")) throw new SettingsRpcError("malformed");
  return { id, provider: m.provider, modelId: m.id, name: typeof m.name === "string" ? m.name.slice(0, 160) : id, imageInput: m.input.includes("image") };
}
function idleState(value: unknown): { model: ComposerModel | null; thinkingLevel: ThinkingLevel } {
  const s = object(value);
  // Missing facts are not an idle assertion (including old/malformed pi responses).
  if (typeof s.isStreaming !== "boolean" || typeof s.isCompacting !== "boolean" || !Number.isInteger(s.pendingMessageCount) || (s.pendingMessageCount as number) < 0 || !isThinkingLevel(s.thinkingLevel)) throw new SettingsRpcError("malformed");
  if (s.isStreaming || s.isCompacting || s.pendingMessageCount !== 0) throw new SettingsRpcError("busy");
  return { model: s.model === null || s.model === undefined ? null : modelOf(s.model), thinkingLevel: s.thinkingLevel };
}
/** Configure only while the caller holds its send-preparation lease. Never persists global defaults. */
export async function prepareComposerSettings(
  channel: RpcSettingsChannel,
  generation: number,
  requested: { readonly model?: string; readonly thinkingLevel?: ThinkingLevel; readonly requireImage?: boolean },
  isIdle: () => boolean,
): Promise<ConfirmedComposerSettings> {
  let mutated = false;
  const guard = (): void => { if (!isIdle()) throw new SettingsRpcError("busy"); };
  const state = async () => { guard(); const result = idleState(await channel.request(generation, { type: "get_state" })); guard(); return result; };
  try {
    let current = await state();
    let selected = current.model;
    if (requested.model !== undefined && requested.model !== current.model?.id) {
      guard(); const listing = object(await channel.request(generation, { type: "get_available_models" }));
      if (!Array.isArray(listing.models) || listing.models.length > 2048) throw new SettingsRpcError("malformed");
      const models = listing.models.map(modelOf);
      selected = models.find(model => model.id === requested.model) ?? null;
      if (selected === null) { const aliases = models.filter(model => model.modelId === requested.model); if (aliases.length === 1) selected = aliases[0]!; }
      if (selected === null || (requested.requireImage === true && !selected.imageInput)) throw new SettingsRpcError("rejected");
      current = await state(); // reread pi busy facts immediately before mutation
      guard(); mutated = true;
      const result = modelOf(await channel.request(generation, { type: "set_model", provider: selected.provider, modelId: selected.modelId }));
      if (result.id !== selected.id) throw new SettingsRpcError("malformed");
      current = await state();
    }
    if (selected === null || current.model?.id !== selected.id || (requested.requireImage === true && !selected.imageInput)) throw new SettingsRpcError("rejected");
    guard(); const response = object(await channel.request(generation, { type: "get_available_thinking_levels" }));
    if (!Array.isArray(response.levels) || response.levels.length === 0 || response.levels.length > 7 || !response.levels.every(isThinkingLevel) || new Set(response.levels).size !== response.levels.length) throw new SettingsRpcError("malformed");
    const levels: ThinkingLevel[] = response.levels;
    if (requested.thinkingLevel !== undefined) {
      if (!levels.includes(requested.thinkingLevel)) throw new SettingsRpcError("rejected");
      current = await state();
      if (current.model?.id !== selected.id) throw new SettingsRpcError("stale");
      if (current.thinkingLevel !== requested.thinkingLevel) {
        guard(); mutated = true;
        await channel.request(generation, { type: "set_thinking_level", level: requested.thinkingLevel });
      }
    }
    const final = await state();
    if (final.model?.id !== selected.id || (requested.thinkingLevel !== undefined && final.thinkingLevel !== requested.thinkingLevel) || !levels.includes(final.thinkingLevel)) throw new SettingsRpcError("rejected");
    return { model: final.model, thinkingLevel: final.thinkingLevel, thinkingLevels: levels };
  } catch (error) {
    // A failed setter/validation can leave partial state. No later prompt in that generation.
    if (mutated || (error instanceof SettingsRpcError && error.code === "malformed")) channel.quarantine(generation);
    throw error;
  }
}
