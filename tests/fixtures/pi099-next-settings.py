"""Real RpcSession -> production ProcessHost -> candidate pi -> owned HTTP provider.
No browser/DTO proof; no real credentials or paid provider. Run from any cwd.
"""
import datetime
import json
import pathlib
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPO = pathlib.Path(__file__).resolve().parents[2]
BASE = REPO / '.pi/composer-checks/real-next-settings'
OUT = BASE / datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
OUT.mkdir(parents=True, exist_ok=True)
requests = []
errors = []
with tempfile.TemporaryDirectory(prefix='pi099-next-settings-') as home:
    root = pathlib.Path(home)
    agent = root / 'agent'
    agent.mkdir()
    (root / 'workspace').mkdir()

    class Provider(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: object) -> None:
            pass

        def do_POST(self):
            size = int(self.headers['Content-Length'])
            assert 0 < size <= 1024 * 1024, 'unbounded test request'
            payload = json.loads(self.rfile.read(size))
            index = len(requests) + 1
            requests.append({'model': payload.get('model'), 'reasoningEffort': payload.get('reasoning_effort')})
            if self.path != '/v1/chat/completions' or payload.get('model') not in ['one', 'two']:
                errors.append('unexpected path/model')
                self.send_error(400)
                return
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            try:
                for delta, finish in [({'role': 'assistant'}, None), ({'content': f'Owned response {index}'}, None), ({}, 'stop')]:
                    time.sleep(.08)
                    data = {'id': f'owned-{index}', 'object': 'chat.completion.chunk', 'created': 1,
                            'model': payload['model'], 'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
                    self.wfile.write(('data: ' + json.dumps(data) + '\n\n').encode())
                    self.wfile.flush()
                self.wfile.write(b'data: [DONE]\n\n')
                self.wfile.flush()
            except BrokenPipeError:
                errors.append('unexpected cancellation')

    provider = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    models = [{'id': name, 'name': 'Owned ' + name, 'reasoning': True, 'input': ['text', 'image'],
               'thinkingLevelMap': {'off': 'none', 'low': 'low', 'high': 'high'},
               'compat': {'supportsReasoningEffort': True},
               'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0},
               'contextWindow': 128000, 'maxTokens': 512} for name in ['one', 'two']]
    (agent / 'models.json').write_text(json.dumps({'providers': {'ui-settings-test': {
        'baseUrl': f'http://127.0.0.1:{provider.server_port}/v1', 'api': 'openai-completions',
        'apiKey': 'synthetic-fixture-not-a-credential', 'models': models}}}))
    (agent / 'settings.json').write_text(json.dumps({'defaultProvider': 'ui-settings-test', 'defaultModel': 'one', 'defaultThinkingLevel': 'off'}))
    env = {'PATH': '/home/yyj/.nvm/versions/node/v24.18.0/bin:/usr/bin:/bin', 'HOME': home,
           'TMPDIR': home, 'PI_CODING_AGENT_DIR': str(agent), 'PI_OFFLINE': '1', 'LANG': 'C.UTF-8',
           'NO_COLOR': '1', 'PI099_SETTINGS_ROOT': home, 'PI099_SETTINGS_OUT': str(OUT),
           'NODE_OPTIONS': f'--import={REPO / "tests/fixtures/pi099-loopback-only.mjs"}',
           'PI099_NETWORK_LOG': str(root / 'network-probe.jsonl')}
    try:
        probe = subprocess.run(['node', '--input-type=module', '-e',
            "try { await fetch('https://example.com'); process.exit(1); } catch(e) { if (!String(e).includes('PI099 test blocked non-loopback host')) throw e; }"],
            cwd=home, env=env, capture_output=True, text=True, timeout=15)
        assert probe.returncode == 0, 'network guard selfcheck failed'
        assert json.loads((root / 'network-probe.jsonl').read_text()) == {'blockedHost': 'example.com'}
        env['PI099_NETWORK_LOG'] = str(root / 'network-run.jsonl')
        with (OUT / 'run.log').open('wb') as log:
            run = subprocess.run(['node', str(REPO / 'tests/fixtures/pi099-next-settings.mjs')],
                cwd=root / 'workspace', env=env, stdout=log, stderr=subprocess.STDOUT, timeout=90)
        blocked = [json.loads(line) for line in (root / 'network-run.jsonl').read_text().splitlines()] if (root / 'network-run.jsonl').exists() else []
        result = {'runtimeExit': run.returncode, 'providerRequests': requests, 'providerErrors': errors,
                  'blockedNonLoopbackAttempts': blocked, 'networkGuardSelfcheck': 'passed',
                  'productionAuthUsed': False, 'paidProviderUsed': False,
                  'scope': 'Real internal RpcSession/ProcessHost/pi and provider wire; NOT browser/application DTO wiring',
                  'limitation': 'Allowlisted env, disposable HOME/agentDir/cwd and Node network guard; not an OS sandbox or real provider/auth/billing proof.'}
        (OUT / 'provider-result.json').write_text(json.dumps(result, indent=2) + '\n')
        print('Artifacts:', OUT, flush=True)
        print(json.dumps(result), flush=True)
        assert run.returncode == 0, f'real settings runtime failed; inspect {OUT / "run.log"}'
        assert requests == [{'model': 'one', 'reasoningEffort': 'low'}, {'model': 'two', 'reasoningEffort': 'high'}], 'actual provider parameters differ'
        assert not errors and not blocked, 'unexpected provider/network activity'
    finally:
        provider.shutdown()
        provider.server_close()
