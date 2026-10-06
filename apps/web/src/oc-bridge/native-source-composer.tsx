import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { NativeSurfaceHost } from './native-surface-host';
import { activeEditor } from './native-composer-actions';
import { NativeComposerInput } from './native-composer-input';
import { NativeModelControlsScope } from './native-model-controls';
import type { EditorSlot } from '../ws/conversation-state';

export interface NativeEditorProps {
  value: string; editable: boolean; editorKey: string; expanded: boolean;
  bindEditor: (handle: { getValue(): string } | null) => void;
  onChange: (change: { value: string }) => void;
  onKeyDown: (event: KeyboardEvent) => boolean;
}
interface Props {
  host: NativeSurfaceHost; isMobile: boolean;
  renderEditor: (props: NativeEditorProps) => React.ReactNode;
  renderFooter: (props: Record<string, unknown>) => React.ReactNode;
  renderModels: () => React.ReactNode;
}
/** Only native owner facts supply text/settings/attachments/results. The
 * renderer callbacks reuse original controls, without mounting ChatInput's
 * legacy restore/prepare/clear effects. Local state is interaction-only.
 */
export function NativeSourceComposer({ host, isMobile, renderEditor, renderFooter, renderModels }: Props) {
  const { port } = host;
  const snapshot = useSyncExternalStore(port.subscribe, port.getSnapshot);
  const slot = activeEditor(port);
  const targetId = slot?.id ?? '';
  const input = useMemo(() => new NativeComposerInput(port, targetId), [port, targetId]);
  const current = useRef(input); current.current = input;
  const editor = useRef<{ getValue(): string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const finishTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [ime, setIme] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [riskWitness, setRiskWitness] = useState<{ id: string; version: number; operation: EditorSlot['operation'] } | null>(null);
  // This is a DOM identity, not a second text/draft store. Same-file owner
  // transfer keeps CodeMirror's caret/unfinished composition alive; explicit
  // navigation to a different target recreates it and rejects old callbacks.
  const identity = useRef({ targetId, key: targetId });
  if (identity.current.targetId !== targetId) {
    const oldDraft = snapshot.conversation.drafts.get(identity.current.targetId);
    const transferred = !!slot && !slot.isNew && oldDraft?.transferred === true && oldDraft.file === slot.file && oldDraft.result?.status === 'launched';
    identity.current = { targetId, key: transferred ? identity.current.key : targetId };
  }
  const editorKey = identity.current.key;
  useEffect(() => {
    composing.current = false; setIme(false); setFeedback(''); setRiskWitness(null);
    if (finishTimer.current !== null) clearTimeout(finishTimer.current);
    finishTimer.current = null;
  }, [editorKey]);
  useEffect(() => () => { if (finishTimer.current !== null) clearTimeout(finishTimer.current); }, []);
  const ready = snapshot.write.connState === 'ready';
  const pending = slot?.operation?.pending === true;
  const turn = snapshot.detail.status?.turn.state;
  // Native TurnState is a discriminated object, never Source's busy string.
  // Closed/absent/other-file facts cannot advertise a running turn or stop.
  const busy = slot !== null && snapshot.detail.file === slot.file && (turn === 'dispatching' || turn === 'in-flight' || turn === 'settling');
  const unknown = slot?.result?.status === 'unknown';
  const riskConfirmed = !!slot && riskWitness?.id === slot.id && riskWitness.version === slot.version && riskWitness.operation === slot.operation;
  const hasContent = !!slot && (slot.text.trim().length > 0 || slot.attachments.length > 0);
  const canSend = ready && hasContent && !pending && !slot?.uploading && !ime && !busy && (!unknown || riskConfirmed);
  const send = () => {
    if (composing.current || !canSend) return;
    const captured = input;
    void captured.send(riskConfirmed).then(result => {
      if (current.current !== captured) return;
      setFeedback(result.status === 'local' ? result.message : result.status === 'launched' ? '' : '发送未确认成功；草稿已保留，请核对原生状态。');
    }).catch(() => { if (current.current === captured) setFeedback('发送结果未确认；请核对原生状态，勿自动重发。'); });
  };
  const pick = () => { if (ready && !pending && !slot?.uploading) fileInput.current?.click(); };
  const unsupported = () => setFeedback('此功能尚未接入原生通道，不会执行旧后台操作。');
  const radius = isMobile ? '1.5rem' : 'var(--radius-xl)';
  const footer = {
    isMobile, isVSCode: false, sessionId: slot && !slot.isNew ? slot.file : null,
    newSessionDraftOpen: slot?.isNew === true, messageLength: slot?.text.length ?? 0,
    radius, footerPaddingClass: 'px-3 pb-2 pt-1', footerGapClass: 'gap-2',
    footerIconButtonClass: 'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-interactive-hover/50',
    iconSizeClass: 'h-[18px] w-[18px]', sendIconSizeClass: 'h-5 w-5', stopIconSizeClass: 'h-5 w-5',
    canSend, canAbort: ready && busy && !pending, hasContent, isExpandedInput: expanded,
    permissionAutoAcceptEnabled: false, isPermissionAutoAcceptInteractive: false, dictationActive: false,
    onPickLocalFiles: pick, onOpenAttachSheet: pick, onToggleExpandedInput: () => setExpanded(value => !value),
    onPrimaryAction: send, onQueueMessage: unsupported, onTogglePermissionAutoAccept: unsupported,
    onOpenIssuePicker: unsupported, onOpenPrPicker: unsupported, onStartDictation: unsupported,
    onDictationInsert: unsupported, onDictationInsertAndSend: unsupported, onDictationContentHeightChange: () => {},
    onAbort: () => {
      if (!slot || activeEditor(port)?.id !== targetId || !ready || !busy) return;
      const captured = input;
      void port.stop(slot.file).then(() => { if (current.current === captured) setFeedback('停止请求已返回；状态以原生通道为准。'); }).catch(() => { if (current.current === captured) setFeedback('停止结果未确认；状态以原生通道为准。'); });
    },
    isBtw: false, btwSelection: { model: null, agent: null, variant: null },
  };
  return <NativeModelControlsScope port={port} targetId={targetId}>
    <form data-native-composer="true" className={`relative w-full min-w-0 pt-0 pb-4${isMobile ? ' bottom-safe-area oc-mobile-composer' : ''}`} onSubmit={event => { event.preventDefault(); send(); }}
      onCompositionStartCapture={() => {
        if (finishTimer.current !== null) clearTimeout(finishTimer.current);
        finishTimer.current = null;
        composing.current = true; setIme(true); current.current.beginComposition();
      }}
      onCompositionEndCapture={() => {
        const key = identity.current.key;
        if (finishTimer.current !== null) clearTimeout(finishTimer.current);
        // CodeMirror's composition-end DOM flush is deferred. Never enable
        // send before it has run, nor read a different editor after navigation.
        finishTimer.current = setTimeout(() => {
          finishTimer.current = null;
          if (identity.current.key !== key) return;
          const handle = editor.current;
          if (handle) current.current.endComposition(handle.getValue());
          composing.current = false; setIme(false);
        }, 50);
      }}>
      <div data-native-composer-column="true" className="chat-input-column relative overflow-visible">
      <input ref={fileInput} hidden type="file" multiple accept="image/png,image/jpeg,text/*,.ts,.tsx,.js,.py,.json,.md,.yaml,.yml,.csv,.c,.cpp,.rs,.go,.java" onChange={event => {
        const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = '';
        if (files.length) void input.actions.upload(files);
      }} />
      <div className="flex flex-col relative overflow-visible border border-border/80 focus-within:border-interactive-selection-foreground/35 shadow-[0_4px_16px_-4px_rgb(0_0_0_/_0.12)] oc-glass-composer" style={{ borderRadius: radius }}>
        {isMobile && <div className="scrollbar-none relative z-10 flex items-center gap-x-2 overflow-x-auto px-3 pb-0.5 pt-1.5">{renderModels()}</div>}
        {!!slot?.attachments.length && <div className="flex items-center gap-1 px-3 pt-2 flex-wrap">{slot.attachments.map(attachment => <span key={attachment.id} className="inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-1 text-xs"><span className="truncate">{attachment.name}</span><button type="button" disabled={pending} aria-label={`移除 ${attachment.name}`} onClick={() => input.actions.removeAttachment(attachment.id)}>×</button></span>)}</div>}
        {renderEditor({ value: slot?.text ?? '', editable: !!slot, editorKey, expanded, bindEditor: handle => { editor.current = handle; }, onChange: change => { input.change(change.value); }, onKeyDown: event => {
          if (composing.current || event.isComposing || event.keyCode === 229) return false;
          if (event.key === 'Enter' && !event.shiftKey && canSend) { event.preventDefault(); send(); return true; }
          return false;
        } })}
        {renderFooter(footer)}
      </div>
      {slot && <details className="px-3 pt-1 text-xs text-muted-foreground"><summary>自定义模型</summary><input aria-label="自定义模型标识" className="mt-1 w-full rounded border bg-transparent px-2 py-1" value={slot.freeText} disabled={pending} onChange={event => input.actions.setCustomModel(event.currentTarget.value)} placeholder="provider/model；留空使用已选模型" /></details>}
      {unknown && <label className="block px-3 py-1 text-xs"><input type="checkbox" checked={riskConfirmed} onChange={event => setRiskWitness(event.currentTarget.checked && slot ? { id: slot.id, version: slot.version, operation: slot.operation } : null)} /> 已核对上次请求，接受可能重复执行的风险后再发送</label>}
      {!ready && <div role="status" className="px-3 py-1 text-xs">原生通道未就绪，草稿已保留。<button type="button" onClick={() => port.reconnect()}>重新连接</button></div>}
      {(slot?.uploading || slot?.uploadError || feedback || (slot?.result && slot.result.status !== 'launched')) && <div role="status" className="px-3 py-1 text-xs">{slot?.uploading ? '附件上传中，暂不发送。' : slot?.uploadError || feedback || '原生请求尚未确认成功；草稿保留，不自动重发。'}</div>}
      </div>
    </form>
  </NativeModelControlsScope>;
}
