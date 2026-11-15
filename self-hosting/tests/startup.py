"""Content-free native server startup profile, no provider request/credentials."""
import os
import json
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.request

with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    config = root / 'opencode.json'
    config.write_text(json.dumps({'$schema': 'https://opencode.ai/config.json', 'plugin': [], 'mcp': {},
        'autoupdate': False, 'lsp': False, 'formatter': False, 'snapshot': False, 'enabled_providers': ['pilot'],
        'model': 'pilot/fixture', 'small_model': 'pilot/fixture', 'default_agent': 'conversation',
        'permission': {'*': 'deny', 'read': 'allow', 'grep': 'allow', 'glob': 'allow', 'list': 'allow'},
        'agent': {'conversation': {'mode': 'primary', 'model': 'pilot/fixture', 'prompt': 'Read source.'}},
        'provider': {'pilot': {'npm': '@ai-sdk/openai-compatible',
           'options': {'baseURL': '{env:INFERENCE_BASE_URL}', 'apiKey': '{env:INFERENCE_API_KEY}'},
           'models': {'fixture': {'id': 'fixture', 'name': 'fixture', 'tool_call': True,
                                 'limit': {'context': 32768, 'output': 8192}}}}}}))
    env = {'PATH': os.environ['PATH'], 'HOME': directory, 'PWD': directory, 'XDG_DATA_HOME': str(root / 'data'),
           'XDG_CONFIG_HOME': str(root / 'config'), 'XDG_CACHE_HOME': str(root / 'cache'),
           'OPENCODE_CONFIG': str(config), 'OPENCODE_PURE': '1', 'OPENCODE_DISABLE_MODELS_FETCH': '1',
           'OPENCODE_DISABLE_DEFAULT_PLUGINS': '1', 'OPENCODE_DISABLE_PROJECT_CONFIG': '1',
           'OPENCODE_DISABLE_EXTERNAL_SKILLS': '1', 'OPENCODE_DISABLE_CLAUDE_CODE_SKILLS': '1',
           'INFERENCE_BASE_URL': 'http://127.0.0.1:1/v1', 'INFERENCE_API_KEY': 'fixture'}
    subprocess.run(['git', 'init', '--quiet', str(root)], check=True)
    subprocess.run(['git', '-C', str(root), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                    'commit', '--quiet', '--allow-empty', '-m', 'fixture'], check=True)
    with (root / 'log').open('wb') as log:
        started = time.monotonic()
        process = subprocess.Popen(['opencode', 'serve', '--pure', '--port', '18199', '--print-logs'],
                                   cwd=root, env=env, stdout=log, stderr=log)
        try:
            while time.monotonic() - started < 60:
                try:
                    print(urllib.request.urlopen('http://127.0.0.1:18199/global/health', timeout=1).read().decode())
                    print('health_ready_s', time.monotonic() - started)
                    request = urllib.request.Request('http://127.0.0.1:18199/session', data=b'{"title":"startup-profile"}', headers={'Content-Type': 'application/json'})
                    print('session', urllib.request.urlopen(request, timeout=60).status)
                    print('session_ready_s', time.monotonic() - started)
                    break
                except Exception:
                    time.sleep(.1)
            print((root / 'log').read_text())
        finally:
            process.terminate()
            process.wait()
