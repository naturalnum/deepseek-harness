"""Abstract validator CLI cases with synthetic content, not translation assessment."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests/fixtures/bilingual-three-paragraph-abstract.json"
SPEC = importlib.util.spec_from_file_location("generator_abstract_utils", ROOT / "scripts/report_text_utils.py")
UTILS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(UTILS)


class AbstractParagraphs(unittest.TestCase):
    def setUp(self):
        self.content = json.loads(FIXTURE.read_text())

    def validate(self, content):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "abstract.json"
            path.write_text(json.dumps(content, ensure_ascii=False))
            before = path.read_bytes()
            result = subprocess.run(
                [sys.executable, str(ROOT / "scripts/validate_abstract.py"), str(path)],
                capture_output=True, text=True, timeout=5,
                env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
            )
            self.assertEqual(path.read_bytes(), before)
            self.assertEqual(result.stderr, "")
            return result.returncode, json.loads(result.stdout)

    def test_three_paragraphs_pass_in_each_existing_cli_envelope(self):
        for envelope in (self.content, {"content": self.content}, {"artifact": {"content": self.content}}):
            with self.subTest(envelope=list(envelope)):
                code, metrics = self.validate(envelope)
                self.assertEqual(code, 0, metrics["errors"])
                self.assertEqual(metrics["paragraph_count"], 3)
                self.assertEqual(metrics["english_paragraph_count"], 3)
                self.assertTrue(metrics["english_paragraph_structure_passed"])

    def test_one_two_or_four_english_paragraphs_fail_with_valid_chinese(self):
        paragraphs = self.content["abstract_en"].split("\n\n")
        for count in (1, 2, 4):
            with self.subTest(count=count):
                content = copy.deepcopy(self.content)
                content["abstract_en"] = "\n\n".join((paragraphs + paragraphs)[:count])
                code, metrics = self.validate(content)
                self.assertEqual(code, 1)
                self.assertEqual(metrics["paragraph_count"], 3)
                self.assertEqual(metrics["english_paragraph_count"], count)
                self.assertFalse(metrics["english_paragraph_structure_passed"])
                self.assertEqual(len(metrics["errors"]), 1)
                self.assertIn("英文摘要必须恰好为3个自然段", metrics["errors"][0])

    def test_three_wrapped_lines_are_one_english_paragraph(self):
        self.content["abstract_en"] = self.content["abstract_en"].replace("\n\n", "\n")
        code, metrics = self.validate(self.content)
        self.assertEqual(code, 1)
        self.assertEqual(metrics["english_paragraph_count"], 1)

    def test_empty_english_still_fails_bilingual_presence(self):
        self.content["abstract_en"] = " \n "
        code, metrics = self.validate(self.content)
        self.assertEqual(code, 1)
        self.assertEqual(metrics["english_paragraph_count"], 0)
        self.assertFalse(metrics["english_abstract_present"])

    def test_crlf_and_blank_line_whitespace_preserve_three_paragraphs(self):
        self.content["abstract_en"] = " \r\n" + self.content["abstract_en"].replace("\n\n", "\r\n \t\r\n") + "\r\n "
        code, metrics = self.validate(self.content)
        self.assertEqual(code, 0, metrics["errors"])
        self.assertEqual(metrics["english_paragraph_count"], 3)

    def test_chinese_three_line_compatibility_is_retained(self):
        self.content["abstract_cn"] = self.content["abstract_cn"].replace("\n\n", "\n")
        code, metrics = self.validate(self.content)
        self.assertEqual(code, 0, metrics["errors"])
        self.assertEqual(metrics["paragraph_count"], 3)

    def test_explicit_non_bilingual_validation_keeps_chinese_only_input(self):
        self.content.pop("abstract_en")
        self.content.pop("keywords_en")
        metrics = UTILS.abstract_quality_metrics(self.content, require_bilingual=False)
        self.assertTrue(metrics["valid"], metrics["errors"])
        self.assertFalse(metrics["english_paragraph_structure_required"])


if __name__ == "__main__":
    unittest.main()
