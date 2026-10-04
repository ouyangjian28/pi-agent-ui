// Read-only envelopes for the original SDK global.event() consumer.
// This cache deduplicates UI projections, never owns execution/drafts/history.
import type { NativePiSnapshot } from "./native-pi-port";
import { nativeDirectory, ocMessages, ocSession } from "./oc-read-projection";

export interface SurfaceEvent {
  readonly directory: string;
  readonly payload: { readonly type: string; readonly properties: Readonly<Record<string, unknown>> };
}
interface Entry { readonly value: unknown; readonly encoded: string }
export class OcEventProjection {
  private sessions = new Map<string, Entry>();
  private readonly messages = new Map<string, Map<string, Entry>>();
  private readonly parts = new Map<string, Map<string, Entry>>();
  private readonly statuses = new Map<string, string>();
  private readonly clearSequences = new Map<string, number>();
  private directory: string | null = null;
  project(snapshot: NativePiSnapshot): readonly SurfaceEvent[] {
    // Missing/failed facts do not delete displayed rows or announce healthy.
    if (snapshot.list.state !== "ready" || snapshot.write.connState !== "ready" || snapshot.detail.connState !== "ready") return [];
    const directory = nativeDirectory(snapshot); if (directory === null) return [];
    if (directory !== this.directory) {
      this.directory = directory; this.sessions.clear(); this.messages.clear(); this.parts.clear(); this.statuses.clear(); this.clearSequences.clear();
    }
    const output: SurfaceEvent[] = [];
    const emit = (type: string, properties: Record<string, unknown>) => { output.push({ directory, payload: { type, properties } }); };
    if (snapshot.list.sessions !== null) {
      const current = new Map<string, Entry>();
      for (const row of snapshot.list.sessions) {
        const value = ocSession(row, directory); const encoded = JSON.stringify(value);
        current.set(row.file, { value, encoded });
        const previous = this.sessions.get(row.file);
        if (previous?.encoded !== encoded) emit(previous ? "session.updated" : "session.created", { info: value });
        this.sessions.set(row.file, { value, encoded });
      }
      // A page/partial scan is NOT authoritative absence, so never emit deletes.
      if (snapshot.list.listReliability === "full" && snapshot.list.hasMore === false) {
        for (const [file, previous] of this.sessions) if (!current.has(file)) {
          emit("session.deleted", { info: previous.value }); this.sessions.delete(file);
          this.messages.delete(file); this.parts.delete(file); this.statuses.delete(file); this.clearSequences.delete(file);
        }
      }
    }
    const detail = snapshot.detail; const file = detail.file;
    if (file === null || detail.phase !== "live") return output;
    if (detail.status !== null && detail.status.turn.state !== "closed") {
      // A native closed/unknown turn is neither known idle nor active busy.
      const status = { type: detail.status.turn.state === "idle" ? "idle" : "busy" };
      const encoded = JSON.stringify(status);
      if (this.statuses.get(file) !== encoded) { emit("session.status", { sessionID: file, status }); this.statuses.set(file, encoded); }
      // No session.idle/completed verdict invented from a temporary final.
    }
    const oldMessages = this.messages.get(file) ?? new Map<string, Entry>();
    const oldParts = this.parts.get(file) ?? new Map<string, Entry>();
    const nextMessages = new Map<string, Entry>(); const nextParts = new Map<string, Entry>();
    const rows = ocMessages(detail.events, detail.liveEvents, file);
    for (const row of rows) {
      const info = row.info; const encoded = JSON.stringify(info);
      nextMessages.set(info.id, { value: info, encoded });
      // Owning message MUST precede its parts, or original reducer requests a
      // materialisation/reload that can overwrite the streaming projection.
      if (oldMessages.get(info.id)?.encoded !== encoded) emit("message.updated", { info });
      for (const part of row.parts) {
        const encodedPart = JSON.stringify(part); nextParts.set(part.id, { value: part, encoded: encodedPart });
        if (oldParts.get(part.id)?.encoded !== encodedPart) emit("message.part.updated", { sessionID: file, part });
      }
    }
    // Retiring the temporary live id is display reconciliation, not promotion
    // into a durable pi entry. Durable native history keeps its original id.
    const clearSeq = detail.events.reduce((latest, event) => event.kind === "clear" ? Math.max(latest, event.seq) : latest, -1);
    const cleared = clearSeq > (this.clearSequences.get(file) ?? -1);
    if (cleared) this.clearSequences.set(file, clearSeq);
    for (const [id, previous] of oldMessages) if (!nextMessages.has(id)) {
      if (cleared || id.startsWith("pi-live-")) emit("message.removed", { sessionID: file, messageID: id });
      else nextMessages.set(id, previous); // A shorter window is not deletion.
    }
    for (const [id, entry] of oldParts) if (!nextParts.has(id)) {
      const part = entry.value as { readonly messageID: string };
      if (nextMessages.has(part.messageID)) {
        if (rows.some((row) => row.info.id === part.messageID)) emit("message.part.removed", { sessionID: file, messageID: part.messageID, partID: id });
        else nextParts.set(id, entry); // Same partial-history retention rule.
      }
    }
    this.messages.set(file, nextMessages); this.parts.set(file, nextParts);
    return output;
  }
}
