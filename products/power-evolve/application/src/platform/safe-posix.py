"""One-shot, descriptor-relative POSIX workspace operations for FileService.

Node has no portable openat/renameat API. This helper receives one bounded JSON
request on stdin, never inherits platform secrets, and emits one JSON response.
Every user-controlled path component is opened relative to a retained directory
descriptor with O_NOFOLLOW. The caller must validate identity and hold its PG
write lock; this process only enforces filesystem containment.
"""

import base64
import datetime
import errno
import hashlib
import json
import os
import secrets
import stat
import sys
import unicodedata

MAX_BYTES = 32 * 1024 * 1024
MAX_ITEMS = 200
MAX_SCANNED = 10000
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC


class Refusal(Exception):
    def __init__(self, code):
        self.code = code


def component(value):
    if not isinstance(value, str) or not value or value in ('.', '..') \
            or len(value.encode('utf-16-le', 'surrogatepass')) // 2 > 100 \
            or unicodedata.normalize('NFC', value) != value \
            or '/' in value or '\\' in value \
            or any(ord(c) < 32 or ord(c) == 127 or 0xd800 <= ord(c) <= 0xdfff for c in value):
        raise Refusal('invalid_path')
    return value


def segments(value):
    if not isinstance(value, list) or len(value) > 16:
        raise Refusal('invalid_path')
    return [component(part) for part in value]


def directory(fd, name, create=False, owner=None):
    made = False
    if create:
        try:
            os.mkdir(name, 0o700, dir_fd=fd)
            made = True
        except FileExistsError:
            pass
    try:
        next_fd = os.open(name, DIRECTORY_FLAGS, dir_fd=fd)
    except OSError as error:
        if error.errno in (errno.ELOOP, errno.ENOTDIR):
            raise Refusal('invalid_path') from error
        raise
    if made and owner is not None:
        try:
            os.fchown(next_fd, owner['uid'], owner['gid'])
        except BaseException:
            os.close(next_fd)
            raise
    return next_fd


def root_fd(path):
    if not isinstance(path, str) or not path.startswith('/'):
        raise Refusal('workspace_unavailable')
    fd = os.open('/', DIRECTORY_FLAGS)
    try:
        for part in path.split('/'):
            if part:
                next_fd = directory(fd, component(part))
                os.close(fd)
                fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


def walk(fd, parts, create=False, owner=None):
    try:
        for part in parts:
            next_fd = directory(fd, part, create, owner)
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


def file_bytes(parent_fd, name):
    try:
        fd = os.open(name, FILE_FLAGS, dir_fd=parent_fd)
    except FileNotFoundError:
        return None
    except OSError as error:
        if error.errno in (errno.ELOOP, errno.ENOTDIR):
            raise Refusal('invalid_path') from error
        raise
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise Refusal('invalid_path')
        if info.st_size > MAX_BYTES:
            raise Refusal('file_too_large')
        data = bytearray()
        while len(data) <= MAX_BYTES:
            chunk = os.read(fd, min(65536, MAX_BYTES + 1 - len(data)))
            if not chunk:
                return bytes(data)
            data.extend(chunk)
        raise Refusal('file_too_large')
    finally:
        os.close(fd)


def parent_fd(workspace_fd, parts, create=False, owner=None):
    return walk(os.dup(workspace_fd), parts[:-1], create, owner)


def empty_directories(fd, parts):
    selected = None
    with os.scandir(fd) as listing:
        for entry in listing:
            if not parts or selected is not None or entry.name != parts[0] \
                    or not entry.is_dir(follow_symlinks=False):
                return False
            selected = entry.name
    if selected is None:
        return True
    child = directory(fd, selected)
    try:
        return empty_directories(child, parts[1:])
    finally:
        os.close(child)


def put(workspace_fd, parts, request, owner):
    parent = parent_fd(workspace_fd, parts, True, owner)
    try:
        target_digest = request['digest']
        current = file_bytes(parent, parts[-1])
        if current is not None:
            if hashlib.sha256(current).hexdigest() == target_digest:
                return {'written': False}
            raise Refusal('file_exists')
        data = base64.b64decode(request['data'], validate=True)
        if len(data) > MAX_BYTES or hashlib.sha256(data).hexdigest() != target_digest:
            raise Refusal('invalid_file_data')
        temporary = '.pe-' + secrets.token_hex(16) + '.tmp'
        fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC,
                     0o600, dir_fd=parent)
        try:
            try:
                with os.fdopen(fd, 'wb', closefd=False) as stream:
                    stream.write(data)
                    stream.flush()
                if owner is not None:
                    os.fchown(fd, owner['uid'], owner['gid'])
                os.fsync(fd)
            finally:
                os.close(fd)
            try:
                os.link(temporary, parts[-1], src_dir_fd=parent, dst_dir_fd=parent,
                        follow_symlinks=False)
            except FileExistsError:
                raise Refusal('file_exists')
            os.fsync(parent)
        finally:
            try:
                os.unlink(temporary, dir_fd=parent)
            except FileNotFoundError:
                pass
        return {'written': True}
    finally:
        os.close(parent)


def execute(request):
    if sys.version_info < (3, 9) or os.name != 'posix' or not hasattr(os, 'O_NOFOLLOW') \
            or not hasattr(os, 'O_DIRECTORY') \
            or not all(function in os.supports_dir_fd for function in
                       (os.open, os.mkdir, os.stat, os.rename, os.unlink)) \
            or os.scandir not in os.supports_fd:
        raise Refusal('workspace_unavailable')
    operation = request.get('op')
    owner = request.get('owner')
    if owner is not None and (not isinstance(owner, dict) or not isinstance(owner.get('uid'), int)
                              or not isinstance(owner.get('gid'), int)):
        raise Refusal('workspace_unavailable')
    fd = root_fd(request.get('root'))
    if operation == 'probe':
        os.close(fd)
        return {'ready': True, 'python': sys.version.split()[0]}
    workspace_id = component(request.get('workspaceId'))
    try:
        if operation == 'ensure_workspace':
            workspace = directory(fd, workspace_id, True, owner)
            if owner is not None:
                os.fchown(workspace, owner['uid'], owner['gid'])
            os.close(workspace)
            os.close(fd)
            return {}
        workspace = directory(fd, workspace_id)
        workspace = walk(workspace, segments(request.get('rootParts', [])))
    except Refusal as error:
        os.close(fd)
        raise Refusal('workspace_unavailable') from error
    except OSError as error:
        os.close(fd)
        if error.errno == errno.ENOENT:
            if operation == 'directory_probe':
                return {'exists': False}
            if operation == 'empty':
                return {'empty': True}
            raise Refusal('workspace_unavailable') from error
        raise
    os.close(fd)
    parts = segments(request.get('parts'))
    try:
        if operation == 'empty':
            return {'empty': empty_directories(workspace, parts)}
        if operation == 'directory_probe':
            try:
                selected = walk(os.dup(workspace), parts)
            except FileNotFoundError:
                return {'exists': False}
            os.close(selected)
            return {'exists': True}
        if operation == 'create_directory':
            parent = walk(os.dup(workspace), parts)
            try:
                selected = directory(parent, component(request['name']), True, owner)
                os.close(selected)
            finally:
                os.close(parent)
            return {}
        if operation == 'directories':
            listed = walk(os.dup(workspace), parts)
            names = []
            try:
                with os.scandir(listed) as listing:
                    for count, entry in enumerate(listing):
                        if count >= MAX_SCANNED:
                            raise Refusal('directory_too_large')
                        try:
                            component(entry.name)
                            if stat.S_ISDIR(entry.stat(follow_symlinks=False).st_mode):
                                names.append(entry.name)
                        except (FileNotFoundError, Refusal):
                            continue
            finally:
                os.close(listed)
            names.sort()
            remaining = [name for name in names if request.get('after') is None or name > request['after']]
            limit = request['limit']
            if not isinstance(limit, int) or limit < 1 or limit > MAX_ITEMS:
                raise Refusal('invalid_path')
            return {'names': remaining[:limit], 'more': len(remaining) > limit}
        if operation == 'kind':
            if not parts:
                return {'kind': 'directory'}
            parent = parent_fd(workspace, parts)
            try:
                info = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
            finally:
                os.close(parent)
            if stat.S_ISDIR(info.st_mode):
                return {'kind': 'directory'}
            if stat.S_ISREG(info.st_mode):
                return {'kind': 'file'}
            raise Refusal('invalid_path')
        if operation == 'read':
            try:
                parent = parent_fd(workspace, parts)
            except FileNotFoundError:
                return {'data': None}
            try:
                data = file_bytes(parent, parts[-1])
                return {'data': None if data is None else base64.b64encode(data).decode('ascii')}
            finally:
                os.close(parent)
        if operation == 'list':
            try:
                listed = walk(os.dup(workspace), parts)
            except FileNotFoundError:
                return {'missing': True, 'items': []}
            items = []
            scanned = 0
            try:
                with os.scandir(listed) as listing:
                    for entry in listing:
                        scanned += 1
                        if scanned > MAX_SCANNED:
                            raise Refusal('directory_too_large')
                        try:
                            info = entry.stat(follow_symlinks=False)
                        except FileNotFoundError:
                            continue
                        if not stat.S_ISDIR(info.st_mode) and not stat.S_ISREG(info.st_mode):
                            continue
                        if len(items) >= MAX_ITEMS:
                            raise Refusal('directory_too_large')
                        updated = datetime.datetime.fromtimestamp(info.st_mtime, datetime.timezone.utc)
                        items.append({'name': entry.name, 'kind': 'directory' if stat.S_ISDIR(info.st_mode) else 'file',
                                      'size': info.st_size if stat.S_ISREG(info.st_mode) else None,
                                      'updatedAt': updated.isoformat(timespec='milliseconds').replace('+00:00', 'Z')})
            finally:
                os.close(listed)
            return {'missing': False, 'items': items}
        if operation == 'put':
            return put(workspace, parts, request, owner)
        raise Refusal('workspace_unavailable')
    finally:
        os.close(workspace)


def main():
    """Read one bounded Cloud request; imports perform no stdin or filesystem work."""
    try:
        payload = sys.stdin.buffer.read(48 * 1024 * 1024 + 1)
        if len(payload) > 48 * 1024 * 1024:
            raise Refusal('invalid_file_data')
        result = execute(json.loads(payload))
        sys.stdout.write(json.dumps({'ok': True, 'value': result}, separators=(',', ':')))
    except Refusal as error:
        sys.stdout.write(json.dumps({'ok': False, 'code': error.code}, separators=(',', ':')))
    except FileNotFoundError:
        sys.stdout.write('{"ok":false,"code":"file_not_found"}')
    except OSError as error:
        code = 'invalid_path' if error.errno in (errno.ELOOP, errno.ENOTDIR) else 'workspace_unavailable'
        sys.stdout.write(json.dumps({'ok': False, 'code': code}, separators=(',', ':')))
    except (ValueError, KeyError, TypeError, UnicodeError):
        sys.stdout.write('{"ok":false,"code":"workspace_unavailable"}')


if __name__ == '__main__':
    main()
