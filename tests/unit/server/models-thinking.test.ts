import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { enrichThinkingLevels } from "../../../apps/server/src/ws/models-thinking.js";

let owned: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const dir of owned) await rm(dir, { recursive: true, force: true }); owned = []; });
async function setup(version = VERSION) {
  const dir = await mkdtemp(join(tmpdir(), "thinking-capabilities-")); owned.push(dir);
  const pi = join(dir, "pi"); await writeFile(pi, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, { mode: 0o700 }); await chmod(pi, 0o700);
  vi.stubEnv("PI_CODING_AGENT_DIR", dir);
  const data = JSON.stringify({ providers: { controlled: { api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", apiKey: "synthetic-test-not-auth", models: [
    { id: "reasoner", name: "Local catalog only", reasoning: true, thinkingLevelMap: { off: "none", low: "low", high: "high" }, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 512 },
    { id: "restricted", name: "Explicitly restricted", reasoning: true, thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null }, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 512 },
    { id: "plain", name: "No reasoning", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 512 },
  ] } } });
  await writeFile(join(dir, "models.json"), data);
  return { dir, pi, data };
}
describe("same-version read-only public SDK thinking catalog", () => {
  it("uses real public SDK model metadata (not yes/no), preserving unknown identity and configuration bytes", async () => {
    const { pi, dir, data } = await setup();
    const entries = [{ provider: "controlled", id: "reasoner", thinking: "yes" }, { provider: "controlled", id: "plain", thinking: "no" }, { provider: "controlled", id: "restricted", thinking: "yes" }, { provider: "controlled", id: "unknown", thinking: "yes" }];
    const result = await enrichThinkingLevels(pi, entries);
    // Missing map keys retain SDK defaults; null explicitly disables a level.
    expect(result[0]?.thinkingLevels).toEqual(["off", "minimal", "low", "medium", "high"]);
    expect(result[1]?.thinkingLevels).toEqual(["off"]); expect(result[2]?.thinkingLevels).toEqual(["off", "low", "high"]); expect(result[3]).toEqual(entries[3]);
    expect(await readFile(join(dir, "models.json"), "utf8")).toBe(data);
    await expect(readFile(join(dir, "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("a different child version is unknown, not same capabilities from the installed SDK", async () => {
    const { pi } = await setup("0.86.1"); const entries = [{ provider: "controlled", id: "reasoner", thinking: "yes" }];
    expect(await enrichThinkingLevels(pi, entries)).toBe(entries);
  });
  it("unknown models and invalid config do not erase the original listing or leak configuration", async () => {
    const { pi, dir } = await setup(); await writeFile(join(dir, "models.json"), "invalid-json");
    const entries = [{ provider: "controlled", id: "reasoner", thinking: "yes" }];
    expect(await enrichThinkingLevels(pi, entries)).toBe(entries);
  });
  it("unavailable version command degrades explicitly without throwing", async () => {
    const { dir } = await setup(); const entries = [{ provider: "controlled", id: "reasoner" }];
    expect(await enrichThinkingLevels(join(dir, "absent"), entries)).toBe(entries);
  });
});
