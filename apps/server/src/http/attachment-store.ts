import { createHash, randomBytes } from "node:crypto";
import { ATTACHMENT_TOTAL_MAX_BYTES, IMAGE_UPLOAD_MAX_BYTES, TEXT_UPLOAD_MAX_BYTES, isAttachmentIds, isUploadedAttachment, type UploadedAttachmentDTO } from "@pi-agent-ui/protocol";
import { classifyAttachmentName, decodeTextAttachment, AttachmentInputError } from "./attachment-bytes.ts";
import { ImageValidator } from "./image-validator.ts";
import { PinnedDirectory, AttachmentStorageError } from "./pinned-directory.ts";

interface StoredMetadata { readonly attachment: UploadedAttachmentDTO; readonly principal: string; readonly createdAt: number; }
export interface ResolvedAttachment { readonly attachment: UploadedAttachmentDTO; readonly bytes: Buffer; readonly text?: string; }
const PRINCIPAL = /^[0-9a-f]{64}$/;
const STORE_BYTES = 256 * 1024 * 1024;
const OWNER_BYTES = 32 * 1024 * 1024;
const STORE_OBJECTS = 256;
const OWNER_OBJECTS = 64;
const UNUSED_TTL_MS = 24 * 60 * 60 * 1000;
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
function publicDescriptor(v: UploadedAttachmentDTO): UploadedAttachmentDTO { return { id:v.id, name:v.name, kind:v.kind, mimeType:v.mimeType, size:v.size, sha256:v.sha256 }; }
function validMetadata(v: unknown): v is StoredMetadata {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const m=v as Record<string,unknown>;
  return Object.keys(m).length===3 && isUploadedAttachment(m.attachment) && typeof m.principal==="string" && PRINCIPAL.test(m.principal) && typeof m.createdAt==="number" && Number.isSafeInteger(m.createdAt) && m.createdAt>0;
}
/** 不透明授权引用+不可变同字节对象；不把base64塞journal，不向浏览器暴露路径。 */
export class AttachmentStore {
  private readonly objects = new Map<string,StoredMetadata>();
  private closed = false;
  private readonly pinned = new Set<string>();
  // 同对象固定/删除在第一个await之前互斥；不能成功固定后仍被已进入的删除抹掉。
  private readonly mutating = new Set<string>();
  private activeOperations = 0;
  private collecting = false;
  private drained: (()=>void) | undefined;
  private closePromise: Promise<void> | undefined;
  private async operation<T>(work: ()=>Promise<T>): Promise<T> {
    if (this.closed || this.collecting) throw new AttachmentStorageError();
    this.activeOperations++;
    try { return await work(); } finally { this.activeOperations--; if (this.activeOperations===0) this.drained?.(); }
  }
  private activeUploads = 0;
  private reservedBytes = 0;
  private readonly reservedOwner = new Map<string,{bytes:number;count:number}>();
  private constructor(private readonly directory: PinnedDirectory, private readonly validator: ImageValidator, private readonly now: () => number) {}
  static async open(path: string, now: () => number = Date.now): Promise<AttachmentStore> {
    const directory = await PinnedDirectory.open(path); const store = new AttachmentStore(directory,new ImageValidator(),now);
    try {
      const names = await directory.names();
      if (names.length > STORE_OBJECTS*3+16 || names.some((name)=>!(/^[0-9a-f]{32}\.(json|blob|pin)$/.test(name)))) throw new AttachmentStorageError();
      for (const name of names.filter((name)=>name.endsWith(".json"))) {
        const metadata: unknown = JSON.parse((await directory.read(name,4096)).toString("utf8"));
        if (!validMetadata(metadata) || metadata.attachment.id!==name.slice(0,32) || !names.includes(metadata.attachment.id+".blob")) throw new AttachmentStorageError();
        store.objects.set(metadata.attachment.id,metadata);
      }
      // Interrupted uploads have no published reference; remove their uncommitted blobs.
      for (const name of names.filter((name)=>name.endsWith(".blob") && !store.objects.has(name.slice(0,32)))) await directory.remove(name);
      for (const name of names.filter((name)=>name.endsWith(".pin"))) {
        const id=name.slice(0,32);
        if (!store.objects.has(id)) { await directory.remove(name); continue; }
        if ((await directory.read(name,1)).toString()!=="1") throw new AttachmentStorageError();
        store.pinned.add(id);
      }
      await store.collectExpired();
      if (store.totals().bytes>STORE_BYTES || store.objects.size>STORE_OBJECTS) throw new AttachmentStorageError();
      return store;
    } catch { await store.close(); throw new AttachmentStorageError(); }
  }
  private totals(principal?: string): {bytes:number;count:number} {
    let bytes=0; let count=0; for (const m of this.objects.values()) if (principal===undefined || m.principal===principal) {bytes+=m.attachment.size;count++;} return {bytes,count};
  }
  private checkPrincipal(principal: string): void { if (this.closed || !PRINCIPAL.test(principal)) throw new AttachmentStorageError(); }
  collectExpired(): Promise<void> { return this.operation(()=>this.collectExpiredNow()); }
  private async collectExpiredNow(): Promise<void> {
    if (this.activeUploads>0 || this.activeOperations>1) return;
    this.collecting=true;
    try { for (const [id,m] of this.objects) if (!this.pinned.has(id) && this.now()-m.createdAt>UNUSED_TTL_MS) { await this.directory.remove(id+".json"); await this.directory.remove(id+".blob"); this.objects.delete(id); } }
    finally { this.collecting=false; }
  }
  upload(principal: string, name: string, input: Uint8Array): Promise<UploadedAttachmentDTO> { return this.operation(()=>this.uploadNow(principal,name,input)); }
  private async uploadNow(principal: string, name: string, input: Uint8Array): Promise<UploadedAttachmentDTO> {
    this.checkPrincipal(principal); const kind=classifyAttachmentName(name);
    const limit=kind==="image" ? IMAGE_UPLOAD_MAX_BYTES : TEXT_UPLOAD_MAX_BYTES;
    if (input.byteLength===0 || input.byteLength>limit) throw new AttachmentInputError("too-large","附件超过本批单件限额，文件未发送。");
    const total=this.totals(); const owned=this.totals(principal); const reserved=this.reservedOwner.get(principal) ?? {bytes:0,count:0};
    if (this.activeUploads>=2 || total.bytes+this.reservedBytes+input.byteLength>STORE_BYTES || total.count+this.activeUploads>=STORE_OBJECTS || owned.bytes+reserved.bytes+input.byteLength>OWNER_BYTES || owned.count+reserved.count>=OWNER_OBJECTS) throw new AttachmentStorageError();
    this.activeUploads++; this.reservedBytes+=input.byteLength; this.reservedOwner.set(principal,{bytes:reserved.bytes+input.byteLength,count:reserved.count+1});
    const bytes=Buffer.from(input); const id=randomBytes(16).toString("hex"); let blobWritten=false; let metadataWritten=false;
    try {
      let mimeType: UploadedAttachmentDTO["mimeType"];
      if (kind==="image") {
        const header=await this.validator.validate(bytes); mimeType=header.mimeType;
        if ((/\.png$/i.test(name)) !== (mimeType==="image/png")) throw new AttachmentInputError("invalid-image","图片扩展名与实际格式不一致，请按原格式重新保存。");
      } else { decodeTextAttachment(bytes); mimeType="text/plain"; }
      this.checkPrincipal(principal);
      const attachment: UploadedAttachmentDTO={id,name,kind,mimeType,size:bytes.length,sha256:digest(bytes)};
      const metadata: StoredMetadata={attachment,principal,createdAt:this.now()};
      await this.directory.writeExclusive(id+".blob",bytes); blobWritten=true;
      await this.directory.writeExclusive(id+".json",Buffer.from(JSON.stringify(metadata))); metadataWritten=true;
      this.checkPrincipal(principal); this.objects.set(id,metadata); return publicDescriptor(attachment);
    } catch (error) {
      if (metadataWritten) await this.directory.remove(id+".json"); if (blobWritten) await this.directory.remove(id+".blob");
      throw error instanceof AttachmentInputError ? error : new AttachmentStorageError();
    } finally {
      this.activeUploads--; this.reservedBytes-=bytes.length;
      const r=this.reservedOwner.get(principal); if (r!==undefined) { if (r.count===1) this.reservedOwner.delete(principal); else this.reservedOwner.set(principal,{bytes:r.bytes-bytes.length,count:r.count-1}); }
    }
  }
  resolve(principal: string, ids: readonly string[]): Promise<readonly ResolvedAttachment[]> { return this.operation(()=>this.resolveNow(principal,ids)); }
  private async resolveNow(principal: string, ids: readonly string[]): Promise<readonly ResolvedAttachment[]> {
    this.checkPrincipal(principal); if (!isAttachmentIds(ids)) throw new AttachmentStorageError();
    const entries=ids.map((id)=>this.objects.get(id));
    if (entries.some((m)=>m===undefined || m.principal!==principal)) throw new AttachmentStorageError();
    if (entries.reduce((size,m)=>size+(m?.attachment.size??0),0)>ATTACHMENT_TOTAL_MAX_BYTES) throw new AttachmentInputError("too-large","一条消息的附件总量不能超过20 MiB。");
    const resolved: ResolvedAttachment[]=[];
    for (const m of entries) {
      if (m===undefined) throw new AttachmentStorageError();
      const bytes=await this.directory.read(m.attachment.id+".blob",m.attachment.size);
      if (bytes.length!==m.attachment.size || digest(bytes)!==m.attachment.sha256) throw new AttachmentStorageError();
      resolved.push(m.attachment.kind==="text" ? {attachment:publicDescriptor(m.attachment),bytes,text:decodeTextAttachment(bytes)} : {attachment:publicDescriptor(m.attachment),bytes});
    }
    this.checkPrincipal(principal); return resolved;
  }
  /** 必须在意图入journal之前固定对象；未知/重启恢复不可被普通待发送清理删掉。 */
  pin(principal: string, ids: readonly string[]): Promise<void> { return this.operation(async()=>{
    this.checkPrincipal(principal); if (!isAttachmentIds(ids)) throw new AttachmentStorageError();
    const unique=[...new Set(ids)];
    if (unique.some((id)=>this.mutating.has(id))) throw new AttachmentStorageError();
    for (const id of unique) this.mutating.add(id);
    try {
      await this.resolveNow(principal,ids);
      for (const id of unique) if (!this.pinned.has(id)) { await this.directory.writeExclusive(id+".pin",Buffer.from("1")); this.pinned.add(id); }
    } finally { for (const id of unique) this.mutating.delete(id); }
  }); }
  remove(principal: string, id: string): Promise<void> { return this.operation(async()=>{
    this.checkPrincipal(principal); const m=this.objects.get(id); if (m===undefined || m.principal!==principal || this.pinned.has(id) || this.mutating.has(id)) throw new AttachmentStorageError();
    this.mutating.add(id);
    try { await this.directory.remove(id+".json"); await this.directory.remove(id+".blob"); this.objects.delete(id); }
    finally { this.mutating.delete(id); }
  }); }
  close(): Promise<void> {
    this.closePromise ??= (async()=>{
      this.closed=true; await this.validator.dispose();
      if (this.activeOperations>0) await new Promise<void>((resolve)=>{this.drained=resolve;});
      await this.directory.close();
    })();
    return this.closePromise;
  }
}
