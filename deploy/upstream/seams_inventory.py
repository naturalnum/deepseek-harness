#!/usr/bin/env python3
"""Generate or check Native interface tables from the current Git checkout."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys

sys.dont_write_bytecode = True

from seams_classify import OWN, TEST, internals, ledger, native_source
from render_seams import render

HERE = Path(__file__).resolve().parent


def git(root, *args):
    """Read Git without changing references, index or source files."""
    return subprocess.check_output(['git', *args], cwd=root).decode()


def collect(root, base):
    """Read the current worktree and the caller-selected Native comparison base."""
    git(root, 'rev-parse', '--verify', '--end-of-options', base + '^{commit}')
    fields = git(root, 'diff', '--name-status', '-z', '-M', base, '--').split('\0')
    changed = set()
    added = set()
    index = 0
    while index < len(fields) - 1:
        status, path = fields[index:index + 2]
        index += 2
        if status.startswith(('R', 'C')):
            path = fields[index]
            index += 1
        if native_source(path):
            (added if status.startswith('A') else changed).add(path)
    rows = ledger((root / 'deploy/upstream/ledger.tsv').read_text())
    by_path = {row['路径']: row for row in rows}
    paths = sorted(set(git(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0')))
    sources = {}
    mounts = []
    for path in paths:
        if not OWN.search(path) or TEST.search(path):
            continue
        source = root / path
        if not source.is_file() or source.is_symlink():
            continue
        if re.search(r'(?:/src/|^deploy/upstream/).*\.(?:ts|tsx|mts)$', path):
            sources[path] = source.read_text()
        elif path.endswith(('.yml', '.yaml')):
            text = source.read_text()
            for number, line in enumerate(text.splitlines(), 1):
                match = re.search(r'\bname:\s*[\'\"]?(@deepseek-ai/(?:dsh-|cordis)[\w./-]+)', line)
                if match and not re.search(r'/dsh-(?:pe-|remote-server)', match[1]):
                    mounts.append(dict(path=path, line=number, entry=match[1], modules=[match[1]], expression=line.strip()))
    syntax = json.loads(subprocess.check_output(['node', str(HERE / 'seams_ast.mjs')], cwd=root,
        input=json.dumps({'files': [dict(path=path, text=text) for path, text in sources.items()]}).encode()))
    reads = internals(sources)
    non_seam = sum(by_path.get(path, {}).get('类别') != '扩展点' for path in changed)
    for row in rows:
        row['changed'] = row['路径'] in changed
        row['added'] = row['路径'] in added
    return dict(counts=dict(native_source_files=len(changed), non_seam_files=non_seam,
                            uncentralized_internal_lines=sum(not row['centralized'] for row in reads)),
                added_native_sources=sorted(added),
                added_native_counts=dict(total=len(added),
                    skill_assets=sum(path.startswith('packages/skill/skill-office/assets/') for path in added),
                    root_scripts=sum(path.startswith('scripts/') for path in added),
                    src=sum(not path.startswith(('scripts/', 'packages/skill/skill-office/assets/')) for path in added)),
                imports=syntax['imports'], unresolved_imports=syntax['unresolvedImports'], inheritance=syntax['inheritance'],
                mounts=sorted(syntax['mounts'] + mounts, key=lambda row: (row['path'], row['line'], row['entry'])),
                internals=reads, ledger=rows, unlisted_native_sources=sorted((changed | added) - by_path.keys()))


def main():
    """Use one command for generation, drift checking and the three measured counts."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('upstream_base')
    parser.add_argument('--repo', type=Path)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--write', action='store_true')
    mode.add_argument('--counts', action='store_true')
    parser.add_argument('--check-centralized', action='store_true')
    args = parser.parse_args()
    root = args.repo or Path(git(HERE, 'rev-parse', '--show-toplevel').strip())
    data = collect(root, args.upstream_base)
    print(json.dumps(data['counts'], ensure_ascii=False))
    if args.counts:
        return 0
    if args.check_centralized and data['counts']['uncentralized_internal_lines']:
        print('Native internal reads remain outside the declared central files.', file=sys.stderr)
        return 1
    stale = []
    for name, content in render(data).items():
        output = root / 'deploy/upstream' / name
        if args.write:
            output.write_text(content)
        elif not output.exists() or output.read_text() != content:
            stale.append(name)
    if stale:
        print('Interface inventory drift: ' + ', '.join(stale) + '; regenerate with --write.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(2)
