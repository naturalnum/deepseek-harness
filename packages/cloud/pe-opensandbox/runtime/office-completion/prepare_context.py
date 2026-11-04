"""Verify the frozen Office context and prepare a build handoff without operating Docker."""
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import tarfile

MANIFEST_SHA256 = '4ee30a9d242ce4c39544500c992220412dafb9905dcc9b1d18584aa9af5db7e3'
SSH_BASE_IMAGE = 'sha256:c75632ff5ced1d239c688e836c383ce3629ef1a93f7b698294345f2aa8074f2d'
DOCKERFILE = 'packages/cloud/pe-opensandbox/runtime/office/Dockerfile'
PREFIXES = ('packages/cloud/pe-opensandbox/runtime/office/', 'packages/skill/skill-office/assets/')


def sha256(data):
    """Return the complete byte digest."""
    return hashlib.sha256(data).hexdigest()


def verify_context(context, manifest_bytes):
    """Read only inventory members after checking the approved complete manifest."""
    if sha256(manifest_bytes) != MANIFEST_SHA256:
        raise ValueError('The approved v5 manifest digest differs')
    manifest = json.loads(manifest_bytes)
    rows = manifest['files']
    names = set()
    result = []
    for row in rows:
        name = row['path']
        relative = PurePosixPath(name)
        if (relative.is_absolute() or '..' in relative.parts or str(relative) != name
                or not name.startswith(PREFIXES) or name in names):
            raise ValueError('Unexpected or duplicate context member')
        names.add(name)
        selected = context
        for part in relative.parts:
            selected = selected / part
            if selected.is_symlink():
                raise ValueError('Context symlinks are not accepted')
        data = selected.read_bytes()
        if len(data) != row['bytes'] or sha256(data) != row['sha256']:
            raise ValueError('Context member bytes differ: ' + name)
        result.append((name, data, selected.stat().st_mode & 0o777))
    if len(rows) != 251 or sum(len(data) for _, data, _ in result) != 4459197:
        raise ValueError('Frozen context total differs')
    if DOCKERFILE not in names:
        raise ValueError('Missing frozen Office recipe')
    return sorted(result)


def capacity_plan(builder_free_bytes, production_free_bytes, required_builder_free_bytes):
    """Keep builder admission separate from the still-unknown production image import size."""
    if any(type(value) is not int or value < 0 for value in (builder_free_bytes, production_free_bytes, required_builder_free_bytes)):
        raise ValueError('Actual nonnegative free byte measurements are required')
    if required_builder_free_bytes == 0:
        raise ValueError('An explicit positive reviewed builder allowance is required')
    return {
        'builderAvailableBytes': builder_free_bytes,
        'builderMinimumFreeBytes': required_builder_free_bytes,
        'builderShortfallBytes': max(0, required_builder_free_bytes - builder_free_bytes),
        'buildCapacityAdmitted': builder_free_bytes >= required_builder_free_bytes,
        'productionAvailableBytes': production_free_bytes,
        'productionImportAdmitted': False,
        'productionImportReason': 'Actual unique image-layer bytes and import peak must be measured after the build; remote build success alone is insufficient.',
    }


def prepare(context, manifest, output, builder_free_bytes, production_free_bytes, required_builder_free_bytes):
    """Create only a new owned output directory; no source, engine, image or account is mutated."""
    capacity = capacity_plan(builder_free_bytes, production_free_bytes, required_builder_free_bytes)
    members = verify_context(context.resolve(strict=True), manifest.read_bytes())
    output.mkdir(mode=0o700)
    archive = output / 'office-v5-context.tar'
    with tarfile.open(archive, 'x', format=tarfile.USTAR_FORMAT) as stream:
        for name, data, mode in members:
            entry = tarfile.TarInfo(name)
            entry.size = len(data)
            entry.mode = mode
            entry.mtime = entry.uid = entry.gid = 0
            stream.addfile(entry, io.BytesIO(data))
    plan = {
        'schema': 'office-build-handoff-v1',
        'approvedManifestSha256': MANIFEST_SHA256,
        'contextFiles': len(members),
        'contextBytes': sum(len(data) for _, data, _ in members),
        'contextArchiveBytes': archive.stat().st_size,
        'contextArchiveSha256': sha256(archive.read_bytes()),
        'baseImage': SSH_BASE_IMAGE,
        'dockerfile': DOCKERFILE,
        'baseSelectionReason': 'Preserve the qualified SSH dependency layer when adding Office; the final Office image still requires its own exact admission and qualification.',
        'capacity': capacity,
        'builderStarted': False,
        'productionChanged': False,
        'officeExecutionAccepted': False,
        'requiredOwnerMeasurements': [
            'Fresh actual builder image-store filesystem free bytes; external overlay free space and logical reclaim estimates do not substitute.',
            'Build peak free bytes, exact final linux/arm64 image id, package/font manifests, unique additional layers and final production import peak.',
            'Current/rollback/all user data remain preserved; original runtime resource and tenant quotas are unchanged.',
        ],
        'qualification': [
            'Only the sole runtime owner may start the builder or invoke the existing qualify-office-image.py with exact image id and script/fixture/output mounts.',
            'The existing standalone CLI qualification driver is not a proof of the original SDK seccomp/CapDrop, issued account environment, approvals or tenant lifecycle.',
            'Run the original issued Native account environment with --clearenv: verify fonts, Python runtime, Office/Math, Pandoc, Poppler CMaps and XeLaTeX without Host dependency mounts.',
            'Complete the retained13 skill/model/output matrix, cancellation/rollback and visual output checks; preserve original package/license/template/member hashes.',
            'Keep model/user invocation disabled until actual image, account/model and output qualification passes.',
        ],
    }
    (output / 'handoff.json').write_text(json.dumps(plan, ensure_ascii=False, indent=2) + '\n')
    return plan


def main():
    """Prepare evidence only, returning2 when the measured builder has insufficient headroom."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--context', required=True, type=Path)
    parser.add_argument('--manifest', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--builder-free-bytes', required=True, type=int)
    parser.add_argument('--production-free-bytes', required=True, type=int)
    parser.add_argument('--required-builder-free-bytes', required=True, type=int)
    args = parser.parse_args()
    plan = prepare(args.context, args.manifest, args.output,
                   args.builder_free_bytes, args.production_free_bytes, args.required_builder_free_bytes)
    print(json.dumps({'handoff': str(args.output / 'handoff.json'),
                      'buildCapacityAdmitted': plan['capacity']['buildCapacityAdmitted'],
                      'productionImportAdmitted': False}))
    return 0 if plan['capacity']['buildCapacityAdmitted'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
