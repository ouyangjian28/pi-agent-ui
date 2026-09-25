// PiProcessHost 单元面：注入式 spawnFn + PassThrough 假 child（真 Node 流背压语义）
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { PiProcessHost } from "../../../apps/server/src/host/process-host.js";

/** 假子进程：process 本体=EventEmitter；三管道=PassThrough（真背压/真 destroy 语义）。pid 可注入（S4-02 分立判据）。 */
class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough({ highWaterMark: 16 * 1024 });
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kills: string[] = [];
  pid: number | undefined = undefined; // 默认=未创建（spawn 失败形态）
  kill(sig: string): boolean {
    this.kills.push(sig);
    return true;
  }
}

function makeHost(onAudit?: (line: string) => void): { host: PiProcessHost; child: FakeChild; audits: string[] } {
  const child = new FakeChild();
  const audits: string[] = [];
  const host = new PiProcessHost({
    spawnFn: () => child as unknown as ChildProcessWithoutNullStreams,
    ...(onAudit !== undefined ? { onAudit: (l) => { audits.push(l); onAudit(l); } } : { onAudit: (l) => audits.push(l) }),
  });
  return { host, child, audits };
}

function handlers() {
  const events: unknown[] = [];
  const stderr: string[] = [];
  const exits: Array<{ code: number | null; signal: string | null }> = [];
  return {
    events,
    stderr,
    exits,
    h: {
      onEvent: (e: unknown) => events.push(e),
      onStderr: (t: string) => stderr.push(t),
      onExit: (code: number | null, signal: string | null) => exits.push({ code, signal }),
    },
  };
}

const until = async (f: () => boolean, what: string, ms = 1000): Promise<void> => {
  const t0 = Date.now();
  while (!f()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("PiProcessHost（注入式假 child）", () => {
  it("spawn：事件泵解析好行/坏行分流+撕裂行跨块拼接+stderr 透传", async () => {
    const { host, child } = makeHost();
    const rec = handlers();
    host.spawn(["--mode", "rpc"], rec.h);
    child.stdout.write('{"type":"agent_start","seq"');
    child.stdout.write(':1}\n{"type":"response"}\nnot-json\n');
    child.stdout.end(); // flush 残尾
    child.stderr.write("warn line\n");
    child.stderr.end();
    await until(() => rec.events.length === 2 && rec.stderr.length === 2, "事件+stderr 全到");
    expect(rec.events[0]).toEqual({ type: "agent_start", seq: 1 });
    expect(rec.events[1]).toEqual({ type: "response" });
    expect(rec.stderr[0]).toBe("[stdout-nonjson] not-json");
  });

  it("句柄唯一：两次 spawn 两个不同 id", () => {
    const child = new FakeChild();
    const host = new PiProcessHost({ spawnFn: () => child as unknown as ChildProcessWithoutNullStreams });
    const h1 = host.spawn([], handlers().h);
    const h2 = host.spawn([], handlers().h);
    expect(h1.id).not.toBe(h2.id);
  });

  it("writeStdin 真背压：缓冲满→等 drain→resolve；期间字节可读", async () => {
    const { host, child } = makeHost();
    const rec = handlers();
    const handle = host.spawn([], rec.h);
    const big = "x".repeat(64 * 1024); // > 16KB highWaterMark
    const p = host.writeStdin(handle, big);
    let done = false;
    void p.then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false); // 未读走=背压挂着
    const got: Buffer[] = [];
    child.stdin.on("data", (d: Buffer) => got.push(d));
    await until(() => done, "drain 后 resolve");
    expect(Buffer.concat(got).length).toBe(64 * 1024);
  });

  it("writeStdin EPIPE：stdin 带错 destroy→reject 呈现调用方", async () => {
    const { host, child } = makeHost();
    const handle = host.spawn([], handlers().h);
    const epipe = new Error("write EPIPE");
    child.stdin.on("error", () => {}); // 吸掉流级 error（无监听会成进程级 uncaught）；拒绝路径由 writeStdin 自证
    child.stdin.destroy(epipe);
    await expect(host.writeStdin(handle, "line\n")).rejects.toThrow(/EPIPE|destroyed|关闭/);
  });

  it("exit 事件=唯一退出证据；error 后到的 exit 不重复报；句柄清理后 writeStdin 拒绝", async () => {
    const { host, child } = makeHost();
    const rec = handlers();
    const handle = host.spawn([], rec.h);
    child.emit("error", Object.assign(new Error("spawn pi ENOENT"), { code: "ENOENT" }));
    child.emit("exit", 1, null); // error 之后的 exit：不重复
    expect(rec.exits).toEqual([{ code: null, signal: null }]);
    expect(rec.stderr[0]).toContain("[child-error] spawn pi ENOENT (ENOENT)");
    await expect(host.writeStdin(handle, "x")).rejects.toThrow(/未知或已退出/);
  });

  it("正常退出：exit(code,signal) 直报+flush 残尾行", async () => {
    const { host, child } = makeHost();
    const rec = handlers();
    host.spawn([], rec.h);
    child.stdout.write('{"type":"tail"}'); // 无换行残尾
    child.emit("exit", 0, null);
    child.stdout.end(); // 触发 flush
    child.stderr.end();
    await until(() => rec.exits.length === 1 && rec.events.length === 1, "exit+残尾");
    expect(rec.exits[0]).toEqual({ code: 0, signal: null });
    expect(rec.events[0]).toEqual({ type: "tail" });
  });

  it("stop：kill 信号透传；未知句柄安全 no-op", () => {
    const { host, child } = makeHost();
    const rec = handlers();
    const handle = host.spawn([], rec.h);
    host.stop(handle, "SIGTERM");
    host.stop(handle, "SIGKILL");
    host.stop({ id: "proc-999" }, "SIGTERM");
    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("closeStdin：EOF 写出（优雅关闭面）", async () => {
    const { host, child } = makeHost();
    const handle = host.spawn([], handlers().h);
    let sawEnd = false;
    child.stdin.on("finish", () => {
      sawEnd = true;
    });
    host.closeStdin(handle);
    await until(() => sawEnd, "stdin EOF");
  });

  it("stdout 大块多行一次到达：全部解析不丢", async () => {
    const { host, child } = makeHost();
    const rec = handlers();
    host.spawn([], rec.h);
    const lines = Array.from({ length: 50 }, (_, i) => `{"type":"e${i}"}`);
    child.stdout.write(lines.join("\n") + "\n");
    child.stdout.end();
    await until(() => rec.events.length === 50, "50 行全到");
  });

  // ---- S4-01：write true≠成功；成功=回调无错+背压释放；生命周期级错误吸收 ----
  it("S4-01a 短写异步 EPIPE：write 已接收但回调报错→reject（不得先报成功）；迟到流错误被吸收器兜住", async () => {
    // 持回调的受控 Writable：write true 但回调未兑现（GPT P1 同构）
    class HoldStdin extends Writable {
      cb: ((e: Error | null) => void) | null = null;
      _write(_c: Buffer, _enc: string, cb: (e: Error | null) => void): void {
        this.cb = cb;
      }
    }
    const { host, child, audits } = makeHost();
    const hold = new HoldStdin();
    Object.defineProperty(child, "stdin", { value: hold });
    const handle = host.spawn([], handlers().h);
    let resolved = false;
    const p = host.writeStdin(handle, "line\n");
    void p.then(
      () => {
        resolved = true;
      },
      () => undefined,
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(resolved).toBe(false); // 新语义：等 write 回调，write true 不算成功
    expect(hold.cb).not.toBeNull();
    hold.cb?.(new Error("write EPIPE")); // 回调报错→字节未确认→reject
    await expect(p).rejects.toThrow(/EPIPE/);
    expect(resolved).toBe(false);
    hold.emit("error", new Error("late EPIPE")); // 结算后迟到流错误：吸收器在场→无 uncaught+审计
    await until(() => audits.some((l) => l.includes("stdin-error")), "生命周期吸收器审计");
  });

  it("S4-01b 背压中错误：64KB 挂起中 destroy(err)→reject 不挂死", async () => {
    const { host, child } = makeHost();
    const handle = host.spawn([], handlers().h);
    const p = host.writeStdin(handle, "x".repeat(64 * 1024));
    await new Promise((r) => setTimeout(r, 10));
    child.stdin.destroy(new Error("EPIPE in backlog"));
    await expect(p).rejects.toThrow(/EPIPE/);
  });

  it("S4-01c pending 中 close：背压挂起中无错 destroy→close 事件→reject（不是成功）", async () => {
    const { host, child } = makeHost();
    const handle = host.spawn([], handlers().h);
    const p = host.writeStdin(handle, "x".repeat(64 * 1024));
    await new Promise((r) => setTimeout(r, 10));
    child.stdin.destroy(); // 无 error：只走 close 分支
    await expect(p).rejects.toThrow(/关闭/);
  });

  it("S4-01d 同步抛错：stdin.write 同步 throw→reject+监听清理（不留泄漏监听）", async () => {
    const { host, child } = makeHost();
    const handle = host.spawn([], handlers().h);
    Object.defineProperty(child.stdin, "write", {
      value: () => {
        throw new Error("sync boom");
      },
    });
    await expect(host.writeStdin(handle, "x")).rejects.toThrow(/sync boom/);
  });

  // ---- S4-02：error 分立——存活进程上的运行错误≠退出证据 ----
  it("S4-02 运行错误（pid 在）不折算退出：句柄保留可写；stderr 记录；后到真 exit 正常上报恰一次", async () => {
    const { host, child } = makeHost();
    const rec = handlers();
    child.pid = 4242; // 进程已创建（运行形态）
    const handle = host.spawn([], rec.h);
    child.emit("error", Object.assign(new Error("kill EPERM"), { code: "EPERM", syscall: "kill" }));
    expect(rec.exits).toEqual([]); // 不伪造退出证据
    expect(rec.stderr[0]).toContain("[child-error] kill EPERM (EPERM)");
    child.stdin.on("data", () => undefined); // 读走输出侧，让写回调兑现
    await host.writeStdin(handle, "still-alive\n"); // 句柄保留：写仍可用
    child.emit("exit", 0, null); // 真退出证据后到：正常上报
    expect(rec.exits).toEqual([{ code: 0, signal: null }]);
    await expect(host.writeStdin(handle, "x")).rejects.toThrow(/未知或已退出/);
  });

  // ---- S4-07：诊断/消费者异常不阻断关键路径 ----
  it("S4-07a 审计抛错不阻断：exit 仍上报+stop kill 仍执行", () => {
    const child = new FakeChild();
    child.pid = 4242;
    const host = new PiProcessHost({
      spawnFn: () => child as unknown as ChildProcessWithoutNullStreams,
      onAudit: () => {
        throw new Error("audit down");
      },
    });
    const rec = handlers();
    const handle = host.spawn([], rec.h);
    host.stop(handle, "SIGTERM");
    expect(child.kills).toEqual(["SIGTERM"]); // kill 未被审计异常吞掉
    child.emit("exit", 0, null);
    expect(rec.exits).toEqual([{ code: 0, signal: null }]); // 退出登记未被审计异常吞掉
  });

  it("S4-07b 消费者抛错不截断事件泵：同块 a 抛错→b 仍处理+[handler-error] 诊断", async () => {
    const { host, child } = makeHost();
    const events: unknown[] = [];
    const stderr: string[] = [];
    host.spawn([], {
      onEvent: (e) => {
        if ((e as { type: string }).type === "a-marker") throw new Error("consumer boom");
        events.push(e);
      },
      onStderr: (t) => stderr.push(t),
      onExit: () => undefined,
    });
    child.stdout.write('{"type":"a-marker"}\n{"type":"b"}\n');
    await until(() => events.length === 1, "b 行仍被处理");
    expect(events).toEqual([{ type: "b" }]);
    expect(stderr.some((l) => l.includes("[handler-error] consumer boom"))).toBe(true);
  });

  // ---- Y2：事件形状验证对齐 pi-child（type 必须字符串）----
  it("Y2 type 非字符串：{\"type\":123} 分流 [stdout-nonjson]，不进 onEvent", async () => {
    const { host, child } = makeHost();
    const rec = handlers();
    host.spawn([], rec.h);
    child.stdout.write('{"type":123}\n');
    child.stdout.end();
    await until(() => rec.stderr.length === 1, "坏行分流");
    expect(rec.stderr[0]).toContain('[stdout-nonjson] {"type":123}');
    expect(rec.events).toEqual([]);
  });
});
