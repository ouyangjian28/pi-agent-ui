// Narrow, build-time behaviour overlay. Never rewrites the source snapshot.
// Literal matching is deliberate: source drift fails closed, not a partial wire.
function once(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Native model binding anchor missing/ambiguous: ${before.slice(0, 75)}`);
  return source.replace(before, after);
}
export function nativeModelControlsTransform(source) {
  let next = 'import { useNativeModelControls } from "@pi-native/model-controls";\n' + source;
  next = once(next, '    selection,\n    sessionId: controlledSessionId,', '    selection: originalSelection,\n    sessionId: controlledSessionId,');
  next = once(next, '    const { t } = useI18n();', '    const nativeModelControls = useNativeModelControls();\n    const selection = nativeModelControls?.selection ?? originalSelection;\n    const { t } = useI18n();');
  next = once(next, '    const handleVariantSelect = React.useCallback((variant: string | undefined) => {', '    const handleVariantSelect = React.useCallback((variant: string | undefined) => {\n        if (nativeModelControls) { nativeModelControls.actions.chooseThinking(variant ?? null); return; }');
  // Include the binding in the existing callback's dependency array; otherwise
  // a reused component could act on the previous session's native slot.
  next = once(next, '    }, [commitVariantSelectionForModel, currentModelId, currentProviderId]);', '    }, [nativeModelControls, commitVariantSelectionForModel, currentModelId, currentProviderId]);');
  next = once(next, "        options?: { applyVariant?: boolean; variant?: string | undefined; agentName?: string | null },\n    ) => {\n        try {", "        options?: { applyVariant?: boolean; variant?: string | undefined; agentName?: string | null },\n    ) => {\n        if (nativeModelControls) {\n            const applied = options?.applyVariant\n                ? nativeModelControls.actions.chooseModelAndThinking(providerId, modelId, options.variant ?? null)\n                : nativeModelControls.actions.chooseModel(providerId, modelId);\n            if (applied) { setAgentMenuOpen(false); if (isCompact) closeMobilePanel(); requestAnimationFrame(focusChatInput); }\n            return;\n        }\n        try {");
  next = once(next, '        const handleMobileModelApply = (providerId: string, modelId: string, variant: string | null | undefined) => {', '        const handleMobileModelApply = (providerId: string, modelId: string, variant: string | null | undefined) => {\n            if (nativeModelControls) {\n                if (nativeModelControls.actions.chooseModelAndThinking(providerId, modelId, variant ?? null)) { setExpandedMobileModelKey(null); closeMobilePanel(); requestAnimationFrame(focusChatInput); }\n                return;\n            }');
  return next;
}
