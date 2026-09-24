// 十九审开工首序④：通知终态单调性——done 先落迟到 started 不降回（§17 接收账本）
import { describe, expect, it } from "vitest";
import { accountDomainClose, closeWithAcks, expireWithEvidence, lateReplayAfterDone, transition } from "@pi-agent-ui/protocol";

describe("通知状态机跃迁合法性（三 ACK 分立+单调性）", () => {
  it("主线相邻前进合法：received→derived→started→done", () => {
    expect(transition("received", "derived")).toBeNull();
    expect(transition("derived", "started")).toBeNull();
    expect(transition("started", "done")).toBeNull();
  });
  it("done 单调：done 后任何降级拒绝（含迟到 started）", () => {
    const r = transition("done", "started");
    expect(r).toContain("monotonic");
    expect(transition("done", "received")).not.toBeNull();
    expect(transition("done", "derived")).not.toBeNull();
    expect(transition("done", "done")).toBeNull(); // 幂等重放
  });
  it("禁倒退：derived→received 拒；received 不得跳 done（需经派生/开栓）", () => {
    expect(transition("derived", "received")).not.toBeNull();
    expect(transition("received", "done")).not.toBeNull();
  });
  it("expired 独立终态（一审 A1 修正）：未终态可入 expired；expired 后迟到 ACK 不升 done（超时收口即终局）", () => {
    expect(transition("started", "expired")).toBeNull();
    expect(transition("expired", "done")).not.toBeNull(); // 旧「晚到完成」口径废止——迟到 ACK 不收口
    expect(transition("expired", "started")).not.toBeNull();
    // 到期收口=证据驱动：deadline 未过不收口；过了才 expired
    expect(expireWithEvidence("started", false).closed).toBe(false);
    expect(expireWithEvidence("started", true)).toMatchObject({ state: "expired", closed: true });
    expect(expireWithEvidence("done", true).closed).toBe(false); // 终态单调
  });
  it("done 收口裁决（一审 A1）：三 ACK 齐才 done；缺一不收口；执行终局不替代 ACK；未开栓无收口面", () => {
    const none = { channelAck: false, presentAck: false, effectAck: false };
    expect(closeWithAcks("started", none).closed).toBe(false); // 零 ACK
    expect(closeWithAcks("started", { channelAck: true, presentAck: true, effectAck: false }).closed).toBe(false); // 二缺一
    expect(closeWithAcks("started", { channelAck: true, presentAck: true, effectAck: true })).toMatchObject({
      state: "done",
      closed: true,
    });
    expect(closeWithAcks("derived", { channelAck: true, presentAck: true, effectAck: true })).toMatchObject({ state: "done", closed: true }); // R2-06：derived 亦可收口（三 ACK 齐）
    expect(closeWithAcks("received", { channelAck: true, presentAck: true, effectAck: true }).closed).toBe(false); // 未派生
    // R2-06 两域：outbox expired 回执→账本域 done(reason=expired)；迟到 ACK 不改成因
    expect(accountDomainClose("expired", "expired", null)).toMatchObject({ state: "done", closed: true });
    expect(accountDomainClose("done", "expired", { channelAck: true, presentAck: true, effectAck: true }).closed).toBe(false); // done 后迟到 ACK 不改成因
    expect(accountDomainClose("started", "expired", null).closed).toBe(false); // 无 expired 回执不映射
    expect(closeWithAcks("done", { channelAck: true, presentAck: true, effectAck: true }).closed).toBe(false); // 终态单调
  });
});

describe("迟到重投墓碑（八审 P0-2：删墓碑后再投同 notificationId 不得重新执行）", () => {
  it("done 后重投=拒绝再派生，状态保持 done", () => {
    const r = lateReplayAfterDone("done", "redeliver");
    expect(r.accepted).toBe(false);
    expect(r.state).toBe("done");
    expect(r.reason).toContain("tombstone");
  });
  it("未终态重投=按未决恢复扫描处理（不误吞）", () => {
    const r = lateReplayAfterDone("derived", "redeliver");
    expect(r.accepted).toBe(true);
  });
});
