// 真进程宿主壳：ProcessHostPort 的生产实现（TECH §40）。
// - spawn：detached=非 win32（自成进程组）；stdio 三 pipe（stdin=命令主链路，不 ignore）；stdout/stderr 常驻排空（64KB 满假死红线）。
// - 退出证据=exit 事件（waitpid 口径）；异步 spawn 失败（ENOENT 等 error 事件不伴随 exit）折算 onExit(null,null)=保守意外退出。
// - writeStdin：Node 流背压（write false→等 drain）；EPIPE/destroyed→reject 呈现调用方；每次 spawn 新句柄（不可复用）。
// 单元测试注入 spawnFn+PassThrough；真 pi 冒烟走 integration。
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { LinePump } from "./line-pump.js";
import type { ProcessHandle, ProcessHostPort, ProcessSpawnHandlers } from "@pi-agent-ui/protocol";

export interface PiProcessHostOpts {
  /** pi 可执行文件（默认 PATH 解析 "pi"；测试/部署可换绝对路径）。 */
  readonly piBin?: string;
  /** spawn 函数注入（单元测试用假 child；默认 node:child_process.spawn）。 */
  readonly spawnFn?: (bin: string, args: string[], opts: { stdio: "pipe"[]; detached: boolean }) => ChildProcessWithoutNullStreams;
  /** 审计/诊断行（默认丢弃）。 */
  readonly onAudit?: (line: string) => void;
}

export class PiProcessHost implements ProcessHostPort {
  private static seq = 0;
  private readonly procs = new Map<string, ChildProcessWithoutNullStreams>();

  constructor(private readonly opts: PiProcessHostOpts = {}) {}

  private audit(line: string): void {
    this.opts.onAudit?.(`process-host ${line}`);
  }

  spawn(args: readonly string[], h: ProcessSpawnHandlers): ProcessHandle {
    const bin = this.opts.piBin ?? "pi";
    const spawnFn = this.opts.spawnFn ?? spawn;
    const child = spawnFn(bin, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const id = `proc-${++PiProcessHost.seq}`;
    this.procs.set(id, child);
    // 本句柄出口去重：error（未伴随 exit 的异步失败）与 exit 只报一次；后到的只进 stderr 记录。
    let exited = false;
    const reportExit = (code: number | null, signal: string | null) => {
      if (exited) return;
      exited = true;
      this.procs.delete(id);
      h.onExit(code, signal);
    };
    child.on("error", (e: unknown) => {
      const msg = e instanceof Error ? `${e.message}${(e as NodeJS.ErrnoException).code ? ` (${(e as NodeJS.ErrnoException).code})` : ""}` : String(e);
      this.audit(`error handle=${id} ${msg}`);
      h.onStderr(`[child-error] ${msg}`);
      // ENOENT 等异步失败不伴随 exit → 折算 null/null（保守意外退出，监管器按换代收口）
      reportExit(null, null);
    });
    child.on("exit", (code, signal) => {
      this.audit(`exit handle=${id} code=${code} signal=${signal}`);
      reportExit(code, signal);
    });
    // 常驻排空双管道（撕裂尾 flush 到解析层；坏行不炸泵）
    const stdoutPump = new LinePump((line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        h.onStderr(`[stdout-nonjson] ${line}`);
        return;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        h.onStderr(`[stdout-nonjson] ${line}`);
        return;
      }
      h.onEvent(parsed);
    });
    child.stdout.on("data", (c: Buffer) => stdoutPump.feed(c));
    child.stdout.on("end", () => stdoutPump.flush());
    const stderrPump = new LinePump((line) => h.onStderr(line));
    child.stderr.on("data", (c: Buffer) => stderrPump.feed(c));
    child.stderr.on("end", () => stderrPump.flush());
    return { id };
  }

  async writeStdin(h: ProcessHandle, text: string): Promise<void> {
    const child = this.procs.get(h.id);
    if (child === undefined) return Promise.reject(new Error(`writeStdin: 未知或已退出的句柄 ${h.id}`));
    const stdin = child.stdin;
    if (stdin.destroyed) return Promise.reject(new Error(`writeStdin: stdin 已关闭（句柄 ${h.id}）`));
    return new Promise<void>((resolve, reject) => {
      let settled = false; // write 回调/drain/error/close 多源竞态，只结算一次
      const onDrain = (): void => finish(resolve);
      const onStreamError = (err: Error): void => finish(() => reject(err)); // EPIPE 等：字节未确认交付
      const onClose = (): void => finish(() => reject(new Error(`writeStdin: stdin 在写入/背压等待中关闭（句柄 ${h.id}）`)));
      const cleanup = (): void => {
        stdin.off("drain", onDrain);
        stdin.off("error", onStreamError);
        stdin.off("close", onClose);
      };
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };
      stdin.on("drain", onDrain);
      stdin.on("error", onStreamError);
      stdin.on("close", onClose);
      const writable = stdin.write(text, (err) => {
        if (err) finish(() => reject(err instanceof Error ? err : new Error(String(err))));
        else if (writable) finish(resolve); // 返回 true=内核已消化，回调无错=字节确认
      });
      if (writable) finish(resolve); // 立即消化：背压不触发
      // writable=false：等 drain（或 error/close 兜底）；write 回调无错时若已 drain 也经 onDrain 结算
    });
  }

  stop(h: ProcessHandle, signal: "SIGTERM" | "SIGKILL"): void {
    const child = this.procs.get(h.id);
    if (child === undefined) {
      this.audit(`stop-unknown handle=${h.id} signal=${signal}`);
      return; // 已退出：kill 无意义
    }
    this.audit(`stop handle=${h.id} signal=${signal}`);
    child.kill(signal);
  }

  /** 优雅关闭：stdin EOF（pi RPC 收到 EOF 即退，实测 code=0）。端口外附加面，组装层用；监管器 retire 走信号路径。 */
  closeStdin(h: ProcessHandle): void {
    const child = this.procs.get(h.id);
    if (child === undefined) return;
    child.stdin.end();
  }
}
