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

    @patch.object(repair, "stop_app_server")
    def test_model_repair_rewrites_pinned_model_only(self, _stop):
        old = "cpx-relay-mu3su9ba/claude-opus-5-5"
        meta = {"type": "session_meta", "payload": {"id": "pinned", "model_provider": "custom"}}
        ctx = {"type": "turn_context", "payload": {"model": old, "comp_hash": "codex-plus-aggregate", "effort": "medium"}}
        settings = {"type": "event_msg", "payload": {"type": "thread_settings_applied",
                                                       "thread_settings": {"model": old, "model_provider_id": "openai"}}}
        message = '{"type":"response_item","payload":{"text":"讨论 ' + old + ' 的问题"}}\n'
        pinned = self.root / "sessions" / "pinned.jsonl"
        pinned.write_text("\n".join(json.dumps(x, ensure_ascii=False) for x in (meta, ctx, settings)) + "\n" + message,
                          encoding="utf-8")
        db = sqlite3.connect(self.root / "state_5.sqlite")
        db.execute("INSERT INTO threads VALUES ('pinned', 'custom', ?)", (old,))
        db.commit()
        db.close()

        scan = repair.snapshot(self.root)
        self.assertEqual((scan["models"][old], scan["dbModels"][old]), (1, 1))
        result = repair.repair_model(self.root, {"sourceModels": [old], "targetModel": "gpt-6.1-sol",
                                                 "expected": {old: {"database": 1, "files": 1}}})
        self.assertEqual((result["files"], result["lines"], result["database"]), (1, 2, 1))
        lines = pinned.read_text(encoding="utf-8").splitlines(keepends=True)
        self.assertEqual(json.loads(lines[1])["payload"], {"model": "gpt-6.1-sol", "effort": "medium"})
        self.assertEqual(json.loads(lines[2])["payload"]["thread_settings"]["model"], "gpt-6.1-sol")
        self.assertEqual(lines[3], message)
        self.assertEqual(self.file.read_text(encoding="utf-8").splitlines(keepends=True)[1], self.history)
        db = sqlite3.connect(self.root / "state_5.sqlite")
        self.assertEqual(db.execute("SELECT model FROM threads WHERE id='pinned'").fetchone(), ("gpt-6.1-sol",))
        db.close()
        self.assertIn(old, (pathlib.Path(result["backup"]) / "sessions" / "pinned.jsonl").read_text(encoding="utf-8"))

    @patch.object(repair, "stop_app_server")
    def test_reasoning_cleanup_keeps_lines_and_other_items(self, _stop):
        claude = {"type": "reasoning", "id": "rs_msg_011C_0", "summary": [], "encrypted_content": "CAQS0wcKEAgT"}
        openai = {"type": "reasoning", "id": "rs_0d8", "summary": [], "encrypted_content": "gAAAAABpXYZ"}
        message = {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "reasoning 回答"}]}
        rows = [
            {"type": "session_meta", "payload": {"id": "r", "model_provider": "custom"}},
            {"ordinal": 1, "type": "response_item", "payload": claude},
            {"ordinal": 2, "type": "response_item", "payload": openai},
            {"ordinal": 3, "type": "response_item", "payload": message},
            {"ordinal": 4, "type": "compacted", "payload": {"message": "", "replacement_history": [claude, message]}},
        ]
        path = self.root / "sessions" / "r.jsonl"
        path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")

        scan = repair.snapshot(self.root)
        self.assertEqual(scan["reasoning"], {"foreign": {"files": 1, "items": 2}, "all": {"files": 1, "items": 3}})
        result = repair.repair_reasoning(self.root, {"scope": "foreign", "expected": scan["reasoning"]["foreign"]})
        self.assertEqual((result["files"], result["items"]), (1, 2))
        lines = [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines()]
        self.assertEqual([l.get("ordinal") for l in lines], [None, 1, 2, 3, 4])
        self.assertEqual(lines[1]["payload"], {"type": repair.REMOVED_REASONING})
        self.assertEqual(lines[2]["payload"], openai)
        self.assertEqual(lines[3]["payload"], message)
        self.assertEqual(lines[4]["payload"]["replacement_history"], [message])
        after = repair.snapshot(self.root)["reasoning"]
        self.assertEqual(after, {"foreign": {"files": 0, "items": 0}, "all": {"files": 1, "items": 1}})
        result = repair.repair_reasoning(self.root, {"scope": "all", "expected": after["all"]})
        self.assertEqual(result["items"], 1)
        self.assertEqual(repair.snapshot(self.root)["reasoning"]["all"], {"files": 0, "items": 0})


if __name__ == "__main__":
    pass


class AvailableModelTests(unittest.TestCase):
    def test_reads_current_catalog_and_official_cache(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            (root / "catalogs").mkdir()
            (root / "catalogs" / "relay.json").write_text(json.dumps({"models": [
                {"slug": "claude-opus-5-5", "visibility": "list"},
                {"slug": "hidden", "visibility": "hide"}]}), encoding="utf-8")
            (root / "models_cache.json").write_text(json.dumps({"models": [
                {"slug": "gpt-6.1-sol", "display_name": "GPT-6.1 Sol", "visibility": "list"}]}), encoding="utf-8")
            (root / "config.toml").write_text(
                "model_provider = \"custom\"\nmodel_catalog_json = 'catalogs/relay.json'\nmodel = \"claude-opus-5-5\"\n"
                "[model_providers.custom]\nmodel = \"ignored\"\n", encoding="utf-8")
            result = repair.available_models(root)
            self.assertEqual((result["provider"], result["model"]), ("custom", "claude-opus-5-5"))
            self.assertEqual([[m["slug"] for m in g["models"]] for g in result["groups"]],
                             [["claude-opus-5-5", "hidden"], ["gpt-6.1-sol"]])
            self.assertTrue(result["groups"][0]["models"][1]["hidden"])
            self.assertEqual([g["current"] for g in result["groups"]], [True, False])
            (root / "config.toml").write_text("model = \"gpt-6.1-sol\"\n", encoding="utf-8")
            result = repair.available_models(root)
            self.assertEqual([(g["label"], g["current"]) for g in result["groups"]], [("当前方式（官方登录）", True)])


if __name__ == "__main__":
    unittest.main()
