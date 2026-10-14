// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { ConversationState } from "../../../apps/web/src/ws/conversation-state";
import { useConversationLifetime } from "../../../apps/web/src/ws/use-conversation-lifetime";
import type { WriteClientSurface } from "../../../apps/web/src/ws/write-client";
import type { WriteSendOutcomeDTO } from "@pi-agent-ui/protocol/src/contracts";
afterEach(() => { cleanup(); vi.useRealTimers(); });
it("Strict 探测不销毁；真卸载物理清 timer；卸载后迟到回执零刷新", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let settle!: (outcome: WriteSendOutcomeDTO) => void;
  const client: WriteClientSurface = { sendPrompt: () => new Promise((yes) => { settle = yes; }), sendStop: vi.fn(), resume: vi.fn(), subscribe: () => () => {}, getSnapshot: () => ({ connState: "ready", errorKind: null, errorMessage: null, inflight: [], lastResult: null, lastResumeResult: null, resumeState: { phase: "idle" } }) };
  const refresh = vi.fn(); const owner = new ConversationState(refresh, 50); owner.setClient(client);
  const dispose = vi.spyOn(owner, "dispose");
  function Probe() { useConversationLifetime(owner); return React.createElement("div"); }
  const mounted = render(React.createElement(React.StrictMode, null, React.createElement(Probe)));
  await act(async () => { await Promise.resolve(); }); expect(dispose).not.toHaveBeenCalled();
  const id = owner.create("lifetime.jsonl")!; owner.edit(id, "still here"); const pending = owner.send(id);
  expect(vi.getTimerCount()).toBe(1);
  mounted.unmount(); await act(async () => { await Promise.resolve(); });
  expect(vi.getTimerCount()).toBe(0); expect(dispose).toHaveBeenCalledTimes(1);
  settle({ kind: "launched", intentId: "i-1", commandId: 1 }); await pending;
  expect(refresh).not.toHaveBeenCalled();
});
