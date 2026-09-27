// fix12（B12-3③）：readBounded 内层单测——分次 read 循环/EOF 止/读中硬限/read 异常归类。
// 接缝=BoundedReadHandle 结构化接口（脚本化句柄注入；FileHandle 结构兼容），64KB 窗真实路径。
import { describe, expect, it } from "vitest";
import { readBounded, type BoundedReadHandle } from "../../../apps/server/src/ws/safe-open.ts";
import { SafeOpenError } from "../../../apps/server/src/ws/safe-open.ts";

/** 脚本化句柄：按 16B 一段吐 data；记录 read 调用参数；可选注入异常。 */
function scripted(data: Buffer, opts: { failOn?: number } = {}): {
  fh: BoundedReadHandle; reads: () => Array<{ offset: number; length: number; position: number | null }>;
} {
  const calls: Array<{ offset: number; length: number; position: number | null }> = [];
  let i = 0;
  const fh: BoundedReadHandle = {
    read: async (buffer, offset, length, position) => {
      calls.push({ offset, length, position });
      if (opts.failOn !== undefined && calls.length === opts.failOn) throw new Error("EIO 模拟");
      const chunk = data.subarray(i * 16, i * 16 + 16);
      i++;
      chunk.copy(buffer, offset);
      return { bytesRead: chunk.byteLength };
    },
  };
  return { fh, reads: () => calls };
}

describe("safe-open readBounded（fix12 内层接缝单测）", () => {
  it("S1 分次循环到 EOF：40B 数据 16B×2+8B 三段读回；position 恒 null（顺序读交由 fd 偏移）", async () => {
    const data = Buffer.alloc(40, 0xab);
    const { fh, reads } = scripted(data);
    const out = await readBounded(fh, 1000, "s1.jsonl");
    expect(out.byteLength).toBe(40);
    expect(out.equals(data)).toBe(true);
    expect(reads().length).toBe(4); // 16+16+8+EOF(0)
    expect(reads().every((c) => c.position === null && c.offset === 0 && c.length === 64 * 1024)).toBe(true);
  });

  it("S2 读中硬限：maxBytes=32 下第三段累计 48>32 → too-large（不等读完）", async () => {
    const data = Buffer.alloc(48, 1);
    const { fh, reads } = scripted(data);
    await expect(readBounded(fh, 32, "s2.jsonl")).rejects.toMatchObject({ kind: "too-large" });
    expect(reads().length).toBe(3); // 16+16+16=48 即抛（第 4 次 EOF 不发）
  });

  it("S3 恰等于上限不抛（<=maxBytes 合法）：48B maxBytes=48 → 全量回", async () => {
    const data = Buffer.alloc(48, 2);
    const { fh } = scripted(data);
    const out = await readBounded(fh, 48, "s3.jsonl");
    expect(out.byteLength).toBe(48);
  });

  it("S4 read 异常归类 read-failed：第 2 次注入 EIO → SafeOpenError{kind:read-failed}（detail 携原因）", async () => {
    const data = Buffer.alloc(64, 3);
    const { fh } = scripted(data, { failOn: 2 });
    const err = await readBounded(fh, 1000, "s4.jsonl").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SafeOpenError);
    expect((err as SafeOpenError).kind).toBe("read-failed");
    expect((err as SafeOpenError).message).toContain("EIO"); // 原因归入 message（detail 非公开契约字段）
  });

  it("S5 空文件：首次 read 即 EOF(0) → 空 Buffer 零段", async () => {
    const { fh, reads } = scripted(Buffer.alloc(0));
    const out = await readBounded(fh, 10, "s5.jsonl");
    expect(out.byteLength).toBe(0);
    expect(reads().length).toBe(1); // 一次 EOF 探测
  });
});
