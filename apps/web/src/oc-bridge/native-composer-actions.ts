// Explicit user-action boundary for original OpenChamber composer controls.
// No selection-store subscriptions, automatic default restoration or draft copy.
import { isThinkingLevel, type ThinkingLevel } from "@pi-agent-ui/protocol/src/composer-input";
import { MODEL_DEFAULT, effectiveModel, isPersistableModel, isSendableModel } from "../ws/draft-model";
import type { EditorSlot, SendResult } from "../ws/conversation-state";
import { DISPLAY_DEFAULT_MODEL } from "./oc-read-projection";
import type { NativePiPort } from "./native-pi-port";

export function activeEditor(port: NativePiPort): EditorSlot | null {
  const state = port.getSnapshot().conversation;
  if (state.view.kind === "draft") return state.drafts.get(state.view.id) ?? null;
  if (state.view.kind === "session") {
    // Native session slots are keyed by owner id, not transport filename.
    // Resolve the page's file through owner facts without duplicating id rules.
    for (const slot of state.sessions.values()) if (slot.file === state.view.file) return slot;
  }
  return null;
}
export function supportedThinking(port: NativePiPort, slot: EditorSlot): readonly ThinkingLevel[] | undefined {
  const model = effectiveModel(slot.modelChoice, slot.freeText);
  const catalogue = port.getSnapshot().list.models;
  const candidates = catalogue.status === "ok" && model !== undefined
    ? catalogue.items.filter((item) => model === `${item.provider}/${item.id}` || (!model.includes("/") && item.id === model)) : [];
  return candidates.length === 1 ? candidates[0]?.thinkingLevels : undefined;
}
function local(message: string): SendResult { return { status: "local", kind: "local-invalid", message }; }
/** Target id is the native owner slot, never an OpenCode optimistic message id.
 * Old UI effects cannot invoke this implicitly: only user callbacks bind it.
 */
export function nativeComposerActions(port: NativePiPort, id: string) {
  const slot = () => { const current = activeEditor(port); return current?.id === id ? current : null; };
  const modelChoice = (provider: string, modelId: string): string | null => {
    const key = `${provider}/${modelId}`;
    const choice = key === DISPLAY_DEFAULT_MODEL ? MODEL_DEFAULT : key;
    const models = port.getSnapshot().list.models;
    return isPersistableModel(choice) && (choice === MODEL_DEFAULT || (models.status === "ok" && models.items.some((model) => model.provider === provider && model.id === modelId))) ? choice : null;
  };
  return {
    edit(text: string): boolean { if (!slot()) return false; port.owner.edit(id, text); return true; },
    chooseModel(provider: string, modelId: string): boolean {
      const current = slot(); if (!current || current.operation?.pending) return false;
      const choice = modelChoice(provider, modelId); if (choice === null) return false;
      // Preserve unsupported old effort instead of silently lowering it.
      port.owner.configure(id, choice, ""); return true;
    },
    chooseModelAndThinking(provider: string, modelId: string, value: string | null | undefined): boolean {
      const current = slot(); if (!current || current.operation?.pending) return false;
      const choice = modelChoice(provider, modelId); if (choice === null) return false;
      const level = value ?? null;
      const levels = supportedThinking(port, { ...current, modelChoice: choice, freeText: "" });
      if (level !== null && (!isThinkingLevel(level) || !levels?.includes(level))) return false;
      // Validate both before either mutation: invalid mobile effort must not
      // partially switch the selected model or destroy its custom draft.
      port.owner.configure(id, choice, "");
      port.owner.configureThinking(id, level); return true;
    },
    setCustomModel(text: string): boolean {
      const current = slot(); if (!current || current.operation?.pending) return false;
      // Unfinished/invalid text is a draft fact, not silently normalised away.
      port.owner.configure(id, current.modelChoice, text); return true;
    },
    chooseThinking(value: string | null | undefined): boolean {
      const current = slot(); if (!current || current.operation?.pending) return false;
      if (value == null) { port.owner.configureThinking(id, null); return true; }
      if (!isThinkingLevel(value) || !supportedThinking(port, current)?.includes(value)) return false;
      port.owner.configureThinking(id, value); return true;
    },
    async send(riskConfirmed = false): Promise<SendResult> {
      const current = slot(); if (!current) return local("目标输入区已切换，未发送。");
      const model = effectiveModel(current.modelChoice, current.freeText);
      if (!isSendableModel(model)) return local("模型标识无效，草稿已保留。");
      if (current.thinkingLevel !== null && !supportedThinking(port, current)?.includes(current.thinkingLevel)) return local("当前模型的思考级别未确认或不支持，选择与草稿已保留。");
      // Unknown/pending/upload/client/version checks remain the native owner's.
      return port.send(id, model, riskConfirmed);
    },
    async upload(files: readonly File[]): Promise<void> { if (slot()) await port.owner.upload(id, files); },
    removeAttachment(objectId: string): boolean { if (!slot()) return false; port.owner.removeAttachment(id, objectId); return true; },
  };
}
