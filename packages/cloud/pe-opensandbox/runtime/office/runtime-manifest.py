"""Record the actual guest interpreter and distributions in the native payload format."""
import importlib.metadata
import json
import pathlib
import platform
import subprocess

def runtime_arch(machine):
    """Use the Native manifest architecture names, independently of OCI platform names."""
    names = {'x86_64': 'x64', 'amd64': 'x64', 'aarch64': 'arm64', 'arm64': 'arm64'}
    if machine not in names:
        raise ValueError('unsupported Office runtime architecture: ' + machine)
    return names[machine]


def write_manifest(root):
    """Record the interpreter executing this builder and its installed distributions."""
    manifest = {
        'desktopVersion': 'dsh-cloud-office-candidate', 'platform': 'linux',
        'arch': runtime_arch(platform.machine()), 'python': platform.python_version(),
        'node': subprocess.check_output([str(root / 'dependencies/node/bin/node'), '--version'], text=True).strip().lstrip('v'),
        'pythonPackages': {d.metadata['Name']: d.version for d in importlib.metadata.distributions()},
    }
    (root / 'runtime.json').write_text(json.dumps(manifest, indent=2) + '\n')


if __name__ == '__main__':
    write_manifest(pathlib.Path('/opt/dsh/runtime'))
