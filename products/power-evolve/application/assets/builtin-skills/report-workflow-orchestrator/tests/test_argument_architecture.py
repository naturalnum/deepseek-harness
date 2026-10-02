"""Synthetic architecture handoffs through the real engine and file CLI; no model or infrastructure.

Run: PYTHONDONTWRITEBYTECODE=1 python3 tests/test_argument_architecture.py
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
sys.path.insert(0, str(ROOT / "scripts"))
import workflow_engine as engine

REGISTRY = json.loads((ROOT / "skill-registry.json").read_text())
CHAPTERS = [
    {"chapter_no": 1, "chapter_title": "项目概述", "chapter_type": "foundation"},
    {"chapter_no": 2, "chapter_title": "合成负荷识别", "chapter_type": "technical-research"},
    {"chapter_no": 3, "chapter_title": "总结", "chapter_type": "conclusion"},
]


def architecture(content):
    return {"artifact_type": "argument_architecture", "artifact_id": "argument_architecture",
            "version": 1, "content": copy.deepcopy(content)}


def pending():
    state = engine.new_state("synthetic-architecture", {"title": "合成报告", "goal": "验证交接"}, "source_grounded")
    state["stage"] = "PROJECT_PROFILE_CONFIRMED"
    state["artifacts"]["project_profile"] = {
        "versions": [{"artifact_id": "project_profile", "version": 1, "content": {}}],
        "reviews": [], "approved_version": 1,
    }
    return engine.prepare_pending_request(state, REGISTRY)


def response(request, content):
    return {"request_id": request["orchestration"]["request_id"],
            "skill_name": request["skill_name"], "action": request["action"],
            "status": "success", "artifact": architecture(content)}


def old_draft():
    state, request = pending()
    state["stage"] = "ARGUMENT_ARCHITECTURE_DRAFTED"
    state["pending_action"] = None
    state["artifacts"]["argument_architecture"] = {
        "versions": [architecture({"one_sentence_problem": "旧草稿没有结构化章节"})],
        "reviews": [], "approved_version": None,
    }
    return state, request


class ArchitectureHandoff(unittest.TestCase):
    def test_nested_real_response_shape_applies_confirms_and_has_three_targets(self):
        state, request = pending()
        content = {"report_scope_confirmation": {"chapter_mapping": copy.deepcopy(CHAPTERS)},
                   "research_contents": ["叙述性研究内容不是章节表"]}
        drafted = engine.apply_response(state, response(request, content), REGISTRY)
        self.assertEqual(drafted["stage"], "ARGUMENT_ARCHITECTURE_DRAFTED")
        confirmed = engine.confirm(drafted, "argument_architecture")
        action = engine.next_action(confirmed, REGISTRY)
        self.assertEqual([x["suggested_title"] for x in action["chapter_targets"]],
                         [x["chapter_title"] for x in CHAPTERS])
        answers = [{"chapter_key": x["chapter_key"], "approximate_content": "合成材料"}
                   for x in action["chapter_targets"]]
        briefed = engine.submit_chapter_content_briefs(confirmed, answers)
        self.assertEqual(len(briefed["chapter_content_briefs"]["items"]), 3)
        self.assertEqual(engine.next_action(briefed, REGISTRY)["action"], "generate_outline")
        self.assertEqual(state["stage"], "PROJECT_PROFILE_CONFIRMED")

    def test_complete_top_level_mapping_does_not_duplicate_foundation_or_conclusion(self):
        state, request = pending()
        rows = [dict(x, chapter_id=f"ch{x['chapter_no']}") for x in CHAPTERS]
        drafted = engine.apply_response(state, response(request, {"proposed_chapters": rows}), REGISTRY)
        action = engine.next_action(engine.confirm(drafted, "argument_architecture"), REGISTRY)
        self.assertEqual([x["chapter_key"] for x in action["chapter_targets"]], ["ch1", "ch2", "ch3"])

    def test_technical_only_legacy_mapping_keeps_one_foundation_and_conclusion(self):
        state, request = pending()
        drafted = engine.apply_response(state, response(request, {
            "technical_chapters": [{"chapter_id": "technical-a", "title": "合成负荷识别"}],
        }), REGISTRY)
        action = engine.next_action(engine.confirm(drafted, "argument_architecture"), REGISTRY)
        self.assertEqual([x["chapter_key"] for x in action["chapter_targets"]],
                         ["foundation", "technical-a", "conclusion"])

    def test_invalid_mapping_is_rejected_by_both_apply_and_confirm_without_mutation(self):
        invalid = [None, {}, {"proposed_chapters": []}, {"proposed_chapters": ["not a chapter object"]},
                   {"proposed_chapters": [{}]}, {"proposed_chapters": [{"title": " "}]},
                   {"proposed_chapters": [dict(CHAPTERS[1], chapter_type="made-up")]},
                   {"proposed_chapters": [dict(CHAPTERS[1], chapter_type={})]},
                   {"report_scope_confirmation": {"chapter_mapping": [{"chapter_title": "缺少章节角色"}]}},
                   {"proposed_chapters": [dict(CHAPTERS[1], chapter_id="same"),
                                          dict(CHAPTERS[1], chapter_id="same")]},
                   {"proposed_chapters": [CHAPTERS[0], CHAPTERS[2]]}]
        for content in invalid:
            with self.subTest(content=content):
                state, request = pending()
                before = copy.deepcopy(state)
                with self.assertRaisesRegex(ValueError, "chapter"):
                    engine.apply_response(state, response(request, content), REGISTRY)
                self.assertEqual(state, before)
                draft, _ = old_draft()
                draft["artifacts"]["argument_architecture"]["versions"][0]["content"] = content
                original = copy.deepcopy(draft)
                with self.assertRaisesRegex(ValueError, "chapter"):
                    engine.confirm(draft, "argument_architecture")
                self.assertEqual(draft, original)

    def test_old_invalid_draft_has_frozen_repair_request_new_version_and_explicit_confirmation(self):
        draft, old_request = old_draft()
        original_version = copy.deepcopy(draft["artifacts"]["argument_architecture"]["versions"][0])
        repair_state, repair = engine.prepare_pending_request(draft, REGISTRY)
        self.assertEqual(repair["action"], "build_argument_architecture")
        self.assertNotEqual(repair["orchestration"]["request_id"], old_request["orchestration"]["request_id"])
        self.assertEqual(repair["payload"]["base_artifact"], original_version)
        self.assertIn("revision_instruction", repair["payload"])
        again, same_request = engine.prepare_pending_request(repair_state, REGISTRY)
        self.assertEqual(again, repair_state)
        self.assertEqual(same_request, repair)
        with self.assertRaisesRegex(ValueError, "request_id"):
            engine.apply_response(repair_state, response(old_request, {"proposed_chapters": CHAPTERS}), REGISTRY)
        fixed_response = response(repair, {"proposed_chapters": CHAPTERS})
        fixed = engine.apply_response(repair_state, fixed_response, REGISTRY)
        slot = fixed["artifacts"]["argument_architecture"]
        self.assertEqual(slot["versions"][0], original_version)
        self.assertEqual([x["version"] for x in slot["versions"]], [1, 2])
        self.assertEqual(fixed["stage"], "ARGUMENT_ARCHITECTURE_DRAFTED")
        self.assertNotIn("argument_architecture", fixed["confirmations"])
        self.assertEqual(engine.next_action(fixed, REGISTRY),
                         {"kind": "user_confirmation", "target": "argument_architecture"})
        confirmed = engine.confirm(fixed, "argument_architecture")
        self.assertEqual(confirmed["stage"], "ARGUMENT_ARCHITECTURE_CONFIRMED")
        self.assertEqual(confirmed["artifacts"]["argument_architecture"]["approved_version"], 2)
        with self.assertRaisesRegex(ValueError, "request_id"):
            engine.apply_response(fixed, fixed_response, REGISTRY)

    def test_response_must_match_pending_skill_and_action(self):
        for field in ["skill_name", "action"]:
            state, request = pending()
            value = response(request, {"proposed_chapters": CHAPTERS})
            value[field] = "wrong" if field == "skill_name" else "build_project_profile"
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "pending_action"):
                engine.apply_response(state, value, REGISTRY)

    def test_cli_rejection_retains_exact_file_and_accepts_corrected_same_pending_request(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state, request = pending()
            state_path, response_path = root / "state.json", root / "response.json"
            engine.save_json(state_path, state)
            original = state_path.read_bytes()
            engine.save_json(response_path, response(request, {"proposed_chapters": []}))
            result = self.cli("apply", state_path, response_path)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(state_path.read_bytes(), original)
            engine.save_json(response_path, response(request, {"proposed_chapters": CHAPTERS}))
            self.assertEqual(self.cli("apply", state_path, response_path).returncode, 0)
            self.assertEqual(json.loads(state_path.read_text())["stage"], "ARGUMENT_ARCHITECTURE_DRAFTED")
            self.assertEqual(self.cli("confirm", state_path, "argument_architecture").returncode, 0)

    def test_cli_old_invalid_draft_is_repaired_through_next_apply_and_confirm(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            draft, old_request = old_draft()
            state_path, request_path, response_path = root / "state.json", root / "request.json", root / "response.json"
            engine.save_json(state_path, draft)
            self.assertEqual(self.cli("next", state_path, "--request-out", request_path).returncode, 0)
            repair = json.loads(request_path.read_text())
            self.assertNotEqual(repair["orchestration"]["request_id"], old_request["orchestration"]["request_id"])
            frozen = state_path.read_bytes()
            self.assertEqual(self.cli("next", state_path, "--request-out", request_path).returncode, 0)
            self.assertEqual(state_path.read_bytes(), frozen)
            engine.save_json(response_path, response(old_request, {"proposed_chapters": CHAPTERS}))
            self.assertNotEqual(self.cli("apply", state_path, response_path).returncode, 0)
            self.assertEqual(state_path.read_bytes(), frozen)
            engine.save_json(response_path, response(repair, {"proposed_chapters": CHAPTERS}))
            self.assertEqual(self.cli("apply", state_path, response_path).returncode, 0)
            fixed = json.loads(state_path.read_text())
            versions = fixed["artifacts"]["argument_architecture"]["versions"]
            self.assertEqual(versions[0], draft["artifacts"]["argument_architecture"]["versions"][0])
            self.assertEqual(versions[1]["version"], 2)
            self.assertEqual(fixed["stage"], "ARGUMENT_ARCHITECTURE_DRAFTED")
            self.assertEqual(self.cli("confirm", state_path, "argument_architecture").returncode, 0)
            self.assertEqual(json.loads(state_path.read_text())["artifacts"]["argument_architecture"]["approved_version"], 2)

    def test_model_autonomous_keeps_existing_unstructured_architecture_flow(self):
        state, request = pending()
        state["content_generation_mode"] = "model_autonomous"
        drafted = engine.apply_response(state, response(request, {"one_sentence_problem": "自主生成说明"}), REGISTRY)
        self.assertEqual(engine.confirm(drafted, "argument_architecture")["stage"], "ARGUMENT_ARCHITECTURE_CONFIRMED")

    @staticmethod
    def cli(*args):
        return subprocess.run([sys.executable, str(ROOT / "scripts" / "workflow_cli.py"), *map(str, args)],
                              capture_output=True, text=True, timeout=5,
                              env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})


if __name__ == "__main__":
    unittest.main()
