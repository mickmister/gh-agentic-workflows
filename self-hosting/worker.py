"""A run-owned native Gas City session launches the OpenCode conversation worker."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time


def run():
    assert not Path('/var/run/docker.sock').exists(), 'Workload must not receive VM Docker socket'
    base = Path('/workspace/pilot-run')
    base.mkdir(parents=True, exist_ok=False)
    home = base / 'home'
    home.mkdir(mode=0o700)
    city = base / 'city'
    city.mkdir()
    env = {**os.environ, 'HOME': str(home), 'GC_HOME': str(base / 'gc-home'), 'GC_BEADS': 'file', 'GC_SESSION': 'tmux'}
    Path(env['GC_HOME']).mkdir()
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    Path(env['GC_HOME'], 'supervisor.toml').write_text(f'[supervisor]\nport = {port}\n')
    q = json.dumps
    config = base / 'city.toml'
    config.write_text(f'''[workspace]
name = "self-hosted-thread"
install_agent_hooks = []
[workspace.env]
PATH = {q(env['PATH'])}
HOME = {q(str(home))}
PILOT_WORKSPACE = {q(os.environ['PILOT_WORKSPACE'])}
PILOT_THREAD = {q(os.environ['PILOT_THREAD'])}
PILOT_GATEWAY = {q(os.environ.get('PILOT_GATEWAY', 'http://gateway:8080'))}
PILOT_WORKER_TOKEN = {q(os.environ['PILOT_WORKER_TOKEN'])}
PILOT_RUN = {q(os.environ.get('GITHUB_RUN_ID', os.environ.get('GITEA_RUN_ID', 'manual')))}
[beads]
provider = "file"
[session]
provider = "tmux"
[daemon]
patrol_interval = "1s"
[providers.opencode-thread]
base = ""
command = {q(sys.executable)}
args = ["/opt/pilot/turn.py"]
prompt_mode = "arg"
[[agent]]
name = "conversation"
provider = "opencode-thread"
work_dir = {q(str(base))}
lifecycle = "one_shot"
attach = false
max_active_sessions = 1
''')
    config.chmod(0o600)

    def gc(*args):
        with (base / 'gc-command.log').open('wb') as errors:
            return subprocess.check_output(['gc', *args], cwd=city, env={**env, 'PWD': str(city)}, stderr=errors)

    gc('init', '--file', str(config), '--name', 'self-hosted-thread', '--no-start', '--skip-provider-readiness', str(city))
    Path(env['GC_HOME'], 'cities.toml').write_text(f'[[cities]]\npath = {q(str(city))}\nname = "self-hosted-thread"\n')
    with (base / 'gc.log').open('wb') as log:
        supervisor = subprocess.Popen(['gc', 'supervisor', 'run'], cwd=city, env={**env, 'PWD': str(city)}, stdout=log, stderr=log)
        try:
            for _ in range(60):
                if supervisor.poll() is not None:
                    raise RuntimeError('Gas City supervisor failed')
                try:
                    if json.loads(gc('supervisor', 'status', '--json')).get('running'):
                        break
                except subprocess.CalledProcessError:
                    pass
                time.sleep(.5)
            else:
                raise RuntimeError('Gas City startup failed')
            identity = json.loads(gc('session', 'new', 'conversation', '--title', 'Self-hosted thread', '--no-attach', '--json'))
            assert identity.get('ok') and identity.get('session_id')
            result = base / 'result.json'
            while not result.exists():
                if supervisor.poll() is not None:
                    raise RuntimeError('Gas City exited before native outcome')
                time.sleep(.25)
            outcome = json.loads(result.read_text())
            assert outcome['gc_session_id'] == identity['session_id'], 'Native worker ownership mismatch'
            if not outcome['ok']:
                raise RuntimeError('Native turn failed; thread retained for explicit recovery')
            print(json.dumps({'ok': True, 'gc_session_id': identity['session_id'], 'outcome': outcome.get('outcome')}))
        finally:
            try:
                gc('stop', str(city))
            finally:
                supervisor.terminate()
                try:
                    supervisor.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    supervisor.kill()
                    supervisor.wait()


if __name__ == '__main__':
    run()
