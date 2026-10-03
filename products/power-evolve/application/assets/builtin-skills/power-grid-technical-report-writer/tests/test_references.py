"""Actual QA dataset citation through the reference registry validator."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from validate_references import validate_gbt7714_entry

FIXTURE = ROOT / "tests/fixtures/dataset-reference-registry.json"
URL = "https://archive.ics.uci.edu/dataset/321/electricityloaddiagrams20112014"


def registry():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


class DatasetReferences(unittest.TestCase):
    def run_registry(self, data):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "references.json"
            path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            return subprocess.run([sys.executable, str(ROOT / "scripts/validate_references.py"), str(path)],
                                  capture_output=True, text=True, timeout=10,
                                  env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"))

    def test_actual_qa_dataset_registry_cli(self):
        result = self.run_registry(registry())
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_bare_and_online_dataset_markers(self):
        entry = registry()["items"][0]["gbt7714_entry"]
        for marker in ("DS", "DS/OL", "DB", "DB/OL"):
            with self.subTest(marker=marker):
                value = entry.replace("DS/OL", marker)
                if "/" not in marker:
                    value = value.replace("[2026-10-03]", "").replace(URL + ". ", "")
                self.assertEqual(validate_gbt7714_entry(value, "dataset"), [])

    def test_original_missing_url_and_other_dataset_failures(self):
        entry = registry()["items"][0]["gbt7714_entry"]
        cases = {
            "original QA DOI without URL": entry.replace(URL + ". ", ""),
            "missing date": entry.replace("[2026-10-03]", ""),
            "missing final period": entry[:-1],
            "final sequence number in registry": "[4] " + entry,
            "unsupported dataset carrier": entry.replace("DS/OL", "DS/DK"),
            "unsupported document marker": entry.replace("DS/OL", "UNKNOWN/OL"),
        }
        for name, value in cases.items():
            with self.subTest(case=name):
                self.assertTrue(validate_gbt7714_entry(value, "dataset"))

    def test_other_reference_type_bindings_remain_required(self):
        entry = registry()["items"][0]["gbt7714_entry"]
        for reference_type in ("journal_article", "conference_paper", "standard", "official_document", "book", "thesis", "report"):
            with self.subTest(reference_type=reference_type):
                self.assertTrue(validate_gbt7714_entry(entry, reference_type))
        for marker in ("J", "R", "EB/OL"):
            with self.subTest(dataset_wrong_marker=marker):
                self.assertTrue(validate_gbt7714_entry(entry.replace("DS/OL", marker), "dataset"))

    def test_registry_verification_requirements_remain_required(self):
        for changes in ({"verification_status": "pending"}, {"verification_sources": []},
                        {"official_url": "file:///local/data"}):
            with self.subTest(changes=changes):
                data = copy.deepcopy(registry())
                data["items"][0].update(changes)
                result = self.run_registry(data)
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
