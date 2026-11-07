"""Verify real scientific imports and offline OCR models, preserving the inherited Office runtime record."""
import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import platform
import runpy
import sys

parser = argparse.ArgumentParser()
parser.add_argument('--baseline', required=True)
parser.add_argument('--runtime', required=True)
parser.add_argument('--document-script', required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()
baseline = json.loads(Path(args.baseline).read_text())
packages = {item.metadata['Name'].lower().replace('_', '-'): item.version for item in importlib.metadata.distributions()}
if sys.version_info[:2] != (3, 13):
    raise RuntimeError('This research qualification requires Python 3.13')
for name, version in baseline['packages'].items():
    if packages.get(name) != version:
        raise RuntimeError('An inherited Office distribution changed: ' + name)
if hashlib.sha256(Path(args.runtime).read_bytes()).hexdigest() != baseline['officeRuntimeSha256']:
    raise RuntimeError('The inherited Office runtime manifest changed')
for name, version in {'airalogy': '0.16.0', 'pymupdf': '1.26.7', 'rapidocr': '3.10.0', 'onnxruntime': '1.31.1'}.items():
    if packages.get(name) != version:
        raise RuntimeError('A scientific runtime version differs: ' + name)
# These are the actual APIs used by the retained protocol executor.
from airalogy.assigner import DefaultAssigner
from airalogy.ingest import import_records
from airalogy.migrations import apply_declarative_migration, migration_rule_hash, validate_migration_manifest
from airalogy.markdown import extract_assigner_blocks, generate_model, parse_aimd
from airalogy.markdown.errors import AimdParseError
from airalogy.markdown.model_sync import merge_var_models
import numpy
import pymupdf
import rapidocr
import onnxruntime
from PIL import Image

source = runpy.run_path(args.document_script)
source['create_ocr']()
model_root = Path(rapidocr.__file__).parent / 'models'
models = {}
for name in ['PP-OCRv6_det_small.onnx', 'ch_ppocr_mobile_v2.0_cls_mobile.onnx', 'PP-OCRv6_rec_small.onnx']:
    data = (model_root / name).read_bytes()
    models[name] = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
Path(args.output).write_text(json.dumps({'schema': 1, 'python': platform.python_version(), 'packages': packages,
    'ocrModels': models, 'officeRuntimeSha256': baseline['officeRuntimeSha256'],
    'qualification': 'imports-and-offline-model-load-only'}, indent=2, sort_keys=True) + '\n')
