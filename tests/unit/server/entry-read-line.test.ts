// D4 批①（服务端读面·readLineAt）：docs/d4-fulltext-design.md v5.1 §4.3 三判据。
// fake BoundedReadHandle=Buffer 定点读（同 safe-open 接缝——FileHandle 结构兼容）。
// 覆盖：判据①（offset===0/前字节 0x0A/bad-start）；判据②（行界：ok 行/撕裂尾 torn/窗满 oversized）；
// 判据③（fatal 解码 invalid-utf8）；raw 契约=不含 \n。
import { describe, expect, it } from "vitest";
import { readLineAt, type BoundedReadHandle } from "../../../apps/server/src/ws/safe-open.ts";

/** Buffer 脚本化句柄：read(buffer,offset,length,position)——position|null 按 Node 语义定点读。 */
function handleOf(content: Buffer): BoundedReadHandle {
  return {
    async read(buffer, _offset, length, position) {
      const pos = position === null ? 0 : position;
      const n = Math.max(0, Math.min(length, content.byteLength - pos));
      if (n > 0) content.copy(buffer, _offset, pos, pos + n);
      return { bytesRead: n };
    },
  };
}

const FILE = "s.jsonl";

describe("D4 §4.3 readLineAt 三判据", () => {
  it("判据①：offset===0 免读；行首（前字节 0x0A）命中；中段残片→bad-start", async () => {
    const fh = handleOf(Buffer.from("line1\nline2\nline3\n"));
    const a = await readLineAt(fh, 0, 1024, FILE);
    expect(a.ok && a.raw).toBe("line1");
    const b = await readLineAt(fh, 6, 1024, FILE); // line2 行首
    expect(b.ok && b.raw).toBe("line2");
    const c = await readLineAt(fh, 8, 1024, FILE); // 'ne2' 中段（前字节 'i'）
    expect(c.ok === false && c.reason).toBe("bad-start");
    const d = await readLineAt(fh, 100, 1024, FILE); // 越界（读不到前字节）→bad-start（非 crash）
    expect(d.ok === false && d.reason).toBe("bad-start");
  });
  it("判据②：ok 行 raw 不含 \\n；撕裂尾（EOF 无 \\n）→torn；窗满无 \\n→oversized", async () => {
    const fh = handleOf(Buffer.from("full-line\nTORN-TAIL"));
    const a = await readLineAt(fh, 0, 1024, FILE);
    expect(a.ok && a.raw === "full-line" && !a.raw.includes("\n")).toBe(true);
    const b = await readLineAt(fh, 10, 1024, FILE); // 末段无 \n
    expect(b.ok === false && b.reason).toBe("torn");
    const c = await readLineAt(fh, 0, 8, FILE); // 窗 9B 无 \n（full-line 9B > 8B 限）
    expect(c.ok === false && c.reason).toBe("oversized");
  });
  it("判据③：fatal 解码纪律——非法 UTF-8 字节→invalid-utf8", async () => {
    const fh = handleOf(Buffer.from([0x61, 0xff, 0xfe, 0x0a]));
    const r = await readLineAt(fh, 0, 1024, FILE);
    expect(r.ok === false && r.reason).toBe("invalid-utf8");
  });
  it("多字节字符行：按字节定位无损还原（中文行 raw 全量）", async () => {
    const line = "中文行内容"; // 每字 3B
    const buf = Buffer.from(`${line}\n`);
    const fh = handleOf(buf);
    const r = await readLineAt(fh, 0, 1024, FILE);
    expect(r.ok && r.raw).toBe(line);
  });
  it("1MiB 行硬读限口径：maxBytes=1_048_576 窗=maxBytes+1", async () => {
    const huge = Buffer.alloc(1_048_576 + 10, 0x61); // >1MiB 无 \n
    const fh = handleOf(Buffer.concat([huge, Buffer.from("\n")]));
    const r = await readLineAt(fh, 0, 1_048_576, FILE);
    expect(r.ok === false && r.reason).toBe("oversized");
  });
});
