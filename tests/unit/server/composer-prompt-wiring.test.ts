import { describe, expect, it, vi } from "vitest";
import { validateWriteFrame } from "@pi-agent-ui/protocol";
import { createRpcWriteHost } from "../../../apps/server/src/ws/rpc-write-host.ts";

const prompt = { t: "prompt", requestId: "r-1", file: "/tmp/s.jsonl", text: "hello" };

describe("输入区下一条参数契约与宿主接线", () => {
  it("旧prompt仍原形，缺省不自造思考级别", () => {
    expect(validateWriteFrame(prompt)).toEqual({ ok: true, frame: prompt });
  });
  it.each(["off", "minimal", "low", "medium", "high", "xhigh", "max"])("%s只证明语法合法，真实能力留给宿主确认", (thinkingLevel) => {
    expect(validateWriteFrame({ ...prompt, thinkingLevel })).toEqual({ ok: true, frame: { ...prompt, thinkingLevel } });
  });
  it.each([null, 3, [], "", "HIGH", "high ", "extreme", undefined])("非法思考值%j拒绝，不静默忽略", (thinkingLevel) => {
    expect(validateWriteFrame({ ...prompt, thinkingLevel })).toMatchObject({ ok: false, code: 4404 });
  });
  it("扩展不放松未知字段或其他帧", () => {
    expect(validateWriteFrame({ ...prompt, thinkingLevel: "low", surprise: true })).toMatchObject({ ok: false, code: 4404 });
    expect(validateWriteFrame({ t: "stop", file: prompt.file, requestId: "r-2", thinkingLevel: "low" })).toMatchObject({ ok: false, code: 4404 });
  });
  it("应用宿主透传下一条快照，默认调用仍保旧三参", async () => {
    const send = vi.fn(async () => ({ kind: "launched" as const, key: { intentId: "i-opts", commandId: 1, generation: 0 } }));
    const sessionFor = vi.fn(() => ({ send, stop: async () => { throw new Error("Unexpected stop"); } }));
    const host = createRpcWriteHost({ sessionFor });
    await host.sendPrompt(prompt.file, "first");
    expect(send).toHaveBeenLastCalledWith("first", undefined, undefined);
    await host.sendPrompt(prompt.file, "second", undefined, "fixture/two", undefined, { thinkingLevel: "high" });
    expect(send).toHaveBeenLastCalledWith("second", undefined, "fixture/two", { thinkingLevel: "high" });
    expect(sessionFor).toHaveBeenCalledTimes(1);
  });
});
