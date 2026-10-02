// Check actual original App inside the PUBLIC static preview, no fake HTTP API.
import http from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,sep,extname} from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const dist=resolve(root,'.pi/ui-oc-source/public-dist');
const output=resolve(root,'.pi/ui-oc-source/static-probe-'+Date.now());
await mkdir(output,{recursive:true});
const prefix='/html/ui-oc-preview/';
const errors=[],blocked=[],requests=[];
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'};
const server=http.createServer(async(req,res)=>{
 const path=new URL(req.url,'http://127.0.0.1').pathname;
 requests.push({method:req.method,path});
 if(req.method!=='GET'||!path.startsWith(prefix)){res.writeHead(404).end();return;}
 let file;
 try{file=resolve(dist,decodeURIComponent(path.slice(prefix.length)));}catch{res.writeHead(400).end();return;}
 if(!file.startsWith(dist+sep)){res.writeHead(403).end();return;}
 try{const data=await readFile(file);res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream','Cache-Control':'no-store'}).end(data);}catch{res.writeHead(404).end();}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const base='http://127.0.0.1:'+server.address().port;
const url=base+prefix+'preview.html';
process.env.PLAYWRIGHT_BROWSERS_PATH='/home/yyj/.cache/ms-playwright';
const {chromium}=createRequire('/home/yyj/ai/repos/pi-agent-ui-hybrid/package.json')('playwright');
let browser;
try{
 browser=await chromium.launch({headless:true});
 const desktop=await browser.newContext({viewport:{width:1440,height:900},serviceWorkers:'block'});
 await desktop.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin===base&&u.pathname.startsWith(prefix))return route.continue();blocked.push({origin:u.origin,path:u.pathname});return route.abort();});
 const page=await desktop.newPage();page.on('pageerror',e=>errors.push(String(e)));
 await page.goto(url,{waitUntil:'domcontentloaded'});
 const frame=await (await page.locator('iframe').elementHandle()).contentFrame();
 await frame.waitForFunction(()=>globalThis.__OC_PREVIEW_ONLY__&&document.body.innerText.includes('UI sample'),undefined,{timeout:15000});
 const refused=await frame.evaluate(async()=>({status:(await fetch('/api/session',{method:'POST',body:'{}'})).status,signal:globalThis.__OC_PREVIEW_ONLY__}));
 if(refused.status!==501||!refused.signal)throw new Error('Static preview write guard failed');
 await page.screenshot({path:resolve(output,'desktop.png')});
 await frame.getByRole('button',{name:'Settings',exact:true}).first().click();
 await frame.getByRole('dialog').filter({hasText:'Settings'}).waitFor({state:'visible',timeout:10000});
 await page.screenshot({path:resolve(output,'settings.png')});
 const phoneContext=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',serviceWorkers:'block'});
 await phoneContext.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin===base&&u.pathname.startsWith(prefix))return route.continue();blocked.push({origin:u.origin,path:u.pathname});return route.abort();});
 const phone=await phoneContext.newPage();phone.on('pageerror',e=>errors.push(String(e)));
 await phone.goto(url,{waitUntil:'domcontentloaded'});
 const phoneFrame=await(await phone.locator('iframe').elementHandle()).contentFrame();
 await phoneFrame.waitForFunction(()=>document.body.innerText.includes('UI sample'),undefined,{timeout:15000});
 const phoneNoOverflow=await phoneFrame.evaluate(()=>document.documentElement.scrollWidth<=innerWidth);
 await phone.screenshot({path:resolve(output,'phone.png')});
 const leakedAPI=requests.some(r=>!r.path.startsWith(prefix)||r.method!=='GET');
 const result={urlScope:'Authenticated HTML subdirectory layout simulated locally; public gate checked separately',backendConnected:false,modelLoaded:true,settingsVisible:true,writeRefused:refused.status,phoneNoOverflow,leakedAPI,pageErrors:errors,blocked,requests,output};
 await writeFile(resolve(output,'checks.json'),JSON.stringify(result,null,2)+'\n');
 if(errors.length||!phoneNoOverflow||leakedAPI)throw new Error('Static preview page/overflow/network guard failed');
 console.log(JSON.stringify({output,modelLoaded:true,settingsVisible:true,writeRefused:501,phoneNoOverflow,leakedAPI,pageErrors:errors.length}));
}finally{if(browser)await browser.close();server.closeAllConnections();await new Promise(done=>server.close(done));}
