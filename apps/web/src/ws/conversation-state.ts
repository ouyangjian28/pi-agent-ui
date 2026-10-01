// R1 v6 §3.1：页面、活动订阅目标、编辑槽与发送事实分立。
// 本层不解释 WS 帧，不自动发送/停止/回答；回执从真 WriteClient 的 Promise 进入。
import { isUploadedAttachment, ATTACHMENT_MAX_COUNT, ATTACHMENT_TOTAL_MAX_BYTES, type ThinkingLevel, type UploadedAttachmentDTO } from "@pi-agent-ui/protocol/src/composer-input";

async function uploadAttachment(file: File, signal: AbortSignal): Promise<UploadedAttachmentDTO> {
  const response = await fetch("/api/attachments", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/octet-stream", "X-Attachment-Name": encodeURIComponent(file.name) }, body: file, signal });
  if (!response.ok) throw new Error("附件上传失败；请检查类型、大小和登录状态后重试。");
  const value: unknown = await response.json();
  if (value === null || typeof value !== "object" || !("attachment" in value) || !("ok" in value) || value.ok !== true || !isUploadedAttachment(value.attachment)) throw new Error("附件上传回执无效；未加入消息。");
  return value.attachment;
}
import type { WriteSendOutcomeDTO } from "@pi-agent-ui/protocol/src/contracts";
import { WriteSendError, type WriteClientSurface } from "./write-client";

export type SendResult =
  | { readonly status: "launched"; readonly outcome: Extract<WriteSendOutcomeDTO, { kind: "launched" }> }
  | { readonly status: "rejected"; readonly outcome: Exclude<WriteSendOutcomeDTO, { kind: "launched" | "gate-failed" }> }
  | { readonly status: "local"; readonly message: string; readonly kind: "not-ready" | "local-invalid" | "closed" | "in-flight" }
  | { readonly status: "unknown"; readonly message: string; readonly outcome?: Extract<WriteSendOutcomeDTO, { kind: "gate-failed" }> };

/** 请求级 server（如 4402）不证明未启动；绝不把 retryable 当自动补发授权。 */
export function classifySend(outcome: WriteSendOutcomeDTO): SendResult {
  if (outcome.kind === "launched") return { status: "launched", outcome };
  if (outcome.kind === "gate-failed") return { status: "unknown", outcome, message: "可能已受理，结果尚未确认。请先查看目标会话，再次发送可能重复执行。" };
  return { status: "rejected", outcome };
}
export function classifySendError(error: unknown, wasReady: boolean): SendResult {
  if (error instanceof WriteSendError) {
    if (error.kind === "server" || error.kind === "transport" || (error.kind === "closed" && wasReady)) {
      return { status: "unknown", message: "可能已受理，结果尚未确认。请先查看目标会话，再次发送可能重复执行。" };
    }
    return { status: "local", kind: error.kind, message: error.message };
  }
  return { status: "unknown", message: "可能已受理，结果尚未确认。再次发送可能重复执行。" };
}
export type PageIntent = { readonly kind: "list" } | { readonly kind: "draft"; readonly id: string } | { readonly kind: "session"; readonly file: string };
export type DraftPhase = "editing" | "sending" | "in-flight-away" | "settled-launched" | "settled-rejected" | "settled-unknown";
export interface SendOperation {
  readonly id: number;
  readonly client: WriteClientSurface;
  readonly version: number;
  readonly text: string;
  readonly pending: boolean;
}
export interface EditorSlot {
  readonly id: string;
  readonly file: string;
  readonly isNew: boolean;
  readonly text: string;
  readonly version: number;
  readonly modelChoice: string;
  readonly freeText: string;
  readonly thinkingLevel: ThinkingLevel | null;
  readonly attachments: readonly UploadedAttachmentDTO[];
  readonly uploading: boolean;
  readonly uploadError: string | null;
  readonly phase: DraftPhase;
  readonly result: SendResult | null;
  readonly operation: SendOperation | null;
  readonly transferred: boolean;
}
export interface ConversationSnapshot {
  readonly view: PageIntent;
  readonly activeFile: string | null;
  readonly drafts: ReadonlyMap<string, EditorSlot>;
  readonly sessions: ReadonlyMap<string, EditorSlot>;
  readonly revision: number;
}
const WAIT_MS = 20_000;

/** RealApp 持有单实例；重连壳不卸载本 owner，呈现页隐藏不改变 activeFile。 */
export class ConversationState {
  private snapshot: ConversationSnapshot = { view: { kind: "list" }, activeFile: null, drafts: new Map(), sessions: new Map(), revision: 0 };
  private readonly listeners = new Set<() => void>();
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private currentClient: WriteClientSurface | null = null;
  private seq = 0;
  private draftSeq = 0;
  private disposed = false;
  private readonly uploads = new Map<string, AbortController>();
  constructor(private readonly refresh: () => void = () => {}, private readonly waitMs = WAIT_MS, private readonly uploader = uploadAttachment) {}
  readonly getSnapshot = (): ConversationSnapshot => this.snapshot;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(patch: Partial<ConversationSnapshot>): void {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...patch, revision: this.snapshot.revision + 1 };
    for (const listener of this.listeners) listener();
  }
  private slot(id: string): EditorSlot | undefined { return this.snapshot.drafts.get(id) ?? this.snapshot.sessions.get(id); }
  private put(slot: EditorSlot): void {
    const key = slot.isNew ? "drafts" : "sessions";
    this.publish({ [key]: new Map(this.snapshot[key]).set(slot.id, slot) });
  }
  private blank(id: string, file: string, isNew: boolean, modelChoice = "__default__"): EditorSlot {
    return { id, file, isNew, text: "", version: 0, modelChoice, freeText: "", thinkingLevel: null, attachments: [], uploading: false, uploadError: null, phase: "editing", result: null, operation: null, transferred: false };
  }
  setClient(client: WriteClientSurface | null): void {
    if (this.currentClient === client) return;
    this.currentClient = client;
    for (const slot of [...this.snapshot.drafts.values(), ...this.snapshot.sessions.values()]) {
      if (slot.operation?.pending && slot.operation.client !== client) {
        this.put({ ...slot, phase: "settled-unknown", result: { status: "unknown", message: "连接已更换，上一条可能已受理；不会自动补发。" } });
      }
    }
  }
  get canCreate(): boolean {
    return ![...this.snapshot.drafts.values(), ...this.snapshot.sessions.values()].some((d) => d.operation?.pending);
  }
  create(file: string, modelChoice = "__default__"): string | null {
    if (!this.canCreate) return null;
    const id = `draft-${++this.draftSeq}`;
    this.put(this.blank(id, file, true, modelChoice));
    this.publish({ view: { kind: "draft", id }, activeFile: null });
    return id;
  }
  edit(id: string, text: string): void {
    const slot = this.slot(id);
    if (slot) this.put({ ...slot, text, version: slot.version + 1 });
  }
  configure(id: string, modelChoice: string, freeText: string): void {
    const slot = this.slot(id);
    if (slot) this.put({ ...slot, modelChoice, freeText, version: slot.version + 1 });
  }
  configureThinking(id: string, thinkingLevel: ThinkingLevel | null): void {
    const slot = this.slot(id);
    if (slot) this.put({ ...slot, thinkingLevel, version: slot.version + 1 });
  }
  async upload(id: string, files: readonly File[]): Promise<void> {
    const slot = this.slot(id);
    if (this.disposed || !slot || slot.uploading || slot.operation?.pending || files.length === 0) return;
    if (slot.attachments.length + files.length > ATTACHMENT_MAX_COUNT) { this.put({ ...slot, uploadError: "每条最多8个附件。" }); return; }
    const controller = new AbortController(); this.uploads.set(id, controller);
    const deadline = setTimeout(() => controller.abort(), 30_000);
    this.put({ ...slot, uploading: true, uploadError: null });
    try {
      for (const file of files) {
        if (controller.signal.aborted) throw new Error("cancelled");
        const item = await this.uploader(file, controller.signal);
        const current = this.slot(id);
        if (this.disposed || !current || this.uploads.get(id) !== controller) return;
        if (!isUploadedAttachment(item) || current.attachments.reduce((sum, entry) => sum + entry.size, item.size) > ATTACHMENT_TOTAL_MAX_BYTES) throw new Error("limit");
        this.put({ ...current, attachments: [...current.attachments, item], version: current.version + 1 });
      }
    } catch {
      const current = this.slot(id); if (current && !this.disposed) this.put({ ...current, uploadError: "附件上传未完成；已成功的附件保留，未成功的不会发送。仅支持PNG/JPEG与UTF-8文本/代码，图片≤10MiB、文本≤48KiB。" });
    } finally {
      clearTimeout(deadline); if (this.uploads.get(id) === controller) this.uploads.delete(id);
      const current = this.slot(id); if (current && !this.disposed) this.put({ ...current, uploading: false });
    }
  }
  removeAttachment(id: string, attachmentId: string): void {
    const slot = this.slot(id); if (!slot || slot.operation?.pending) return;
    this.put({ ...slot, attachments: slot.attachments.filter((item) => item.id !== attachmentId), version: slot.version + 1, uploadError: null });
    // 未提交对象可删；已固定对象由服务端拒删，不能因UI移除破坏恢复。
    void fetch(`/api/attachments/${attachmentId}`, { method: "DELETE", credentials: "same-origin" }).catch(() => {});
  }
  back(): void {
    const view = this.snapshot.view;
    if (view.kind === "draft") {
      const slot = this.snapshot.drafts.get(view.id);
      if (slot?.phase === "editing" && slot.operation === null && !slot.uploading && slot.attachments.length === 0) {
        const drafts = new Map(this.snapshot.drafts); drafts.delete(view.id); this.publish({ drafts });
      } else if (slot?.phase === "sending") this.put({ ...slot, phase: "in-flight-away" });
    }
    this.publish({ view: { kind: "list" } }); // session 返回保 activeFile，零退订
  }
  open(file: string): string {
    const id = `session:${file}`;
    if (!this.snapshot.sessions.has(id)) this.put(this.blank(id, file, false));
    // 成功首发残稿只转移一次；再开不覆盖 A 后来编辑的文本。
    for (const draft of this.snapshot.drafts.values()) {
      if (draft.file !== file || draft.phase !== "settled-launched" || draft.transferred) continue;
      const session = this.snapshot.sessions.get(id)!;
      if (session.version === 0 && session.text === "") this.put({ ...session, text: draft.text, version: draft.version, modelChoice: draft.modelChoice, freeText: draft.freeText, thinkingLevel: draft.thinkingLevel, attachments: draft.attachments });
      this.put({ ...draft, transferred: true });
    }
    this.publish({ view: { kind: "session", file }, activeFile: file });
    return id;
  }
  restore(id: string): void {
    const slot = this.snapshot.drafts.get(id);
    if (!slot) return;
    if (slot.phase === "settled-launched") { this.open(slot.file); return; }
    if (slot.phase === "in-flight-away") this.put({ ...slot, phase: "sending" });
    this.publish({ view: { kind: "draft", id }, activeFile: null });
  }
  /** 只有明确用户确认后才调用；仍 pending 的原 client 不释放，必须先重建 client。 */
  canRetry(id: string, confirmed: boolean): boolean {
    const slot = this.slot(id);
    if (!slot || slot.phase !== "settled-unknown") return true;
    return confirmed && !(slot.operation?.pending && slot.operation.client === this.currentClient);
  }
  send(id: string, model?: string, confirmed = false): Promise<SendResult> {
    const slot = this.slot(id);
    const client = this.currentClient;
    if (!slot || !client) return Promise.resolve({ status: "local", kind: "not-ready", message: "连接未就绪，未发送。" });
    if (!this.canRetry(id, confirmed) || (slot.operation?.pending && slot.operation.client === client)) {
      return Promise.resolve({ status: "local", kind: "in-flight", message: "原操作尚在途；请先查看结果，必要时确认风险并重连后再发。" });
    }
    if (slot.uploading) return Promise.resolve({ status: "local", kind: "in-flight", message: "附件正在上传，未发送。" });
    const wasReady = client.getSnapshot().connState === "ready";
    const op: SendOperation = { id: ++this.seq, client, version: slot.version, text: slot.text, pending: true };
    this.put({ ...slot, operation: op, phase: "sending", result: null });
    this.timers.set(op.id, setTimeout(() => {
      this.timers.delete(op.id);
      const current = this.slot(id);
      if (current?.operation?.id === op.id && current.operation.pending) {
        this.put({ ...current, phase: "settled-unknown", result: { status: "unknown", message: "等待已截止，但原请求仍在途，可能已受理；不会自动补发。" } });
      }
    }, this.waitMs));
    let request: Promise<WriteSendOutcomeDTO>;
    try {
      request = slot.thinkingLevel === null && slot.attachments.length === 0
        ? client.sendPrompt(slot.file, slot.text, model)
        : client.sendPrompt(slot.file, slot.text, model, undefined, {
          ...(slot.thinkingLevel === null ? {} : { thinkingLevel: slot.thinkingLevel }),
          ...(slot.attachments.length === 0 ? {} : { attachments: slot.attachments.map((item) => item.id) }),
        });
    }
    catch (error) { request = Promise.reject(error); }
    return request.then(classifySend, (error: unknown) => classifySendError(error, wasReady)).then((result) => {
      const timer = this.timers.get(op.id); if (timer !== undefined) clearTimeout(timer); this.timers.delete(op.id);
      if (this.disposed) return result;
      const current = this.slot(id);
      // 记账独立于页面：迟到成功仍刷新列表，但旧操作不覆盖一次显式重试。
      if (result.status === "launched") this.refresh();
      if (!current || current.operation?.id !== op.id) return result;
      const phase = result.status === "launched" ? "settled-launched" : result.status === "unknown" ? "settled-unknown" : "settled-rejected";
      // 清稿门（三元）：版本不是文本相等；重连后旧 client 不清稿。
      const clear = result.status === "launched" && op.client === this.currentClient && current.version === op.version;
      this.put({ ...current, text: clear ? "" : current.text, attachments: clear ? [] : current.attachments, phase, result, operation: { ...op, pending: false } });
      const view = this.snapshot.view;
      // 导航门独立：B/list 不抢页；恢复中的 D 正常进 A。
      if (slot.isNew && result.status === "launched" && view.kind === "draft" && view.id === id) this.open(slot.file);
      return result;
    });
  }
  dispose(): void {
    this.disposed = true;
    for (const controller of this.uploads.values()) controller.abort(); this.uploads.clear();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear(); this.listeners.clear();
  }
}
