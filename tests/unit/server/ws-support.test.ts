// 切片③ 3a 支撑组件单测（w0 验收 A1-A6/B7-B12/D21-D22 对应面）
// safe-open：域解析/symlink 拒绝/非常规拒/有界读；token-auth：fail-closed/热轮换撤销/乱序；
// connection-queue：双门边界/4431 恰一次/批量让步/迟到回调/背压门；compute-semaphore：并发 2/FIFO/超时/取消；
// session-scan：枚举上限/稳定排序/sanitize 先于截断/条目级 partial。
import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputeSemaphore } from "../../../apps/server/src/ws/compute-semaphore.ts";
import { ConnectionQueue, type SendPort } from "../../../apps/server/src/ws/connection-queue.ts";
import { openSafeFile, readSafeWithin, resolveWithinRoots } from "../../../apps/server/src/ws/safe-open.ts";
import { scanSessions } from "../../../apps/server/src/ws/session-scan.ts";
import { TokenAuthority } from "../../../apps/server/src/ws/token-auth.ts";
import { gatewayMetaFrom } from "../../../apps/server/src/ws/ws-transport.ts";

function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ws-support-"));
}

// ---------- safe-open ----------
describe("safe-open（A1-A4）", () => {
  it("域解析：双根+分隔边界", () => {
    expect(resolveWithinRoots("a.jsonl", ["/r1", "/r2"])).toBe("/r1/a.jsonl");
    expect(resolveWithinRoots("../x.jsonl", ["/r1"])).toBeNull();
    expect(resolveWithinRoots("../ax.jsonl", ["/r1/a"])).toBeNull(); // 兄弟前缀目录：必须整段之内
    expect(resolveWithinRoots("sub/b.jsonl", ["/r1"])).toBe("/r1/sub/b.jsonl");
  });

  it("symlink 最终组件拒绝（O_NOFOLLOW）；根内 symlink 同样拒绝", async () => {
    const d = await tmp();
    try {
      const real = join(d, "real.jsonl");
      await writeFile(real, "x");
      await symlink(real, join(d, "link.jsonl"));
      await expect(openSafeFile(join(d, "link.jsonl"))).rejects.toThrow(/symlink/);
      await expect(readSafeWithin("link.jsonl", [d], 1024)).rejects.toThrow(/symlink/);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  it("目录（非常规文件）拒绝", async () => {
    const d = await tmp();
    try {
      const sub = join(d, "subdir.jsonl");
      await mkdir(sub);
      await expect(openSafeFile(sub)).rejects.toThrow(/not-regular|open-denied|ELOOP|symlink/);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  it("有界读：超限即刻失败（too-large），不读完", async () => {
    const d = await tmp();
    try {
      const f = join(d, "big.jsonl");
      await writeFile(f, "a".repeat(3000));
      await expect(readSafeWithin("big.jsonl", [d], 1024)).rejects.toThrow(/too-large/);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  it("正常读取同句柄闭环", async () => {
    const d = await tmp();
    try {
      await writeFile(join(d, "ok.jsonl"), '{"t":"x"}\n');
      const buf = await readSafeWithin("ok.jsonl", [d], 1024);
      expect(buf.toString()).toBe('{"t":"x"}\n');
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });
});

// ---------- token-auth ----------
describe("token-auth（A5-A6）", () => {
  it("fromTokens 校验；check 逐字比对", () => {
    const a = TokenAuthority.fromTokens(["tok-a", "tok-b"]);
    expect(a.check("tok-a")).toBe(true);
    expect(a.check("tok-b")).toBe(true);
    expect(a.check("tok-c")).toBe(false);
    expect(a.check("")).toBe(false);
  });

  it("fromFile 初始不可读→fail-closed 抛错（拒启动）", async () => {
    const d = await tmp();
    try {
      await expect(TokenAuthority.fromFile(join(d, "missing.json"))).rejects.toThrow();
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  it("fromFile+reload：撤销集合=旧−新；失败沿用旧", async () => {
    const d = await tmp();
    try {
      const f = join(d, "tokens.json");
      await writeFile(f, JSON.stringify({ version: 1, tokens: ["t1", "t2"] }));
      const a = await TokenAuthority.fromFile(f);
      expect(a.check("t1")).toBe(true);
      await writeFile(f, JSON.stringify({ version: 1, tokens: ["t2"] }));
      const r = await a.reload();
      expect(r.changed).toBe(true);
      expect(r.revoked).toHaveLength(1);
      expect(a.check("t1")).toBe(false);
      // 失败 reload：文件变非法→沿用旧基准
      await writeFile(f, "{broken");
      const r2 = await a.reload();
      expect(r2.changed).toBe(false);
      expect(a.check("t2")).toBe(true);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  it("reload 乱序丢弃（不回退旧版本）", async () => {
    // 两次并发 reload：旧慢新快——旧完成时序号过期被丢弃，不覆盖新集合
    const d = await tmp();
    try {
      const f = join(d, "tokens.json");
      await writeFile(f, JSON.stringify({ version: 1, tokens: ["v1"] }));
      let current = "v1";
      const fakeDeps = {
        readFile: async (_p: string) => JSON.stringify({ version: 1, tokens: [current] }),
      } as unknown as Parameters<typeof TokenAuthority.fromFile>[1];
      const a = await TokenAuthority.fromFile(f, fakeDeps);
      current = "v2";
      const r1p = a.reload(); // 读到 v2（慢）
      current = "v3";
      const r2 = await a.reload(); // 读到 v3（先完成）
      await r1p;
      expect(a.check("v3")).toBe(true);
      expect(a.check("v2")).toBe(false);
      expect(r2.changed).toBe(true);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });
});

// ---------- connection-queue ----------
class FakePort implements SendPort {
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  closed: unknown[] = [];
  terminated = 0;
  failNextSend = false;
  sendCbDelay = 0;
  pendingCbs: Array<(err?: Error | null) => void> = [];
  send(data: string, cb?: (err?: Error | null) => void): void {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error("sync boom");
    }
    this.sent.push(data);
    if (cb) {
      if (this.sendCbDelay > 0) this.pendingCbs.push(cb);
      else cb(null);
    }
  }
  close(code?: number, reason?: string): void {
    this.closed.push([code, reason]);
    this.readyState = 2; // CLOSING（握手未完成；terminate 才 CLOSED）
  }
  terminate(): void {
    this.terminated++;
    this.readyState = 3;
  }
  flush(err?: Error | null): void {
    const cbs = this.pendingCbs.splice(0);
    for (const c of cbs) c(err);
  }
}

function mkQueue(port: FakePort, over: Partial<ConstructorParameters<typeof ConnectionQueue>[0]> = {}): ConnectionQueue {
  return new ConnectionQueue({
    port,
    maxFrames: 8,
    maxBytes: 4096,
    drainBatch: 4,
    closeWaitMs: 50,
    setTimeout: (cb) => setTimeout(cb, 0) as unknown as unknown,
    setImmediate: (cb) => setImmediate(cb),
    clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    ...over,
  });
}

async function microtasks(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

describe("connection-queue（B7-B10）", () => {
  it("正常 drain：全部经 port.send，回调成功释放字节", async () => {
    const p = new FakePort();
    const q = mkQueue(p);
    for (let i = 0; i < 6; i++) expect(q.enqueue({ t: "error", code: 4404, message: `m${i}`, retryable: false, requestId: "" })).toBe("queued");
    await new Promise((r) => setTimeout(r, 10));
    expect(p.sent).toHaveLength(6);
    expect(q.depth).toBe(0);
    q.dispose();
  });

  it("帧数门：边界允许 +1 拒→恰一次 4431 直发+close(4431)+限时 terminate", async () => {
    const p = new FakePort();
    const q = mkQueue(p, { maxFrames: 3 });
    q.enqueue({ t: "error", code: 4404, message: "a", retryable: false, requestId: "" });
    q.enqueue({ t: "error", code: 4404, message: "b", retryable: false, requestId: "" });
    q.enqueue({ t: "error", code: 4404, message: "c", retryable: false, requestId: "" });
    expect(q.enqueue({ t: "error", code: 4404, message: "d", retryable: false, requestId: "" })).toBe("rejected-overflow");
    const j = JSON.parse(p.sent[p.sent.length - 1]!);
    expect(j.code).toBe(4431);
    expect(j.retryable).toBe(true);
    const count4431 = p.sent.filter((s) => JSON.parse(s).code === 4431).length;
    expect(count4431).toBe(1);
    expect(p.closed[0]).toEqual([4431, "connection-queue-overflow"]);
    await new Promise((r) => setTimeout(r, 60));
    expect(p.terminated).toBe(1);
    expect(q.enqueue({ t: "error", code: 4404, message: "e", retryable: false, requestId: "" })).not.toBe("queued");
    q.dispose();
  });

  it("字节门：累计超限拒收（边界=允许）", async () => {
    const p = new FakePort();
    const q = mkQueue(p, { maxBytes: 300, maxFrames: 100 });
    const f = (i: number): { t: "error"; code: 4404; message: string; retryable: false; requestId: string } =>
      ({ t: "error", code: 4404, message: "x".repeat(70), retryable: false, requestId: `r${i}` });
    q.enqueue(f(1)); // ≈141B
    const r2 = q.enqueue(f(2));
    expect(r2).toBe("queued"); // 两帧 ≈282 <300 边界内允许
    expect(q.enqueue(f(3))).toBe("rejected-overflow"); // ≈423 >300
    q.dispose();
  });

  it("回调错误→终止；迟到回调不复活不复账", async () => {
    const p = new FakePort();
    const q = mkQueue(p);
    p.sendCbDelay = 1;
    q.enqueue({ t: "error", code: 4404, message: "a", retryable: false, requestId: "" });
    await new Promise((r) => setImmediate(r)); // drain 已执行，回调挂起
    p.flush(new Error("EPIPE"));
    await new Promise((r) => setTimeout(r, 5));
    expect(p.closed.length).toBeGreaterThan(0);
    const sentBefore = p.sent.length;
    p.flush(null); // 迟到成功回调
    expect(p.sent.length).toBe(sentBefore);
    q.dispose();
  });

  it("send 同步抛错→终止", async () => {
    const p = new FakePort();
    const q = mkQueue(p);
    p.failNextSend = true;
    q.enqueue({ t: "error", code: 4404, message: "a", retryable: false, requestId: "" });
    await new Promise((r) => setTimeout(r, 5));
    expect(p.closed.length).toBeGreaterThan(0);
    q.dispose();
  });

  it("背压门：bufferedAmount≥4MB→终止", async () => {
    const p = new FakePort();
    const q = mkQueue(p, { bufferedAmountLimit: 100 });
    p.bufferedAmount = 200;
    expect(q.checkBacklog()).toBe(false);
    expect(p.closed.length).toBeGreaterThan(0);
    q.dispose();
  });

  it("drain 批量上限：一批 ≤drainBatch，余量下一轮", async () => {
    const p = new FakePort();
    const q = mkQueue(p, { maxFrames: 100, maxBytes: 65536, drainBatch: 3 });
    for (let i = 0; i < 7; i++) q.enqueue({ t: "error", code: 4404, message: `m${i}`, retryable: false, requestId: "" });
    await new Promise((r) => setImmediate(r)); // 第一轮 drain
    expect(p.sent.length).toBe(3); // 第一批 3
    await new Promise((r) => setTimeout(r, 5));
    expect(p.sent.length).toBe(7);
    q.dispose();
  });

  it("close(1000) 正常路径：尽力排空", async () => {
    const p = new FakePort();
    const q = mkQueue(p, { maxFrames: 100, maxBytes: 65536 });
    for (let i = 0; i < 3; i++) q.enqueue({ t: "error", code: 4404, message: `m${i}`, retryable: false, requestId: "" });
    q.close(1000, "bye");
    expect(p.sent).toHaveLength(3);
    expect(p.closed[0]).toEqual([1000, "bye"]);
    q.dispose();
  });
});

// ---------- compute-semaphore ----------
describe("compute-semaphore（B11/B12）", () => {
  it("并发 2+FIFO；release 后推进", async () => {
    const sem = new ComputeSemaphore(2, 60_000);
    const a = sem.acquire();
    const b = sem.acquire();
    const c = sem.acquire();
    const ar = await a.promise;
    const br = await b.promise;
    expect(ar.ok).toBe(true);
    expect(br.ok).toBe(true);
    expect(sem.inFlight).toBe(2);
    let cDone = false;
    void c.promise.then(() => {
      cDone = true;
    });
    await microtasks(3);
    expect(cDone).toBe(false); // 满载排队
    ar.release();
    const cr = await c.promise;
    expect(cr.ok).toBe(true);
    expect(sem.inFlight).toBe(2);
    br.release();
    cr.release();
    expect(sem.inFlight).toBe(0);
  });

  it("排队 5s 超时→timeout；取消→canceled", async () => {
    const sem = new ComputeSemaphore(1, 20, { setTimeout: (cb) => setTimeout(cb, 0) as unknown as unknown, clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) });
    const a = sem.acquire();
    const ar = await a.promise;
    const b = sem.acquire();
    const br = await b.promise;
    expect(br.ok).toBe(false);
    expect(br.kind).toBe("timeout");
    const c = sem.acquire();
    c.cancel();
    const cr = await c.promise;
    expect(cr.ok).toBe(false);
    expect(cr.kind).toBe("canceled");
    ar.release();
  });

  it("重复 release 幂等（不多还槽）", async () => {
    const sem = new ComputeSemaphore(1, 60_000);
    const a = sem.acquire();
    const ar = await a.promise;
    ar.release();
    ar.release();
    expect(sem.inFlight).toBe(0);
    const b = sem.acquire();
    const br = await b.promise;
    expect(br.ok).toBe(true);
    br.release();
  });
});

// ---------- session-scan ----------
describe("session-scan（D21）", () => {
  it("稳定排序：lastActiveMs desc+null 最后+file 次键；total=命中数", async () => {
    const d = await tmp();
    try {
      await writeFile(join(d, "a.jsonl"), JSON.stringify({ type: "session", id: "s-a", timestamp: 100 }) + "\n" + JSON.stringify({ type: "message", timestamp: 300, message: { role: "user", content: "标题A" } }) + "\n");
      await writeFile(join(d, "b.jsonl"), JSON.stringify({ type: "session", id: "s-b", timestamp: 200 }) + "\n");
      await writeFile(join(d, "c.jsonl"), "broken\n"); // 无时间戳→null
      const r = await scanSessions(d);
      expect(r.total).toBe(3);
      expect(r.dirReliability).toBe("full");
      const files = r.sessions.map((s) => s.file);
      expect(files).toEqual(["a.jsonl", "b.jsonl", "c.jsonl"]); // a=300（message 刷新）→b=200→null
      expect(r.sessions[0]!.title.text).toBe("标题A");
      expect(r.sessions[1]!.title.text).toBe("");
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  it("枚举上限 1000→dirReliability=partial+total 未截断数", async () => {
    const d = await tmp();
    try {
      await writeFile(join(d, "one.jsonl"), "{}\n");
      await writeFile(join(d, "two.jsonl"), "{}\n");
      const r = await scanSessions(d, { maxFiles: 1 });
      expect(r.dirReliability).toBe("partial");
      expect(r.total).toBe(2);
      expect(r.sessions).toHaveLength(1);
      expect(r.sessions[0]!.listReliability).toBe("full");
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  it("sanitize 先于截断：超长标题截断且已脱敏", async () => {
    const d = await tmp();
    try {
      const long = "很长的标题".repeat(50);
      await writeFile(join(d, "x.jsonl"), JSON.stringify({ type: "session", id: "s", timestamp: 1 }) + "\n" + JSON.stringify({ type: "message", timestamp: 2, message: { role: "user", content: long } }) + "\n");
      const r = await scanSessions(d);
      const t = r.sessions[0]!.title;
      expect(t.truncated).toBe(true);
      expect(t.text.length).toBeLessThanOrEqual(80 + 20); // 截断标记余量
      expect(t.text).toContain("很长的标题");
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  it("坏文件（symlink）→条目占位 partial 不吞文件", async () => {
    const d = await tmp();
    try {
      await writeFile(join(d, "real.jsonl"), "{}\n");
      await symlink(join(d, "real.jsonl"), join(d, "evil.jsonl"));
      const r = await scanSessions(d);
      const evil = r.sessions.find((s) => s.file === "evil.jsonl");
      expect(evil).toBeDefined();
      expect(evil?.listReliability).toBe("partial");
      expect(evil?.sessionId).toBeNull();
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  it("单文件超读取预算→partial", async () => {
    const d = await tmp();
    try {
      await writeFile(join(d, "big.jsonl"), JSON.stringify({ type: "session", id: "s", timestamp: 1 }) + "\n" + "x".repeat(200) + "\n");
      const r = await scanSessions(d, { perFileBudget: 60 });
      expect(r.sessions[0]!.listReliability).toBe("partial");
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });
});

describe("ws-support w1 修复面（W1-03/09/12）", () => {
  it("W1-09 FIFO（命名管道）open 不阻塞：O_NONBLOCK→同 fd fstat 拒 not-regular", async () => {
    const d = await tmp();
    try {
      const fifo = join(d, "p.jsonl");
      execSync(`mkfifo '${fifo}'`);
      const t0 = Date.now();
      await expect(readSafeWithin(fifo, [d], 64)).rejects.toThrow(/非常规|not-regular/);
      expect(Date.now() - t0).toBeLessThan(2000); // 不挂起等写端
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  it("W1-12 ISO 时间戳（真实 pi 会话格式）：lastActiveMs=Date.parse 非 null", async () => {
    const d = await tmp();
    try {
      const iso = "2026-09-27T10:00:00.000Z";
      await writeFile(join(d, "iso.jsonl"),
        JSON.stringify({ type: "session", id: "s", timestamp: iso }) + "\n" +
        JSON.stringify({ type: "message", timestamp: "2026-09-27T11:30:00.000Z", message: { role: "user", content: "hi" } }) + "\n");
      const r = await scanSessions(d);
      expect(r.sessions[0]!.lastActiveMs).toBe(Date.parse("2026-09-27T11:30:00.000Z"));
      expect(r.sessions[0]!.title.text).toBe("hi");
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  it("W1-03 帧数门计入在途：回调未兑现的 send 占位，未完成+排队>上限→拒收", async () => {
    const port: SendPort = {
      readyState: 1, bufferedAmount: 0,
      send: (_d: string, cb?: (err?: Error | null) => void): boolean => { heldCbs.push(cb ?? (() => {})); return false; },
      close: () => {}, terminate: () => {},
    };
    const heldCbs: Array<(err?: Error | null) => void> = [];
    const q = new ConnectionQueue({ port, maxFrames: 3, maxBytes: 1_000_000 });
    const first = q.enqueue({ t: "pong", nonce: "1" } as never);
    if (first !== "queued") throw new Error(`first=${first}`);
    await new Promise((res) => setImmediate(res)); // drain 交 send（回调挂起→inflight=1）
    expect(q.enqueue({ t: "pong", nonce: "2" } as never)).toBe("queued");
    await new Promise((res) => setImmediate(res));
    expect(q.enqueue({ t: "pong", nonce: "3" } as never)).toBe("queued");
    await new Promise((res) => setImmediate(res));
    // inflight=3（回调全挂起）+第 4 帧→拒收（旧实现只看 q.length=0→会放行）；溢出→终止连接
    expect(q.enqueue({ t: "pong", nonce: "4" } as never)).toBe("rejected-overflow");
    await new Promise((res) => setImmediate(res));
    expect(q.enqueue({ t: "pong", nonce: "5" } as never)).toBe("rejected-overflow"); // 终止态拒收
    q.dispose();
    // 槽归还在非溢出流验证：回调兑现后 inflight 归零，后续帧重新可入
    const held2: Array<(err?: Error | null) => void> = [];
    const port2: SendPort = {
      readyState: 1, bufferedAmount: 0,
      send: (_d: string, cb?: (err?: Error | null) => void): boolean => { held2.push(cb ?? (() => {})); return false; },
      close: () => {}, terminate: () => {},
    };
    const q2 = new ConnectionQueue({ port: port2, maxFrames: 3, maxBytes: 1_000_000 });
    for (const n of ["1", "2", "3"]) expect(q2.enqueue({ t: "pong", nonce: n } as never)).toBe("queued");
    await new Promise((res) => setImmediate(res));
    expect(held2.length).toBe(3);
    for (const cb of held2.splice(0)) cb(null); // 兑现→inflight 归零+字节释放
    await new Promise((res) => setImmediate(res));
    for (const n of ["4", "5", "6"]) expect(q2.enqueue({ t: "pong", nonce: n } as never)).toBe("queued"); // 若归还缺失→第 4 帧即拒
    q2.dispose();
  });
});

describe("gatewayMetaFrom（3b-2 clientIp 接线）", () => {
  it("直连元数据全链映射（origin/loopback/tls/clientIp）", () => {
    const m = gatewayMetaFrom({ origin: "http://localhost:5173", loopback: true, tls: false, clientIp: "::1", remoteAddress: "::1", proxied: false });
    expect(m).toEqual({ origin: "http://localhost:5173", loopback: true, tls: false, clientIp: "::1" });
  });
  it("可信代理派生的 clientIp 原样透传（不退 unknown）", () => {
    const m = gatewayMetaFrom({ origin: "https://app.example", loopback: false, tls: true, clientIp: "203.0.113.9", remoteAddress: "10.0.0.7", proxied: true });
    expect(m.clientIp).toBe("203.0.113.9");
    expect(m.tls).toBe(true);
    expect(m.loopback).toBe(false);
  });
  it("origin 缺失（非浏览器入口被拒前）→undefined（网关默认拒路径）", () => {
    const m = gatewayMetaFrom({ origin: null, loopback: true, tls: false, clientIp: "127.0.0.1", remoteAddress: "127.0.0.1", proxied: false });
    expect(m.origin).toBeUndefined();
  });
});
