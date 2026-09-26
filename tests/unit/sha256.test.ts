import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { sha256Hex, sha256Hex12, sha256HexBytes } from "@pi-agent-ui/protocol";

/** 3b2c-Y3（GPT fix1）：SHA-256 固定 golden 入仓（不再只留 /tmp 对拍脚本）。
 *  覆盖：边界长度块扩展（55/56/63/64/119/120——单块填充边界与双块）、多字节 UTF-8、
 *  空串、64KiB 长输入；与 node:crypto 逐向量对拍（测试进程可用 node:crypto，浏览器面
 *  不受影响——被测实现自身零 node 依赖）。 */

describe("sha256 golden + node:crypto 对拍", () => {
  it("固定 golden（NIST 向量）", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
    expect(sha256Hex12("hello world")).toBe("b94d27b9934d"); // 前 12 hex（附件身份 canon 长度）
  });

  it("边界长度对拍（0..72 全长 + 119/120/1000）", () => {
    for (const len of [...Array.from({ length: 73 }, (_, i) => i), 119, 120, 1000]) {
      const input = "a".repeat(len);
      expect(sha256Hex(input), `len=${len}`).toBe(createHash("sha256").update(input, "utf8").digest("hex"));
    }
  });

  it("多字节 UTF-8 与 emoji/中文", () => {
    for (const s of ["中文🚀", "héllo wörld", "\u{1F600}\u{1F680}"]) {
      expect(sha256Hex(s)).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
    }
  });

  it("64KiB 长输入（块循环路径）", () => {
    const big = "x".repeat(65536) + "y".repeat(1234);
    expect(sha256Hex(big)).toBe(createHash("sha256").update(big, "utf8").digest("hex"));
  });
});

describe("sha256HexBytes 3b-3⑤：字节入口对拍 node:crypto", () => {
  it("空/随机字节/撕裂多字节尾/64KiB 全对齐（指纹=整文件字节含撕裂尾）", async () => {
    const { createHash } = await import("node:crypto");
    const ref = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
    const rnd = (n: number, seed: number): Uint8Array => {
      const out = new Uint8Array(n);
      let x = seed;
      for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; out[i] = x >>> 24; }
      return out;
    };
    const cases: Uint8Array[] = [
      new Uint8Array(0),
      rnd(1, 7),
      rnd(55, 11), // 边界块长 55（+9=64 恰一整块）
      rnd(56, 13), // 跨块边界
      rnd(119, 17),
      rnd(120, 19),
      rnd(1000, 23),
      Buffer.concat([Buffer.from("line1\n", "utf8"), Buffer.from([0xe4, 0xb8])]), // 撕裂多字节尾
      rnd(64 * 1024, 29),
    ];
    for (const c of cases) expect(sha256HexBytes(c)).toBe(ref(c));
    // 字节入口与字符串入口一致性（UTF-8 编码同源）
    expect(sha256HexBytes(new TextEncoder().encode("hello world"))).toBe(sha256Hex("hello world"));
  });
});
