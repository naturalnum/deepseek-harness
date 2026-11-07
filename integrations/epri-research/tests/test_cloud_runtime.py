"""Offline source/extraction and preservation checks; no Linux interpreter, package install or Docker is executed."""
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


installer = load('scientific_installer', ROOT / 'scripts/install-cloud-python.py')
probe = load('scientific_probe', ROOT / 'scripts/cloud-runtime-probe.py')


def archive(path, name='python/bin/python3.13'):
    with tarfile.open(path, 'w:gz') as output:
        entry = tarfile.TarInfo(name)
        entry.size, entry.mode = 3, 0o755
        output.addfile(entry, io.BytesIO(b'ELF'))
    return {'archiveBytes': path.stat().st_size, 'archiveSha256': hashlib.sha256(path.read_bytes()).hexdigest()}


class ScientificRuntimeTests(unittest.TestCase):
    def test_extracts_only_verified_input_and_never_overwrites_an_existing_interpreter(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'python.tar.gz'
            record = archive(source)
            installer.install(source, record, root / 'new')
            self.assertEqual((root / 'new/python/bin/python3.13').read_bytes(), b'ELF')
            with self.assertRaisesRegex(ValueError, 'already exists'):
                installer.install(source, record, root / 'new')
            for changed in [{'archiveBytes': 1}, {'archiveSha256': '0' * 64}]:
                with self.assertRaises(ValueError):
                    installer.install(source, {**record, **changed}, root / 'denied')
                self.assertFalse((root / 'denied').exists())

    def test_rejects_members_outside_the_independent_python_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for index, name in enumerate(['other/file', 'python/../../escape']):
                source = root / str(index)
                record = archive(source, name)
                with self.assertRaises((ValueError, tarfile.FilterError)):
                    installer.install(source, record, root / 'new')
                self.assertFalse((root / 'escape').exists())

    def test_protected_tree_hash_tracks_bytes_modes_and_links_without_following_external_links(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            protected = root / 'office'
            protected.mkdir()
            file = protected / 'package.py'
            file.write_bytes(b'original')
            external = root / 'external'
            external.write_text('outside')
            (protected / 'link').symlink_to(external)
            before = probe.tree(protected)
            self.assertEqual(before, probe.tree(protected))
            external.write_text('changed outside')
            self.assertEqual(before, probe.tree(protected))
            file.write_bytes(b'changed')
            self.assertNotEqual(before, probe.tree(protected))
            content = probe.tree(protected)
            file.chmod(0o400)
            self.assertNotEqual(content, probe.tree(protected))

    def test_office_comparison_rejects_every_interpreter_package_and_protected_tree_change(self):
        before = {'python': '3.12.13', 'executable': probe.OFFICE_PYTHON, 'executableSha256': 'old',
                  'packages': {'numpy': '2.3.4'}, 'runtimeSha256': probe.OFFICE_RUNTIME_SHA256, 'trees': {'runtime': 'old'}}
        probe.assert_office_preserved(before, copy.deepcopy(before))
        for field in before:
            after = copy.deepcopy(before)
            after[field] = 'changed'
            with self.subTest(field=field), self.assertRaisesRegex(RuntimeError, 'Original Office'):
                probe.assert_office_preserved(before, after)

    def test_scientific_probe_rejects_the_old_interpreter_before_importing_scientific_packages(self):
        record = json.loads((ROOT / 'source-records/cloud-python.json').read_text())
        with patch.object(probe.platform, 'python_version', return_value='3.12.13'):
            with self.assertRaisesRegex(RuntimeError, 'scientific interpreter version'):
                probe.observe_science(record, {}, 'not-opened')

    def test_build_uses_one_original_base_and_installs_packages_only_in_the_new_interpreter(self):
        lines = (ROOT / 'Dockerfile.cloud').read_text().replace('\\\n', '').splitlines()
        self.assertEqual(len([line for line in lines if line.startswith('FROM ')]), 1)
        self.assertFalse(any(line.startswith('ENV ') for line in lines))
        self.assertIn('COPY ', '\n'.join(lines))
        self.assertTrue(next(line for line in lines if line.startswith('COPY ')).endswith('/opt/dsh/research/.build/'))
        run = next(line for line in lines if line.startswith('RUN '))
        self.assertIn('/opt/dsh/research/python/bin/python3 -I -B -m pip --isolated install', run)
        self.assertIn('--only-binary=:all: --prefix /opt/dsh/research/python', run)
        self.assertNotIn('chmod -R u+w /opt/dsh/runtime', run)
        self.assertIn('chmod -R a-w /opt/dsh/research', run)


if __name__ == '__main__':
    unittest.main(verbosity=2)
