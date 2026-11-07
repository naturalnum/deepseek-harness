"""Execution transport only. Scientific semantics come from the original executors."""
import base64
import contextlib
import io
import json
import os
from pathlib import Path
import runpy
import sys

payload = json.load(sys.stdin)
root = Path(os.environ.get('EPRI_EXECUTION_ROOT', '/tmp/airalogy')).resolve()
root.mkdir()
os.chdir(root)
package = root / ('workflow' if payload['action'] == 'workflow_assign' else 'protocol')
package.mkdir()
for name, data in payload['files'].items():
    target = (package / name).resolve()
    if not target.is_relative_to(package):
        raise ValueError('Invalid package path')
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(base64.b64decode(data, validate=True))
for name, source in payload['executors'].items():
    (root / name).write_text(source, encoding='utf-8')
input_dir = root / 'inputs'
input_dir.mkdir()
file_map = {}
for index, (file_id, item) in enumerate(payload.get('attachments', {}).items()):
    target = input_dir / str(index)
    target.write_bytes(base64.b64decode(item['contentBase64'], validate=True))
    file_map[file_id] = {'path': str(target), 'file_name': item['name']}
output_dir = root / 'outputs'
output_dir.mkdir()
os.environ['AIRALOGY_LOCAL_FILE_MAP_JSON'] = json.dumps(file_map)
os.environ['AIRALOGY_LOCAL_FILE_OUTPUT_DIR'] = str(output_dir)
os.environ['AIRALOGY_WORKFLOW_DIR'] = str(package)
sys.path.insert(0, str(root))
if payload['action'] == 'workflow_assign':
    executor = 'workflow_executor.py'
    sys.argv = [executor, json.dumps(payload['params'])]
else:
    executor = 'protocol_executor.py'
    sys.argv = [executor, payload['action'], 'protocol', json.dumps(payload['params'])]
capture = io.StringIO()
with contextlib.redirect_stdout(capture):
    try:
        runpy.run_path(str(root / executor), run_name='__main__')
    except SystemExit as exc:
        if exc.code not in (0, None):
            raise
lines = capture.getvalue().strip().splitlines()
result = json.loads(lines[-1])
files = []
total = 0
for target in output_dir.rglob('*'):
    if target.is_symlink() or not target.is_file() or not target.resolve().is_relative_to(output_dir):
        continue
    total += target.stat().st_size
    if total > 2 * 1024 * 1024 or len(files) >= 30:
        raise ValueError('Generated files exceed 2 MiB / 30 files')
    files.append({'name': str(target.relative_to(output_dir)), 'contentBase64': base64.b64encode(target.read_bytes()).decode()})
if files:
    result['files'] = files
print(json.dumps(result, ensure_ascii=False))
