// Actual original App/MobileApp -> unchanged startServer -> native pi clients.
// Read-only Root proof; no Source data mocks, WS replacement or state injection.
import { createServer as createViteServer } from 'vite';
import { chromium } from 'playwright';
import { randomBytes } from 'node:crypto';
import { createServer as reservePort } from 'node:net';
import { execFileSync } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join, basename, relative } from 'node:path';
const repo = process.env.PI_OC_ROOT_REPO ?? resolve(import.meta.dirname, '../..');
if (repo !== '/home/yyj/ai/repos/pi-agent-ui-oc-bridge') throw new Error('Original Root fixture must use the approved isolated candidate repository');
const home = process.env.PI_OC_ROOT_HOME;
const out = process.env.PI_OC_ROOT_OUTPUT;
const dist = process.env.PI_OC_ROOT_DIST;
if (!home || !basename(home).startsWith('pi-oc-root-') || process.env.HOME !== home || process.env.PI_CODING_AGENT_DIR !== join(home, 'agent')) throw new Error('Refuse non-isolated original Root fixture');
const ignored = join(repo, '.pi/oc-bridge-checks') + '/';
if (!out?.startsWith(ignored) || !dist?.startsWith(ignored) || !dist.endsWith('/dist')) throw new Error('Invalid original Root proof paths');
const compilation = JSON.parse(await readFile(join(dist, 'native-overlays.json'), 'utf8'));
if (!compilation.nativeOriginalEntryCompiled || !compilation.nativeSourceComposerReadOnly || compilation.originalSourceModified || compilation.backendStarted) throw new Error('Need audited original native-entry dist');
const piBin = join(repo, 'node_modules/.bin/pi');
if (execFileSync(piBin, ['--version'], { encoding: 'utf8' }).trim() !== '0.99.2') throw new Error('Candidate runtime drift');
const compiler = await createViteServer({ root: repo, configFile: false, cacheDir: join(out, 'vite-cache'), server: { middlewareMode: true, hmr: false, watch: null }, ssr: { noExternal: ['@pi-agent-ui/protocol'] }, logLevel: 'error' });
const { startServer } = await compiler.ssrLoadModule(join(repo, 'apps/server/src/composition.ts'));
const reservation = reservePort();
await new Promise((done, fail) => { reservation.once('error', fail); reservation.listen(0, '127.0.0.1', done); });
const port = reservation.address().port;
await new Promise(done => reservation.close(done));
const origin = `http://127.0.0.1:${port}`;
const token = randomBytes(32).toString('hex');
const tokenFile = join(home, 'fixture-token.json');
await writeFile(tokenFile, JSON.stringify({ version: 1, tokens: [token] }), { mode: 0o600, flag: 'wx' });
const transcripts = join(home, 'transcripts'), journals = join(home, 'journal');
const frames = [], sends = [], errors = [], errorStacks = [], blocked = [], requests = [], surfaces = [];
const assert = (value, message) => { if (!value) throw new Error(message); };
let browser, server, failure, lastPage;
try {
  server = await startServer({ tokenFile, allowedOrigins: [origin], roots: [transcripts, journals, join(home, 'workspace')], scanDir: transcripts, tokenPollMs: 0, port, host: '127.0.0.1', staticDir: dist,
    journalLayout: { transcriptsRoot: transcripts, journalRoot: journals }, sessionFor: file => resolve(transcripts, file),
    write: { sessionFor: file => resolve(transcripts, relative(journals, file)), piBin, extraPiArgs: ['--offline', '--no-approve', '--no-extensions', '--no-context-files', '--no-skills', '--no-themes', '--no-prompt-templates', '--tools', 'read'], readinessTimeoutMs: 20000, responseTimeoutMs: 15000, turnTimeoutMs: 45000 }, audit: () => {} });
  const executablePath = chromium.executablePath(); await access(executablePath, constants.X_OK);
  browser = await chromium.launch({ headless: true, executablePath });
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, serviceWorkers: 'block', ...(mobile ? { isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' } : {}) });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === origin || ['blob:', 'data:'].includes(url.protocol)) return route.continue();
      blocked.push({ origin: url.origin, pathname: url.pathname }); return route.abort();
    });
    const page = await context.newPage(); lastPage = page;
    page.on('pageerror', error => {
      errors.push(error.message);
      // Diagnostic only. Keep existing error/visibility gates; never persist
      // the owned login token even if a future transport embeds it in a stack.
      errorStacks.push((error.stack ?? error.message).split(token).join('[redacted-fixture-token]'));
    });
    page.on('request', request => { const url = new URL(request.url()); requests.push({ method: request.method(), pathname: url.pathname }); });
    page.on('websocket', socket => {
      assert(new URL(socket.url()).origin === origin.replace('http:', 'ws:'), 'Non-owned browser socket');
      socket.on('framereceived', ({ payload }) => { try { frames.push(JSON.parse(String(payload))); } catch { errors.push('Malformed native frame'); } });
      // Never persist auth bodies/tokens; retain only frame type for no-write gate.
      socket.on('framesent', ({ payload }) => { try { sends.push(JSON.parse(String(payload)).t); } catch { errors.push('Malformed browser frame'); } });
    });
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('pi 登录令牌', { exact: true }).fill('fixture-wrong-not-a-credential');
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '没有加载原界面' }).waitFor();
    assert(await page.getByLabel('pi 登录令牌', { exact: true }).inputValue() === '', 'Failed login retains token in DOM');
    await page.getByLabel('pi 登录令牌', { exact: true }).fill(token);
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await page.getByLabel('pi 登录令牌', { exact: true }).waitFor({ state: 'hidden', timeout: 30000 });
    await page.waitForFunction(() => document.body.innerText.includes('NATIVE-ROOT-OWNED'), undefined, { timeout: 30000 });
    const facts = await page.evaluate(() => ({ surface: window.__OPENCHAMBER_SURFACE__, body: document.body.innerText, controls: [...document.querySelectorAll('button')].map(n => ({ text: n.textContent, title: n.title, aria: n.getAttribute('aria-label') })), overflow: document.documentElement.scrollWidth - innerWidth, tokenInjected: window.__OPENCHAMBER_CLIENT_TOKEN__ != null || window.__OPENCHAMBER_RUNTIME_HEADERS__ != null }));
    assert(facts.surface === (mobile ? 'mobile' : 'desktop') && !facts.tokenInjected, 'Surface/token bootstrap mismatch');
    assert(facts.overflow <= 1, 'Original surface horizontal overflow');
    await page.screenshot({ path: join(out, mobile ? 'phone.png' : 'desktop.png'), fullPage: false });
    surfaces.push(facts); await context.close();
  }
  assert(frames.some(f => f.t === 'models-list' && f.models?.some(m => m.provider === 'ui-upgrade-test' && m.id === 'fixture')), 'Actual model listing never reached browser');
  assert(frames.some(f => f.t === 'sessions' && JSON.stringify(f).includes('NATIVE-ROOT-OWNED')), 'Actual session listing never reached browser');
  assert(!sends.some(t => ['prompt', 'resume', 'stop', 'steer', 'interrupt'].includes(t)), 'Readonly original Root sent native write command');
  assert(!errors.length && !blocked.length, 'Original Root page errors/external network attempts');
} catch (error) { failure = error; }
finally {
  if (failure && lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: join(out, 'last-page.png'), fullPage: false }).catch(() => {});
  if (browser) await browser.close(); if (server) await server.dispose(); await compiler.close();
  await writeFile(join(out, 'result.json'), JSON.stringify({ passed: !failure, error: failure?.message, proofScope: 'Actual original App/MobileApp plus unchanged gateway/native clients with owned history and local model configuration. Readonly Root only; not chat/composer/paid-provider/physical phone/IME acceptance.', compilation, surfaces, requests, frameTypes: frames.map(f => f.t), sentTypes: sends, errors, errorStacks, blocked, productionAuthUsed: false }, null, 2) + '\n');
}
if (failure) throw failure;
console.log('Original desktop/mobile native read-only Root browser passed; chat still unbound.');
