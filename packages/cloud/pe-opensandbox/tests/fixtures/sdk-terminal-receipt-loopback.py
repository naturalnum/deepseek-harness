"""One private SDK HTTP app, positive terminal read first, then the actual application ACK fixture."""
import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import runpy
import socket
import subprocess
import sys

import uvicorn

FIXTURES = Path(__file__).resolve().parent
HTTP = runpy.run_path(str(FIXTURES.parent / 'test_deletion_ack_http.py'))
PROXY = runpy.run_path(str(FIXTURES / 'sdk-receipt-transport-loopback.py'))['discard_first_response']
SDK, KEY, SID, SCOPE = (HTTP[key] for key in ('SDK', 'KEY', 'ID', 'SCOPE'))


def load_runtime(wheel):
    auth = HTTP['load_auth_and_route'](wheel)
    from original_sdk_server_sources import deletion_terminal_http
    HTTP['DeletionAckHttp'].path.__globals__.update(WHEEL=wheel, AUTH=auth)
    return auth, deletion_terminal_http


def serve(wheel, root, fd):
    auth, terminal = load_runtime(wheel)
    owner = terminal.TerminalReadCompletionRecords(root, uid=os.getuid(), require_domain=False,
                                                  view=HTTP['FIXTURE']['OriginalView']())
    app, service = HTTP['fixture_app'](owner, auth)
    terminal.install_private_deletion_receipts(app, service)
    with socket.socket(fileno=fd) as listener:
        assert listener.getsockname()[0] == '127.0.0.1'
        uvicorn.Server(uvicorn.Config(app, access_log=False, log_level='warning')).run(sockets=[listener])


@contextmanager
def loopback(http, wheel):
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        listener.listen(16)
        fd = listener.fileno()
        process = subprocess.Popen([sys.executable, '-I', '-B', __file__, '--wheel', str(wheel),
                                    '--serve', str(http.root), '--socket-fd', str(fd)],
                                   pass_fds=(fd,), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        port = listener.getsockname()[1]
    try:
        http.wait_for(lambda: http.request(port, method='GET', path='/openapi.json', key=None)[0] == 200)
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
            raise RuntimeError(errors.decode('utf-8', errors='replace'))


def run_node(node, name, *arguments):
    run = subprocess.run([node, '--experimental-transform-types', str(FIXTURES / name), *map(str, arguments)],
                         capture_output=True, text=True, timeout=8)
    if run.returncode != 0:
        raise RuntimeError(run.stderr)
    return run.stdout


def expect_binding(terminal, receipt):
    return {key: receipt[key] for key in terminal.IDENTITY}


def main(wheel, node):
    auth, terminal = load_runtime(wheel)
    http = HTTP['DeletionAckHttp']()
    http.setUp()
    try:
        first = http.receipts[1]
        second = http.receipts[2]
        owner = terminal.TerminalReadCompletionRecords(http.root, uid=os.getuid(), require_domain=False,
                                                      view=HTTP['FIXTURE']['OriginalView']())
        try:
            # Set up the real prior state with a durable ACK but an unsettled outer reference.
            try:
                with owner.original_serial(SID(2)):
                    owner.acknowledge(KEY, SCOPE(2), second)
                    raise InterruptedError('synthetic unknown after durable ACK')
            except InterruptedError:
                pass
            owner.reserve(HTTP['FIXTURE']['original'](3))
        finally:
            owner.close()
        first_active = http.root / (SID(1) + '.json')
        second_active = http.root / (SID(2) + '.json')
        initial_first = first_active.read_bytes()
        initial_second = second_active.read_bytes()
        read_path = lambda index: terminal.TERMINAL_ROUTE.format(sandbox_id=SID(index))
        with loopback(http, wheel) as (server_pid, upstream_port):
            def read(index, scope, expected, key=KEY):
                return http.request(upstream_port, path=read_path(index), key=key,
                                    body=SDK.encode({'scope': scope, 'expected': expected}))

            bound = expect_binding(terminal, first)
            assert read(1, SCOPE(1), bound, key=None)[0] == 401
            assert read(2, SCOPE(1), expect_binding(terminal, second))[0] == 409
            for field in ('containerId', 'providerGeneration', 'policyDigest', 'receiptDigest'):
                assert read(1, SCOPE(1), {**bound, field: 'f' * 64})[0] == 409
            assert read(3, SCOPE(3), {**bound, 'sandboxId': SID(3)})[0] == 409
            assert read(4, SCOPE(4), {**bound, 'sandboxId': SID(4)})[0] == 409
            status, _, body = read(2, SCOPE(2), {**expect_binding(terminal, second), 'receiptDigest': second['receiptDigest']})
            assert status == 200 and json.loads(body) == second
            assert second_active.read_bytes() == initial_second

            scope = SCOPE(1)
            intent_keys = ('allocationId', 'accountId', 'epoch', 'sessionId', 'workspaceId', 'environmentVersion',
                           'provider', 'projectMountVersion', 'requestedAt', 'createDeadlineAt')
            full_binding = {**dict(zip(intent_keys[:5], scope[:5])), **bound}
            (http.work / 'before-terminal.json').write_text(json.dumps({
                'intent': dict(zip(intent_keys, scope)), 'binding': full_binding,
            }))
            with PROXY(upstream_port, auth, read_path(1)) as (port, readings):
                run_node(node, 'sdk-terminal-receipt-app.mjs', http.work, port)
                assert len(readings) == 2 and readings[0] == readings[1] and readings[1][2] == 200
                assert json.loads(readings[0][1]) == {'scope': scope, 'expected': bound}
            obtained = json.loads((http.work / 'incoming.json').read_text())['receipt']
            assert obtained == first and first_active.read_bytes() == initial_first
            archive = http.work / 'deletion-acknowledgements'
            assert SID(1) not in SDK.decode((archive / 'index.json').read_bytes())['receipts']
            with PROXY(upstream_port, auth, http.path(1)) as (port, acknowledgements):
                lost = json.loads(run_node(node, 'sdk-receipt-transport-app.mjs', 'lost', http.work, port))
                restarted = json.loads(run_node(node, 'sdk-receipt-transport-app.mjs', 'restart', http.work, port))
                assert lost['ack'] == 'pending' and restarted['ack'] == 'acknowledged'
                assert lost['pid'] != restarted['pid']
                assert len(acknowledgements) == 2 and acknowledgements[0] == acknowledgements[1]
                assert acknowledgements[1][2] == 200 and not first_active.exists()
                assert second_active.read_bytes() == initial_second
            print(f'Original SDK PID {server_pid}; application ACK PIDs {lost["pid"]}, {restarted["pid"]}')
            print('Cross-scope, unknown, unfound and mismatched exact binding refused')
            print('Read response dropped and replayed with no retirement; actual returned receipt then persisted and ACKed')
            print('ACK response dropped; restarted application delivered identical ACK once; other original unchanged')
    finally:
        http.doCleanups()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--wheel', type=Path, required=True)
    parser.add_argument('--node')
    parser.add_argument('--serve', type=Path)
    parser.add_argument('--socket-fd', type=int)
    args = parser.parse_args()
    if args.serve:
        serve(args.wheel.resolve(), args.serve, args.socket_fd)
    else:
        main(args.wheel.resolve(), args.node)
