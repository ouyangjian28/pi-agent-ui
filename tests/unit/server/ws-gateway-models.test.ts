// M-OPS（v1.4）网关 get-models 面单测：接线回帧/未接线 4405/失败 cause 空表（FakeConn 同 entry 测试形态）。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TokenAuthority } from "../../../apps/server/src/ws/token-auth.ts";
import { WsGateway, type WsGatewayOpts } from "../../../apps/server/src/ws/ws-gateway.js";
import { ModelsListingService } from "../../../apps/server/src/ws/model-listing.js";

class FakeConn {
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  closes: Array<[number | undefined, string | undefined]> = [];
  private msgCb: ((data: string, isBinary: boolean) => void) | null = null;
  send(data: string): void { this.sent.push(data); }
  close(code?: number, reason?: string): void { this.closes.push([code, reason]); this.readyState = 2; }
  terminate(): void { this.readyState = 3; }
  hooks(): GatewayConnHooksLike { return { onMessage: (cb) => { this.msgCb = cb; }, onClose: () => undefined }; }
  async say(obj: unknown): Promise<void> {
    this.msgCb?.(JSON.stringify(obj), false);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  }
  frames(): Array<Record<string, unknown>> { return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>); }
  async drain(n: number, ms = 2000): Promise<void> {
    const t0 = Date.now();
    while (this.sent.length < n) {
      if (Date.now() - t0 > ms) throw new Error("drain 超时");
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

interface GatewayConnHooksLike {
  onMessage: (cb: (data: string, isBinary: boolean) => void) => void;
  onClose: (cb: (code: number) => void) => void;
}

const rigs: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(rigs.splice(0).map((d) => d())); });

async function makeRig(over: Partial<WsGatewayOpts> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ws-gw-models-"));
  const gw = new WsGateway({
    tokens: TokenAuthority.fromTokens(["tok-ok"]),
    roots: [dir],
    scanDir: dir,
    allowedOrigins: ["http://localhost:5173"],
    heartbeat: { pingMs: 0, idleMs: 0 },
    audit: () => undefined,
    ...over,
  });
  const conn = (): FakeConn => {
    const c = new FakeConn();
    gw.attach(c, c.hooks(), { origin: "http://localhost:5173", loopback: true, tls: false });
    return c;
  };
  rigs.push(async () => { gw.dispose(); await rm(dir, { recursive: true, force: true }); });
  return { gw, conn };
}

async function authed(r: { conn: () => FakeConn }): Promise<FakeConn> {
  const c = r.conn();
  await c.say({ t: "hello", protocolVersion: 1, token: "tok-ok" });
  return c;
}

function listingWith(r: { ok: true; models: Array<{ provider: string; id: string }> } | { ok: false; cause: string }): ModelsListingService {
  return new ModelsListingService({ piBin: "pi", now: () => 1, spawnImpl: async () => r });
}

describe("网关 get-models（M-OPS v1.4）", () => {
  it("G-m-1：未接线→4405（协议已含帧但宿主未配 piBin）", async () => {
    const r = await makeRig();
    const c = await authed(r);
    await c.say({ t: "get-models", requestId: "m1" });
    await c.drain(2);
    const err = c.frames().find((f) => f.t === "error");
    expect(err).toMatchObject({ code: 4405, requestId: "m1" });
  });

  it("G-m-2：接线→models-list 回帧（requestId 同程+表条目透传）", async () => {
    const r = await makeRig({ modelsListing: listingWith({ ok: true, models: [{ provider: "anthropic", id: "claude-opus-4-5" }, { provider: "litellm", id: "glm-5.3" }] }) });
    const c = await authed(r);
    await c.say({ t: "get-models", requestId: "m2" });
    await c.drain(2);
    const frame = c.frames().find((f) => f.t === "models-list");
    expect(frame).toBeDefined();
    expect(frame!.requestId).toBe("m2");
    expect(frame!.models).toHaveLength(2);
    expect(frame!.cause).toBeUndefined();
  });

  it("G-m-3：失败→models-list 空表+cause（不 close 不 error 帧）", async () => {
    const r = await makeRig({ modelsListing: listingWith({ ok: false, cause: "pi --list-models 超时（10s）" }) });
    const c = await authed(r);
    await c.say({ t: "get-models", requestId: "m3" });
    await c.drain(2);
    const frame = c.frames().find((f) => f.t === "models-list");
    expect(frame).toMatchObject({ requestId: "m3", cause: "pi --list-models 超时（10s）" });
    expect(frame!.models).toEqual([]);
    expect(c.frames().some((f) => f.t === "error")).toBe(false);
    expect(c.closes).toHaveLength(0);
  });

  it("G-m-4：get-models 计入在途上限（同 tick 第 5 个→4404）", async () => {
    const slow = new ModelsListingService({
      piBin: "pi",
      spawnImpl: () => new Promise(() => undefined) as Promise<ReturnType<typeof Object>> as never,
    });
    const r = await makeRig({ modelsListing: slow });
    const c = await authed(r);
    for (let i = 0; i < 5; i++) c.say({ t: "get-models", requestId: `bulk-${i}` } as never); // 同 tick 连发
    await c.drain(2);
    const err = c.frames().find((f) => f.t === "error");
    expect(err?.code).toBe(4404); // inFlightRequestsPerConn=4
  });
});
