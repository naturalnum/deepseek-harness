"""Verify source authorization and exact private-core replacement without executing a Host Git build."""
import importlib.util
import io
import json
import lzma
from pathlib import Path
import struct
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('cloud_git_build', ROOT / 'scripts/build-cloud-git.py')
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


def core(method=b'getrandom\0'):
    return b'\x7fELF\x02\x01' + b'\0' * 12 + struct.pack('<H', 183) + b'\0' * 16 + method


class GitSourceBuildTests(unittest.TestCase):
    def test_exact_archive_bounds_do_not_allow_a_path_to_escape_the_fresh_builder(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / 'source.tar.xz'
            with tarfile.open(archive, 'w:xz') as stream:
                member = tarfile.TarInfo('git-2.47.3/../escaped')
                member.size = 1
                stream.addfile(member, io.BytesIO(b'x'))
            record = {'archive': {'root': 'git-2.47.3', 'members': 1, 'regularBytes': 1}}
            with self.assertRaisesRegex(ValueError, 'source path escapes'):
                builder.extract_source(archive, record, root / 'work')
            self.assertFalse((root / 'work').exists())
            self.assertFalse((root / 'escaped').exists())

    def test_signed_source_entry_must_bind_all_inputs_before_building(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            keyring = root / 'keyring'
            keyring.write_bytes(b'reviewed keyring')
            source_name = 'git.orig.tar.xz'
            source = b'synthetic upstream bytes'
            index = ('Package: git\nVersion: pinned\nDirectory: pool/git\nChecksums-Sha256:\n '
                     + builder.digest(source) + ' ' + str(len(source)) + ' ' + source_name + '\n\n').encode()
            contents = {'InRelease': b'signed release', 'Sources.xz': lzma.compress(index), source_name: source}
            record = {'immutableBaseKeyring': {'bytes': keyring.stat().st_size, 'sha256': builder.digest(keyring.read_bytes())},
                      'inputs': [], 'release': 'InRelease', 'index': 'Sources.xz', 'indexReleasePath': 'main/source/Sources.xz',
                      'indexUncompressedBytes': len(index), 'requiredPrimarySigningKeys': ['A' * 40],
                      'version': 'pinned', 'directory': 'pool/git', 'sourceFiles': [source_name]}
            for name, data in contents.items():
                (root / name).write_bytes(data)
                record['inputs'].append({'name': name, 'bytes': len(data), 'sha256': builder.digest(data)})
            release = ('SHA256:\n ' + builder.digest(contents['Sources.xz']) + ' '
                       + str(len(contents['Sources.xz'])) + ' main/source/Sources.xz\n')
            def verified(args, **kwargs):
                Path(args[args.index('--output') + 1]).write_text(release)
                return SimpleNamespace(stdout='[GNUPG:] VALIDSIG ' + 'A' * 40)
            with patch.object(builder.subprocess, 'run', side_effect=verified):
                builder.verify(record, root, keyring, Path('/reviewed-gpgv'))
                record['version'] = 'unapproved'
                with self.assertRaisesRegex(ValueError, 'Exact Git source'):
                    builder.verify(record, root, keyring, Path('/reviewed-gpgv'))
                record['version'] = 'pinned'
                record['requiredPrimarySigningKeys'] = ['B' * 40]
                with self.assertRaisesRegex(ValueError, 'signatures required'):
                    builder.verify(record, root, keyring, Path('/reviewed-gpgv'))
            (root / source_name).write_bytes(b'changed')
            with patch.object(builder.subprocess, 'run') as verifier:
                with self.assertRaisesRegex(ValueError, 'input differs'):
                    builder.verify(record, root, keyring, Path('/reviewed-gpgv'))
                verifier.assert_not_called()

    def test_replaces_only_the_two_exact_core_copies_and_keeps_other_prefix_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            prefix, artifact = root / 'prefix', root / 'artifact'
            artifact.mkdir()
            original = b'old reviewed Git'
            names = ['usr/bin/git', 'usr/lib/git-core/git']
            for name in names:
                target = prefix / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(original)
                target.chmod(0o555)
            helper = prefix / 'usr/lib/git-core/git-remote-http'
            helper.write_bytes(b'original helper')
            new_core = core()
            record = {'prefix': str(prefix), 'version': 'pinned', 'replaceCorePaths': names,
                      'originalCoreSha256': builder.digest(original)}
            record_bytes = json.dumps(record).encode()
            receipt = {'schema': 'research-cloud-git-getrandom-build-v1', 'recordSha256': builder.digest(record_bytes),
                       'version': 'pinned', 'command': ['/usr/bin/make', '-j2', *builder.OPTIONS, 'git'],
                       'getrandomLibcImport': True, 'deviceFallbackAbsent': True,
                       'core': {'bytes': len(new_core), 'sha256': builder.digest(new_core)}}
            (artifact / 'git').write_bytes(new_core)
            wrong = {**receipt, 'recordSha256': '0' * 64}
            (artifact / 'build.json').write_text(json.dumps(wrong))
            with self.assertRaisesRegex(ValueError, 'Exact source-build receipt'):
                builder.replace(record, record_bytes, artifact, prefix)
            self.assertEqual([ (prefix / name).read_bytes() for name in names], [original, original])
            (artifact / 'build.json').write_text(json.dumps(receipt))
            builder.replace(record, record_bytes, artifact, prefix)
            self.assertEqual([ (prefix / name).read_bytes() for name in names], [new_core, new_core])
            self.assertEqual(helper.read_bytes(), b'original helper')
            self.assertEqual((prefix.stat().st_mode & 0o777), 0o555)
            self.assertEqual((prefix / 'getrandom-build.json').stat().st_mode & 0o777, 0o444)
            with self.assertRaisesRegex(ValueError, 'Fresh Git build record'):
                builder.replace(record, record_bytes, artifact, prefix)

    def test_rejects_device_fallback_wrong_elf_and_unapproved_source_receipt(self):
        builder.check_core(core())
        for binary in [core(b'/dev/urandom\0'), core(b'getrandom\0/dev/urandom\0'), b'not ELF']:
            with self.assertRaisesRegex(ValueError, 'getrandom without'):
                builder.check_core(binary)
        self.assertIn('CSPRNG_METHOD=getrandom', builder.OPTIONS)
        self.assertNotIn('NO_CURL=1', builder.OPTIONS)


if __name__ == '__main__':
    unittest.main()
