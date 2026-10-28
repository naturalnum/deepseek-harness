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


def open_skill_world(project, expected_root, value, owned_fds):
    from wire import skill_world
    fixed = skill_world(value)
    max_copies = fixed['maxCopies']
    grant = {'metadata': [int(fixed['metadata'][k]) for k in ['device','inode']],
             'skills': [int(fixed['skills'][k]) for k in ['device','inode']],
             'copies': [{'version': c['version'], 'identity': [int(c['identity'][k]) for k in ['device','inode']]} for c in fixed['copies']]}
    """Borrow canonical fixed-copy source FDs into the original operation FD set."""
    import re
    if (type(grant) is not dict or set(grant) != {'metadata', 'skills', 'copies'}
            or type(max_copies) is not int or not 1 <= max_copies <= 2147483647
            or type(grant['copies']) is not list or not 0 <= len(grant['copies']) <= max_copies):
        raise ValueError('fixed skill world grant required')
    project_path(project)
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC

    def take(path, parent=None):
        fd = os.open(path, flags, dir_fd=parent)
        owned_fds.add(fd)  # Caller closes once, including failed checks; cancellation is not closure.
        return fd

    def directory(fd, expected):
        value = os.fstat(fd)
        if (type(expected) is not list or len(expected) != 2
                or any(type(x) is not int or x < 0 for x in expected) or expected[1] == 0
                or not stat.S_ISDIR(value.st_mode) or value.st_uid != 2000 or value.st_gid != 2000
                or stat.S_IMODE(value.st_mode) != 0o700 or [value.st_dev, value.st_ino] != expected):
            raise ValueError('skill directory identity changed')
        return value

    def mount(fd):
        with open('/proc/self/fdinfo/' + str(fd)) as source:
            data = source.read(4097)
        if len(data) > 4096:
            raise ValueError('fd facts too large')
        rows = [line.split(':', 1)[1].strip() for line in data.splitlines() if line.startswith('mnt_id:')]
        if len(rows) != 1 or not rows[0].isascii() or not rows[0].isdecimal():
            raise ValueError('fd mount identity required')
        return rows[0]

    root = take(project)
    actual_root = directory(root, expected_root)
    metadata = take('.pe', root)
    parent = directory(metadata, grant['metadata'])
    if not os.fstatvfs(metadata).f_flag & os.ST_RDONLY:
        raise ValueError('outer metadata source is not read-only')
    skills = take('skills', metadata)
    source = directory(skills, grant['skills'])
    if parent.st_dev != actual_root.st_dev or source.st_dev != actual_root.st_dev:
        raise ValueError('skill copy outside original project domain')
    if os.fstatvfs(skills).f_flag & os.ST_RDONLY:
        raise ValueError('outer skill source is read-only')
    source_mount = mount(skills)
    copies, seen = [], set()
    for item in grant['copies']:
        if (type(item) is not dict or set(item) != {'version', 'identity'} or type(item['version']) is not str
                or re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}', item['version']) is None
                or item['version'] in seen):
            raise ValueError('fixed unique server version required')
        seen.add(item['version'])
        fd = take(item['version'], skills)
        actual = directory(fd, item['identity'])
        if actual.st_dev != actual_root.st_dev or mount(fd) != source_mount or os.fstatvfs(fd).f_flag & os.ST_RDONLY:
            raise ValueError('skill copy crossed project source mount')
        copies.append({'version': item['version'], 'fd': fd, 'identity': item['identity'][:]})
    return {'metadataFd': metadata, 'copies': copies, 'grant': grant, 'wire': fixed}


def skill_world_argv(base, project, opened, mode='workspace-write'):
    """Bind pinned copies under a readonly private scaffold, leaving all other .pe readonly."""
    if mode not in ['read-only', 'workspace-write']:
        raise ValueError('unsupported file policy')
    bind_fd = '--ro-bind-fd' if mode == 'read-only' else '--bind-fd'
    suffix = ['--ro-bind', project + '/.pe', project + '/.pe', '--chdir', project]
    if type(base) is not list or base[-5:] != suffix:
        raise ValueError('original fixed world suffix required')
    parent = project + '/.pe/skills'
    args = base[:-5] + ['--ro-bind-fd', str(opened['metadataFd']), project + '/.pe',
                        '--size', str(4096 * (len(opened['copies']) + 1)), '--tmpfs', parent]
    for copy in opened['copies']:
        path = parent + '/' + copy['version']
        args += ['--perms', '0700', '--dir', path, bind_fd, str(copy['fd']), path]
    return args + ['--remount-ro', parent, '--chdir', project]


def verify_file_policy(project, mode):
    """Before PREPARED, verify actual mount flags on every account-writable root."""
    project_path(project)
    if mode not in ['read-only', 'workspace-write']:
        raise ValueError('unsupported file policy')
    readonly = mode == 'read-only'
    for path in [project, ENV_ROOT + '/home', ENV_ROOT + '/venv', ENV_ROOT + '/tmp', '/tmp']:
        if bool(os.statvfs(path).f_flag & os.ST_RDONLY) != readonly:
            raise ValueError('workload file policy mount mismatch')


def verify_skill_world(project, expected_root, value, mode='workspace-write'):
    from wire import skill_world
    if mode not in ['read-only', 'workspace-write']:
        raise ValueError('unsupported file policy')
    fixed = skill_world(value)
    grant = {'metadata': [int(fixed['metadata'][k]) for k in ['device','inode']],
             'copies': [{'version': c['version'], 'identity': [int(c['identity'][k]) for k in ['device','inode']]} for c in fixed['copies']]}
    """Check actual fixed-copy world before PREPARED; files and original role issuance own authority."""
    root = os.lstat(project)
    metadata = os.lstat(project + '/.pe')
    parent_path = project + '/.pe/skills'
    parent = os.lstat(parent_path)
    if ([root.st_dev, root.st_ino] != expected_root or not stat.S_ISDIR(metadata.st_mode)
            or [metadata.st_dev, metadata.st_ino] != grant['metadata']
            or not os.statvfs(project + '/.pe').f_flag & os.ST_RDONLY
            or not stat.S_ISDIR(parent.st_mode) or not os.statvfs(parent_path).f_flag & os.ST_RDONLY):
        raise ValueError('readonly skill world parent required')
    expected_names = sorted(item['version'] for item in grant['copies'])
    if sorted(os.listdir(parent_path)) != expected_names:
        raise ValueError('unexpected skill world entries')
    for item in grant['copies']:
        path = parent_path + '/' + item['version']
        value = os.lstat(path)
        if (not stat.S_ISDIR(value.st_mode) or [value.st_dev, value.st_ino] != item['identity']
                or value.st_dev != root.st_dev or value.st_uid != 0 or value.st_gid != 0
                or stat.S_IMODE(value.st_mode) != 0o700
                or bool(os.statvfs(path).f_flag & os.ST_RDONLY) != (mode == 'read-only')):
            raise ValueError('original skill copy file policy mismatch')
