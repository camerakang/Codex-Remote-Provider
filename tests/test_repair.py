import importlib.util
import json
import os
import pathlib
import sqlite3
import tempfile
import unittest
from unittest.mock import patch


MODULE = pathlib.Path(__file__).parents[1] / "src" / "core" / "repair.py"
spec = importlib.util.spec_from_file_location("repair", MODULE)
repair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repair)


class RepairTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name) / ".codex"
        self.root.mkdir()
        self.file = self.root / "sessions" / "2026" / "10" / "21" / "example.jsonl"
        self.file.parent.mkdir(parents=True)
        meta = {"type": "session_meta", "payload": {"id": "example", "model_provider": "custom"}}
        self.history = '{"type":"turn_context","payload":{"model":"claude-opus-5-5"}}\n'
        self.file.write_text(json.dumps(meta) + "\n" + self.history, encoding="utf-8")
        db = sqlite3.connect(self.root / "state_5.sqlite")
        db.execute("CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT, model TEXT)")
        db.execute("INSERT INTO threads VALUES ('example', 'custom', 'claude-opus-5-5')")
        db.execute("INSERT INTO threads VALUES ('other', 'openai', 'gpt-6.1-sol')")
        db.commit()
        db.close()

    def options(self):
        return {"source": "custom", "target": "openai", "model": None,
                "resetModel": True, "expected": {"database": 1, "files": 1}}

    @patch.object(repair, "stop_app_server")
    def test_repairs_both_sources_and_preserves_history_with_backup(self, _stop):
        before = repair.snapshot(self.root)
        self.assertEqual(before["database"]["custom"], 1)
        self.assertEqual(before["files"]["custom"], 1)
        result = repair.repair(self.root, self.options())
        self.assertEqual((result["database"], result["files"]), (1, 1))
        backup = pathlib.Path(result["backup"])
        self.assertTrue((backup / "state_5.sqlite").exists())
        self.assertIn('"model_provider": "custom"', (backup / self.file.relative_to(self.root)).read_text())
        db = sqlite3.connect(self.root / "state_5.sqlite")
        self.assertEqual(db.execute("SELECT model_provider, model FROM threads WHERE id='example'").fetchone(),
                         ("openai", None))
        db.close()
        text = self.file.read_text(encoding="utf-8")
        self.assertEqual(json.loads(text.splitlines()[0])["payload"]["model_provider"], "openai")
        self.assertEqual(text.splitlines(keepends=True)[1], self.history)

    @patch.object(repair, "stop_app_server")
    def test_stale_scan_refuses_changes(self, _stop):
        options = self.options()
        options["expected"]["database"] = 2
        with self.assertRaisesRegex(RuntimeError, "重新扫描"):
            repair.repair(self.root, options)
        self.assertEqual(repair.snapshot(self.root)["database"]["custom"], 1)
        _stop.assert_not_called()

    @patch.object(repair, "stop_app_server")
    def test_invalid_jsonl_refuses_changes(self, _stop):
        (self.root / "sessions" / "bad.jsonl").write_text("invalid\n", encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "无法解析"):
            repair.repair(self.root, self.options())
        self.assertEqual(repair.snapshot(self.root)["database"]["custom"], 1)
        _stop.assert_not_called()

    @patch.object(repair, "stop_app_server")
    def test_file_failure_rolls_back_prior_file_and_database(self, _stop):
        second = self.root / "archived_sessions" / "other.jsonl"
        second.parent.mkdir()
        second.write_text(self.file.read_text(encoding="utf-8"), encoding="utf-8")
        original = self.file.read_bytes()
        options = self.options()
        options["expected"]["files"] = 2
        actual = repair.rewrite_metadata
        calls = 0

        def fail_second(path, source, target):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("simulated write failure")
            return actual(path, source, target)

        with patch.object(repair, "rewrite_metadata", side_effect=fail_second):
            with self.assertRaisesRegex(OSError, "simulated"):
                repair.repair(self.root, options)
        self.assertEqual(self.file.read_bytes(), original)
        self.assertEqual(repair.snapshot(self.root)["database"]["custom"], 1)
        self.assertEqual(repair.snapshot(self.root)["files"]["custom"], 2)


if __name__ == "__main__":
    unittest.main()
