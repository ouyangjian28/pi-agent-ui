import { spawn } from "node:child_process";
import { ModelRuntime, VERSION } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { isThinkingLevel } from "@pi-agent-ui/protocol";
import type { ModelEntry } from "./model-listing.js";

/** A read-only catalog view, never a live session setter or an auth/availability probe.
 * Version mismatch, unknown model, invalid metadata or discovery failure => no assertion
 * of supported levels. The UI must keep its default-only/unknown-capability fallback.
 * Sending still independently checks the actual RPC child immediately before prompt. */
export async function enrichThinkingLevels(piBin: string, entries: readonly ModelEntry[]): Promise<readonly ModelEntry[]> {
  if (!(await matchesSdkVersion(piBin))) return entries;
  try {
    const runtime = await ModelRuntime.create({
      allowModelNetwork: false, refreshOnCreate: false,
      credentials: {
        read: async () => undefined,
        list: async () => [],
        modify: async () => { throw new Error("Capability catalog is read-only"); },
        delete: async () => { throw new Error("Capability catalog is read-only"); },
      },
    });
    if (runtime.getError()) return entries;
    return entries.map((entry) => {
      const model = runtime.getModel(entry.provider, entry.id);
      if (!model) return entry;
      const levels = getSupportedThinkingLevels(model);
      if (levels.length > 7 || !levels.every(isThinkingLevel) || new Set(levels).size !== levels.length) return entry;
      return { ...entry, thinkingLevels: levels };
    });
  } catch {
    // Do not leak configuration/auth material through a listing error or log.
    return entries;
  }
}

/** piBin is host configuration, not client input. Bounded stdout, no prompt or login. */
async function matchesSdkVersion(piBin: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const child = spawn(piBin, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(false); }, 2000);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 1024) { child.kill("SIGKILL"); clearTimeout(timer); resolve(false); }
    });
    child.once("error", () => { clearTimeout(timer); resolve(false); });
    child.once("close", (code) => { clearTimeout(timer); resolve(code === 0 && output.trim() === VERSION); });
  });
}
