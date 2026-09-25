// pi-child 泵接面单测（r8：解析错/无 type 行/业务回调错三路径分离；不依赖真 spawn）
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { attachPumps } from "../../../apps/server/src/host/pi-child.js";

function fakeChild() {
  const c = new EventEmitter() as unknown as {
    stdout: PassThrough;
    stderr: PassThrough;
    on: (ev: string, fn: (...a: unknown[]) => void) => void;
  };
  (c as { stdout: PassThrough }).stdout = new PassThrough();
  (c as { stderr: PassThrough }).stderr = new PassThrough();
  return c;
}

describe("attachPumps 三路径分离（r8）", () => {
  it("正常事件→onEvent；非 JSON 行→[stdout-nonjson]；无 type 行→[stdout-nonjson]；onEvent 抛错→[handler-error] 不误报格式问题且泵继续", () => {
    const child = fakeChild();
    const events: string[] = [];
    const stderr: string[] = [];
    attachPumps(child as never, {
      onEvent: (e) => {
        if (e.type === "boom") throw new Error("业务处理炸了");
        events.push(e.type as string);
      },
      onStderr: (t) => stderr.push(t),
      onExit: () => {},
    });
    child.stdout.write('{"type":"agent_start"}\n');
    child.stdout.write("这不是 JSON 横幅行\n");
    child.stdout.write('{"type":"boom"}\n');
    child.stdout.write('{"noType":true}\n');
    child.stdout.write('{"type":"agent_end"}\n'); // 泵在 handler 抛错后继续交付
    child.stdout.end();
    expect(events).toEqual(["agent_start", "agent_end"]);
    expect(stderr.some((l) => l.startsWith("[stdout-nonjson] 这不是 JSON"))).toBe(true);
    expect(stderr.some((l) => l.startsWith("[handler-error] boom"))).toBe(true); // 独立故障路径，非格式误报
    expect(stderr.some((l) => l.startsWith("[stdout-nonjson] {\"noType\""))).toBe(true);
  });

  it("r8b-01：null 行/数组行/原始值行不炸泵——与后续正常事件同块时也不丢（JSON.parse(\"null\") 成功但 e.type 会抛的回归）", () => {
    const child = fakeChild();
    const events: string[] = [];
    const stderr: string[] = [];
    attachPumps(child as never, {
      onEvent: (e) => {
        events.push(e.type as string);
      },
      onStderr: (t) => stderr.push(t),
      onExit: () => {},
    });
    // 同一 data 块：null + 数组 + 正常事件——旧实现在 e.type 处抛 TypeError，同块后续事件全丢
    child.stdout.write("null\n" + '["a","b"]' + "\n" + '{"type":"after_null"}\n');
    child.stdout.write("42\n"); // 非对象原始值同防护
    child.stdout.write('{"type":"tail"}\n');
    child.stdout.end();
    expect(events).toEqual(["after_null", "tail"]); // 不抛+同块后续事件照常交付
    expect(stderr.some((l) => l.startsWith("[stdout-nonjson] null"))).toBe(true);
    expect(stderr.some((l) => l.startsWith('[stdout-nonjson] ["a","b"]'))).toBe(true);
    expect(stderr.some((l) => l.startsWith("[stdout-nonjson] 42"))).toBe(true);
  });
});
