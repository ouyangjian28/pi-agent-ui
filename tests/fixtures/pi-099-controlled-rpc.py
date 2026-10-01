"""Actual candidate pi RPC with a loopback-only deterministic provider; no real auth."""
import json, pathlib, queue, subprocess, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPO = pathlib.Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix='pi099-controlled-') as home:
    root = pathlib.Path(home)
    fixture = root / 'owned-fixture.txt'
    fixture.write_text('owned fixture only\n')
    requests = []
    errors = []

    class MockProvider(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            requests.append({'path': self.path, 'model': payload.get('model')})
            call = len(requests)
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            if call == 2:
                delta = {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': 'owned-read', 'type': 'function', 'function': {'name': 'read', 'arguments': json.dumps({'path': str(fixture)})}}]}
                reason = 'tool_calls'
            else:
                delta = {'role': 'assistant', 'content': '候选运行时文本 ✓' if call == 1 else '已读临时样本 ✓'}
                reason = 'stop'
            if call > 3:
                errors.append('unexpected provider retry/request')
            for part, stop in [(delta, None), ({}, reason)]:
                event = {'id': 'fixture-completion', 'object': 'chat.completion.chunk', 'created': 1, 'model': 'fixture', 'choices': [{'index': 0, 'delta': part, 'finish_reason': stop}]}
                self.wfile.write(('data: ' + json.dumps(event, ensure_ascii=False) + '\n\n').encode())
            self.wfile.write(b'data: [DONE]\n\n')
            self.wfile.flush()

    server = ThreadingHTTPServer(('127.0.0.1', 0), MockProvider)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    agent = root / 'agent'
    agent.mkdir()
    (agent / 'models.json').write_text(json.dumps({'providers': {'ui-upgrade-test': {
        'baseUrl': f'http://127.0.0.1:{server.server_port}/v1', 'api': 'openai-completions',
        'apiKey': 'synthetic-fixture-not-a-credential', 'models': [{'id': 'fixture', 'name': 'Controlled fixture',
        'reasoning': False, 'input': ['text'], 'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0},
        'contextWindow': 128000, 'maxTokens': 512}]}}}))
    extension = root / 'owned-command.mjs'
    extension.write_text("export default function(pi) { pi.registerCommand('owned-handled', { description: 'Controlled non-model command', handler: async (_args, ctx) => { ctx.ui.notify('owned handled', 'info'); } }); }\n")
    env = {'PATH': '/home/yyj/.nvm/versions/node/v24.18.0/bin:/usr/bin:/bin', 'HOME': home, 'TMPDIR': home,
           'PI_CODING_AGENT_DIR': str(agent), 'PI_OFFLINE': '1', 'LANG': 'C.UTF-8'}
    actual_version = subprocess.check_output([str(REPO / 'node_modules/.bin/pi'), '--version'], cwd=home, env=env, timeout=20).decode().strip()
    assert actual_version == '0.99.2', f'Expected actual local pi 0.99.2, got {actual_version}'
    process = subprocess.Popen([str(REPO / 'node_modules/.bin/pi'), '--mode', 'rpc', '--no-session', '--offline',
        '--no-approve', '--no-extensions', '--no-context-files', '--no-skills', '--no-themes', '--no-prompt-templates',
        '--tools', 'read', '-e', str(extension), '--provider', 'ui-upgrade-test', '--model', 'fixture'],
        cwd=home, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    lines = queue.Queue()
    stderr = []
    threading.Thread(target=lambda: [lines.put(json.loads(line)) for line in process.stdout], daemon=True).start()
    threading.Thread(target=lambda: [stderr.append(line) for line in process.stderr], daemon=True).start()
    trace = []

    def send(identifier, command, **args):
        process.stdin.write((json.dumps({'id': identifier, 'type': command, **args}) + '\n').encode())
        process.stdin.flush()

    def receive_until(predicate, timeout=20):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            event = lines.get(timeout=deadline - time.monotonic())
            trace.append(event)
            if predicate(event):
                return event
        raise AssertionError('RPC event deadline')

    try:
        send('ready', 'get_state')
        response = receive_until(lambda e: e.get('id') == 'ready')
        assert response['success'] is True
        assert response['data']['model']['provider'] == 'ui-upgrade-test'
        for identifier, text in [('text', 'Controlled text probe'), ('tool', 'Controlled read probe')]:
            start = len(trace)
            send(identifier, 'prompt', message=text)
            receive_until(lambda e: e.get('type') == 'agent_settled')
            turn = trace[start:]
            ack = next(e for e in turn if e.get('type') == 'response' and e.get('id') == identifier)
            assert ack['success'] is True and ack['data']['disposition'] == 'started', ack
            assert any(e.get('type') == 'message_end' and e.get('message', {}).get('role') == 'assistant' for e in turn)
            updates = [e for e in turn if e.get('type') == 'message_update']
            assert updates and all('message' not in e and 'partial' not in e.get('assistantMessageEvent', {}) for e in updates)
            if identifier == 'tool':
                starts = [e for e in turn if e.get('type') == 'tool_execution_start']
                ends = [e for e in turn if e.get('type') == 'tool_execution_end']
                assert len(starts) == len(ends) == 1
                assert starts[0]['toolCallId'] == ends[0]['toolCallId'] == 'owned-read'
                assert ends[0].get('isError') is False
                assert 'owned fixture only' in json.dumps(ends[0]['result'])
        send('handled', 'prompt', message='/owned-handled')
        handled = receive_until(lambda e: e.get('type') == 'response' and e.get('id') == 'handled')
        assert handled['success'] is True and handled['data']['disposition'] == 'handled', handled
        send('state-after-handled', 'get_state')
        state = receive_until(lambda e: e.get('id') == 'state-after-handled')
        assert state['data']['isStreaming'] is False
        assert len(requests) == 3 and not errors
        process.stdin.close()
        exit_code = process.wait(timeout=10)
        assert exit_code == 0
        result = {'runtime': actual_version, 'isolation': 'temporary HOME/agentDir/cwd; allowlisted env; only controlled loopback provider',
            'checks': ['text delta/final/agent_settled', 'real read tool on owned temporary fixture', 'toolCallId correlation',
                       'explicit extension under --no-extensions', 'handled prompt disposition', 'EOF exit zero'],
            'providerRequests': len(requests), 'exitCode': exit_code, 'stderrLines': len(stderr),
            'limitation': 'Actual pi RPC only; not the application adapter, real provider auth, billing, cancellation or recovery acceptance.'}
        output = REPO / '.pi/upgrade-checks'
        (output / 'controlled-rpc-result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
        (output / 'controlled-rpc-trace.json').write_text(json.dumps(trace, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps(result, ensure_ascii=False))
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        server.shutdown()
        server.server_close()
