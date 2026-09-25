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
    | { readonly idStableWith: string }
    | { readonly idPattern: string; readonly idDistinctWith: string };
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
      else if ("idDistinctWith" in v.expect) {
        expect(out).toMatch(new RegExp(v.expect.idPattern));
        expect(out).not.toBe(machineId(v.expect.idDistinctWith)); // UTF-8 全字节：高位字符互异
      }
      else if ("idPattern" in v.expect) expect(out).toMatch(new RegExp(v.expect.idPattern));
      else expect(out).toBe(machineId(v.expect.idStableWith)); // 同输入稳定
    });
  }
  it("向量规模 ≥40（契约冻结门）", () => {
    expect(raw.vectors.length).toBeGreaterThanOrEqual(40);
  });

  // B07 二次方回溯防护（性能门）：65KiB 无分隔符文本曾因无界贪婪类回溯实测
  // 9.3s（env/⑦/⑧ 各 ~3s）；有界量词后 <50ms。500ms 上限留 10 倍余量防环境抖动。
  it("B07 性能门：65KiB 无分隔符文本 <500ms", () => {
    const t0 = performance.now();
    const out = sanitizeText("a".repeat(65270) + "中文", 200);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(500);
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBe(200);
    const t1 = performance.now();
    const id = machineId("a".repeat(65270) + "=value12345678");
    expect(performance.now() - t1).toBeLessThan(500);
    expect(id).toMatch(/^~id-[0-9a-f]{16}$/); // 超界凭据形态 → 哈希映射不外发
  });

  // 3b2c-B6（GPT 3b2b）：PEM 重复 BEGIN 无 END 的二次方路径（旧正则①惰性 [\s\S]*? 每起点
  // 重扫剩余后缀，512KiB 实测 5.7s）→ maskPem 线性扫描器。多规模阶梯+伸缩性断言：
  // 线性实现下 512KiB 耗时 < 32KiB 耗时 × 64（二次方路径该比值≈256 且绝对值秒级）。
  it("B6 性能门：重复 BEGIN 无 END 多规模阶梯（32K→512K）", () => {
    const times: Array<[number, number]> = [];
    for (const size of [32_768, 65_536, 131_072, 262_144, 524_288]) {
      const chunk = "-----BEGIN A-----";
      const input = chunk.repeat(Math.ceil(size / chunk.length));
      const t0 = performance.now();
      const a = sanitizeText(input, 200);
      const b = machineId(input);
      const dt = performance.now() - t0;
      expect(a.text).toBe("[truncated-secret]");
      expect(b).toMatch(/^~id-/);
      times.push([size, dt]);
      expect(dt, `sanitizeText+machineId @${size}B 应 <500ms（线性扫描器）`).toBeLessThan(500);
    }
    const [s0, t0] = times[0]!;
    const [s4, t4] = times[4]!;
    expect(t4, `512KiB/32KiB 耗时比应 <64（线性；二次方≈16×规模比×单次全扫）`).toBeLessThan(
      Math.max(1, t0) * 64,
    );
    void s0; void s4;
  });
  it("B6 性能门：含 END 的整块 PEM 大输入同样线性（BEGIN…END 成对 ×大规模）", () => {
    const unit = "-----BEGIN PRIVATE KEY-----\n" + "A".repeat(64) + "\n-----END PRIVATE KEY-----\n";
    const input = unit.repeat(2_000); // ~190KiB 成对 PEM
    const t0 = performance.now();
    const out = sanitizeText(input, 200);
    const dt = performance.now() - t0;
    expect(out.text).not.toContain("PRIVATE");
    expect(dt, "成对 PEM 190KiB 应 <500ms").toBeLessThan(500);
  });
});
