"""Freeze one declared runtime adapter correction while preserving original skill archives."""
import ast
import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile
import zipfile

SOURCE_CONTEXT_SHA = '4f17e2e7f6c92c9a5ce0c3b5e018e43c9d312d8a5bcb51f9d318f87e32962a90'
SOURCE_CONTEXT_BYTES = 5099520
ORIGINAL_SHA = '697d479686d09c90fd8f04f77c3c9281cd75225f29c4f31307bebdc3fb35d509'
RUNTIME_SHA = 'fddc0649c281974356b6183bf2b70f74426ba9ed81659061627bb8526088ed9a'
PATCH_SHA = '48943264d7d8990a4b13137db0d147cdae2efbec3373f5b0759b409d14012eae'
ARCHIVE_SHA = '5e255306b52b03e73f91c542917de3f6553c0e8f448f21a86290743f5d0b59ad'
BASE_IMAGE = 'sha256:3209e963a7b4f008818649e353c4af91da494e179cf3de54ae5c06b1edd79a97'
ASSETS = 'packages/skill/skill-office/assets/'
PACKAGE = ASSETS + 'reports/tech-report-writer/'
ADAPTER = 'scripts/orchestration_adapter.py'
RUNTIME_PATH = '/opt/dsh/skills/office/reports/tech-report-writer/' + ADAPTER


def sha(raw):
    """Return the complete immutable input digest."""
    return hashlib.sha256(raw).hexdigest()


def patch_source(raw):
    """Keep explicit h2/h3 numbers; reject any other upstream or resulting bytes."""
    if sha(raw) != ORIGINAL_SHA:
        raise ValueError('Exact original adapter SHA required')
    source = raw.decode('utf8')
    for level, size in [(2, 14), (3, 12)]:
        before = f'''out.append(f"<h{level} style='font-family:黑体;font-size:{size}pt'>{{inline_markdown(title)}}</h{level}>")'''
        after = f'''out.append(f"<h{level} style='font-family:黑体;font-size:{size}pt'>{{inline_markdown(m.group(2).strip())}}</h{level}>")'''
        if source.count(before) != 1:
            raise ValueError('Exact two original heading expressions required')
        source = source.replace(before, after)
    result = source.encode('utf8')
    if sha(result) != RUNTIME_SHA:
        raise ValueError('Exact declared runtime adapter SHA required')
    ast.parse(result)
    return result


def prepare(source_context, output):
    """Read a pinned original context and write one exclusive COPY context, never a build."""
    if source_context.stat().st_size != SOURCE_CONTEXT_BYTES:
        raise ValueError('Exact original Office context size required')
    context = source_context.read_bytes()
    if sha(context) != SOURCE_CONTEXT_SHA:
        raise ValueError('Exact original Office context SHA required')
    with tarfile.open(fileobj=io.BytesIO(context), mode='r:') as original:
        files = {m.name: original.extractfile(m).read() for m in original.getmembers()
                 if m.isfile() and m.name.startswith(ASSETS)}
    raw = files[PACKAGE + ADAPTER]
    archive = files[PACKAGE + '.dsh-package.zip']
    if sha(archive) != ARCHIVE_SHA:
        raise ValueError('Exact original tech-report-writer archive SHA required')
    with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
        if zipped.read(ADAPTER) != raw:
            raise ValueError('Original context and ZIP adapter bytes differ')
    runtime = patch_source(raw)
    here = Path(__file__).resolve().parent
    patch = (here / 'heading-numbering.patch').read_bytes()
    if sha(patch) != PATCH_SHA:
        raise ValueError('Exact declared two-line patch SHA required')
    docker = (here / 'Dockerfile').read_bytes()
    expected = ('FROM ' + BASE_IMAGE + '\nCOPY --chown=0:0 orchestration_adapter.py ' + RUNTIME_PATH + '\n').encode()
    if docker != expected:
        raise ValueError('Exact single-adapter COPY recipe required')
    archives = []
    for name, data in files.items():
        if name.endswith('/.dsh-package.json'):
            metadata = json.loads(data)
            zipped = files[name[:-len('.json')] + '.zip']
            if len(zipped) != metadata['archive']['bytes'] or sha(zipped) != metadata['archive']['sha256']:
                raise ValueError('Original archive differs from its inventory')
            archives.append({'path': name[:-len('.json')] + '.zip', 'version': metadata['version'], **metadata['archive']})
    if len(archives) != 13:
        raise ValueError('All thirteen original archives required')
    members = {'Dockerfile': (docker, 0o644), 'orchestration_adapter.py': (runtime, 0o444)}
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w', format=tarfile.USTAR_FORMAT) as tar:
        for name, (data, mode) in members.items():
            entry = tarfile.TarInfo(name)
            entry.size, entry.mode, entry.uid, entry.gid, entry.mtime = len(data), mode, 0, 0, 0
            tar.addfile(entry, io.BytesIO(data))
    manifest = {'schema': 'office-single-runtime-adapter-correction-v1', 'executedBuild': False,
        'baseImage': BASE_IMAGE, 'newOfficeImage': None, 'newServerImage': None,
        'sourceContext': {'bytes': len(context), 'sha256': SOURCE_CONTEXT_SHA},
        'originalArchives': archives, 'originalAdapter': {'path': PACKAGE + ADAPTER, 'sha256': ORIGINAL_SHA},
        'patchSha256': PATCH_SHA, 'runtimeException': {'path': RUNTIME_PATH, 'alias': RUNTIME_PATH.replace('/office/reports/', '/reports/'),
            'originalSha256': ORIGINAL_SHA, 'patchSha256': PATCH_SHA,
            'bytes': len(runtime), 'sha256': RUNTIME_SHA, 'mode': '0444', 'uid': 0, 'gid': 0},
        'originalAssets': [{'path': n.removeprefix(ASSETS), 'bytes': len(b), 'sha256': sha(b)} for n, b in sorted(files.items())],
        'context': {'bytes': len(stream.getvalue()), 'sha256': sha(stream.getvalue()), 'members': 2},
        'meaning': 'Original archives, templates and licenses stay unchanged. Only this live runtime adapter differs; every other live resource must match its original inventory. No image, SDK, provider or model qualification is implied.'}
    output.mkdir(mode=0o755, exist_ok=False)
    for name, (data, mode) in members.items():
        (output / name).write_bytes(data)
        (output / name).chmod(mode)
    (output / 'context.tar').write_bytes(stream.getvalue())
    (output / 'MANIFEST.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return manifest


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('usage: prepare_context.py exact-original-context.tar exclusive-output-directory')
    print(json.dumps(prepare(Path(sys.argv[1]), Path(sys.argv[2])), indent=2))
