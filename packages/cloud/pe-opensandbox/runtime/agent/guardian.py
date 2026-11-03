"""PRIVATE UNEXECUTED. bwrap 0.11.2 is setup authority; this fixed program is PID1 only."""
import ctypes
import errno
import json
import os
import resource
import signal
import struct
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
from paths import enter_cwd, verify_skill_world, verify_file_policy
from wire import LIMITS, file_policy, stream_spec, environment

RECORD = struct.Struct('!4sB3xii')
PREPARED, SPAWNED, DIRECT, EMPTY, ERROR = range(1, 6)


def emit(fd, tag, a=0, b=0):
    data = RECORD.pack(b'S4B1', tag, a, b)
    if os.write(fd, data) != len(data):
        raise OSError(errno.EIO, 'short trusted record')


def child_limits():
    for sig in [signal.SIGINT, signal.SIGTERM, signal.SIGPIPE]:
        signal.signal(sig, signal.SIG_DFL)
    for kind, value in [(resource.RLIMIT_CPU, LIMITS['childCpuSeconds']),
                        (resource.RLIMIT_AS, LIMITS['childAddressBytes']),
                        (resource.RLIMIT_FSIZE, LIMITS['childFileBytes']),
                        (resource.RLIMIT_NOFILE, LIMITS['childOpenFiles']),
                        (resource.RLIMIT_NPROC, LIMITS['childProcesses']),
                        (resource.RLIMIT_CORE, LIMITS['childCoreBytes'])]:
        resource.setrlimit(kind, (value, value))


def install_control_fd(control, descriptors):
    """Relocate an original private fd7 before exposing only the reviewed control endpoint at child fd7."""
    descriptors = list(descriptors)
    if control != 7:
        if 7 in descriptors:
            replacement = os.dup(7)
            descriptors = [replacement if fd == 7 else fd for fd in descriptors]
            os.close(7)
        os.dup2(control, 7, inheritable=False)
        os.close(control)
    return tuple(descriptors)


def main(config, status, gate, stdin, stdout, stderr, control=None):
    stage = 1
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(4, 0, 0, 0, 0) != 0 or libc.prctl(3, 0, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), 'dumpable0 required')
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGCHLD, signal.SIG_DFL)
        stage = 2
        assert os.getpid() == 1 and os.getresuid() == os.getresgid() == (0, 0, 0) and not os.getgroups()
        assert os.readlink('/proc/self') == '1' and os.statvfs('/').f_flag & os.ST_RDONLY
        with open('/proc/self/status') as f:
            facts = dict(x.split(':', 1) for x in f if ':' in x)
        assert all(int(facts[k], 16) == 0 for k in ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'])
        assert facts['NoNewPrivs'].strip() == '1'
        stage = 3
        raw = os.read(config, 4097)
        assert len(raw) <= 4096 and not os.read(config, 1)
        os.close(config)
        spec = json.loads(raw)
        stdin_mode = spec['stdinMode']
        pipes = spec.get('executionKind') == 'pipes'
        assert type(stdin_mode) is str and stdin_mode in (['ignore', 'batch', 'pipe'] if pipes else ['ignore', 'batch'])
        if pipes:
            fixed = stream_spec(spec['stream'])
            assert (fixed['control'] == 'pipe') == (control is not None)
            assert all(value is not None for value in environment(spec['env']).values())
        else:
            assert 'executionKind' not in spec and 'stream' not in spec and control is None
        for path, expected in spec['roots'].items():
            st = os.stat(path)
            assert [st.st_dev, st.st_ino] == expected
        enter_cwd(spec['projectRoot'], spec['cwd'], spec['roots'][spec['projectRoot']])
        mode = 'workspace-write'
        if 'filePolicy' in spec:
            mode = file_policy(spec['filePolicy'])['mode']
            verify_file_policy(spec['projectRoot'], mode)
        if 'skillWorld' in spec:
            verify_skill_world(spec['projectRoot'], spec['roots'][spec['projectRoot']], spec['skillWorld'], mode)
        stage = 4
        if control is not None:
            status, gate, stdin, stdout, stderr = install_control_fd(control, (status, gate, stdin, stdout, stderr))
            control = 7
        live = set()
        for name in os.listdir('/proc/self/fd'):
            try:
                os.fstat(int(name))
                live.add(int(name))
            except OSError as e:
                assert e.errno == errno.EBADF
        assert live == {0, 1, 2, status, gate, stdin, stdout, stderr} | (set() if control is None else {control})
        emit(status, PREPARED)  # Setup and dumpable0 checked; no user child yet.
        if os.read(gate, 1) != b'C':
            emit(status, EMPTY)
            return
        os.close(gate)  # EOF never authorizes a user fork. Root stops via the held init pidfd.
        stage = 5
        user_stdin = stdin
        if stdin_mode == 'ignore':
            os.close(stdin)
            user_stdin = subprocess.DEVNULL
        child_env = dict(spec['env'])
        if pipes and 'terminal' in fixed:
            from terminal import run
            run(spec['argv'], child_env, stdin, stdout, stderr, control, status,
                fixed['terminal'], child_limits, emit, (SPAWNED, DIRECT, EMPTY))
            return

        if control is not None:
            child_env['DSH_SUBPROCESS_CONTROL'] = 'pipe'
        child = subprocess.Popen(spec['argv'], executable=spec['argv'][0], cwd=None, env=child_env,
                                 stdin=user_stdin, stdout=stdout, stderr=stderr, close_fds=True,
                                 pass_fds=() if control is None else (7,),
                                 start_new_session=True, preexec_fn=child_limits)
        for fd in ([stdin] if stdin_mode in ['batch', 'pipe'] else []) + [stdout, stderr] + ([] if control is None else [control]):
            os.close(fd)
        emit(status, SPAWNED, child.pid)
        stage = 6
        while True:
            try:
                pid, outcome = os.waitpid(-1, 0)
            except ChildProcessError:
                emit(status, EMPTY)
                return
            if pid == child.pid:
                assert os.WIFEXITED(outcome) or os.WIFSIGNALED(outcome)
                child.returncode = os.waitstatus_to_exitcode(outcome)
                emit(status, DIRECT, pid, outcome)
    except BaseException as e:
        emit(status, ERROR, stage, e.errno if isinstance(e, OSError) else 0)
        # Real PID1 exit empties this namespace; Root still requires actual exit/reap/all EOF.


if __name__ == '__main__':
    if len(sys.argv) not in [7, 8] or not __debug__:
        raise SystemExit(125)
    main(*(int(x) for x in sys.argv[1:]))
    os._exit(0)
