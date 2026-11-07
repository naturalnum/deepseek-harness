"""Measure the original Office interpreter separately from the independent scientific runtime."""
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import runpy
import stat
import subprocess
import sys
import sysconfig

OFFICE_PYTHON = '/opt/dsh/runtime/dependencies/python/bin/python3'
OFFICE_VERSION = '3.12.13'
OFFICE_RUNTIME = Path('/opt/dsh/runtime/runtime.json')
OFFICE_RUNTIME_SHA256 = '13eeff1ee75f7a8fec8f82b91e2193f73316a8f53551ac3f5733082d5c496c68'
RESEARCH_ROOT = Path('/opt/dsh/research/python')
SCIENTIFIC_PACKAGES = {'airalogy': '0.16.0', 'pymupdf': '1.26.7', 'rapidocr': '3.10.0',
                       'onnxruntime': '1.31.1', 'numpy': '2.3.4', 'pillow': '12.0.0', 'pandas': '2.3.3'}


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for part in iter(lambda: stream.read(1048576), b''):
            digest.update(part)
    return digest.hexdigest()


def packages():
    return {item.metadata['Name'].lower().replace('_', '-'): item.version for item in importlib.metadata.distributions()}


def tree(path):
    """Hash names, modes, symlink destinations and every regular-file byte without following symlinks."""
    digest = hashlib.sha256()
    files, size = 0, 0
    for item in [path] + sorted(path.rglob('*')):
        info = item.lstat()
        row = {'path': str(item.relative_to(path)), 'mode': stat.S_IMODE(info.st_mode)}
        if item.is_symlink():
            row['symlink'] = os.readlink(item)
        elif stat.S_ISREG(info.st_mode):
            row.update({'bytes': info.st_size, 'sha256': sha256(item)})
            files += 1
            size += info.st_size
        elif stat.S_ISDIR(info.st_mode):
            row['directory'] = True
        else:
            raise RuntimeError('Unexpected original Office filesystem member: ' + str(item))
        digest.update(json.dumps(row, sort_keys=True).encode() + b'\n')
    return {'sha256': digest.hexdigest(), 'files': files, 'bytes': size}


def observe_office():
    if platform.python_version() != OFFICE_VERSION or sys.executable != OFFICE_PYTHON:
        raise RuntimeError('Office observation requires its original exact interpreter')
    if sha256(OFFICE_RUNTIME) != OFFICE_RUNTIME_SHA256:
        raise RuntimeError('The original Office runtime manifest differs')
    roots = [Path('/opt/dsh/runtime'), Path('/opt/dsh/skills'), Path('/opt/dsh/fonts'),
             Path(sysconfig.get_path('stdlib')), Path('/usr/lib/libreoffice'), Path('/usr/share/fonts')]
    return {'python': platform.python_version(), 'executable': sys.executable,
            'executableSha256': sha256(Path(sys.executable).resolve()), 'packages': packages(),
            'runtimeSha256': sha256(OFFICE_RUNTIME), 'trees': {str(root): tree(root) for root in roots}}


def assert_office_preserved(before, after):
    if before != after:
        raise RuntimeError('Original Office interpreter, packages or protected bytes changed')


def observe_science(record, office, document_script):
    if platform.python_version() != record['version'] or sys.version_info[:2] != (3, 13):
        raise RuntimeError('The independent scientific interpreter version differs')
    if platform.machine() != 'aarch64' or Path(sys.prefix) != RESEARCH_ROOT:
        raise RuntimeError('Scientific Python must run from its independent Linux arm64 directory')
    if Path(sys.executable) != RESEARCH_ROOT / 'bin/python3':
        raise RuntimeError('Unexpected scientific Python executable')
    if any(not Path(item).is_relative_to(RESEARCH_ROOT) for item in sys.path if item):
        raise RuntimeError('Scientific Python imports an external interpreter path')
    observed = packages()
    for name, version in SCIENTIFIC_PACKAGES.items():
        if observed.get(name) != version:
            raise RuntimeError('A scientific package version differs: ' + name)
    # Actual APIs consumed by the preserved executors; they do not import Office packages.
    from airalogy.assigner import DefaultAssigner
    from airalogy.ingest import import_records
    from airalogy.migrations import apply_declarative_migration, migration_rule_hash, validate_migration_manifest
    from airalogy.markdown import extract_assigner_blocks, generate_model, parse_aimd
    from airalogy.markdown.errors import AimdParseError
    from airalogy.markdown.model_sync import merge_var_models
    import airalogy
    import numpy
    import pandas
    import pymupdf
    import rapidocr
    import onnxruntime
    import PIL
    for module in [airalogy, numpy, pandas, pymupdf, rapidocr, onnxruntime, PIL]:
        if not Path(module.__file__).resolve().is_relative_to(RESEARCH_ROOT):
            raise RuntimeError('Scientific package was loaded from outside its interpreter: ' + module.__name__)
    source = runpy.run_path(document_script)
    source['create_ocr']()
    models = {}
    for name in ['PP-OCRv6_det_small.onnx', 'ch_ppocr_mobile_v2.0_cls_mobile.onnx', 'PP-OCRv6_rec_small.onnx']:
        path = Path(rapidocr.__file__).parent / 'models' / name
        models[name] = {'bytes': path.stat().st_size, 'sha256': sha256(path)}
    linked = subprocess.run(['/usr/bin/ldd', sys.executable], check=True, capture_output=True, text=True).stdout
    if 'not found' in linked:
        raise RuntimeError('Scientific Python has an unresolved shared library')
    return {'schema': 2, 'python': platform.python_version(), 'executable': sys.executable,
            'executableSha256': sha256(Path(sys.executable).resolve()), 'pythonSource': record,
            'packages': observed, 'ocrModels': models, 'sharedLibraries': linked,
            'officePreserved': office, 'qualification': 'separate-interpreters-imports-and-offline-model-load-only'}


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest='command', required=True)
    before = commands.add_parser('snapshot-office')
    before.add_argument('--output', type=Path, required=True)
    after = commands.add_parser('verify-office')
    after.add_argument('--baseline', type=Path, required=True)
    after.add_argument('--output', type=Path, required=True)
    science = commands.add_parser('verify-science')
    science.add_argument('--record', type=Path, required=True)
    science.add_argument('--office', type=Path, required=True)
    science.add_argument('--document-script', required=True)
    science.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.command == 'snapshot-office':
        observed = observe_office()
    elif args.command == 'verify-office':
        observed = observe_office()
        assert_office_preserved(json.loads(args.baseline.read_text()), observed)
    else:
        observed = observe_science(json.loads(args.record.read_text()), json.loads(args.office.read_text()), args.document_script)
    args.output.write_text(json.dumps(observed, indent=2, sort_keys=True) + '\n')


if __name__ == '__main__':
    main()
