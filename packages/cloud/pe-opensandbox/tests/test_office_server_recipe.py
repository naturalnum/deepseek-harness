"""Exercise the shipped exact selector expression without importing or running an SDK."""
import ast
import importlib.util
from pathlib import Path
import textwrap
import unittest

RECIPE = Path(__file__).resolve().parents[1] / 'runtime/server/prepare_office_context.py'
spec = importlib.util.spec_from_file_location('office_server_recipe', RECIPE)
recipe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recipe)


def selected(native, admit):
    scope = {'native': native, 'FIXED_IMAGE': 'unchanged-original-fixture',
             'self': type('SelectorInput', (), {'policy': {'admitCreates': admit}})()}
    exec(compile(ast.parse(textwrap.dedent(recipe.REPLACEMENT)), '<actual-office-selector>', 'exec'), scope)
    return scope['selected_images']


class OfficeServerRecipe(unittest.TestCase):
    def test_create_accepts_only_heading_workload(self):
        self.assertEqual(selected(True, True), ('sha256:ff336ad49a52795fa82960da50a46cc7cbb654326ad5160313f94355d1cce461',))

    def test_closed_audit_preserves_every_exact_predecessor(self):
        images = selected(True, False)
        self.assertEqual(images, (
            'sha256:62016189c3c5cec1c88d10af21b5dc0dfac0fc2247cd66709374dbdfc9d1135a',
            'sha256:c75632ff5ced1d239c688e836c383ce3629ef1a93f7b698294345f2aa8074f2d',
            'sha256:3690da1fbb1faaabaf7265927b8b21a0fef0c4c988d83a8b1e321a2e82d43140',
            'sha256:3209e963a7b4f008818649e353c4af91da494e179cf3de54ae5c06b1edd79a97',
            recipe.OFFICE))
        for old in images[:-1]:
            self.assertNotIn(old, selected(True, True))
        self.assertNotIn('sha256:' + '0' * 64, images)

    def test_non_native_fixture_profile_is_unchanged(self):
        self.assertEqual(selected(False, True), ('unchanged-original-fixture',))
        self.assertEqual(selected(False, False), ('unchanged-original-fixture',))

    def test_foreign_upstream_source_cannot_be_rewritten(self):
        with self.assertRaisesRegex(ValueError, 'exact original649'):
            recipe.patch_source(b'unreviewed-source')
        self.assertEqual(recipe.AFTER, 'f1a357ec42dce6fc67ed2db1e8a4d37528fa5df42226d0ba846fc9bee111229a')


if __name__ == '__main__':
    unittest.main(verbosity=2)
