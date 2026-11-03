#!/usr/bin/env python3
"""Require expected Chinese text through the selected guest Poppler executable."""
import argparse
import hashlib
import json
from pathlib import Path
import resource
import subprocess


def file_digest(path):
    """Hash the source without buffering the full PDF."""
    value = hashlib.sha256()
    with path.open('rb') as reader:
        for chunk in iter(lambda: reader.read(65536), b''):
            value.update(chunk)
    return value.hexdigest()


def limits():
    """Retain the original per-command ceilings for this disposable CLI probe."""
    for kind, value in [(resource.RLIMIT_AS, 536870912), (resource.RLIMIT_FSIZE, 67108864),
                        (resource.RLIMIT_NOFILE, 64), (resource.RLIMIT_NPROC, 64),
                        (resource.RLIMIT_CPU, 75), (resource.RLIMIT_CORE, 0)]:
        resource.setrlimit(kind, (value, value))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--pdftotext', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--required-text', required=True, action='append')
    args = parser.parse_args()
    source = args.source.resolve(strict=True)
    if not args.pdftotext.is_absolute() or any(not value.strip() for value in args.required_text):
        parser.error('Select an absolute executable and nonempty expected text')
    original = file_digest(source)
    with args.output.open('xb') as output:
        subprocess.run([str(args.pdftotext), '-layout', str(source), '-'],
                       stdout=output, check=True, preexec_fn=limits, timeout=30)
    text = args.output.read_text(encoding='utf-8')
    normalized = ''.join(text.split())
    missing = [value for value in args.required_text if ''.join(value.split()) not in normalized]
    if file_digest(source) != original:
        raise RuntimeError('PDF source changed during the probe')
    result = {'sourceSha256': original, 'missingText': missing,
              'chineseCharacters': sum('\u4e00' <= character <= '\u9fff' for character in text),
              'scope': 'Poppler CLI only; default image/account/model qualification is separate'}
    print(json.dumps(result, ensure_ascii=False))
    if missing:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
