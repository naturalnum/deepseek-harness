"""Current-version Word acceptance through the real workflow file CLI."""
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
import workflow_engine as engine

REGISTRY = engine.load_json(ROOT / "skill-registry.json")


class WordValidation(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "state.json"
        state = engine.new_state("word-validation-fixture", {"title": "合成测试报告", "goal": "测试验收"})
        state["stage"] = "WORD_REPORT_GENERATED"
        state["artifacts"]["word_report"] = {
            "versions": [{"artifact_type": "word_report", "artifact_id": "word-1", "version": 1,
                          "content": {"docx_path": "word-v1.docx"}},
                         {"artifact_type": "word_report", "artifact_id": "word-2", "version": 2,
                          "content": {"docx_path": "word-v2.docx"}, "validation_status": "pending"}],
            "reviews": [], "approved_version": None,
        }
        self.state, request = engine.prepare_pending_request(state, REGISTRY)
        self.response = {
            "request_id": request["orchestration"]["request_id"], "skill_name": request["skill_name"],
            "action": request["action"], "status": "success",
            "validation_result": {
                "validated_artifact_id": "word-2", "validated_version": 2, "decision": "pass", "valid": True,
                "docx_path": "word-v2.docx", "structural_validation": {"passed": True, "errors": [], "warnings": []},
                "visual_qa": {"status": "passed", "page_count": 2, "inspected_pages": [1, 2], "issues": []},
                "revision_instruction": "",
            },
        }
        engine.save_json(self.path, self.state)

    def cli(self, *args):
        return subprocess.run([sys.executable, str(ROOT / "scripts/workflow_cli.py"), *map(str, args)],
                              capture_output=True, text=True, timeout=10,
                              env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})

    def apply(self, response):
        path = self.path.with_name("response.json")
        engine.save_json(path, response)
        return self.cli("apply", self.path, path)

    def test_exact_current_version_pages_pass_and_require_explicit_confirmation(self):
        # Inspection order is independent of document page order.
        self.response["validation_result"]["visual_qa"]["inspected_pages"] = [2, 1]
        result = self.apply(self.response)
        self.assertEqual(result.returncode, 0, result.stderr)
        saved = engine.load_json(self.path)
        self.assertEqual(saved["stage"], "WORD_REPORT_VALIDATED")
        self.assertIsNone(saved["artifacts"]["word_report"]["approved_version"])
        self.assertEqual(saved["artifacts"]["word_report"]["versions"][0],
                         self.state["artifacts"]["word_report"]["versions"][0])
        result = self.cli("confirm", self.path, "word_report")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(engine.load_json(self.path)["stage"], "COMPLETED")
        self.assertEqual(engine.load_json(self.path)["artifacts"]["word_report"]["approved_version"], 2)

    def test_missing_outside_duplicate_boolean_and_malformed_pages_preserve_pending_state(self):
        cases = [(2, [0, 2]), (2, [2, 3]), (2, [1]), (2, [1, 1]), (2, [1, 2, 2]),
                 (2, [True, 2]), (2, [1, False]), (2, [1, "2"]), (2, [1, 2.0]),
                 (2, None), (2, "12"), (2, [1, {}]), (True, [1]), (2.0, [1, 2]), ("2", [1, 2]), (0, [])]
        before = self.path.read_bytes()
        for count, pages in cases:
            with self.subTest(count=count, pages=pages):
                response = copy.deepcopy(self.response)
                response["validation_result"]["visual_qa"].update(page_count=count, inspected_pages=pages)
                result = self.apply(response)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("cover exactly", result.stderr)
                self.assertEqual(self.path.read_bytes(), before)

    def test_old_word_version_and_wrong_artifact_do_not_consume_pending_request(self):
        before = self.path.read_bytes()
        for field, value in [("validated_version", 1), ("validated_artifact_id", "word-1")]:
            with self.subTest(field=field):
                response = copy.deepcopy(self.response)
                response["validation_result"][field] = value
                result = self.apply(response)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("mismatch", result.stderr)
                self.assertEqual(self.path.read_bytes(), before)

    def test_historical_pass_does_not_confirm_the_new_word_version(self):
        state = copy.deepcopy(self.state)
        state["stage"] = "WORD_REPORT_VALIDATED"
        state["pending_action"] = None
        old = copy.deepcopy(self.response["validation_result"])
        old.update(validated_artifact_id="word-1", validated_version=1, docx_path="word-v1.docx")
        state["artifacts"]["word_report"]["reviews"] = [old]
        engine.save_json(self.path, state)
        before = self.path.read_bytes()
        result = self.cli("confirm", self.path, "word_report")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("current version", result.stderr)
        self.assertEqual(self.path.read_bytes(), before)

    def test_successful_render_without_inspection_cannot_apply_a_pass(self):
        self.response["validation_result"]["visual_qa"].update(status="rendered_pending_inspection", inspected_pages=[])
        before = self.path.read_bytes()
        result = self.apply(self.response)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("without passed visual QA", result.stderr)
        self.assertEqual(self.path.read_bytes(), before)

    def test_completed_review_chain_checks_exact_pages_and_current_word_version(self):
        state = copy.deepcopy(self.state)
        state.update(stage="COMPLETED", pending_action=None)
        state["artifacts"]["report"] = {
            "versions": [{"artifact_id": "report-1", "version": 1}], "approved_version": 1,
            "reviews": [{"reviewed_artifact_id": "report-1", "reviewed_version": 1,
                         "decision": "pass", "overall_score": 90, "issues": [], "must_fix": [],
                         "revision_instruction": ""}],
        }
        slot = state["artifacts"]["word_report"]
        slot["approved_version"] = 2
        slot["reviews"] = [copy.deepcopy(self.response["validation_result"])]

        def check():
            engine.save_json(self.path, state)
            before = self.path.read_bytes()
            result = subprocess.run([sys.executable, str(ROOT / "scripts/validate_review_chain.py"), str(self.path)],
                                    capture_output=True, text=True, timeout=10,
                                    env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
            self.assertEqual(self.path.read_bytes(), before)
            return result

        self.assertEqual(check().returncode, 0)
        for pages in [[0, 2], [2, 3], [1], [1, 1], [1, 2, 2], [True, 2], [1, {}]]:
            with self.subTest(pages=pages):
                slot["reviews"][-1]["visual_qa"]["inspected_pages"] = pages
                result = check()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("full-page visual validation", result.stdout)
        slot["reviews"][-1] = copy.deepcopy(self.response["validation_result"])
        slot["reviews"][-1].update(validated_artifact_id="word-1", validated_version=1)
        self.assertNotEqual(check().returncode, 0)


if __name__ == "__main__":
    unittest.main()
