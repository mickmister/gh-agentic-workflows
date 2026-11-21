"""Native OpenCode IO: explicit session import, prompt, text projection, abort, export.

No setup-planning turn or full workspace database restore is needed to read source.
This first pilot grants source read/search, not source mutations or deployment.
"""
import base64
import json
import os
from pathlib import Path
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request


BASE = Path('/workspace/pilot-run')


def rpc(path, body):
    payload = {'workspace': os.environ['PILOT_WORKSPACE'], 'thread': os.environ['PILOT_THREAD'], **body}
    request = urllib.request.Request(os.environ.get('PILOT_GATEWAY', 'http://gateway:8080') + '/internal/' + path,
                                     data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json',
                                     'Authorization': 'Bearer ' + os.environ['PILOT_WORKER_TOKEN']})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def native(base_url, path, body=None, timeout=30):
    request = urllib.request.Request(base_url + path, data=json.dumps(body).encode() if body is not None else None,
                                     headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        data = response.read()
        return json.loads(data) if data else None


def work():
    started = time.monotonic()
    claim = rpc('claim', {'run': os.environ['PILOT_RUN']})
    if not claim:
        return 'duplicate_or_empty'
    owner = claim['owner']
    source = BASE / 'source'
    authorization = base64.b64encode(('pilot-admin:' + claim['source'].pop('token')).encode()).decode()
    clone_env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0', 'GIT_CONFIG_COUNT': '1',
                 'GIT_CONFIG_KEY_0': 'http.' + claim['source']['url'] + '.extraheader',
                 'GIT_CONFIG_VALUE_0': 'AUTHORIZATION: basic ' + authorization}
    subprocess.run(['git', 'clone', '--quiet', '--branch', claim['source']['ref'], '--single-branch',
                    claim['source']['url'], str(source)], env=clone_env, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    sha = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD']).decode().strip()
    source_ready = time.monotonic() - started
    config = BASE / 'opencode.json'
    model = claim['inference']['model']
    config.write_text(json.dumps({
        '$schema': 'https://opencode.ai/config.json', 'model': 'pilot/' + model, 'small_model': 'pilot/' + model,
        'default_agent': 'conversation', 'enabled_providers': ['pilot'], 'share': 'disabled',
        'autoupdate': False, 'snapshot': False, 'formatter': False, 'lsp': False, 'plugin': [], 'mcp': {},
        'permission': {'*': 'deny', 'read': 'allow', 'grep': 'allow', 'glob': 'allow', 'list': 'allow'},
        'agent': {'conversation': {'mode': 'primary', 'model': 'pilot/' + model,
                   'prompt': 'Answer the user using the available repository. Read/search source as needed. This pilot is read-only; do not modify source. Do not claim tests or actions you have not performed.'}},
        'provider': {'pilot': {'npm': '@ai-sdk/openai-compatible', 'options': {
            'baseURL': '{env:INFERENCE_BASE_URL}', 'apiKey': '{env:INFERENCE_API_KEY}'},
            'models': {model: {'id': model, 'name': model, 'tool_call': True,
                                'limit': {'context': 32768, 'output': 8192}}}}}}))
    config.chmod(0o600)
    home = BASE / 'native-home'
    home.mkdir(mode=0o700)
    env = {key: value for key, value in os.environ.items() if key in ('PATH', 'LANG', 'TERM')}
    env.update(HOME=str(home), PWD=str(source), XDG_CONFIG_HOME=str(home / '.config'),
               XDG_DATA_HOME=str(home / '.local/share'), XDG_CACHE_HOME=str(home / '.cache'),
               XDG_STATE_HOME=str(home / '.local/state'), OPENCODE_CONFIG=str(config), OPENCODE_PURE='1',
               OPENCODE_DISABLE_DEFAULT_PLUGINS='1', OPENCODE_DISABLE_PROJECT_CONFIG='1',
               OPENCODE_DISABLE_EXTERNAL_SKILLS='1', OPENCODE_DISABLE_CLAUDE_CODE_SKILLS='1',
               OPENCODE_DISABLE_MODELS_FETCH='1', INFERENCE_BASE_URL=claim['inference']['baseURL'],
               INFERENCE_API_KEY=claim['inference']['apiKey'])
    session = None
    if claim['checkpoint']:
        previous = claim['checkpoint']
        assert previous['runtime'] == 'opencode-1.19.4', 'Unsupported runtime; explicit migration required'
        assert all(previous['source'][k] == claim['source'][k] for k in ('url', 'ref')), 'Source binding changed; explicit migration required'
        restored = rpc('restore', {'owner': owner})
        data = base64.b64decode(restored['data'])
        value = json.loads(data)
        session = previous['session']
        assert value['info']['id'] == session
        # Reapply current trusted permissions; never trust imported policy.
        value['info']['permission'] = []
        imported = BASE / 'import.json'
        imported.write_text(json.dumps(value))
        imported.chmod(0o600)
        subprocess.run(['opencode', 'import', str(imported), '--pure'], cwd=source, env=env,
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    base_url = f'http://127.0.0.1:{port}'
    with (BASE / 'native.log').open('wb') as log:
        server = subprocess.Popen(['opencode', 'serve', '--pure', '--hostname', '127.0.0.1', '--port', str(port), '--print-logs'],
                                   cwd=source, env=env, stdout=log, stderr=log)
        try:
            for _ in range(120):
                if server.poll() is not None:
                    raise RuntimeError('Native server exited')
                try:
                    native(base_url, '/global/health', timeout=1)
                    break
                except (urllib.error.URLError, TimeoutError):
                    time.sleep(.25)
            else:
                raise RuntimeError('Native server not ready')
            server_ready = time.monotonic() - started
            if session is None:
                session = native(base_url, '/session', {'title': os.environ['PILOT_THREAD']})['id']
            else:
                actual = native(base_url, f'/session/{session}')
                assert actual['directory'] == str(source), 'Restored session directory mismatch'
            runtime_ready = time.monotonic() - started
            message = claim['message']
            while True:
                before = {m['info']['id'] for m in native(base_url, f'/session/{session}/message')}
                # Native message-list reads may lag streamed text persistence.
                # Subscribe before prompting so useful text and interrupt controls
                # do not wait for turn completion.
                live = {'reply': '', 'first': None, 'error': None}
                subscribed = threading.Event()
                stop = threading.Event()
                def events(stop=stop, live=live, before=before, owner=owner, subscribed=subscribed):
                    parts = {}
                    roles = {}
                    try:
                        with urllib.request.urlopen(base_url + '/event', timeout=60) as stream:
                            subscribed.set()
                            for line in stream:
                                if stop.is_set():
                                    break
                                if not line.startswith(b'data: '):
                                    continue
                                event = json.loads(line[6:])
                                props = event.get('properties', {})
                                if event['type'] == 'message.updated':
                                    info = props.get('info', {})
                                    roles[info.get('id')] = info.get('role')
                                    continue
                                part = props.get('part', {})
                                if event['type'] == 'message.part.updated' and part.get('sessionID') == session and part.get('type') == 'text' and part.get('messageID') not in before and roles.get(part.get('messageID')) == 'assistant':
                                    parts[part['id']] = part.get('text', '')
                                elif event['type'] == 'message.part.delta' and props.get('sessionID') == session and props.get('messageID') not in before and props.get('field') == 'text' and roles.get(props.get('messageID')) == 'assistant':
                                    parts[props['partID']] = parts.get(props['partID'], '') + props.get('delta', '')
                                else:
                                    continue
                                text = '\n'.join(parts.values())
                                if text and text != live['reply']:
                                    live['reply'] = text
                                    live['first'] = live['first'] or time.monotonic() - started
                                    rpc('update', {'owner': owner, 'reply': text})
                    except Exception:
                        if not stop.is_set():
                            live['error'] = 'Native event stream disconnected'
                watcher = threading.Thread(target=events, daemon=True)
                watcher.start()
                if not subscribed.wait(10):
                    raise RuntimeError('Native event subscription failed')
                native(base_url, f'/session/{session}/prompt_async', {
                    'agent': 'conversation', 'model': {'providerID': 'pilot', 'modelID': model},
                    'parts': [{'type': 'text', 'text': 'Current source commit: ' + sha + '. Re-read affected source if earlier conversation described another revision.\n\n' + message['text']}]})
                reply = ''
                first_reply = None
                interrupted = False
                while True:
                    if server.poll() is not None:
                        raise RuntimeError('Native server exited during turn')
                    rows = native(base_url, f'/session/{session}/message')
                    assistants = [m for m in rows if m['info']['id'] not in before and m['info']['role'] == 'assistant']
                    text = '\n'.join(p['text'] for m in assistants for p in m.get('parts', []) if p.get('type') == 'text')
                    if text != reply:
                        reply = text
                        first_reply = first_reply or time.monotonic() - started
                        rpc('update', {'owner': owner, 'reply': reply})
                    if rpc('poll', {'owner': owner})['interrupt'] and not interrupted:
                        native(base_url, f'/session/{session}/abort', {})
                        interrupted = True
                    statuses = native(base_url, '/session/status')
                    idle = statuses.get(session, {}).get('type', 'idle') == 'idle'
                    if assistants and idle and all(m['info'].get('time', {}).get('completed') for m in assistants):
                        break
                    if interrupted and idle:
                        break
                    time.sleep(.4)
                errors = [m['info'].get('error') for m in assistants if m['info'].get('error')]
                stop.set()
                first_reply = live['first'] or first_reply
                reply = reply or live['reply']
                if errors and not interrupted:
                    raise RuntimeError('Native provider/tool turn failed')
                exported = BASE / 'native-export.json'
                # Regular-file output avoids native CLI truncation through pipes.
                with exported.open('wb') as stream:
                    subprocess.run(['opencode', 'export', session, '--pure'], cwd=source, env=env,
                                   stdout=stream, stderr=subprocess.DEVNULL, check=True)
                data = exported.read_bytes()
                parsed = json.loads(data)
                assert parsed['info']['id'] == session and parsed['messages']
                assert len(data) <= 64 * 1024 * 1024
                ref = rpc('blob', {'data': base64.b64encode(data).decode()})
                # Private bounded startup diagnostics support measured tuning;
                # explicitly remove only credentials used by this invocation.
                log.flush()
                diagnostics = (BASE / 'native.log').read_bytes()[-256 * 1024:]
                for credential in (claim['inference']['apiKey'], os.environ['PILOT_WORKER_TOKEN']):
                    if credential:
                        diagnostics = diagnostics.replace(credential.encode(), b'[REDACTED]')
                diagnostic_ref = rpc('blob', {'data': base64.b64encode(diagnostics).decode()})
                checkpoint = {'runtime': 'opencode-1.19.4', 'session': session, 'native': ref,
                              'diagnostics': diagnostic_ref,
                              'source': {k: claim['source'][k] for k in ('url', 'ref')}, 'last_request': message['id'],
                              'gc_session_id': os.environ['GC_SESSION_ID']}
                checkpoint['source']['sha'] = sha
                rpc('update', {'owner': owner, 'reply': reply, 'checkpoint': checkpoint, 'finished': True,
                               'status': 'interrupted' if interrupted else 'completed',
                               'timings': {'source_ready_s': source_ready, 'runtime_ready_s': runtime_ready,
                                           'server_ready_s': server_ready,
                                           'first_reply_s': first_reply, 'checkpoint_s': time.monotonic() - started}})
                # Each safe-boundary claim is conditional. Concurrent dispatches
                # can claim the next message, but never share this runtime.
                claim = rpc('claim', {'run': os.environ['PILOT_RUN']})
                if not claim:
                    return 'checkpoint_committed'
                owner, message = claim['owner'], claim['message']
        finally:
            server.terminate()
            try:
                server.wait(timeout=20)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()


if __name__ == '__main__':
    result = {'ok': False, 'gc_session_id': os.environ.get('GC_SESSION_ID')}
    try:
        result.update(ok=True, outcome=work())
    finally:
        destination = BASE / 'result.json'
        temporary = BASE / 'result.tmp'
        temporary.write_text(json.dumps(result))
        temporary.replace(destination)
