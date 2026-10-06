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
const navigation = process.env.PI_OC_ROOT_NAVIGATION === '1';
const compilation = JSON.parse(await readFile(join(dist, 'native-overlays.json'), 'utf8'));
if (navigation && !compilation.nativeSourceNavigationCompiled) throw new Error('Navigation probe needs audited Source navigation overlay');
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
const frames = [], sends = [], errors = [], errorStacks = [], blocked = [], requests = [], surfaces = [], navigationFacts = [], historyFacts = [];
const mobileSessionsLabel = 'Open sessions and projects';
const mobileDialogLabel = 'Sessions';
const assert = (value, message) => { if (!value) throw new Error(message); };
let browser, server, failure, lastPage, failureFacts, lastPaintRead;
const consoleErrors = [];
try {
  // Bind the exact phone role/name to its actual Source consumer and English
  // locale. Do not borrow the desktop button's different accessible name.
  const sourceUi = join(repo, 'vendor/openchamber-frontend/packages/ui/src');
  assert((await readFile(join(sourceUi, 'apps/MobileHeader.tsx'), 'utf8')).includes("aria-label={t('mobile.sessions.openSheetAria')}"), 'Source mobile sessions consumer drift');
  const english = await readFile(join(sourceUi, 'lib/i18n/messages/en.ts'), 'utf8');
  assert(english.includes("'mobile.sessions.openSheetAria': '" + mobileSessionsLabel + "'"), 'Source mobile English accessible name drift');
  assert(english.includes("'mobile.sessions.sheet.title': '" + mobileDialogLabel + "'"), 'Source mobile dialog English name drift');
  assert((await readFile(join(sourceUi, 'apps/MobileSessionsSheet.tsx'), 'utf8')).includes("ariaLabel={t('mobile.sessions.sheet.title')}"), 'Source mobile dialog consumer drift');
  server = await startServer({ tokenFile, allowedOrigins: [origin], roots: [transcripts, journals, join(home, 'workspace')], scanDir: transcripts, tokenPollMs: 0, port, host: '127.0.0.1', staticDir: dist,
    journalLayout: { transcriptsRoot: transcripts, journalRoot: journals }, sessionFor: file => resolve(transcripts, file),
    write: { sessionFor: file => resolve(transcripts, relative(journals, file)), piBin, extraPiArgs: ['--offline', '--no-approve', '--no-extensions', '--no-context-files', '--no-skills', '--no-themes', '--no-prompt-templates', '--tools', 'read'], readinessTimeoutMs: 20000, responseTimeoutMs: 15000, turnTimeoutMs: 45000 }, audit: () => {} });
  const executablePath = chromium.executablePath(); await access(executablePath, constants.X_OK);
  browser = await chromium.launch({ headless: true, executablePath });
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ locale: 'en-US', viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, serviceWorkers: 'block', ...(mobile ? { isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' } : {}) });
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
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text().split(token).join('[redacted-fixture-token]')); });
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
    // The actual Source phone list is a closed drawer on first render.
    // Enter it through its real UI gesture, not DOM/state/Source DTO injection.
    // Diagnostic only, after login input is gone: capture the actual entry
    // and accessible controls even if navigation later fails. No state writes.
    navigationFacts.push(await page.evaluate(() => ({ surface: window.__OPENCHAMBER_SURFACE__, controls: [...document.querySelectorAll('button')].map(n => ({ text: n.textContent, aria: n.getAttribute('aria-label') })) })));
    if (mobile) {
      await page.getByRole('button', { name: mobileSessionsLabel, exact: true }).tap();
      // The Source drawer remains mounted off-screen while closed and has a
      // real 320ms enter transition. Visible alone is not viewport/steady proof.
      await page.waitForFunction(label => {
        const el = [...document.querySelectorAll('[role="dialog"]')].find(n => n.getAttribute('aria-label') === label);
        if (!el || el.getAttribute('aria-hidden') !== 'false') return false;
        const r = el.getBoundingClientRect(), style = getComputedStyle(el);
        return style.transform === 'none' && style.visibility === 'visible' && r.left >= -1 && r.top >= -1 && Math.abs(r.right - innerWidth) <= 1 && Math.abs(r.bottom - innerHeight) <= 1 && !el.getAnimations().some(a => a.playState === 'running' || a.pending);
      }, mobileDialogLabel, { timeout: 30000 });
    }
    await page.waitForFunction(() => document.body.innerText.includes('NATIVE-ROOT-OWNED'), undefined, { timeout: 30000 });
    const ownedButton = (mobile ? page.getByRole('dialog', { name: mobileDialogLabel, exact: true }) : page).locator('button').filter({ hasText: 'NATIVE-ROOT-OWNED' }).first();
    await ownedButton.waitFor({ state: 'visible', timeout: 30000 });
    const ownedButtonBounds = await ownedButton.boundingBox();
    const viewport = page.viewportSize();
    assert(ownedButtonBounds && viewport && ownedButtonBounds.width > 0 && ownedButtonBounds.height > 0 && ownedButtonBounds.x >= -1 && ownedButtonBounds.y >= -1 && ownedButtonBounds.x + ownedButtonBounds.width <= viewport.width + 1 && ownedButtonBounds.y + ownedButtonBounds.height <= viewport.height + 1, 'Owned session button is not fully inside viewport');
    assert(!await page.getByRole('dialog', { name: 'Add project directory', exact: true }).isVisible(), 'Native startup auto-opened unsupported project directory dialog');
    const facts = await page.evaluate(() => ({ surface: window.__OPENCHAMBER_SURFACE__, body: document.body.innerText, controls: [...document.querySelectorAll('button')].map(n => ({ text: n.textContent, title: n.title, aria: n.getAttribute('aria-label') })), overflow: document.documentElement.scrollWidth - innerWidth, tokenInjected: window.__OPENCHAMBER_CLIENT_TOKEN__ != null || window.__OPENCHAMBER_RUNTIME_HEADERS__ != null }));
    assert(facts.surface === (mobile ? 'mobile' : 'desktop') && !facts.tokenInjected, 'Surface/token bootstrap mismatch');
    assert(facts.overflow <= 1, 'Original surface horizontal overflow');
    await page.screenshot({ path: join(out, mobile ? 'phone.png' : 'desktop.png'), fullPage: false });
    const drawerGeometry = mobile ? await page.getByRole('dialog', { name: mobileDialogLabel, exact: true }).evaluate(el => ({ bounds: el.getBoundingClientRect().toJSON(), transform: getComputedStyle(el).transform, ariaHidden: el.getAttribute('aria-hidden'), runningAnimations: el.getAnimations().filter(a => a.playState === 'running' || a.pending).length })) : null;
    surfaces.push({ ...facts, ownedButtonBounds, drawerGeometry });
    if (navigation) {
      // Actual original row gesture only: no Source/owner/window state writes.
      if (mobile) await ownedButton.tap(); else await ownedButton.click();
      await page.waitForFunction(() => {
        const cards = [...document.querySelectorAll('[data-message-id]')];
        return ['NATIVE-HISTORY-ASSISTANT-OWNED', 'NATIVE-HISTORY-USER-OWNED'].every(text => cards.some(el => el.textContent.includes(text)));
      }, undefined, { timeout: 30000 });
      if (mobile) await page.waitForFunction(label => {
        const el = [...document.querySelectorAll('[role="dialog"]')].find(n => n.getAttribute('aria-label') === label);
        return el?.getAttribute('aria-hidden') === 'true' && !el.getAnimations().some(a => a.playState === 'running' || a.pending);
      }, mobileDialogLabel, { timeout: 30000 });
      // Require durable native snapshot bytes too, not only list title or UI text.
      assert(frames.some(f => f.t === 'snapshot' && JSON.stringify(f).includes('NATIVE-HISTORY-ASSISTANT-OWNED') && JSON.stringify(f).includes('NATIVE-HISTORY-USER-OWNED')), 'Owned native persisted history snapshot never reached browser');
      const history = await page.evaluate(() => ({ surface: window.__OPENCHAMBER_SURFACE__, overflow: document.documentElement.scrollWidth - innerWidth, cards: [...document.querySelectorAll('[data-message-id]')].map(el => ({ id: el.getAttribute('data-message-id'), text: el.textContent, bounds: el.getBoundingClientRect().toJSON() })), controls: [...document.querySelectorAll('button')].map(el => ({ text: el.textContent, aria: el.getAttribute('aria-label') })) }));
      assert(history.overflow <= 1, 'Actual native history horizontal overflow');
      for (const text of ['NATIVE-HISTORY-ASSISTANT-OWNED', 'NATIVE-HISTORY-USER-OWNED']) {
        const card = page.locator('[data-message-id]').filter({ hasText: text });
        assert(await card.count() === 1, 'Missing/duplicated distinct persisted history card: ' + text);
        await card.waitFor({ state: 'visible', timeout: 30000 });
        const bounds = await card.boundingBox(); assert(bounds && bounds.width > 0 && bounds.height > 0 && bounds.x >= -1 && bounds.x + bounds.width <= viewport.width + 1 && bounds.y < viewport.height && bounds.y + bounds.height > 0, 'Persisted history card outside viewport');
      }
      // Stronger visual gate after the preserved history3 DOM pass exposed a
      // false old-backend alert and a still-fading desktop screenshot. Read
      // actual marker text+ancestors; never alter CSS/animations/Source state.
      const paintRead = () => {
        const texts = ['NATIVE-HISTORY-ASSISTANT-OWNED', 'NATIVE-HISTORY-USER-OWNED'];
        return texts.map(text => {
          const cards = [...document.querySelectorAll('[data-message-id]')].filter(el => el.textContent.includes(text));
          if (cards.length !== 1) return { text, settled: false };
          const walker = document.createTreeWalker(cards[0], NodeFilter.SHOW_TEXT);
          let target = null; for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.textContent.includes(text)) { target = node.parentElement; break; }
          if (!target) return { text, settled: false };
          const r = target.getBoundingClientRect(); let opacity = 1, visible = true, animations = 0;
          for (let el = target; el; el = el.parentElement) {
            const style = getComputedStyle(el); opacity *= Number(style.opacity);
            visible &&= style.visibility === 'visible' && style.display !== 'none';
            animations += el.getAnimations().filter(a => a.playState === 'running' || a.pending).length;
          }
          return { text, opacity, visible, animations, bounds: r.toJSON(), settled: opacity >= .99 && visible && animations === 0 && r.width > 0 && r.height > 0 && r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1 };
        });
      };
      lastPaintRead = paintRead;
      await page.waitForFunction(`() => (${paintRead.toString()})().every(f => f.settled)`, undefined, { timeout: 30000 });
      await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
      const paint = await page.evaluate(paintRead);
      assert(paint.length === 2 && paint.every(f => f.settled), 'Native persisted history text/ancestor paint still unsettled');
      assert(!await page.getByRole('status').filter({ hasText: 'OpenCode did not start a reply to this message.' }).isVisible(), 'Native history falsely claims old OpenCode accepted send but no reply');
      await page.screenshot({ path: join(out, mobile ? 'phone-history.png' : 'desktop-history.png'), fullPage: false });
      historyFacts.push({ ...history, paint });
    }
    await context.close();
  }
  assert(frames.some(f => f.t === 'models-list' && f.models?.some(m => m.provider === 'ui-upgrade-test' && m.id === 'fixture')), 'Actual model listing never reached browser');
  assert(frames.some(f => f.t === 'sessions' && JSON.stringify(f).includes('NATIVE-ROOT-OWNED')), 'Actual session listing never reached browser');
  assert(!sends.some(t => ['prompt', 'resume', 'stop', 'steer', 'interrupt'].includes(t)), 'Readonly original Root sent native write command');
  assert(!errors.length && !blocked.length, 'Original Root page errors/external network attempts');
} catch (error) { failure = error; }
finally {
  if (failure && lastPage && !lastPage.isClosed()) {
    // Diagnostic reads only; never alter owner/Source state or existing gates.
    failureFacts = await lastPage.evaluate(() => ({ surface: window.__OPENCHAMBER_SURFACE__, body: document.body.innerText, cards: [...document.querySelectorAll('[data-message-id]')].map(el => ({ id: el.getAttribute('data-message-id'), text: el.textContent })), controls: [...document.querySelectorAll('button')].map(el => ({ text: el.textContent, aria: el.getAttribute('aria-label') })) })).catch(() => null);
    if (failureFacts && lastPaintRead) failureFacts.paint = await lastPage.evaluate(lastPaintRead).catch(() => null);
    await lastPage.screenshot({ path: join(out, 'last-page.png'), fullPage: false }).catch(() => {});
  }
  if (browser) await browser.close(); if (server) await server.dispose(); await compiler.close();
  await writeFile(join(out, 'result.json'), JSON.stringify({ passed: !failure, error: failure?.message, proofScope: navigation ? 'Actual original desktop+fresh phone UI row click/tap, native persisted JSONL snapshots and two distinct Source message cards. Readonly navigation/history only, not new/send/stream/stop/composer/paid provider/physical phone/IME acceptance.' : 'Actual original App/MobileApp plus unchanged gateway/native clients with owned history and local model configuration. Readonly Root only; not chat/composer/paid-provider/physical phone/IME acceptance.', compilation, surfaces, navigationFacts, historyFacts, historySnapshots: navigation ? frames.filter(f => f.t === 'snapshot' && JSON.stringify(f).includes('NATIVE-HISTORY-ASSISTANT-OWNED')) : [], requests, frameTypes: frames.map(f => f.t), sentTypes: sends, errors, errorStacks, consoleErrors, failureFacts, blocked, productionAuthUsed: false }, null, 2) + '\n');
}
if (failure) throw failure;
console.log(navigation ? 'Original desktop/mobile explicit native row selection and persisted history passed; composer still readonly.' : 'Original desktop/mobile native read-only Root browser passed; chat still unbound.');
