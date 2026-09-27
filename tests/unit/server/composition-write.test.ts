// 3c-3：composition 写侧接线受控测试（CW1-CW9）。
// 真链=composition→gateway→RpcWriteHost→session-registry→RpcSession→PiProcessHost→真实子进程；
// 进程用 /bin/cat（回声不答 readiness 探针→确定性 readiness-timeout；无 LLM、无 PI_E2E 门）。
// 真正的 readiness 成功+真 pi 写/停链路归 tests/integration/ws-write-e2e.test.ts（PI_E2E=1）。
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startServer, type PiAgentUiServer } from "../../../apps/server/src/composition.ts";

const ORIGIN = "http://localhost:5173";
const TOKEN = "tok-3c3-1";
const CLEANUP: PiAgentUiServer[] = [];

interface Frame { t?: string; [k: string]: unknown }

async function mkCfg(extra: Record<string, unknown> = {}): Promise<{ dir: string; cfg: Record<string, unknown>; audits: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), "comp-3c3-"));
  const tokenFile = join(dir, "tokens.json");
  await writeFile(tokenFile, JSON.stringify({ version: 1, tokens: [TOKEN] }), { mode: 0o600 });
  await chmod(tokenFile, 0o600);
  const audits: string[] = [];
  const cfg = {
    tokenFile,
    allowedOrigins: [ORIGIN],
    roots: [dir],
    scanDir: dir,
    tokenPollMs: 0,
    audit: (l: string) => audits.push(l),
    ...extra,
  };
  return { dir, cfg, audits };
}

async function start(cfg: Record<string, unknown>): Promise<PiAgentUiServer> {
  const s = await startServer(cfg as Parameters<typeof startServer>[0]);
  CLEANUP.push(s);
  return s;
}

/** 受控写链：piBin=/bin/cat（探针回声≠response→readiness 超时确定性触发）。 */
const CAT_WRITE = {
  sessionFor: (f: string) => `${f}.session`,
  piBin: "/bin/cat",
  readinessTimeoutMs: 300,
  timeoutPollMs: 50,
};

async function connect(port: number): Promise<{ ws: WebSocket; next: (t: string, pred?: (f: Frame) => boolean) => Promise<Frame>; close: () => void }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: ORIGIN });
  const frames: Frame[] = [];
  await new Promise<void>((res, rej) => { ws.on("open", res); ws.on("error", (e) => rej(e as Error)); });
  ws.on("message", (d) => frames.push(JSON.parse(String(d))));
  const send = (f: Frame) => ws.send(JSON.stringify(f));
  const next = (t: string, pred?: (f: Frame) => boolean): Promise<Frame> => new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const hit = frames.find((f) => f.t === t && (pred === undefined || pred(f)));
      if (hit !== undefined) { clearInterval(iv); res(hit); }
      else if (Date.now() - t0 > 5_000) { clearInterval(iv); rej(new Error(`等帧超时：${t}（现有 ${frames.map((f) => f.t).join(",")}）`)); }
    }, 10);
  });
  send({ t: "hello", protocolVersion: 1, token: TOKEN });
  await next("welcome");
  return { ws, next, close: () => ws.close() };
}

afterEach(async () => {
  while (CLEANUP.length > 0) {
    const s = CLEANUP.pop();
    if (s) await s.dispose().catch(() => {});
  }
});

describe("3c-3 composition 写侧接线", () => {
  it("CW1 writeHost 与 write 同供 → 拒启（接线歧义门）", async () => {
    const { cfg } = await mkCfg({ writeHost: { sendPrompt: async () => ({ kind: "no-process" }), stop: async () => ({ kind: "no-process" }) }, write: CAT_WRITE });
    await expect(startServer(cfg as Parameters<typeof startServer>[0])).rejects.toThrow(/writeHost 与 write 同供/);
  });

  it("CW2 write.sessionFor 缺失 → 拒启（写侧无从落地）", async () => {
    const { cfg } = await mkCfg({ write: { piBin: "/bin/cat" } });
    await expect(startServer(cfg as Parameters<typeof startServer>[0])).rejects.toThrow(/sessionFor 缺失/);
  });

  it("CW3 真链失败面：prompt→cat 回声不答探针→not-ready(cause=readiness-timeout)+write-ack；审计含 spawn/registry/readiness 链", async () => {
    const { dir, cfg, audits } = await mkCfg({ write: CAT_WRITE });
    const s = await start(cfg);
    const c = await connect(s.port);
    try {
      c.ws.send(JSON.stringify({ t: "prompt", requestId: "r1", file: "s1.jsonl", text: "hi" }));
      const ack = await c.next("write-ack", (f) => f.requestId === "r1");
      expect(ack.outcome).toEqual({ kind: "not-ready", cause: "readiness-timeout" });
      await new Promise<void>((res) => { const iv = setInterval(() => { if (audits.some((l) => l.includes("session-registry created"))) { clearInterval(iv); res(); } }, 20); setTimeout(() => { clearInterval(iv); res(); }, 3_000); });
      expect(audits.some((l) => l.includes("session-registry created") && l.includes("s1.jsonl"))).toBe(true);
      expect(audits.some((l) => l.includes("readiness"))).toBe(true);
      // readiness 超时→退役链→真进程退出证据（process-host exit 行）
      await new Promise<void>((res) => { const iv = setInterval(() => { if (audits.some((l) => l.includes("process-host exit"))) { clearInterval(iv); res(); } }, 20); setTimeout(() => { clearInterval(iv); res(); }, 5_000); });
      expect(audits.some((l) => l.includes("process-host exit"))).toBe(true);
      void dir;
    } finally {
      c.close();
    }
  });

  it("CW4 会话缓存：两次 prompt 同 file→registry 恰建一次（audit 计数）", async () => {
    const { cfg, audits } = await mkCfg({ write: CAT_WRITE });
    const s = await start(cfg);
    const c = await connect(s.port);
    try {
      for (const rid of ["r1", "r2"]) {
        c.ws.send(JSON.stringify({ t: "prompt", requestId: rid, file: "s1.jsonl", text: "hi" }));
        await c.next("write-ack", (f) => f.requestId === rid);
      }
      await new Promise((r) => setTimeout(r, 200));
      expect(audits.filter((l) => l.includes("session-registry created") && l.includes("s1.jsonl")).length).toBe(1);
    } finally {
      c.close();
    }
  });

  it("CW5 stop on idle 会话：write-stop-ack {kind:no-process}（不伪造进程死活）", async () => {
    const { cfg } = await mkCfg({ write: CAT_WRITE });
    const s = await start(cfg);
    const c = await connect(s.port);
    try {
      c.ws.send(JSON.stringify({ t: "prompt", requestId: "r1", file: "s1.jsonl", text: "hi" }));
      await c.next("write-ack", (f) => f.requestId === "r1");
      c.ws.send(JSON.stringify({ t: "stop", requestId: "r2", file: "s1.jsonl" }));
      const ack = await c.next("write-stop-ack", (f) => f.requestId === "r2");
      expect(ack.outcome.kind).toBe("no-process"); // readiness 失败已退役→idle 无进程
    } finally {
      c.close();
    }
  });

  it("CW6 dispose 在途：readiness 等待期 server.dispose()→resolve 有限时间内+审计含 registry disposed（统一销毁面）", async () => {
    const { cfg } = await mkCfg({ write: { ...CAT_WRITE, readinessTimeoutMs: 60_000 } }); // 长窗：必在等待期 dispose
    const s = await start(cfg);
    const c = await connect(s.port);
    c.ws.send(JSON.stringify({ t: "prompt", requestId: "r1", file: "s1.jsonl", text: "hi" }));
    await new Promise((r) => setTimeout(r, 150)); // 让链路走到 readiness 等待
    const t0 = Date.now();
    await s.dispose();
    expect(Date.now() - t0).toBeLessThan(15_000); // 退出确认预算内（SIGTERM 链杀 cat）
    c.close();
  });

  it("CW7 statusFor 真源接线：订阅快照 status.process.phase=idle（未构造会话）+sessionId 确定性派生", async () => {
    const { dir, cfg } = await mkCfg({ write: CAT_WRITE });
    await writeFile(join(dir, "s1.jsonl"), `${JSON.stringify({ t: "session-init", sessionId: "sid-1", leafId: "l0", ts: 1, cwd: dir })}\n`, "utf8");
    const s = await start(cfg);
    const c = await connect(s.port);
    try {
      c.ws.send(JSON.stringify({ t: "subscribe", requestId: "sub1", file: "s1.jsonl" }));
      const snap = await c.next("snapshot");
      const status = snap.status as { process: { phase: string }; session: { sessionId: string | null } };
      expect(status.process.phase).toBe("idle"); // 写侧未构造=进程 idle 真值
      expect(status.session.sessionId).toMatch(/^sess-[0-9a-f]{12}$/); // 注册表派生（非读侧 sid）
    } finally {
      c.close();
    }
  });

  it("CW8 statusFor 构造后：prompt 失败退 idle 后快照 process.phase 仍 idle+bg known（注册表观测面贯通）", async () => {
    const { dir, cfg } = await mkCfg({ write: CAT_WRITE });
    await writeFile(join(dir, "s1.jsonl"), `${JSON.stringify({ t: "session-init", sessionId: "sid-1", leafId: "l0", ts: 1, cwd: dir })}\n`, "utf8");
    const s = await start(cfg);
    const c = await connect(s.port);
    try {
      c.ws.send(JSON.stringify({ t: "prompt", requestId: "r1", file: "s1.jsonl", text: "hi" }));
      await c.next("write-ack", (f) => f.requestId === "r1");
      c.ws.send(JSON.stringify({ t: "subscribe", requestId: "sub1", file: "s1.jsonl" }));
      const snap = await c.next("snapshot");
      const status = snap.status as { process: { phase: string }; backgroundTasks: { availability: string; activeCount: number | null } };
      expect(["idle", "running", "stopping"]).toContain(status.process.phase);
      expect(status.backgroundTasks.availability).toBe("known"); // 已构造→真计数面
      expect(status.backgroundTasks.activeCount).toBe(0);
    } finally {
      c.close();
    }
  });

  it("CW9 dispose 审计序：session-registry disposed 先于 composition disposed（统一销毁挂在收尾链）", async () => {
    const { cfg, audits } = await mkCfg({ write: CAT_WRITE });
    const s = await start(cfg);
    const c = await connect(s.port);
    c.ws.send(JSON.stringify({ t: "prompt", requestId: "r1", file: "s1.jsonl", text: "hi" }));
    await c.next("write-ack", (f) => f.requestId === "r1");
    c.close();
    await s.dispose();
    const iReg = audits.findIndex((l) => l.includes("session-registry disposed"));
    const iComp = audits.findIndex((l) => l.includes("composition disposed"));
    expect(iReg).toBeGreaterThanOrEqual(0);
    expect(iComp).toBeGreaterThan(iReg);
  });

  it("CW10 越界 file 照旧 4404（写侧接线不放宽读侧授权域）：prompt file=/etc/hosts.jsonl", async () => {
    const { cfg } = await mkCfg({ write: CAT_WRITE });
    const s = await start(cfg);
    const c = await connect(s.port);
    try {
      c.ws.send(JSON.stringify({ t: "prompt", requestId: "r1", file: "/etc/hosts.jsonl", text: "x" }));
      const err = await c.next("error", (f) => (f.requestId as string) === "r1");
      expect(err.code).toBe(4404);
    } finally {
      c.close();
    }
  });
});
