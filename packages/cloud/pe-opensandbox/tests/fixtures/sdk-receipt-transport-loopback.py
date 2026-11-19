"""Exercise the two real application processes against the existing private HTTP fixture."""
import argparse
from contextlib import contextmanager
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import runpy
import subprocess
from threading import Thread


@contextmanager
def discard_first_response(upstream_port, auth, expected_path):
    observations = []

    class Proxy(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, *_args):
            pass

        def do_POST(self):
            if self.path != expected_path:
                self.send_error(400)
                return
            length = int(self.headers.get('content-length', '0'))
            if not 0 < length <= auth.max_body:
                self.send_error(400)
                return
            request = self.rfile.read(length)
            connection = HTTPConnection('127.0.0.1', upstream_port, timeout=4)
            try:
                connection.request('POST', self.path, request, {
                    auth.header: self.headers[auth.header], 'Content-Type': 'application/json',
                })
                response = connection.getresponse()
                body = response.read()
                observations.append((self.path, request, response.status, body))
                if len(observations) == 1:
                    self.close_connection = True
                    return
                self.send_response(response.status)
                self.send_header('Content-Type', response.getheader('Content-Type'))
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                self.wfile.write(body)
            finally:
                connection.close()

    with ThreadingHTTPServer(('127.0.0.1', 0), Proxy) as proxy:
        worker = Thread(target=proxy.serve_forever, kwargs={'poll_interval': 0.05})
        worker.start()
        try:
            yield proxy.server_port, observations
        finally:
            proxy.shutdown()
            worker.join(timeout=4)
            assert not worker.is_alive()


def main(wheel, node):
    fixtures = Path(__file__).resolve().parent
    original_http = runpy.run_path(str(fixtures.parent / 'test_deletion_ack_http.py'))
    test_class = original_http['DeletionAckHttp']
    auth = original_http['load_auth_and_route'](wheel)
    test_class.path.__globals__.update(WHEEL=wheel, AUTH=auth)
    http = test_class()
    http.setUp()
    try:
        scope = original_http['SCOPE'](1)
        receipt = http.receipts[1]
        intent_keys = ('allocationId', 'accountId', 'epoch', 'sessionId', 'workspaceId', 'environmentVersion',
                       'provider', 'projectMountVersion', 'requestedAt', 'createDeadlineAt')
        (http.work / 'incoming.json').write_text(json.dumps({'intent': dict(zip(intent_keys, scope)), 'receipt': receipt}))
        with http.server() as (sdk_pid, upstream_port):
            with discard_first_response(upstream_port, auth, http.path()) as (port, observations):
                runs = []
                for phase in ['lost', 'restart']:
                    run = subprocess.run([node, '--experimental-transform-types', str(fixtures / 'sdk-receipt-transport-app.mjs'),
                                          phase, str(http.work), str(port)], capture_output=True, text=True, timeout=8)
                    if run.returncode != 0:
                        raise RuntimeError(run.stderr)
                    runs.append(json.loads(run.stdout))
                    if phase == 'lost':
                        assert len(observations) == 1, 'no implicit replay after loss'
                        assert observations[0][2] == 200, 'original server persisted the first ACK before dropping the reply'
                        assert not (http.root / (receipt['sandboxId'] + '.json')).exists()
                assert runs[0]['pid'] != runs[1]['pid']
                assert [run['ack'] for run in runs] == ['pending', 'acknowledged']
                assert len(observations) == 2 and observations[0] == observations[1]
                _, raw, status, acknowledged = observations[1]
                assert status == 200 and json.loads(acknowledged) == receipt
                assert json.loads(raw) == {'scope': scope, 'receipt': receipt}
                print(f'Original SDK PID {sdk_pid}, Node application PIDs {[r["pid"] for r in runs]}')
                print('Real POST committed, wire reply dropped, application restarted, exactly one same-body replay')
    finally:
        http.doCleanups()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--wheel', type=Path, required=True)
    parser.add_argument('--node', required=True)
    args = parser.parse_args()
    main(args.wheel.resolve(), args.node)
