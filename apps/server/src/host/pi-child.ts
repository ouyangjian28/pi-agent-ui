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

/** spawn pi（--mode json：stdout=JSONL 事件流；stdin 立即 EOF——否则 readPipedStdin 等 stdin 数据挂死零输出）。 */
export function spawnPi(args: readonly string[], h: PiChildHandlers): ChildProcessWithoutNullStreams {
  const child = spawn("pi", [...args, "--mode", "json"], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end(); // EOF 必给（main.ts readPipedStdin 等管道数据直到 EOF；不给=挂死）
  // 超时保护=父进程自己 kill 计时器（勿用 shell timeout 包裹——pi 权限系统 wrapper floor 会拦）
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
  child.stdout.on("data", (d: Buffer) => stdout.feed(d));
  child.stderr.on("data", (d: Buffer) => stderr.feed(d));
  child.stdout.on("close", () => stdout.flush());
  child.stderr.on("close", () => stderr.flush());
  child.on("exit", (code, signal) => h.onExit(code, signal));
}
