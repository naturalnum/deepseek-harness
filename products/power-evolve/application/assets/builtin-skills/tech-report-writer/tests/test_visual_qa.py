"""Deterministic acceptance of renderer facts and explicit inspection records.

Rendering and visual inspection are controlled inputs here; real page inspection
belongs to the installed report business trial.
"""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import orchestration_adapter as adapter
from docx import Document


class VisualAcceptance(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.docx = Path(self.directory.name).resolve() / "word-v2.docx"
        Document().save(self.docx)
        self.request = {
            "orchestration": {"enabled": True, "request_id": "visual-fixture", "caller_skill": "report-workflow-orchestrator"},
            "skill_name": "tech-report-writer", "action": "validate_word_report",
            "payload": {"word_report": {"artifact_id": "word-2", "version": 2,
                                        "content": {"docx_path": str(self.docx)}}},
        }
        self.render = {"success": True, "page_count": 2, "catalog_qa": {"checked": True, "ok": True}}

    def validate(self, visual=None, render=None, returncode=0, structural=None):
        request = copy.deepcopy(self.request)
        if visual is not None:
            request["payload"]["visual_qa_result"] = visual

        def run(args, **kwargs):
            self.assertEqual(args[1], str(SCRIPTS / "render_for_visual_qa.py"))
            self.assertEqual(args[2], str(self.docx))
            output = Path(args[-1])
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(self.render if render is None else render))
            return subprocess.CompletedProcess(args, returncode, "", "")

        with patch("report_validator.validate_report", return_value=structural or {"valid": True, "errors": [], "warnings": []}), \
                patch.object(adapter.subprocess, "run", side_effect=run):
            return adapter.validate_word(request)["validation_result"]

    def test_exit_zero_and_catalog_success_still_wait_for_actual_inspection(self):
        result = self.validate()
        self.assertEqual(result["decision"], "blocked")
        self.assertFalse(result["valid"])
        self.assertEqual(result["visual_qa"]["status"], "rendered_pending_inspection")
        self.assertEqual(result["visual_qa"]["inspected_pages"], [])

    def test_explicit_exact_pages_bind_result_to_current_artifact_and_version(self):
        result = self.validate({"status": "passed", "inspected_pages": [2, 1], "issues": []})
        self.assertEqual(result["decision"], "pass")
        self.assertTrue(result["valid"])
        self.assertEqual((result["validated_artifact_id"], result["validated_version"]), ("word-2", 2))

    def test_outside_missing_duplicate_boolean_and_malformed_pages_do_not_pass(self):
        cases = [[0, 2], [2, 3], [1], [1, 1], [1, 2, 2], [True, 2], [1, False],
                 [1, "2"], [1, 2.0], [], None, "12", [1, {}]]
        for pages in cases:
            with self.subTest(pages=pages):
                result = self.validate({"status": "passed", "inspected_pages": pages, "issues": []})
                self.assertEqual(result["decision"], "revise")
                self.assertFalse(result["valid"])
                self.assertEqual(result["visual_qa"]["status"], "failed")

    def test_renderer_count_cannot_be_replaced_by_supplied_count(self):
        for count in [0, True, 2.0, "2", None]:
            with self.subTest(count=count):
                render = {**self.render, "page_count": count}
                result = self.validate({"status": "passed", "page_count": 2, "inspected_pages": [1, 2]}, render)
                self.assertFalse(result["valid"])
                self.assertNotEqual(result["decision"], "pass")

    def test_nonzero_render_exit_or_failed_catalog_blocks_supplied_visual_pass(self):
        visual = {"status": "passed", "inspected_pages": [1, 2], "issues": []}
        cases = [(self.render, 1), ({**self.render, "success": False}, 0),
                 ({**self.render, "catalog_qa": {}}, 0),
                 ({**self.render, "catalog_qa": {"checked": True, "ok": False,
                                                "incorrect_catalog_pages": ["fixture"]}}, 0)]
        for render, code in cases:
            with self.subTest(render=render, returncode=code):
                result = self.validate(visual, render, code)
                self.assertFalse(result["valid"])
                self.assertEqual(result["decision"], "revise")
                self.assertEqual(result["visual_qa"]["status"], "failed")

    def test_structural_failure_cannot_be_overridden_by_complete_visual_pass(self):
        result = self.validate({"status": "passed", "inspected_pages": [1, 2]},
                               structural={"valid": False, "errors": ["synthetic structural failure"], "warnings": []})
        self.assertFalse(result["valid"])
        self.assertEqual(result["decision"], "revise")


if __name__ == "__main__":
    unittest.main()
