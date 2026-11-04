"""Focused controls for the offline capacity and frozen-context handoff."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import prepare_context as subject


class HandoffTests(unittest.TestCase):
    def test_current_store_refuses_build_and_never_admits_import(self):
        result = subject.capacity_plan(1341444096, 1341444096)
        self.assertFalse(result['buildCapacityAdmitted'])
        self.assertEqual(result['builderShortfallBytes'], 2953523200)
        self.assertFalse(result['productionImportAdmitted'])

    def test_exact_builder_capacity_still_requires_import_measurement(self):
        result = subject.capacity_plan(4 * 1024**3, 1341444096)
        self.assertTrue(result['buildCapacityAdmitted'])
        self.assertEqual(result['builderShortfallBytes'], 0)
        self.assertFalse(result['productionImportAdmitted'])

    def test_invalid_measurements_are_not_capacity(self):
        for value in (-1, 1.5, True):
            with self.assertRaises(ValueError):
                subject.capacity_plan(value, 0)

    def test_unapproved_manifest_refuses_before_context_read(self):
        with self.assertRaisesRegex(ValueError, 'manifest digest'):
            subject.verify_context(Path('/unused'), b'{}')

    def test_valid_manifest_digest_does_not_authorize_escaping_member(self):
        raw = json.dumps({'files': [{'path': '../escape', 'bytes': 0, 'sha256': '0' * 64}]}).encode()
        with patch.object(subject, 'MANIFEST_SHA256', subject.sha256(raw)):
            with self.assertRaisesRegex(ValueError, 'Unexpected'):
                subject.verify_context(Path('/unused'), raw)

    def test_valid_manifest_digest_does_not_authorize_symlink_member(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            selected = root / 'packages/cloud/pe-opensandbox/runtime/office'
            selected.mkdir(parents=True)
            (selected / 'Dockerfile').symlink_to('/unused')
            raw = json.dumps({'files': [{'path': subject.DOCKERFILE, 'bytes': 0, 'sha256': '0' * 64}]}).encode()
            with patch.object(subject, 'MANIFEST_SHA256', subject.sha256(raw)):
                with self.assertRaisesRegex(ValueError, 'symlinks'):
                    subject.verify_context(root, raw)


if __name__ == '__main__':
    unittest.main()
