"""The image builder emits Native architecture names and rejects unknown machines."""
import importlib.util
from pathlib import Path
import unittest

source = Path(__file__).resolve().parents[1] / 'runtime/office/runtime-manifest.py'
spec = importlib.util.spec_from_file_location('office_runtime_manifest', source)
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class OfficeRuntimeManifest(unittest.TestCase):
    def test_supported_kernel_and_oci_names(self):
        for machine, expected in [('x86_64', 'x64'), ('amd64', 'x64'), ('aarch64', 'arm64'), ('arm64', 'arm64')]:
            with self.subTest(machine=machine):
                self.assertEqual(builder.runtime_arch(machine), expected)

    def test_unknown_architecture_is_not_silently_assigned(self):
        with self.assertRaisesRegex(ValueError, 'unsupported Office runtime architecture'):
            builder.runtime_arch('riscv64')


if __name__ == '__main__':
    unittest.main()
