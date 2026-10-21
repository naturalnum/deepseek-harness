"""Literal nonsecret Root command: claim a fresh private directory exactly once."""
import os
import stat

if os.getuid() != 0 or os.geteuid() != 0 or os.getgid() != 0 or os.getegid() != 0:
    raise RuntimeError('root identity required')
os.umask(0o077)
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW
root = os.open('/', flags)
try:
    item = os.fstat(root)
    if item.st_uid != 0 or item.st_gid != 0 or stat.S_IMODE(item.st_mode) != 0o755:
        raise RuntimeError('root directory refused')
    os.mkdir('root-secret', 0o700, dir_fd=root)
    private = os.open('root-secret', flags, dir_fd=root)
    try:
        item = os.fstat(private)
        if item.st_uid != 0 or item.st_gid != 0 or stat.S_IMODE(item.st_mode) != 0o700:
            raise RuntimeError('private directory refused')
        marker = os.open('s4-bootstrap.claimed', os.O_WRONLY | os.O_CREAT | os.O_EXCL
                         | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600, dir_fd=private)
        try:
            if os.write(marker, b's4-bootstrap/1\n') != 15:
                raise RuntimeError('claim write unconfirmed')
            os.fsync(marker)
        finally:
            os.close(marker)
        os.mkdir('.bootstrap', 0o700, dir_fd=private)
        os.fsync(private)
    finally:
        os.close(private)
    os.fsync(root)
finally:
    os.close(root)
print('s4-bootstrap-claimed', flush=True)
