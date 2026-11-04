"""Freeze a legacy-compatible Office context; actual owner dpkg/apt evidence gates build inputs."""
import argparse
import email.parser
import io
import json
from pathlib import Path, PurePosixPath
import re
import tarfile
import zipfile
from urllib.parse import urlsplit, unquote
from prepare_context import SSH_BASE_IMAGE, sha256, verify_context
from install_v6 import parse_apt_simulation, phase_maps, map_sha256

PREFIX = 'packages/cloud/pe-opensandbox/runtime/office-completion/'
ASSETS = 'packages/skill/skill-office/assets/'
WHEEL_MANIFEST_SHA256 = '8887b49702c033acb126ab16bfc455ab1febd654e8e1b48bb5a46608b9040993'
STAGE1_PLAN_SHA256 = 'e5a58884652af1dc840d0f37fedabd8da09edb85901ff4e3001052eb75e7d816'
APT_FIRST = sorted('libreoffice-writer libreoffice-calc libreoffice-impress libreoffice-math poppler-utils poppler-data pandoc fonts-noto-cjk fonts-liberation fonts-texgyre fontconfig ca-certificates'.split())
APT = sorted('libreoffice-writer libreoffice-calc libreoffice-impress libreoffice-math poppler-utils poppler-data pandoc texlive-xetex texlive-lang-chinese texlive-latex-extra texlive-fonts-recommended tex-gyre fonts-noto-cjk fonts-liberation fonts-texgyre fontconfig ca-certificates'.split())
TOP = dict(item.split('==') for item in 'numpy==2.3.4 pandas==2.3.3 python-docx==1.2.0 python-pptx==1.0.2 openpyxl==3.1.5 XlsxWriter==3.2.9 Pillow==12.0.0 lxml==6.0.2 beautifulsoup4==4.14.2 json-repair==0.53.0 requests==2.32.5 pdfplumber==0.11.8 fonttools==4.60.1'.split())


def canonical(name):
    """Use Python distribution-name comparison without changing its original metadata."""
    return re.sub(r'[-_.]+', '-', name).lower()


def wheel_filename(name):
    """Keep one already-declared compatible platform tag so USTAR can retain exact wheel bytes."""
    parts = name.removesuffix('.whl').split('-')
    if len(parts) not in (5, 6):
        raise ValueError('Unexpected wheel filename fields')
    platforms = parts[-1].split('.')
    selected = next((tag for tag in ('manylinux_2_28_aarch64', 'manylinux2014_aarch64', 'manylinux_2_17_aarch64', 'any')
                     if tag in platforms), None)
    if selected is None:
        raise ValueError('Wheel is not compatible with the selected ARM64 baseline')
    result = '-'.join([*parts[:-1], selected]) + '.whl'
    if len(result.encode()) > 100:
        raise ValueError('Wheel filename still exceeds the USTAR name field')
    return result


def wheel_inputs(directory, manifest, url_report=None):
    """Require the complete measured wheel set, exact bytes, metadata and all top-level pins."""
    if len(manifest['packages']) != 28:
        raise ValueError('Expected the retained complete28-wheel closure')
    members, requirements, versions = [], [], {}
    urls = {}
    if url_report is not None:
        for item in url_report['install']:
            detail = item['download_info']
            url = detail['url']
            parsed = urlsplit(url)
            filename = unquote(parsed.path.rsplit('/', 1)[-1])
            if (parsed.scheme != 'https' or parsed.netloc != 'files.pythonhosted.org'
                    or parsed.query or parsed.fragment or filename in urls):
                raise ValueError('Direct wheel source must be a unique official HTTPS archive')
            urls[filename] = (url, detail['archive_info']['hashes']['sha256'])
        if set(urls) != {row['wheel'] for row in manifest['packages']}:
            raise ValueError('Direct URL report must match the exact retained28-wheel closure')
    for row in manifest['packages']:
        name = row['wheel']
        if Path(name).name != name or not name.endswith('.whl'):
            raise ValueError('Invalid wheel filename')
        data = (directory / name).read_bytes()
        if len(data) != row['archiveBytes'] or sha256(data) != row['sha256']:
            raise ValueError('Frozen wheel bytes differ')
        archive = zipfile.ZipFile(io.BytesIO(data))
        metadata_names = [name for name in archive.namelist() if name.endswith('.dist-info/METADATA')]
        if len(metadata_names) != 1:
            raise ValueError('Ambiguous wheel distribution metadata')
        metadata = email.parser.BytesParser().parsebytes(archive.read(metadata_names[0]))
        distribution, version = metadata['Name'], metadata['Version']
        key = canonical(distribution)
        if key in versions or not re.fullmatch(r'[A-Za-z0-9_.-]+', distribution + version):
            raise ValueError('Duplicate or malformed Python distribution')
        versions[key] = version
        if url_report is None:
            requirements.append(f'{distribution}=={version} --hash=sha256:{row["sha256"]}')
            members.append((PREFIX + 'v6-build/wheels/' + wheel_filename(name), data, 0o444))
        else:
            url, digest = urls[name]
            if digest != row['sha256']:
                raise ValueError('Direct URL report changed an original wheel hash')
            requirements.append(f'{distribution} @ {url} --hash=sha256:{digest}')
    if any(versions.get(canonical(name)) != version for name, version in TOP.items()):
        raise ValueError('Required original top-level Python pin changed')
    members.append((PREFIX + 'v6-build/requirements.lock', ('\n'.join(sorted(requirements, key=str.lower)) + '\n').encode(), 0o444))
    return members


def owner_inputs(directory):
    """Validate parsed inputs against raw read-only owner observations; no Docker call is made."""
    base = json.loads((directory / 'base-dpkg.json').read_text())
    plan = json.loads((directory / 'apt-plan.json').read_text())
    for value, raw_name in ((base, 'base-dpkg.raw'), (plan, 'apt-plan.raw')):
        raw = (directory / raw_name).read_bytes()
        if (value['baseImage'] != SSH_BASE_IMAGE or value['architecture'] != 'arm64'
                or value['observationKind'] != 'actual-readonly-owner-observation'
                or sha256(raw) != value['rawEvidenceSha256']):
            raise ValueError('Owner observation identity or raw digest differs')
    baseline = {row['name']: row['version'] for row in base['packages']}
    raw_baseline = {}
    for line in (directory / 'base-dpkg.raw').read_text().splitlines():
        status, name, version = line.split('\t')
        if status == 'installed':
            raw_baseline[name] = version
    if baseline != raw_baseline or len(baseline) != len(base['packages']):
        raise ValueError('Parsed base packages differ from actual raw query')
    proposed = {row['name']: row['version'] for row in plan['newOrChangedPackages']}
    if len(proposed) != len(plan['newOrChangedPackages']) or not proposed:
        raise ValueError('Incomplete or duplicate apt plan')
    if sorted(plan['requestedPackages']) != APT:
        raise ValueError('Original Office apt functionality was removed or widened')
    if not set(APT) <= baseline.keys() | proposed.keys():
        raise ValueError('A required Office package is unavailable')
    for name, version in proposed.items():
        if (not re.fullmatch(r'[a-z0-9][a-z0-9+.-]*', name)
                or not re.fullmatch(r'[A-Za-z0-9.+:~_-]+', version)
                or baseline.get(name) == version):
            raise ValueError('Invalid exact apt mutation selector')
    if parse_apt_simulation((directory / 'apt-plan.raw').read_text()) != proposed:
        raise ValueError('Parsed apt plan differs from original simulation')
    return [(PREFIX + 'v6-build/' + name, (directory / name).read_bytes(), 0o444)
            for name in ('base-dpkg.json', 'apt-plan.json', 'base-dpkg.raw', 'apt-plan.raw')]


def split_inputs(directory, original):
    """Use only the independently reviewed actual192/59 solver input, never the static193/58 union."""
    raw_plan = (directory / 'ACTUAL-STAGE1-PLAN.json').read_bytes()
    if sha256(raw_plan) != STAGE1_PLAN_SHA256:
        raise ValueError('Approved actual stage-one plan digest differs')
    first = json.loads(raw_plan)
    raw = (directory / 'APT-STAGE1-SIMULATION.raw').read_bytes()
    metadata = (directory / 'APT-STAGE1-SELECTED-METADATA.raw').read_bytes()
    if (sha256(raw) != first['rawEvidenceSha256'] or sha256(metadata) != first['rawMetadataSha256']
            or first['baseImage'] != SSH_BASE_IMAGE or first['architecture'] != 'arm64'
            or first['observationKind'] != 'actual-readonly-owner-observation'
            or first['actualAptExitCode'] != 0 or first['freshSignedIndexActualExitCode'] != 0
            or first['removals'] != [] or sorted(first['requestedPackages']) != APT_FIRST):
        raise ValueError('Actual stage-one raw observation or exact direct roots differ')
    base = json.loads((original / 'base-dpkg.json').read_text())
    full = json.loads((original / 'apt-plan.json').read_text())
    before, delta, after = phase_maps('apt-office', base, full, first)
    second_before, second_delta, final = phase_maps('apt-tex', base, full, first)
    if (parse_apt_simulation(raw.decode()) != delta or after != second_before
            or (len(before), len(delta), len(after), len(second_delta), len(final)) != (97, 192, 287, 59, 345)):
        raise ValueError('Actual stage package maps differ from the reviewed97→287→345 chain')
    members = [(PREFIX + 'v6-build/apt-stage1.json', raw_plan, 0o444),
               (PREFIX + 'v6-build/apt-stage1.raw', raw, 0o444),
               (PREFIX + 'v6-build/apt-stage1-metadata.raw', metadata, 0o444)]
    maps = {}
    for phase in ('apt-office', 'apt-tex'):
        previous, changed, target = phase_maps(phase, base, full, first)
        maps[phase] = {'beforeCount': len(previous), 'beforeSha256': map_sha256(previous),
                       'changedCount': len(changed), 'changedSha256': map_sha256(changed),
                       'expectedCount': len(target), 'expectedMapSha256': map_sha256(target)}
    return members, maps


def archive_bytes(members):
    """Set asset directory/file modes before COPY, avoiding later full-tree copy-up."""
    names = [name for name, _, _ in members]
    if len(names) != len(set(names)):
        raise ValueError('Duplicate context member')
    result = io.BytesIO()
    with tarfile.open(fileobj=result, mode='w', format=tarfile.USTAR_FORMAT) as archive:
        parents = set()
        for name in names:
            parents.update(str(parent) for parent in PurePosixPath(name).parents if str(parent) != '.')
        for name in sorted(parents, key=lambda name: (name.count('/'), name)):
            info = tarfile.TarInfo(name + '/')
            info.type = tarfile.DIRTYPE
            info.mode = 0o555 if name.startswith(ASSETS.rstrip('/')) else 0o755
            archive.addfile(info)
        for name, data, mode in sorted(members):
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = 0o444 if name.startswith(ASSETS) else mode
            archive.addfile(info, io.BytesIO(data))
    return result.getvalue()


def materialize(context, manifest, wheelhouse, wheel_manifest, output, observations=None, url_report=None, stage1_directory=None):
    """Write only a new owned archive and manifest; missing observations leave a non-buildable template."""
    if (observations is None) != (stage1_directory is None):
        raise ValueError('Both original owner inputs and actual stage-one inputs are required together')
    if sha256(wheel_manifest.read_bytes()) != WHEEL_MANIFEST_SHA256:
        raise ValueError('Approved complete wheel-manifest digest differs')
    members = verify_context(context, manifest.read_bytes())
    original = {name: sha256(data) for name, data, _ in members}
    here = Path(__file__).parent
    members += [(PREFIX + 'Dockerfile.v6', (here / 'Dockerfile.v6').read_bytes(), 0o444),
                (PREFIX + 'v6-build/install.py', (here / 'install_v6.py').read_bytes(), 0o444)]
    old_runtime = 'packages/cloud/pe-opensandbox/runtime/office/'
    for name in ('prepare-fonts.py', 'word_catalog.py', 'refresh_word.py', 'runtime-manifest.py'):
        members.append((PREFIX + 'v6-build/' + name, (context / old_runtime / name).read_bytes(), 0o444))
    members += wheel_inputs(wheelhouse, json.loads(wheel_manifest.read_text()),
                            json.loads(url_report.read_text()) if url_report is not None else None)
    maps = None
    if observations is not None:
        members += owner_inputs(observations)
        extra, maps = split_inputs(stage1_directory, observations)
        members += extra
    raw = archive_bytes(members)
    output.mkdir(mode=0o700)
    (output / 'context-v6.tar').write_bytes(raw)
    record = {
        'schema': 'office-v6-two-apt-frozen-context-v1', 'baseImage': SSH_BASE_IMAGE,
        'dockerfile': PREFIX + 'Dockerfile.v6',
        'stages': ['office-system', 'office-apt', 'office-complete'],
        'aptPhases': ['apt-office', 'apt-tex'], 'phasePackageMaps': maps,
        'stage1ActualPlanSha256': STAGE1_PLAN_SHA256 if maps is not None else None,
        'aptStageRequiresSeparatePeakReview': True,
        'wheelManifestSha256': WHEEL_MANIFEST_SHA256,
        'original251ResourceHashesPreserved': all(original[name] == sha256(data) for name, data, _ in members if name in original),
        'completeOriginalFileCount': len(original), 'templateOnly': observations is None,
        'ownerPrerequisitesPresent': observations is not None, 'resourceChangePerformed': False,
        'imageBuilt': False, 'productionImportAdmitted': False,
        'contextTarBytes': len(raw), 'contextTarSha256': sha256(raw),
        'pythonAcquisition': 'official-direct-https-urls' if url_report is not None else 'offline-wheel-copy',
        'urlReportSha256': sha256(url_report.read_bytes()) if url_report is not None else None,
        'retainedWheelCopyLayerBytes': 0 if url_report is not None else sum(row['archiveBytes'] for row in json.loads(wheel_manifest.read_text())['packages']),
        'wheelFilenameMappings': [{'original': row['wheel'], 'buildContext': wheel_filename(row['wheel']), 'sha256': row['sha256']}
                                 for row in json.loads(wheel_manifest.read_text())['packages']],
        'wheelLayerNote': 'Direct URLs retain exact28hashes and download only during RUN; offline COPY retains compressed wheels in a lower layer even after cleanup. Download working-set peak remains a separate gate.',
        'files': [{'path': name, 'bytes': len(data), 'sha256': sha256(data)} for name, data, _ in sorted(members)],
    }
    (output / 'manifest-v6.json').write_text(json.dumps(record, indent=2) + '\n')
    return record


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('context', 'manifest', 'wheelhouse', 'wheel-manifest', 'output'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--owner-inputs', type=Path)
    parser.add_argument('--url-report', type=Path)
    parser.add_argument('--stage1-inputs', type=Path)
    args = parser.parse_args()
    result = materialize(args.context, args.manifest, args.wheelhouse, args.wheel_manifest, args.output, args.owner_inputs, args.url_report, args.stage1_inputs)
    print(json.dumps({key: result[key] for key in ('templateOnly', 'contextTarBytes', 'contextTarSha256', 'original251ResourceHashesPreserved')}))
