"""Offline exact Office server context producer; creates no process, SDK, or resource."""
from pathlib import Path
import ast
import hashlib
import io
import json
import sys
import tarfile

BASE_SERVER = 'sha256:6497790ee3398569aef7d8f35d442e76c33c9be08633a6a2732dbcb2ee1fe01e'
OFFICE = 'sha256:3209e963a7b4f008818649e353c4af91da494e179cf3de54ae5c06b1edd79a97'
AFTER = '63c6efcb1cfac8ae8d7adcfe9d816544e7052df2be2c7ce3928bcda7808c82aa'
BEFORE = '4557a2744b784f4b6480a4a5a5dcb26c492c006e145c1cb7771939b5b78498d1'
NEEDLE = """        selected_images = (('sha256:62016189c3c5cec1c88d10af21b5dc0dfac0fc2247cd66709374dbdfc9d1135a',
                            'sha256:c75632ff5ced1d239c688e836c383ce3629ef1a93f7b698294345f2aa8074f2d')
                           if native else (FIXED_IMAGE,))
"""
REPLACEMENT = """        selected_images = ((('sha256:3209e963a7b4f008818649e353c4af91da494e179cf3de54ae5c06b1edd79a97',)
                            if self.policy['admitCreates'] else
                            ('sha256:62016189c3c5cec1c88d10af21b5dc0dfac0fc2247cd66709374dbdfc9d1135a',
                             'sha256:c75632ff5ced1d239c688e836c383ce3629ef1a93f7b698294345f2aa8074f2d',
                             'sha256:3690da1fbb1faaabaf7265927b8b21a0fef0c4c988d83a8b1e321a2e82d43140',
                             'sha256:3209e963a7b4f008818649e353c4af91da494e179cf3de54ae5c06b1edd79a97'))
                           if native else (FIXED_IMAGE,))
"""

def patch_source(raw):
    if hashlib.sha256(raw).hexdigest() != BEFORE:
        raise ValueError('exact original649 completion source required')
    source = raw.decode('utf8')
    if source.count(NEEDLE) != 1:
        raise ValueError('exact original649 selection target required')
    result = source.replace(NEEDLE, REPLACEMENT).encode('utf8')
    if hashlib.sha256(result).hexdigest() != AFTER:
        raise ValueError('exact Office completion source digest required')
    ast.parse(result)
    return result

def prepare(source, output):
    raw = source.read_bytes()
    patched = patch_source(raw)
    members = {
        'Dockerfile': Path(__file__).with_name('Dockerfile.office').read_bytes(),
        'completion_view.py': patched,
    }
    if hashlib.sha256(members['Dockerfile']).hexdigest() != '9885718bc73a1879e4f108dfe41408e98598e6c66429a5d09e88012b0ec202d2':
        raise ValueError('exact Office Dockerfile digest required')
    output.mkdir(mode=0o755, exist_ok=False)
    manifest = {'schema': 'office-server-offline-context-v1', 'executedBuild': False,
        'baseServer': BASE_SERVER, 'officeImage': OFFICE, 'source': str(source.resolve()),
        'sourceSha256': BEFORE, 'files': []}
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
    if len(sys.argv) != 3:
        raise SystemExit('usage: prepare_office_context.py exact649-public-source exclusive-own-output-directory')
    print(json.dumps(prepare(Path(sys.argv[1]), Path(sys.argv[2])), indent=2))
