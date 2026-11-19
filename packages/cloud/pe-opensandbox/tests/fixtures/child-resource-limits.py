"""Read actual resource limits across the Guardian's Bash pre-exec boundary."""

import errno
import fcntl
import json
import mmap
import os
import resource
import subprocess
import sys


KINDS = {
    'cpu': resource.RLIMIT_CPU,
    'address': resource.RLIMIT_AS,
    'files': resource.RLIMIT_FSIZE,
    'descriptors': resource.RLIMIT_NOFILE,
    'processes': resource.RLIMIT_NPROC,
    'core': resource.RLIMIT_CORE,
}


def limits():
    return {name: list(resource.getrlimit(kind)) for name, kind in KINDS.items()}


def probe(private_writer):
    try:
        os.fstat(private_writer)
    except OSError as error:
        assert error.errno == errno.EBADF
    else:
        raise AssertionError('A private supervisor writer survived user Bash exec.')
    current = limits()
    with mmap.mmap(-1, 600 * 1024 * 1024) as mapping:
        mapping[0] = 1
        mapping[-1] = 2
    files = [os.open('/dev/null', os.O_RDONLY) for _ in range(48)]
    for fd in files:
        os.close(fd)
    descriptor_hard = current['descriptors'][1]
    try:
        resource.setrlimit(resource.RLIMIT_NOFILE, (descriptor_hard + 1, descriptor_hard + 1))
    except (OSError, ValueError):
        pass
    else:
        raise AssertionError('The user process could raise its hard descriptor limit.')
    observed = subprocess.check_output([sys.executable, '-I', '-S', '-B', __file__, 'descendant'], timeout=5)
    assert json.loads(observed) == current
    print(json.dumps(current))


if __name__ == '__main__':
    if sys.argv[1] == 'child':
        probe(int(sys.argv[2]))
    elif sys.argv[1] == 'descendant':
        print(json.dumps(limits()))
    else:
        sys.path.insert(0, sys.argv[1])
        from guardian import child_limits

        assert os.geteuid() != 0
        before = limits()
        reader, writer = os.pipe()
        private_writer = fcntl.fcntl(writer, fcntl.F_DUPFD, 64)
        try:
            assert os.get_inheritable(private_writer)
            observed = subprocess.check_output(
                ['/bin/bash', '--noprofile', '--norc', '-c', 'exec "$@"', 'bash',
                 sys.executable, '-I', '-S', '-B', __file__, 'child', str(private_writer)],
                close_fds=True, preexec_fn=child_limits, timeout=8)
            assert os.write(private_writer, b'parent') == 6
            assert os.read(reader, 6) == b'parent'
        finally:
            for fd in (private_writer, writer, reader):
                os.close(fd)
        assert limits() == before
        print(observed.decode().strip())
