import type { ThinkingLevel } from "@pi-agent-ui/protocol";

/** Internal pi commands only. No prompt/abort; this channel never journals user intents. */
export type SettingsCommand =
  | { readonly type: "get_state" | "get_available_models" | "get_available_thinking_levels" }
  | { readonly type: "set_model"; readonly provider: string; readonly modelId: string }
  | { readonly type: "set_thinking_level"; readonly level: ThinkingLevel };

export type SettingsFailure = "stale" | "busy" | "closed" | "timeout" | "write-failed" | "rejected" | "malformed" | "uncertain";
export class SettingsRpcError extends Error {
  constructor(readonly code: SettingsFailure) { super(`pi 参数确认失败（${code}）；本条消息未发送。`); }
}
interface Pending {
  readonly generation: number;
  readonly command: SettingsCommand["type"];
  responseSeen: boolean;
  resolve(data: unknown): void;
  reject(error: SettingsRpcError): void;
}
export interface SettingsChannelOpts {
  readonly isCurrent: (generation: number) => boolean;
  /** Must capture the current process handle synchronously, not redirect an async write. */
  readonly write: (generation: number, line: string) => Promise<boolean>;
  readonly timeoutMs?: number;
}

/** One in-flight control operation. A response alone is NOT proof of completed stdin write. */
export class RpcSettingsChannel {
  private sequence = 0;
  private readonly pending = new Map<string, Pending>();
  private closed = false;
  private uncertainGeneration: number | null = null;

  constructor(private readonly opts: SettingsChannelOpts) {
    const timeout = opts.timeoutMs ?? 3000;
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 30_000) throw new Error("参数RPC截止须为1..30000ms");
  }

  isUncertain(generation: number): boolean { return this.uncertainGeneration === generation; }

  request(generation: number, command: SettingsCommand): Promise<unknown> {
    if (this.closed) return Promise.reject(new SettingsRpcError("closed"));
    if (!this.opts.isCurrent(generation)) return Promise.reject(new SettingsRpcError("stale"));
    if (this.isUncertain(generation)) return Promise.reject(new SettingsRpcError("uncertain"));
    if (this.pending.size !== 0) return Promise.reject(new SettingsRpcError("busy"));
    // Distinct from ready-* and c<commandId>; monotonic ids survive generation changes.
    const id = `cfg-${generation}-${++this.sequence}`;
    return new Promise<unknown>((resolve, reject) => {
      let done = false;
      let writeFinished = false;
      let responseFinished = false;
      let data: unknown;
      const finish = (error?: SettingsRpcError): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.pending.delete(id);
        if (error !== undefined) {
          // Unknown writes may complete later. Quarantine THIS generation until retired;
          // a future prompt must not race a late model/thinking mutation.
          this.uncertainGeneration = generation; // even a setter rejection can follow a partial state change
          reject(error);
        } else resolve(data);
      };
      const complete = (): void => {
        if (done || !writeFinished || !responseFinished) return;
        if (!this.opts.isCurrent(generation)) finish(new SettingsRpcError("stale"));
        else finish();
      };
      const timer = setTimeout(() => finish(new SettingsRpcError("timeout")), this.opts.timeoutMs ?? 3000);
      this.pending.set(id, {
        generation, command: command.type, responseSeen: false,
        resolve: (value) => { data = value; responseFinished = true; complete(); },
        reject: (error) => finish(error),
      });
      // The microtask also catches a synchronous host throw. Recheck after the boundary.
      void Promise.resolve().then(() => {
        if (done) return false;
        if (!this.opts.isCurrent(generation)) throw new SettingsRpcError("stale");
        return this.opts.write(generation, `${JSON.stringify({ ...command, id })}\n`);
      }).then((ok) => {
        if (done) return;
        if (!ok) { finish(new SettingsRpcError("write-failed")); return; }
        writeFinished = true;
        complete();
      }).catch((error: unknown) => finish(error instanceof SettingsRpcError ? error : new SettingsRpcError("write-failed")));
    });
  }

  /** Return true only for a matching id AND generation; don't steal another demux lane. */
  accept(event: unknown, generation: number): boolean {
    if (event === null || typeof event !== "object") return false;
    const e = event as Record<string, unknown>;
    if (e.type !== "response" || typeof e.id !== "string") return false;
    const pending = this.pending.get(e.id);
    if (pending === undefined || pending.generation !== generation) return false;
    if (pending.responseSeen) return true;
    pending.responseSeen = true;
    if (e.command !== pending.command || typeof e.success !== "boolean") pending.reject(new SettingsRpcError("malformed"));
    else if (!e.success) pending.reject(new SettingsRpcError("rejected"));
    else {
      try { pending.resolve(structuredClone(e.data)); }
      catch { pending.reject(new SettingsRpcError("malformed")); }
    }
    return true;
  }

  quarantine(generation: number): void {
    this.uncertainGeneration = generation;
    this.cancelGeneration(generation);
  }

  cancelGeneration(generation: number): void {
    for (const pending of [...this.pending.values()]) {
      if (pending.generation === generation) pending.reject(new SettingsRpcError("stale"));
    }
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of [...this.pending.values()]) pending.reject(new SettingsRpcError("closed"));
  }
}
