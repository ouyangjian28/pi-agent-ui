// ②WS/UI 契约准备包：入站帧校验（contracts.ts validateClientFrame 判别优先级+错误码）。
import { describe, expect, it } from "vitest";
import { estimateFrameBytes, validateClientFrame } from "@pi-agent-ui/protocol";

describe("入站帧校验", () => {
  it("hello 合法（最小）", () => {
    expect(validateClientFrame({ t: "hello", protocolVersion: 1, token: "T" })).toEqual({ ok: true, frame: { t: "hello", protocolVersion: 1, token: "T" } });
  });
  it("hello 版本不支持（合法整数）→4403", () => {
    expect(validateClientFrame({ t: "hello", protocolVersion: 2, token: "T" })).toMatchObject({ ok: false, code: 4403 });
  });
  it("hello protocolVersion 非整数→4404（格式层先于版本层）", () => {
    expect(validateClientFrame({ t: "hello", protocolVersion: "1", token: "T" })).toMatchObject({ ok: false, code: 4404 });
  });
  it("hello 缺 token→4404；token 空串→4404", () => {
    expect(validateClientFrame({ t: "hello", protocolVersion: 1 })).toMatchObject({ ok: false, code: 4404 });
    expect(validateClientFrame({ t: "hello", protocolVersion: 1, token: "" })).toMatchObject({ ok: false, code: 4404 });
  });
  it("hello 多余字段→4404", () => {
    expect(validateClientFrame({ t: "hello", protocolVersion: 1, token: "T", extra: 1 })).toMatchObject({ ok: false, code: 4404 });
  });
  it("写类帧（prompt）→4405（鉴权前禁写；不论其余字段）", () => {
    expect(validateClientFrame({ t: "prompt", text: "hi" })).toMatchObject({ ok: false, code: 4405 });
    expect(validateClientFrame({ t: "spawn" })).toMatchObject({ ok: false, code: 4405 });
  });
  it("未知 t→4404（不回显超长）", () => {
    expect(validateClientFrame({ t: "wat", requestId: "r-1" })).toMatchObject({ ok: false, code: 4404 });
    const r = validateClientFrame({ t: "w".repeat(40) });
    expect(r).toMatchObject({ ok: false, code: 4404 });
    if (!r.ok) expect(r.message).not.toContain("w".repeat(40));
  });
  it("非对象/缺 t→4404", () => {
    expect(validateClientFrame("hello")).toMatchObject({ ok: false, code: 4404 });
    expect(validateClientFrame([1, 2])).toMatchObject({ ok: false, code: 4404 });
    expect(validateClientFrame({})).toMatchObject({ ok: false, code: 4404 });
    expect(validateClientFrame({ t: 123 })).toMatchObject({ ok: false, code: 4404 });
  });
  it("list-sessions 合法（最小+分页）", () => {
    expect(validateClientFrame({ t: "list-sessions", requestId: "r-1" })).toEqual({ ok: true, frame: { t: "list-sessions", requestId: "r-1" } });
    expect(validateClientFrame({ t: "list-sessions", requestId: "r-1", offset: 10, limit: 20 })).toEqual({ ok: true, frame: { t: "list-sessions", requestId: "r-1", offset: 10, limit: 20 } });
  });
  it("list-sessions limit 超上限→4404；offset 负→4404", () => {
    expect(validateClientFrame({ t: "list-sessions", requestId: "r-1", limit: 201 })).toMatchObject({ ok: false, code: 4404 });
    expect(validateClientFrame({ t: "list-sessions", requestId: "r-1", offset: -1 })).toMatchObject({ ok: false, code: 4404 });
  });
  it("subscribe init 合法", () => {
    expect(validateClientFrame({ t: "subscribe", requestId: "r-1", file: "s.jsonl" })).toEqual({ ok: true, frame: { t: "subscribe", requestId: "r-1", file: "s.jsonl" } });
  });
  it("subscribe resync（cursor）合法", () => {
    expect(validateClientFrame({ t: "subscribe", requestId: "r-1", file: "s.jsonl", cursor: { streamId: "s-1", seq: 12 } }))
      .toEqual({ ok: true, frame: { t: "subscribe", requestId: "r-1", file: "s.jsonl", cursor: { streamId: "s-1", seq: 12 } } });
  });
  it("subscribe page（snapshotId+historyNext）合法", () => {
    expect(validateClientFrame({ t: "subscribe", requestId: "r-1", file: "s.jsonl", snapshotId: "k-1", historyNext: { streamId: "s-1", seq: 201 } }))
      .toEqual({ ok: true, frame: { t: "subscribe", requestId: "r-1", file: "s.jsonl", snapshotId: "k-1", historyNext: { streamId: "s-1", seq: 201 } } });
  });
  it("subscribe 分支互斥：cursor+snapshotId→4404；snapshotId 无 historyNext→4404", () => {
    expect(validateClientFrame({ t: "subscribe", requestId: "r-1", file: "s.jsonl", cursor: { streamId: "s-1", seq: 1 }, snapshotId: "k", historyNext: { streamId: "s-1", seq: 2 } })).toMatchObject({ ok: false, code: 4404 });
    expect(validateClientFrame({ t: "subscribe", requestId: "r-1", file: "s.jsonl", snapshotId: "k" })).toMatchObject({ ok: false, code: 4404 });
  });
  it("subscribe 非法 file→4404（路径穿越/坏字符）", () => {
    expect(validateClientFrame({ t: "subscribe", requestId: "r-1", file: "../etc/passwd" })).toMatchObject({ ok: false, code: 4404 });
    expect(validateClientFrame({ t: "subscribe", requestId: "r-1", file: "s.txt" })).toMatchObject({ ok: false, code: 4404 });
    expect(validateClientFrame({ t: "subscribe", requestId: "r-1", file: "a".repeat(120) + ".jsonl" })).toMatchObject({ ok: false, code: 4404 });
  });
  it("cursor seq 非法→4404（负数/非整数/缺字段）", () => {
    expect(validateClientFrame({ t: "subscribe", requestId: "r-1", file: "s.jsonl", cursor: { streamId: "s-1", seq: -1 } })).toMatchObject({ ok: false, code: 4404 });
    expect(validateClientFrame({ t: "subscribe", requestId: "r-1", file: "s.jsonl", cursor: { streamId: "s-1" } })).toMatchObject({ ok: false, code: 4404 });
  });
  it("unsubscribe 合法", () => {
    expect(validateClientFrame({ t: "unsubscribe", requestId: "r-1", subscriptionId: "sub-1" })).toEqual({ ok: true, frame: { t: "unsubscribe", requestId: "r-1", subscriptionId: "sub-1" } });
  });
  it("get-recovery 合法；evidenceHash 非法→4404", () => {
    expect(validateClientFrame({ t: "get-recovery", requestId: "r-1", file: "s.jsonl" })).toEqual({ ok: true, frame: { t: "get-recovery", requestId: "r-1", file: "s.jsonl" } });
    expect(validateClientFrame({ t: "get-recovery", requestId: "r-1", file: "s.jsonl", evidenceHash: "xyz" })).toMatchObject({ ok: false, code: 4404 });
    expect(validateClientFrame({ t: "get-recovery", requestId: "r-1", file: "s.jsonl", evidenceHash: "a".repeat(64), offset: 3 })).toEqual({ ok: true, frame: { t: "get-recovery", requestId: "r-1", file: "s.jsonl", evidenceHash: "a".repeat(64), offset: 3 } });
  });
  it("ping 合法（nonce；无 requestId）", () => {
    expect(validateClientFrame({ t: "ping", nonce: "n-1" })).toEqual({ ok: true, frame: { t: "ping", nonce: "n-1" } });
    expect(validateClientFrame({ t: "ping" })).toMatchObject({ ok: false, code: 4404 });
  });
  it("requestId 非法→4404（缺失/超长/坏字符）", () => {
    expect(validateClientFrame({ t: "list-sessions" })).toMatchObject({ ok: false, code: 4404 });
    expect(validateClientFrame({ t: "list-sessions", requestId: "r".repeat(65) })).toMatchObject({ ok: false, code: 4404 });
    expect(validateClientFrame({ t: "list-sessions", requestId: "r 1" })).toMatchObject({ ok: false, code: 4404 });
  });

  it("estimateFrameBytes：ASCII/中文/代理对 UTF-8 字节", () => {
    const empty = estimateFrameBytes({ t: "events", subscriptionId: "s", origin: "history", refSeq: 0, events: [] });
    const cn = estimateFrameBytes({ t: "events", subscriptionId: "s", origin: "history", refSeq: 0, events: [] as never[] });
    expect(cn - empty).toBe(0);
    const a = JSON.stringify({ v: "ab" }).length, b = JSON.stringify({ v: "中文" }).length;
    expect(estimateFrameBytes({ t: "pong", nonce: "n" } as never) + (b - a)).toBeGreaterThan(0);
    // 精确字节：手算帮手已内联（中文 3B/字、代理对 4B）——对拍两个串差值
    const s1 = JSON.stringify({ v: "ab" }), s2 = JSON.stringify({ v: "中文" }), s3 = JSON.stringify({ v: "😀" });
    expect(estimateFrameBytes({ t: "pong", nonce: s2 } as never) - estimateFrameBytes({ t: "pong", nonce: s1 } as never))
      .toBe(BufferBytes(s2) - BufferBytes(s1));
    expect(estimateFrameBytes({ t: "pong", nonce: s3 } as never) - estimateFrameBytes({ t: "pong", nonce: s1 } as never))
      .toBe(BufferBytes(s3) - BufferBytes(s1));
  });
});

function BufferBytes(s: string): number {
  return new TextEncoder().encode(s).length;
}
