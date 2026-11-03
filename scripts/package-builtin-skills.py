#!/usr/bin/env python3
"""Build or verify deterministic complete-package carriers beside bundled skill roots."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import zipfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--check', action='store_true')
args = parser.parse_args()
repo = Path(__file__).resolve().parent.parent
for relative in ['packages/skill/skill-office/assets', 'packages/skill/skill-office/assets/reports']:
    for root in sorted((repo / relative).iterdir()):
        if not root.is_dir() or not (root / 'SKILL.md').is_file():
            continue
        files, output = [], io.BytesIO()
        with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(root.rglob('*')):
                if path.is_symlink():
                    raise ValueError(f'Skill resource links are not packaged: {path}')
                if not path.is_file() or path.name.startswith('.dsh-package'):
                    continue
                data, name = path.read_bytes(), path.relative_to(root).as_posix()
                files.append(dict(relativePath=name, bytes=len(data), sha256=hashlib.sha256(data).hexdigest()))
                info = zipfile.ZipInfo(name, (2026, 11, 3, 0, 0, 0))
                info.compress_type, info.external_attr = zipfile.ZIP_DEFLATED, 0o100444 << 16
                archive.writestr(info, data)
        data = output.getvalue()
        version = hashlib.sha256(json.dumps(files, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
        manifest = dict(version=version, files=files, archive=dict(bytes=len(data), sha256=hashlib.sha256(data).hexdigest()))
        expected = {'.dsh-package.json': (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode(), '.dsh-package.zip': data}
        for name, value in expected.items():
            path = root / name
            if args.check:
                if path.read_bytes() != value:
                    raise ValueError(f'Packaged carrier is stale: {path}')
            else:
                path.write_bytes(value)
        print(root.name, len(files), version)
