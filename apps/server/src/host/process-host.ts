// 真进程宿主壳：ProcessHostPort 的生产实现（TECH §40）。
// - spawn：detached=非 win32（自成进程组）；stdio 三 pipe（stdin=命令主链路，不 ignore）；stdout/stderr 常驻排空（64KB 满假死红线）。
// - 退出证据=exit 事件（waitpid 口径）。error 事件分立（S4-02）：进程未创建（pid===undefined，如 ENOENT）
//   折算 onExit(null,null)=保守意外退出；已创建进程上的运行错误（kill EPERM 等，进程仍活）只进 stderr+审计，
//   保留句柄与退出屏障，等真实 exit——杀不掉≠已退出，不得伪造退出证据。
// - writeStdin（S4-01）：成功=write 回调无错 且（返回 true 或已见 drain）；write true 只表示未达背压阈值，
//   不等于字节确认；生命周期级 stdin error 吸收器（spawn 时挂、永不摘）兜住结算后到达的流错误。
// - 诊断隔离（S4-07）：审计走不抛出的 safeAudit（不阻止 kill/退出登记/清理）；事件消费者抛错走
//   [handler-error] 诊断路径，同块后续行继续排空。
// 单元测试注入 spawnFn+PassThrough；真 pi 冒烟走 integration。
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { LinePump } from "./line-pump.js";
import type { ProcessHandle, ProcessHostPort, ProcessSpawnHandlers } from "@pi-agent-ui/protocol";

export interface PiProcessHostOpts {
  /** pi 可执行文件（默认 PATH 解析 "pi"；测试/部署可换绝对路径）。 */
  readonly piBin?: string;
  /** spawn 函数注入（单元测试用假 child；默认 node:child_process.spawn）。 */
  readonly spawnFn?: (bin: string, args: string[], opts: { stdio: "pipe"[]; detached: boolean }) => ChildProcessWithoutNullStreams;
  /** 审计/诊断行（默认丢弃）。异常被隔离，不影响关键路径。 */
  readonly onAudit?: (line: string) => void;
}

export class PiProcessHost implements ProcessHostPort {
  private static seq = 0;
  private readonly procs = new Map<string, ChildProcessWithoutNullStreams>();

  constructor(private readonly opts: PiProcessHostOpts = {}) {}

  /** 审计隔离（S4-07）：onAudit 同步抛错不得阻止退出登记/kill/清理。 */
  private audit(line: string): void {
    try {
      this.opts.onAudit?.(`process-host ${line}`);
    } catch {
      // 吞掉：诊断通道自身故障不阻断关键路径（无更底层通道，静默）
    }
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
    // 本句柄出口去重：error（折算路径）与 exit 只报一次；后到的只进 stderr 记录。
    let exited = false;
    const reportExit = (code: number | null, signal: string | null): void => {
      if (exited) return;
      exited = true;
      this.procs.delete(id);
      h.onExit(code, signal);
    };
    // 生命周期级 stdin 错误吸收器（S4-01）：writeStdin 结算后的迟到流错误不得成为未捕获异常。
    child.stdin.on("error", (e: unknown) => {
      this.audit(`stdin-error handle=${id} ${e instanceof Error ? e.message : String(e)}`);
    });
    child.on("error", (e: unknown) => {
      const msg = e instanceof Error ? `${e.message}${(e as NodeJS.ErrnoException).code ? ` (${(e as NodeJS.ErrnoException).code})` : ""}` : String(e);
      this.audit(`error handle=${id} ${msg}`);
      try {
        h.onStderr(`[child-error] ${msg}`);
      } catch (ce: unknown) {
        this.audit(`stderr-callback-failed handle=${id} ${ce instanceof Error ? ce.message : String(ce)}`);
      }
      // S4-02 分立：仅「进程未创建」（pid undefined，ENOENT 等异步 spawn 失败，不伴随 exit）折算退出；
      // 存活进程上的运行错误（kill EPERM 等）保留句柄，等真实 exit（唯一退出证据）。
      if (child.pid === undefined) reportExit(null, null);
      else this.audit(`error-runtime-kept handle=${id} pid=${child.pid}`); // 不删句柄：后续 write/stop 仍可用
    });
    child.on("exit", (code, signal) => {
      this.audit(`exit handle=${id} code=${code} signal=${signal}`);
      reportExit(code, signal);
    });
    // 常驻排空双管道（撕裂尾 flush 到解析层；坏行不炸泵；消费者异常不截断同块后续行）
    const stdoutPump = new LinePump((line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.tryStderr(h, id, `[stdout-nonjson] ${line}`);
        return;
      }
      // 形状验证（Y2，对齐 pi-child）：非 null/非对象/数组/type 非字符串 → 坏行分流
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        typeof (parsed as { type?: unknown }).type !== "string"
      ) {
        this.tryStderr(h, id, `[stdout-nonjson] ${line}`);
        return;
      }
      try {
        h.onEvent(parsed);
      } catch (ce: unknown) {
        // 消费者异常（S4-07/P8）：诊断+继续排空同块后续行（不重试该行）
        this.tryStderr(h, id, `[handler-error] ${ce instanceof Error ? ce.message : String(ce)}`);
      }
    });
    child.stdout.on("data", (c: Buffer) => stdoutPump.feed(c));
    child.stdout.on("end", () => stdoutPump.flush());
    const stderrPump = new LinePump((line) => this.tryStderr(h, id, line));
    child.stderr.on("data", (c: Buffer) => stderrPump.feed(c));
    child.stderr.on("end", () => stderrPump.flush());
    return { id };
  }

  /** stderr 回调隔离：onStderr 抛错不得截断事件泵/退出手续。 */
  private tryStderr(h: ProcessSpawnHandlers, id: string, text: string): void {
    try {
      h.onStderr(text);
    } catch (e: unknown) {
      this.audit(`stderr-callback-failed handle=${id} ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async writeStdin(h: ProcessHandle, text: string): Promise<void> {
    const child = this.procs.get(h.id);
    if (child === undefined) return Promise.reject(new Error(`writeStdin: 未知或已退出的句柄 ${h.id}`));
    const stdin = child.stdin;
    if (stdin.destroyed) return Promise.reject(new Error(`writeStdin: stdin 已关闭（句柄 ${h.id}）`));
    return new Promise<void>((resolve, reject) => {
      let settled = false; // write 回调/drain/error/close 多源竞态，只结算一次
      let cbOk = false; // write 回调无错（字节确认）
      let backlog = true; // 背压未释放（write 返回 true 才置 false；否则等 drain）
      const cleanup = (): void => {
        stdin.off("drain", onDrain);
        stdin.off("error", onStreamError);
        stdin.off("close", onClose);
      };
      const maybeResolve = (): void => {
        if (!settled && cbOk && !backlog) {
          settled = true;
          cleanup();
          resolve();
        }
      };
      const finishErr = (err: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };
      const onDrain = (): void => {
        backlog = false;
        maybeResolve();
      };
      const onStreamError = (err: Error): void => finishErr(err); // EPIPE 等：字节未确认交付
      const onClose = (): void => finishErr(new Error(`writeStdin: stdin 在写入/背压等待中关闭（句柄 ${h.id}）`));
      stdin.on("drain", onDrain);
      stdin.on("error", onStreamError);
      stdin.on("close", onClose);
      try {
        const writable = stdin.write(text, (err) => {
          if (err) {
            finishErr(err instanceof Error ? err : new Error(String(err)));
            return;
          }
          cbOk = true;
          maybeResolve(); // 成功=回调无错+背压已释放（true 或 drain）
        });
        if (writable) {
          backlog = false;
          maybeResolve(); // 未达阈值也须等回调无错（S4-01：true≠已写入）
        }
      } catch (e: unknown) {
        finishErr(e instanceof Error ? e : new Error(String(e))); // 同步抛错（罕见）也走统一清理
      }
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
