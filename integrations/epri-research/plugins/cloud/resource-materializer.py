"""Copy one approved bounded resource batch through the current managed project mount."""
import base64
import hashlib
import json
import os
import stat
import sys
import uuid

payload = json.load(sys.stdin)
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
root = os.open(payload['workspace'], flags)


def descend(parent, segments):
    current = os.dup(parent)
    try:
        for name in segments:
            try:
                os.mkdir(name, 0o700, dir_fd=current)
            except FileExistsError:
                pass
            child = os.open(name, flags, dir_fd=current)
            os.close(current)
            current = child
        return current
    except BaseException:
        os.close(current)
        raise


results = []
try:
    base = descend(root, payload['destination'].split('/'))
    try:
        for item in payload['files']:
            components = item['path'].split('/')
            if any(not p or p in ('.', '..') or '\\' in p for p in components):
                raise ValueError('Invalid resource member path')
            parent = descend(base, components[:-1])
            try:
                data = base64.b64decode(item['dataBase64'], validate=True)
                if hashlib.sha256(data).hexdigest() != item['sha256']:
                    raise ValueError('Source resource integrity failed')
                try:
                    existing = os.open(components[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
                except FileNotFoundError:
                    temporary = '.research-copy-' + uuid.uuid4().hex
                    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent)
                    try:
                        with os.fdopen(fd, 'wb') as output:
                            output.write(data)
                            output.flush()
                            os.fsync(output.fileno())
                        try:
                            os.link(temporary, components[-1], src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
                        except FileExistsError:
                            pass
                    finally:
                        os.unlink(temporary, dir_fd=parent)
                    existing = os.open(components[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
                with os.fdopen(existing, 'rb') as existing_file:
                    info = os.fstat(existing_file.fileno())
                    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > payload['maxFileBytes']:
                        raise ValueError('Existing resource is not a bounded regular file')
                    copied = existing_file.read(payload['maxFileBytes'] + 1)
                results.append({'path': item['path'], 'bytes': len(copied), 'sha256': hashlib.sha256(copied).hexdigest(),
                                'modified': copied != data})
            finally:
                os.close(parent)
    finally:
        os.close(base)
finally:
    os.close(root)
print(json.dumps({'files': results}, ensure_ascii=False))
