// 事件泵行缓冲测试（分块/半行/空行/CRLF/多字节跨块/flush 残余）
import { describe, expect, it } from "vitest";
import { LinePump } from "../../../apps/server/src/host/line-pump.js";

describe("LinePump（stdout 常驻排空行缓冲）", () => {
  it("整块多行：逐行回调，空行跳过", () => {
    const lines: string[] = [];
    const p = new LinePump((l) => lines.push(l));
    p.feed(Buffer.from('{"type":"a"}\n\n{"type":"b"}\n', "utf8"));
    expect(lines).toEqual(['{"type":"a"}', '{"type":"b"}']);
  });

  it("半行分块：跨块拼回完整行（排空即回调，不等块边界）", () => {
    const lines: string[] = [];
    const p = new LinePump((l) => lines.push(l));
    p.feed(Buffer.from('{"type":"ev', "utf8"));
    expect(lines).toEqual([]); // 半行不回调
    p.feed(Buffer.from('ent","x":1}\n{"type":"ne', "utf8"));
    expect(lines).toEqual(['{"type":"event","x":1}']); // 第一行完整即回调
    p.feed(Buffer.from('xt"}\n', "utf8"));
    expect(lines).toEqual(['{"type":"event","x":1}', '{"type":"next"}']);
  });

  it("CRLF：\\r 保留在行尾由解析层容忍（泵职责=按 \\n 拆；跨平台写手）", () => {
    const lines: string[] = [];
    const p = new LinePump((l) => lines.push(l));
    p.feed(Buffer.from('{"a":1}\r\n{"b":2}\r\n', "utf8"));
    expect(lines).toEqual(['{"a":1}\r', '{"b":2}\r']);
    // 注：\r 保留在行尾由解析层容忍（JSON.parse 容忍尾随 \r）；泵职责=按 \n 拆
    expect(JSON.parse(lines[0]!)).toEqual({ a: 1 });
  });

  it("多字节跨块（送审前自审修复的回归）：中文字符横跨 chunk 边界不撕裂", () => {
    const lines: string[] = [];
    const p = new LinePump((l) => lines.push(l));
    // 整行 {"title":"会话管理标题"}；按字节在「会」(E4 BC 9A) 首字节后切开
    const whole = Buffer.from('{"title":"会话管理标题"}\n', "utf8");
    const cut = whole.indexOf(Buffer.from("会", "utf8")) + 1; // 落在 3 字节序列中间
    p.feed(whole.subarray(0, cut));
    expect(lines).toEqual([]); // 半行（含不完整多字节尾）不回调
    p.feed(whole.subarray(cut));
    expect(lines).toEqual(['{"title":"会话管理标题"}']); // 无 U+FFFD
    expect(JSON.parse(lines[0]!)).toEqual({ title: "会话管理标题" });
  });

  it("多字节跨块：4 字节 emoji 横跨边界（代理对不劈半）", () => {
    const lines: string[] = [];
    const p = new LinePump((l) => lines.push(l));
    const whole = Buffer.from('{"e":"😀🎉"}\n', "utf8");
    const cut = whole.indexOf(Buffer.from("😀", "utf8")) + 2; // emoji 第 2 字节后切
    p.feed(whole.subarray(0, cut));
    p.feed(whole.subarray(cut));
    expect(lines).toEqual(['{"e":"😀🎉"}']);
  });

  it("多字节撕裂尾：末尾不完整字节序列 flush 交解析层判坏行（如实呈现不静默丢）", () => {
    const lines: string[] = [];
    const p = new LinePump((l) => lines.push(l));
    p.feed(Buffer.from('{"ok":1}\n{"torn":"会', "utf8").subarray(0, -1)); // 採掉「会」末字节（真撕裂：E4 BC 残缺）
    p.flush();
    expect(lines).toEqual(['{"ok":1}', '{"torn":"\uFFFD']); // 残缺序列（E4 BC）整体置换为一个替换符（WHATWG 口径）——坏行交上层跳过
  });

  it("flush 残余：流结束交付最后无换行行（撕裂尾）", () => {
    const lines: string[] = [];
    const p = new LinePump((l) => lines.push(l));
    p.feed(Buffer.from('{"complete":1}\n{"torn":"half', "utf8"));
    expect(lines).toEqual(['{"complete":1}']);
    p.flush();
    expect(lines).toEqual(['{"complete":1}', '{"torn":"half']);
  });

  it("reset 清缓冲（复用）", () => {
    const lines: string[] = [];
    const p = new LinePump((l) => lines.push(l));
    p.feed(Buffer.from("partial-no-newline", "utf8"));
    p.reset();
    p.feed(Buffer.from("next\n", "utf8"));
    expect(lines).toEqual(["next"]); // 旧半行已弃
  });
});
