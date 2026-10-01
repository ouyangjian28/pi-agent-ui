import type { IncomingMessage, ServerResponse } from "node:http";
import { IMAGE_UPLOAD_MAX_BYTES, TEXT_UPLOAD_MAX_BYTES } from "@pi-agent-ui/protocol";
import { parseSessionCookie } from "./login-route.ts";
import { deriveConnMeta } from "../ws/ws-transport.ts";
import { AttachmentStore } from "./attachment-store.ts";
import { AttachmentInputError, classifyAttachmentName } from "./attachment-bytes.ts";
export interface AttachmentRouteOpts {
  readonly store: AttachmentStore;
  readonly sessionIdentityOf: (sid: string|null)=>string|null;
  readonly allowedOrigins: readonly string[];
  readonly trustedProxies?: readonly string[];
  readonly audit?: (line:string)=>void;
  readonly bodyTimeoutMs?: number;
}
class BodyError extends Error { constructor(readonly status: number){super("附件请求体不可用，文件未发送。");} }
/** Raw binary body; hard byte cap, one deadline, and abort handlers. No multipart/base64 expansion. */
function readBody(req: IncomingMessage,limit:number,timeoutMs:number):Promise<Buffer>{
  return new Promise((resolve,reject)=>{
    const chunks:Buffer[]=[];let total=0;let finished=false;
    const finish=(error?:Error):void=>{if(finished)return;finished=true;clearTimeout(timer);req.off("data",data);req.off("end",end);req.off("error",failure);req.off("aborted",failure);if(error!==undefined)reject(error);else resolve(Buffer.concat(chunks,total));};
    const data=(chunk:Buffer):void=>{total+=chunk.length;if(total>limit){finish(new BodyError(413));return;}chunks.push(Buffer.from(chunk));};
    const end=():void=>finish(total===0 ? new BodyError(400):undefined);
    const failure=():void=>finish(new BodyError(400));
    const timer=setTimeout(()=>finish(new BodyError(408)),timeoutMs);
    req.on("data",data);req.once("end",end);req.once("error",failure);req.once("aborted",failure);
  });
}
export function createAttachmentRoute(opts:AttachmentRouteOpts):{handle(req:IncomingMessage,res:ServerResponse):boolean;dispose():void}{
  const origins=[...opts.allowedOrigins],proxies=[...(opts.trustedProxies??[])];const inflight=new Set<IncomingMessage>();const owners=new Set<string>();let closed=false;
  const identity=(req:IncomingMessage):string|null=>opts.sessionIdentityOf(parseSessionCookie(req.headers.cookie));
  const reply=(req:IncomingMessage,res:ServerResponse,status:number,data:unknown):void=>{
    if(res.destroyed||res.writableEnded)return;
    res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Content-Security-Policy":"default-src 'none'",...(status>=400?{Connection:"close"}:{})});res.end(JSON.stringify(data));
    if(status>=400){const timer=setTimeout(()=>req.destroy(),1000);timer.unref();res.once("finish",()=>{clearTimeout(timer);req.destroy();});res.once("close",()=>{clearTimeout(timer);req.destroy();});}
  };
  const handle=(req:IncomingMessage,res:ServerResponse):boolean=>{
    const path=(req.url??"").split("?")[0]??"";if(path!=="/api/attachments"&&!path.startsWith("/api/attachments/"))return false;
    const reject=(status:number,error:string):void=>reply(req,res,status,{ok:false,error});
    if(closed){reject(503,"附件服务已关闭。");return true;}
    const meta=deriveConnMeta(req,req.socket,proxies),origin=req.headers.origin;
    if((origin===undefined?!meta.loopback:typeof origin!=="string"||origin.length===0||origin.toLowerCase()==="null"||!origins.includes(origin))||(!meta.loopback&&!meta.tls)){reject(403,"附件来源或通道不被允许。");return true;}
    const principal=identity(req);if(principal===null){reject(401,"登录已失效，请重新登录；文件未发送。");return true;}
    const id=/^\/api\/attachments\/([0-9a-f]{32})$/.exec(path)?.[1];
    if(!((req.method==="POST"&&path==="/api/attachments")||(req.method==="DELETE"&&id!==undefined))){reject(405,"附件操作不被支持。");return true;}
    if(inflight.size>=2||owners.has(principal)){reject(429,"附件上传繁忙，请稍后重试。");return true;}
    if(req.method==="POST"&&req.headers["content-type"]!=="application/octet-stream"){reject(415,"附件须以原始字节上传。");return true;}
    let name="";let maxBytes=IMAGE_UPLOAD_MAX_BYTES;
    if(req.method==="POST"){
      try{const header=req.headers["x-attachment-name"];if(typeof header!=="string"||header.length>2048)throw new Error();name=decodeURIComponent(header);maxBytes=classifyAttachmentName(name)==="text"?TEXT_UPLOAD_MAX_BYTES:IMAGE_UPLOAD_MAX_BYTES;}
      catch{reject(415,"附件名称或格式不被支持；仅支持PNG/JPEG与UTF-8文本代码。");return true;}
      const length=req.headers["content-length"];if(length!==undefined&&(!/^[0-9]+$/.test(length)||Number(length)>maxBytes)){reject(413,"附件超过上传限额。");return true;}
    }else if(req.headers["transfer-encoding"]!==undefined||(req.headers["content-length"]!==undefined&&req.headers["content-length"]!=="0")){reject(400,"移除附件不能携带请求体。");return true;}
    inflight.add(req);owners.add(principal);
    void(async()=>{
      if(req.method==="DELETE"&&id!==undefined){await opts.store.remove(principal,id);if(closed||identity(req)!==principal||res.destroyed){reject(401,"登录已失效。");return;}reply(req,res,200,{ok:true});return;}
      const bytes=await readBody(req,maxBytes,opts.bodyTimeoutMs??10_000);
      if(closed||identity(req)!==principal||res.destroyed)throw new BodyError(401);
      const attachment=await opts.store.upload(principal,name,bytes);
      if(closed||identity(req)!==principal||res.destroyed){await opts.store.remove(principal,attachment.id);throw new BodyError(401);}
      reply(req,res,201,{ok:true,attachment});
    })().catch((error:unknown)=>{
      const status=error instanceof BodyError?error.status:error instanceof AttachmentInputError?(error.code==="too-large"?413:400):503;
      const message=error instanceof BodyError||error instanceof AttachmentInputError?error.message:"附件不可用，文件未发送。";
      try{opts.audit?.(`attachment-rejected status=${status}`);}catch{/* audit must not escape the HTTP owner */}reject(status,message);
    }).finally(()=>{inflight.delete(req);owners.delete(principal);});
    return true;
  };
  return {handle,dispose:()=>{closed=true;for(const req of inflight)req.destroy();}};
}
