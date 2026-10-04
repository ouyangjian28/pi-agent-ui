import React, { createContext, useContext, useMemo, useSyncExternalStore } from "react";
import { effectiveModel } from "../ws/draft-model";
import type { NativePiPort } from "./native-pi-port";
import { DISPLAY_DEFAULT_MODEL } from "./oc-read-projection";
import { nativeComposerActions } from "./native-composer-actions";

type Actions = ReturnType<typeof nativeComposerActions>;
export interface NativeModelControlsBinding {
  readonly actions: Actions;
  readonly selection: { readonly model: { readonly providerId: string; readonly modelId: string }; readonly agent: string; readonly variant: string | null };
}
const Context = createContext<NativeModelControlsBinding | null>(null);
export const useNativeModelControls = (): NativeModelControlsBinding | null => useContext(Context);
/** Wrap only owner-bound composer controls, not a global multi-column surface.
 * Explicit target id prevents a stale/hidden control from configuring another
 * session. Selection is a read projection, never a second draft store.
 */
export function NativeModelControlsScope({ port, targetId, children }: { readonly port: NativePiPort; readonly targetId: string; readonly children: React.ReactNode }) {
  const snapshot = useSyncExternalStore(port.subscribe, port.getSnapshot);
  const slot = snapshot.conversation.drafts.get(targetId) ?? snapshot.conversation.sessions.get(targetId) ?? null;
  const actions = useMemo(() => nativeComposerActions(port, targetId), [port, targetId]);
  const binding = useMemo(() => {
    const model = slot ? effectiveModel(slot.modelChoice, slot.freeText) ?? DISPLAY_DEFAULT_MODEL : DISPLAY_DEFAULT_MODEL;
    const slash = model.indexOf("/");
    return { actions, selection: { model: { providerId: slash > 0 ? model.slice(0, slash) : "", modelId: slash > 0 ? model.slice(slash + 1) : model }, agent: "pi", variant: slot?.thinkingLevel ?? null } };
  }, [actions, snapshot, slot]);
  return <Context.Provider value={binding}>{children}</Context.Provider>;
}
