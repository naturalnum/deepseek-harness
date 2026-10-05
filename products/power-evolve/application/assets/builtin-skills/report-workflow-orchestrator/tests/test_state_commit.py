"""Real JSON replacement and CLI failure reporting without infrastructure."""
import errno
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import workflow_engine as engine


class StateCommit(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "state.json"
        self.old_bytes = b'{"stage":"INITIALIZED","history":["old"]}\n'
        self.path.write_bytes(self.old_bytes)
        self.new = {"stage": "WORD_REPORT_VALIDATED", "history": ["old", "视觉检查"]}

    def assert_no_temporary_files(self):
        self.assertEqual(list(self.path.parent.iterdir()), [self.path])

    def test_file_sync_precedes_same_directory_private_replace_and_directory_sync(self):
        events = []
        fsync, replace = os.fsync, os.replace

        def sync(fd):
            events.append("directory_sync" if stat.S_ISDIR(os.fstat(fd).st_mode) else "file_sync")
            return fsync(fd)

        def commit(source, destination):
            events.append("replace")
            self.assertEqual(Path(source).parent, self.path.parent)
            self.assertEqual(destination, self.path)
            self.assertEqual(Path(source).stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(Path(source).read_text()), self.new)
            self.assertEqual(self.path.read_bytes(), self.old_bytes)
            return replace(source, destination)

        with patch.object(engine.os, "fsync", side_effect=sync), patch.object(engine.os, "replace", side_effect=commit):
            engine.save_json(self.path, self.new)
        self.assertEqual(events, ["file_sync", "replace", "directory_sync"])
        self.assertEqual(engine.load_json(self.path), self.new)
        self.assert_no_temporary_files()

    def test_serialization_temp_creation_file_sync_and_replace_failure_preserve_old_bytes(self):
        failures = [(engine.json, "dumps", TypeError("synthetic serialization failure")),
                    (engine.tempfile, "NamedTemporaryFile", OSError(errno.ENOSPC, "synthetic creation failure")),
                    (engine.os, "fsync", OSError(errno.EIO, "synthetic file sync failure")),
                    (engine.os, "replace", OSError(errno.EIO, "synthetic replacement failure"))]
        for owner, method, error in failures:
            with self.subTest(method=method), patch.object(owner, method, side_effect=error):
                with self.assertRaises(type(error)):
                    engine.save_json(self.path, self.new)
            self.assertEqual(self.path.read_bytes(), self.old_bytes)
            self.assert_no_temporary_files()

    def test_directory_sync_failure_reports_unconfirmed_commit_without_rolling_back(self):
        fsync = os.fsync

        def fail_directory(fd):
            if stat.S_ISDIR(os.fstat(fd).st_mode):
                raise OSError(errno.EIO, "synthetic directory sync failure")
            return fsync(fd)

        with patch.object(engine.os, "fsync", side_effect=fail_directory):
            with self.assertRaisesRegex(RuntimeError, "file may already be updated, but commit is not confirmed") as caught:
                engine.save_json(self.path, self.new)
        self.assertIsInstance(caught.exception.__cause__, OSError)
        self.assertEqual(engine.load_json(self.path), self.new)
        self.assert_no_temporary_files()

    def test_partial_temporary_write_or_flush_failure_cannot_truncate_old_state(self):
        create = engine.tempfile.NamedTemporaryFile
        for method in ["write", "flush"]:
            def interrupt(*args, **kwargs):
                file = create(*args, **kwargs)
                original = file.write

                def fail(*values):
                    if method == "write":
                        original(values[0][:10])
                    raise OSError(errno.ENOSPC, "synthetic partial write or flush failure")

                setattr(file, method, fail)
                return file

            with self.subTest(method=method), patch.object(engine.tempfile, "NamedTemporaryFile", side_effect=interrupt):
                with self.assertRaises(OSError):
                    engine.save_json(self.path, self.new)
            self.assertEqual(self.path.read_bytes(), self.old_bytes)
            self.assert_no_temporary_files()

    def test_cli_emits_no_success_for_file_sync_replace_or_directory_sync_failure(self):
        code = """
import errno, os, stat, sys
sys.path.insert(0, sys.argv[1])
import workflow_engine, workflow_cli
fault = sys.argv[2]
original_sync = os.fsync
def fail_sync(fd):
    directory = stat.S_ISDIR(os.fstat(fd).st_mode)
    if (fault == 'directory_sync' and directory) or (fault == 'file_sync' and not directory):
        raise OSError(errno.EIO, 'synthetic sync failure')
    return original_sync(fd)
def fail_replace(*args):
    raise OSError(errno.EIO, 'synthetic replacement failure')
workflow_engine.os.fsync = fail_sync
if fault == 'replace':
    workflow_engine.os.replace = fail_replace
sys.argv = ['workflow_cli', *sys.argv[3:]]
raise SystemExit(workflow_cli.main())
"""
        for fault in ["file_sync", "replace", "directory_sync"]:
            with self.subTest(fault=fault):
                self.path.write_bytes(self.old_bytes)
                result = subprocess.run([sys.executable, "-c", code, str(ROOT / "scripts"), fault,
                                         "init", str(self.path), "--project-id", "commit-fixture",
                                         "--title", "合成测试", "--goal", "测试提交失败"],
                                        capture_output=True, text=True, timeout=10,
                                        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, "")
                if fault == "directory_sync":
                    self.assertIn("commit is not confirmed", result.stderr)
                    self.assertIn("reread the state", result.stderr)
                    self.assertEqual(engine.load_json(self.path)["project_id"], "commit-fixture")
                else:
                    self.assertEqual(self.path.read_bytes(), self.old_bytes)
                self.assert_no_temporary_files()


if __name__ == "__main__":
    unittest.main()
