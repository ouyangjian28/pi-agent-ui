import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AttachmentStore } from "../../../apps/server/src/http/attachment-store.ts";

const owner = "a".repeat(64);
async function withStore(work: (store: AttachmentStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "attachment-pin-race-"));
  const store = await AttachmentStore.open(dir);
  try { await work(store); }
  finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
}

describe("附件提交与删除不能交错", () => {
  it("先固定再删除：提交的字节必须耐久存在", async () => withStore(async (store) => {
    const item = await store.upload(owner, "code.ts", Buffer.from("const value = 1;"));
    const results = await Promise.allSettled([store.pin(owner, [item.id, item.id]), store.remove(owner, item.id)]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    const restored = await store.resolve(owner, [item.id, item.id]);
    expect(restored).toHaveLength(2);
    expect(restored[0]!.bytes).toEqual(Buffer.from("const value = 1;"));
  }));
  it("先删除再固定：拒绝提交而非生成一个丢字节的引用", async () => withStore(async (store) => {
    const item = await store.upload(owner, "code.ts", Buffer.from("const value = 1;"));
    const results = await Promise.allSettled([store.remove(owner, item.id), store.pin(owner, [item.id])]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    await expect(store.resolve(owner, [item.id])).rejects.toThrow();
  }));
});
