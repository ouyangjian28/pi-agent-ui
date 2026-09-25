// 通用命令通道测试（TECH §3②占位先行序；r8/r8c 风险序 1：通用命令先耐久占位再发送）
// 覆盖：占位 fsync 先于 send／cached 不重发／同键不同参拒+审计／占位 fsync 失败=未发送+留置（A1-02 写前/写后两替身）／
// send 抛错=效果未知留置／send 返回 null=协议违规留置+审计（A1-05）／结果耐久失败=内存占位态+重放读到=cached 非洗白／
// 崩溃重放 unknown-effect。
import { describe, expect, it } from "vitest";
import { CommandChannel, CommandDedup } from "@pi-agent-ui/protocol";
import type { OpLedgerPort, OpRecord } from "@pi-agent-ui/protocol";

const T0 = "2026-09-25T00:00:00Z";

/** 受控 op 表端口：记录事件序（placeholder/send 由测试自记）；可按脚本失败（写前/写后两模式，A1-02）。 */
class FakeLedger implements OpLedgerPort {
  readonly events: string[] = [];
  placeholders: OpRecord[] = [];
  results: OpRecord[] = [];
  failPlaceholder: boolean | "after" = false; // true=写前拒；"after"=已写后拒
  failResult: boolean | "after" = false;

  appendPlaceholder(rec: OpRecord): Promise<void> {
    if (this.failPlaceholder === "after") {
      this.placeholders.push(rec); // 行已写再报错
      return Promise.reject(new Error("ph-eio-after"));
    }
    if (this.failPlaceholder) return Promise.reject(new Error("ph-eio"));
    this.placeholders.push(rec);
    this.events.push("placeholder");
    return Promise.resolve();
  }

  appendResult(rec: OpRecord): Promise<void> {
    if (this.failResult === "after") {
      this.results.push(rec); // 结果行已写再报错
      return Promise.reject(new Error("res-eio-after"));
    }
    if (this.failResult) return Promise.reject(new Error("res-eio"));
    this.results.push(rec);
    this.events.push("result");
    return Promise.resolve();
  }
}

const make = (ledger = new FakeLedger()) => {
  const dedup = new CommandDedup();
  const audits: string[] = [];
  const channel = new CommandChannel({
    dedup,
    ledger,
    now: () => T0,
    onAudit: (line) => audits.push(line),
  });
  return { dedup, ledger, channel, audits };
};

const trackedSend =
  (ledger: FakeLedger, result: object = { ok: true }) =>
  async (): Promise<object> => {
    ledger.events.push("send");
    return result;
  };

describe("通用命令通道（CommandChannel）", () => {
  it("占位先行：placeholder fsync 先于 send；成功路径 result 行 fsync+内存 settle", async () => {
    const { ledger, channel, dedup } = make();
    const out = await channel.dispatch("op-1", "argsA", trackedSend(ledger));
    expect(out).toEqual({ kind: "ok", result: { ok: true } });
    expect(ledger.events).toEqual(["placeholder", "send", "result"]);
    expect(dedup.get("op-1")?.result).toEqual({ ok: true });
  });

  it("同 opId 同参重试（应答丢失场景）：cached 不重发（send 未再执行）", async () => {
    const ledger = new FakeLedger();
    const { channel } = make(ledger);
    let sends = 0;
    const send = async (): Promise<object> => {
      sends += 1;
      ledger.events.push("send");
      return { ok: true, n: sends };
    };
    await channel.dispatch("op-1", "argsA", send);
    const out = await channel.dispatch("op-1", "argsA", send);
    expect(out).toEqual({ kind: "cached", result: { ok: true, n: 1 } });
    expect(sends).toBe(1);
    expect(ledger.events.filter((e) => e === "send")).toHaveLength(1);
  });

  it("同键不同参：rejected-different-args+审计钩子触发+不发送", async () => {
    const { ledger, channel, audits } = make();
    await channel.dispatch("op-1", "argsA", trackedSend(ledger));
    const out = await channel.dispatch("op-1", "argsB", trackedSend(ledger));
    expect(out).toEqual({ kind: "rejected-different-args" });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toContain("op-1");
    expect(ledger.events).toEqual(["placeholder", "send", "result"]);
  });

  it("占位 fsync 失败（写前拒绝）：未发送+内存占位留置→同 opId 重试=unknown-effect；新 opId=重新受理", async () => {
    const ledger = new FakeLedger();
    ledger.failPlaceholder = true;
    const { channel } = make(ledger);
    let sent = false;
    const out = await channel.dispatch("op-1", "argsA", async (): Promise<object> => {
      sent = true;
      return { ok: true };
    });
    expect(out.kind).toBe("placeholder-durability-failed");
    expect(sent).toBe(false); // 未发送：副作用通道从未开栓
    expect(ledger.placeholders).toHaveLength(0); // 写前拒绝替身：进程内视角无行（真实盘态由恢复重放裁决）
    ledger.failPlaceholder = false; // 恢复注入故障，后续派发正常耐久
    // 留置保守口径（A1-02）：同 opId 重试=unknown-effect（不重发）；重发=新 opId
    const retry = await channel.dispatch("op-1", "argsA", trackedSend(ledger));
    expect(retry).toEqual({ kind: "unknown-effect" });
    const fresh = await channel.dispatch("op-2", "argsA", trackedSend(ledger));
    expect(fresh).toEqual({ kind: "ok", result: { ok: true } });
    expect(ledger.events.filter((e) => e === "send")).toHaveLength(1); // 仅 op-2 发送过
  });

  it("占位 fsync 失败（写后拒绝，A1-02）：reject≠盘上无行——占位行已在数组但 reject；同 opId 仍 unknown-effect，新 opId=ok", async () => {
    const ledger = new FakeLedger();
    ledger.failPlaceholder = "after";
    const { channel } = make(ledger);
    const out = await channel.dispatch("op-1", "argsA", trackedSend(ledger));
    expect(out.kind).toBe("placeholder-durability-failed");
    expect(ledger.placeholders).toHaveLength(1); // 行已写（write 已落，fsync 报错）——不得宣称盘上无占位
    expect(ledger.events).toEqual([]); // send/result 从未发生
    ledger.failPlaceholder = false; // 恢复注入故障
    const retry = await channel.dispatch("op-1", "argsA", trackedSend(ledger));
    expect(retry).toEqual({ kind: "unknown-effect" }); // 与写前拒绝同口径：保守留置
    const fresh = await channel.dispatch("op-2", "argsA", trackedSend(ledger));
    expect(fresh).toEqual({ kind: "ok", result: { ok: true } });
  });

  it("send 抛错=效果未知：send-failed+占位留置（重试同 opId=unknown-effect 不重发）", async () => {
    const { channel } = make();
    const boom = async (): Promise<object> => {
      throw new Error("EPIPE");
    };
    const out = await channel.dispatch("op-1", "argsA", boom);
    expect(out.kind).toBe("send-failed");
    const retry = await channel.dispatch("op-1", "argsA", async () => ({ ok: true }));
    expect(retry).toEqual({ kind: "unknown-effect" }); // 不重发（效果未知态留置）
  });

  it("send 返回 null=协议违规（A1-05）：send-failed+审计行+占位留置（不得当 cached(null)/落盘洗白）", async () => {
    const { channel, audits, ledger } = make();
    const nullSend = async (): Promise<object> => null as unknown as object; // 运行时违规（类型面已禁）
    const out = await channel.dispatch("op-1", "argsA", nullSend);
    expect(out.kind).toBe("send-failed");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toContain("op-1");
    expect(audits[0]).toContain("null");
    expect(ledger.results).toHaveLength(0); // 不落结果行（null 哨兵不得进盘冒充事实）
    const retry = await channel.dispatch("op-1", "argsA", trackedSend(ledger));
    expect(retry).toEqual({ kind: "unknown-effect" }); // 占位留置：效果未知
  });

  it("结果耐久失败（写前拒绝）：result-durability-failed（结果在手）+内存保持占位态（重试=unknown-effect）", async () => {
    const ledger = new FakeLedger();
    ledger.failResult = true;
    const { channel } = make(ledger);
    const out = await channel.dispatch("op-1", "argsA", async () => ({ ok: true }));
    expect(out.kind).toBe("result-durability-failed");
    if (out.kind === "result-durability-failed") expect(out.result).toEqual({ ok: true });
    const retry = await channel.dispatch("op-1", "argsA", async () => ({ ok: true }));
    expect(retry).toEqual({ kind: "unknown-effect" }); // 结果行写入未确认：进程内保守口径
  });

  it("结果耐久失败（写后拒绝，A1-02）：进程内 unknown-effect 口径；原通道重试=unknown-effect；重放读到结果行=cached 非洗白", async () => {
    const ledger = new FakeLedger();
    ledger.failResult = "after";
    const { channel } = make(ledger);
    const out = await channel.dispatch("op-1", "argsA", async () => ({ ok: true }));
    expect(out.kind).toBe("result-durability-failed");
    expect(ledger.results).toHaveLength(1); // 结果行已写（fsync 报错不证明无行）
    // s1b：同通道（同内存 dedup）重试同 opId=unknown-effect（未 settle，不得凭 in 手结果当 cached）
    const retry = await channel.dispatch("op-1", "argsA", async () => ({ ok: "must-not-send" }));
    expect(retry).toEqual({ kind: "unknown-effect" });
    expect(ledger.events.filter((e) => e === "send")).toHaveLength(0); // 未重发
    // 重启重放：读到有效结果行=新增证据→cached（非洗白）
    const dedup2 = new CommandDedup();
    dedup2.replay(ledger.results);
    const channel2 = new CommandChannel({ dedup: dedup2, ledger: new FakeLedger(), now: () => T0 });
    const replayed = await channel2.dispatch("op-1", "argsA", async () => ({ ok: "other" }));
    expect(replayed).toEqual({ kind: "cached", result: { ok: true } }); // 按盘上事实，不重发
  });

  it("崩溃重放后旧 opId=unknown-effect（占位无结果不重发不受理）；新 opId 正常", async () => {
    const { dedup, channel } = make();
    dedup.replay([{ opId: "op-old", argsHash: "argsA", placedAt: T0, result: null }]); // 恢复重放占位行
    const out = await channel.dispatch("op-old", "argsA", async () => ({ ok: true }));
    expect(out).toEqual({ kind: "unknown-effect" });
    const out2 = await channel.dispatch("op-new", "argsA", async () => ({ ok: true }));
    expect(out2).toEqual({ kind: "ok", result: { ok: true } });
  });
});

describe("B1-02：审计钩子异常隔离（观测层失败不进主链路）", () => {
  it("同键不同参：onAudit 抛错不影响 rejected-different-args 返回", async () => {
    const ledger = new FakeLedger();
    const dedup = new CommandDedup();
    const channel = new CommandChannel({
      dedup,
      ledger,
      now: () => T0,
      onAudit: () => {
        throw new Error("audit-observer-down");
      },
    });
    let sends = 0;
    const send = async (): Promise<object> => {
      sends += 1;
      return { ok: true };
    };
    await channel.dispatch("op-1", "argsA", send); // 首次 ok
    const out = await channel.dispatch("op-1", "argsB", send); // 同键不同参
    expect(out).toEqual({ kind: "rejected-different-args" }); // dispatch 不因钩子 reject
    expect(sends).toBe(1); // 只首发过，拒参分支未发送
  });

  it("send 返回 null（A1-05）：onAudit 抛错不影响 send-failed+占位留置", async () => {
    const ledger = new FakeLedger();
    const dedup = new CommandDedup();
    const channel = new CommandChannel({
      dedup,
      ledger,
      now: () => T0,
      onAudit: () => {
        throw new Error("audit-observer-down");
      },
    });
    const out = await channel.dispatch("op-null", "argsA", async () => null as unknown as object);
    expect(out.kind).toBe("send-failed"); // 隔离生效：声明语义不被钩子改写
    expect(ledger.results).toHaveLength(0); // 未落结果行
    const retry = await channel.dispatch("op-null", "argsA", async () => ({ ok: true }));
    expect(retry).toEqual({ kind: "unknown-effect" }); // 占位留置（效果未知）
  });
});
