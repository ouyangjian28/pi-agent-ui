import React, { useEffect, useSyncExternalStore } from "react";
import type { ModelsState } from "../ws/ws-client";
import { MODEL_DEFAULT, isPersistableModel, effectiveModel, isSendableModel } from "../ws/draft-model";
export interface ModelSource {
  readonly requestModels: () => void;
  readonly requestRoots: () => void;
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => { readonly state: unknown; readonly models: ModelsState };
}
export function ModelPicker({ source, choice, freeText, onConfigure }: { source: ModelSource; choice: string; freeText: string; onConfigure: (choice: string, freeText: string) => void }) {
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot);
  const models = snapshot.models;
  useEffect(() => { source.requestModels(); source.requestRoots(); }, [source, snapshot.state]);
  const custom = freeText.trim();
  const selected = custom || choice;
  const legal = isSendableModel(effectiveModel(choice, freeText));
  const listed = models.items.some((model) => `${model.provider}/${model.id}` === selected);
  return <div className="model-picker">
    <label>待发模型<select aria-label="模型选择" value={selected} onChange={(event) => {
      if (isPersistableModel(event.target.value)) onConfigure(event.target.value, "");
    }}>
      <option value={MODEL_DEFAULT}>默认（pi 配置）</option>
      {models.status === "loading" && <option value={MODEL_DEFAULT} disabled>模型清单加载中…</option>}
      {models.status === "failed" && <option value={MODEL_DEFAULT} disabled>模型清单加载失败（可手打 id）</option>}
      {selected !== MODEL_DEFAULT && (!listed || models.status !== "ok") && <option value={selected}>自定义：{selected}</option>}
      {models.status === "ok" && models.items.map((model) => {
        const value = `${model.provider}/${model.id}`; const usable = value !== MODEL_DEFAULT && isPersistableModel(value);
        return <option key={value} value={value} disabled={!usable}>{model.provider} / {model.id}{model.context ? `（${model.context}）` : ""}{usable ? "" : "（不可用）"}</option>;
      })}
    </select></label>
    <details className="custom-model" open={freeText !== "" || !legal || models.status === "failed"}>
      <summary>自定义模型</summary>
      <label>模型 id 直达<input aria-label="模型 id 直达" value={freeText} placeholder="provider/model-id" onChange={(event) => onConfigure(choice, event.target.value)} /></label>
    </details>
    {!legal && <small role="alert">模型标识非法；__ 前缀为界面保留值，回默认请选「默认」</small>}
    {models.status === "failed" && <p role="status">模型清单拉取失败（{(models.cause ?? "原因未知").slice(0, 200)}）——可手打模型 id 继续</p>}
  </div>;
}
