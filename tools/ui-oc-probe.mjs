// Diagnostic of the original built App; isolated fake auth only, no backend.
import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
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
  if (req.method !== 'GET') { res.writeHead(501, {'Content-Type':'application/json'}).end(JSON.stringify({error:'Preview only: action not connected'})); return; }
  if (pathname === '/auth/session') { res.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify({previewOnly:true})); return; }
  let path;
  try { path = resolve(dist, '.' + decodeURIComponent(pathname === '/' ? '/index.html' : pathname)); } catch { res.writeHead(400).end(); return; }
  if (!path.startsWith(dist + sep)) { res.writeHead(403).end(); return; }
  try { const bytes = await readFile(path); res.writeHead(200, {'Content-Type':mime[extname(path)] ?? 'application/octet-stream'}).end(bytes); }
  catch { res.writeHead(501, {'Content-Type':'application/json'}).end(JSON.stringify({error:'Preview endpoint not implemented', previewOnly:true})); }
});
await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
const base = `http://127.0.0.1:${server.address().port}`;
const { chromium } = createRequire('/home/yyj/ai/repos/pi-agent-ui-hybrid/package.json')('playwright');
let browser;
try {
  browser = await chromium.launch({ headless:true });
  const context = await browser.newContext({viewport:{width:1440,height:900}, serviceWorkers:'block'});
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === base) return route.continue();
    blocked.push({origin:url.origin, pathname:url.pathname}); return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(base, {waitUntil:'domcontentloaded'});
  await page.waitForTimeout(3500); // Explicit diagnostic observation window, not a job polling loop.
  await page.screenshot({path:resolve(output, 'desktop.png'), fullPage:false});
  const body = await page.locator('body').innerText();
  const controls = await page.locator('button').evaluateAll(nodes => nodes.map(node => ({text:node.textContent, title:node.title, aria:node.getAttribute('aria-label')})));
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:resolve(output, 'phone.png'), fullPage:false});
  await writeFile(resolve(output, 'diagnostic.json'), JSON.stringify({previewOnly:true, backendConnected:false, body, controls, requests, errors, blocked}, null, 2)+'\n');
  console.log(JSON.stringify({output, controls:controls.length, pageErrors:errors.length, backendStarted:false}));
} finally {
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise(done => server.close(done));
}
