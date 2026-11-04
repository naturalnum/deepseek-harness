"""Build separate system and Office payload layers using exact owner observations."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import uuid

ROOT = Path('/opt/office-build')


def installed():
    """Return only actually installed Debian package versions."""
    text = subprocess.check_output(['dpkg-query', '-W', '-f', '${db:Status-Status}\t${Package}\t${Version}\n'], text=True)
    return {name: version for status, name, version in (line.split('\t') for line in text.splitlines())
            if status == 'installed'}


def parse_apt_simulation(text):
    """Read exact versions proposed by the original apt simulation, never a rounded size summary."""
    selected = {}
    for line in text.splitlines():
        if line.startswith('Remv '):
            raise ValueError('Office preparation must not remove an installed package')
        if line.startswith('Inst '):
            match = re.match(r'^Inst ([a-z0-9+.-]+)(?::arm64)?(?: \[[^\]]+\])? \(([^ ]+)', line)
            if match is None or match[1] in selected:
                raise ValueError('Unexpected apt simulation record')
            selected[match[1]] = match[2]
    return selected


def readonly_tree(root):
    """Freeze newly created payloads in this same RUN, excluding symlink targets."""
    for directory, children, files in os.walk(root, followlinks=False):
        for name in [*files, *children]:
            path = Path(directory) / name
            if not path.is_symlink():
                readonly_mode(path)
        readonly_mode(Path(directory))


def readonly_mode(path):
    """Do not mutate an already read-only inode merely to repeat its current mode."""
    current = path.stat().st_mode & 0o777
    wanted = current & 0o555
    if current != wanted:
        path.chmod(wanted)


def observations():
    """Both stages require the original exact owner files, never an inferred package baseline."""
    base_file, plan_file, stage1_file = ROOT / 'base-dpkg.json', ROOT / 'apt-plan.json', ROOT / 'apt-stage1.json'
    if not all(path.is_file() for path in (base_file, plan_file, stage1_file)):
        raise ValueError('Missing actual owner base/dpkg and apt-plan inputs; template is not buildable')
    base, plan = json.loads(base_file.read_text()), json.loads(plan_file.read_text())
    return base, plan, json.loads(stage1_file.read_text())


def package_map(rows):
    """Read one complete unique package map from its already reviewed owner record."""
    result = {row['name']: row['version'] for row in rows}
    if len(result) != len(rows):
        raise ValueError('Repeated package in the owner plan')
    return result


def map_sha256(value):
    """Use the same canonical map bytes for materialization and live commit checkpoints."""
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def phase_maps(phase, base, full, first):
    """Derive I0→I1→F from the actual stage-one solver and the unchanged full target."""
    initial = package_map(base['packages'])
    full_delta = package_map(full['newOrChangedPackages'])
    first_delta = package_map(first['newOrChangedPackages'])
    final = {**initial, **full_delta}
    if not first_delta or any(full_delta.get(name) != version or initial.get(name) == version
                              for name, version in first_delta.items()):
        raise ValueError('Stage-one mutation is not an exact subset of the full target')
    intermediate = {**initial, **first_delta}
    second_delta = {name: version for name, version in final.items() if intermediate.get(name) != version}
    if not second_delta or package_map(first['stage2RemainingChangedPackages']) != second_delta:
        raise ValueError('Stage-two remainder differs from the original full target')
    if phase == 'apt-office':
        return initial, first_delta, intermediate
    if phase == 'apt-tex':
        return intermediate, second_delta, final
    raise ValueError('Unknown fixed apt phase')


def clean_payload_preflight():
    """Fail before apt or payload work if the original interpreter contract is unavailable."""
    if not os.access('/opt/dsh-native/node', os.X_OK):
        raise ValueError('Original nativeNode executable is unavailable')
    subprocess.run(['python3', '-c', 'import ensurepip, venv'], check=True)
    if Path('/opt/dsh/runtime').exists() or Path('/opt/dsh/fonts').exists():
        raise ValueError('Unexpected prior Office payload; refusing lower-layer chmod/copy-up')


def await_apt_commit(phase, expected, root=ROOT, timeout_seconds=900):
    """Hold this owned build RUN for the runtime owner's external upper-layer/physical checks."""
    if phase not in ('apt-office', 'apt-tex'):
        raise ValueError('Unknown fixed apt commit phase')
    actual = installed()
    if actual != expected:
        raise ValueError('Actual package map changed before its commit checkpoint')
    approval = root / (phase + '-commit-approval.json')
    if approval.exists():
        raise ValueError('Pre-existing apt commit approval is not admissible')
    request = {
        'kind': 'office-apt-commit-checkpoint-v2', 'phase': phase, 'requestId': uuid.uuid4().hex,
        'installerSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'systemPackagesSha256': map_sha256(actual), 'expectedPackageMapSha256': map_sha256(expected),
        'expectedPackageCount': len(expected),
        'timeoutSeconds': timeout_seconds,
        'requiredStoreReserveBytes': 268435456, 'requiredMemoryReserveBytes': 536870912,
    }
    (root / (phase + '-commit-request.json')).write_text(json.dumps(request, sort_keys=True) + '\n')
    print(json.dumps({'officeAptReadyForCommit': request}), flush=True)
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if approval.exists():
            response = json.loads(approval.read_text())
            if response != {'requestId': request['requestId'], 'phase': phase,
                            'expectedPackageMapSha256': request['expectedPackageMapSha256'], 'decision': 'approve'}:
                raise ValueError('Apt commit approval does not match this live checkpoint')
            print(json.dumps({'officeAptCommitReleased': request['requestId']}), flush=True)
            return
        time.sleep(1)
    raise TimeoutError('Apt commit was not admitted before the finite checkpoint deadline')


def install_apt(phase):
    """Commit only the system dependency layer so its working-copy peak stays separate."""
    base, plan, first = observations()
    expected_base, expected, target = phase_maps(phase, base, plan, first)
    before = installed()
    if before != expected_base:
        raise ValueError('Actual build base dpkg state differs from the admitted input')
    clean_payload_preflight()
    # The custom configuration is generated only in the payload stage. Use system defaults for apt triggers.
    os.environ.pop('FONTCONFIG_FILE', None)
    for name, version in expected.items():
        if name in before:
            subprocess.run(['dpkg', '--compare-versions', version, 'gt', before[name]], check=True)
    pins = [name + '=' + version for name, version in sorted(expected.items())]
    # Simulate immediately against the same fresh indexes before performing any package installation.
    subprocess.run(['apt-get', 'update'], check=True)
    command = ['apt-get', '--no-install-recommends', 'install', *pins]
    simulation = subprocess.check_output([*command[:1], '-s', *command[1:]], text=True)
    if parse_apt_simulation(simulation) != expected:
        raise ValueError('Refreshed apt resolution differs from the approved complete plan')
    subprocess.run([*command[:1], '-y', *command[1:]], check=True)
    after = installed()
    if after != target:
        raise ValueError('Actual apt mutation differs from the approved complete plan')
    for path in (Path('/var/lib/apt/lists'), Path('/var/cache/apt/archives')):
        for child in path.iterdir():
            if child.is_dir():
                shutil.rmtree(child)
            else:
                child.unlink()
    await_apt_commit(phase, target)


def install_payload():
    """Freeze only newly created Python/font/runtime files, without touching the apt tree."""
    base, plan, first = observations()
    _, _, expected = phase_maps('apt-tex', base, plan, first)
    after = installed()
    if after != expected:
        raise ValueError('Actual system-stage package map differs before payload installation')
    clean_payload_preflight()
    runtime = Path('/opt/dsh/runtime')
    python_root = runtime / 'dependencies/python'
    subprocess.run(['python3', '-m', 'venv', str(python_root)], check=True)
    python = str(python_root / 'bin/python3')
    acquisition = ['--find-links', str(ROOT / 'wheels')] if (ROOT / 'wheels').is_dir() else []
    subprocess.run([python, '-m', 'pip', 'install', '--no-index', *acquisition,
                    '--no-cache-dir', '--no-compile', '--require-hashes',
                    '-r', str(ROOT / 'requirements.lock')], check=True)
    node_bin = runtime / 'dependencies/node/bin'
    node_bin.mkdir(parents=True)
    (runtime / 'dependencies/node/node_modules').mkdir()
    (node_bin / 'node').symlink_to('/opt/dsh-native/node')
    subprocess.run([python, str(ROOT / 'prepare-fonts.py')], check=True)
    office = runtime / 'office'
    office.mkdir()
    for name in ('word_catalog.py', 'refresh_word.py'):
        shutil.copyfile(ROOT / name, office / name)
        (office / name).chmod(0o555)
    # Preserve both published paths while storing every report member only once.
    skills = Path('/opt/dsh/skills')
    (skills / 'reports').symlink_to('office/reports')
    for directory, _, files in os.walk(skills / 'office'):
        for path in [Path(directory), *(Path(directory) / name for name in files)]:
            if path.stat().st_mode & 0o222:
                raise ValueError('Asset source modes must be read-only before COPY, not changed in a later layer')
    subprocess.run([python, str(ROOT / 'runtime-manifest.py')], check=True)
    (runtime / 'system-packages.json').write_text(json.dumps(after, sort_keys=True, indent=2) + '\n')
    shutil.copyfile(ROOT / 'apt-plan.json', runtime / 'apt-plan.json')
    shutil.copyfile(ROOT / 'apt-stage1.json', runtime / 'apt-stage1.json')
    shutil.copyfile(ROOT / 'requirements.lock', runtime / 'requirements.lock')
    readonly_tree(runtime)
    readonly_tree(Path('/opt/dsh/fonts'))
    readonly_mode(skills)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=('apt-office', 'apt-tex', 'payload'))
    phase = parser.parse_args().phase
    if phase == 'payload':
        install_payload()
    else:
        install_apt(phase)
