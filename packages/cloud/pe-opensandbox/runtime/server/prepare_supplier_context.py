"""Produce an offline COPY-only candidate from the exact Office server; create no runtime or qualification."""
from pathlib import Path
import ast
import hashlib
import io
import json
import re
import sys
import tarfile

import prepare_office_context as office

BASE_SERVER = 'sha256:1b7ec16bb1031eab0fd7024905fc03dc5f814fbfe46bbb2d5aa2f88e3813b628'
BEFORE = office.AFTER
DOCKERFILE = (f'FROM {BASE_SERVER}\n'
              'COPY --chown=0:0 completion_view.py '
              '/usr/local/lib/python3.12/site-packages/opensandbox_server/services/docker/completion_view.py\n')


def selected_images(workload):
    """Retain all five closed-audit predecessors and select only the explicit candidate for creation."""
    if not isinstance(workload, str) or not re.fullmatch(r'sha256:[0-9a-f]{64}', workload):
        raise ValueError('one explicit immutable candidate workload digest required')
    if workload == office.OFFICE:
        raise ValueError('candidate must differ from the original Office workload')
    opened = f"(('{office.OFFICE}',)\n"
    closed = f"'{office.OFFICE}'))\n"
    if office.REPLACEMENT.count(opened) != 1 or office.REPLACEMENT.count(closed) != 1:
        raise ValueError('exact original Office selected_images expression required')
    return office.REPLACEMENT.replace(opened, f"(('{workload}',)\n").replace(
        closed, f"'{office.OFFICE}',\n                             '{workload}'))\n")


def patch_source(raw, workload):
    """Change only the original selected_images assignment after its complete source digest matches."""
    if hashlib.sha256(raw).hexdigest() != BEFORE:
        raise ValueError('exact original Office completion source required')
    source = raw.decode('utf8')
    if source.count(office.REPLACEMENT) != 1:
        raise ValueError('exact original Office selection target required')
    result = source.replace(office.REPLACEMENT, selected_images(workload)).encode('utf8')
    ast.parse(result)
    return result


def prepare(source, workload, output):
    """Freeze a candidate context and source/file hashes; the build owner qualifies and registers actual image digests."""
    raw = source.read_bytes()
    patched = patch_source(raw, workload)
    members = {'Dockerfile': DOCKERFILE.encode('utf8'), 'completion_view.py': patched}
    output.mkdir(mode=0o755, exist_ok=False)
    manifest = {'schema': 'supplier-server-offline-context-v1', 'executedBuild': False,
                'baseServer': BASE_SERVER, 'candidateWorkloadImage': workload,
                'source': str(source.resolve()), 'sourceSha256': BEFORE, 'files': []}
    for name, data in members.items():
        (output / name).write_bytes(data)
        manifest['files'].append({'path': name, 'bytes': len(data),
                                  'sha256': hashlib.sha256(data).hexdigest(), 'mode': '0644'})
    target = output / 'context.tar'
    with target.open('xb') as out:
        with tarfile.open(fileobj=out, mode='w', format=tarfile.USTAR_FORMAT) as archive:
            for name, data in members.items():
                entry = tarfile.TarInfo(name)
                entry.size, entry.mode, entry.uid, entry.gid, entry.mtime = len(data), 0o644, 0, 0, 0
                archive.addfile(entry, io.BytesIO(data))
    manifest['context'] = {'bytes': target.stat().st_size,
                           'sha256': hashlib.sha256(target.read_bytes()).hexdigest(), 'entries': 2}
    (output / 'MANIFEST.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return manifest


if __name__ == '__main__':
    if len(sys.argv) != 4:
        raise SystemExit('usage: prepare_supplier_context.py exact-office-public-source candidate-workload-sha256 exclusive-output-directory')
    print(json.dumps(prepare(Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3])), indent=2))
