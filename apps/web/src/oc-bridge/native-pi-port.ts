// OpenChamber wiring substrate, not an OpenCode server/protocol implementation.
// UI projections must read these native facts; they cannot own a second draft.
import { LIMITS } from "@pi-agent-ui/protocol/src/contracts";
import { ConversationState, type ConversationSnapshot, type SendResult } from "../ws/conversation-state";
import { WsClient, type SessionsSnapshot, type WebSocketFactory } from "../ws/ws-client";
import { SubscribeClient, type SessionDetailSnapshot } from "../ws/subscribe-client";
import { WriteClient, type WriteSnapshot } from "../ws/write-client";

export interface NativePiSnapshot {
  readonly list: SessionsSnapshot;
  readonly detail: SessionDetailSnapshot;
  readonly write: WriteSnapshot;
  readonly conversation: ConversationSnapshot;
}
export interface NativePiPortOptions {
  readonly createSocket?: WebSocketFactory;
  readonly waitMs?: number;
  readonly upload?: ConstructorParameters<typeof ConversationState>[2];
}
interface Clients {
  readonly list: WsClient;
  readonly detail: SubscribeClient;
  readonly write: WriteClient;
}

/** One owner for the lifetime of the surface, including explicit reconnects.
 * Tokens are used only by the existing authenticated clients/uploader: never
 * copied into snapshots, error text, SDK-compatible DTOs, or logs.
 */
export class NativePiPort {
  readonly owner: ConversationState;
  private clients: Clients;
  private snapshot: NativePiSnapshot;
  private readonly listeners = new Set<() => void>();
  private detachClients: readonly (() => void)[] = [];
  private readonly detachOwner: () => void;
  private disposed = false;

  constructor(private readonly url: string, private readonly token: string, private readonly options: NativePiPortOptions = {}) {
    this.clients = this.makeClients();
    this.owner = new ConversationState(() => this.clients.list.requestSessions(), options.waitMs, options.upload);
    this.snapshot = this.readFacts();
    this.detachOwner = this.owner.subscribe(() => {
      this.syncSubscription();
      this.publish();
    });
    this.bindClients();
    this.owner.setClient(this.clients.write);
  }
  readonly getSnapshot = (): NativePiSnapshot => this.snapshot;
  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  connect(): void {
    if (this.disposed) return;
    this.clients.list.connect();
    this.clients.write.connect();
    this.clients.detail.connect();
  }
  createDraft(file: string, modelChoice = "__default__"): string | null {
    if (this.disposed || !LIMITS.filePattern.test(file)) return null;
    // Local draft only. No durable session or successful prompt is fabricated.
    return this.owner.create(file, modelChoice);
  }
  openSession(file: string): string | null {
    if (this.disposed || !LIMITS.filePattern.test(file)) return null;
    return this.owner.open(file);
  }
  back(): void { if (!this.disposed) this.owner.back(); }
  refresh(): void { if (!this.disposed) this.clients.list.requestSessions(); }
  moreSessions(): void { if (!this.disposed) this.clients.list.requestMoreSessions(); }
  send(id: string, model?: string, riskConfirmed = false): Promise<SendResult> {
    if (this.disposed) return Promise.resolve({ status: "local", kind: "closed", message: "界面已关闭，未发送。" });
    return this.owner.send(id, model, riskConfirmed);
  }
  stop(file: string) { return this.clients.write.sendStop(file); }
  resume(file: string, intentId: string, generation: number) {
    return this.clients.write.resume(file, intentId, generation);
  }
  /** Explicit transport replacement, never an automatic prompt/resume retry.
   * Pending facts become unknown before old clients close. The same owner and
   * its version counters survive; a late old receipt cannot clear new edits.
   */
  reconnect(): void {
    if (this.disposed) return;
    this.unbindClients();
    this.owner.setClient(null);
    this.closeClients();
    this.clients = this.makeClients();
    this.bindClients();
    this.owner.setClient(this.clients.write);
    this.syncSubscription();
    this.publish();
    this.connect();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    this.detachOwner();
    this.unbindClients();
    this.owner.dispose();
    this.closeClients();
  }
  private makeClients(): Clients {
    return {
      list: new WsClient(this.url, this.token, this.options.createSocket),
      detail: new SubscribeClient(this.url, this.token, this.options.createSocket),
      write: new WriteClient(this.url, this.token, this.options.createSocket),
    };
  }
  private bindClients(): void {
    const current = this.clients;
    const update = () => {
      if (this.disposed || this.clients !== current) return;
      // Native clients keep unknown/loading distinct from an empty catalogue.
      const list = current.list.getSnapshot();
      if (list.state === "ready") {
        if (list.models.status === "idle") current.list.requestModels();
        if (list.roots.status === "idle") current.list.requestRoots();
      }
      this.publish();
    };
    this.detachClients = [current.list.subscribe(update), current.write.subscribe(update), current.detail.subscribe(update)];
  }
  private unbindClients(): void {
    for (const detach of this.detachClients) detach();
    this.detachClients = [];
  }
  private closeClients(): void {
    this.clients.list.close(); this.clients.write.close(); this.clients.detail.close();
  }
  private syncSubscription(): void {
    const file = this.owner.getSnapshot().activeFile;
    if (file !== null && file !== this.clients.detail.getSnapshot().file) {
      this.clients.detail.subscribeSession(file);
    }
  }
  private readFacts(): NativePiSnapshot {
    return { list: this.clients.list.getSnapshot(), detail: this.clients.detail.getSnapshot(), write: this.clients.write.getSnapshot(), conversation: this.owner.getSnapshot() };
  }
  private publish(): void {
    if (this.disposed) return;
    const next = this.readFacts();
    if (next.list === this.snapshot.list && next.detail === this.snapshot.detail && next.write === this.snapshot.write && next.conversation === this.snapshot.conversation) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
