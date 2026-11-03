"""Source-only wire/Manager/selector and real local pipe/fd7 tests; never a PID namespace or Target acceptance."""
import hashlib
import hmac
import json
import os
from pathlib import Path
import selectors
import socket
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1] / 'runtime' / 'agent'
sys.path.insert(0, str(ROOT))
import guardian
import launcher
from manager import Manager
from server import Server, parse_head, parse_stream_head
from stream import CREDIT, DATA, EOF, DATA_BYTES, WINDOW_BYTES, PipeChannels, decode, encode
from wire import ROLE_DOMAIN, VERSION, Refused, canonical, dumps, prepared_digest, verify_role

TOKEN, RUNTIME = '3' * 64, '2' * 64
WS_API = None
if os.environ.get('PE_EXECUTION_WS_WHEELS'):
    # Explicit test input only; production dependency selection remains Root-owned.
    wheels = Path(os.environ['PE_EXECUTION_WS_WHEELS'])
    for name, digest in [('wsproto-1.3.2-py3-none-any.whl', '61eea322cdf56e8cc904bd3ad7573359a242ba65688716b0710a5eb12beab584'),
                         ('h11-0.16.0-py3-none-any.whl', '63cf8bbe7522de3bf65932fda1d9c2772064ffb3dae62d55932da54b31cb6c86')]:
        path = wheels / name
        assert hashlib.sha256(path.read_bytes()).hexdigest() == digest
        sys.path.insert(0, str(path))
    from wsproto import WSConnection, ConnectionType, events
    WS_API = WSConnection, ConnectionType, events


def spec(mode='ignore', control='pipe'):
    return {'executionKind': 'pipes', 'argv': ['/bin/source-fixture'], 'cwd': '/srv/project',
            'stdin': {'mode': mode}, 'env': {'HOME': None, 'NODE_OPTIONS': '--max-old-space-size=64'},
            'stream': {'version': 'pe-execution-stream-v1', 'stdout': 'pipe', 'stderr': 'pipe', 'control': control,
                       'limits': {'controlInputBytes': 8388608, 'controlOutputBytes': 8388608}}}


def signed(identity='one', role='program', value=None):
    value = spec() if value is None else value
    normalized, _, _ = canonical(value)
    digest = prepared_digest(normalized)
    registration = 'service-original' if role == 'service' else None
    payload = {'protocolVersion': VERSION, 'runtimeIdentity': RUNTIME, 'operationId': identity,
               'specHash': digest, 'role': role, 'registrationId': registration}
    signature = hmac.new(hmac.digest(bytes.fromhex(TOKEN), ROLE_DOMAIN, 'sha256'), dumps(payload), hashlib.sha256).hexdigest()
    return {'runtimeIdentity': RUNTIME, 'operationId': identity, 'specHash': digest,
            'authorization': {'role': role, 'registrationId': registration, 'signature': signature}, 'spec': normalized}


def reference(body):
    return {key: body[key] for key in ['runtimeIdentity', 'operationId', 'specHash', 'authorization']}


class Kernel:
    """Only the external kernel is scripted in Manager/HTTP cases; actual FD functions are tested separately."""
    def __init__(self, value):
        self.attempted = self.prepared = True
        self.committed = self.released = self.empty_confirmed = False
        self.cause = self.fault = self.failure = self.direct = self.deadline = None
        self.phase, self.stops = 'fixture-prepared', []
        self.stream = PipeChannels(value) if value.get('executionKind') == 'pipes' else None
        self.buffers = {name: bytearray() for name in ['stdout', 'stderr']}
        self.counts = dict.fromkeys(self.buffers, 0)
        self.eof = set()

    def begin_prepare(self): pass
    def pump(self, timeout=0): pass
    def empty(self): return False
    def stop(self, cause, kill=True):
        self.stops.append((cause, kill)); self.cause = cause
        if self.stream is not None: self.stream.abort_inputs()
    def commit(self, _deadline): self.committed = True
    def result(self): return {'providerFailure': False}


class World:
    def __init__(self):
        self.now = 100.0
        self.owner = SimpleNamespace(project='/srv/project', closed=False)
        self.owner.register = self.register
        self.manager = Manager(RUNTIME, self.owner, {}, 'source-fixture-image', TOKEN, clock=lambda: self.now)
        self.manager.stream_enabled = True

    def register(self, _identity, argv, cwd, stdin, batch, **options):
        value = {'argv': argv, 'cwd': cwd, 'stdin': {'mode': stdin}}
        if 'pipes' in options:
            value.update(executionKind='pipes', stream=options['pipes'], env=options['env'])
        return Kernel(value)


class WireManagerTests(unittest.TestCase):
    def test_collect_canonical_bytes_unchanged_and_pipes_extra_fields_signed(self):
        value = {'argv': ['/bin/echo', 'unicode-中'], 'stdin': {'mode': 'ignore'}, 'cwd': '/srv/project'}
        normalized, batch, digest = canonical(value)
        self.assertEqual(normalized, value); self.assertEqual(batch, b'')
        self.assertEqual(digest, hashlib.sha256(dumps(value)).hexdigest())
        body = signed(); verify_role(body, TOKEN)
        changed = json.loads(json.dumps(body)); changed['spec']['stream']['limits']['controlInputBytes'] -= 1
        self.assertNotEqual(prepared_digest(canonical(changed['spec'])[0]), body['specHash'])
        changed['specHash'] = prepared_digest(canonical(changed['spec'])[0])
        with self.assertRaises(Refused): verify_role(changed, TOKEN)

    def test_invalid_spec_env_marker_unknown_and_budget_refuse(self):
        for mutate in [lambda v: v.update(extra=1), lambda v: v['stdin'].update(mode='tty'),
                       lambda v: v['stream'].update(version='raw-upgrade'),
                       lambda v: v['stream']['limits'].update(controlInputBytes=8388609),
                       lambda v: v['stream']['limits'].update(controlOutputBytes=True),
                       lambda v: v['env'].update(DSH_SUBPROCESS_CONTROL='pipe'),
                       lambda v: v['env'].update(BAD='x' * 4097),
                       lambda v: v['env'].update({'bad-name': 'x'})]:
            value = spec(); mutate(value)
            with self.subTest(value=value), self.assertRaises(Refused): canonical(value)
        value = {'argv': ['/bin/echo'], 'stdin': {'mode': 'pipe'}, 'cwd': '/srv/project'}
        with self.assertRaises(Refused): canonical(value)

    def test_prepare_attach_commit_exact_once_and_unsigned_refusal(self):
        world = World(); body = signed(); ref = reference(body)
        first = world.manager.handle('/prepare', body)
        self.assertTrue(first['operation']['prepared'])
        with self.assertRaises(Refused): world.manager.handle('/commit', ref)
        row = world.manager.records['one']; original = row['kernel']
        bad = json.loads(json.dumps(ref)); bad['authorization']['role'] = 'foreground'
        with self.assertRaises(Refused): world.manager.stream_operation(bad)
        holder = {'websocket': SimpleNamespace(io_closed=lambda: False, opening=True)}
        world.manager.attach_stream(ref, holder)
        with self.assertRaises(Refused): world.manager.attach_stream(ref, {})
        with self.assertRaises(Refused): world.manager.handle('/commit', ref)
        holder['websocket'].opening = False
        world.manager.handle('/commit', ref)
        self.assertTrue(original.committed)
        self.assertIs(row['kernel'], original); self.assertIs(row['streamHolder'], holder)

    def test_disconnect_retains_original_holder_and_stops_no_reconnect(self):
        world = World(); body = signed(); ref = reference(body)
        world.manager.handle('/prepare', body)
        holder = {'websocket': SimpleNamespace(io_closed=lambda: False, opening=False)}
        row = world.manager.attach_stream(ref, holder)
        world.manager.detach_stream(row, False)
        self.assertTrue(row['unknown']); self.assertTrue(world.manager.sealed)
        self.assertEqual(row['kernel'].stops, [('stream-disconnect', True)])
        self.assertIs(row['streamHolder'], holder)
        with self.assertRaises(Refused): world.manager.attach_stream(ref, {})

    def test_capacity_program_plus_foreground_only_and_no_unqualified_stream(self):
        for first, second, allowed in [('program', 'foreground', True), ('program', 'service', False),
                                       ('program', 'program', False), ('foreground', 'service', True)]:
            world = World()
            a = spec() if first != 'service' else {'argv': ['/bin/fixture'], 'cwd': '/srv/project', 'stdin': {'mode': 'ignore'}}
            b = spec() if second != 'service' else {'argv': ['/bin/fixture'], 'cwd': '/srv/project', 'stdin': {'mode': 'ignore'}}
            world.manager.handle('/prepare', signed('one', first, a))
            if allowed:
                world.manager.handle('/prepare', signed('two', second, b))
                with self.assertRaises(Refused): world.manager.handle('/prepare', signed('three', 'foreground'))
            else:
                with self.assertRaises(Refused): world.manager.handle('/prepare', signed('two', second, b))
        world = World(); world.manager.stream_enabled = False
        self.assertEqual(world.manager.handshake()['capabilities'], ['argv', 'stdin-ignore', 'stdin-batch', 'collect'])
        self.assertEqual(world.manager.handshake()['rangeRoles'], {'foreground': 0, 'service': 0})
        with self.assertRaises(Refused): world.manager.handle('/prepare', signed())
        world.manager.stream_enabled = True
        self.assertEqual(world.manager.handshake()['rangeRoles'], {'foreground': 0, 'service': 0, 'program': 0})

    def test_snapshot_never_confuses_range_with_stream_settlement(self):
        world = World(); body = signed(); world.manager.handle('/prepare', body)
        io = {'done': False}
        row = world.manager.attach_stream(reference(body), {'websocket': SimpleNamespace(io_closed=lambda: io['done'], opening=False)})
        row['kernel'].released = True
        row['kernel'].counts['stdout'] = 17
        value = world.manager.snapshot(row)
        self.assertTrue(value['rangeEmpty']); self.assertFalse(value['ioClosed'])
        self.assertEqual(value['streams']['stdout'], {'requestedOffset': 0, 'startOffset': 17, 'endOffset': 17,
                         'observedBytes': 17, 'base64': '', 'lossy': True, 'eof': False})
        io['done'] = True
        self.assertTrue(world.manager.snapshot(row)['ioClosed'])

    def test_http_collect_and_private_stream_headers_do_not_put_identity_in_url(self):
        collect_head = ('POST /poll HTTP/1.1\r\nHost: fixture.invalid\r\nx-pe-execution-token: ' + TOKEN
                        + '\r\nContent-Length: 1\r\nContent-Type: application/json\r\n\r\n').encode()
        self.assertEqual(parse_head(collect_head, TOKEN), ('/poll', 1))
        ref = reference(signed())
        head = ('GET /stream HTTP/1.1\r\nHost: fixture.invalid\r\nx-pe-execution-token: ' + TOKEN
                + '\r\nx-pe-operation-id: one\r\nx-pe-spec-hash: ' + ref['specHash']
                + '\r\nx-pe-range-role: program\r\nx-pe-registration-id: -\r\nx-pe-role-signature: '
                + ref['authorization']['signature'] + '\r\n\r\n').encode()
        self.assertEqual(parse_stream_head(head, TOKEN, RUNTIME), ref)
        for bad in [head.replace(b'GET /stream ', b'GET /stream?token=forbidden '),
                    head.replace(TOKEN.encode(), b'0' * 64),
                    head.replace(b'Host: fixture.invalid\r\n', b'Host: fixture.invalid\r\nHost: duplicate\r\n')]:
            with self.assertRaises(Refused): parse_stream_head(bad, TOKEN, RUNTIME)

    def test_output_window_is_independent_and_received_sequence_never_replays(self):
        channels = PipeChannels(spec('pipe'))
        for _ in range(WINDOW_BYTES // DATA_BYTES): channels.produced('stdout', b'x' * DATA_BYTES)
        self.assertEqual(channels.read_allowance('stdout'), 0)
        channels.produced('control', b'opaque control')
        self.assertGreater(channels.read_allowance('control'), 0)
        channels.receive(encode(DATA, 1, 0, b'one'))
        with self.assertRaises(Refused): channels.receive(encode(DATA, 1, 0, b'one'))
        channels.receive(encode(EOF, 1, 1, b''))
        with self.assertRaises(Refused): channels.receive(encode(DATA, 1, 2, b'after eof'))
        with self.assertRaises(Refused): channels.receive(encode(CREDIT, 3, 0, (1).to_bytes(4, 'big')))


class RealPipeTests(unittest.TestCase):
    def setUp(self):
        # macOS lacks Linux's atomic creation flags. Only the test adapter uses Python's
        # actual non-inheritable pipe/socket equivalents; production remains Linux-only.
        if not hasattr(os, 'pipe2'):
            fixture = patch.object(os, 'pipe2', lambda _flags: os.pipe(), create=True)
            fixture.start(); self.addCleanup(fixture.stop)
        if not hasattr(socket, 'SOCK_CLOEXEC'):
            fixture = patch.object(socket, 'SOCK_CLOEXEC', 0, create=True)
            fixture.start(); self.addCleanup(fixture.stop)

    def operation(self, mode='pipe'):
        owner = SimpleNamespace(project='/srv/project', roots={}, closed=False)
        value = spec(mode)
        op = launcher.Operation(owner, 'local-fd-test', value['argv'], value['cwd'], mode, b'', 'program',
                                pipes=value['stream'], env=value['env'])
        op.selector = selectors.DefaultSelector()
        op.committed = True
        self.addCleanup(self.cleanup, op)
        return op

    @staticmethod
    def cleanup(op):
        for fd in list(op.fds):
            try: op.selector.unregister(fd)
            except KeyError: pass
            op.close(fd)
        op.selector.close()

    def test_actual_stdin_credit_only_after_write_and_eof(self):
        op = self.operation()
        read, write = op.pipe(); os.set_blocking(write, False)
        op.input_fds[1] = write
        op.stream.receive(encode(DATA, 1, 0, b'actual stdin'))
        self.assertIsNone(op.stream.next_frame())
        op.flush_inputs()
        self.assertEqual(os.read(read, 4096), b'actual stdin')
        kind, channel, sequence, credit = decode(op.stream.next_frame())
        self.assertEqual((kind, channel, sequence, int.from_bytes(credit, 'big')), (CREDIT, 1, 0, 12))
        op.stream.receive(encode(EOF, 1, 1, b'')); op.flush_inputs()
        self.assertEqual(os.read(read, 1), b''); self.assertNotIn(write, op.fds)

    def test_actual_control_more_than_window_bidirectional_then_half_close(self):
        op = self.operation('ignore')
        parent, child = op.control_pair()
        peer = socket.socket(fileno=child); op.fds.remove(child); self.addCleanup(peer.close)
        os.set_blocking(parent, False)
        op.selector.register(parent, selectors.EVENT_READ, 'control'); op.input_fds[4] = parent
        host_sequence, total = 0, 0
        for _ in range(25):
            payload = b'\x00\xff' * 2048
            op.stream.receive(encode(DATA, 4, host_sequence, payload)); host_sequence += 1
            op.flush_inputs(); self.assertEqual(peer.recv(4096), payload)
            credit = decode(op.stream.next_frame())
            self.assertEqual((credit[0], int.from_bytes(credit[3], 'big')), (CREDIT, 4096))
            peer.sendall(payload); op.pump(0)
            frame = decode(op.stream.next_frame()); self.assertEqual(frame[3], payload)
            op.stream.receive(encode(CREDIT, 4, host_sequence, (4096).to_bytes(4, 'big'))); host_sequence += 1
            total += 4096
        self.assertEqual(total, 102400)
        self.assertEqual(op.stream.input_counts[4], total); self.assertEqual(op.stream.output_counts[4], total)
        op.stream.receive(encode(EOF, 4, host_sequence, b'')); op.flush_inputs()
        self.assertEqual(peer.recv(1), b'')
        peer.sendall(b'after-half-close'); op.pump(0)
        self.assertEqual(decode(op.stream.next_frame())[3], b'after-half-close')
        peer.close(); op.pump(0)
        self.assertIn('control', op.eof); self.assertNotIn(parent, op.fds)

    def test_explicit_stop_abandons_only_unwritten_bytes_without_credit(self):
        channels = PipeChannels(spec('pipe'))
        channels.receive(encode(DATA, 1, 0, b'original input'))
        channels.consumed(1, 3)
        channels.abort_inputs()
        self.assertEqual(channels.abandoned[1], 11)
        credit = decode(channels.next_frame())
        self.assertEqual(int.from_bytes(credit[3], 'big'), 3)
        self.assertEqual(channels.rows[1]['pending'], 11)
        with self.assertRaises(Refused): channels.receive(encode(DATA, 1, 1, b'no replay'))

    def test_control_budget_error_and_exact_guardian_config_budget(self):
        value = spec(); value['stream']['limits']['controlInputBytes'] = 3
        channels = PipeChannels(value)
        channels.receive(encode(DATA, 4, 0, b'123'))
        with self.assertRaises(Refused): channels.receive(encode(DATA, 4, 1, b'4'))
        value = spec(); value['stream']['limits']['controlOutputBytes'] = 3
        channels = PipeChannels(value); channels.produced('control', b'123')
        with self.assertRaises(Refused): channels.produced('control', b'4')
        owner = SimpleNamespace(project='/srv/project', roots={}, closed=False)
        value = spec()
        with self.assertRaises(AssertionError): launcher.Operation(owner, 'oversized-env', value['argv'], value['cwd'],
            'ignore', b'', 'program', pipes=value['stream'], env={'X': 'y' * 4096})

    def test_real_child_fd7_inheritance_and_private_fd7_relocation(self):
        result = subprocess.run([sys.executable, '-I', '-S', '-B', str(Path(__file__).resolve()), '--fd7-helper'],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        value = json.loads(result.stdout)
        self.assertEqual(value['fds'], [0, 1, 2, 7]); self.assertEqual(value['marker'], 'pipe')
        self.assertEqual(value['reply'], 'parent-ack')


@unittest.skipUnless(WS_API is not None, 'protected WS test inputs not selected; no WS acceptance claimed')
class SelectorWebSocketTests(unittest.TestCase):
    def setUp(self):
        self.world = World()
        self.body = signed()
        self.ref = reference(self.body)
        self.world.manager.handle('/prepare', self.body)
        self.remote, local = socket.socketpair()
        listener, unused = socket.socketpair()  # Registered inert fd only; no listening socket or server process.
        self.addCleanup(unused.close); self.addCleanup(listener.close); self.addCleanup(self.remote.close)
        self.server = Server(self.world.manager, TOKEN, listener, websocket_api=lambda: WS_API)
        self.addCleanup(self.server.selector.close)
        self.local = local; local.setblocking(False); self.remote.settimeout(1)
        self.addCleanup(local.close)
        self.peer = {'socket': local, 'input': bytearray(), 'length': None, 'headerEnd': None,
                     'authenticated': False, 'output': None, 'sent': 0, 'created': 100.0}
        self.server.peers[local] = self.peer
        self.server.selector.register(local, selectors.EVENT_READ, self.peer)
        self.client = WS_API[0](WS_API[1].CLIENT)
        self.host_sequence = dict.fromkeys(range(1, 5), 0)
        self.fragments = bytearray()

    def push(self, wire):
        for start in range(0, len(wire), 512):
            self.remote.sendall(wire[start:start + 512])
            self.server.read(self.peer)

    def flush(self):
        self.server.refresh_streams()
        output = self.peer['output']
        if not output: return []
        count = len(output)
        while self.peer['output'] is not None: self.server.write(self.peer)
        received = 0
        while received < count:
            chunk = self.remote.recv(min(4096, count - received)); received += len(chunk)
            self.client.receive_data(chunk)
        return list(self.client.events())

    def attach(self):
        authorization = self.ref['authorization']
        headers = [(b'x-pe-execution-token', TOKEN.encode()), (b'x-pe-operation-id', self.ref['operationId'].encode()),
                   (b'x-pe-spec-hash', self.ref['specHash'].encode()), (b'x-pe-range-role', authorization['role'].encode()),
                   (b'x-pe-registration-id', b'-'), (b'x-pe-role-signature', authorization['signature'].encode())]
        self.push(self.client.send(WS_API[2].Request(host='source-fixture.invalid', target='/stream',
                  subprotocols=['pe-execution-stream-v1'], extra_headers=headers)))
        accepted, = self.flush()
        self.assertIsInstance(accepted, WS_API[2].AcceptConnection)
        self.assertTrue(self.world.manager.records['one']['streamConnected'])

    def send(self, kind, channel, payload):
        message = encode(kind, channel, self.host_sequence[channel], payload)
        self.host_sequence[channel] += 1
        self.push(self.client.send(WS_API[2].BytesMessage(data=message)))

    def mux(self, events):
        result = []
        for event in events:
            self.assertIsInstance(event, WS_API[2].BytesMessage)
            self.fragments.extend(event.data)
            if event.message_finished:
                result.append(decode(bytes(self.fragments))); self.fragments.clear()
        return result

    def test_actual_same_server_upgrade_exact_ref_commit_and_raw_control(self):
        self.attach()
        row = self.world.manager.records['one']
        self.world.manager.handle('/commit', self.ref)
        payload = b'\x00\xff{"opaque":"Native PTC"}\n'
        self.send(DATA, 4, payload)
        self.assertEqual(bytes(row['kernel'].stream.incoming[4]), payload)
        row['kernel'].stream.consumed(4, len(payload))  # Kernel delivery is scripted only in this WS test.
        frames = self.mux(self.flush())
        self.assertEqual((frames[0][0], frames[0][1], int.from_bytes(frames[0][3], 'big')), (CREDIT, 4, len(payload)))
        row['kernel'].stream.produced('control', payload)
        frames = self.mux(self.flush()); self.assertEqual(frames[0][3], payload)
        self.send(CREDIT, 4, len(payload).to_bytes(4, 'big'))
        self.assertEqual(row['kernel'].stream.rows[4]['credit'], WINDOW_BYTES)

    def test_data_before_commit_and_text_messages_refuse_original_holder_retained(self):
        self.attach()
        with self.assertRaises(Refused): self.send(DATA, 4, b'not submitted')
        row = self.world.manager.records['one']; holder = row['streamHolder']
        self.server.close_peer(self.local)
        self.assertIs(row['streamHolder'], holder); self.assertTrue(row['unknown'])
        self.assertEqual(row['kernel'].stops, [('stream-disconnect', True)])

    def test_normal_ws_close_requires_range_and_all_actual_send_credit_settlement(self):
        self.attach(); self.world.manager.handle('/commit', self.ref)
        row = self.world.manager.records['one']; op = row['kernel']
        op.stream.produced('stdout', b'raw bytes')
        data, = self.mux(self.flush()); self.assertEqual(data[3], b'raw bytes')
        op.released = True  # Scripted physical fact, deliberately independent of actual WS settlement.
        for name in ['stdout', 'stderr', 'control']: op.stream.ended(name)
        for _ in range(3): self.mux(self.flush())
        self.assertFalse(self.world.manager.snapshot(row)['ioClosed'])
        self.send(CREDIT, 2, len(b'raw bytes').to_bytes(4, 'big'))
        self.assertTrue(self.world.manager.snapshot(row)['ioClosed'])
        self.push(self.client.send(WS_API[2].CloseConnection(code=1000)))
        closed, = self.flush(); self.assertIsInstance(closed, WS_API[2].CloseConnection)
        self.server.refresh_streams()
        self.assertFalse(row['streamConnected']); self.assertFalse(row['unknown']); self.assertFalse(self.world.manager.sealed)

    def test_early_transport_drop_marks_original_unknown_without_new_process(self):
        self.attach(); self.world.manager.handle('/commit', self.ref)
        row = self.world.manager.records['one']; original = row['kernel']
        self.remote.shutdown(socket.SHUT_WR); self.server.read(self.peer)
        self.assertTrue(row['unknown']); self.assertIs(row['kernel'], original)
        self.assertEqual(len(self.world.manager.records), 1)
        with self.assertRaises(Refused): self.world.manager.stream_operation(self.ref)

    def test_text_message_is_not_a_mux_frame(self):
        self.attach(); self.world.manager.handle('/commit', self.ref)
        with self.assertRaises(Refused): self.push(self.client.send(WS_API[2].TextMessage(data='not a frame')))
        self.server.close_peer(self.local)
        self.assertTrue(self.world.manager.records['one']['unknown'])


def fd7_helper():
    private = [os.open('/dev/null', os.O_RDWR | os.O_CLOEXEC) for _ in range(5)]
    assert private == [3, 4, 5, 6, 7]
    parent, child = socket.socketpair()
    source = child.detach()
    descriptors = guardian.install_control_fd(source, (7, 3, 4, 5, 6))
    assert descriptors[0] != 7 and os.fstat(descriptors[0]) == os.fstat(3)
    code = """import json,os
os.write(7,b'child-fd7')
reply=os.read(7,4096).decode()
live=[]
for fd in range(32):
 try:os.fstat(fd);live.append(fd)
 except OSError:pass
print(json.dumps({'fds':live,'marker':os.environ.get('DSH_SUBPROCESS_CONTROL'),'reply':reply}))
"""
    child = subprocess.Popen([sys.executable, '-I', '-S', '-B', '-c', code], stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, pass_fds=(7,), close_fds=True,
                             env={'DSH_SUBPROCESS_CONTROL': 'pipe'})
    os.close(7)
    assert parent.recv(4096) == b'child-fd7'
    parent.sendall(b'parent-ack'); parent.close()
    output, error = child.communicate(timeout=5)
    assert child.returncode == 0, error
    for fd in set(descriptors): os.close(fd)
    sys.stdout.buffer.write(output)


if __name__ == '__main__':
    if sys.argv[1:] == ['--fd7-helper']:
        fd7_helper()
    else:
        unittest.main(verbosity=2)
