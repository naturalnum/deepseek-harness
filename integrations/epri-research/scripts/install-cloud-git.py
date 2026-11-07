"""Verify an offline Debian signature chain and extract Git into its independent image prefix."""
import argparse
import hashlib
import io
import json
import lzma
from pathlib import Path, PurePosixPath
import posixpath
import shutil
import struct
import subprocess
import tarfile
import tempfile


def digest(data):
    return hashlib.sha256(data).hexdigest()


def checked_input(directory, row):
    if Path(row['name']).name != row['name']:
        raise ValueError('Git source input must be a basename')
    data = (directory / row['name']).read_bytes()
    if len(data) != row['bytes'] or digest(data) != row['sha256']:
        raise ValueError('Git source input differs: ' + row['name'])
    return data


def deb_data(data):
    """Read the fixed ar container without invoking a package manager or maintainer scripts."""
    if not data.startswith(b'!<arch>\n'):
        raise ValueError('Git package is not an ar archive')
    offset, payload = 8, None
    while offset < len(data):
        header = data[offset:offset + 60]
        if len(header) != 60 or header[-2:] != b'`\n':
            raise ValueError('Malformed Git package member')
        size = int(header[48:58].decode('ascii').strip())
        start = offset + 60
        if size < 0 or start + size > len(data):
            raise ValueError('Truncated Git package member')
        if header[:16].decode('ascii').strip().rstrip('/') == 'data.tar.xz':
            if payload is not None:
                raise ValueError('Duplicate Git package payload')
            payload = data[start:start + size]
        offset = start + size + size % 2
    if payload is None or offset != len(data):
        raise ValueError('Missing Git package payload')
    return payload


def inspect_payload(payload, record):
    rows, total, core = [], 0, None
    with tarfile.open(fileobj=io.BytesIO(payload), mode='r:xz') as archive:
        for member in archive:
            name = PurePosixPath(member.name)
            if name.is_absolute() or '..' in name.parts or (name.parts and name.parts[0] not in ['etc', 'usr', 'var']):
                raise ValueError('Git package path escapes its private prefix')
            if not (member.isfile() or member.isdir() or member.issym() or member.islnk()) or member.mode & 0o6000:
                raise ValueError('Unsupported Git package member')
            if member.issym() or member.islnk():
                target = posixpath.normpath(posixpath.join(posixpath.dirname(member.name) if member.issym() else '', member.linkname))
                if target.startswith('/') or target == '..' or target.startswith('../'):
                    raise ValueError('Git package link escapes its private prefix')
            row = {'name': member.name, 'type': member.type.decode(), 'mode': member.mode,
                   'size': member.size, 'link': member.linkname}
            if member.isfile():
                stream = archive.extractfile(member)
                data = stream.read()
                row['sha256'] = digest(data)
                total += len(data)
                if name.as_posix() == record['core']['path']:
                    core = data
            rows.append(row)
            if len(rows) > record['payload']['members'] or total > record['payload']['regularBytes']:
                raise ValueError('Git payload exceeds its exact source manifest')
    manifest = json.dumps(rows, sort_keys=True, separators=(',', ':')).encode()
    if (len(rows) != record['payload']['members'] or total != record['payload']['regularBytes']
            or digest(manifest) != record['payload']['manifestSha256']):
        raise ValueError('Git payload member manifest differs')
    expected = record['core']
    if (core is None or len(core) != expected['bytes'] or digest(core) != expected['sha256']
            or core[:6] != b'\x7fELF\x02\x01' or struct.unpack_from('<H', core, 18)[0] != expected['elfMachine']):
        raise ValueError('Git core ELF differs')


def verify_source(record, directory, keyring, gpgv):
    anchor = record['immutableBaseKeyring']
    key_bytes = keyring.read_bytes()
    if len(key_bytes) != anchor['bytes'] or digest(key_bytes) != anchor['sha256']:
        raise ValueError('The immutable base Debian keyring differs')
    inputs = {row['name']: checked_input(directory, row) for row in record['inputs']}
    release_input, index_input, package_input = record['inputs']
    with tempfile.TemporaryDirectory(prefix='research-git-signature-') as temporary:
        target = Path(temporary) / 'Release'
        checked = subprocess.run([str(gpgv), '--homedir', temporary, '--keyring', str(keyring),
                                  '--status-fd=1', '--output', str(target), str(directory / release_input['name'])],
                                 check=True, capture_output=True, text=True, timeout=15)
        signatures = {line.split()[-1] for line in checked.stdout.splitlines() if line.startswith('[GNUPG:] VALIDSIG ')}
        if not set(record['requiredPrimarySigningKeys']).issubset(signatures):
            raise ValueError('Git source lacks the reviewed Debian release signatures')
        release = target.read_text()
    in_sha256, hashes = False, {}
    for line in release.splitlines():
        if line == 'SHA256:':
            in_sha256 = True
        elif in_sha256 and line.startswith(' '):
            checksum, size, name = line.split()
            hashes[name] = (checksum, int(size))
        elif in_sha256:
            break
    if hashes.get(record['indexReleasePath']) != (index_input['sha256'], index_input['bytes']):
        raise ValueError('Signed Debian Release does not bind the exact package index')
    with lzma.LZMAFile(io.BytesIO(inputs[index_input['name']])) as source:
        index = source.read(record['indexUncompressedBytes'] + 1)
    if len(index) != record['indexUncompressedBytes']:
        raise ValueError('Debian package index size differs')
    matches = []
    for block in index.decode().split('\n\n'):
        if block.startswith('Package: ' + record['package'] + '\n'):
            matches.append(dict(line.split(': ', 1) for line in block.splitlines() if line and not line.startswith(' ') and ': ' in line))
    if len(matches) != 1:
        raise ValueError('Debian package identity is ambiguous')
    package = matches[0]
    for key, value in {'Version': record['version'], 'Architecture': record['architecture'],
                       'Filename': record['packageFilename'], 'SHA256': package_input['sha256'], 'Size': str(package_input['bytes'])}.items():
        if package.get(key) != value:
            raise ValueError('Signed Debian package entry differs: ' + key)
    payload = deb_data(inputs[package_input['name']])
    inspect_payload(payload, record)
    return payload


def install(payload, record, destination):
    if str(destination) != record['prefix'] or destination.exists() or destination.is_symlink():
        raise ValueError('Git requires its fresh exact independent prefix')
    destination.mkdir(mode=0o755)
    with tarfile.open(fileobj=io.BytesIO(payload), mode='r:xz') as archive:
        archive.extractall(destination, filter='data')
    binary = destination / record['core']['path']
    linked = subprocess.run(['/usr/bin/ldd', str(binary)], check=True, capture_output=True, text=True, timeout=10).stdout
    if 'not found' in linked or any(name not in linked for name in record['core']['needed']):
        raise ValueError('Git has unresolved or unexpected core library prerequisites')
    (destination / 'bin').mkdir()
    launcher = destination / 'bin/git'
    launcher.write_text('#!/bin/sh\nexport GIT_EXEC_PATH=' + str(destination / 'usr/lib/git-core')
                        + '\nexport GIT_TEMPLATE_DIR=' + str(destination / 'usr/share/git-core/templates')
                        + '\nexec ' + str(binary) + ' "$@"\n')
    launcher.chmod(0o755)
    shutil.copyfile(destination / 'usr/share/doc/git/copyright', destination / 'COPYRIGHT')
    (destination / 'source.json').write_text(json.dumps({'source': record, 'sharedLibraries': linked}, indent=2) + '\n')
    for path in sorted(destination.rglob('*'), reverse=True) + [destination]:
        if not path.is_symlink():
            path.chmod(path.stat().st_mode & 0o555)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--record', type=Path, required=True)
    parser.add_argument('--input-dir', type=Path, required=True)
    parser.add_argument('--destination', type=Path, default=Path('/opt/dsh/research/git'))
    parser.add_argument('--keyring', type=Path, default=Path('/usr/share/keyrings/debian-archive-keyring.gpg'))
    parser.add_argument('--gpgv', type=Path, default=Path('/usr/bin/gpgv'))
    parser.add_argument('--verify-only', action='store_true')
    args = parser.parse_args()
    record = json.loads(args.record.read_text())
    payload = verify_source(record, args.input_dir, args.keyring, args.gpgv)
    if not args.verify_only:
        install(payload, record, args.destination)
    print(json.dumps({'verified': True, 'installed': not args.verify_only, 'version': record['version']}))


if __name__ == '__main__':
    main()
