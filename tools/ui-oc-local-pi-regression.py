"""Run unchanged pi smoke/full tests with real CLI and an owned local synthetic provider.
Never imports production credentials or runs paid provider. First run smoke, then --full.
"""
import argparse
import json
import pathlib
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPO = pathlib.Path(__file__).resolve().parents[1]
NODE = pathlib.Path('/home/yyj/.nvm/versions/node/v24.18.0/bin/node')
PATH = '/home/yyj/.nvm/versions/node/v24.18.0/bin:/usr/bin:/bin'
PROVIDER = 'ui-owned-event-pump'
MODEL = 'fixture'

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', required=True, type=pathlib.Path)
    parser.add_argument('--full', action='store_true')
    args = parser.parse_args()
    out = args.out.resolve()
    allowed = (REPO / '.pi/oc-bridge-checks').resolve()
    if not out.is_relative_to(allowed) or out == allowed:
        raise SystemExit('Output must be a new owned .pi/oc-bridge-checks descendant')
    out.mkdir(parents=True, exist_ok=False)
    (out / 'commit.txt').write_text(subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True))
    requests = []
    errors = []

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'
        def log_message(self, *_):
            pass
        def do_POST(self):
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 2_000_000:
                    raise ValueError('invalid size')
                body = json.loads(self.rfile.read(size))
                users = [m for m in body.get('messages', []) if m.get('role') == 'user']
                content = users[-1].get('content') if users else None
                text = content if isinstance(content, str) else '\n'.join(p.get('text', '') for p in content or [] if p.get('type') == 'text')
                # Only bounded proof facts; never record headers/arbitrary bodies or key values.
                requests.append({'path': self.path, 'model': body.get('model'), 'stream': body.get('stream'), 'expectedPrompt': '只回复一个字：好' in text})
                if self.path != '/v1/chat/completions' or body.get('model') != MODEL or body.get('stream') is not True or not requests[-1]['expectedPrompt']:
                    raise ValueError('unexpected owned provider request')
                pieces = [{'role': 'assistant'}, {'content': '好'}, {}]
                data = []
                for i, delta in enumerate(pieces):
                    event = {'id': 'owned-event-pump', 'object': 'chat.completion.chunk', 'created': 1, 'model': MODEL, 'choices': [{'index': 0, 'delta': delta, 'finish_reason': 'stop' if i == 2 else None}]}
                    data.append('data: ' + json.dumps(event, ensure_ascii=False) + '\n\n')
                payload = (''.join(data) + 'data: [DONE]\n\n').encode()
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                self.wfile.flush()
            except Exception as error:
                errors.append(type(error).__name__)
                self.send_error(400, 'Owned provider request rejected')

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix='ui-owned-event-pump-') as home:
            root = pathlib.Path(home)
            agent = root / 'agent'
            agent.mkdir()
            model = {'id': MODEL, 'name': 'Owned event pump', 'reasoning': False, 'input': ['text'], 'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}, 'contextWindow': 128000, 'maxTokens': 512}
            (agent / 'models.json').write_text(json.dumps({'providers': {PROVIDER: {'baseUrl': f'http://127.0.0.1:{server.server_port}/v1', 'api': 'openai-completions', 'apiKey': 'synthetic-fixture-not-a-credential', 'models': [model]}}}))
            (agent / 'settings.json').write_text(json.dumps({'defaultProvider': PROVIDER, 'defaultModel': MODEL, 'defaultThinkingLevel': 'off', 'defaultProjectTrust': 'never', 'cacheWarming': 'off', 'enableInstallTelemetry': False}))
            env = {'HOME': home, 'TMPDIR': home, 'PATH': PATH, 'CI': '1', 'LANG': 'C.UTF-8', 'NO_COLOR': '1', 'PI_CODING_AGENT_DIR': str(agent), 'PI_OFFLINE': '1', 'NODE_OPTIONS': '--import=' + str(REPO / 'tests/fixtures/pi099-loopback-only.mjs'), 'PI099_NETWORK_LOG': str(out / 'network.jsonl')}
            with (out / 'guard-selfcheck.log').open('w') as log:
                subprocess.run([str(NODE), '--input-type=module', '-e', 'import assert from "node:assert/strict"; assert.throws(() => fetch("https://example.invalid/probe"), /PI099 test blocked non-loopback host/); console.log("Owned guard synchronous denial selfcheck passed");'], cwd=REPO, env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
            # Keep the deliberate guard selfcheck apart from subsequent provider/test traffic.
            (out / 'network.jsonl').rename(out / 'network-selfcheck.jsonl')
            with (out / 'pi-version.log').open('w') as log:
                subprocess.run(['pi', '--version'], cwd=REPO, env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
            cmd = [str(NODE), 'node_modules/vitest/vitest.mjs', 'run', '--maxWorkers=2', '--reporter=json', '--outputFile=' + str(out / 'results.json')]
            if not args.full:
                cmd.extend(['--project', 'integration', 'tests/integration/pi-child.smoke.test.ts'])
            (out / 'profile.json').write_text(json.dumps({'command': cmd, 'envNames': sorted(env), 'realCli': True, 'changedTests': False, 'productionCredentialsImported': False, 'localSyntheticProvider': True, 'paidProviderProof': False, 'guard': 'Node TCP/fetch loopback only, not OS sandbox'}, indent=2) + '\n')
            with (out / 'tests.log').open('w') as log:
                result = subprocess.run(cmd, cwd=REPO, env=env, stdout=log, stderr=subprocess.STDOUT)
            (out / 'provider-facts.json').write_text(json.dumps({'requests': requests, 'errors': errors, 'keyIsSyntheticLiteral': True, 'headersRecorded': False, 'arbitraryBodiesRecorded': False, 'paidModel': False}, ensure_ascii=False, indent=2) + '\n')
            (out / 'exit.json').write_text(json.dumps({'vitestExitCode': result.returncode, 'full': args.full}) + '\n')
            if result.returncode:
                raise SystemExit(result.returncode)
            report = json.loads((out / 'results.json').read_text())
            assert report['success'] and report['numFailedTests'] == 0
            target = [s for s in report['testResults'] if s['name'] == str(REPO / 'tests/integration/pi-child.smoke.test.ts')]
            assert len(target) == 1 and len(target[0]['assertionResults']) == 1 and target[0]['assertionResults'][0]['status'] == 'passed'
            assert len(requests) == 1 and requests[0]['expectedPrompt'] and not errors, 'Missing/extra/malformed actual CLI provider request'
            assert not (out / 'network.jsonl').exists(), 'Unexpected non-loopback connection attempt during actual tests'
            if not args.full:
                assert report['numTotalTests'] == report['numPassedTests'] == 1 and report['numPendingTests'] == 0
            else:
                with (out / 'coverage-check.log').open('w') as log:
                    subprocess.run([str(NODE), 'tools/ui-oc-check-full-results.mjs', str(out / 'results.json'), 'tests/fixtures/run-records/ui-oc-native/full-regression-2-workers/default.json.gz', 'sdk'], cwd=REPO, env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
            print('Unchanged actual-pi ' + ('full default' if args.full else 'smoke') + ' passed using only an owned local synthetic provider. Not paid-provider/auth/billing/UI send acceptance.')
    finally:
        server.shutdown()
        server.server_close()

if __name__ == '__main__':
    main()
