"""Unprivileged descriptor-relative snapshots, comparison and command-directory admission."""
import hashlib
import json
import math
import os
import signal
import stat
import sys
import time
import unicodedata

MAX_INPUT = 4 * 1024 * 1024 + 16384
MAX_FILE = 2097152
EXCLUDED = {'.git', 'node_modules', '.venv', '__pycache__', '.cache'}
COMMAND_LAUNCH = False
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK
REGULAR = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK


def canonical(path):
    parts = path.split('/')
    units = lambda text: len(text.encode('utf-16-le', 'surrogatepass')) // 2
    return (0 < units(path) <= 512 and '\\' not in path
            and unicodedata.normalize('NFC', path) == path
            and not (len(path) >= 2 and path[0].isascii() and path[0].isalpha() and path[1] == ':')
            and len(parts) <= 16
            and all(0 < units(part) <= 100 and part not in ('.', '..') for part in parts)
            and all(ord(c) > 31 and ord(c) != 127 and not 0xd800 <= ord(c) <= 0xdfff for c in path))


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


def identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


class BudgetExceeded(Exception):
    pass


class OutsideWorkspace(Exception):
    pass


class Snapshot:
    def __init__(self, limits):
        self.limits = limits
        self.deadline = time.monotonic() + limits['timeoutMs'] / 1000
        self.records = {}
        self.reasons = set()
        self.entries = 0
        self.hashed = 0
        self.output_bytes = 512

    def budget(self):
        if time.monotonic() >= self.deadline:
            raise BudgetExceeded()

    def add(self, path, record):
        encoded = len(json.dumps({'path': path, **record}, ensure_ascii=False, separators=(',', ':')).encode('utf8')) + 1
        if self.output_bytes + encoded > self.limits['maxSnapshotBytes']:
            raise BudgetExceeded()
        self.output_bytes += encoded
        self.records[path] = {'path': path, **record}

    def file(self, directory, name, path, observed):
        if observed.st_size > MAX_FILE:
            self.reasons.add('excluded_paths')
            self.add(path, {'kind': 'file', 'sizeBytes': observed.st_size, 'sha256': None})
            return
        if self.hashed + observed.st_size > self.limits['maxHashBytes']:
            self.reasons.add('budget_exceeded')
            self.add(path, {'kind': 'file', 'sizeBytes': observed.st_size, 'sha256': None})
            return
        descriptor = os.open(name, REGULAR, dir_fd=directory)
        try:
            initial = os.fstat(descriptor)
            if not stat.S_ISREG(initial.st_mode) or identity(initial) != identity(observed):
                self.reasons.add('changed_during_scan')
                self.add(path, {'kind': 'unknown'})
                return
            digest = hashlib.sha256()
            size = 0
            while True:
                self.budget()
                chunk = os.read(descriptor, min(65536, MAX_FILE + 1 - size))
                if not chunk:
                    break
                size += len(chunk)
                self.hashed += len(chunk)
                if size > MAX_FILE:
                    self.reasons.add('changed_during_scan')
                    self.add(path, {'kind': 'unknown'})
                    return
                if self.hashed > self.limits['maxHashBytes']:
                    raise BudgetExceeded()
                digest.update(chunk)
            final = os.fstat(descriptor)
            current = os.stat(name, dir_fd=directory, follow_symlinks=False)
            if size != initial.st_size or identity(initial) != identity(final) or identity(final) != identity(current):
                self.reasons.add('changed_during_scan')
                self.add(path, {'kind': 'unknown'})
                return
            self.add(path, {'kind': 'file', 'sizeBytes': size, 'sha256': digest.hexdigest()})
        finally:
            os.close(descriptor)

    def directory(self, descriptor, path):
        before = os.fstat(descriptor)
        self.add(path, {'kind': 'directory', 'complete': False})
        try:
            with os.scandir(descriptor) as entries:
                for entry in entries:
                    self.budget()
                    self.entries += 1
                    if self.entries > self.limits['maxEntries']:
                        raise BudgetExceeded()
                    child_path = f'{path}/{entry.name}' if path else entry.name
                    if entry.name in EXCLUDED or not canonical(child_path):
                        self.reasons.add('excluded_paths')
                        continue
                    try:
                        observed = os.stat(entry.name, dir_fd=descriptor, follow_symlinks=False)
                        if stat.S_ISREG(observed.st_mode) and observed.st_nlink == 1:
                            self.file(descriptor, entry.name, child_path, observed)
                        elif stat.S_ISDIR(observed.st_mode):
                            child = os.open(entry.name, DIRECTORY, dir_fd=descriptor)
                            try:
                                if identity(os.fstat(child)) != identity(observed):
                                    self.reasons.add('changed_during_scan')
                                    self.add(child_path, {'kind': 'unknown'})
                                else:
                                    self.directory(child, child_path)
                            finally:
                                os.close(child)
                        else:
                            self.reasons.add('excluded_paths')
                            self.add(child_path, {'kind': 'other'})
                    except OSError:
                        self.reasons.add('read_failed')
                        # A failed entry cannot be used as evidence that this path was absent.
                        self.add(child_path, {'kind': 'unknown'})
            after = os.fstat(descriptor)
            if identity(before) != identity(after):
                self.reasons.add('changed_during_scan')
            else:
                self.records[path]['complete'] = True
        except BudgetExceeded:
            self.reasons.add('budget_exceeded')
            raise

    def run(self, root):
        try:
            descriptor = root_descriptor(root)
        except (OSError, ValueError):
            return {'version': 1, 'status': 'unavailable', 'records': [], 'reasons': ['scan_unavailable']}
        try:
            self.directory(descriptor, '')
        except BudgetExceeded:
            pass
        except OSError:
            self.reasons.add('read_failed')
        finally:
            os.close(descriptor)
        return {'version': 1, 'status': 'partial' if self.reasons else 'complete',
                'records': list(self.records.values()), 'reasons': sorted(self.reasons)}


def proved_new(path, baseline):
    parent = baseline.get('')
    components = path.split('/')
    for index in range(len(components)):
        prior = baseline.get('/'.join(components[:index + 1]))
        if prior is None:
            return parent is not None and parent.get('kind') == 'directory' and parent.get('complete') is True
        if index == len(components) - 1:
            return prior.get('kind') in ('other', 'directory')
        if prior.get('kind') != 'directory':
            return False
        parent = prior
    return False


def changes(before, after, maximum):
    if before['status'] == 'unavailable' or after['status'] == 'unavailable':
        return {'status': 'unavailable', 'files': [], 'reasons': sorted(set(before['reasons'] + after['reasons'] + ['scan_unavailable']))}
    baseline = {entry['path']: entry for entry in before['records']}
    reasons = set(before['reasons'] + after['reasons'])
    files = []
    for entry in after['records']:
        if entry['kind'] != 'file' or entry.get('sha256') is None:
            continue
        prior = baseline.get(entry['path'])
        changed = (prior is not None and prior.get('kind') == 'file'
                   and (prior['sizeBytes'] != entry['sizeBytes'] or
                        prior.get('sha256') is not None and prior['sha256'] != entry['sha256']))
        if changed or proved_new(entry['path'], baseline):
            files.append({'path': entry['path'], 'sizeBytes': entry['sizeBytes'], 'sha256': entry['sha256']})
    if len(files) > maximum:
        reasons.add('budget_exceeded')
    return {'status': 'partial' if reasons else 'complete', 'files': sorted(files, key=lambda file: file['path'])[:maximum],
            'reasons': sorted(reasons)}


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
    limits = request['limits']
    if sys.platform == 'linux':
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (128 * 1024 * 1024, 128 * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
        seconds = math.ceil(limits['timeoutMs'] / 1000) + 1
        resource.setrlimit(resource.RLIMIT_CPU, (seconds, seconds))
    after = Snapshot(limits).run(request['root'])
    return after if mode == 'snapshot' else changes(request['before'], after, limits['maxFiles'])


if __name__ == '__main__':
    try:
        result = main()
        print(json.dumps(result, ensure_ascii=False, separators=(',', ':')))
    except BaseException:
        # No user path, command, content or exception text crosses the failure channel.
        if COMMAND_LAUNCH:
            print('command_start_failed', file=sys.stderr)
            sys.exit(126)
        print('{"status":"unavailable","files":[],"reasons":["scan_unavailable"]}')
        sys.exit(1)
