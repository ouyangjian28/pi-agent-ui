// PiProcessHost 单元面：注入式 spawnFn + PassThrough 假 child（真 Node 流背压语义）
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { PiProcessHost } from "../../../apps/server/src/host/process-host.js";

/** 假子进程：process 本体=EventEmitter；三管道=PassThrough（真背压/真 destroy 语义）。 */
class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough({ highWaterMark: 16 * 1024 });
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kills: string[] = [];
  readonly spawnedBins: string[] = [];
  kill(sig: string): boolean {
    this.kills.push(sig);
    return true;
  }
}

function makeHost(): { host: PiProcessHost; child: FakeChild } {
  const child = new FakeChild();
  const host = new PiProcessHost({ spawnFn: () => child as unknown as ChildProcessWithoutNullStreams });
  return { host, child };
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
});
