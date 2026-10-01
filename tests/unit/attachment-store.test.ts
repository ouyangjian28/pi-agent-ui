import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, readdir, symlink, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AttachmentStore } from "../../apps/server/src/http/attachment-store.ts";
const owner="a".repeat(64), other="b".repeat(64);
const require=createRequire(new URL("../../apps/server/package.json",import.meta.url));
function imageBytes(): Uint8Array {
  const {PhotonImage}=require("@silvia-odwyer/photon-node") as {PhotonImage:new(pixels:Uint8Array,width:number,height:number)=>{get_bytes():Uint8Array;free():void}};
  const image=new PhotonImage(Uint8Array.from([255,0,0,255]),1,1); try{return image.get_bytes();}finally{image.free();}
}
async function fixture(run:(store:AttachmentStore,path:string,root:string)=>Promise<void>,clock:()=>number=Date.now):Promise<void>{
  const root=await mkdtemp(join(tmpdir(),"composer-store-")); const path=join(root,"store"); const store=await AttachmentStore.open(path,clock);
  try{await run(store,path,root);}finally{await store.close();await rm(root,{recursive:true,force:true});}
}
describe("attachment durable byte and authority store",()=>{
  it("roundtrips real text bytes, public descriptor has no paths or principal",async()=>fixture(async(store)=>{
    const file=await store.upload(owner,"例子.ts",Buffer.from("const n = 你好;\n"));
    expect(Object.keys(file).sort()).toEqual(["id","kind","mimeType","name","sha256","size"].sort());
    const result=await store.resolve(owner,[file.id]);expect(result[0]?.text).toBe("const n = 你好;\n");expect(result[0]?.bytes.toString()).toBe("const n = 你好;\n");
  }));
  it("rejects other principals, malformed references and missing objects",async()=>fixture(async(store)=>{
    const file=await store.upload(owner,"a.txt",Buffer.from("secret fixture"));await expect(store.resolve(other,[file.id])).rejects.toThrow();await expect(store.remove(other,file.id)).rejects.toThrow();
    for(const id of ["../a", "c".repeat(32)])await expect(store.resolve(owner,[id])).rejects.toThrow();await expect(store.upload("bad","a.txt",Buffer.from("x"))).rejects.toThrow();
  }));
  it("never trusts label, short hash or matching length when bytes drift",async()=>fixture(async(store,path)=>{
    const file=await store.upload(owner,"a.txt",Buffer.from("same"));await writeFile(join(path,file.id+".blob"),"evil");await expect(store.resolve(owner,[file.id])).rejects.toThrow();
  }));
  it("keeps duplicate references and same filenames with different contents distinct",async()=>fixture(async(store)=>{
    const first=await store.upload(owner,"a.txt",Buffer.from("one")),second=await store.upload(owner,"a.txt",Buffer.from("two"));expect(first.id).not.toBe(second.id);expect(first.sha256).not.toBe(second.sha256);
    const result=await store.resolve(owner,[first.id,first.id,second.id]);expect(result.map(r=>r.text)).toEqual(["one","one","two"]);
  }));
  it("persists exact objects and ownership across restart",async()=>fixture(async(store,path)=>{
    const file=await store.upload(owner,"a.txt",Buffer.from("durable"));await store.close();const restored=await AttachmentStore.open(path);try{expect((await restored.resolve(owner,[file.id]))[0]?.text).toBe("durable");await expect(restored.resolve(other,[file.id])).rejects.toThrow();}finally{await restored.close();}
  }));
  it("pins used payloads durably before intent, not deleting them as unused after TTL",async()=>{
    let now=1_800_000_000_000;await fixture(async(store,path)=>{
      const retained=await store.upload(owner,"used.txt",Buffer.from("retained")),unused=await store.upload(owner,"draft.txt",Buffer.from("unused"));await store.pin(owner,[retained.id]);now+=25*60*60*1000;await store.collectExpired();
      expect((await store.resolve(owner,[retained.id]))[0]?.text).toBe("retained");await expect(store.resolve(owner,[unused.id])).rejects.toThrow();await expect(store.remove(owner,retained.id)).rejects.toThrow();await store.close();
      const restored=await AttachmentStore.open(path,()=>now);try{expect((await restored.resolve(owner,[retained.id]))[0]?.text).toBe("retained");await expect(restored.remove(owner,retained.id)).rejects.toThrow();}finally{await restored.close();}
    },()=>now);
  });
  it("removes unpublished crash leftovers without inventing descriptors",async()=>fixture(async(store,path)=>{
    await store.close();await writeFile(join(path,"c".repeat(32)+".blob"),"orphan",{mode:0o600});const restored=await AttachmentStore.open(path);try{expect(await readdir(path)).toEqual([]);}finally{await restored.close();}
  }));
  it("validates actual image decoding and matching filename format",async()=>fixture(async(store)=>{
    const bytes=imageBytes(),file=await store.upload(owner,"photo.png",bytes);expect(file.kind).toBe("image");expect((await store.resolve(owner,[file.id]))[0]?.bytes.equals(Buffer.from(bytes))).toBe(true);
    await expect(store.upload(owner,"fake.jpg",bytes)).rejects.toThrow(/扩展名/);await expect(store.upload(owner,"broken.png",bytes.slice(0,33))).rejects.toThrow();
  }));
  it("snapshots input before asynchronous decoding",async()=>fixture(async(store)=>{
    const bytes=imageBytes();const expected=Buffer.from(bytes);const pending=store.upload(owner,"photo.png",bytes);bytes.fill(0);const file=await pending;expect((await store.resolve(owner,[file.id]))[0]?.bytes.equals(expected)).toBe(true);
  }));
  it("rejects unsupported, oversized or nonUTF8 uploads without files",async()=>fixture(async(store,path)=>{
    await expect(store.upload(owner,"a.zip",Buffer.from("x"))).rejects.toThrow();await expect(store.upload(owner,"a.txt",Buffer.from([255]))).rejects.toThrow();await expect(store.upload(owner,"a.txt",Buffer.alloc(48*1024+1,65))).rejects.toThrow();expect(await readdir(path)).toEqual([]);
  }));
  it("per principal object budget is reserved across concurrent operations",async()=>fixture(async(store)=>{
    for(let i=0;i<63;i++)await store.upload(owner,"a.txt",Buffer.from("x"));const outcomes=await Promise.allSettled([store.upload(owner,"a.txt",Buffer.from("y")),store.upload(owner,"a.txt",Buffer.from("z"))]);expect(outcomes.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(outcomes.filter(r=>r.status==="rejected")).toHaveLength(1);
    await expect(store.upload(other,"b.txt",Buffer.from("x"))).resolves.toMatchObject({kind:"text"});
  }));
  it("retains same pinned objects after parent pathname replacement",async()=>fixture(async(store,path,root)=>{
    const file=await store.upload(owner,"a.txt",Buffer.from("original"));await rename(path,join(root,"moved"));await mkdir(join(root,"evil"),{mode:0o700});await symlink(join(root,"evil"),path);expect((await store.resolve(owner,[file.id]))[0]?.text).toBe("original");
  }));
  it("disposal cancels image upload and refuses further actions",async()=>fixture(async(store)=>{
    const pending=store.upload(owner,"photo.png",imageBytes()).then(()=>"unexpected",()=>"cancelled");await store.close();expect(await pending).toBe("cancelled");await expect(store.resolve(owner,[])).rejects.toThrow();
  }));
});
