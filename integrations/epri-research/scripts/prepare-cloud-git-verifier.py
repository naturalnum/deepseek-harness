"""Stage a pinned offline signature verifier without changing base-image packages."""
import argparse
import hashlib
import json
import lzma
import os
from pathlib import Path
import subprocess


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--record', type=Path, required=True)
    parser.add_argument('--inputs', type=Path, required=True)
    parser.add_argument('--index', type=Path, required=True)
    parser.add_argument('--destination', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    record = json.loads(args.record.read_text())
    if args.destination != Path('/opt/dsh/research/.git-build/tools') or args.destination.exists():
        raise RuntimeError('Verifier requires its fresh temporary build prefix')
    if sha(Path('/usr/bin/dpkg-deb')) != '496045198f358af6537c40a217ac56d43f14a36a8864778f4e6f5fc5bc6290c1':
        raise RuntimeError('Original dpkg-deb bytes differ')
    keyring = record['immutableBaseKeyring']
    if Path(keyring['path']).stat().st_size != keyring['bytes'] or sha(Path(keyring['path'])) != keyring['sha256']:
        raise RuntimeError('Original Debian archive keyring differs')
    index = record['signedIndex']
    if args.index.stat().st_size != index['bytes'] or sha(args.index) != index['sha256']:
        raise RuntimeError('Reviewed signed package index differs')
    entries = {}
    for block in lzma.decompress(args.index.read_bytes()).decode().split('\n\n'):
        if block.startswith('Package: '):
            row = dict(line.split(': ', 1) for line in block.splitlines() if line and not line.startswith(' ') and ': ' in line)
            entries[row['Package']] = row
    for row in record['packages']:
        package = args.inputs / row['name']
        entry = entries[row['package']]
        if (entry['Version'] != row['version'] or entry['Architecture'] != 'arm64'
                or entry['SHA256'] != row['sha256'] or entry['Size'] != str(row['bytes'])
                or entry['Filename'] != row['url'].removeprefix('https://deb.debian.org/debian/')
                or package.stat().st_size != row['bytes'] or sha(package) != row['sha256']):
            raise RuntimeError('Verifier package differs from signed index')
    args.destination.mkdir(mode=0o700)
    for row in record['packages']:
        subprocess.run(['/usr/bin/dpkg-deb', '--extract', str(args.inputs / row['name']), str(args.destination)], check=True, timeout=30)
    library = str(args.destination / 'usr/lib/aarch64-linux-gnu')
    binary = args.destination / 'usr/bin/gpgv'
    environment = dict(os.environ, LD_LIBRARY_PATH=library)
    linked = subprocess.run(['/usr/bin/ldd', str(binary)], env=environment, check=True, capture_output=True, text=True, timeout=10).stdout
    if 'not found' in linked:
        raise RuntimeError('Verifier has unresolved shared libraries')
    (args.destination / 'bin').mkdir()
    wrapper = args.destination / 'bin/gpgv'
    wrapper.write_text('#!/bin/sh\nLD_LIBRARY_PATH=' + library + ' exec ' + str(binary) + ' "$@"\n')
    wrapper.chmod(0o700)
    files = []
    for path in sorted(args.destination.rglob('*')):
        st = path.lstat()
        row = {'path': str(path.relative_to(args.destination)), 'mode': oct(st.st_mode & 0o7777)}
        if path.is_symlink():
            row['symlink'] = os.readlink(path)
        elif path.is_file():
            row.update(bytes=st.st_size, sha256=sha(path))
        elif path.is_dir():
            row['directory'] = True
        else:
            raise RuntimeError('Unexpected verifier file type')
        files.append(row)
    args.output.write_text(json.dumps({'schema':'dsh-git-build-verifier-files/v1', 'temporaryOnly':True, 'source':record, 'sharedLibraries':linked, 'files':files}, indent=2) + '\n')


if __name__ == '__main__':
    main()
