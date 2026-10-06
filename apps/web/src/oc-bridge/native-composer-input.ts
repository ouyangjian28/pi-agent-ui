// Input-event adapter only. The existing owner remains the sole draft/model/
// version/client/attachment authority. IME is transient UI state, not a draft.
import type { EditorSlot, SendResult } from '../ws/conversation-state';
import { activeEditor, nativeComposerActions } from './native-composer-actions';
import type { NativePiPort } from './native-pi-port';
export interface NativeInputKey {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly isComposing?: boolean;
  readonly keyCode?: number;
}
export class NativeComposerInput {
  private ime = false;
  readonly actions: ReturnType<typeof nativeComposerActions>;
  constructor(private readonly port: NativePiPort, readonly targetId: string) {
    this.actions = nativeComposerActions(port, targetId);
  }
  get slot(): EditorSlot | null {
    const current = activeEditor(this.port);
    return current?.id === this.targetId ? current : null;
  }
  get composing(): boolean { return this.ime; }
  change(rawText: string): boolean { return this.actions.edit(rawText); }
  beginComposition(): boolean {
    const current = this.slot;
    if (!current) return false;
    // Set the transient flag before owner listeners render. CodeMirror may
    // defer onChange; touching the OWNER version protects bytes from late ACK.
    this.ime = true;
    if (!this.change(current.text)) { this.ime = false; return false; }
    return true;
  }
  endComposition(controlRawText: string): boolean {
    this.ime = false;
    // The renderer must supply the actual controlled editor value after its
    // composition flush; this adapter cannot guess DOM text or normalise it.
    return this.change(controlRawText);
  }
  keyAction(event: NativeInputKey): 'send' | 'editor' {
    return this.slot && event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229 && !this.ime ? 'send' : 'editor';
  }
  send(riskConfirmed = false): Promise<SendResult> {
    if (this.ime) return Promise.resolve({ status: 'local', kind: 'local-invalid', message: '输入法仍在组字，未发送；草稿已保留。' });
    // No optimistic clear, implicit retry, Source prepare or shadow store.
    return this.actions.send(riskConfirmed);
  }
}
