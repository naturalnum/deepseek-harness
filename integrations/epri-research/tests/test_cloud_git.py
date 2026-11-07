"""Offline Git supplier acceptance and refusal checks; no Linux Git or Docker is executed."""
import hashlib
import importlib.util
import io
import json
import lzma
from pathlib import Path
import runpy
import struct
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


installer = load('cloud_git_installer', ROOT / 'scripts/install-cloud-git.py')
probe = load('cloud_git_probe', ROOT / 'scripts/cloud-git-probe.py')


def payload(extra=None):
    elf = b'\x7fELF\x02\x01' + b'\0' * 12 + struct.pack('<H', 183) + b'\0' * 16
    stream, rows = io.BytesIO(), []
    with tarfile.open(fileobj=stream, mode='w:xz') as archive:
        for name in ['.', './etc', './var', './usr', './usr/bin']:
            member = tarfile.TarInfo(name)
            member.type, member.mode = tarfile.DIRTYPE, 0o755
            archive.addfile(member)
            rows.append({'name': name, 'type': '5', 'mode': 0o755, 'size': 0, 'link': ''})
        member = tarfile.TarInfo('./usr/bin/git')
        member.size, member.mode = len(elf), 0o755
        archive.addfile(member, io.BytesIO(elf))
        rows.append({'name': member.name, 'type': '0', 'mode': 0o755, 'size': len(elf), 'link': '', 'sha256': installer.digest(elf)})
        if extra is not None:
            archive.addfile(extra)
    record = {'payload': {'members': len(rows), 'regularBytes': len(elf),
                         'manifestSha256': installer.digest(json.dumps(rows, sort_keys=True, separators=(',', ':')).encode())},
              'core': {'path': 'usr/bin/git', 'bytes': len(elf), 'sha256': installer.digest(elf), 'elfMachine': 183}}
    return stream.getvalue(), record


def ar(data):
    header = ('data.tar.xz'.ljust(16) + '0'.ljust(12) + '0'.ljust(6) + '0'.ljust(6)
              + '100644'.ljust(8) + str(len(data)).ljust(10) + '`\n').encode()
    return b'!<arch>\n' + header + data + (b'\n' if len(data) % 2 else b'')


class GitSupplierTests(unittest.TestCase):
    def test_accepts_exact_private_etc_usr_var_members_and_rejects_changed_elf_and_escaped_links(self):
        data, record = payload()
        installer.inspect_payload(installer.deb_data(ar(data)), record)
        wrong = {**record, 'core': {**record['core'], 'elfMachine': 62}}
        with self.assertRaisesRegex(ValueError, 'ELF differs'):
            installer.inspect_payload(data, wrong)
        for name, target in [('../escape', ''), ('/absolute', ''), ('./usr/bin/link', '../../../escape')]:
            member = tarfile.TarInfo(name)
            member.type, member.linkname = tarfile.SYMTYPE, target or '/outside'
            bad, _ = payload(member)
            with self.assertRaisesRegex(ValueError, 'escapes'):
                installer.inspect_payload(bad, record)

    def test_verifies_each_signed_release_index_package_and_base_keyring_before_installation(self):
        data, record = payload()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package = ar(data)
            index = ('Package: git\nVersion: pinned\nArchitecture: arm64\nFilename: pool/git.deb\n'
                     'Size: ' + str(len(package)) + '\nSHA256: ' + installer.digest(package) + '\n\n').encode()
            contents = [b'synthetic signed release', lzma.compress(index), package]
            names = ['InRelease', 'Packages.xz', 'git.deb']
            record.update({'package': 'git', 'version': 'pinned', 'architecture': 'arm64', 'packageFilename': 'pool/git.deb',
                           'indexReleasePath': 'main/binary-arm64/Packages.xz', 'indexUncompressedBytes': len(index),
                           'requiredPrimarySigningKeys': ['A' * 40]})
            record['inputs'] = []
            for name, content in zip(names, contents):
                (root / name).write_bytes(content)
                record['inputs'].append({'name': name, 'bytes': len(content), 'sha256': installer.digest(content)})
            keyring = root / 'keyring'
            keyring.write_bytes(b'synthetic immutable keyring')
            record['immutableBaseKeyring'] = {'bytes': keyring.stat().st_size, 'sha256': installer.digest(keyring.read_bytes())}
            release = 'SHA256:\n ' + record['inputs'][1]['sha256'] + ' ' + str(len(contents[1])) + ' ' + record['indexReleasePath'] + '\n'
            def verified(args, **kwargs):
                Path(args[args.index('--output') + 1]).write_text(release)
                return SimpleNamespace(stdout='[GNUPG:] VALIDSIG ' + 'A' * 40)
            with patch.object(installer.subprocess, 'run', side_effect=verified):
                self.assertEqual(installer.verify_source(record, root, keyring, Path('/reviewed-gpgv')), data)
                release = release.replace(record['inputs'][1]['sha256'], '0' * 64)
                with self.assertRaisesRegex(ValueError, 'does not bind'):
                    installer.verify_source(record, root, keyring, Path('/reviewed-gpgv'))
            keyring.write_bytes(b'changed')
            with patch.object(installer.subprocess, 'run') as verifier:
                with self.assertRaisesRegex(ValueError, 'keyring differs'):
                    installer.verify_source(record, root, keyring, Path('/reviewed-gpgv'))
                verifier.assert_not_called()
            (root / 'git.deb').write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'source input differs'):
                installer.checked_input(root, record['inputs'][2])

    def test_preserves_the_original_native_six_limits(self):
        directory = ROOT.parents[1] / 'packages/cloud/pe-opensandbox/runtime/agent'
        with patch.object(sys, 'path', [str(directory), *sys.path]):
            native = runpy.run_path(str(directory / 'wire.py'))['LIMITS']
        names = {'cpu': 'childCpuSeconds', 'address': 'childAddressBytes', 'file': 'childFileBytes',
                 'descriptors': 'childOpenFiles', 'processes': 'childProcesses', 'core': 'childCoreBytes'}
        self.assertEqual({key: value for key, (_, value) in probe.LIMITS.items()}, {key: native[name] for key, name in names.items()})

    def test_never_labels_an_unconfined_probe_as_managed(self):
        status = 'NoNewPrivs:\t0\nSeccomp:\t0\n'
        with patch.object(sys, 'argv', ['cloud-git-probe', '--managed']), patch.object(Path, 'read_text', return_value=status), patch.object(probe, 'qualify') as execute:
            with self.assertRaisesRegex(RuntimeError, 'original business guard'):
                probe.main()
            execute.assert_not_called()


if __name__ == '__main__':
    unittest.main()
