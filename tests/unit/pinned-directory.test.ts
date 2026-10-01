import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, link, rename, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PinnedDirectory } from "../../apps/server/src/http/pinned-directory.ts";
const key = "a".repeat(32) + ".blob";
async function fixture(run: (root: string) => Promise<void>): Promise<void> { const root = await mkdtemp(join(tmpdir(), "composer-dir-")); try { await run(root); } finally { await rm(root, {recursive:true,force:true}); } }
describe("pinned attachment dirfd containment", () => {
  it("roundtrips exclusive durable data from the same pinned directory", async () => fixture(async (root) => {
    const dir = await PinnedDirectory.open(join(root,"store")); try { await dir.writeExclusive(key,Buffer.from("hello")); expect((await dir.read(key,16)).toString()).toBe("hello"); await expect(dir.writeExclusive(key,Buffer.from("replace"))).rejects.toThrow(); await dir.remove(key); await expect(dir.read(key,16)).rejects.toThrow(); } finally { await dir.close(); }
  }));
  it("rejects symlink final directory and ancestor component", async () => fixture(async (root) => {
    await mkdir(join(root,"real"),{mode:0o700}); await symlink(join(root,"real"),join(root,"alias"));
    await expect(PinnedDirectory.open(join(root,"alias"))).rejects.toThrow(); await expect(PinnedDirectory.open(join(root,"alias","child"))).rejects.toThrow();
  }));
  it("rejects insecure directory permissions without silently chmodding", async () => fixture(async (root) => {
    await mkdir(join(root,"open")); await chmod(join(root,"open"),0o755); await expect(PinnedDirectory.open(join(root,"open"))).rejects.toThrow();
  }));
  it("stays at the pinned inode after parent rename and adversarial path replacement", async () => fixture(async (root) => {
    await mkdir(join(root,"parent")); const dir = await PinnedDirectory.open(join(root,"parent","store"));
    try { await dir.writeExclusive(key,Buffer.from("original")); await rename(join(root,"parent"),join(root,"moved")); await mkdir(join(root,"evil"),{mode:0o700}); await writeFile(join(root,"evil",key),"evil",{mode:0o600}); await symlink(join(root,"evil"),join(root,"parent")); expect((await dir.read(key,16)).toString()).toBe("original"); } finally { await dir.close(); }
  }));
  it("rejects symlink, hardlinked and over-budget leaf files", async () => fixture(async (root) => {
    const store = join(root,"store"); const dir = await PinnedDirectory.open(store);
    try { const outside=join(root,"outside"); await writeFile(outside,"outside",{mode:0o600}); await symlink(outside,join(store,key)); await expect(dir.read(key,20)).rejects.toThrow(); await dir.remove(key); await link(outside,join(store,key)); await expect(dir.read(key,20)).rejects.toThrow(); await dir.remove(key); await dir.writeExclusive(key,Buffer.from("oversized")); await expect(dir.read(key,2)).rejects.toThrow(); } finally { await dir.close(); }
  }));
  it("never exposes directory paths through errors", async () => fixture(async (root) => {
    const dir = await PinnedDirectory.open(join(root,"store")); try { await expect(dir.read(key,20)).rejects.not.toThrow(root); for (const name of ["../x", "a.json", "/abs", "a".repeat(32)+".json/child"]) await expect(dir.read(name,20)).rejects.toThrow(/存储不可用/); } finally { await dir.close(); }
  }));
  it("closing rejects new operations and waits for the acquired operation lease", async () => fixture(async (root) => {
    const dir = await PinnedDirectory.open(join(root,"store")); const write = dir.writeExclusive(key,Buffer.from("hello")); const outcome=write.then(()=>"written",()=>"closed-safely"); await dir.close(); expect(await outcome).toBe("written"); await expect(dir.names()).rejects.toThrow(); await dir.close();
  }));
});
