// 事件泵行缓冲测试（分块/半行/空行/CRLF/flush 残余）
import { describe, expect, it } from "vitest";
import { LinePump } from "../../../apps/server/src/host/line-pump.js";

describe("LinePump（stdout 常驻排空行缓冲）", () => {
  it("整块多行：逐行回调，空行跳过", () => {
    const lines: string[] = [];
    const p = new LinePump((l) => lines.push(l));
    p.feed('{"type":"a"}\n\n{"type":"b"}\n');
    expect(lines).toEqual(['{"type":"a"}', '{"type":"b"}']);
  });

  it("半行分块：跨块拼回完整行（排空即回调，不等块边界）", () => {
    const lines: string[] = [];
    const p = new LinePump((l) => lines.push(l));
    p.feed('{"type":"ev');
    expect(lines).toEqual([]); // 半行不回调
    p.feed('ent","x":1}\n{"type":"ne');
    expect(lines).toEqual(['{"type":"event","x":1}']); // 第一行完整即回调
    p.feed('xt"}\n');
    expect(lines).toEqual(['{"type":"event","x":1}', '{"type":"next"}']);
  });

  it("CRLF：\\r 尾剥（跨平台写手）", () => {
    const lines: string[] = [];
    const p = new LinePump((l) => lines.push(l));
    p.feed('{"a":1}\r\n{"b":2}\r\n');
    expect(lines).toEqual(['{"a":1}\r', '{"b":2}\r']);
    // 注：\r 保留在行尾由解析层容忍（JSON.parse 容忍尾随 \r）；泵职责=按 \n 拆
    expect(JSON.parse(lines[0]!)).toEqual({ a: 1 });
  });

  it("flush 残余：流结束交付最后无换行行（撕裂尾）", () => {
    const lines: string[] = [];
    const p = new LinePump((l) => lines.push(l));
    p.feed('{"complete":1}\n{"torn":"half');
    expect(lines).toEqual(['{"complete":1}']);
    p.flush();
    expect(lines).toEqual(['{"complete":1}', '{"torn":"half']);
  });

  it("reset 清缓冲（复用）", () => {
    const lines: string[] = [];
    const p = new LinePump((l) => lines.push(l));
    p.feed("partial-no-newline");
    p.reset();
    p.feed("next\n");
    expect(lines).toEqual(["next"]); // 旧半行已弃
  });
});
