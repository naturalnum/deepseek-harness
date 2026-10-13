"""Unprivileged command directory admission and private Linux PID1 writer cleanup."""
import json
import os
import signal
import sys
import time

MAX_INPUT = 16384
COMMAND_LAUNCH = False
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK


class OutsideWorkspace(Exception):
    pass


def root_descriptor(path):
    if not isinstance(path, str) or not path.startswith('/') or len(path) > 4096:
        raise ValueError('invalid_root')
    descriptor = os.open('/', DIRECTORY)
    try:
        for part in path.split('/'):
            if not part:
                continue
            if part in ('.', '..'):
                raise ValueError('invalid_root')
            child = os.open(part, DIRECTORY, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def cwd_descriptor(root, cwd):
    descriptor = root_descriptor(root)
    try:
        root_path = os.path.realpath(root)
        resolved = os.path.realpath(f'{root}/{cwd}')
        if resolved != root_path and not resolved.startswith(f'{root_path}/'):
            raise OutsideWorkspace()
        relative = '' if resolved == root_path else resolved[len(root_path) + 1:]
        for part in relative.split('/'):
            if part in ('', '.'):
                continue
            if part == '..':
                raise ValueError('invalid_cwd')
            child = os.open(part, DIRECTORY, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def read_proc(pid, name):
    with open(f'/proc/{pid}/{name}', 'rb') as source:
        result = source.read(16385)
    if len(result) > 16384:
        raise ValueError('proc_record_too_large')
    return result


def cleanup_namespace(runner_pid):
    # A host/local Runner cannot authorize a UID sweep. The immutable container CMD is the root PID1 Runner.
    if (sys.platform != 'linux' or os.getuid() != 1000 or os.geteuid() != 1000
            or os.getgid() != 1000 or os.getegid() != 1000 or type(runner_pid) is not int
            or runner_pid != 1 or os.getppid() != 1):
        return False
    try:
        argv = read_proc(1, 'cmdline').split(b'\0')
        uid = next(line for line in read_proc(1, 'status').splitlines() if line.startswith(b'Uid:'))
        if (len(argv) != 3 or argv[0] not in (b'node', b'/usr/local/bin/node')
                or argv[1] != b'/opt/power-evolve/runner.mjs' or argv[2] != b''
                or list(map(int, uid.split()[1:])) != [0, 0, 0, 0]):
            return False
    except (OSError, ValueError, StopIteration):
        return False
    return kill_namespace_users()


def kill_namespace_users():
    import resource
    resource.setrlimit(resource.RLIMIT_AS, (128 * 1024 * 1024, 128 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    resource.setrlimit(resource.RLIMIT_CPU, (3, 3))
    deadline = time.monotonic() + 2.5
    checked = 0
    quiet_passes = 0
    while time.monotonic() < deadline:
        found = False
        with os.scandir('/proc') as processes:
            for count, process in enumerate(processes):
                checked += 1
                if count >= 4096 or checked > 65536 or time.monotonic() >= deadline:
                    return False
                if not process.name.isdecimal() or int(process.name) in (1, os.getpid()):
                    continue
                try:
                    uid = next(line for line in read_proc(int(process.name), 'status').splitlines() if line.startswith(b'Uid:'))
                    ids = list(map(int, uid.split()[1:]))
                    if len(ids) != 4:
                        return False
                    if 1000 not in ids:
                        continue
                    state = read_proc(int(process.name), 'stat').rsplit(b')', 1)[1].split()[0]
                    if state in (b'Z', b'X'):
                        continue
                    found = True
                    # Single active execution, no supported background tasks: all other UID1000 processes are writers.
                    os.kill(int(process.name), signal.SIGKILL)
                except FileNotFoundError:
                    found = True  # A racing process disappearance cannot certify a quiet pass.
                except ProcessLookupError:
                    found = True
                except (OSError, ValueError, IndexError, StopIteration):
                    return False
        quiet_passes = 0 if found else quiet_passes + 1
        if quiet_passes == 2:
            return True
        time.sleep(0.02)
    return False


def main():
    global COMMAND_LAUNCH
    # The production parent fixes UID/GID 1000. Standalone POSIX tests use their non-root UID.
    if os.geteuid() == 0:
        raise PermissionError('unprivileged_helper_required')
    source = sys.stdin.buffer.read(MAX_INPUT + 1)
    if len(source) > MAX_INPUT:
        raise ValueError('invalid_input')
    request = json.loads(source)
    mode = request['mode']
    if mode == 'command':
        COMMAND_LAUNCH = True
        descriptor = cwd_descriptor(request['root'], request['cwd'])
        try:
            os.fchdir(descriptor)
        finally:
            os.close(descriptor)
        os.execve('/bin/bash', ['/bin/bash', '-lc', request['command']], dict(os.environ))
    if mode == 'cwd':
        try:
            descriptor = cwd_descriptor(request['root'], request['cwd'])
            os.close(descriptor)
            return {'valid': True}
        except (OSError, ValueError):
            return {'valid': False, 'status': 400}
        except OutsideWorkspace:
            return {'valid': False, 'status': 403}
    if mode == 'cleanup':
        return {'quiet': cleanup_namespace(request['runnerPid'])}
    raise ValueError('invalid_mode')


if __name__ == '__main__':
    try:
        result = main()
        print(json.dumps(result, ensure_ascii=False, separators=(',', ':')))
    except BaseException:
        # No user path, command, content or exception text crosses the failure channel.
        if COMMAND_LAUNCH:
            print('command_start_failed', file=sys.stderr)
            sys.exit(126)
        print('{"error":"helper_unavailable"}')
        sys.exit(1)
