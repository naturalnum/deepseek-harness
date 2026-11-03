"""Record the actual guest interpreter and distributions in the native payload format."""
import importlib.metadata
import json
import pathlib
import platform
import subprocess
root = pathlib.Path('/opt/dsh/runtime')
(root / 'runtime.json').write_text(json.dumps({
    'desktopVersion': 'dsh-cloud-office-candidate', 'platform': 'linux', 'arch': 'arm64',
    'python': platform.python_version(),
    'node': subprocess.check_output([str(root / 'dependencies/node/bin/node'), '--version'], text=True).strip().lstrip('v'),
    'pythonPackages': {d.metadata['Name']: d.version for d in importlib.metadata.distributions()},
}, indent=2) + '\n')
