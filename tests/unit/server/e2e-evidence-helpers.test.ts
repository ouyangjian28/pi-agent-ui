// 3c-3（20b B2）：E2E 证据助手负例——不耗 LLM 的失败面证明。
// GPT 20b 要求：先完成该轮不算在飞成功；s2 提前退出只剩 s1 停不能借 s1 过；坏形状 exit 拒收。
// 这些失败面在真进程 E2E 里只作断言路径，此处用合成数据直接证明「断言确实会拒绝」。
import { describe, expect, it } from "vitest";
import { assertExitShape, disposeChain, findSpawnFor, inFlightAt, type JLineLike, type SpawnRecord } from "../../helpers/e2e-evidence.js";

describe("e2e-evidence 助手（20b B2 负例面）", () => {
  it("H15-N1 先完成的轮不算在飞：settled 已现 → inFlightAt=false（sending 历史行不冒充当前运行态）", () => {
    const lines: JLineLike[] = [
      { t: "enqueue", intentId: "i1", generation: 1 },
      { t: "sending", intentId: "i1" },
      { t: "settled", intentId: "i1" },
    ];
    expect(inFlightAt(lines, "i1")).toBe(false); // 反例：三行齐=已收口
    expect(inFlightAt([{ t: "enqueue", intentId: "i2" }], "i2")).toBe(false); // 未到 sending 也不算
    expect(inFlightAt([
      { t: "enqueue", intentId: "i3", generation: 1 },
      { t: "sending", intentId: "i3" },
    ], "i3")).toBe(true); // 正例：sending 已现+settled 未现
  });

  it("H15-N2 借 s1 过不了：目标 handle=H2 无 stop（或 exit 先于 stop）→ disposeChain 抛错，不用 s1 的链顶替", () => {
    // s1 正常被停退（H1 链完整）；s2=目标提前自退（exit 无 stop）；s1 的 stop/exit 不能满足 H2 断言
    const audits = [
      "spawn H1",
      "exit handle=H2 code=0 signal=null", // 目标提前自退（无 stop=非销毁击杀）
      "stop handle=H1 signal=SIGTERM",
      "exit handle=H1 code=null signal=SIGTERM",
      "session-registry disposed",
      "composition disposed",
    ];
    expect(() => disposeChain(audits, "H2", 0)).toThrow(/stop handle=H2/); // 借不到 H1：H2 无 stop 行
    const s1 = disposeChain(audits, "H1", 0); // 对照：H1 自身链成立（stop2<exit3<registry4<comp5），
    expect([s1.stop, s1.exit, s1.registry, s1.composition]).toEqual([2, 3, 4, 5]); // 证明 H2 被拒非夹具损坏
  });

  it("H15-N2b 链序破坏即拒：exit 在 stop 前（纯自退）→ 抛「自退或借用」；缺 registry/composition 段 → 抛缺段", () => {
    const selfExit = ["exit handle=H9 code=0 signal=null", "stop handle=H9 signal=SIGTERM", "session-registry disposed", "composition disposed"];
    expect(() => disposeChain(selfExit, "H9", 0)).toThrow(/自退或借用/);
    const noComp = ["stop handle=H9 signal=SIGTERM", "exit handle=H9 code=null signal=SIGTERM", "session-registry disposed"];
    expect(() => disposeChain(noComp, "H9", 0)).toThrow(/composition disposed/);
    // token 边界：H9 的链不得被 H90 顶替
    const decoy = ["stop handle=H90 signal=SIGTERM", "exit handle=H90 code=0 signal=null"];
    expect(() => disposeChain(decoy, "H9", 0)).toThrow(/stop handle=H9/);
  });

  it("H15-N3 坏形状 exit 拒收：{}/[]/缺字段/错类型/双空 → assertExitShape 抛错；合法形状放行", () => {
    expect(() => assertExitShape({})).toThrow(/缺字段/);
    expect(() => assertExitShape([])).toThrow(/须为对象/);
    expect(() => assertExitShape([1, 2])).toThrow(/须为对象/);
    expect(() => assertExitShape({ code: null })).toThrow(/缺字段/);
    expect(() => assertExitShape({ code: "0", signal: null })).toThrow(/字段类型错/);
    expect(() => assertExitShape({ code: null, signal: 3 })).toThrow(/字段类型错/);
    expect(() => assertExitShape({ code: null, signal: null })).toThrow(/双空/);
    expect(assertExitShape({ code: 0, signal: null })).toEqual({ code: 0, signal: null });
    expect(assertExitShape({ code: null, signal: "SIGTERM" })).toEqual({ code: null, signal: "SIGTERM" });
  });

  it("H15-N4 findSpawnFor 严格相等：无记录抛错不猜；多代取最新", () => {
    const spawns: SpawnRecord[] = [
      { file: "/d/s2.jsonl", id: "proc-1", generation: 1 },
      { file: "/d/s2.jsonl", id: "proc-2", generation: 2 },
    ];
    expect(() => findSpawnFor(spawns, "/d/s1.jsonl")).toThrow(/无 .* 的 spawn 记录/);
    expect(findSpawnFor(spawns, "/d/s2.jsonl")).toEqual({ file: "/d/s2.jsonl", id: "proc-2", generation: 2 });
  });
});
