"""Pure selected original-source checks; no SDK imports or owner construction."""
import ast
import hashlib
import json
from pathlib import Path
import sys
import unittest

RUNTIME = Path(__file__).resolve().parents[1] / 'runtime'
ARM = ('0fc274e60c4b606db202dc9e82db60b4d944ba74bab8b6af2cd95ea28c4f8b2d', 814328, 183)
AMD = ('2eac825be98626a3a7e8daf17afdedcb65560951cb26ffaecea261f5686acb28', 734864, 62)


def definitions(relative, names):
    tree = ast.parse((RUNTIME / relative).read_bytes())
    selected = [item for item in tree.body if isinstance(item, ast.FunctionDef) and item.name in names
                or isinstance(item, ast.Assign) and any(isinstance(t, ast.Name) and t.id in names for t in item.targets)]
    namespace = {}
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(relative), 'exec'), namespace)
    return namespace


class RuntimeArchitecture(unittest.TestCase):
    def test_both_original_callers_choose_only_the_matching_exact_binary(self):
        for source in ['agent/launcher.py', 'bootstrap/publisher.py']:
            selected = definitions(source, {'bwrap_profile'})['bwrap_profile']
            for name in ['aarch64', 'arm64']:
                self.assertEqual(selected(name), ARM)
            for name in ['x86_64', 'amd64']:
                self.assertEqual(selected(name), AMD)
            for name in ['i386', 'riscv64', '', None, 'arm64\n']:
                with self.assertRaises(RuntimeError):
                    selected(name)

    def test_fixed_elf_does_not_accept_the_other_machine_or_format(self):
        for source in ['agent/launcher.py', 'bootstrap/publisher.py']:
            check = definitions(source, {'fixed_elf'})['fixed_elf']
            for machine in [62, 183]:
                raw = b'\x7fELF\x02\x01' + b'\0' * 12 + machine.to_bytes(2, 'little')
                self.assertTrue(check(raw, machine))
                self.assertFalse(check(raw, 183 if machine == 62 else 62))
                for changed in [raw[:19], b'bad' + raw[3:], raw[:4] + b'\x01' + raw[5:], raw[:5] + b'\x02' + raw[6:]]:
                    self.assertFalse(check(changed, machine))

    def test_complete_recipe_rejects_cross_arch_and_dependency_images(self):
        selected = definitions('server/completion_view.py', {'fixed_recipe', 'FIXED_IMAGE', 'NATIVE_AMD64_IMAGE'})
        check = selected['fixed_recipe']
        arm, amd = selected['FIXED_IMAGE'], selected['NATIVE_AMD64_IMAGE']
        self.assertTrue(check(arm, 'arm64'))
        self.assertTrue(check(amd, 'amd64'))
        for image, arch in [(arm, 'amd64'), (amd, 'arm64'), (amd, 'x86_64'), ('native:latest', 'amd64'),
                            ('sha256:b9e5cb3029d236dbfcb50823d59cc5ad77dab7efcd1fc4c5a256babcbcf78bde', 'amd64')]:
            self.assertFalse(check(image, arch))

    def test_legacy_historical_creator_is_not_replaced_by_the_current_creator(self):
        value = definitions('server/completion_view.py', {'FIXED_CREATOR_SHA'})['FIXED_CREATOR_SHA']
        self.assertEqual(value, '831b9f941abb7ef01603d8ed1ec25fb92480628033cf239279b97f12871d5a38')

    def test_original_deletion_owner_is_byte_identical(self):
        raw = (RUNTIME / 'server/deletion_completion.py').read_bytes()
        self.assertEqual(len(raw), 15786)
        self.assertEqual(hashlib.sha256(raw).hexdigest(), '96496b09fdb4b5bf094cb34c96b24671f2ae2679a9e06234a50ad85a6ebc35a4')


if __name__ == '__main__':
    if sys.argv[1:] == ['--profiles']:
        print(json.dumps({source: {platform: definitions(source, {'bwrap_profile'})['bwrap_profile'](platform)
                                  for platform in ['arm64', 'amd64']}
                          for source in ['agent/launcher.py', 'bootstrap/publisher.py']}))
    else:
        unittest.main(verbosity=2)
