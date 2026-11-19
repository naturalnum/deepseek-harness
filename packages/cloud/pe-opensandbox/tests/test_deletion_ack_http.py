"""Loopback ACK integration against the original OpenSandbox 1.1.1 authentication middleware."""
import argparse
from contextlib import asynccontextmanager, contextmanager
import hashlib
from http.client import HTTPConnection
import json
from pathlib import Path
import runpy
import socket
import subprocess
import sys
from tempfile import TemporaryDirectory
import time
from types import ModuleType, SimpleNamespace
import unittest

from fastapi import FastAPI
import uvicorn

FIXTURE = runpy.run_path(str(Path(__file__).with_name('test_deletion_acknowledgement.py')))
PACKAGE = FIXTURE['PACKAGE']
KEY = FIXTURE['KEY']
SDK = FIXTURE['sdk']
ACK = FIXTURE['ack']
ID = FIXTURE['sid']
SCOPE = FIXTURE['scope']
WHEEL_SHA256 = '7da042ecd5cfdd38bd8a96ca92d28d02bd91af2c26e5250382dd7a21c4bf04b8'


def load_auth_and_route(wheel):
    assert hashlib.sha256(wheel.read_bytes()).hexdigest() == WHEEL_SHA256, 'unexpected SDK wheel'
    sys.path.insert(0, str(wheel))
    # AuthMiddleware is the actual wheel's module. Only config loading is replaced
    # so this test cannot select a real server config or Kubernetes dependencies.
    config = ModuleType('opensandbox_server.config')
    config.AppConfig = object
    def require_fixture_config():
        raise AssertionError('The fixture always supplies explicit synthetic config.')
    config.get_config = require_fixture_config
    sys.modules[config.__name__] = config
    from opensandbox_server.middleware.auth import AuthMiddleware, SANDBOX_API_KEY_HEADER
    from original_sdk_server_sources.deletion_ack_http import ACK_ROUTE, MAX_ACK_BODY_BYTES, install_private_deletion_ack
    return SimpleNamespace(middleware=AuthMiddleware, header=SANDBOX_API_KEY_HEADER, path=ACK_ROUTE,
                           max_body=MAX_ACK_BODY_BYTES, install=install_private_deletion_ack)


def fixture_app(owner, auth, *, middleware=True, tenant_provider=None):
    config = SimpleNamespace(server=SimpleNamespace(api_key=KEY.decode('ascii')))
    @asynccontextmanager
    async def lifespan(_app):
        try:
            yield
        finally:
            owner.close()
    app = FastAPI(lifespan=lifespan)
    app.state.config = config
    app.state.tenant_provider = tenant_provider
    service = SimpleNamespace(_deletion_records=owner, _deletion_view=owner.view, app_config=config)
    if middleware:
        app.add_middleware(auth.middleware, config=config, tenant_provider=tenant_provider)
    return app, service


def serve(wheel, root, fd):
    auth = load_auth_and_route(wheel)
    owner = FIXTURE['open_owner'](root)
    app, service = fixture_app(owner, auth)
    auth.install(app, service)
    @app.get('/health')
    async def healthy():
        return {'ready': True}
    with socket.socket(fileno=fd) as listener:
        assert listener.getsockname()[0] == '127.0.0.1'
        uvicorn.Server(uvicorn.Config(app, access_log=False, log_level='warning')).run(sockets=[listener])


class DeletionAckHttp(unittest.TestCase):
    def setUp(self):
        work = TemporaryDirectory(prefix='sdk-ack-http-', dir=PACKAGE)
        self.addCleanup(work.cleanup)
        self.work = Path(work.name) / 'work'
        self.work.mkdir(mode=0o700)
        self.root = self.work / 'deletion-completions'
        ACK.initialize_ack_domain(self.root, FIXTURE['GENERATION'], FIXTURE['POLICY'], uid=self.work.stat().st_uid)
        owner = FIXTURE['open_owner'](self.root)
        self.receipts = {}
        try:
            def remove(sandbox_id, *, expected_container_id):
                assert expected_container_id == f'{int(sandbox_id[-12:], 16):064x}'
            service = SimpleNamespace(_deletion_records=owner, _deletion_view=owner.view, _delete_sandbox_without_completion=remove)
            for index in [1, 2]:
                owner.reserve(FIXTURE['original'](index))
                owner.bind(ID(index), f'{index:064x}')
                SDK.finish_original_delete(service, ID(index))
                self.receipts[index] = owner.completed_receipt(KEY, ID(index), SCOPE(index))
        finally:
            owner.close()

    def payload(self, index, *, scope=None, receipt=None):
        return SDK.encode({'scope': SCOPE(index) if scope is None else scope,
                           'receipt': self.receipts[index] if receipt is None else receipt})

    def path(self, index=1):
        return AUTH.path.format(sandbox_id=ID(index))

    def request(self, port, *, method='POST', path=None, body=None, key=KEY, media='application/json'):
        connection = HTTPConnection('127.0.0.1', port, timeout=4)
        try:
            headers = {}
            if key is not None:
                headers[AUTH.header] = key.decode('ascii')
            if media is not None:
                headers['Content-Type'] = media
            connection.request(method, path or self.path(), body=body, headers=headers)
            response = connection.getresponse()
            raw = response.read()
            return response.status, response.getheader('Cache-Control'), raw
        finally:
            connection.close()

    def wait_for(self, observation):
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            try:
                value = observation()
                if value:
                    return value
            except OSError:
                pass
            time.sleep(0.025)
        self.fail('Timed out observing the private fixture.')

    @contextmanager
    def server(self):
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            listener.listen(16)
            fd = listener.fileno()
            process = subprocess.Popen([sys.executable, '-I', '-B', __file__, '--wheel', str(WHEEL),
                                        '--serve', str(self.root), '--socket-fd', str(fd)],
                                       pass_fds=(fd,), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            port = listener.getsockname()[1]
        try:
            self.wait_for(lambda: self.request(port, path='/health', method='GET', key=None)[0] == 200)
            yield process.pid, port
        finally:
            if process.poll() is None:
                process.terminate()
            try:
                _, errors = process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                _, errors = process.communicate(timeout=5)
            if process.returncode not in (0, -15):
                self.fail(errors.decode('utf-8', errors='replace'))

    def test_startup_requires_original_single_tenant_auth_and_owner(self):
        owner = FIXTURE['open_owner'](self.root)
        try:
            for kwargs in ({'middleware': False}, {'tenant_provider': object()}):
                with self.subTest(kwargs=kwargs):
                    app, service = fixture_app(owner, AUTH, **kwargs)
                    with self.assertRaisesRegex(SDK.CompletionUnknown, 'ack-http-auth-owner'):
                        AUTH.install(app, service)
            app, service = fixture_app(owner, AUTH)
            with self.assertRaisesRegex(SDK.CompletionUnknown, 'ack-http-owner'):
                AUTH.install(app, SimpleNamespace())
            with self.assertRaisesRegex(SDK.CompletionUnknown, 'ack-http-owner'):
                AUTH.install(app, SimpleNamespace(_deletion_records=owner, _deletion_view=object()))
            AUTH.install(app, service)
            with self.assertRaisesRegex(SDK.CompletionUnknown, 'ack-http-registered'):
                AUTH.install(app, service)
        finally:
            owner.close()

    def test_real_auth_and_invalid_or_cross_scope_requests_preserve_both_originals(self):
        with self.server() as (_, port):
            evidence = self.payload(1)
            for key, upstream in [(None, 'MISSING_API_KEY'), (b'wrong-key', 'INVALID_API_KEY')]:
                status, _, raw = self.request(port, key=key, body=evidence)
                self.assertEqual((status, json.loads(raw)['code']), (401, upstream))
            for path, body, info in [
                (self.path(2), evidence, 400),
                (self.path() + '?archive=another', evidence, 400),
                (self.path(), self.payload(1, scope=SCOPE(2)), 409),
                (self.path(), self.payload(1, receipt={**self.receipts[1], 'containerId': 'f' * 64}), 409),
                (self.path(), self.payload(1, receipt={**self.receipts[1], 'providerGeneration': 'f' * 64}), 409),
                (self.path(), self.payload(1, receipt={**self.receipts[1], 'receiptDigest': 'f' * 64}), 409),
                (self.path(), b'{"scope":[],"scope":[]}', 400),
                (self.path(), evidence.decode('ascii').encode('utf-16'), 400),
                (self.path(), b' ' * (AUTH.max_body + 1), 413),
            ]:
                with self.subTest(path=path, status=info):
                    self.assertEqual(self.request(port, path=path, body=body)[0], info)
            self.assertEqual(self.request(port, body=evidence, media='text/plain')[0], 415)
            self.assertEqual(self.request(port, path=self.path().removeprefix('/v1'), body=evidence)[0], 404)
            schema = json.loads(self.request(port, method='GET', path='/openapi.json', key=None)[2])
            self.assertNotIn(AUTH.path, schema['paths'])
            for index in (1, 2):
                self.assertTrue((self.root / (ID(index) + '.json')).exists())
            self.assertEqual(SDK.decode((self.work / 'deletion-acknowledgements/index.json').read_bytes())['receipts'], {})

    def test_duplicate_auth_header_and_slow_body_are_refused(self):
        with self.server() as (_, port):
            for duplicate, expected in [(True, 401), (False, 408)]:
                connection = HTTPConnection('127.0.0.1', port, timeout=4)
                try:
                    connection.putrequest('POST', self.path())
                    connection.putheader(AUTH.header, KEY.decode('ascii'))
                    if duplicate:
                        connection.putheader(AUTH.header, KEY.decode('ascii'))
                    connection.putheader('Content-Type', 'application/json')
                    connection.putheader('Content-Length', '10')
                    connection.endheaders(b'{')
                    response = connection.getresponse()
                    self.assertEqual(response.status, expected)
                    response.read()
                finally:
                    connection.close()
        self.assertTrue((self.root / (ID(1) + '.json')).exists())

    def test_lost_http_ack_and_server_restart_replay_only_same_receipt(self):
        payload = self.payload(1)
        active = self.root / (ID(1) + '.json')
        with self.server() as (first_pid, port):
            # Send the real request, observe durable settlement out of band,
            # and discard the HTTP response before the client reads any bytes.
            with socket.create_connection(('127.0.0.1', port), timeout=4) as connection:
                headers = [f'POST {self.path()} HTTP/1.1', f'Host: 127.0.0.1:{port}',
                           f'{AUTH.header}: {KEY.decode("ascii")}', 'Content-Type: application/json',
                           f'Content-Length: {len(payload)}', 'Connection: close', '', '']
                connection.sendall('\r\n'.join(headers).encode('ascii') + payload)
                self.wait_for(lambda: not active.exists())
        self.assertTrue((self.root / (ID(2) + '.json')).exists())
        with self.server() as (second_pid, port):
            self.assertNotEqual(first_pid, second_pid)
            for _ in range(2):
                status, cache, raw = self.request(port, body=payload)
                self.assertEqual((status, cache, json.loads(raw)), (200, 'no-store', self.receipts[1]))
            wrong = self.payload(1, receipt={**self.receipts[1], 'receiptDigest': 'f' * 64})
            self.assertEqual(self.request(port, body=wrong)[0], 409)
        archive = self.work / 'deletion-acknowledgements'
        self.assertEqual(sorted(item.name for item in archive.iterdir()), [ID(1) + '.json', 'index.json'])


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--wheel', type=Path, required=True)
    parser.add_argument('--serve', type=Path)
    parser.add_argument('--socket-fd', type=int)
    args = parser.parse_args()
    WHEEL = args.wheel.resolve()
    if args.serve:
        serve(WHEEL, args.serve, args.socket_fd)
    else:
        AUTH = load_auth_and_route(WHEEL)
        unittest.main(argv=[sys.argv[0]], verbosity=2)
