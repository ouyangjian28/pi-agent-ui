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
