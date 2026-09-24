// 集成冒烟：真 spawn pi --mode json，走完一轮 prompt→事件流→退出（本机依赖 pi 0.86.1；CI 标 integration 可选）
import { describe, expect, it } from "vitest";
import { spawnPi, type PiEvent } from "../../apps/server/src/host/pi-child.js";

describe("pi 子进程事件泵（集成冒烟）", () => {
  it(
    "spawn pi -p →stdout JSONL 事件流→退出",
    { timeout: 120_000 },
    async () => {
      const events: PiEvent[] = [];
      const stderrLines: string[] = [];
      const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        spawnPi(["-p", "只回复一个字：好"], {
          onEvent: (e) => events.push(e),
          onStderr: (t) => stderrLines.push(t),
          onExit: (code, signal) => resolve({ code, signal }),
        });
      });
      const { code } = await exited;
      expect(code).toBe(0); // 正常退出
      expect(events.length).toBeGreaterThan(0); // 事件流非空（agent_start 等）
      expect(events.some((e) => e.type === "agent_end" || e.type === "agent_settled")).toBe(true); // 至少跑完一轮
    },
  );
});
