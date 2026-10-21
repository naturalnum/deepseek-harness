"""Bounded Root path policy and guardian cwd acquisition; no resources at import."""
import os
import posixpath
import stat

ENV_ROOT = '/opt/session-env'
ENV = {'PATH': ENV_ROOT + '/venv/bin:/usr/local/bin:/usr/bin:/bin',
       'HOME': ENV_ROOT + '/home', 'TMPDIR': ENV_ROOT + '/tmp', 'LANG': 'C.UTF-8'}
RESERVED = [ENV_ROOT, '/trusted', '/root-secret', '/proc', '/sys', '/dev', '/tmp',
            '/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/root']


def absolute(path):
    try:
        valid = (type(path) is str and path.startswith('/') and not path.startswith('//')
                 and posixpath.normpath(path) == path and len(path.encode('utf-8')) <= 512
                 and all(ord(c) >= 32 and ord(c) != 127 for c in path))
    except UnicodeError:
        valid = False
    if not valid:
        raise ValueError('canonical absolute path required')
    return path


def beneath(root, path):
    return path == root or path.startswith(root + '/')


def project_path(path):
    absolute(path)
    if path == '/' or any(beneath(root, path) or beneath(path, root) for root in RESERVED):
        raise ValueError('project overlaps protected world')
    return path


def checked_cwd(project, cwd):
    project_path(project); absolute(cwd)
    if not beneath(project, cwd):
        raise ValueError('cwd outside project')
    return cwd


def enter_cwd(project, cwd, expected):
    """Before PREPARED: no symlinks/cross-device dirs; retain actual directory as cwd."""
    checked_cwd(project, cwd)
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    fd = os.open(project, flags)
    try:
        root = os.fstat(fd)
        if not stat.S_ISDIR(root.st_mode) or [root.st_dev, root.st_ino] != expected:
            raise ValueError('project identity changed')
        parts = cwd[len(project):].strip('/').split('/') if cwd != project else []
        for part in parts:
            child = os.open(part, flags, dir_fd=fd)
            previous, fd = fd, child
            os.close(previous)  # Each descriptor closed once; failure aborts this guardian.
            current = os.fstat(fd)
            if not stat.S_ISDIR(current.st_mode) or current.st_dev != root.st_dev:
                raise ValueError('cwd crossed project filesystem')
        os.fchdir(fd)
        current = os.stat('.')
        held = os.fstat(fd)
        if os.getcwd() != cwd or (current.st_dev, current.st_ino) != (held.st_dev, held.st_ino):
            raise ValueError('cwd canonical identity changed')
    finally:
        os.close(fd)
    # cwd itself holds the directory. No path is reopened at commit; no cwd FD reaches user argv.
