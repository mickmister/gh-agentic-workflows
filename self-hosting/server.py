"""Personal-pilot admission, conditional state IO and response delivery.

Gitea owns CI jobs, Gas City owns native work sessions, OpenCode owns reasoning.
No daemon socket, semantic router, setup selector or model lives in this service.
"""
import copy
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import time
import urllib.parse
import uuid
from storage import Store, encoded, identifier, secret, thread_key
import forge


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # Native/raw payloads and credentials never go to public CI logs.

    def send(self, status, value, content_type='application/json'):
        data = encoded(value) if content_type == 'application/json' else value
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(data)

    def authorized(self, worker=False):
        expected = secret('worker_token' if worker else 'app_token')
        return bool(expected) and hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + expected)

    def body(self):
        size = int(self.headers.get('Content-Length', '0'))
        limit = 90 * 1024 * 1024 if self.path in ('/internal/blob', '/internal/publish') else 1024 * 1024
        if not 0 < size <= limit:
            raise ValueError('Request size is invalid')
        return json.loads(self.rfile.read(size))

    def do_GET(self):
        try:
            store = Store()
            path = urllib.parse.urlsplit(self.path)
            host = self.headers.get('Host', '').split(':')[0].lower()
            if path.path == '/healthz':
                return self.send(200, {'ready': True})
            if path.path == '/tls-allow':
                domain = urllib.parse.parse_qs(path.query).get('domain', [''])[0]
                suffix = '.' + os.environ['PAGES_DOMAIN']
                key = domain[:-len(suffix)] if domain.endswith(suffix) else ''
                if key.startswith('b-') and store.read('pilot/sites/' + identifier(key) + '.json')[0]:
                    return self.send(200, {'allowed': True})
                return self.send(403, {'allowed': False})
            if host.endswith('.' + os.environ['PAGES_DOMAIN']):
                key = identifier(host[:-len('.' + os.environ['PAGES_DOMAIN'])])
                ref, _ = store.read('pilot/sites/' + key + '.json')
                if ref is None:
                    return self.send(404, {'error': 'Unpublished branch'})
                manifest = json.loads(store.restore(ref))
                name = urllib.parse.unquote(path.path).lstrip('/') or 'index.html'
                if name.endswith('/'):
                    name += 'index.html'
                file = manifest['files'].get(name)
                if not file:
                    return self.send(404, {'error': 'Asset not found'})
                # Preview origins have no API access or app token handling.
                return self.send(200, store.restore(file), file['type'])
            if host != os.environ['APP_HOST'] and host not in ('gateway', 'localhost', '127.0.0.1'):
                return self.send(404, {'error': 'Unknown host'})
            if path.path == '/':
                return self.send(200, (Path(__file__).parent / 'web/index.html').read_bytes(), 'text/html; charset=utf-8')
            if path.path == '/api/thread' and self.authorized():
                query = urllib.parse.parse_qs(path.query)
                value, _ = store.read(thread_key(query['workspace'][0], query['thread'][0]))
                if value is None:
                    return self.send(404, {'error': 'Thread not found'})
                public = copy.deepcopy(value)
                public.pop('checkpoint', None)
                return self.send(200, public)
            if path.path == '/api/threads' and self.authorized():
                query = urllib.parse.parse_qs(path.query)
                workspace = identifier(query['workspace'][0])
                prefix = f'pilot/workspaces/{workspace}/threads/'
                listing = store.s3.list_objects_v2(Bucket=store.bucket, Prefix=prefix, MaxKeys=100)
                return self.send(200, {'threads': [x['Key'][len(prefix):-5] for x in listing.get('Contents', [])],
                                       'next': listing.get('NextContinuationToken')})
            return self.send(401, {'error': 'Authorization required'})
        except (ValueError, KeyError):
            return self.send(400, {'error': 'Invalid request'})
        except Exception:
            return self.send(503, {'error': 'Storage unavailable; no empty-state fallback'})

    def do_POST(self):
        try:
            path = urllib.parse.urlsplit(self.path).path
            worker = path.startswith('/internal/')
            # Do not allow a preview origin to use a stolen browser ambient cookie:
            # auth is explicit Bearer; reject cross-origin browser mutations too.
            origin = self.headers.get('Origin')
            if origin and origin != 'https://' + os.environ['APP_HOST']:
                return self.send(403, {'error': 'Origin denied'})
            if not self.authorized(worker):
                return self.send(401, {'error': 'Authorization required'})
            body = self.body()
            store = Store()
            workspace, thread = identifier(body['workspace']), identifier(body['thread'])
            key = thread_key(workspace, thread)
            if path == '/internal/publish':
                import base64
                import tempfile
                from publish import publish
                repository = body['repository']
                if repository != os.environ['SOURCE_REPOSITORY']:
                    raise ValueError('Publication repository is not bound to this installation')
                head = forge.api(f'repos/{repository}/branches/' + urllib.parse.quote(body['branch'], safe=''))
                if head['commit']['id'] != body['sha']:
                    raise ValueError('Source branch moved; stale build refused')
                with tempfile.TemporaryDirectory() as directory:
                    total = 0
                    for name, content in body['files'].items():
                        candidate = Path(name)
                        if candidate.is_absolute() or '..' in candidate.parts or '.git' in candidate.parts:
                            raise ValueError('Invalid static asset path')
                        data = base64.b64decode(content, validate=True)
                        total += len(data)
                        if total > 24 * 1024 * 1024:
                            raise ValueError('Static payload exceeds limit')
                        target = Path(directory) / candidate
                        target.parent.mkdir(parents=True, exist_ok=True)
                        target.write_bytes(data)
                    result = publish(store, directory, repository, body['branch'], body['sha'], os.environ['PAGES_DOMAIN'])
                return self.send(200, result)
            if path == '/api/create':
                state = {'workspace': workspace, 'thread': thread, 'messages': [], 'active': None,
                         'checkpoint': None, 'status': 'idle', 'created': time.time()}
                store.put(key, state)
                return self.send(201, {'thread': thread})
            if path == '/api/submit':
                request = identifier(body['request'])
                text = body['text']
                if not isinstance(text, str) or not 0 < len(text) <= 32000:
                    raise ValueError('Invalid text')

                def admit(state):
                    if state is None:
                        raise ValueError('Create thread first')
                    previous = next((m for m in state['messages'] if m['id'] == request), None)
                    if previous:
                        if previous['text'] != text:
                            raise ValueError('Request ID reused with changed input')
                    else:
                        if len(state['messages']) >= 200:
                            raise ValueError('Pilot thread limit reached; archive before continuing')
                        state['messages'].append({'id': request, 'text': text, 'saved': time.time(), 'status': 'queued', 'reply': ''})
                    return state['active'] is None and any(m['status'] == 'queued' for m in state['messages'])

                dispatch_needed = store.mutate(key, admit)
                if dispatch_needed:
                    try:
                        forge.dispatch(workspace, thread)
                    except Exception:
                        return self.send(202, {'saved': True, 'dispatched': False, 'retry': 'Submit the same request ID again'})
                return self.send(202, {'saved': True, 'dispatched': dispatch_needed})
            if path == '/api/interrupt':
                def interrupt(state):
                    if not state or not state['active']:
                        raise ValueError('No active turn')
                    state['interrupt'] = state['active']['request']
                store.mutate(key, interrupt)
                return self.send(202, {'interrupt_requested': True})
            if path == '/api/recover':
                # A dead run retains its claim. Require verified terminal CI state
                # before clearing it; never steal ownership on a guessed timeout.
                state, _ = store.read(key)
                if not state or not state['active'] or not forge.run_is_terminal(state['active']['run']):
                    raise ValueError('Recorded run is not terminal; recovery denied')
                owner = state['active']['owner']
                def recover(current):
                    if not current['active'] or current['active']['owner'] != owner:
                        raise ValueError('Ownership changed')
                    current['active'] = None
                    current['status'] = 'recovery_required'
                    # Unknown partial effects are not automatically retried.
                    for message in current['messages']:
                        if message['status'] == 'working':
                            message['status'] = 'interrupted_uncheckpointed'
                store.mutate(key, recover)
                return self.send(200, {'recovered_to_last_checkpoint': True, 'prior_effects_require_reconciliation': True})
            if path == '/internal/claim':
                run = str(body['run'])
                owner = str(uuid.uuid4())
                def claim(state):
                    if not state or state['active']:
                        return None
                    message = next((m for m in state['messages'] if m['status'] == 'queued'), None)
                    if message is None:
                        return None
                    state['active'] = {'owner': owner, 'run': run, 'request': message['id']}
                    state['status'] = 'working'
                    message['status'] = 'working'
                    message['run'] = run
                    return {'owner': owner, 'message': message, 'checkpoint': state['checkpoint']}
                result = store.mutate(key, claim)
                if result:
                    result.update(source={'url': os.environ['GITEA_URL'] + '/' + os.environ['SOURCE_REPOSITORY'] + '.git',
                                          'ref': os.environ['SOURCE_REF'], 'token': secret('source_token')},
                                  inference={'baseURL': os.environ['INFERENCE_BASE_URL'], 'model': os.environ['INFERENCE_MODEL'],
                                             'apiKey': secret('inference_key')})
                return self.send(200, result)
            if path == '/internal/poll':
                state, _ = store.read(key)
                if not state or not state['active'] or state['active']['owner'] != body['owner']:
                    raise ValueError('Wrong run owner')
                return self.send(200, {'interrupt': state.get('interrupt') == state['active']['request']})
            if path == '/internal/update':
                def update(state):
                    if not state or not state['active'] or state['active']['owner'] != body['owner']:
                        raise ValueError('Wrong run owner')
                    message = next(m for m in state['messages'] if m['id'] == state['active']['request'])
                    if 'reply' in body:
                        message['reply'] = body['reply'][:128000]
                        if message['reply'] and 'first_reply' not in message:
                            message['first_reply'] = time.time()
                    if 'checkpoint' in body:
                        # Bytes are independently verified before advancing authority.
                        checkpoint = body['checkpoint']
                        store.restore(checkpoint['native'])
                        state['checkpoint'] = checkpoint
                    if body.get('finished'):
                        message['status'] = body.get('status', 'completed')
                        message['finished'] = time.time()
                        message['timings'] = body.get('timings', {})
                        state['active'] = None
                        state['status'] = message['status']
                        state.pop('interrupt', None)
                store.mutate(key, update)
                return self.send(200, {'saved': True})
            if path == '/internal/blob':
                import base64
                return self.send(200, store.blob(base64.b64decode(body['data'], validate=True)))
            if path == '/internal/restore':
                import base64
                # Only restore the current thread's bound checkpoint.
                state, _ = store.read(key)
                if not state['active'] or state['active']['owner'] != body['owner']:
                    raise ValueError('Wrong run owner')
                return self.send(200, {'data': base64.b64encode(store.restore(state['checkpoint']['native'])).decode()})
            return self.send(404, {'error': 'Unknown operation'})
        except (ValueError, KeyError, StopIteration):
            return self.send(400, {'error': 'Invalid request or ownership conflict'})
        except Exception:
            return self.send(503, {'error': 'Operation failed; retained state requires reconciliation'})


if __name__ == '__main__':
    ThreadingHTTPServer(('0.0.0.0', 8080), Handler).serve_forever()
