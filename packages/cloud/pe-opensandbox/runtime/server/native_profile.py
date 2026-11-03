"""Apply the fixed Native creation patch to the exact reviewed server source at image build time."""
from pathlib import Path
import hashlib
import py_compile
import textwrap


ROOT = Path('/usr/local/lib/python3.12/site-packages/opensandbox_server/services/docker')
PINS = {
    'container_ops.py': (
        '31c73448d9e7d9d7147bc9a8956c8d1f59760d2a46a19e124106ad60153a03d9',
        '7f1cb5e0309fb568528ea6e86ba88f639c3e8cd6253d19fbb2129f59eca4602b',
    ),
    'docker_service.py': (
        'f3a24e0bdcafbc4508daa089900fe3f7783b404f733ee52a04f002d2b78c2d86',
        '8d255753184dd56dd41ab05f02ade5131fea7ca1f9690b401a692a703400f24b',
    ),
}


def patch(name, source):
    if name == 'container_ops.py':
        needle = '            security_opts.append("systempaths=unconfined")\n'
        if source.count(needle) != 1:
            raise RuntimeError('Native system-path patch target changed')
        return source.replace(needle, '')
    comment = (
        '            # Inject the container permissions required by bwrap isolation.\n'
        '            # bwrap needs pivot_root/mount, including a fresh procfs, which are blocked\n'
        "            # by Docker's default AppArmor, seccomp, and protected-system-path settings.\n"
    )
    if source.count(comment) != 1:
        raise RuntimeError('Native isolation patch target changed')
    source = source.replace(comment, '')
    start = source.index('            if isolation_requested:\n')
    body = start + len('            if isolation_requested:\n')
    tmpfs = source.index('                tmpfs = dict(host_config_kwargs.get("tmpfs") or {})\n', body)
    warning = source.index('                logger.warning(\n', tmpfs)
    end = source.index('\n            if self.network_mode != HOST_NETWORK_MODE', warning)
    privileged = source[body:tmpfs]
    temporary = source[tmpfs:warning]
    diagnostic = source[warning:end]
    replacement = (
        '            if isolation_requested:\n'
        '                # The explicit Native profile retains its reviewed capabilities and seccomp.\n'
        '                if not self.app_config.docker.native_bwrap_profile:\n'
        + textwrap.indent(privileged + diagnostic, '    ')
        + temporary
    )
    return source[:start] + replacement + source[end:]


for name, (before, after) in PINS.items():
    path = ROOT / name
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != before:
        raise RuntimeError('Original Native server source digest changed')
    result = patch(name, raw.decode('utf-8')).encode('utf-8')
    if hashlib.sha256(result).hexdigest() != after:
        raise RuntimeError('Patched Native server source digest differs')
    path.write_bytes(result)
    py_compile.compile(str(path), doraise=True)
