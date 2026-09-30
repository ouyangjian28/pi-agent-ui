// R1：旧表单壳退役。兼容导出只装配同一个真实 WriteComposer，供旧行为测试迁移；
// RealApp 不再渲染本适配器。autoFile/偏好/守卫只有 ws/draft-model 一份实现。
import React, { useEffect, useRef, useSyncExternalStore } from "react";
import { ConversationState } from "../ws/conversation-state";
import { autoFile, readLastModel, writeLastModel, effectiveModel, MODEL_DEFAULT } from "../ws/draft-model";
import { WriteComposer } from "./write-composer";
import type { ModelSource } from "./model-picker";
import type { WriteClientSurface } from "../ws/write-client";
import type { RootsState } from "../ws/ws-client";
export { autoFile, readLastModel, writeLastModel, isPersistableModel } from "../ws/draft-model";
export type ModelsSource = Omit<ModelSource, "requestRoots">;
export interface RootsSource { readonly requestRoots: () => void; readonly subscribe: (listener: () => void) => () => void; readonly getSnapshot: () => { readonly roots: RootsState }; }
export type NewSessionSource = ModelSource;
export function NewSession({ wsClient, writeClient, onLaunched, onCancel }: { wsClient: ModelSource; writeClient: WriteClientSurface; onLaunched: (file: string) => void; onCancel: () => void }) {
  const ownerRef = useRef<ConversationState | null>(null);
  const launchedRef = useRef(onLaunched); launchedRef.current = onLaunched;
  const idRef = useRef<string | null>(null);
  if (!ownerRef.current) {
    const owner = new ConversationState(); ownerRef.current = owner; owner.setClient(writeClient);
    idRef.current = owner.create(autoFile(), readLastModel() ?? MODEL_DEFAULT);
  }
  const owner = ownerRef.current; const snapshot = useSyncExternalStore(owner.subscribe, owner.getSnapshot);
  const id = idRef.current!; const slot = snapshot.drafts.get(id)!;
  useEffect(() => { owner.setClient(writeClient); }, [owner, writeClient]);
  useEffect(() => () => owner.dispose(), [owner]);
  return <WriteComposer client={writeClient} file={slot.file} editor={{
    slot, source: wsClient, isNew: true,
    onEdit: (text) => owner.edit(id, text), onConfigure: (choice, text) => owner.configure(id, choice, text),
    onCancel, onViewTarget: () => {},
    onSend: async (confirmed) => {
      const value = effectiveModel(slot.modelChoice, slot.freeText);
      writeLastModel(value ?? MODEL_DEFAULT);
      const result = await owner.send(id, value, confirmed);
      if (result.status === "launched") launchedRef.current(slot.file);
      return result;
    },
  }} />;
}
