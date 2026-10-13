#!/usr/bin/env python3
"""Validate migrated rule blocks against their recorded IDs and hashes after approved rule evolution."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path

BLOCK_RE = re.compile(
    r"<!-- MIGRATED_RULE_BLOCK id=(?P<id>[^ ]+) sha256=(?P<sha>[0-9a-f]{64}) -->\n"
    r"(?P<body>.*?)"
    r"<!-- END_MIGRATED_RULE_BLOCK id=(?P=id) -->",
    re.S,
)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', default=None, help='Skill root; defaults to parent of scripts/')
    args = parser.parse_args()
    root = Path(args.root).resolve() if args.root else Path(__file__).resolve().parents[1]
    manifest_path = root / 'references' / 'rule-migration-manifest-v3.6.0.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    errors: list[str] = []
    checked = 0

    for item in manifest['blocks']:
        path = root / item['target_file']
        if not path.exists():
            errors.append(f"missing target file: {item['target_file']}")
            continue
        text = path.read_text(encoding='utf-8')
        found = {m.group('id'): m for m in BLOCK_RE.finditer(text)}
        block_id = item['id']
        if block_id not in found:
            errors.append(f"missing block {block_id} in {item['target_file']}")
            continue
        body = found[block_id].group('body')
        # File writer inserts one separator newline after every original fragment.
        # Remove exactly one separator newline before hashing when present.
        if body.endswith('\n\n'):
            body_for_hash = body[:-1]
        else:
            body_for_hash = body
        actual = hashlib.sha256(body_for_hash.encode('utf-8')).hexdigest()
        marker_sha = found[block_id].group('sha')
        expected = item['sha256']
        if marker_sha != expected:
            errors.append(f"marker hash mismatch for {block_id}: {marker_sha} != {expected}")
        if actual != expected:
            errors.append(f"content hash mismatch for {block_id}: {actual} != {expected}")
        checked += 1

    if errors:
        print('FAIL')
        for error in errors:
            print(f'- {error}')
        return 1
    print(f'PASS: {checked} migrated rule blocks are intact.')
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
