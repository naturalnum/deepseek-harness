"""Exercise the actual importer with stdlib modules; no scientific code runs on the Host."""
import ast
import csv
import importlib
import importlib.util
import io
import json
import logging
import os
from pathlib import Path
import sys
import tempfile
import unittest
import uuid

SOURCE = Path(__file__).resolve().parents[1] / 'src/reused/engine/protocol_executor.py'


class OptionalModelTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.package = 'protocol_' + uuid.uuid4().hex
        self.parent = self.root / self.package
        self.parent.mkdir()
        (self.parent / '__init__.py').write_text('')
        self.stderr = io.StringIO()
        logger = logging.Logger(self.package, logging.DEBUG)
        handler = logging.StreamHandler(self.stderr)
        logger.addHandler(handler)
        self.addCleanup(handler.close)
        definition = next(node for node in ast.parse(SOURCE.read_text()).body
                          if isinstance(node, ast.FunctionDef) and node.name == 'import_module')
        module = ast.Module(body=[definition], type_ignores=[])
        namespace = {'importlib': importlib, 'sys': sys, 'os': os, 'logger': logger}
        exec(compile(module, str(SOURCE), 'exec'), namespace)
        self.load = namespace['import_module']
        sys.path.insert(0, str(self.root))
        self.addCleanup(self.cleanup_modules)

    def cleanup_modules(self):
        sys.path.remove(str(self.root))
        for name in list(sys.modules):
            if name == self.package or name.startswith(self.package + '.'):
                del sys.modules[name]
        self.directory.cleanup()

    def test_absent_optional_leaf_stays_silent_for_500_actual_resolution_attempts(self):
        for _ in range(502):
            self.assertIsNone(self.load(self.package + '.model', optional=True))
        self.assertEqual(self.stderr.getvalue(), '')

    def test_required_absence_and_present_namespace_keep_the_original_warning(self):
        self.assertIsNone(self.load(self.package + '.model'))
        self.assertIn('not found', self.stderr.getvalue())
        self.stderr.seek(0)
        self.stderr.truncate()
        (self.parent / 'model').mkdir()
        self.assertIsNone(self.load(self.package + '.model', optional=True))
        self.assertIn('not found', self.stderr.getvalue())

    def test_existing_optional_model_still_loads(self):
        (self.parent / 'model.py').write_text('class VarModel: pass\n')
        self.assertIsNotNone(self.load(self.package + '.model', optional=True).VarModel)
        self.assertEqual(self.stderr.getvalue(), '')

    def test_missing_parent_is_not_mistaken_for_an_absent_optional_leaf(self):
        with self.assertRaises(ModuleNotFoundError) as failure:
            self.load(self.package + '_absent.model', optional=True)
        self.assertEqual(failure.exception.name, self.package + '_absent')

    def test_parent_initialization_dependency_failure_propagates(self):
        missing = 'parent_dependency_' + uuid.uuid4().hex
        (self.parent / '__init__.py').write_text('import ' + missing + '\n')
        with self.assertRaises(ModuleNotFoundError) as failure:
            self.load(self.package + '.model', optional=True)
        self.assertEqual(failure.exception.name, missing)

    def test_optional_module_dependency_failure_stays_visible_with_original_cause(self):
        missing = 'model_dependency_' + uuid.uuid4().hex
        (self.parent / 'model.py').write_text('import ' + missing + '\n')
        with self.assertRaises(ImportError) as failure:
            self.load(self.package + '.model', optional=True)
        self.assertIsInstance(failure.exception.__cause__, ModuleNotFoundError)
        self.assertEqual(failure.exception.__cause__.name, missing)
        self.assertIn(missing, self.stderr.getvalue())
        self.assertNotIn(self.package + '.model', sys.modules)

    def test_optional_module_import_error_is_not_silenced(self):
        (self.parent / 'model.py').write_text("raise ImportError('original import failure')\n")
        with self.assertRaisesRegex(ImportError, 'original import failure'):
            self.load(self.package + '.model', optional=True)
        self.assertIn('original import failure', self.stderr.getvalue())

    def test_native_csv_and_direct_recalculation_inputs_have_the_same_500_rows(self):
        fixtures = Path(__file__).parent / 'fixtures'
        with (fixtures / 'power-quality-500.csv').open() as source:
            rows = [{**row, 'expected': int(row['expected']), 'valid': int(row['valid'])}
                    for row in csv.DictReader(source)]
        self.assertEqual(len(rows), 500)
        self.assertEqual(len({row['channel'] for row in rows}), 500)
        request = json.loads((fixtures / 'power-quality-500-recalculate.json').read_text())
        self.assertEqual(request['action'], 'recalculate')
        self.assertEqual(request['params']['tables']['measurements'], rows)


if __name__ == '__main__':
    unittest.main(verbosity=2)
