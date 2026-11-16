"""Sandbox-only acceptance fixture, started by the original dev_service tool."""
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlsplit


HTML = b'''<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>010 sandbox service</title><link rel="stylesheet" href="/style.css">
<h1>010 sandbox service</h1><p id="local">JavaScript pending</p>
<button id="increment">Call backend</button><pre id="result">GET pending</pre>
<script src="/app.js"></script></html>'''
SCRIPT = b'''document.querySelector('#local').textContent = 'JavaScript ready';
let clicks = 0;
const render = async (method) => {
  const reply = await fetch('/api/counter', method === 'POST'
    ? {method, headers: {'content-type': 'application/json'}, body: JSON.stringify({increment: 1})}
    : {method});
  if (!reply.ok) throw new Error('Backend refused');
  document.querySelector('#result').textContent = JSON.stringify(await reply.json());
};
document.querySelector('#increment').addEventListener('click', async () => {
  document.querySelector('#local').textContent = 'Clicked ' + (++clicks);
  try { await render('POST'); } catch (_) { document.querySelector('#result').textContent = 'Backend error'; }
});
render('GET').catch(() => { document.querySelector('#result').textContent = 'Backend error'; });'''
CSS = b'body{font:18px system-ui;padding:24px;background:#eef6ff;color:#183049}button{padding:12px}pre{white-space:pre-wrap}'
counter = 0
requests = 0


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, content_type, body):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def snapshot(self):
        forbidden = ('Cookie', 'Authorization', 'OPEN-SANDBOX-API-KEY',
                     'X-EXECD-ACCESS-TOKEN', 'X-Agent-Token', 'X-PE-Account', 'X-PE-Generation')
        return json.dumps({'marker': '010-real-sandbox-backend', 'counter': counter,
                           'requests': requests,
                           'platformCredentialsPresent': any(name in self.headers for name in forbidden)},
                          separators=(',', ':')).encode()

    def do_GET(self):
        global requests
        requests += 1
        route = urlsplit(self.path).path
        if route == '/':
            self.reply(200, 'text/html; charset=utf-8', HTML)
        elif route == '/app.js':
            self.reply(200, 'text/javascript; charset=utf-8', SCRIPT)
        elif route == '/style.css':
            self.reply(200, 'text/css; charset=utf-8', CSS)
        elif route == '/api/counter':
            self.reply(200, 'application/json', self.snapshot())
        else:
            self.reply(404, 'text/plain', b'Not found')

    def do_POST(self):
        global counter, requests
        requests += 1
        if self.path != '/api/counter':
            self.reply(404, 'text/plain', b'Not found')
            return
        length = int(self.headers.get('Content-Length', '0'))
        if not 0 < length <= 256:
            self.reply(413, 'text/plain', b'Body refused')
            return
        try:
            value = json.loads(self.rfile.read(length))
            if value != {'increment': 1}:
                raise ValueError()
        except (ValueError, UnicodeError):
            self.reply(400, 'text/plain', b'Invalid request')
            return
        counter += 1
        self.reply(200, 'application/json', self.snapshot())


if __name__ == '__main__':
    HTTPServer(('0.0.0.0', 8000), Handler).serve_forever()
