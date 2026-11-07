"""Extract one SHA-pinned standalone CPython archive into the independent research directory; execute nothing."""
import argparse
import hashlib
import json
from pathlib import Path
import tarfile


def install(archive, record, destination):
    if archive.stat().st_size != record['archiveBytes']:
        raise ValueError('Scientific Python archive size differs from the source record')
    digest = hashlib.sha256()
    with archive.open('rb') as stream:
        for part in iter(lambda: stream.read(1048576), b''):
            digest.update(part)
    if digest.hexdigest() != record['archiveSha256']:
        raise ValueError('Scientific Python archive SHA differs from the source record')
    if (destination / 'python').exists() or (destination / 'python').is_symlink():
        raise ValueError('Scientific Python destination already exists')
    with tarfile.open(archive, 'r:gz') as source:
        members = source.getmembers()
        if not members or any(item.name != 'python' and not item.name.startswith('python/') for item in members):
            raise ValueError('Scientific Python archive must contain only its python directory')
        source.extractall(destination, members=members, filter='data')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--record', type=Path, required=True)
    parser.add_argument('--destination', type=Path, required=True)
    args = parser.parse_args()
    install(args.archive, json.loads(args.record.read_text()), args.destination)


if __name__ == '__main__':
    main()
