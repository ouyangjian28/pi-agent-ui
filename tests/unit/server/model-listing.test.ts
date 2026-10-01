// M-OPS（v1.4）模型清单服务单测：表格解析边界+缓存 TTL+并发去重+失败 cause。
import { describe, expect, it } from "vitest";
import { ModelsListingService, parseModelsTable, type ModelEntry } from "../../../apps/server/src/ws/model-listing.js";

const SAMPLE = [
  "provider            model                                context   max-out   thinking   images",
  "anthropic           claude-opus-4-5                      200k      64k       yes        yes",
  "litellm             glm-5.3                              200k      64k       -          -",
  "kimi-coding         k3                                   256k      -         yes        -",
].join("\n");

describe("parseModelsTable", () => {
  it("M-l-1：正常表——provider/model 全列+context/thinking 空值省略", () => {
    const r = parseModelsTable(SAMPLE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.models).toHaveLength(3);
    const first = r.models[0] as ModelEntry;
    expect(first).toEqual({ provider: "anthropic", id: "claude-opus-4-5", context: "200k", thinking: "yes" });
    const second = r.models[1] as ModelEntry;
    expect(second.context).toBe("200k");
    expect(second.thinking).toBe("-"); // - 原样保留（解析层不猜测语义；M-l-4 同锚）
  });

  it("M-l-2：表头缺 model 列→cause", () => {
    const r = parseModelsTable("provider            context\na                   200k");
    expect(r).toEqual({ ok: false, cause: "表头缺 provider/model 列" });
  });

  it("M-l-3：空输出→cause", () => {
    expect(parseModelsTable("")).toEqual({ ok: false, cause: "空输出" });
    expect(parseModelsTable("   \n  \n")).toEqual({ ok: false, cause: "空输出" });
  });

  it("M-l-4：thinking 列为 - →原样保留（视图层解释；解析层不猜测语义）", () => {
    const r = parseModelsTable(SAMPLE);
    expect(r.ok && (r.models[1] as ModelEntry).thinking).toBe("-");
  });

  it("M-l-5：列数不足行跳过（长行折行类噪声）", () => {
    const noisy = SAMPLE + "\n碎片行";
    const r = parseModelsTable(noisy);
    expect(r.ok && r.models.length).toBe(3);
  });

  it("M-l-6：CRLF 兼容", () => {
    const r = parseModelsTable(SAMPLE.split("\n").join("\r\n"));
    expect(r.ok && r.models.length).toBe(3);
  });
});

describe("ModelsListingService", () => {
  it("M-l-7：缓存 TTL 内单次 spawn（now 注入）", async () => {
    let calls = 0;
    const svc = new ModelsListingService({
      piBin: "pi",
      now: () => 1_000_000,
      spawnImpl: async () => {
        calls += 1;
        return { ok: true, models: [{ provider: "a", id: "m1" }] };
      },
    });
    const r1 = await svc.list();
    const r2 = await svc.list();
    expect(calls).toBe(1);
    expect(r1.ok && r1.models.length).toBe(1);
    expect(r2.ok && r2.models.length).toBe(1);
  });

  it("M-l-8：TTL 过期重拉", async () => {
    let calls = 0;
    let clock = 1_000_000;
    const svc = new ModelsListingService({
      piBin: "pi",
      cacheTtlMs: 600_000,
      now: () => clock,
      spawnImpl: async () => {
        calls += 1;
        return { ok: true, models: [] };
      },
    });
    await svc.list();
    clock += 600_001;
    await svc.list();
    expect(calls).toBe(2);
  });

  it("M-l-9：并发去重——同窗两请求共享一次 spawn", async () => {
    let calls = 0;
    let release: (() => void) | null = null;
    const svc = new ModelsListingService({
      piBin: "pi",
      spawnImpl: () =>
        new Promise((resolve) => {
          calls += 1;
          release = () => resolve({ ok: true, models: [{ provider: "a", id: "m1" }] });
        }) as Promise<ReturnType<typeof parseModelsTable>>,
    });
    const p1 = svc.list();
    const p2 = svc.list();
    release?.();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(calls).toBe(1);
    expect(r1.ok && r1.models.length).toBe(1);
    expect(r2.ok).toBe(true);
  });

  it("M-l-10：spawn 抛错→空表 cause（不抛出）+失败结果也缓存", async () => {
    let calls = 0;
    const svc = new ModelsListingService({
      piBin: "pi",
      now: () => 1,
      spawnImpl: async () => {
        calls += 1;
        throw new Error("boom");
      },
    });
    const r1 = await svc.list();
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.cause).toContain("boom");
    const r2 = await svc.list();
    expect(calls).toBe(1); // 失败也缓存（防故障风暴）
    expect(r2.ok).toBe(false);
  });
  it("supported-level enrichment is cached and concurrent requests stay single-flight", async () => {
    const decorate = async (models: readonly ModelEntry[]) => models.map((m) => ({ ...m, thinkingLevels: ["off", "high"] as const }));
    let calls = 0;
    const svc = new ModelsListingService({ piBin: "pi", spawnImpl: async () => ({ ok: true, models: [{ provider: "controlled", id: "m" }] }), enrichThinkingLevels: async (models) => { calls++; return decorate(models); } });
    const [a, b] = await Promise.all([svc.list(), svc.list()]);
    expect(a).toEqual({ ok: true, models: [{ provider: "controlled", id: "m", thinkingLevels: ["off", "high"] }] });
    expect(b).toEqual(a); expect(calls).toBe(1); expect(await svc.list()).toEqual(a); expect(calls).toBe(1);
  });
  it("failed optional capability discovery preserves the model list and releases inflight", async () => {
    let calls = 0;
    const svc = new ModelsListingService({ piBin: "pi", cacheTtlMs: 0, spawnImpl: async () => ({ ok: true, models: [{ provider: "controlled", id: "m", thinking: "yes" }] }), enrichThinkingLevels: async () => { calls++; throw new Error("do not expose provider configuration"); } });
    const expected = { ok: true, models: [{ provider: "controlled", id: "m", thinking: "yes" }] };
    expect(await svc.list()).toEqual(expected); expect(await svc.list()).toEqual(expected); expect(calls).toBe(2);
  });
});
