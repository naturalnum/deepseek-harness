"""Bounded local file access under an authorized directory's retained descriptors.

FD 3 shares the caller's flock open-file description and remains open until exit.
The Cloud helper owns component validation and no-follow descriptor traversal;
this helper adds local root identity and create-only durable publication.
"""

import base64
import errno
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import stat
import sys

spec = importlib.util.spec_from_file_location(
    'power_evolve_safe_posix', Path(__file__).resolve().parent.parent / 'platform' / 'safe-posix.py')
safe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(safe)

MAX_IPC_BYTES = 4 * 1024 * 1024


def relative_parts(value, allow_root=False):
    if allow_root and value == '.':
        return []
    if not isinstance(value, str) or not value or value.startswith('/'):
        raise safe.Refusal('invalid_path')
    return safe.segments(value.split('/'))


def identity(info):
    return {'dev': str(info.st_dev), 'ino': str(info.st_ino)}


def retain_lock():
    try:
        info = os.fstat(3)
        if not stat.S_ISREG(info.st_mode):
            raise safe.Refusal('local_files_lock_required')
        # The inherited description must hold exclusion throughout the helper,
        # even if its Node owner dies. Never issue LOCK_UN on this shared lock.
        fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as error:
        raise safe.Refusal('local_files_lock_required') from error


def create(root, parts, encoded):
    if not isinstance(encoded, str):
        raise safe.Refusal('invalid_file_data')
    try:
        data = base64.b64decode(encoded, validate=True)
    except (ValueError, UnicodeError) as error:
        raise safe.Refusal('invalid_file_data') from error
    if len(data) > safe.MAX_BYTES:
        raise safe.Refusal('file_too_large')
    if base64.b64encode(data).decode('ascii') != encoded:
        raise safe.Refusal('invalid_file_data')
    parent = safe.walk(os.dup(root), parts[:-1])
    temporary = '.pe-' + secrets.token_hex(16) + '.tmp'
    made = False
    try:
        fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC,
                     0o600, dir_fd=parent)
        made = True
        try:
            with os.fdopen(fd, 'wb', closefd=False) as stream:
                stream.write(data)
                stream.flush()
            os.fsync(fd)
        finally:
            os.close(fd)
        try:
            os.link(temporary, parts[-1], src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
        except FileExistsError as error:
            raise safe.Refusal('file_exists') from error
        os.unlink(temporary, dir_fd=parent)
        made = False
        os.fsync(parent)
        return {}
    finally:
        if made:
            try:
                os.unlink(temporary, dir_fd=parent)
            except FileNotFoundError:
                pass
        os.close(parent)


def execute(request):
    if os.name != 'posix' or sys.version_info < (3, 9):
        raise safe.Refusal('local_files_unavailable')
    operation = request.get('op')
    if operation not in ('inspect', 'read', 'create'):
        raise safe.Refusal('local_files_unavailable')
    parts = relative_parts(request.get('relative'), operation == 'inspect')
    if operation != 'inspect':
        retain_lock()
    root = safe.root_fd(request.get('root'))
    try:
        actual = identity(os.fstat(root))
        if operation == 'inspect':
            selected = safe.walk(os.dup(root), parts)
            os.close(selected)
            return actual
        expected = request.get('identity')
        if not isinstance(expected, dict) or set(expected) != {'dev', 'ino'} \
                or any(not isinstance(expected[key], str) or not expected[key].isascii()
                       or not expected[key].isdecimal() for key in ('dev', 'ino')) \
                or actual != expected:
            raise safe.Refusal('directory_identity_changed')
        if operation == 'create':
            return create(root, parts, request.get('base64'))
        parent = safe.walk(os.dup(root), parts[:-1])
        try:
            data = safe.file_bytes(parent, parts[-1])
            if data is None:
                raise safe.Refusal('file_not_found')
            return {'base64': base64.b64encode(data).decode('ascii'),
                    'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)}
        finally:
            os.close(parent)
    finally:
        os.close(root)


def main():
    """Consume one bounded request and emit only response data or a safe category."""
    try:
        payload = sys.stdin.buffer.read(MAX_IPC_BYTES + 1)
        if len(payload) > MAX_IPC_BYTES:
            raise safe.Refusal('invalid_file_data')
        value = execute(json.loads(payload))
        response = {'ok': True, 'value': value}
    except safe.Refusal as error:
        response = {'ok': False, 'code': error.code}
    except FileNotFoundError:
        response = {'ok': False, 'code': 'file_not_found'}
    except OSError as error:
        code = 'invalid_path' if error.errno in (errno.ELOOP, errno.ENOTDIR) else 'local_files_unavailable'
        response = {'ok': False, 'code': code}
    except (ValueError, KeyError, TypeError, UnicodeError):
        response = {'ok': False, 'code': 'local_files_unavailable'}
    try:
        sys.stdout.write(json.dumps(response, separators=(',', ':')))
        sys.stdout.flush()
    except BrokenPipeError:
        # A dead caller has no response sink; FD 3 still stays held through exit.
        os._exit(1)


if __name__ == '__main__':
    main()
