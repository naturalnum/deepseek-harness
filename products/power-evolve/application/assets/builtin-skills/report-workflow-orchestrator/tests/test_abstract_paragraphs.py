"""Modern abstract request/apply/confirm gates; child output is synthetic test input."""
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
STATE_FIXTURE = ROOT / "tests/fixtures/chapter-review-passed.json"
ABSTRACT_FIXTURE = ROOT.parent / "power-grid-technical-report-writer/tests/fixtures/bilingual-three-paragraph-abstract.json"


class AbstractWorkflow(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.work = Path(self.directory.name)
        self.state = self.work / "state.json"
        state = json.loads(STATE_FIXTURE.read_text())
        state["stage"] = "CHAPTER_CONFIRMED"
        state["pending_action"] = None
        for chapter in state["chapters"].values():
            chapter["status"] = "confirmed"
        state["artifacts"].pop("abstract", None)
        state["confirmations"].pop("abstract", None)
        self.write(self.state, state)
        self.content = json.loads(ABSTRACT_FIXTURE.read_text())

    def write(self, path, content):
        path.write_text(json.dumps(content, ensure_ascii=False, indent=2) + "\n")

    def read(self):
        return json.loads(self.state.read_text())

    def cli(self, *args):
        return subprocess.run(
            [sys.executable, str(ROOT / "scripts/workflow_cli.py"), *map(str, args)],
            capture_output=True, text=True, timeout=5,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )

    def next_request(self):
        path = self.work / "request.json"
        result = self.cli("next", self.state, "--request-out", path)
        self.assertEqual(result.returncode, 0, result.stderr)
        request = json.loads(path.read_text())
        self.assertEqual(request["action"], "generate_abstract")
        return request

    def apply(self, request, content, version=1):
        path = self.work / "response.json"
        self.write(path, {
            "request_id": request["orchestration"]["request_id"],
            "skill_name": request["skill_name"], "action": request["action"], "status": "success",
            "artifact": {"artifact_type": "abstract", "artifact_id": "abstract-structure", "version": version,
                         "content": content,
                         "quality_metrics": {"abstract_quality": {"valid": True, "english_paragraph_count": 3}}},
        })
        result = self.cli("apply", self.state, path)
        self.assertEqual(result.returncode, 0, result.stderr)

    def reject_confirmation(self):
        before = self.state.read_bytes()
        result = self.cli("confirm", self.state, "abstract")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.state.read_bytes(), before)

    def test_modern_one_paragraph_english_requires_repair_and_cannot_confirm(self):
        request = self.next_request()
        one_paragraph = copy.deepcopy(self.content)
        one_paragraph["abstract_en"] = one_paragraph["abstract_en"].replace("\n\n", " ")
        self.apply(request, one_paragraph)
        state = self.read()
        self.assertEqual(state["stage"], "ABSTRACT_REVISION_REQUIRED")
        slot = state["artifacts"]["abstract"]
        metrics = slot["versions"][-1]["quality_metrics"]["abstract_quality"]
        self.assertEqual(metrics["paragraph_count"], 3)
        self.assertEqual(metrics["english_paragraph_count"], 1)
        self.assertFalse(metrics["valid"])
        self.assertIsNone(slot["approved_version"])
        review = slot["reviews"][-1]
        self.assertEqual(review["review_source"], "deterministic_abstract_quality_gate")
        self.assertEqual(review["reviewed_version"], 1)
        self.assertTrue(any("英文摘要必须恰好为3个自然段" in x for x in review["must_fix"]))
        self.reject_confirmation()
        repair = self.next_request()
        self.assertIn("three natural paragraphs separated by blank lines", repair["payload"]["abstract_generation_requirements"]["english_rule"])
        self.apply(repair, self.content, version=2)
        state = self.read()
        self.assertEqual(state["stage"], "ABSTRACT_DRAFTED")
        self.assertEqual([x["version"] for x in state["artifacts"]["abstract"]["versions"]], [1, 2])
        self.assertFalse(state["artifacts"]["abstract"]["versions"][0]["quality_metrics"]["abstract_quality"]["valid"])
        confirmed = self.cli("confirm", self.state, "abstract")
        self.assertEqual(confirmed.returncode, 0, confirmed.stderr)
        self.assertEqual(self.read()["artifacts"]["abstract"]["approved_version"], 2)

    def test_modern_three_plus_three_paragraphs_pass_and_confirm(self):
        self.apply(self.next_request(), self.content)
        state = self.read()
        self.assertEqual(state["stage"], "ABSTRACT_DRAFTED")
        metrics = state["artifacts"]["abstract"]["versions"][-1]["quality_metrics"]["abstract_quality"]
        self.assertTrue(metrics["valid"], metrics["errors"])
        self.assertEqual(metrics["english_paragraph_count"], 3)
        result = self.cli("confirm", self.state, "abstract")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.read()["stage"], "ABSTRACT_CONFIRMED")


if __name__ == "__main__":
    unittest.main()
