"""PTY and foreground control owned only by the original namespace guardian; the user never receives this control FD."""
import errno
import fcntl
import json
import os
import select
import signal
import struct
import subprocess
import termios


def process_facts():
    result = []
    for name in os.listdir('/proc'):
        if not name.isdecimal():
            continue
        try:
            with open('/proc/' + name + '/stat') as file:
                raw = file.read(4096)
            fields = raw[raw.rfind(')') + 2:].split()
            result.append((int(name), fields[0], int(fields[2]), int(fields[3])))
        except FileNotFoundError:
            continue
    return result


def foreground(master, terminal_device):
    group = os.tcgetpgrp(master)
    if group <= 1:
        return None
    members = [pid for pid, state, pgid, _ in process_facts() if pgid == group and state not in ['Z', 'X']]
    waiting = False
    for pid in members:
        try:
            with open('/proc/' + str(pid) + '/wchan') as file:
                wait = file.read(256).strip()
            if wait in ['n_tty_read', 'tty_read', 'wait_woken'] and os.stat('/proc/' + str(pid) + '/fd/0').st_rdev == terminal_device:
                waiting = True
        except FileNotFoundError:
            continue
    # Prompt readiness remains in Native LocalPtySession; absence of a kernel wait fact is not idle.
    return {'processGroupId': group, 'inputWaiting': waiting}


def run(argv, env, stdin, stdout, stderr, control, status, dimensions, limits, emit, tags):
    spawned, direct, empty = tags
    master, slave = os.openpty()
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', dimensions['rows'], dimensions['cols'], 0, 0))
    def setup():
        os.setsid()
        fcntl.ioctl(0, termios.TIOCSCTTY, 0)
        limits()
    child = subprocess.Popen(argv, executable=argv[0], env=env, stdin=slave, stdout=slave, stderr=slave,
                             close_fds=True, preexec_fn=setup)
    terminal_device = os.fstat(slave).st_rdev
    os.close(slave)
    os.close(stderr)
    emit(status, spawned, child.pid)
    pending_out, pending_in, pending_control, requests = bytearray(), bytearray(), bytearray(), bytearray()
    pending_control.extend(json.dumps({'ready': child.pid}, separators=(',', ':')).encode() + b'\n')
    for fd in [master, stdin, stdout, control]:
        os.set_blocking(fd, False)
    master_eof = input_eof = False
    generation = 0
    try:
        while True:
            all_reaped = False
            while True:
                try:
                    pid, outcome = os.waitpid(-1, os.WNOHANG)
                except ChildProcessError:
                    all_reaped = True
                    break
                if not pid:
                    break
                if pid == child.pid:
                    child.returncode = os.waitstatus_to_exitcode(outcome)
                    emit(status, direct, pid, outcome)
            if all_reaped and master_eof and not pending_out and not pending_control:
                emit(status, empty)
                return
            reads = ([master] if not master_eof and len(pending_out) < 65536 else []) + ([stdin] if not input_eof and len(pending_in) < 4096 else [])
            if len(pending_control) < 4096:
                reads.append(control)
            writes = ([stdout] if pending_out else []) + ([master] if pending_in and not master_eof else []) + ([control] if pending_control else [])
            readable, writable, _ = select.select(reads, writes, [], 0.01)
            for fd in writable:
                pending = pending_out if fd == stdout else pending_in if fd == master else pending_control
                count = os.write(fd, pending[:4096])
                assert count > 0
                del pending[:count]
            for fd in readable:
                try:
                    data = os.read(fd, min(4096, 65536 - len(pending_out)) if fd == master else 4096)
                except OSError as error:
                    if fd != master or error.errno != errno.EIO:
                        raise
                    data = b''
                if fd == master:
                    if data:
                        pending_out.extend(data)
                    else:
                        master_eof = True
                elif fd == stdin:
                    if data:
                        generation += 1
                        pending_in.extend(data)
                        assert len(pending_in) <= 8192
                    else:
                        input_eof = True
                else:
                    assert data, 'terminal control closed while original range remains active'
                    requests.extend(data)
                    assert len(requests) <= 4096
                    while b'\n' in requests:
                        line, _, tail = requests.partition(b'\n')
                        requests[:] = tail
                        request = json.loads(line)
                        assert type(request) is dict and set(request) == {'id', 'method', 'args'}
                        assert type(request['id']) is int and 0 <= request['id'] < 0xffffffff
                        method, args = request['method'], request['args']
                        assert type(args) is list
                        if method == 'foreground':
                            assert not args
                            value = None if master_eof else foreground(master, terminal_device)
                        elif method == 'activity':
                            assert not args
                            value = {'state': 'unknown', 'generation': generation}
                        elif method == 'resize':
                            assert len(args) == 2 and all(type(x) is int and 1 <= x <= 65535 for x in args)
                            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', args[1], args[0], 0, 0))
                            value = None
                        elif method == 'signal':
                            assert len(args) == 1 and args[0] in ['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGTSTP', 'SIGHUP']
                            group = os.tcgetpgrp(master)
                            assert group > 1
                            os.killpg(group, getattr(signal, args[0]))
                            generation += 1
                            value = group
                        else:
                            raise ValueError('terminal method refused')
                        pending_control.extend(json.dumps({'id': request['id'], 'value': value}, separators=(',', ':')).encode() + b'\n')
                        assert len(pending_control) <= 4096
    finally:
        for fd in [master, stdin, stdout, control]:
            os.close(fd)
