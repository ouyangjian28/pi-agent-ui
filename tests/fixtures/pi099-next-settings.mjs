// Real candidate runtime + production host, isolated by companion Python launcher.
import { createServer as createViteServer } from 'vite';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
const repo = resolve(import.meta.dirname, '../..');
const root = process.env.PI099_SETTINGS_ROOT;
const out = process.env.PI099_SETTINGS_OUT;
if (!root || !basename(root).startsWith('pi099-next-settings-') || process.env.HOME !== root || process.env.PI_CODING_AGENT_DIR !== join(root, 'agent')) throw new Error('Refuse non-isolated settings environment');
if (!out || !out.startsWith(join(repo, '.pi/composer-checks/real-next-settings/'))) throw new Error('Invalid settings artifact path');
await mkdir(out, { recursive: true });
const piBin = join(repo, 'node_modules/.bin/pi');
const version = execFileSync(piBin, ['--version'], { encoding: 'utf8' }).trim();
if (version !== '0.99.2') throw new Error(`Candidate runtime drift: ${version}`);
const compiler = await createViteServer({ root: repo, configFile: false, cacheDir: join(out, 'vite-cache'), server: { middlewareMode: true, hmr: false, watch: null }, ssr: { noExternal: ['@pi-agent-ui/protocol'] }, logLevel: 'error' });
const { RpcSession } = await compiler.ssrLoadModule(join(repo, 'apps/server/src/runtime/rpc-session.ts'));
const { FileDurability } = await compiler.ssrLoadModule(join(repo, 'apps/server/src/runtime/file-durability.ts'));
const { PiProcessHost } = await compiler.ssrLoadModule(join(repo, 'apps/server/src/host/process-host.ts'));
const actual = new PiProcessHost({ piBin });
const sent = [];
const responses = [];
const checks = [];
let spawns = 0;
const ownedChildren = [];
let failure;
let session;
const assert = (value, message) => { if (!value) throw new Error(message); };
const rows = async () => (await readFile(join(root, 'journal.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
async function settled(intent) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const journal = await rows();
    if (journal.some(row => row.t === 'settled' && row.intentId === intent) && session.getState().gate.kind === 'idle') {
      const indices = ['enqueue', 'sending', 'settled'].map(t => journal.findIndex(row => row.t === t && row.intentId === intent));
      assert(indices[0] >= 0 && indices[0] < indices[1] && indices[1] < indices[2], 'Durable intent ordering failed');
      return;
    }
    await new Promise(done => setTimeout(done, 30));
  }
  throw new Error(`Real settings settle deadline: ${intent}`);
}
// Observations only: every byte/response still flows through production host and session.
const host = {
  spawn(args, handlers, cwd) {
    spawns++;
    let finish;
    const exit = new Promise(resolve => { finish = resolve; });
    const handle = actual.spawn(args, { ...handlers, onExit(...facts) {
      finish();
      handlers.onExit(...facts);
    }, onEvent(event) {
      if (event.type === 'response' && event.id?.startsWith('cfg-')) {
        const data = event.data;
        responses.push({ id: event.id, command: event.command, success: event.success,
          model: data?.model ? { provider: data.model.provider, id: data.model.id } : undefined,
          thinkingLevel: data?.thinkingLevel, levels: data?.levels,
          isStreaming: data?.isStreaming, isCompacting: data?.isCompacting, pendingMessageCount: data?.pendingMessageCount });
      }
      handlers.onEvent(event);
    } }, cwd);
    ownedChildren.push({ handle, exit });
    return handle;
  },
  writeStdin(handle, text) { sent.push(JSON.parse(text)); return actual.writeStdin(handle, text); },
  closeStdin(handle) { actual.closeStdin(handle); },
  stop(handle, signal) { actual.stop(handle, signal); },
};
try {
  await writeFile(join(root, 'journal.jsonl'), '', { flag: 'wx' });
  session = new RpcSession({ sessionFile: join(root, 'transcript.jsonl'), journalPath: join(root, 'journal.jsonl'), sessionId: 'owned-settings',
    host, durability: new FileDurability(join(root, 'journal.jsonl')), cwd: join(root, 'workspace'),
    extraPiArgs: ['--offline', '--no-approve', '--no-extensions', '--no-context-files', '--no-skills', '--no-themes', '--no-prompt-templates', '--tools', 'read'],
    readinessTimeoutMs: 20000, settingsTimeoutMs: 3000, responseTimeoutMs: 15000, audit: () => undefined });
  const first = await session.send('Owned first turn', undefined, 'ui-settings-test/one', { thinkingLevel: 'low' });
  assert(first.kind === 'launched', `Cold configuration rejected: ${JSON.stringify(first)}`);
  assert(typeof first.key?.intentId === 'string', 'Internal LaunchOutcome.key.intentId missing');
  await settled(first.key.intentId);
  assert((await readFile(join(root, 'transcript.jsonl.model'), 'utf8')).trim() === 'ui-settings-test/one', 'Cold canonical preference not confirmed');
  checks.push('cold real model/thinking confirmed before durable prompt and settled');
  const marker = sent.length;
  const second = await session.send('Owned second turn', 1, 'ui-settings-test/two', { thinkingLevel: 'high' });
  assert(second.kind === 'launched', `Warm configuration rejected: ${JSON.stringify(second)}`);
  assert(typeof second.key?.intentId === 'string', 'Internal LaunchOutcome.key.intentId missing');
  await settled(second.key.intentId);
  const types = sent.slice(marker).map(frame => frame.type);
  assert(types.indexOf('set_model') >= 0 && types.indexOf('set_thinking_level') > types.indexOf('set_model') && types.indexOf('prompt') > types.indexOf('set_thinking_level'), 'Warm configuration order broken');
  assert(spawns === 1, 'Model change respawned rather than reconfigured warm process');
  assert((await readFile(join(root, 'transcript.jsonl.model'), 'utf8')).trim() === 'ui-settings-test/two', 'Warm canonical preference not confirmed');
  checks.push('warm single-process real model/thinking switching and durable settlement');
  const before = await readFile(join(root, 'journal.jsonl'), 'utf8');
  const promptCount = sent.filter(frame => frame.type === 'prompt').length;
  const invalid = await session.send('Must not send unsupported setting', 1, undefined, { thinkingLevel: 'max' });
  assert(invalid.kind === 'not-ready' && invalid.cause === 'settings-rejected', `Unsupported real level accepted: ${JSON.stringify(invalid)}`);
  assert(sent.filter(frame => frame.type === 'prompt').length === promptCount && await readFile(join(root, 'journal.jsonl'), 'utf8') === before, 'Rejected level wrote prompt or intent');
  assert((await readFile(join(root, 'transcript.jsonl.model'), 'utf8')).trim() === 'ui-settings-test/two', 'Rejected level changed preference');
  checks.push('actual unsupported thinking rejected with no prompt/intent/preference change');
} catch (error) {
  failure = error;
} finally {
  // RpcSession.dispose deliberately releases resources, not its warm process.
  // Retire only this fixture's owned children and observe real exit; do not force success/exit.
  const waitExit = async (child, ms) => {
    let timer;
    try {
      return await Promise.race([child.exit.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); })]);
    } finally { clearTimeout(timer); }
  };
  try {
    for (const child of ownedChildren) {
      actual.closeStdin(child.handle);
      if (!await waitExit(child, 2000)) {
        actual.stop(child.handle, 'SIGTERM');
        if (!await waitExit(child, 1000)) {
          actual.stop(child.handle, 'SIGKILL');
          assert(await waitExit(child, 1000), 'Owned pi cleanup did not observe real exit');
        }
      }
    }
  } catch (error) { failure ??= error; }
  await session?.dispose();
  await compiler.close();
  await writeFile(join(out, 'runtime-result.json'), JSON.stringify({ version, spawns, checks, sent, responses, cleanupObservedExit: !failure, passed: !failure,
    failure: failure ? String(failure) : undefined, scope: 'internal real runtime; not browser/DTO attachment wiring' }, null, 2) + '\n');
}
if (failure) throw failure;
console.log(`Real settings checks passed: ${checks.length}; candidate ${version}; one warm process`);
