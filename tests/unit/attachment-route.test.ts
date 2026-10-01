import { afterEach, describe, expect, it } from "vitest";
import { createServer, request, type Server } from "node:http";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentStore } from "../../apps/server/src/http/attachment-store.ts";
import { createAttachmentRoute } from "../../apps/server/src/http/attachment-route.ts";
const principal="a".repeat(64),sid="c".repeat(64),origin="http://127.0.0.1:4444";
const cleanup:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
async function setup(bodyTimeoutMs=200):Promise<{port:number;path:string;revoke():void;server:Server}>{
  const root=await mkdtemp(join(tmpdir(),"composer-http-"));const path=join(root,"store");const store=await AttachmentStore.open(path);let allowed=true;
  const route=createAttachmentRoute({store,allowedOrigins:[origin],sessionIdentityOf:value=>allowed&&value===sid?principal:null,bodyTimeoutMs});
  const server=createServer((req,res)=>{if(!route.handle(req,res)){res.writeHead(404);res.end();}});await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const addr=server.address();if(addr===null||typeof addr==="string")throw Error("fixture failed");
  cleanup.push(async()=>{route.dispose();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await store.close();await rm(root,{recursive:true,force:true});});return{port:addr.port,path,revoke:()=>{allowed=false;},server};
}
function upload(port:number,body:Buffer,headers:Record<string,string>={}):Promise<{status:number;body:Record<string,unknown>}>{
  return new Promise((resolve,reject)=>{
    const req=request({host:"127.0.0.1",port,path:"/api/attachments",method:"POST",headers:{origin,cookie:`pi-agent-ui-session=${sid}`,"content-type":"application/octet-stream","x-attachment-name":"sample.ts","content-length":String(body.length),...headers}},res=>{let raw="";res.on("data",chunk=>{raw+=chunk;});res.on("end",()=>resolve({status:res.statusCode??0,body:JSON.parse(raw) as Record<string,unknown>}));});req.on("error",reject);req.end(body);
  });
}
describe("bounded authenticated attachment HTTP",()=>{
  it("real HTTP accepts exact code bytes and supports removing unpublished payload",async()=>{
    const{port}=await setup();const result=await upload(port,Buffer.from("const hello = '你好';"));expect(result.status).toBe(201);const file=result.body.attachment as {id:string};expect(file.id).toMatch(/^[0-9a-f]{32}$/);
    const res=await fetch(`http://127.0.0.1:${port}/api/attachments/${file.id}`,{method:"DELETE",headers:{origin,cookie:`pi-agent-ui-session=${sid}`}});expect(res.status).toBe(200);
  });
  it("rejects missing, duplicate and invalid sessions before consuming body",async()=>{
    const{port,path}=await setup();for(const cookie of ["",`pi-agent-ui-session=${sid}; pi-agent-ui-session=${sid}`,"pi-agent-ui-session=bad"]){expect((await upload(port,Buffer.from("x"),{cookie})).status).toBe(401);}expect(await readdir(path)).toEqual([]);
  });
  it("rejects cross-origin, opaque and empty origins",async()=>{
    const{port,path}=await setup();for(const value of ["https://evil.test","null",""]){expect((await upload(port,Buffer.from("x"),{origin:value})).status).toBe(403);}expect(await readdir(path)).toEqual([]);
  });
  it("origin allowlist is a frozen snapshot, not caller-owned mutable data",async()=>{
    const root=await mkdtemp(join(tmpdir(),"composer-origin-"));const store=await AttachmentStore.open(join(root,"store"));const origins=[origin];const route=createAttachmentRoute({store,allowedOrigins:origins,sessionIdentityOf:()=>principal});origins.push("https://evil.test");
    const server=createServer((req,res)=>route.handle(req,res));await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const addr=server.address();if(addr===null||typeof addr==="string")throw Error();
    try{expect((await upload(addr.port,Buffer.from("x"),{origin:"https://evil.test"})).status).toBe(403);}finally{route.dispose();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await store.close();await rm(root,{recursive:true,force:true});}
  });
  it("bounds advertised and streamed text size, media type and filename",async()=>{
    const{port,path}=await setup();expect((await upload(port,Buffer.from("x"),{"content-type":"text/plain"})).status).toBe(415);expect((await upload(port,Buffer.from("x"),{"x-attachment-name":"..%2Fx.ts"})).status).toBe(415);
    expect((await upload(port,Buffer.alloc(48*1024+1,65))).status).toBe(413);expect(await readdir(path)).toEqual([]);
  });
  it("stream cap applies without advertised content length",async()=>{
    const f=await setup();const result=await new Promise<number>((resolve,reject)=>{
      const req=request({host:"127.0.0.1",port:f.port,path:"/api/attachments",method:"POST",headers:{origin,cookie:`pi-agent-ui-session=${sid}`,"content-type":"application/octet-stream","x-attachment-name":"a.txt"}},res=>{res.resume();res.on("end",()=>resolve(res.statusCode??0));});req.on("error",reject);req.end(Buffer.alloc(49*1024,65));
    });expect(result).toBe(413);expect(await readdir(f.path)).toEqual([]);
  });
  it("reserves owner inflight budget before slow body consumption",async()=>{
    const f=await setup();const seen=new Promise<void>(resolve=>f.server.once("request",()=>resolve()));let heldReturn: ReturnType<typeof request> | undefined;
    const first=new Promise<number>((resolve,reject)=>{const held=request({host:"127.0.0.1",port:f.port,path:"/api/attachments",method:"POST",headers:{origin,cookie:`pi-agent-ui-session=${sid}`,"content-type":"application/octet-stream","x-attachment-name":"a.txt","content-length":"2"}},res=>{res.resume();res.on("end",()=>resolve(res.statusCode??0));});held.on("error",reject);heldReturn=held;held.write("x");});
    await seen;expect((await upload(f.port,Buffer.from("z"))).status).toBe(429);heldReturn?.end("y");expect(await first).toBe(201);
  });
  it("revocation during slow body prevents durable upload",async()=>{
    const f=await setup();const result=await new Promise<number>((resolve,reject)=>{
      const req=request({host:"127.0.0.1",port:f.port,path:"/api/attachments",method:"POST",headers:{origin,cookie:`pi-agent-ui-session=${sid}`,"content-type":"application/octet-stream","x-attachment-name":"a.txt","content-length":"2"}},res=>{res.resume();res.on("end",()=>resolve(res.statusCode??0));});req.on("error",reject);req.write("x");setTimeout(()=>{f.revoke();req.end("y");},20);
    });expect(result).toBe(401);expect(await readdir(f.path)).toEqual([]);
  });
  it("times out unfinished body with an actual HTTP error response",async()=>{
    const f=await setup(30);const result=await new Promise<number>((resolve,reject)=>{
      const req=request({host:"127.0.0.1",port:f.port,path:"/api/attachments",method:"POST",headers:{origin,cookie:`pi-agent-ui-session=${sid}`,"content-type":"application/octet-stream","x-attachment-name":"a.txt","content-length":"2"}},res=>{res.resume();res.on("end",()=>resolve(res.statusCode??0));});req.on("error",reject);req.write("x");
    });expect(result).toBe(408);expect(await readdir(f.path)).toEqual([]);
  });
});
