"""PRIVATE UNEXECUTED. Fixed four-slot Root fixture, no server/native provider or retries."""
import hashlib
import json
import os
import select
import selectors
import signal
import struct
import subprocess
import time

from paths import ENV, ENV_ROOT, project_path
from wire import LIMITS

BWRAP_HASH = '0fc274e60c4b606db202dc9e82db60b4d944ba74bab8b6af2cd95ea28c4f8b2d'


def world_argv(project):
    project_path(project)  # Root startup only, never an operation-selected mount.
    return ['/trusted/bwrap', '--unshare-user', '--uid', '0', '--gid', '0',
        '--disable-userns', '--assert-userns-disabled', '--unshare-pid', '--unshare-ipc', '--unshare-uts',
        '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--clearenv',
        '--setenv', 'PATH', ENV['PATH'], '--setenv', 'HOME', ENV['HOME'],
        '--setenv', 'TMPDIR', ENV['TMPDIR'], '--setenv', 'LANG', ENV['LANG'],
        '--ro-bind', '/', '/', '--proc', '/proc', '--ro-bind', '/dev', '/dev',
        '--dev-bind', '/dev/null', '/dev/null', '--ro-bind', '/sys', '/sys',
        '--bind', project, project, '--ro-bind', ENV_ROOT, ENV_ROOT,
        '--bind', ENV_ROOT + '/home', ENV_ROOT + '/home',
        '--bind', ENV_ROOT + '/venv', ENV_ROOT + '/venv',
        '--bind', ENV_ROOT + '/tmp', ENV_ROOT + '/tmp',
        '--bind', ENV['TMPDIR'], '/tmp', '--ro-bind', project + '/.pe', project + '/.pe', '--chdir', project]
RECORD = struct.Struct('!4sB3xii')
PREPARED, SPAWNED, DIRECT, EMPTY, ERROR = range(1, 6)


def facts(path):
    with open(path) as f:
        text = f.read(4097)
    assert len(text) <= 4096
    return dict(line.split(':', 1) for line in text.splitlines() if ':' in line)


def exited(fd):
    return bool(select.select([fd], [], [], 0)[0])


class Owner:
    def __init__(self, project, roots):
        if not __debug__:
            raise RuntimeError('optimized Python is unsupported by this reviewed fixture')
        assert os.getuid() == 0 and len(os.listdir('/proc/self/task')) == 1
        assert signal.getsignal(signal.SIGCHLD) == signal.SIG_DFL
        assert not os.statvfs('/').f_flag & os.ST_RDONLY  # User-world mount restrictions must do the work.
        with open('/trusted/bwrap', 'rb') as f:
            assert os.fstat(f.fileno()).st_size == 814328 and hashlib.sha256(f.read(814329)).hexdigest() == BWRAP_HASH
        self.project, self.roots, self.base = project_path(project), roots, world_argv(project)
        self.slots, self.closed = {}, False

    def register(self, identity, argv, cwd, stdin_mode, batch=b'', *, role):
        assert type(identity) is str and 1 <= len(identity) <= 64
        assert not self.closed and identity not in self.slots and len(self.slots) < 4
        assert type(argv) is list and 1 <= len(argv) <= 16 and os.path.isabs(argv[0])
        assert all(type(x) is str and '\0' not in x for x in argv)
        assert sum(len(x.encode()) + 1 for x in argv) <= 4096 and type(batch) is bytes and len(batch) <= 4096
        assert type(stdin_mode) is str and stdin_mode in ['ignore', 'batch']
        assert stdin_mode != 'ignore' or batch == b''
        assert role in ['foreground', 'service']
        op = Operation(self, identity, argv, cwd, stdin_mode, batch, role)
        self.slots[identity] = op  # Slot/intent retained before any FD or process; never reused.
        return op


class Operation:
    def __init__(self, owner, identity, argv, cwd, stdin_mode, batch, role):
        self.owner, self.identity, self.batch = owner, identity, batch
        self.role = role
        self.spec = json.dumps({'argv': argv, 'env': ENV, 'roots': owner.roots,
                                'projectRoot': owner.project, 'cwd': cwd, 'stdinMode': stdin_mode}, separators=(',', ':')).encode()
        assert len(self.spec) <= 4096
        self.fds, self.eof, self.selector = set(), set(), None
        self.process = self.pidfd = self.gate = None
        self.attempted = self.committed = self.prepared = self.empty_record = self.empty_confirmed = False
        self.release_attempted = self.released = self.signalled = False
        self.controlled_stop = False
        self.cause = self.fault = self.failure = self.cleanup_failure = self.direct = self.spawned = None
        self.records, self.metadata = [], []
        self.buffers = {k: bytearray() for k in ['stdout', 'stderr', 'diagnostic', 'status', 'metadata']}
        self.counts = dict.fromkeys(self.buffers, 0)
        self.deadline, self.phase = None, 'registered'

    def close(self, fd):
        self.fds.remove(fd)  # An ambiguous close is recorded, never retried against a reused number.
        try:
            os.close(fd)
        except OSError:
            self.fault, self.owner.closed = self.fault or 'fd-close-unknown', True
            raise

    def pipe(self):
        pair = os.pipe2(os.O_CLOEXEC)
        self.fds.update(pair)
        return pair

    def write(self, fd, data):
        os.set_blocking(fd, False)
        assert len(data) <= os.fpathconf(fd, 'PC_PIPE_BUF')
        if os.write(fd, data) != len(data):
            raise RuntimeError('short private write; never replay')

    def pump(self, timeout=0.01):
        for key, _ in self.selector.select(timeout):
            fd, name = key.fd, key.data
            data = os.read(fd, 4096)
            if not data:
                self.selector.unregister(fd)
                self.close(fd)
                self.eof.add(name)
                assert name not in ['status', 'metadata'] or not self.buffers[name]
                continue
            self.counts[name] += len(data)
            cap = {'status': 80, 'metadata': 2048}.get(name, 4096)
            if name in ['stdout', 'stderr', 'diagnostic']:
                if name == 'diagnostic':
                    self.buffers[name].extend(data[:max(0, cap - len(self.buffers[name]))])
                else:
                    self.buffers[name].extend(data)
                    del self.buffers[name][:-4096]
                if self.counts[name] > (4096 if name == 'diagnostic' else 65536):
                    self.stop('output-budget')
                continue
            assert self.counts[name] <= cap
            self.buffers[name].extend(data)
            if name == 'metadata':
                while b'\n' in self.buffers[name]:
                    line, _, rest = self.buffers[name].partition(b'\n')
                    self.buffers[name][:] = rest
                    row = json.loads(line)
                    assert len(self.metadata) < 2 and type(row) is dict
                    assert ('child-pid' in row) if not self.metadata else set(row) == {'exit-code'}
                    self.metadata.append(row)  # bwrap exit-code is diagnostic, never user direct outcome.
                continue
            while len(self.buffers[name]) >= RECORD.size:
                magic, tag, a, b = RECORD.unpack(self.buffers[name][:RECORD.size])
                del self.buffers[name][:RECORD.size]
                assert magic == b'S4B1' and len(self.records) < 5 and tag in range(1, 6)
                self.records.append([tag, a, b])
                if tag == PREPARED:
                    assert len(self.records) == 1 and not self.prepared and not self.committed and not a and not b
                    self.prepared = True
                elif tag == SPAWNED:
                    assert self.prepared and self.committed and self.spawned is None and not self.empty_record and a > 1 and not b
                    self.spawned = a
                elif tag == DIRECT:
                    assert a == self.spawned and self.direct is None and not self.empty_record
                    assert os.WIFEXITED(b) or os.WIFSIGNALED(b)
                    self.direct = {'waitStatus': b, 'returncode': os.waitstatus_to_exitcode(b)}
                elif tag == EMPTY:
                    assert self.prepared and not self.empty_record and not a and not b
                    self.empty_record = True
                else:
                    self.fault = self.fault or f'guardian-stage-{a}-errno-{b}'
                    self.failure = self.failure or {'type': 'GuardianErrorRecord', 'errno': b, 'phase': f'guardian-stage-{a}'}

    def begin_prepare(self):
        assert not self.attempted and not self.cause and not self.owner.closed
        active = [op for op in self.owner.slots.values() if op is not self and op.attempted and not op.released]
        assert len(active) < 2 and all(op.role != self.role for op in active)
        self.attempted, self.phase = True, 'bwrap-launch'
        self.prepare_deadline = time.monotonic() + LIMITS['prepareMs'] / 1000
        self.selector = selectors.DefaultSelector()
        cfg_r, cfg_w = self.pipe(); status_r, status_w = self.pipe(); gate_r, self.gate = self.pipe()
        in_r, in_w = self.pipe(); out_r, out_w = self.pipe(); err_r, err_w = self.pipe()
        meta_r, meta_w = self.pipe(); block_r, block_w = self.pipe(); diag_r, diag_w = self.pipe()
        child = [cfg_r, status_w, gate_r, in_r, out_w, err_w, meta_w, block_r]
        command = self.owner.base + ['--as-pid-1', '--json-status-fd', str(meta_w), '--block-fd', str(block_r), '--',
                          '/usr/local/bin/python3', '-I', '-S', '-B', '/trusted/bwrap-revision/guardian.py',
                          *(str(fd) for fd in child[:6])]
        self.process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=diag_w,
                                        user=2000, group=2000, extra_groups=[], env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': ENV['LANG']},
                                        close_fds=True, pass_fds=tuple(child))
        for fd in child + [diag_w]:
            self.close(fd)
        for fd, name in [(out_r, 'stdout'), (err_r, 'stderr'), (status_r, 'status'), (meta_r, 'metadata'), (diag_r, 'diagnostic')]:
            os.set_blocking(fd, False)
            self.selector.register(fd, selectors.EVENT_READ, name)
        self.write(cfg_w, self.spec); self.close(cfg_w)
        self.write(in_w, self.batch); self.close(in_w)
        self.block_write = block_w
        self.phase = 'trusted-child-identity'

    def advance_prepare(self):
        self.pump(timeout=0)
        if self.phase == 'trusted-child-identity' and self.metadata:
            row = self.metadata[0]
            pid = row['child-pid']
            assert type(pid) is int and pid > 0
            candidate = os.pidfd_open(pid)
            self.fds.add(candidate)
            actual = facts(f'/proc/{pid}/status')
            assert int(facts(f'/proc/self/fdinfo/{candidate}')['Pid']) == pid and not exited(candidate)
            assert int(actual['PPid']) == self.process.pid and len(actual['NSpid'].split()) >= 2 and int(actual['NSpid'].split()[-1]) == 1
            assert all([int(x) for x in actual[k].split()] == [2000] * 4 for k in ['Uid', 'Gid'])
            assert type(row['pid-namespace']) is int and row['pid-namespace'] > 0 and row['pid-namespace'] != os.stat('/proc/self/ns/pid').st_ino
            self.pidfd = candidate  # Stop authority established only after trusted metadata + live identity checks.
            self.write(self.block_write, b'B'); self.close(self.block_write)
            self.block_write = None
            self.phase = 'guardian-prepared'
        if self.prepared:
            assert not self.spawned
            return True
        assert time.monotonic() < self.prepare_deadline and not self.fault
        assert self.process.poll() is None and (self.pidfd is None or not exited(self.pidfd))
        return False

    def commit(self, resident_deadline):
        assert self.prepared and not self.committed and not self.cause and not self.fault and not self.owner.closed
        assert not exited(self.pidfd)
        now = time.monotonic()
        assert now < resident_deadline
        run_ms = LIMITS['serviceRunMs'] if self.role == 'service' else LIMITS['runMs']
        self.committed, self.deadline = True, min(now + run_ms / 1000, resident_deadline)
        self.phase = 'commit-attempted'
        self.write(self.gate, b'C')  # Latched before write; failure is never replayed.

    def empty(self):
        if not self.empty_confirmed:
            self.empty_confirmed = (self.pidfd is not None and exited(self.pidfd) and self.process.poll() is not None
                                    and self.eof == set(self.buffers) and not self.buffers['status'] and not self.buffers['metadata'])
        return self.empty_confirmed

    def observe(self, cancelled=lambda: False, until=lambda: False):
        while not cancelled():
            self.pump()
            if self.empty():
                return True
            if self.fault or (self.deadline and time.monotonic() >= self.deadline):
                self.stop('provider-failure' if self.fault else 'run-deadline')
            if self.cause or until():
                return False
        return False  # Passive cancellation does not close gates or signal the process.

    def stop(self, reason, kill=True):
        if self.empty_confirmed:
            return  # Do not touch a released/reused identity FD or invent a late cause.
        self.cause = self.cause or reason
        if self.gate is not None:
            fd, self.gate = self.gate, None
            self.close(fd)
        if kill and self.pidfd is not None and not self.signalled:
            self.signalled = True
            pidfd = self.pidfd
            if not exited(pidfd):
                try:
                    signal.pidfd_send_signal(pidfd, signal.SIGKILL)
                except ProcessLookupError:
                    pass  # Neither signal return nor ESRCH substitutes for actual exit/reap/EOF.
                else:
                    self.controlled_stop = (pidfd == self.pidfd and pidfd in self.fds
                                            and self.cause in ['owner-stop', 'cancel', 'run-deadline', 'output-budget'])

    def finish(self):
        if not self.empty():
            self.stop('owner-finally')
            end = time.monotonic() + LIMITS['stopMs'] / 1000
            while not self.empty() and time.monotonic() < end:
                self.pump()
        if not self.empty():
            self.owner.closed = True
            raise RuntimeError('scope unknown; Root must stop the whole physical fixture')
        assert not self.release_attempted
        self.release_attempted = True
        for fd in list(self.fds):
            self.close(fd)
        self.gate = None
        self.selector.close()
        self.spec = self.batch = b''
        self.released = True  # Retained finite raw/results stay charged in the four Owner slots.

    def result(self):
        # Owned SIGKILL can prevent DIRECT emission; complete cleanup proves only range exit.
        stopped_empty = (self.controlled_stop and self.empty() and self.released and not self.fds
                         and not self.fault and not self.failure and not self.cleanup_failure)
        return {'id': self.identity, 'committed': self.committed, 'direct': self.direct,
                'directNotObserved': self.direct is None, 'firstCause': self.cause, 'fault': self.fault,
                'failure': self.failure, 'cleanupFailure': self.cleanup_failure, 'prepared': self.prepared,
                'emptyRecord': self.empty_record, 'actualEmptyReapAllEof': self.empty(), 'ownedFdsClosed': self.released,
                'bwrapReturncode': self.process.returncode if self.process else None, 'metadata': self.metadata,
                'records': self.records, 'observed': self.counts, 'retained': {k: len(v) for k, v in self.buffers.items()},
                'truncated': {k: self.counts[k] > 4096 for k in ['stdout', 'stderr', 'diagnostic']},
                'providerFailure': bool(self.fault or self.failure or self.cleanup_failure
                                        or (self.committed and self.direct is None and not stopped_empty)
                                        or (self.committed and not self.empty_record and not self.signalled))}
