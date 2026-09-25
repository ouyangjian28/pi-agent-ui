// 通用命令通道测试（TECH §3②占位先行序；r8/r8c 风险序 1：通用命令先耐久占位再发送）
// 覆盖：占位 fsync 先于 send／cached 不重发／同键不同参拒+审计／占位 fsync 失败回滚不发送／
// send 失败=效果未知留置／结果耐久失败=内存占位态／崩溃重放 unknown-effect。
import { describe, expect, it } from "vitest";
import { CommandChannel, CommandDedup } from "@pi-agent-ui/protocol";
import type { OpLedgerPort, OpRecord } from "@pi-agent-ui/protocol";

const T0 = "2026-09-25T00:00:00Z";

/** 受控 op 表端口：记录事件序（placeholder/send/result）；可按脚本失败。 */
class FakeLedger implements OpLedgerPort {
  readonly events: string[] = [];
  placeholders: OpRecord[] = [];
  failPlaceholder = false;
  failResult = false;

  appendPlaceholder(rec: OpRecord): Promise<void> {
    if (this.failPlaceholder) return Promise.reject(new Error("ph-eio"));
    this.placeholders.push(rec);
    this.events.push("placeholder");
    return Promise.resolve();
  }

  appendResult(_rec: OpRecord): Promise<void> {
    if (this.failResult) return Promise.reject(new Error("res-eio"));
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
  (ledger: FakeLedger, result: unknown = { ok: true }) =>
  async (): Promise<unknown> => {
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
    const send = async () => {
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

  it("占位 fsync 失败：不发送+内存占位回滚（同 opId 重新受理=admitted 非 unknown-effect）", async () => {
    const ledger = new FakeLedger();
    ledger.failPlaceholder = true;
    const { channel } = make(ledger);
    let sent = false;
    const out = await channel.dispatch("op-1", "argsA", async () => {
      sent = true;
      return { ok: true };
    });
    expect(out.kind).toBe("placeholder-durability-failed");
    expect(sent).toBe(false); // 未发送：副作用通道从未开栓
    // 回滚证据：同通道重试同 opId=重新受理（非 unknown-effect）——占位耐久失败不留内存脏占位
    ledger.failPlaceholder = false;
    const out1b = await channel.dispatch("op-1", "argsA", async () => ({ ok: true }));
    expect(out1b).toEqual({ kind: "ok", result: { ok: true } });
    expect(ledger.placeholders).toHaveLength(1); // 仅重试成功这一次落占位
    // 重新派发同 opId=正常受理（盘上无占位=事实一致）
    const ledger2 = new FakeLedger();
    const d2 = make(ledger2);
    const out2 = await d2.channel.dispatch("op-1", "argsA", trackedSend(ledger2));
    expect(out2).toEqual({ kind: "ok", result: { ok: true } });
  });

  it("send 抛错=效果未知：send-failed+占位留置（重试同 opId=unknown-effect 不重发）", async () => {
    const { channel } = make();
    const boom = async () => {
      throw new Error("EPIPE");
    };
    const out = await channel.dispatch("op-1", "argsA", boom);
    expect(out.kind).toBe("send-failed");
    const retry = await channel.dispatch("op-1", "argsA", async () => ({ ok: true }));
    expect(retry).toEqual({ kind: "unknown-effect" }); // 不重发（效果未知态留置）
  });

  it("结果耐久失败：result-durability-failed（结果在手）+内存保持占位态（重试=unknown-effect）", async () => {
    const ledger = new FakeLedger();
    ledger.failResult = true;
    const { channel } = make(ledger);
    const out = await channel.dispatch("op-1", "argsA", async () => ({ ok: true }));
    expect(out.kind).toBe("result-durability-failed");
    if (out.kind === "result-durability-failed") expect(out.result).toEqual({ ok: true });
    const retry = await channel.dispatch("op-1", "argsA", async () => ({ ok: true }));
    expect(retry).toEqual({ kind: "unknown-effect" }); // 盘上占位无结果=崩溃闭环口径
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
