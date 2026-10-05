"""Actual scoped file reads and failure controls; fixtures are synthetic project materials."""
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import validate_references as validator


class LocalReferences(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.work = Path(self.directory.name).resolve()
        self.source = self.work / "source"
        (self.source / "materials").mkdir(parents=True)
        self.file = self.source / "materials/method.md"
        self.file.write_bytes("合成方法材料，仅供接口测试。\n".encode())
        self.bytes = self.file.read_bytes()
        digest = hashlib.sha256(self.bytes).hexdigest()
        self.item = {
            "id": "REF-METHOD", "title": "合成方法材料", "reference_type": "report",
            "source_kind": "local_file", "verification_status": "verified",
            "doi_or_identifier": "sha256:" + digest, "supports": ["合成规则说明"],
            "local_file_evidence": {"relative_path": "materials/method.md", "sha256": digest, "byte_size": len(self.bytes)},
            "gbt7714_entry": "测试组. 合成方法材料[R]. 2026.",
        }

    def registry(self, item=None):
        return {"internet_access": "unavailable", "collection_confirmed": False, "items": [item or self.item]}

    def issues(self, item):
        return validator.validate_reference_registry(self.registry(item), source_root=self.source)

    def test_real_local_file_and_stable_ids_are_independent_of_array_order(self):
        data = self.registry()
        other = copy.deepcopy(self.item)
        other.update(id="REF-DATA", title="合成数据", reference_type="dataset", gbt7714_entry="测试组. 合成数据[DS]. 2026.")
        data["items"].append(other)
        self.assertEqual(validator.validate_reference_registry(data, source_root=self.source), [])
        data["items"].reverse()
        self.assertEqual(validator.validate_reference_registry(data, source_root=self.source), [])
        self.assertEqual({item["id"] for item in data["items"]}, {"REF-METHOD", "REF-DATA"})
        data["items"][1]["id"] = "REF-DATA"
        self.assertTrue(validator.validate_reference_registry(data, source_root=self.source))

    def test_cli_requires_explicit_root_and_never_accepts_json_root_as_authorization(self):
        path = self.work / "registry.json"
        path.write_text(json.dumps(self.registry(), ensure_ascii=False))
        def run(*args):
            return subprocess.run([sys.executable, str(ROOT / "scripts/validate_references.py"), str(path), *map(str, args)],
                                  capture_output=True, text=True, timeout=5,
                                  env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
        self.assertEqual(run("--source-root", self.source).returncode, 0)
        self.assertEqual(run().returncode, 1)
        data = self.registry()
        data["source_root"] = str(self.source)
        path.write_text(json.dumps(data))
        self.assertEqual(run().returncode, 1)
        self.assertEqual(run("--source-root", self.source).returncode, 1)

    def test_forged_incomplete_and_misclassified_local_metadata_is_rejected(self):
        changes = (
            {"verification_status": "pending"}, {"doi_or_identifier": "invented"},
            {"source_kind": "external"}, {"source_kind": "local"}, {"source_kind": []},
            {"reference_type": "journal_article"}, {"reference_type": {}},
            {"official_url": "https://www.itl.nist.gov/"},
            {"verification_sources": ["https://local.invalid/method"]},
            {"gbt7714_entry": "测试组. 合成方法材料[EB/OL]. [2026-10-05]. https://local.invalid/method."},
        )
        for change in changes:
            with self.subTest(change=change):
                item = copy.deepcopy(self.item); item.update(change)
                self.assertTrue(self.issues(item))
        for field, value in (("sha256", "0" * 64), ("sha256", "not-a-digest"), ("byte_size", True),
                             ("byte_size", -1), ("byte_size", 10**100), ("byte_size", len(self.bytes) - 1),
                             ("relative_path", "materials/missing.md"), ("root", str(self.source))):
            with self.subTest(field=field, value=value):
                item = copy.deepcopy(self.item); item["local_file_evidence"][field] = value
                self.assertTrue(self.issues(item))
        item = copy.deepcopy(self.item); item.pop("source_kind")
        self.assertTrue(self.issues(item))

    def test_paths_and_symlinks_are_rejected_even_when_bytes_match(self):
        outside = self.work / "outside.md"; outside.write_bytes(self.bytes)
        (self.source / "leaf.md").symlink_to(self.file)
        (self.source / "linked").symlink_to(self.source / "materials", target_is_directory=True)
        for path in (str(outside), "../outside.md", "materials/../materials/method.md",
                     "./materials/method.md", "materials//method.md", "materials/",
                     "file:///materials/method.md", "C:\\materials\\method.md", "leaf.md", "linked/method.md"):
            with self.subTest(path=path):
                item = copy.deepcopy(self.item); item["local_file_evidence"]["relative_path"] = path
                self.assertTrue(self.issues(item))
        root_link = self.work / "root-link"; root_link.symlink_to(self.source, target_is_directory=True)
        self.assertTrue(validator.validate_reference_registry(self.registry(), source_root=root_link))
        self.assertTrue(validator.validate_reference_registry(self.registry(), source_root=Path(".")))

    def test_fifo_and_directory_are_not_read_as_sources(self):
        fifo = self.source / "pipe"; os.mkfifo(fifo)
        for path in ("pipe", "materials"):
            item = copy.deepcopy(self.item)
            item["local_file_evidence"].update(relative_path=path, byte_size=0, sha256=hashlib.sha256(b"").hexdigest())
            self.assertTrue(self.issues(item))

    def test_changed_bytes_same_byte_replacement_and_directory_replacement_fail(self):
        original_read = os.read
        for mutation in ("mtime", "replace", "directory", "grow"):
            with self.subTest(mutation=mutation):
                self.file.write_bytes(self.bytes)
                changed = False
                def read(fd, size):
                    nonlocal changed
                    if not changed:
                        changed = True
                        if mutation == "mtime":
                            current = self.file.stat()
                            os.utime(self.file, ns=(current.st_atime_ns, current.st_mtime_ns + 1_000_000))
                        elif mutation == "replace":
                            replacement = self.source / "replacement"; replacement.write_bytes(self.bytes)
                            replacement.replace(self.file)
                        elif mutation == "directory":
                            directory = self.source / "materials"
                            directory.rename(self.source / "old-materials")
                            directory.mkdir(); self.file.write_bytes(self.bytes)
                        else:
                            self.file.write_bytes(self.bytes + b"x")
                    return original_read(fd, size)
                with mock.patch.object(validator.os, "read", side_effect=read):
                    self.assertTrue(self.issues(self.item))
                if mutation == "directory":
                    self.file.unlink(); self.file.parent.rmdir()
                    (self.source / "old-materials").rename(self.source / "materials")

    def test_read_failure_and_unavailable_safe_open_primitives_fail_closed(self):
        with mock.patch.object(validator.os, "read", side_effect=OSError("synthetic read failure")):
            self.assertTrue(self.issues(self.item))
        with mock.patch.object(validator.os, "supports_dir_fd", set()):
            self.assertTrue(self.issues(self.item))

    def test_external_fixture_and_online_rules_remain_but_placeholder_http_is_rejected(self):
        data = json.loads((ROOT / "tests/fixtures/dataset-reference-registry.json").read_text())
        self.assertEqual(validator.validate_reference_registry(data), [])
        disguised = copy.deepcopy(data); disguised["items"][0]["doi_or_identifier"] = "local-file:test-material.md"
        self.assertTrue(validator.validate_reference_registry(disguised))
        for url in ("https://local.invalid/source", "https://EXAMPLE.INVALID./source",
                    "http://example.com/source", "https://local.test/source"):
            with self.subTest(url=url):
                modified = copy.deepcopy(data); modified["items"][0]["verification_sources"] = [url]
                self.assertTrue(validator.validate_reference_registry(modified))
                modified = copy.deepcopy(data); modified["items"][0]["gbt7714_entry"] += " " + url + "."
                self.assertTrue(validator.validate_reference_registry(modified))


if __name__ == "__main__":
    unittest.main()
