// P0-2 r3a P1 修复（K3 审）装配层测试：makeResumeAuthority 真源工厂。
// 杀点=键口径：网关传 journal 绝对路径→reportFor 必须归一为逻辑名喂 provider
// （与 get-recovery 同键——seen-store/锚点持久键单一宇宙，B13-2）；generationFor
// 绝对路径直查 registry（write 面口径）。
//  W-ra-1  abs→provider 收逻辑名（单根/嵌套根/子目录形）
//  W-ra-2  无匹配根→原样透传（fail-open 归一，不制造拒因）
//  W-ra-3  provider null/非 snapshot（kind 字段在场）→report null
//  W-ra-4  snapshot→recoverFromSnapshot 真映射（resendAuthorized/resumeBlocked 透传）
//  W-ra-5  generationFor=registry.statusFor(file).process.generation 直查（键=原样）
import { describe, expect, it } from "vitest";
import { makeResumeAuthority } from "../../../apps/server/src/composition.ts";
import type { RecoveryEvidenceResult } from "../../../apps/server/src/runtime/recovery-evidence-source.ts";

function fakeProvider() {
  const calls: string[] = [];
  let ret: RecoveryEvidenceResult | null = null;
  return {
    calls,
    set: (v: RecoveryEvidenceResult | null) => { ret = v; },
    fn: async (file: string, _signal: AbortSignal): Promise<RecoveryEvidenceResult | null> => { calls.push(file); return ret; },
  };
}

function fakeRegistry(gen: number | null) {
  const calls: string[] = [];
  return {
    calls,
    impl: { statusFor: (f: string) => { calls.push(f); return { process: { generation: gen } }; } },
  };
}

describe("P0-2 r3a P1（K3 审）：makeResumeAuthority 键口径", () => {
  it("W-ra-1 abs→provider 收逻辑名（单根+子目录形）", async () => {
    const p = fakeProvider();
    const r = fakeRegistry(null);
    const a = makeResumeAuthority({ roots: ["/srv/j"], provider: p.fn, registry: r.impl });
    await a.reportFor("/srv/j/s1.jsonl");
    await a.reportFor("/srv/j/sub/s2.jsonl");
    expect(p.calls).toEqual(["s1.jsonl", "sub/s2.jsonl"]); // 键=逻辑名（get-recovery 同键）
  });

  it("W-ra-2 无匹配根→原样透传（fail-open 归一不制造拒因）", async () => {
    const p = fakeProvider();
    const r = fakeRegistry(null);
    const a = makeResumeAuthority({ roots: ["/srv/j"], provider: p.fn, registry: r.impl });
    await a.reportFor("/other/s1.jsonl");
    expect(p.calls).toEqual(["/other/s1.jsonl"]); // 透传，provider 侧现有约束兜底
  });

  it("W-ra-3 provider null/非 snapshot（kind 在场）→report null", async () => {
    const p = fakeProvider();
    const r = fakeRegistry(null);
    const a = makeResumeAuthority({ roots: ["/srv/j"], provider: p.fn, registry: r.impl });
    p.set(null);
    expect(await a.reportFor("/srv/j/s1.jsonl")).toBe(null);
    p.set({ kind: "unavailable", reason: "read-failed" } as RecoveryEvidenceResult);
    expect(await a.reportFor("/srv/j/s1.jsonl")).toBe(null);
  });

  it("W-ra-4 snapshot→recoverFromSnapshot 真映射（授权集/阻断透传）", async () => {
    const p = fakeProvider();
    const r = fakeRegistry(null);
    const a = makeResumeAuthority({ roots: ["/srv/j"], provider: p.fn, registry: r.impl });
    // 最小快照：无 lines 无坏行→空授权+不阻断（recoverFromSnapshot 真函数；详映射面=recover.test 既有覆盖）
    p.set({ version: 1, file: "s1.jsonl", sessionId: "sess-x", lines: [], bad: [], attributedFragments: [], repaired: false, pendingRepair: false, createdAt: 1_700_000_000_000 } as unknown as RecoveryEvidenceResult);
    const report = await a.reportFor("/srv/j/s1.jsonl");
    expect(report).not.toBe(null);
    expect(report!.resendAuthorized).toEqual([]);
    expect(report!.resumeBlocked).toBe(false);
  });

  it("W-ra-5 generationFor=registry 直查（键=原样绝对路径，write 面口径）", () => {
    const p = fakeProvider();
    const r = fakeRegistry(7);
    const a = makeResumeAuthority({ roots: ["/srv/j"], provider: p.fn, registry: r.impl });
    expect(a.generationFor("/srv/j/s1.jsonl")).toBe(7);
    expect(r.calls).toEqual(["/srv/j/s1.jsonl"]); // 不归一——registry 键=write 面绝对路径
  });
});

describe("P0-2 r3b：executeFor 执行点读+资源面", () => {
  // 最小真快照（含两条 enqueue：i-1 授权可重发、i-2 已 settled）
  function snapWithIntents(): RecoveryEvidenceResult {
    const lines = [
      { t: "enqueue", intentId: "i-1", sessionId: "sess-x", generation: 1, leafId: "l1", matchKey: { textHash: "h1", attachmentIdentity: [], ordinal: 0 }, payload: { kind: "prompt", rawText: "重发我", attachments: [], sentAt: "2026-01-01T00:00:00Z" } },
      { t: "enqueue", intentId: "i-2", sessionId: "sess-x", generation: 1, leafId: "l2", matchKey: { textHash: "h2", attachmentIdentity: [], ordinal: 1 }, payload: { kind: "prompt", rawText: "已完成", attachments: [], sentAt: "2026-01-01T00:00:01Z" } },
      { t: "settled", intentId: "i-2" },
    ];
    return { version: 1, file: "s1.jsonl", sessionId: "sess-x", lines, bad: [], attributedFragments: [], repaired: false, pendingRepair: false, createdAt: 1_700_000_000_000 } as unknown as RecoveryEvidenceResult;
  }

  it("W-ra-6 executeFor 键归一同 reportFor（abs→逻辑名）+payload 真映射（intents 查 rawText）；report 与 reportFor 同快照一致", async () => {
    const p = fakeProvider();
    p.set(snapWithIntents());
    const r = fakeRegistry(null);
    const a = makeResumeAuthority({ roots: ["/srv/j"], provider: p.fn, registry: r.impl });
    const got = await a.executeFor("/srv/j/s1.jsonl", "i-1");
    expect(p.calls).toEqual(["s1.jsonl"]); // 与 reportFor 同键归一
    expect(got).not.toBe(null);
    const rep = await a.reportFor("/srv/j/s1.jsonl"); // 授权语义面=recover 算法专属测试（resendAuthorized 需完整裁决链）；此处只锁同快照一致性
    expect(got!.report).toEqual(rep);
    expect(got!.payload).toEqual({ rawText: "重发我" }); // enqueue 载荷读回（i-1 intents 在场）
  });

  it("W-ra-7 intents 缺该 id（授权集与 intents 不一致防御）→payload null", async () => {
    const p = fakeProvider();
    p.set(snapWithIntents());
    const a = makeResumeAuthority({ roots: ["/srv/j"], provider: p.fn, registry: fakeRegistry(null).impl });
    const got = await a.executeFor("/srv/j/s1.jsonl", "i-404");
    expect(got!.payload).toBe(null); // 证据不完整非身份错→上层 execution-failed
  });

  it("W-ra-8 in-flight 合并：并发 reportFor+executeFor 同 file=一次 provider 调用；串行不缓存（两次读）", async () => {
    const p = fakeProvider();
    p.set(snapWithIntents());
    const a = makeResumeAuthority({ roots: ["/srv/j"], provider: p.fn, registry: fakeRegistry(null).impl });
    await Promise.all([a.reportFor("/srv/j/s1.jsonl"), a.executeFor("/srv/j/s1.jsonl", "i-1")]);
    expect(p.calls.length).toBe(1); // 并发共享同次盘读
    await a.reportFor("/srv/j/s1.jsonl");
    expect(p.calls.length).toBe(2); // 完成即删不缓存（无失效钩子下缓存=双发面，正确性否决）
  });

  it("W-ra-9 executeFor→null 同源：provider null/非 snapshot→null", async () => {
    const p = fakeProvider();
    p.set(null);
    const a = makeResumeAuthority({ roots: ["/srv/j"], provider: p.fn, registry: fakeRegistry(null).impl });
    expect(await a.executeFor("/srv/j/s1.jsonl", "i-1")).toBe(null);
  });
});
