"""Real browser -> application -> local pi, with an owned loopback-only provider.
Run: python3 tests/fixtures/pi099-real-app.py. No production credentials/models.
"""
import datetime
import json
import os
import pathlib
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPO = pathlib.Path(__file__).resolve().parents[2]
BASE = REPO / '.pi/upgrade-checks/app-bridge'
OUT = BASE / 'runs' / datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
OUT.mkdir(parents=True, exist_ok=True)
(BASE / 'latest.json').write_text(json.dumps({'runDirectory': str(OUT)}) + '\n')
requests = []
errors = []

with tempfile.TemporaryDirectory(prefix='pi099-real-app-') as home:
    root = pathlib.Path(home)
    agent = root / 'agent'
    agent.mkdir()
    for name in ['workspace', 'journal', 'transcripts']:
        (root / name).mkdir()

    class Provider(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            index = len(requests) + 1
            requests.append({'index': index, 'path': self.path, 'model': payload.get('model')})
            if self.path != '/v1/chat/completions' or payload.get('model') != 'fixture':
                errors.append('unexpected provider path/model')
                self.send_error(400)
                return
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            parts = [({'role': 'assistant'}, None), ({'content': '受控应用正文 '}, None),
                     ({'content': f'✓ 第{index}轮'}, None), ({}, 'stop')]
            try:
                for delta, reason in parts:
                    time.sleep(.22)
                    data = {'id': f'owned-{index}', 'object': 'chat.completion.chunk', 'created': 1,
                            'model': 'fixture', 'choices': [{'index': 0, 'delta': delta, 'finish_reason': reason}]}
                    self.wfile.write(('data: ' + json.dumps(data, ensure_ascii=False) + '\n\n').encode())
                    self.wfile.flush()
                self.wfile.write(b'data: [DONE]\n\n')
                self.wfile.flush()
            except BrokenPipeError:
                errors.append('unexpected provider cancellation')

    provider = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    (agent / 'models.json').write_text(json.dumps({'providers': {'ui-upgrade-test': {
        'baseUrl': f'http://127.0.0.1:{provider.server_port}/v1', 'api': 'openai-completions',
        'apiKey': 'synthetic-fixture-not-a-credential', 'models': [{'id': 'fixture', 'name': 'Owned fixture',
        'reasoning': False, 'input': ['text'], 'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0},
        'contextWindow': 128000, 'maxTokens': 512}]}}}))
    (agent / 'settings.json').write_text(json.dumps({'defaultProvider': 'ui-upgrade-test', 'defaultModel': 'fixture', 'defaultThinkingLevel': 'off'}))
    timestamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
    (root / 'transcripts/owned-history.jsonl').write_text(json.dumps({'type': 'session', 'version': 3,
        'id': 'owned-history', 'timestamp': timestamp, 'cwd': str(root / 'workspace')}) + '\n')
    env = {'PATH': '/home/yyj/.nvm/versions/node/v24.18.0/bin:/usr/bin:/bin', 'HOME': home,
           'TMPDIR': home, 'PI_CODING_AGENT_DIR': str(agent), 'PI_OFFLINE': '1', 'LANG': 'C.UTF-8',
           'NO_COLOR': '1', 'PI099_FIXTURE_ROOT': home, 'PI099_OUTPUT_DIR': str(OUT),
           'PLAYWRIGHT_BROWSERS_PATH': '/home/yyj/.cache/ms-playwright',
           'NODE_OPTIONS': f'--import={REPO / "tests/fixtures/pi099-loopback-only.mjs"}',
           'PI099_NETWORK_LOG': str(root / 'network-selfcheck.jsonl')}
    try:
        # First use of the guard is on an owned subprocess and a deliberate blocked request.
        probe = subprocess.run(['node', '--input-type=module', '-e',
            "try { await fetch('https://example.com'); process.exit(1); } catch(e) { if (!String(e).includes('PI099 test blocked non-loopback host')) throw e; }"],
            cwd=home, env=env, capture_output=True, text=True, timeout=15)
        assert probe.returncode == 0, 'loopback guard selfcheck failed'
        assert json.loads((root / 'network-selfcheck.jsonl').read_text()) == {'blockedHost': 'example.com'}
        env['PI099_NETWORK_LOG'] = str(root / 'network-run.jsonl')
        with (OUT / 'run.log').open('wb') as log:
            run = subprocess.run(['node', str(REPO / 'tests/browser/pi099-real-bridge.mjs')],
                cwd=root / 'workspace', env=env, stdout=log, stderr=subprocess.STDOUT, timeout=150)
        network_attempts = [json.loads(line) for line in (root / 'network-run.jsonl').read_text().splitlines()] if (root / 'network-run.jsonl').exists() else []
        result = {'applicationExitCode': run.returncode, 'providerRequests': requests, 'providerErrors': errors,
                  'blockedNonLoopbackAttempts': network_attempts, 'networkGuardSelfcheck': 'passed',
                  'isolation': 'allowlisted env, temporary HOME/agentDir/workspace; Node TCP/fetch loopback guard; fresh browser',
                  'productionAuthUsed': False, 'paidProviderUsed': False,
                  'limitation': 'Node network guard is not an OS sandbox; mock provider does not prove real auth/billing/real phone.'}
        (OUT / 'provider-result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
        print('Artifacts:', OUT)
        print(json.dumps(result, ensure_ascii=False))
        assert run.returncode == 0, 'application bridge failed; inspect .pi/upgrade-checks/app-bridge/run.log'
        assert len(requests) == 2 and not errors and not network_attempts, 'unexpected provider/network activity'
    finally:
        provider.shutdown()
        provider.server_close()
