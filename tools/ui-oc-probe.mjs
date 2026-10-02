// Actual original App over labelled read-only synthetic data; no backend engine.
import http from 'node:http';
import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { previewGet, previewEventPaths } from './ui-oc-preview-data.mjs';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = resolve(root, 'vendor/openchamber-frontend/packages/web/dist');
const output = resolve(root, '.pi/ui-oc-source/probe-' + Date.now());
await mkdir(output, { recursive: true });
const requests = [], errors = [], blocked = [];
const mime = {'.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png', '.woff2':'font/woff2', '.json':'application/json'};
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  requests.push({ method: req.method, pathname }); // Never log credentials/query/body.
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'");
  if (req.method !== 'GET') { res.writeHead(501, {'Content-Type':'application/json'}).end(JSON.stringify({error:'Preview only: action not connected'})); return; }
  if (pathname === '/preview') {
    res.writeHead(200, {'Content-Type':'text/html'}).end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>原样UI · 未连接后端</title><body style="margin:0"><header style="height:36px;box-sizing:border-box;padding:8px;background:#fff2cf;font:14px sans-serif">仅UI样机 · 所有数据模拟 · 未连接pi或OpenCode · 后台动作拒绝执行</header><iframe title="OpenChamber 原UI样机" src="/" style="border:0;width:100%;height:calc(100dvh - 36px);display:block"></iframe>'); return;
  }
  if (previewEventPaths.has(pathname)) { res.writeHead(200, {'Content-Type':'text/event-stream'}); res.write(': UI fixture only; no execution events\n\n'); return; }
  const fixture = previewGet(pathname);
  if (fixture !== undefined) { res.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify(fixture)); return; }
  let path;
  try { path = resolve(dist, '.' + decodeURIComponent(pathname === '/' ? '/index.html' : pathname)); } catch { res.writeHead(400).end(); return; }
  if (!path.startsWith(dist + sep)) { res.writeHead(403).end(); return; }
  try { const bytes = await readFile(path); res.writeHead(200, {'Content-Type':mime[extname(path)] ?? 'application/octet-stream'}).end(bytes); }
  catch { res.writeHead(501, {'Content-Type':'application/json'}).end(JSON.stringify({error:'Preview endpoint not implemented', previewOnly:true})); }
});
await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
const base = `http://127.0.0.1:${server.address().port}`;
// Use an existing binary cache, never the isolated HOME's empty cache or install.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/home/yyj/.cache/ms-playwright';
if (process.argv.includes('--serve')) {
  console.log(JSON.stringify({previewURL:base+'/preview', backendConnected:false, fixtureOnly:true}));
  await new Promise(done => {
    const stop = () => { server.closeAllConnections(); server.close(done); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  });
  process.exit(0);
}
const { chromium } = createRequire('/home/yyj/ai/repos/pi-agent-ui-hybrid/package.json')('playwright');
let browser;
try {
  const executablePath = chromium.executablePath();
  await access(executablePath, constants.X_OK);
  browser = await chromium.launch({ headless:true, executablePath });
  const context = await browser.newContext({viewport:{width:1440,height:900}, serviceWorkers:'block'});
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === base) return route.continue();
    blocked.push({origin:url.origin, pathname:url.pathname}); return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(base, {waitUntil:'domcontentloaded'});
  const fixtureReady = await page.waitForFunction(() => document.body.innerText.includes('UI sample'), undefined, {timeout:10000}).then(() => true, () => false);
  await page.screenshot({path:resolve(output, 'desktop.png'), fullPage:false});
  const body = await page.locator('body').innerText();
  const controls = await page.locator('button').evaluateAll(nodes => nodes.map(node => ({text:node.textContent, title:node.title, aria:node.getAttribute('aria-label')})));
  await page.getByRole('button', {name:'Settings', exact:true}).first().click();
  await page.getByRole('dialog').filter({hasText:'Settings'}).waitFor({state:'visible', timeout:10000});
  await page.screenshot({path:resolve(output, 'settings.png'), fullPage:false});
  const settingsBody = await page.locator('body').innerText();
  // Fresh phone identity; shrinking an already-mounted desktop is not phone boot.
  const phoneContext = await browser.newContext({viewport:{width:390,height:844}, isMobile:true, hasTouch:true, userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1', serviceWorkers:'block'});
  await phoneContext.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const phone = await phoneContext.newPage();
  phone.on('pageerror', e => errors.push(String(e)));
  await phone.goto(base, {waitUntil:'domcontentloaded'});
  await phone.waitForFunction(() => document.body.innerText.includes('UI sample'), undefined, {timeout:10000});
  const phoneNoHorizontalOverflow = await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  if (!fixtureReady || !phoneNoHorizontalOverflow || errors.length) throw new Error('Original preview fixture/phone/page-error guard failed');
  const refused = await fetch(base+'/api/session', {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'});
  if (refused.status !== 501) throw new Error('Preview must not accept backend writes');
  await phone.screenshot({path:resolve(output, 'phone.png'), fullPage:false});
  const phoneBody = await phone.locator('body').innerText();
  await writeFile(resolve(output, 'diagnostic.json'), JSON.stringify({previewOnly:true, backendConnected:false, fixtureReady, settingsDialogVisible:true, backendWriteRefused:refused.status, phoneNoHorizontalOverflow, phoneIdentity:'fresh iPhone UA/touch context; not physical device/keyboard', body, settingsBody, phoneBody, controls, requests, errors, blocked}, null, 2)+'\n');
  console.log(JSON.stringify({output, controls:controls.length, pageErrors:errors.length, backendStarted:false}));
} finally {
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise(done => server.close(done));
}
