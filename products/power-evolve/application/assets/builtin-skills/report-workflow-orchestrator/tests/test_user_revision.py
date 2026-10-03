"""File CLI regressions with a captured synthetic QA Chapter 1 state.

Child responses are test inputs, not actual model generation or formal review.
The engine, deterministic gates, version storage and review binding are real.
Run: PYTHONDONTWRITEBYTECODE=1 python3 tests/test_user_revision.py
"""
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
FIXTURE = ROOT / "tests/fixtures/chapter-review-passed.json"
REGISTRY = json.loads((ROOT / "skill-registry.json").read_text())
sys.path.insert(0, str(ROOT / "scripts"))
import workflow_engine as engine
FEEDBACK = "首次引用顺序错误；机构使用NIST/SEMATECH正式名称；两种分数阈值须明确绝对值。"


class UserRevision(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.work = Path(self.directory.name)
        self.state = self.work / "state.json"
        self.feedback = self.work / "feedback.json"
        self.write(self.state, json.loads(FIXTURE.read_text()))
        self.write(self.feedback, {"feedback": FEEDBACK})

    def write(self, path, value):
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")

    def read(self):
        return json.loads(self.state.read_text())

    def cli(self, *args):
        return subprocess.run([sys.executable, str(ROOT / "scripts/workflow_cli.py"),
                               *map(str, args)], capture_output=True, text=True,
                              env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}, timeout=10)

    def succeed(self, *args):
        result = self.cli(*args)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        return result

    def reject_unchanged(self, *args):
        before = self.state.read_bytes()
        result = self.cli(*args)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.state.read_bytes(), before)
        return result

    def request(self, target="chapter:1", artifact_id="chapter-1", version=1, request_id="user-ch1-r1"):
        return self.succeed("request-revision", self.state, target, "--artifact-id", artifact_id,
                            "--version", version, "--request-id", request_id, "--feedback-file", self.feedback)

    def next_request(self):
        path = self.work / "request.json"
        self.succeed("next", self.state, "--request-out", path)
        return json.loads(path.read_text())

    def apply(self, request, **body):
        path = self.work / "response.json"
        self.write(path, {"request_id": request["orchestration"]["request_id"],
                          "skill_name": request["skill_name"], "action": request["action"],
                          "status": "success", **body})
        return self.succeed("apply", self.state, path)

    def revised_chapter(self):
        artifact = copy.deepcopy(self.read()["chapters"]["1"]["content"]["versions"][-1])
        artifact["version"] += 1
        artifact["content"]["markdown"] = artifact["content"]["markdown"].replace("NIST 等人", "NIST/SEMATECH")
        artifact["content"]["markdown"] = artifact["content"]["markdown"].replace("figures/fig1-1.svg", "figures/fig1-1-v2.svg")
        artifact["content"]["figures"][0]["path"] = "figures/fig1-1-v2.svg"
        return artifact

    def test_captured_ch1_can_be_returned_without_replacing_its_pass_or_body(self):
        original = self.read()
        self.assertEqual(original["stage"], "CHAPTER_REVIEW_PASSED")
        self.assertIsNone(original["pending_action"])
        self.request()
        requested = self.read()
        self.assertEqual(requested["chapters"], original["chapters"])
        self.assertEqual(requested["artifacts"], original["artifacts"])
        self.assertEqual(requested["schema_version"], "1.1.3")
        feedback = requested["user_revision_requests"][-1]
        self.assertEqual(feedback["feedback_source"], "user")
        self.assertEqual(feedback["feedback"], FEEDBACK)
        self.reject_unchanged("confirm", self.state, "chapter:1")
        request = self.next_request()
        self.assertEqual(request["action"], "revise_chapter")
        self.assertEqual(request["payload"]["base_artifact"], original["chapters"]["1"]["content"]["versions"][-1])
        self.assertEqual(request["payload"]["review_result"], original["chapters"]["1"]["content"]["reviews"][-1])
        self.assertEqual(request["payload"]["review_result"]["decision"], "pass")
        self.assertEqual(request["payload"]["user_feedback"]["feedback"], FEEDBACK)
        self.assertIn(FEEDBACK, request["payload"]["revision_instruction"])
        frozen = self.state.read_bytes()
        self.next_request()
        self.assertEqual(self.state.read_bytes(), frozen)
        self.request()
        self.assertEqual(self.state.read_bytes(), frozen)
        self.reject_unchanged("request-revision", self.state, "chapter:1", "--artifact-id", "chapter-1",
                              "--version", 1, "--request-id", "another-pending", "--feedback-file", self.feedback)
        self.apply(request, artifact=self.revised_chapter())
        revised = self.read()
        slot = revised["chapters"]["1"]["content"]
        self.assertEqual(slot["versions"][0], original["chapters"]["1"]["content"]["versions"][0])
        self.assertEqual(slot["reviews"], original["chapters"]["1"]["content"]["reviews"])
        self.assertEqual([a["version"] for a in slot["versions"]], [1, 2])
        self.assertEqual(revised["stage"], "CHAPTER_DRAFTED")
        self.assertTrue(slot["versions"][-1]["quality_metrics"]["chapter_length"]["length_gate_passed"])
        self.reject_unchanged("confirm", self.state, "chapter:1")
        review_request = self.next_request()
        self.assertEqual(review_request["action"], "review_chapter")
        self.assertEqual(review_request["payload"]["chapter"]["version"], 2)
        review = copy.deepcopy(slot["reviews"][-1])
        path = self.work / "old-review.json"
        self.write(path, {"request_id": review_request["orchestration"]["request_id"],
                          "skill_name": review_request["skill_name"], "action": review_request["action"],
                          "status": "success", "review_result": review})
        self.reject_unchanged("apply", self.state, path)
        # Stop at the required real reviewer request. No synthetic v2 pass is
        # applied to this captured QA case; native acceptance belongs to Root.
        frozen = self.state.read_bytes()
        self.request()
        self.assertEqual(self.state.read_bytes(), frozen)
        self.reject_unchanged("request-revision", self.state, "chapter:1", "--artifact-id", "chapter-1",
                              "--version", 1, "--request-id", "new-after-apply", "--feedback-file", self.feedback)

    def test_wrong_target_baseline_empty_feedback_and_request_id_conflict_are_rejected(self):
        for target, artifact_id, version in [("chapter:2", "chapter-1", 1),
                                             ("report", "chapter-1", 1),
                                             ("chapter:1", "wrong", 1),
                                             ("chapter:1", "chapter-1", 2),
                                             ("chapter:1", "chapter-1", 0)]:
            with self.subTest(target=target, artifact_id=artifact_id, version=version):
                self.reject_unchanged("request-revision", self.state, target, "--artifact-id", artifact_id,
                                      "--version", version, "--request-id", "bad", "--feedback-file", self.feedback)
        for content in [{"feedback": " "}, {"feedback": []}, {"feedback": FEEDBACK, "decision": "pass"}]:
            with self.subTest(content=content):
                self.write(self.feedback, content)
                self.reject_unchanged("request-revision", self.state, "chapter:1", "--artifact-id", "chapter-1",
                                      "--version", 1, "--request-id", "bad", "--feedback-file", self.feedback)
        self.write(self.feedback, {"feedback": FEEDBACK})
        self.request()
        self.write(self.feedback, {"feedback": "different feedback"})
        result = self.reject_unchanged("request-revision", self.state, "chapter:1", "--artifact-id", "chapter-1",
                                      "--version", 1, "--request-id", "user-ch1-r1", "--feedback-file", self.feedback)
        self.assertIn("conflicts", result.stderr)

    def test_active_requests_and_confirmed_targets_are_rejected(self):
        s = self.read()
        s["pending_action"] = {"action": "review_chapter"}
        self.write(self.state, s)
        self.reject_unchanged("request-revision", self.state, "chapter:1", "--artifact-id", "chapter-1",
                              "--version", 1, "--request-id", "new", "--feedback-file", self.feedback)
        s["pending_action"] = None
        self.write(self.state, s)
        self.request()
        self.reject_unchanged("request-revision", self.state, "chapter:1", "--artifact-id", "chapter-1",
                              "--version", 1, "--request-id", "other", "--feedback-file", self.feedback)
        self.write(self.state, json.loads(FIXTURE.read_text()))
        self.succeed("confirm", self.state, "chapter:1")
        self.reject_unchanged("request-revision", self.state, "chapter:1", "--artifact-id", "chapter-1",
                              "--version", 1, "--request-id", "late", "--feedback-file", self.feedback)
        s = self.read()
        s["stage"] = "CHAPTER_REVIEW_PASSED"
        self.write(self.state, s)
        self.reject_unchanged("request-revision", self.state, "chapter:1", "--artifact-id", "chapter-1",
                              "--version", 1, "--request-id", "late", "--feedback-file", self.feedback)

    def test_invalid_revision_identity_version_and_old_file_paths_keep_pending(self):
        self.request()
        request = self.next_request()
        good = self.revised_chapter()
        for field, value in [("artifact_id", "other"), ("artifact_type", "report"), ("version", 1), ("version", True)]:
            artifact = copy.deepcopy(good)
            artifact[field] = value
            path = self.work / "invalid.json"
            self.write(path, {"request_id": request["orchestration"]["request_id"], "skill_name": request["skill_name"],
                              "action": request["action"], "status": "success", "artifact": artifact})
            self.reject_unchanged("apply", self.state, path)
        artifact = copy.deepcopy(good)
        artifact["content"]["figures"][0]["path"] = "figures/fig1-1.svg"
        self.write(path, {"request_id": request["orchestration"]["request_id"], "skill_name": request["skill_name"],
                          "action": request["action"], "status": "success", "artifact": artifact})
        self.assertIn("new body/figure", self.reject_unchanged("apply", self.state, path).stderr)
        self.assertEqual(self.read()["user_revision_requests"][-1]["status"], "requested")
        artifact = copy.deepcopy(good)
        artifact["content"]["chapter_id"] = "2"
        self.write(path, {"request_id": request["orchestration"]["request_id"], "skill_name": request["skill_name"],
                          "action": request["action"], "status": "success", "artifact": artifact})
        self.assertIn("chapter_id", self.reject_unchanged("apply", self.state, path).stderr)
        for field, value in [("request_id", "old-request"), ("skill_name", "report-reviewer"), ("action", "generate_chapter")]:
            response = {"request_id": request["orchestration"]["request_id"], "skill_name": request["skill_name"],
                        "action": request["action"], "status": "success", "artifact": good}
            response[field] = value
            self.write(path, response)
            self.reject_unchanged("apply", self.state, path)

    def test_revised_short_body_cannot_inherit_v1_metrics_or_pass(self):
        self.request()
        request = self.next_request()
        artifact = self.revised_chapter()
        artifact["content"]["markdown"] = "# 第1章 项目概述\n\n过短的新正文。\n"
        self.apply(request, artifact=artifact)
        s = self.read()
        self.assertEqual(s["stage"], "CHAPTER_REVISION_REQUIRED")
        self.assertFalse(s["chapters"]["1"]["content"]["versions"][-1]["quality_metrics"]["chapter_length"]["length_gate_passed"])
        self.reject_unchanged("confirm", self.state, "chapter:1")
        self.assertEqual(self.next_request()["action"], "revise_chapter")

    def target_state(self, target):
        """Construct earlier confirmation points and final-report input from the QA capture."""
        s = json.loads(FIXTURE.read_text())
        stages = {"project_profile": "PROJECT_PROFILE_DRAFTED", "argument_architecture": "ARGUMENT_ARCHITECTURE_DRAFTED",
                  "outline": "OUTLINE_REVIEW_PASSED", "reference_plan": "REFERENCE_PLAN_DRAFTED",
                  "chapter_plan:1": "CHAPTER_PLAN_DRAFTED", "abstract": "ABSTRACT_DRAFTED", "report": "REPORT_REVIEW_PASSED"}
        s["stage"] = stages[target]
        s["confirmations"].pop(target, None)
        if target == "chapter_plan:1":
            slot = s["chapters"]["1"]["plan"]
        elif target in {"abstract", "report"}:
            artifact = {"artifact_type": target, "artifact_id": f"{target}-1", "version": 1,
                        "content": {"markdown": "# 第1章 项目概述\n\n合成的全文请求接口测试正文。\n"}}
            review = copy.deepcopy(s["chapters"]["1"]["content"]["reviews"][-1])
            review["reviewed_artifact_id"] = artifact["artifact_id"]
            slot = {"versions": [artifact], "reviews": [review] if target == "report" else [], "approved_version": None}
            s["artifacts"][target] = slot
        else:
            slot = s["artifacts"][target]
        slot["approved_version"] = None
        self.write(self.state, s)
        return slot["versions"][-1]

    def test_each_supported_confirmation_point_routes_to_existing_action_and_new_version(self):
        cases = {"project_profile": ("build_project_profile", "PROJECT_PROFILE_DRAFTED"),
                 "argument_architecture": ("build_argument_architecture", "ARGUMENT_ARCHITECTURE_DRAFTED"),
                 "outline": ("revise_outline", "OUTLINE_DRAFTED"),
                 "reference_plan": ("search_references", "REFERENCE_PLAN_DRAFTED"),
                 "chapter_plan:1": ("revise_chapter_plan", "CHAPTER_PLAN_DRAFTED"),
                 "abstract": ("generate_abstract", "ABSTRACT_REVISION_REQUIRED"),
                 "report": ("revise_report", "REPORT_ASSEMBLED")}
        for target, (action, stage) in cases.items():
            with self.subTest(target=target):
                base = copy.deepcopy(self.target_state(target))
                self.request(target, base["artifact_id"], 1, f"user-{target}")
                request = self.next_request()
                self.assertEqual(request["action"], action)
                self.assertEqual(request["payload"]["base_artifact"], base)
                self.assertEqual(request["payload"]["user_feedback"]["feedback_source"], "user")
                new = copy.deepcopy(base)
                new["version"] = 2
                self.apply(request, artifact=new)
                s = self.read()
                slot = s["chapters"]["1"]["plan"] if target == "chapter_plan:1" else s["artifacts"][target]
                self.assertEqual(slot["versions"][0], base)
                self.assertEqual([x["version"] for x in slot["versions"]], [1, 2])
                self.assertEqual(s["stage"], stage)
                self.assertIsNone(slot["approved_version"])
                if target in {"outline", "report"}:
                    self.assertEqual(self.next_request()["action"], f"review_{target}")
                elif target == "abstract":
                    self.assertFalse(slot["versions"][-1]["quality_metrics"]["abstract_quality"]["valid"])
                else:
                    self.succeed("confirm", self.state, target)

    def test_report_revision_requires_review_of_v2_and_preserves_old_report_file(self):
        base = self.target_state("report")
        old_file = self.work / "report-v1.md"
        old_file.write_text(base["content"]["markdown"])
        s = self.read()
        s["artifacts"]["report"]["versions"][0]["content"]["file_path"] = str(old_file)
        self.write(self.state, s)
        self.request("report", "report-1")
        request = self.next_request()
        old_bytes = old_file.read_bytes()
        artifact = copy.deepcopy(request["payload"]["base_artifact"])
        artifact["version"] = 2
        response_path = self.work / "response.json"
        self.write(response_path, {"request_id": request["orchestration"]["request_id"], "skill_name": request["skill_name"],
                                  "action": request["action"], "status": "success", "artifact": artifact})
        self.reject_unchanged("apply", self.state, response_path)
        self.assertEqual(old_file.read_bytes(), old_bytes)
        alias = self.work / "alias.md"
        alias.symlink_to(old_file)
        artifact["content"]["file_path"] = str(alias)
        self.write(response_path, {"request_id": request["orchestration"]["request_id"], "skill_name": request["skill_name"],
                                  "action": request["action"], "status": "success", "artifact": artifact})
        self.reject_unchanged("apply", self.state, response_path)
        self.assertEqual(old_file.read_bytes(), old_bytes)
        new_file = self.work / "report-v2.md"
        new_file.write_text("# 第1章 项目概述\n\n合成—新正文。\n")
        artifact["content"] = {"file_path": str(new_file)}
        self.apply(request, artifact=artifact)
        self.assertEqual(old_file.read_bytes(), old_bytes)
        self.assertIn("合成-新正文", new_file.read_text())
        self.assertEqual(self.read()["stage"], "REPORT_ASSEMBLED")
        review_request = self.next_request()
        self.assertEqual(review_request["action"], "review_report")
        self.assertEqual(review_request["payload"]["report"]["version"], 2)
        self.reject_unchanged("confirm", self.state, "report")

    def test_word_user_revision_is_explicitly_unsupported(self):
        s = self.read()
        s["stage"] = "WORD_REPORT_VALIDATED"
        self.write(self.state, s)
        result = self.reject_unchanged("request-revision", self.state, "word_report", "--artifact-id", "word-1",
                                      "--version", 1, "--request-id", "word", "--feedback-file", self.feedback)
        self.assertIn("not supported", result.stderr)

    def test_api_validation_and_failed_child_keep_feedback_without_a_fake_review(self):
        s = self.read()
        with self.assertRaises(ValueError):
            engine.request_revision(s, "chapter:1", "chapter-1", True, FEEDBACK, "user-bad")
        requested = engine.request_revision(s, "chapter:1", "chapter-1", 1, FEEDBACK, "user-good")
        pending, request = engine.prepare_pending_request(requested, REGISTRY)
        failed = engine.apply_response(pending, {"request_id": request["orchestration"]["request_id"],
                                                "skill_name": request["skill_name"], "action": request["action"],
                                                "status": "failed", "error": {"message": "synthetic failed child"}}, REGISTRY)
        self.assertEqual(failed["stage"], "FAILED")
        self.assertEqual(failed["user_revision_requests"][-1]["status"], "failed")
        self.assertEqual(failed["chapters"], s["chapters"])
        self.assertEqual(engine.request_revision(failed, "chapter:1", "chapter-1", 1, FEEDBACK, "user-good"), failed)



if __name__ == "__main__":
    unittest.main()
