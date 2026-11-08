"""Build the pinned Git core with the official getrandom option and replace only its private copies."""
import argparse
import hashlib
import json
import lzma
from pathlib import Path, PurePosixPath
import posixpath
import re
import shutil
import struct
import subprocess
import tarfile
import tempfile


OPTIONS = ['CSPRNG_METHOD=getrandom', 'NO_OPENSSL=1', 'USE_LIBPCRE2=1',
           'prefix=/usr', 'gitexecdir=/usr/lib/git-core',
           'CFLAGS=-O2 -g0 -fstack-protector-strong -Wformat -Werror=format-security -D_FORTIFY_SOURCE=2',
           'LDFLAGS=-Wl,-z,relro -Wl,-z,now']


def digest(data):
    return hashlib.sha256(data).hexdigest()


def checked_file(path, row):
    data = path.read_bytes()
    if len(data) != row['bytes'] or digest(data) != row['sha256']:
        raise ValueError('Git build input differs: ' + path.name)
    return data


def fields(block):
    result, key = {}, None
    for line in block.splitlines():
        if line.startswith(' ') and key is not None:
            result[key] += '\n' + line[1:]
        elif ': ' in line or line.endswith(':'):
            key, value = line.split(':', 1)
            if key in result:
                raise ValueError('Duplicate source index field')
            result[key] = value.lstrip()
    return result


def verify(record, directory, keyring, gpgv):
    """Verify the original archive keyring and signed Release -> Sources -> all three Git source files."""
    checked_file(keyring, record['immutableBaseKeyring'])
    inputs = {}
    for row in record['inputs']:
        if Path(row['name']).name != row['name'] or row['name'] in inputs:
            raise ValueError('Unique source input basenames required')
        inputs[row['name']] = checked_file(directory / row['name'], row)
    with tempfile.TemporaryDirectory(prefix='git-source-signature-') as temporary:
        release = Path(temporary) / 'Release'
        checked = subprocess.run([str(gpgv), '--homedir', temporary, '--keyring', str(keyring),
                                  '--status-fd=1', '--output', str(release), str(directory / record['release'])],
                                 check=True, capture_output=True, text=True, timeout=15)
        keys = {line.split()[-1] for line in checked.stdout.splitlines() if line.startswith('[GNUPG:] VALIDSIG ')}
        if not set(record['requiredPrimarySigningKeys']).issubset(keys):
            raise ValueError('Reviewed Debian source signatures required')
        release_fields = fields(release.read_text())
    hashes = {name: (sha, int(size)) for sha, size, name in
              (line.split() for line in release_fields['SHA256'].splitlines() if line.strip())}
    source_bytes = inputs[record['index']]
    if hashes.get(record['indexReleasePath']) != (digest(source_bytes), len(source_bytes)):
        raise ValueError('Signed Release does not bind the exact Sources index')
    with lzma.LZMAFile(directory / record['index']) as stream:
        source = stream.read(record['indexUncompressedBytes'] + 1)
    if len(source) != record['indexUncompressedBytes']:
        raise ValueError('Source index size differs')
    matches = [fields(block) for block in source.decode().split('\n\n') if block.startswith('Package: git\n')]
    if len(matches) != 1 or matches[0]['Version'] != record['version'] or matches[0]['Directory'] != record['directory']:
        raise ValueError('Exact Git source version and directory required')
    entries = {name: (sha, int(size)) for sha, size, name in
               (line.split() for line in matches[0]['Checksums-Sha256'].splitlines() if line.strip())}
    for name in record['sourceFiles']:
        if entries.get(name) != (digest(inputs[name]), len(inputs[name])):
            raise ValueError('Signed Sources does not bind Git source: ' + name)


def extract_source(archive_path, record, work):
    """Extract the exact bounded upstream tree without links escaping the fresh build directory."""
    if work.exists() or work.is_symlink():
        raise ValueError('Fresh Git build directory required')
    with tarfile.open(archive_path, 'r:xz') as archive:
        members = archive.getmembers()
        if len(members) != record['archive']['members'] or sum(m.size for m in members if m.isfile()) != record['archive']['regularBytes']:
            raise ValueError('Git source archive bounds differ')
        for member in members:
            name = PurePosixPath(member.name)
            if name.is_absolute() or '..' in name.parts or not name.parts or name.parts[0] != record['archive']['root']:
                raise ValueError('Git source path escapes build directory')
            if not (member.isfile() or member.isdir() or member.issym() or member.islnk()) or member.mode & 0o6000:
                raise ValueError('Unsupported Git source member')
            if member.issym() or member.islnk():
                target = posixpath.normpath(posixpath.join(posixpath.dirname(member.name) if member.issym() else '', member.linkname))
                if target != record['archive']['root'] and not target.startswith(record['archive']['root'] + '/'):
                    raise ValueError('Git source link escapes build directory')
        work.mkdir(mode=0o700)
        archive.extractall(work, filter='data')
    return work / record['archive']['root']


def check_core(data):
    if (data[:6] != b'\x7fELF\x02\x01' or len(data) < 20 or struct.unpack_from('<H', data, 18)[0] != 183
            or b'getrandom\0' not in data or b'/dev/urandom\0' in data):
        raise ValueError('ARM64 Git core must use getrandom without the device fallback')


def build(record, record_bytes, directory, keyring, gpgv, work, output, jobs):
    verify(record, directory, keyring, gpgv)
    if output.exists() or output.is_symlink() or not 1 <= jobs <= 4:
        raise ValueError('Fresh artifact directory and bounded compiler jobs required')
    source = extract_source(directory / record['archive']['name'], record, work)
    command = ['/usr/bin/make', '-j' + str(jobs), *OPTIONS, 'git']
    subprocess.run(command, cwd=source, check=True, timeout=600)
    binary = source / 'git'
    data = binary.read_bytes()
    check_core(data)
    symbols = subprocess.run(['/usr/bin/readelf', '--dyn-syms', '--wide', str(binary)],
                             check=True, capture_output=True, text=True, timeout=10).stdout
    if not re.search(r'\bUND\s+getrandom@GLIBC_', symbols):
        raise ValueError('Git ELF lacks the actual getrandom libc import')
    linked = subprocess.run(['/usr/bin/ldd', str(binary)], check=True, capture_output=True, text=True, timeout=10).stdout
    if 'not found' in linked:
        raise ValueError('Built Git has unresolved shared libraries')
    output.mkdir(mode=0o755)
    shutil.copyfile(binary, output / 'git')
    (output / 'git').chmod(0o555)
    tool = lambda argv: subprocess.run(argv, check=True, capture_output=True, text=True, timeout=10).stdout.strip()
    receipt = {'schema': 'research-cloud-git-getrandom-build-v1', 'recordSha256': digest(record_bytes),
               'version': record['version'], 'command': command, 'core': {'bytes': len(data), 'sha256': digest(data)},
               'getrandomLibcImport': True, 'deviceFallbackAbsent': True, 'sharedLibraries': linked,
               'compiler': tool(['/usr/bin/gcc', '--version']), 'make': tool(['/usr/bin/make', '--version'])}
    (output / 'build.json').write_text(json.dumps(receipt, indent=2) + '\n')
    (output / 'build.json').chmod(0o444)


def replace(record, record_bytes, artifact, prefix):
    """Replace exactly the two reviewed core copies; every other supplied helper and template stays intact."""
    if str(prefix) != record['prefix'] or prefix.is_symlink() or not prefix.is_dir():
        raise ValueError('Existing independent Git prefix required')
    receipt = json.loads((artifact / 'build.json').read_text())
    if (receipt['schema'] != 'research-cloud-git-getrandom-build-v1' or receipt['recordSha256'] != digest(record_bytes)
            or receipt['version'] != record['version'] or receipt['command'][2:-1] != OPTIONS
            or receipt['getrandomLibcImport'] is not True or receipt['deviceFallbackAbsent'] is not True):
        raise ValueError('Exact source-build receipt required')
    binary = checked_file(artifact / 'git', receipt['core'])
    check_core(binary)
    destination = prefix / 'getrandom-build.json'
    if destination.exists() or destination.is_symlink():
        raise ValueError('Fresh Git build record required')
    targets = [prefix / name for name in record['replaceCorePaths']]
    if record['replaceCorePaths'] != ['usr/bin/git', 'usr/lib/git-core/git']:
        raise ValueError('Only the two original Git core paths may change')
    for target in targets:
        for parent in target.parents:
            if parent == prefix:
                break
            if parent.is_symlink() or not parent.is_dir():
                raise ValueError('Original private Git directories required')
        if target.is_symlink() or not target.is_file() or target.stat().st_nlink != 1 or digest(target.read_bytes()) != record['originalCoreSha256']:
            raise ValueError('Original supplied Git core differs')
    # Build-layer writes are private; no live guest or repository uses this prefix.
    for target in targets:
        target.chmod(0o755)
        target.write_bytes(binary)
        target.chmod(0o555)
    prefix.chmod(0o755)
    destination.write_text(json.dumps(receipt, indent=2) + '\n')
    destination.chmod(0o444)
    prefix.chmod(0o555)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('phase', choices=['build', 'replace'])
    parser.add_argument('--record', type=Path, required=True)
    parser.add_argument('--input-dir', type=Path)
    parser.add_argument('--keyring', type=Path, default=Path('/usr/share/keyrings/debian-archive-keyring.gpg'))
    parser.add_argument('--gpgv', type=Path, default=Path('/usr/bin/gpgv'))
    parser.add_argument('--work-dir', type=Path)
    parser.add_argument('--output-dir', type=Path)
    parser.add_argument('--jobs', type=int, default=2)
    parser.add_argument('--artifact-dir', type=Path)
    parser.add_argument('--prefix', type=Path, default=Path('/opt/dsh/research/git'))
    args = parser.parse_args()
    record_bytes = args.record.read_bytes()
    record = json.loads(record_bytes)
    if args.phase == 'build':
        if any(item is None for item in [args.input_dir, args.work_dir, args.output_dir]):
            parser.error('build requires --input-dir, --work-dir and --output-dir')
        build(record, record_bytes, args.input_dir, args.keyring, args.gpgv, args.work_dir, args.output_dir, args.jobs)
    else:
        if args.artifact_dir is None:
            parser.error('replace requires --artifact-dir')
        replace(record, record_bytes, args.artifact_dir, args.prefix)


if __name__ == '__main__':
    main()
