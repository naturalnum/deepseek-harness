"""Offline candidate generation changes only the exact selection expression; no SDK or Docker is used."""
import ast
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import textwrap
import unittest
from unittest.mock import patch

SERVER = Path(__file__).resolve().parents[1] / 'runtime/server'
sys.path.insert(0, str(SERVER))
spec = importlib.util.spec_from_file_location('supplier_server_recipe', SERVER / 'prepare_supplier_context.py')
recipe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recipe)
CANDIDATE = 'sha256:' + 'e' * 64  # Synthetic offline fixture, never a registered supplier.


def selected(native, admit):
    scope = {'native': native, 'FIXED_IMAGE': 'unchanged-original-fixture',
             'self': type('SelectorInput', (), {'policy': {'admitCreates': admit}})()}
    exec(compile(ast.parse(textwrap.dedent(recipe.selected_images(CANDIDATE))), '<candidate-selector>', 'exec'), scope)
    return scope['selected_images']


class SupplierServerRecipe(unittest.TestCase):
    def test_open_creation_selects_only_candidate_and_closed_audit_retains_exact_predecessors(self):
        self.assertEqual(selected(True, True), (CANDIDATE,))
        self.assertEqual(selected(True, False), (
            'sha256:62016189c3c5cec1c88d10af21b5dc0dfac0fc2247cd66709374dbdfc9d1135a',
            'sha256:c75632ff5ced1d239c688e836c383ce3629ef1a93f7b698294345f2aa8074f2d',
            'sha256:3690da1fbb1faaabaf7265927b8b21a0fef0c4c988d83a8b1e321a2e82d43140',
            'sha256:3209e963a7b4f008818649e353c4af91da494e179cf3de54ae5c06b1edd79a97',
            recipe.office.OFFICE, CANDIDATE))

    def test_non_native_creation_and_audit_keep_original_selection(self):
        self.assertEqual(selected(False, True), ('unchanged-original-fixture',))
        self.assertEqual(selected(False, False), ('unchanged-original-fixture',))

    def test_rejects_mutable_noncanonical_and_original_workload_candidates(self):
        for value in ['image:latest', 'sha256:' + 'E' * 64, 'sha256:' + 'e' * 63, CANDIDATE + '\n', None, recipe.office.OFFICE]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                recipe.selected_images(value)

    def test_requires_exact_original_source_before_creating_any_output(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / 'source.py', Path(directory) / 'context'
            source.write_bytes(b'unreviewed-source')
            with self.assertRaisesRegex(ValueError, 'exact original Office completion source'):
                recipe.prepare(source, CANDIDATE, output)
            self.assertFalse(output.exists())
        self.assertEqual(recipe.BEFORE, 'f1a357ec42dce6fc67ed2db1e8a4d37528fa5df42226d0ba846fc9bee111229a')

    def test_freezes_exactly_two_copy_only_files_and_retains_all_other_source_bytes(self):
        raw = ('class Fixture:\n    def select(self, native):\n' + recipe.office.REPLACEMENT + '        return selected_images\n').encode()
        # The complete production source is exported and checked separately by the original image owner.
        with patch.object(recipe, 'BEFORE', hashlib.sha256(raw).hexdigest()), tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source.py'
            source.write_bytes(raw)
            result = recipe.prepare(source, CANDIDATE, root / 'first')
            second = recipe.prepare(source, CANDIDATE, root / 'second')
            self.assertFalse(result['executedBuild'])
            self.assertEqual(result['candidateWorkloadImage'], CANDIDATE)
            self.assertEqual(result['baseServer'], 'sha256:1b7ec16bb1031eab0fd7024905fc03dc5f814fbfe46bbb2d5aa2f88e3813b628')
            self.assertEqual(result['context'], second['context'])
            self.assertEqual(source.read_bytes(), raw)
            patched = (root / 'first/completion_view.py').read_bytes()
            self.assertEqual(patched.replace(recipe.selected_images(CANDIDATE).encode(), recipe.office.REPLACEMENT.encode()), raw)
            ast.parse(patched)
            dockerfile = (root / 'first/Dockerfile').read_text()
            self.assertEqual(dockerfile.splitlines()[0], 'FROM ' + recipe.BASE_SERVER)
            self.assertEqual(len(dockerfile.splitlines()), 2)
            self.assertTrue(dockerfile.splitlines()[1].startswith('COPY --chown=0:0 completion_view.py '))
            with tarfile.open(root / 'first/context.tar') as archive:
                self.assertEqual(archive.getnames(), ['Dockerfile', 'completion_view.py'])
                for member in archive.getmembers():
                    self.assertEqual((member.uid, member.gid, member.mtime, member.mode), (0, 0, 0, 0o644))
            self.assertEqual(json.loads((root / 'first/MANIFEST.json').read_text()), result)
            with self.assertRaises(FileExistsError):
                recipe.prepare(source, CANDIDATE, root / 'first')

    def test_missing_or_duplicate_expression_refuses_instead_of_rewriting_another_statement(self):
        for raw in [b'pass\n', (recipe.office.REPLACEMENT * 2).encode()]:
            with patch.object(recipe, 'BEFORE', hashlib.sha256(raw).hexdigest()):
                with self.assertRaisesRegex(ValueError, 'exact original Office selection target'):
                    recipe.patch_source(raw, CANDIDATE)


if __name__ == '__main__':
    unittest.main(verbosity=2)
