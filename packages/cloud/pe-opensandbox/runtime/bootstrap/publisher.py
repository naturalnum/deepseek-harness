"""Fixed Root-only bootstrap publisher; never accepts a path, command or environment input."""
import hashlib
import os
import stat
import subprocess
import sys
import time

ROOT_UID = ROOT_GID = 0
PRIVATE = '/root-secret'
TRUSTED = '/trusted'
STAGE = '.bootstrap'
CLAIM = b's4-bootstrap/1\n'
BWRAP = ('0fc274e60c4b606db202dc9e82db60b4d944ba74bab8b6af2cd95ea28c4f8b2d', 814328)
SOURCES = {
    'server.py': ('302480c419d9790c4355a2295acfe545e43a798051eab5b96cbb940b191aaaf8', 12848),
    'wire.py': ('58311cbe1b5e6c942c05091a02dbd1c5d897275b9e764ce2fc56b650f1e612d6', 6441),
    'manager.py': ('1019519dc566cf29f9a9f55ca769cf40c1c095a0ef266e963fdb9acd326531ae', 10155),
    'launcher.py': ('bfcbf51b0e283216022a2ece1269c8395f8e13919fe71224060185134fdd13f7', 16024),
    'guardian.py': ('24c2a9122b356bc71f26824862570999d4069f53343d7a29c000e5d6feac9c9f', 4618),
    'paths.py': ('65cd31b5d865151fe6b0baeedb7f601ce8d03b702b6581a294dd93208a5d7fbe', 2649),
}
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW
READ = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW
WRITE_NEW = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW


def require(value):
    if not value:
        raise RuntimeError('fixed bootstrap refused')


def directory(name, parent, mode):
    fd = os.open(name, DIRECTORY, dir_fd=parent)
    try:
        item = os.fstat(fd)
        require(stat.S_ISDIR(item.st_mode) and item.st_uid == ROOT_UID and item.st_gid == ROOT_GID
                and stat.S_IMODE(item.st_mode) == mode)
        return fd
    except BaseException:
        os.close(fd)
        raise


def read_file(parent, name, maximum, mode, pin=None):
    fd = os.open(name, READ, dir_fd=parent)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == ROOT_UID and before.st_gid == ROOT_GID
                and stat.S_IMODE(before.st_mode) == mode and before.st_nlink == 1 and before.st_size <= maximum)
        chunks, size = [], 0
        while True:
            chunk = os.read(fd, min(65536, maximum + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            require(size <= maximum)
        data = b''.join(chunks)
        after = os.fstat(fd)
        require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
                and len(data) == before.st_size)
        if pin is not None:
            require(len(data) == pin[1] and hashlib.sha256(data).hexdigest() == pin[0])
        return data
    finally:
        os.close(fd)


def publish(parent, name, data, mode):
    fd = os.open(name, WRITE_NEW, mode, dir_fd=parent)
    try:
        os.fchmod(fd, mode)
        item = os.fstat(fd)
        require(stat.S_ISREG(item.st_mode) and item.st_uid == ROOT_UID and item.st_gid == ROOT_GID
                and item.st_nlink == 1 and stat.S_IMODE(item.st_mode) == mode)
        offset = 0
        while offset < len(data):
            written = os.write(fd, data[offset:])
            require(written > 0)
            offset += written
        os.fsync(fd)
    finally:
        os.close(fd)
    os.fsync(parent)


def main():
    require(os.getuid() == os.geteuid() == ROOT_UID and os.getgid() == os.getegid() == ROOT_GID)
    require(len(sys.argv) == 1 and __debug__)
    os.umask(0o077)
    root = directory('/', None, 0o755)
    private = directory('root-secret', root, 0o700)
    staging = directory(STAGE, private, 0o700)
    try:
        require(read_file(private, 's4-bootstrap.claimed', len(CLAIM), 0o600) == CLAIM)
        require(set(os.listdir(private)) == {STAGE, 's4-bootstrap.claimed'})
        require(set(os.listdir(staging)) == {*SOURCES, 'publisher.py', 'agent.stage'})
        data = {name: read_file(staging, name, pin[1], 0o600, pin) for name, pin in SOURCES.items()}
        config_data = read_file(staging, 'agent.stage', 4096, 0o600)
        # The installed isolation binary is fixed by Root's selected image/deployment; never downloaded.
        opt = directory('opt', root, 0o755)
        try:
            installed = directory('opensandbox', opt, 0o755)
            try:
                binary = read_file(installed, 'bwrap', BWRAP[1], 0o755, BWRAP)
            finally:
                os.close(installed)
        finally:
            os.close(opt)
        os.mkdir('trusted', 0o755, dir_fd=root)
        os.chmod('trusted', 0o755, dir_fd=root, follow_symlinks=False)
        trusted = directory('trusted', root, 0o755)
        try:
            os.mkdir('bwrap-revision', 0o755, dir_fd=trusted)
            os.chmod('bwrap-revision', 0o755, dir_fd=trusted, follow_symlinks=False)
            source = directory('bwrap-revision', trusted, 0o755)
            try:
                for name, content in data.items():
                    publish(source, name, content, 0o644)
            finally:
                os.close(source)
            publish(trusted, 'bwrap', binary, 0o755)
        finally:
            os.close(trusted)
        sys.path.insert(0, TRUSTED + '/bwrap-revision')
        import server
        config = server.checked_configuration(server.loads(config_data))
        server.mount_facts(config)
        publish(private, 'agent.json', config_data, 0o600)
        server.configuration(PRIVATE + '/agent.json')
        # No inherited SSE pipe, token in argv/env, or arbitrary pass_fds survives this launch.
        process = subprocess.Popen(['/usr/local/bin/python3', '-I', '-S', '-B',
                                    TRUSTED + '/bwrap-revision/server.py', PRIVATE + '/agent.json'],
                                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   cwd='/', env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8'},
                                   close_fds=True, start_new_session=True, user=0, group=0, extra_groups=[])
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            require(process.poll() is None)
            try:
                marker = read_file(private, 's4-agent.started', 64, 0o600)
            except FileNotFoundError:
                time.sleep(0.01)
                continue
            require(marker == config['runtimeIdentity'].encode('ascii'))
            print('s4-bootstrap-started', flush=True)
            return
        raise RuntimeError('fixed bootstrap startup unconfirmed')
    finally:
        os.close(staging)
        os.close(private)
        os.close(root)


if __name__ == '__main__':
    main()
