"""Add the reviewed SSH workload supplier to the exact original Native server policy."""
from pathlib import Path
import hashlib
import py_compile

BEFORE = '8616eac997d59b5b9603c73d94507cc8f71a81b876b74ed3e412361ab41fb835'
AFTER = '4557a2744b784f4b6480a4a5a5dcb26c492c006e145c1cb7771939b5b78498d1'
NEEDLE = """        selected_image = ('sha256:62016189c3c5cec1c88d10af21b5dc0dfac0fc2247cd66709374dbdfc9d1135a'
                          if native else FIXED_IMAGE)
        require(self.policy['image'] == selected_image and self.policy['platform'] == 'arm64'
"""
REPLACEMENT = """        selected_images = (('sha256:62016189c3c5cec1c88d10af21b5dc0dfac0fc2247cd66709374dbdfc9d1135a',
                            'sha256:c75632ff5ced1d239c688e836c383ce3629ef1a93f7b698294345f2aa8074f2d')
                           if native else (FIXED_IMAGE,))
        require(self.policy['image'] in selected_images and self.policy['platform'] == 'arm64'
"""


def patch_source(raw: bytes) -> bytes:
    """Preserve every other original profile, authentication and request-binding check."""
    if hashlib.sha256(raw).hexdigest() != BEFORE:
        raise RuntimeError('Original Native completion policy source digest changed')
    source = raw.decode('utf8')
    if source.count(NEEDLE) != 1:
        raise RuntimeError('Original Native workload selection target changed')
    result = source.replace(NEEDLE, REPLACEMENT).encode('utf8')
    if hashlib.sha256(result).hexdigest() != AFTER:
        raise RuntimeError('Native workload selection patch digest differs')
    return result


if __name__ == '__main__':
    path = Path('/usr/local/lib/python3.12/site-packages/opensandbox_server/services/docker/completion_view.py')
    path.write_bytes(patch_source(path.read_bytes()))
    py_compile.compile(str(path), doraise=True)
