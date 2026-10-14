#!/usr/bin/env python3
"""Credential-free guest process/PTY byte relay. Only the Platform can open its exec channel.

Every child is subordinate to the original gVisor Pod; relay replies are untrusted data,
never stop evidence. Kubelet observation outside this guest proves whole-range quiescence.
"""
import base64
import errno
import ctypes
import fcntl
import json
import os
import pty
import signal
import socket
import struct
import subprocess
import sys
import termios
import threading

# Payloads must not open the parent's outer transport or forge waitpid metadata through /proc.
# This is supplementary hardening; only the outside kubelet observation proves range stop.
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(4, 0, 0, 0, 0) != 0:
    raise OSError(ctypes.get_errno(), 'PR_SET_DUMPABLE failed')

request = json.loads(sys.argv[1])
maximum = request['maxFrameBytes']
lock = threading.Lock()
finished = threading.Event()
revision = 0
activity = 'unknown'
child_pid = None
master = None
control = None
child = None


def emit(value):
    encoded = json.dumps(value, separators=(',', ':')).encode() + b'\n'
    if len(encoded) > maximum:
        raise ValueError('native relay reply exceeds configured frame bound')
    with lock:
        view = memoryview(encoded)
        while view:
            view = view[os.write(1, view):]


def pump(fd, channel):
    try:
        while True:
            data = os.read(fd, min(8192, maximum // 4))
            if not data:
                break
            emit({'kind': channel, 'data': base64.b64encode(data).decode()})
    except OSError as error:
        if error.errno not in (errno.EIO, errno.EBADF):
            raise
    finally:
        emit({'kind': channel + 'End'})


def snapshot():
    records = []
    for name in os.listdir('/proc'):
        if not name.isdigit():
            continue
        try:
            with open('/proc/' + name + '/stat', 'r', encoding='utf-8') as source:
                raw = source.read(16384)
            values = raw[raw.rfind(')') + 2:].split()
            records.append((int(name), values[0], int(values[2]), int(values[3])))
        except (OSError, ValueError, IndexError):
            continue
    return records


def foreground():
    # The native Linux provider uses the kernel's tpgid stat field as well.
    # runsc does not implement TIOCGPGRP on the PTY master, so inspect the original
    # shell's kernel record instead of synthesizing a group from its PID.
    try:
        with open('/proc/' + str(child_pid) + '/stat', 'r', encoding='utf-8') as source:
            raw = source.read(16384)
        values = raw[raw.rfind(')') + 2:].split()
        group = int(values[5])
    except (OSError, ValueError, IndexError):
        return None
    if group <= 0:
        return None
    # Positive input-wait evidence only; unsupported runsc wchan observations stay false.
    waiting = False
    members = [pid for pid, state, pgid, session in snapshot() if pgid == group and state != 'Z']
    for pid in members:
        try:
            with open('/proc/' + str(pid) + '/wchan', 'r', encoding='utf-8') as source:
                channel = source.read(256).strip()
            waiting = waiting or channel in ('n_tty_read', 'tty_read', 'wait_woken')
        except OSError:
            pass
    return {'processGroupId': group, 'inputWaiting': waiting}


def inspect_activity():
    members = [(pid, state, pgid) for pid, state, pgid, session in snapshot()
               if session == child_pid and pid != child_pid and state != 'Z']
    return {'state': 'busy' if members else activity, 'revision': revision}


def observe_shell(fd):
    global revision, activity
    with os.fdopen(fd, 'rb', buffering=0) as source:
        while True:
            line = source.readline(256)
            if not line:
                return
            try:
                pid, sequence, state = line.decode().strip().split(':')
                if int(pid) == child_pid and state in ('idle', 'busy', 'unknown'):
                    with lock:
                        revision += 1
                        activity = state
            except (ValueError, UnicodeDecodeError):
                pass


def terminate():
    try:
        os.killpg(child_pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    if not finished.wait(request['graceMs'] / 1000):
        try:
            os.killpg(child_pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def receive():
    global revision, activity
    pending = b''
    while not finished.is_set():
        while b'\n' not in pending:
            chunk = os.read(0, min(4096, maximum))
            if not chunk:
                terminate()
                return
            pending += chunk
            if len(pending) > maximum:
                terminate()
                return
        raw, pending = pending.split(b'\n', 1)
        raw += b'\n'
        if not raw:
            terminate()
            return
        if len(raw) > maximum or not raw.endswith(b'\n'):
            terminate()
            return
        command = json.loads(raw)
        operation = command['op']
        result = None
        try:
            if operation == 'stdin':
                data = base64.b64decode(command['data'], validate=True)
                if master is not None:
                    with lock:
                        revision += 1
                        activity = 'unknown'
                    os.write(master, data)
                elif child.stdin is not None:
                    child.stdin.write(data)
                    child.stdin.flush()
                else:
                    raise ValueError('stdin unavailable')
            elif operation == 'stdinEnd':
                if child is not None and child.stdin is not None:
                    child.stdin.close()
            elif operation == 'control':
                if control is None:
                    raise ValueError('control unavailable')
                control.sendall(base64.b64decode(command['data'], validate=True))
            elif operation == 'controlEnd':
                if control is not None:
                    control.shutdown(socket.SHUT_WR)
            elif operation == 'resize':
                fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', command['rows'], command['cols'], 0, 0))
            elif operation == 'foreground':
                result = foreground()
            elif operation == 'activity':
                result = inspect_activity()
            elif operation == 'signal':
                if command['signal'] not in ('SIGINT', 'SIGTERM', 'SIGKILL', 'SIGTSTP', 'SIGHUP'):
                    raise ValueError('unsupported foreground signal')
                current = foreground()
                if current is None:
                    raise ValueError('foreground unavailable')
                os.killpg(current['processGroupId'], getattr(signal, command['signal']))
                with lock:
                    revision += 1
                    activity = 'unknown'
                result = current['processGroupId']
            elif operation == 'terminate':
                threading.Thread(target=terminate, daemon=True).start()
            else:
                raise ValueError('unknown relay operation')
            if 'id' in command:
                emit({'kind': 'reply', 'id': command['id'], 'ok': True, 'value': result})
        except (OSError, ValueError) as error:
            if 'id' in command:
                emit({'kind': 'reply', 'id': command['id'], 'ok': False, 'error': type(error).__name__ + ':' + str(getattr(error, 'errno', None)) + ':' + operation})
            else:
                terminate()
                return


environment = request['env']
argv = request['argv']
threads = []
if request['terminal']:
    integration = None
    if request.get('shellActivity') and len(argv) == 2 and argv[1] == '-i' and os.path.basename(argv[0]) == 'bash':
        activity_read, activity_write = os.pipe()
        original = os.memfd_create('native-shell-activity', 0)
        integration = fcntl.fcntl(original, fcntl.F_DUPFD, 10)
        os.close(original)
        original = activity_write
        activity_write = fcntl.fcntl(original, fcntl.F_DUPFD, 10)
        os.close(original)
        # These startup hooks are provider lifecycle observation, independent of ordinary PTY output.
        source = '''[[ ! -r ~/.bashrc ]] || builtin source ~/.bashrc
__native_shell_pid=$BASHPID; __native_shell_sequence=0
__native_idle() {
  local result=$? state=idle
  [[ -z $(builtin trap -p) ]] || state=unknown
  if [[ $BASHPID == "$__native_shell_pid" ]]; then
    (( ++__native_shell_sequence ))
    builtin printf '%s:%s:%s\\n' "$BASHPID" "$__native_shell_sequence" "$state" >&9
  fi
  return "$result"
}
if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == "declare -a "* ]]; then
  PROMPT_COMMAND+=(__native_idle)
else
  PROMPT_COMMAND="${PROMPT_COMMAND}"$'\\n'"__native_idle"
fi
PS0+='$(builtin printf "%s:%s:busy\\n" "$__native_shell_pid" "$__native_shell_sequence" >&9)'
'''
        os.write(integration, source.encode())
        os.lseek(integration, 0, os.SEEK_SET)
        argv = [argv[0], '--rcfile', '/proc/self/fd/8', '-i']
    child_pid, master = pty.fork()
    if child_pid == 0:
        if integration is not None:
            os.dup2(integration, 8, inheritable=True)
            os.dup2(activity_write, 9, inheritable=True)
        os.chdir(request['cwd'])
        environment['TERM'] = request['terminalType']
        os.execvpe(argv[0], argv, environment)
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', request['rows'], request['cols'], 0, 0))
    if integration is not None:
        os.close(integration)
        os.close(activity_write)
        threads.append(threading.Thread(target=observe_shell, args=(activity_read,), daemon=True))
    threads.append(threading.Thread(target=pump, args=(master, 'stdout')))
else:
    inherited = ()
    if request['control']:
        control, child_control = socket.socketpair()
        os.dup2(child_control.fileno(), 7, inheritable=True)
        inherited = (7,)
        environment['DSH_SUBPROCESS_CONTROL'] = 'pipe'
    stdin = subprocess.PIPE if request['stdin'] != 'ignore' else subprocess.DEVNULL
    child = subprocess.Popen(argv, cwd=request['cwd'], env=environment, stdin=stdin,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             start_new_session=True, pass_fds=inherited)
    child_pid = child.pid
    if request['control']:
        original = child_control.fileno()
        child_control.close()
        if original != 7:
            os.close(7)
        threads.append(threading.Thread(target=pump, args=(control.fileno(), 'control')))
    threads.extend([threading.Thread(target=pump, args=(child.stdout.fileno(), 'stdout')),
                    threading.Thread(target=pump, args=(child.stderr.fileno(), 'stderr'))])
    if isinstance(request['stdin'], dict):
        child.stdin.write(request['stdin']['data'].encode())
        child.stdin.close()

emit({'kind': 'ready', 'pid': child_pid})
for thread in threads:
    thread.start()
threading.Thread(target=receive, daemon=True).start()
if child is not None:
    result = child.wait()
else:
    waited, status = os.waitpid(child_pid, 0)
    result = os.waitstatus_to_exitcode(status)
finished.set()
# Descendants holding streams remain part of the Pod. The outside controller's deadline/stop
# catches such ranges; never fabricate EOF or an exit proof merely because the top-level exited.
for thread in threads:
    if thread.name != 'observe_shell':
        thread.join()
emit({'kind': 'exit', 'exitCode': result if result >= 0 else None,
      'signal': signal.Signals(-result).name if result < 0 else None})

# Relay-owned daemon input may be blocked in read(0); no Python buffered-I/O finalizers remain.
os._exit(0)
