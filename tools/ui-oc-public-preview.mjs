// Transform only a NEW derived build into an inert static original-UI preview.
import {readFile, writeFile, access} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const dist=resolve(root,'.pi/ui-oc-source/public-dist');
await access(resolve(dist,'index.html'));
try {await access(resolve(dist,'preview.html')); throw new Error('Refuse overwrite of published preview');}
catch(e) {if(e.code!=='ENOENT') throw e;}
const data=await readFile(resolve(root,'tools/ui-oc-preview-data.mjs'),'utf8');
const source=data.replace(/^export /gm,'');
const prelude=`(()=>{\n${source}\n
const originalFetch=globalThis.fetch.bind(globalThis);
const prefix=new URL('./',location.href).pathname;
const refuse=()=>new Response(JSON.stringify({error:'UI preview only: backend action disabled',previewOnly:true}),{status:501,headers:{'Content-Type':'application/json'}});
globalThis.fetch=async(input,options={})=>{
 const url=new URL(typeof input==='string'||input instanceof URL?input:input.url,location.href);
 const method=(options.method||input?.method||'GET').toUpperCase();
 if(method!=='GET'||url.origin!==location.origin) return refuse();
 let path=url.pathname;
 if(path.startsWith(prefix)) {const suffix=path.slice(prefix.length); if(/^(api\/|auth\/|health$)/.test(suffix))path='/'+suffix;}
 if(previewEventPaths.has(path)) {
  const stream=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(': inert UI preview; no execution events\\n\\n')); const signal=options.signal||input?.signal; if(signal?.aborted)c.close(); else signal?.addEventListener('abort',()=>c.close(),{once:true});}});
  return new Response(stream,{headers:{'Content-Type':'text/event-stream'}});
 }
 const fixture=previewGet(path);
 if(fixture!==undefined)return new Response(JSON.stringify(fixture),{headers:{'Content-Type':'application/json'}});
 if(path.startsWith('/api')||path.startsWith('/auth')||path==='/health'||!path.startsWith(prefix))return refuse();
 return originalFetch(input,options);
};
class PreviewEvents extends EventTarget {constructor(url){super();this.url=String(url);this.readyState=0;} close(){this.readyState=2;}}
globalThis.EventSource=PreviewEvents;
// Prevent the original PWA from caching this temporary sample or replacing fetch.
if(navigator.serviceWorker)navigator.serviceWorker.register=()=>Promise.reject(new Error('PWA disabled in inert preview'));
globalThis.__OC_PREVIEW_ONLY__=true;
})();`;
// Classic synchronous prelude runs BEFORE the untouched original module scripts.
await writeFile(resolve(dist,'preview-fixture.js'),prelude);
let html=await readFile(resolve(dist,'index.html'),'utf8');
html=html.replace('<head>',`<head><meta http-equiv="Content-Security-Policy" content="connect-src 'none'; img-src 'self' data: blob:; object-src 'none'; form-action 'none'"><script src="./preview-fixture.js"></script>`);
await writeFile(resolve(dist,'index.html'),html);
await writeFile(resolve(dist,'preview.html'),`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Original UI preview — no backend</title><body style="margin:0;height:100dvh;display:flex;flex-direction:column"><header style="padding:8px;background:#fff2cf;font:13px sans-serif;flex-shrink:0">UI PREVIEW · SIMULATED DATA · NO PI/OPENCODE BACKEND · ACTIONS DISABLED</header><iframe title="Original OpenChamber UI preview" src="./index.html" style="border:0;width:100%;flex:1;min-height:0"></iframe>`);
console.log(JSON.stringify({dist,backendConnected:false,staticFixtureOnly:true}));
