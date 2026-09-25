// ②WS/UI 契约准备包：脱敏向量对拍（fixtures/contracts/sanitizer-vectors.json，人工期望 golden）。
// 期望值手写自 sanitizer.ts 规范（文档 v1.2 §6）；本测试不自证——失败=代码或人工期望需对表修正。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { LIMITS, machineId, sanitizeText } from "@pi-agent-ui/protocol";

interface TextVector {
  readonly name: string;
  readonly kind: "text";
  readonly limit?: number;
  readonly input: string;
  readonly expect: { readonly text: string; readonly truncated: boolean };
}
interface IdVector {
  readonly name: string;
  readonly kind: "id";
  readonly input: string;
  readonly expect:
    | { readonly id: string }
    | { readonly idPattern: string }
    | { readonly idStableWith: string };
}
type Vector = TextVector | IdVector;

const vectorsPath = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/contracts/sanitizer-vectors.json");
const raw = JSON.parse(readFileSync(vectorsPath, "utf8")) as { description: string; vectors: Vector[] };
const textVectors = raw.vectors.filter((v): v is TextVector => v.kind === "text");
const idVectors = raw.vectors.filter((v): v is IdVector => v.kind === "id");

describe("脱敏向量（人工 golden）", () => {
  for (const v of textVectors) {
    it(`text: ${v.name}`, () => {
      const out = sanitizeText(v.input, v.limit ?? LIMITS.previewLimitMessage);
      expect(out.text).toBe(v.expect.text);
      expect(out.truncated).toBe(v.expect.truncated);
    });
  }
  for (const v of idVectors) {
    it(`id: ${v.name}`, () => {
      const out = machineId(v.input);
      if ("id" in v.expect) expect(out).toBe(v.expect.id);
      else if ("idPattern" in v.expect) expect(out).toMatch(new RegExp(v.expect.idPattern));
      else expect(out).toBe(machineId(v.expect.idStableWith)); // 同输入稳定
    });
  }
  it("向量规模 ≥36（契约冻结门）", () => {
    expect(raw.vectors.length).toBeGreaterThanOrEqual(36);
  });
});
