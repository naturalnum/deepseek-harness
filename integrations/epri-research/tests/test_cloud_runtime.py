"""Offline source/extraction and preservation checks; no Linux interpreter, package install or Docker is executed."""
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
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

    def test_original_document_constructor_bounds_threads_and_detector_without_accepting_missing_models(self):
        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory) / 'rapidocr'
            models = package / 'models'
            models.mkdir(parents=True)
            for name in ['PP-OCRv6_det_small.onnx', 'ch_ppocr_mobile_v2.0_cls_mobile.onnx', 'PP-OCRv6_rec_small.onnx']:
                (models / name).write_bytes(b'synthetic constructor-only fixture')
            threads, calls = [], []
            def engine(params):
                self.assertEqual(threads[-1], 1)
                calls.append(params)
                return object()
            modules = {'numpy': SimpleNamespace(), 'pymupdf': SimpleNamespace(),
                       'PIL': SimpleNamespace(Image=None, ImageOps=None, ImageSequence=None),
                       'cv2': SimpleNamespace(setNumThreads=threads.append),
                       'rapidocr': SimpleNamespace(__file__=str(package / '__init__.py'), RapidOCR=engine),
                       'onnxruntime': SimpleNamespace()}
            with patch.dict('sys.modules', modules):
                document = load('document_resource_constructor', ROOT / 'src/server/document-native.py')
                document.create_ocr()
                self.assertEqual(calls[0]['Det.limit_type'], 'max')
                self.assertEqual(calls[0]['Det.limit_side_len'], 1024)
                self.assertEqual(calls[0]['EngineConfig.onnxruntime.intra_op_num_threads'], 1)
                self.assertEqual(calls[0]['EngineConfig.onnxruntime.inter_op_num_threads'], 1)
                (models / 'PP-OCRv6_rec_small.onnx').unlink()
                with self.assertRaisesRegex(FileNotFoundError, 'OCR'):
                    document.create_ocr()
                self.assertEqual(len(calls), 1)

    def test_build_reuses_the_original_base_and_installs_packages_only_in_the_new_interpreter(self):
        lines = (ROOT / 'Dockerfile.cloud').read_text().replace('\\\n', '').splitlines()
        self.assertEqual([line for line in lines if line.startswith('FROM ')], [
            'FROM ${BASE_IMAGE} AS git-supplier',
            'FROM ${GIT_BUILDER_IMAGE} AS git-core-builder',
            'FROM ${BASE_IMAGE} AS research-runtime',
        ])
        self.assertEqual([line for line in lines if line.startswith('COPY --from=')],
                         ['COPY --from=git-supplier /usr/share/keyrings/debian-archive-keyring.pgp /opt/dsh/research/.git-source/keyring.gpg',
                          'COPY --from=git-supplier /opt/dsh/research/git /opt/dsh/research/git',
                          'COPY --from=git-core-builder /opt/dsh/research/.git-source/artifact /opt/dsh/research/.git-build/artifact'])
        self.assertFalse(any(line.startswith('ENV ') for line in lines))
        self.assertIn('COPY ', '\n'.join(lines))
        self.assertTrue(next(line for line in lines if line.startswith('COPY cloud-requirements.txt ')).endswith('/opt/dsh/research/.build/'))
        run = next(line for line in lines if line.startswith('RUN ') and '-m pip --isolated install' in line)
        self.assertIn('/opt/dsh/research/python/bin/python3 -I -B -m pip --isolated install', run)
        self.assertIn('--only-binary=:all: --no-binary=antlr4-python3-runtime --prefix /opt/dsh/research/python', run)
        self.assertNotIn('chmod -R u+w /opt/dsh/runtime', run)
        self.assertIn('chmod -R a-w /opt/dsh/research', run)


if __name__ == '__main__':
    unittest.main(verbosity=2)
