// pi 子进程宿主壳：spawn + 常驻排空（stdout/stderr）+ 事件流解析 + 退出捕获
// 集成面：真 spawn 依赖本机 pi；单元测试走 LinePump 级（line-pump.test.ts）+注入式 fake child（本文件不直接单测）。
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { LinePump } from "./line-pump";

export interface PiEvent {
  readonly type: string;
  readonly [k: string]: unknown;
}

export interface PiChildHandlers {
  onEvent(e: PiEvent): void;
  onStderr(text: string): void;
  onExit(code: number | null, signal: string | null): void;
}

/** spawn pi（--mode json：stdout=JSONL 事件流）。 */
export function spawnPi(args: readonly string[], h: PiChildHandlers): ChildProcessWithoutNullStreams {
  const child = spawn("pi", [...args, "--mode", "json"], { stdio: ["pipe", "pipe", "pipe"] });
  attachPumps(child, h);
  return child;
}

/** 挂常驻排空泵（也用于非本模块 spawn 的子进程：测试/复用）。 */
export function attachPumps(child: ChildProcessWithoutNullStreams, h: PiChildHandlers): void {
  const stdout = new LinePump((line) => {
    try {
      const e = JSON.parse(line) as PiEvent;
      if (typeof e.type === "string") h.onEvent(e);
    } catch {
      // 坏行/非 JSON 行（撕裂尾/横幅输出）：stderr 化记录，不炸泵
      h.onStderr(`[stdout-nonjson] ${line}`);
    }
  });
  const stderr = new LinePump((line) => h.onStderr(line));
  child.stdout.on("data", (d: Buffer) => stdout.feed(d.toString("utf8")));
  child.stderr.on("data", (d: Buffer) => stderr.feed(d.toString("utf8")));
  child.stdout.on("close", () => stdout.flush());
  child.stderr.on("close", () => stderr.flush());
  child.on("exit", (code, signal) => h.onExit(code, signal));
}
