"""Owned original-App readonly browser fixture. No production auth/config.
First execution uses a byte-identical copied Node harness. Mock provider must
receive zero requests; this is not chat/provider/physical-phone acceptance.
"""
import argparse
import datetime
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPO = pathlib.Path(os.environ.get('PI_OC_ROOT_REPO', pathlib.Path(__file__).resolve().parents[2])).resolve()
assert str(REPO) == '/home/yyj/ai/repos/pi-agent-ui-oc-bridge', 'unapproved candidate repo'
parser = argparse.ArgumentParser()
parser.add_argument('--dist', required=True)
parser.add_argument('--out', required=True)
parser.add_argument('--navigation', action='store_true', help='Also exercise actual UI selection and owned persisted history (composer stays readonly)')
args = parser.parse_args()
base = REPO / '.pi/oc-bridge-checks'
dist, out = pathlib.Path(args.dist).resolve(), pathlib.Path(args.out).resolve()
assert dist.is_relative_to(base) and out.is_relative_to(base) and dist.name == 'dist', 'unapproved fixture paths'
assert not out.exists(), 'refuse overwrite of browser evidence'
assert (dist / 'native-overlays.json').is_file(), 'missing audited compiler output'
out.mkdir(parents=True)
copy = out / 'rehearsal' / 'oc-native-root.mjs'
copy.parent.mkdir()
source = REPO / 'tests/browser/oc-native-root.mjs'
shutil.copyfile(source, copy)
assert copy.read_bytes() == source.read_bytes(), 'copied harness differs'
(out / 'harness-copy.json').write_text(json.dumps({'source': str(source), 'copySHA256': hashlib.sha256(copy.read_bytes()).hexdigest(), 'copiedFirstRun': True}) + '\n')
provider_requests = []
with tempfile.TemporaryDirectory(prefix='pi-oc-root-') as home:
    root = pathlib.Path(home)
    for name in ['agent', 'workspace', 'journal', 'transcripts']:
        (root / name).mkdir()

    class Provider(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_POST(self):
            provider_requests.append({'method': 'POST', 'path': self.path})
            self.send_error(503, 'Readonly Root must never prompt provider')

    provider = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    (root / 'agent/models.json').write_text(json.dumps({'providers': {'ui-upgrade-test': {
        'baseUrl': f'http://127.0.0.1:{provider.server_port}/v1', 'api': 'openai-completions',
        'apiKey': 'synthetic-fixture-not-a-credential', 'models': [{'id': 'fixture', 'name': 'Owned fixture',
        'reasoning': True, 'thinkingLevelMap': {'off': 'none', 'low': 'low', 'high': 'high'}, 'input': ['text', 'image'],
        'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}, 'contextWindow': 128000, 'maxTokens': 512}]}}}))
    (root / 'agent/settings.json').write_text(json.dumps({'defaultProvider': 'ui-upgrade-test', 'defaultModel': 'fixture', 'defaultThinkingLevel': 'off'}))
    now = datetime.datetime.now(datetime.timezone.utc)
    rows = [{'type': 'session', 'version': 3, 'id': 'NATIVE-ROOT-OWNED', 'timestamp': now.isoformat(), 'cwd': str(root / 'workspace')},
            {'type': 'message', 'id': 'feed0001', 'parentId': None, 'timestamp': now.isoformat(), 'message': {'role': 'user', 'content': [{'type': 'text', 'text': 'NATIVE-ROOT-OWNED'}], 'timestamp': int(now.timestamp() * 1000)}}]
    if args.navigation:
        # Real native JSONL on disk, not Source DTO/store or a list-title proxy.
        rows.extend([
            {'type': 'message', 'id': 'feed0002', 'parentId': 'feed0001', 'timestamp': now.isoformat(), 'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': 'NATIVE-HISTORY-ASSISTANT-OWNED'}], 'api': 'openai-completions', 'provider': 'ui-upgrade-test', 'model': 'fixture', 'stopReason': 'stop', 'usage': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0, 'totalTokens': 0, 'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0, 'total': 0}}, 'timestamp': int(now.timestamp() * 1000)}},
            {'type': 'message', 'id': 'feed0003', 'parentId': 'feed0002', 'timestamp': now.isoformat(), 'message': {'role': 'user', 'content': [{'type': 'text', 'text': 'NATIVE-HISTORY-USER-OWNED'}], 'timestamp': int(now.timestamp() * 1000)}}])
    (root / 'transcripts/NATIVE-ROOT-OWNED.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in rows))
    (root / 'journal/NATIVE-ROOT-OWNED.jsonl').write_text('')
    env = {'PATH': '/home/yyj/.nvm/versions/node/v24.18.0/bin:/usr/bin:/bin', 'HOME': home, 'TMPDIR': home,
           'PI_CODING_AGENT_DIR': str(root / 'agent'), 'PI_OFFLINE': '1', 'LANG': 'C.UTF-8', 'NO_COLOR': '1',
           'PI_OC_ROOT_HOME': home, 'PI_OC_ROOT_REPO': str(REPO), 'PI_OC_ROOT_OUTPUT': str(out), 'PI_OC_ROOT_DIST': str(dist),
           'PLAYWRIGHT_BROWSERS_PATH': '/home/yyj/.cache/ms-playwright',
           'NODE_OPTIONS': f'--import={REPO / "tests/fixtures/pi099-loopback-only.mjs"}',
           'PI099_NETWORK_LOG': str(root / 'network-selfcheck.jsonl'), 'PI_OC_ROOT_NAVIGATION': '1' if args.navigation else '0'}
    try:
        probe = subprocess.run(['node', '--input-type=module', '-e',
            "try { await fetch('https://example.com'); process.exit(1); } catch(e) { if (!String(e).includes('PI099 test blocked non-loopback host')) throw e; }"],
            cwd=home, env=env, capture_output=True, text=True, timeout=15)
        assert probe.returncode == 0, 'loopback guard selfcheck failed'
        assert json.loads((root / 'network-selfcheck.jsonl').read_text()) == {'blockedHost': 'example.com'}
        env['PI099_NETWORK_LOG'] = str(root / 'network-run.jsonl')
        with (out / 'run.log').open('wb') as log:
            run = subprocess.run(['node', str(copy)], cwd=root / 'workspace', env=env, stdout=log, stderr=subprocess.STDOUT, timeout=150)
        attempts = [json.loads(line) for line in (root / 'network-run.jsonl').read_text().splitlines()] if (root / 'network-run.jsonl').exists() else []
        (out / 'provider-result.json').write_text(json.dumps({'exitCode': run.returncode, 'providerRequests': provider_requests,
            'blockedNonLoopbackAttempts': attempts, 'networkGuardSelfcheck': 'passed', 'productionAuthUsed': False,
            'isolation': 'temporary HOME/agentDir/workspace; allowlisted env; fresh browsers; owned loopback gateway and provider; copied harness',
            'limitation': 'Node loopback guard is not an OS sandbox. Original Root/list and optionally explicit selection/persisted history only, not composer/send/chat/paid provider/physical phone.', 'navigationMode': args.navigation}, indent=2) + '\n')
        print('Artifacts:', out)
        assert run.returncode == 0, f'original Root browser failed; inspect {out / "run.log"}'
        assert not provider_requests and not attempts, 'readonly Root emitted provider or external network request'
    finally:
        provider.shutdown()
        provider.server_close()
