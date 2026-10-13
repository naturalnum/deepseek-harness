"""User-authorized recovery of the captured synthetic Chapter 2 revision limit.

Runs the real engine, deterministic gates and file CLI on temporary copies.
Generator/reviewer responses are protocol test inputs, not real model acceptance.
Run: PYTHONDONTWRITEBYTECODE=1 python3 tests/test_chapter_revision_limit.py
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
FIXTURE = ROOT / "tests/fixtures/chapter-revision-limit.json"
REGISTRY = json.loads((ROOT / "skill-registry.json").read_text())
sys.path.insert(0, str(ROOT / "scripts"))
import workflow_engine as engine

FEEDBACK = "修正小结与科学表述；保持来源和标题锁，重新通过原门禁与正式审核。"


class ChapterRevisionLimit(unittest.TestCase):
    def setUp(self):
        self.state = json.loads(FIXTURE.read_text())

    def request(self, state=None, request_id="user-ch2-limit-1"):
        state = self.state if state is None else state
        artifact = state["chapters"]["2"]["content"]["versions"][-1]
        return engine.request_revision(state, "chapter:2", artifact["artifact_id"],
                                       artifact["version"], FEEDBACK, request_id)

    def response(self, request, **body):
        return {"request_id": request["orchestration"]["request_id"],
                "skill_name": request["skill_name"], "action": request["action"],
                "status": "success", **body}

    def next_revision(self, state=None):
        return engine.prepare_pending_request(self.request(state), REGISTRY)

    def artifact(self, passing=True):
        artifact = copy.deepcopy(self.state["chapters"]["2"]["content"]["versions"][-1])
        artifact["version"] = 4
        content = artifact["content"]
        content["file_path"] = "chapter-2-v4.md"
        content["figures"][0]["path"] = "figures/fig2-1-v4.svg"
        content["markdown"] = content["markdown"].replace("figures/fig2-1.svg", "figures/fig2-1-v4.svg")
        if passing:
            # Adjust the captured failing summary, keeping the real parser/gates.
            head, summary = content["markdown"].split("## 2.4 本章小结", 1)
            paragraphs = summary.strip().split("\n\n")
            paragraphs[1] += "全部计数都按固定的输入记录顺序逐项核对。"
            paragraphs[2] = paragraphs[2].split("；全部 28 条记录", 1)[0] + "。"
            content["markdown"] = head + "## 2.4 本章小结\n\n" + "\n\n".join(paragraphs)
            content["markdown"] += "\n\n说明：本章为模拟数据结果展示，不代表实际实验；实际结果应另行验证。\n"
        return artifact

    def formal_review(self, version, decision="pass"):
        return {"reviewed_artifact_id": "chapter-2", "reviewed_version": version,
                "decision": decision, "overall_score": 90 if decision == "pass" else 60,
                "issues": [], "must_fix": [] if decision == "pass" else ["修正内容问题"],
                "revision_instruction": "无需修改" if decision == "pass" else "修正内容问题"}

    def test_captured_limit_records_one_feedback_and_one_stable_child_without_reset(self):
        before = copy.deepcopy(self.state)
        self.assertEqual(before["stage"], "AWAITING_USER")
        self.assertEqual(before["revision_counters"]["chapters"]["2"], 3)
        requested = self.request()
        self.assertEqual(self.state, before)
        self.assertEqual(requested["chapters"], before["chapters"])
        self.assertEqual(requested["revision_counters"], before["revision_counters"])
        self.assertEqual(requested["quality_gates"], before["quality_gates"])
        self.assertEqual(requested["schema_version"], "1.1.3")
        self.assertEqual(self.request(requested), requested)
        pending, request = engine.prepare_pending_request(requested, REGISTRY)
        again, repeated = engine.prepare_pending_request(pending, REGISTRY)
        self.assertEqual(again, pending)
        self.assertEqual(repeated, request)
        self.assertEqual(request["action"], "revise_chapter")
        self.assertEqual(request["payload"]["chapter_id"], "2")
        self.assertEqual(request["payload"]["revision_output_requirements"]["version"], 4)
        self.assertEqual(request["payload"]["review_result"], before["chapters"]["2"]["content"]["reviews"][-1])
        self.assertEqual(request["payload"]["user_feedback"]["feedback_source"], "user")
        self.assertEqual(self.request(pending), pending)
        with self.assertRaises(ValueError):
            self.request(pending, "another-feedback")
        with self.assertRaisesRegex(ValueError, "conflicts"):
            engine.request_revision(requested, "chapter:2", "chapter-2", 3, "不同意见", "user-ch2-limit-1")

    def test_wrong_target_reason_review_baseline_confirmed_and_pending_are_rejected(self):
        mutations = [
            ("stage", lambda s: s.update(stage="FAILED")),
            ("reason", lambda s: s["last_error"].update(message="chapter review blocked")),
            ("outline", lambda s: s["last_error"].update(message="outline revision limit reached")),
            ("missing reason", lambda s: s.pop("last_error")),
            ("wrong current", lambda s: s.update(current_chapter_id="1")),
            ("wrong error chapter", lambda s: s["last_error"].update(chapter_id="1")),
            ("missing count", lambda s: s["revision_counters"]["chapters"].pop("2")),
            ("zero count", lambda s: s["revision_counters"]["chapters"].update({"2": 0})),
            ("missing content", lambda s: s["chapters"]["2"].pop("content")),
            ("wrong reviewed version", lambda s: s["chapters"]["2"]["content"]["reviews"][-1].update(reviewed_version=2)),
            ("wrong source", lambda s: s["chapters"]["2"]["content"]["reviews"][-1].update(review_source="deterministic_chapter_length_gate")),
            ("review passed", lambda s: s["chapters"]["2"]["content"]["reviews"][-1].update(decision="pass")),
            ("missing review", lambda s: s["chapters"]["2"]["content"].update(reviews=[])),
            ("confirmed", lambda s: s["chapters"]["2"]["content"].update(approved_version=3)),
            ("confirmed status", lambda s: s["chapters"]["2"].update(status="confirmed")),
            ("pending", lambda s: s.update(pending_action={"action": "review_chapter"})),
        ]
        for label, mutate in mutations:
            with self.subTest(label=label):
                state = copy.deepcopy(self.state)
                mutate(state)
                before = copy.deepcopy(state)
                with self.assertRaises(ValueError):
                    engine.request_revision(state, "chapter:2", "chapter-2", 3, FEEDBACK, "bad")
                self.assertEqual(state, before)
        for target, artifact_id, version in [("chapter:1", "chapter-2", 3),
                                              ("report", "chapter-2", 3),
                                              ("chapter:2", "wrong", 3),
                                              ("chapter:2", "chapter-2", 2)]:
            with self.subTest(target=target, artifact_id=artifact_id, version=version):
                with self.assertRaises(ValueError):
                    engine.request_revision(self.state, target, artifact_id, version, FEEDBACK, "bad")

    def test_only_exact_deterministic_and_formal_chapter_limit_reasons_are_supported(self):
        cases = {"heading bridge gate revision limit reached": "deterministic_heading_bridge_gate",
                 "chapter length gate revision limit reached": "deterministic_chapter_length_gate",
                 "chapter summary gate revision limit reached": "deterministic_chapter_summary_gate",
                 "chapter revision limit reached": None}
        for reason, source in cases.items():
            with self.subTest(reason=reason):
                state = copy.deepcopy(self.state)
                state["last_error"]["message"] = reason
                review = self.formal_review(3, "major_revision")
                if source:
                    review["review_source"] = source
                state["chapters"]["2"]["content"]["reviews"][-1] = review
                pending, request = self.next_revision(state)
                self.assertEqual(request["action"], "revise_chapter")
                self.assertEqual(pending["revision_counters"], state["revision_counters"])
        state["chapters"]["2"]["content"]["reviews"][-1]["reviewed_artifact_id"] = "other-chapter"
        with self.assertRaises(ValueError):
            self.request(state)

    def test_recovery_still_applies_length_and_bridge_gates_and_cannot_replay_response(self):
        pending, request = self.next_revision()
        for markdown, reason in [
                ("# 2 配电负荷异常识别方法\n\n过短正文。\n", "chapter length gate revision limit reached"),
                ("# 2 配电负荷异常识别方法\n\n## 2.1 校准\n\n" + "合成的门禁回归正文" * 300,
                 "heading bridge gate revision limit reached")]:
            with self.subTest(reason=reason):
                artifact = self.artifact()
                artifact["content"]["markdown"] = markdown
                response = self.response(request, artifact=artifact)
                failed = engine.apply_response(pending, response, REGISTRY)
                self.assertEqual(failed["stage"], "AWAITING_USER")
                self.assertEqual(failed["last_error"]["message"], reason)
                self.assertEqual(failed["revision_counters"]["chapters"]["2"], 4)
                self.assertEqual(engine.next_action(failed, REGISTRY)["kind"], "user_resolution")
                with self.assertRaisesRegex(ValueError, "pending_action"):
                    engine.apply_response(failed, response, REGISTRY)

    def test_failed_new_version_preserves_history_counts_and_requires_fresh_feedback(self):
        pending, request = self.next_revision()
        failed = engine.apply_response(pending, self.response(request, artifact=self.artifact(False)), REGISTRY)
        self.assertEqual(failed["stage"], "AWAITING_USER")
        self.assertEqual(failed["revision_counters"]["chapters"]["2"], 4)
        slot = failed["chapters"]["2"]["content"]
        self.assertEqual(slot["versions"][:3], self.state["chapters"]["2"]["content"]["versions"])
        self.assertEqual(slot["reviews"][:3], self.state["chapters"]["2"]["content"]["reviews"])
        self.assertEqual(failed["user_revision_requests"][-1]["status"], "applied")
        self.assertEqual(engine.next_action(failed, REGISTRY)["kind"], "user_resolution")
        # Replaying old feedback cannot grant another revision of v4.
        replay = engine.request_revision(failed, "chapter:2", "chapter-2", 3, FEEDBACK, "user-ch2-limit-1")
        self.assertEqual(replay, failed)
        self.assertEqual(engine.next_action(replay, REGISTRY)["kind"], "user_resolution")
        with self.assertRaises(ValueError):
            engine.request_revision(failed, "chapter:2", "chapter-2", 3, FEEDBACK, "new-stale")
        fresh = self.request(failed, "user-ch2-limit-2")
        _, child = engine.prepare_pending_request(fresh, REGISTRY)
        self.assertEqual(child["payload"]["revision_output_requirements"]["version"], 5)

    def test_new_body_figure_paths_and_new_version_review_then_explicit_confirmation(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            state = copy.deepcopy(self.state)
            old_body, old_figure = work / "v3.md", work / "v3.svg"
            old_body.write_text(state["chapters"]["2"]["content"]["versions"][-1]["content"]["markdown"])
            old_figure.write_text('<svg xmlns="http://www.w3.org/2000/svg"><text>synthetic scope</text></svg>')
            latest = state["chapters"]["2"]["content"]["versions"][-1]
            latest["content"]["file_path"] = str(old_body)
            latest["content"]["figures"][0]["path"] = str(old_figure)
            frozen = (old_body.read_bytes(), old_figure.read_bytes())
            pending, request = self.next_revision(state)
            artifact = self.artifact()
            for field, old_path in [("file_path", old_body), ("figure", old_figure)]:
                invalid = copy.deepcopy(artifact)
                if field == "figure":
                    invalid["content"]["figures"][0]["path"] = str(old_path)
                else:
                    invalid["content"][field] = str(old_path)
                with self.assertRaisesRegex(ValueError, "new body/figure"):
                    engine.apply_response(pending, self.response(request, artifact=invalid), REGISTRY)
            new_body, new_figure = work / "v4.md", work / "v4.svg"
            artifact["content"]["file_path"] = str(new_body)
            artifact["content"]["figures"][0]["path"] = str(new_figure)
            new_body.write_text(artifact["content"]["markdown"])
            new_figure.write_bytes(old_figure.read_bytes())
            revised = engine.apply_response(pending, self.response(request, artifact=artifact), REGISTRY)
            self.assertEqual((old_body.read_bytes(), old_figure.read_bytes()), frozen)
            self.assertEqual(revised["stage"], "CHAPTER_DRAFTED")
            self.assertEqual(revised["revision_counters"], state["revision_counters"])
            self.assertEqual(revised["chapters"]["2"]["content"]["reviews"], state["chapters"]["2"]["content"]["reviews"])
            metrics = revised["chapters"]["2"]["content"]["versions"][-1]["quality_metrics"]
            for gate, flag in [("chapter_length", "length_gate_passed"), ("heading_bridge", "bridge_gate_passed"),
                               ("chapter_summary", "summary_gate_passed"), ("simulation_chapter_end_notice", "notice_gate_passed")]:
                self.assertTrue(metrics[gate][flag], metrics)
            with self.assertRaises(ValueError):
                engine.confirm(revised, "chapter:2")
            reviewing, review_request = engine.prepare_pending_request(revised, REGISTRY)
            self.assertEqual(review_request["action"], "review_chapter")
            self.assertEqual(review_request["payload"]["chapter"]["version"], 4)
            with self.assertRaisesRegex(ValueError, "version mismatch"):
                engine.apply_response(reviewing, self.response(review_request, review_result=self.formal_review(3)), REGISTRY)
            failed_review = engine.apply_response(reviewing, self.response(review_request, review_result=self.formal_review(4, "major_revision")), REGISTRY)
            self.assertEqual(failed_review["stage"], "AWAITING_USER")
            self.assertEqual(engine.next_action(failed_review, REGISTRY)["kind"], "user_resolution")
            self.assertEqual(self.request(failed_review, "fresh-after-review")["user_revision_requests"][-1]["base_version"], 4)
            passed = engine.apply_response(reviewing, self.response(review_request, review_result=self.formal_review(4)), REGISTRY)
            confirmed = engine.confirm(passed, "chapter:2")
            self.assertEqual(confirmed["chapters"]["2"]["content"]["approved_version"], 4)
            self.assertEqual(confirmed["stage"], "CHAPTER_CONFIRMED")

    def test_actual_captured_state_cli_records_feedback_and_reuses_child(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            state, feedback, child = work / "state.json", work / "feedback.json", work / "child.json"
            state.write_bytes(FIXTURE.read_bytes())
            feedback.write_text(json.dumps({"feedback": FEEDBACK}, ensure_ascii=False))
            argv = [sys.executable, str(ROOT / "scripts/workflow_cli.py")]
            args = ["request-revision", str(state), "chapter:2", "--artifact-id", "chapter-2", "--version", "3",
                    "--request-id", "user-ch2-limit-1", "--feedback-file", str(feedback)]
            for command in [args, ["next", str(state), "--request-out", str(child)]]:
                result = subprocess.run(argv + command, capture_output=True, text=True, timeout=10,
                                        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
                self.assertEqual(result.returncode, 0, result.stderr)
            snapshot = state.read_bytes()
            request = child.read_bytes()
            for command in [args, ["next", str(state), "--request-out", str(child)]]:
                result = subprocess.run(argv + command, capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(state.read_bytes(), snapshot)
                self.assertEqual(child.read_bytes(), request)
            self.assertEqual(json.loads(request)["action"], "revise_chapter")
            self.assertEqual(feedback.read_text(), json.dumps({"feedback": FEEDBACK}, ensure_ascii=False))


if __name__ == "__main__":
    unittest.main()
