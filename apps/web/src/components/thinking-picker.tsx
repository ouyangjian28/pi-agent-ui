import React, { useId, useSyncExternalStore } from "react";
import { isThinkingLevel, type ThinkingLevel } from "@pi-agent-ui/protocol/src/composer-input";
import { effectiveModel, MODEL_DEFAULT } from "../ws/draft-model";
import type { ModelSource } from "./model-picker";

const LABELS: readonly (readonly [ThinkingLevel, string])[] = [
  ["off", "关闭"], ["minimal", "最少"], ["low", "低"], ["medium", "中"],
  ["high", "高"], ["xhigh", "很高"], ["max", "最高"],
];

export function ThinkingPicker({ source, choice, freeText, level, onChange }: {
  source: ModelSource; choice: string; freeText: string; level: ThinkingLevel | null;
  onChange: (level: ThinkingLevel | null) => void;
}) {
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot);
  const description = useId();
  const model = effectiveModel(choice, freeText);
  const candidates = snapshot.models.status === "ok" && model !== MODEL_DEFAULT && model !== undefined
    ? snapshot.models.items.filter((item) => model === `${item.provider}/${item.id}` || (!model.includes("/") && item.id === model)) : [];
  const levels = candidates.length === 1 ? candidates[0]?.thinkingLevels : undefined;
  const note = levels === undefined
    ? "尚未确认此模型的思考能力，仅可选默认。请选择清单中的具体模型；未知、自定义或旧服务不猜能力。"
    : "选项按模型能力禁用；用于下一条消息，不代表当前会话设置。发送前仍由真实pi再次确认。";
  const selectedUnsupported = level !== null && !(levels?.includes(level) ?? false);
  return <label className="thinking-picker" title={selectedUnsupported ? `当前选择不可用，已保留草稿；请改选默认或支持级别。${note}` : note}>
    <span>思考</span>
    <select aria-label="下一条思考级别" aria-describedby={description} value={level ?? ""} onChange={(event) => {
      const value = event.target.value;
      if (value === "") onChange(null);
      else if (isThinkingLevel(value) && levels?.includes(value)) onChange(value);
    }}>
      <option value="">默认</option>
      {LABELS.map(([value, label]) => <option key={value} value={value} disabled={!(levels?.includes(value) ?? false)}>{label}{levels === undefined ? "（能力未确认）" : levels.includes(value) ? "" : "（此模型不支持）"}</option>)}
    </select>
    <span id={description} className="sr-only">{selectedUnsupported ? "当前级别不可用；选择已保留，请改选默认或支持级别。" : ""}{note}</span>
  </label>;
}
