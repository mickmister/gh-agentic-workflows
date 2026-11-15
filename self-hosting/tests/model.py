"""Deterministic streaming provider, used only by the opt-in local smoke profile.

Exercises real native read tools, history preservation and interrupt transport.
Never substitute these timings for a real inference-provider benchmark.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import time


class Model(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        messages = body['messages']
        last = messages[-1]
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        def emit(delta, finish=None):
            event = {'id': 'fixture', 'object': 'chat.completion.chunk', 'created': 1, 'model': body['model'],
                     'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
            self.wfile.write(('data: ' + json.dumps(event) + '\n\n').encode())
            self.wfile.flush()
        try:
            user = next(m for m in reversed(messages) if m['role'] == 'user')
            text = json.dumps(user['content'])
            if 'interrupt' in text:
                for n in range(120):
                    emit({'content': f'working-{n} '})
                    time.sleep(.25)
                emit({}, 'stop')
            elif last['role'] != 'tool':
                emit({'role': 'assistant', 'tool_calls': [{'index': 0, 'id': 'call_read', 'type': 'function',
                      'function': {'name': 'read', 'arguments': json.dumps({'filePath': '/workspace/pilot-run/source/README.md'})}}]})
                emit({}, 'tool_calls')
            else:
                users = sum(m['role'] == 'user' for m in messages)
                emit({'role': 'assistant', 'content': f'Source inspected; history has {users} user messages. ' + str(last['content'])[:200]})
                emit({}, 'stop')
            self.wfile.write(b'data: [DONE]\n\n')
        except (BrokenPipeError, ConnectionResetError):
            pass


ThreadingHTTPServer(('0.0.0.0', 8090), Model).serve_forever()
