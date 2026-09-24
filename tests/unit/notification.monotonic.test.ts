// 十九审开工首序④：通知终态单调性——done 先落迟到 started 不降回（§17 接收账本）
import { describe, expect, it } from "vitest";
import { lateReplayAfterDone, transition } from "@pi-agent-ui/protocol";

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
  it("expired 独立：未终态可入 expired；expired 只允许晚到完成收口为 done", () => {
    expect(transition("started", "expired")).toBeNull();
    expect(transition("expired", "done")).toBeNull();
    expect(transition("expired", "started")).not.toBeNull();
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
