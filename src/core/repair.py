"""Codex conversation repair (provider and pinned model). Runs on the SSH host or locally with Python 3."""
import base64
import json
import os
import pathlib
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
import uuid

MODEL_RE = re.compile(r"^[\w .:/-]{1,128}$")


def root_dir():
    return pathlib.Path(os.environ.get("CRP_CODEX_HOME") or pathlib.Path.home() / ".codex")


def db_path(root):
    path = root / "state_5.sqlite"
    if not path.is_file():
        raise RuntimeError("远端缺少 ~/.codex/state_5.sqlite")
    return path


def session_files(root):
    for folder in ("sessions", "archived_sessions"):
        base = root / folder
        if base.is_dir():
            for path in base.rglob("*.jsonl"):
                if path.is_file() and not path.is_symlink():
                    yield path


def file_provider(path):
    with path.open("r", encoding="utf-8") as stream:
        line = stream.readline()
    obj = json.loads(line)
    if obj.get("type") != "session_meta" or not isinstance(obj.get("payload"), dict):
        raise ValueError("首行不是 session_meta")
    provider = obj["payload"].get("model_provider")
    if not isinstance(provider, str) or not provider:
        raise ValueError("缺少会话供应商")
    return provider


def line_model(obj):
    """Model pinned by a rollout line: turn_context (used for pre-turn compaction) or thread settings."""
    payload = obj.get("payload") if isinstance(obj, dict) else None
    if not isinstance(payload, dict):
        return None
    if obj.get("type") == "turn_context":
        model = payload.get("model")
    elif obj.get("type") == "event_msg" and payload.get("type") == "thread_settings_applied":
        model = (payload.get("thread_settings") or {}).get("model")
    else:
        return None
    return model if isinstance(model, str) and model else None


def model_lines(path):
    with path.open("r", encoding="utf-8", newline="") as stream:
        for line in stream:
            if '"turn_context"' in line or '"thread_settings_applied"' in line:
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue
                yield obj, line_model(obj)


def file_models(path):
    return {model for _, model in model_lines(path) if model}


# OpenAI's own encrypted reasoning is a Fernet token; relays for other vendors (Claude etc.)
# store their own blobs, which the official backend rejects with "could not be verified".
REMOVED_REASONING = "crp_removed_reasoning"


def reasoning_kind(item):
    if not isinstance(item, dict) or item.get("type") != "reasoning":
        return None
    content = item.get("encrypted_content")
    if not isinstance(content, str) or not content:
        return None
    return "openai" if content.startswith("gAAAAA") else "foreign"


def reasoning_matches(item, scope):
    kind = reasoning_kind(item)
    return kind is not None and (scope == "all" or kind == scope)


def line_reasoning(obj):
    """Encrypted reasoning items carried by a rollout line (direct item or inside compacted history)."""
    payload = obj.get("payload") if isinstance(obj, dict) else None
    if not isinstance(payload, dict):
        return []
    if obj.get("type") == "response_item":
        return [payload] if reasoning_kind(payload) else []
    if obj.get("type") == "compacted" and isinstance(payload.get("replacement_history"), list):
        return [item for item in payload["replacement_history"] if reasoning_kind(item)]
    return []


def file_reasoning(path):
    counts = {"openai": 0, "foreign": 0}
    with path.open("r", encoding="utf-8", newline="") as stream:
        for line in stream:
            if '"reasoning"' in line and '"encrypted_content"' in line:
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue
                for item in line_reasoning(obj):
                    counts[reasoning_kind(item)] += 1
    return counts


def snapshot(root):
    path = db_path(root)
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
    try:
        columns = {row[1] for row in con.execute("PRAGMA table_info(threads)")}
        if not {"id", "model_provider", "model"}.issubset(columns):
            raise RuntimeError("threads 表结构不受支持")
        db_counts = {str(provider): count for provider, count in
                     con.execute("SELECT model_provider, count(*) FROM threads GROUP BY model_provider")}
        db_models = {str(model): count for model, count in
                     con.execute("SELECT model, count(*) FROM threads WHERE model IS NOT NULL AND model != '' GROUP BY model")}
    finally:
        con.close()
    files = {}
    models = {}
    model_sets = {}
    reasoning = {scope: {"files": 0, "items": 0} for scope in ("foreign", "all")}
    errors = []
    for path in session_files(root):
        try:
            provider = file_provider(path)
            files[str(provider)] = files.get(str(provider), 0) + 1
            found = file_models(path)
            for model in found:
                models[model] = models.get(model, 0) + 1
            if found:
                key = "\n".join(sorted(found))
                model_sets[key] = model_sets.get(key, 0) + 1
            kinds = file_reasoning(path)
            for scope, count in (("foreign", kinds["foreign"]), ("all", kinds["foreign"] + kinds["openai"])):
                if count:
                    reasoning[scope]["files"] += 1
                    reasoning[scope]["items"] += count
        except (OSError, ValueError, UnicodeError):
            errors.append(str(path.relative_to(root)))
    return {"database": db_counts, "files": files, "dbModels": db_models, "models": models,
            "modelSets": [[key.split("\n"), count] for key, count in sorted(model_sets.items())],
            "reasoning": reasoning, "invalidFiles": errors}


def matching_files(root, source):
    return [path for path in session_files(root) if file_provider(path) == source]


def top_config(root):
    """Top-level keys of config.toml (before the first table); enough for provider/model/catalog."""
    values = {}
    try:
        text = (root / "config.toml").read_text(encoding="utf-8")
    except OSError:
        return values
    for line in text.splitlines():
        if line.lstrip().startswith("["):
            break
        match = re.match(r"""^\s*([\w-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')""", line)
        if match:
            raw = match.group(2)
            values[match.group(1)] = raw.replace("\\\\", "\\").replace('\\"', '"') if raw is not None else match.group(3)
    return values


def catalog_models(path):
    try:
        data = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeError):
        return None
    items = data.get("models") if isinstance(data, dict) else data
    if not isinstance(items, list):
        return None
    result = []
    for item in items:
        if isinstance(item, dict) and isinstance(item.get("slug"), str):
            entry = {"slug": item["slug"], "name": item.get("display_name") or item["slug"]}
            if item.get("visibility", "list") != "list":
                entry["hidden"] = True
            result.append(entry)
    return result


def available_models(root):
    """Models the currently configured login method offers, read the same way Codex does."""
    conf = top_config(root)
    provider = conf.get("model_provider") or "openai"
    groups = []
    catalog = conf.get("model_catalog_json")
    if catalog:
        path = pathlib.Path(catalog)
        if not path.is_absolute():
            path = root / path
        models = catalog_models(path)
        if models:
            groups.append({"label": f"当前方式（{provider}）", "current": True, "models": models})
    official = catalog_models(root / "models_cache.json")
    if official:
        if provider == "openai" and not groups:
            groups.append({"label": "当前方式（官方登录）", "current": True, "models": official})
        elif provider != "openai":
            groups.append({"label": "官方登录（ChatGPT）", "current": False, "models": official})
    return {"provider": provider, "model": conf.get("model"), "groups": groups}


def local_codex_running():
    if os.name == "nt":
        out = subprocess.run(["tasklist", "/FO", "CSV", "/NH"], capture_output=True, text=True,
                             errors="replace", check=False).stdout
        names = {line.split('","')[0].strip('"').lower() for line in out.splitlines() if line}
        return "codex.exe" in names
    for pattern in (["-x", "Codex"], ["-f", "codex app-server"]):
        if subprocess.run(["pgrep"] + pattern, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                          check=False).returncode == 0:
            return True
    return False


def stop_app_server():
    if os.environ.get("CRP_CODEX_HOME"):
        return
    if os.environ.get("CRP_LOCAL"):
        if local_codex_running():
            raise RuntimeError("本机 Codex 仍在运行，请先完全退出 Codex 桌面版（含托盘）后再修复")
        return
    subprocess.run(["pkill", "-f", "app-server --listen"], stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, check=False)
    for _ in range(25):
        result = subprocess.run(["pgrep", "-f", "app-server --listen"], stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, check=False)
        if result.returncode == 1:
            return
        time.sleep(0.2)
    raise RuntimeError("远端 app-server 未停止，请关闭正在使用的远端对话后重试")


def rewrite_metadata(path, source, target):
    mode = stat.S_IMODE(path.stat().st_mode)
    temp_name = None
    try:
        with path.open("r", encoding="utf-8", newline="") as original:
            first = original.readline()
            obj = json.loads(first)
            if obj.get("type") != "session_meta" or obj.get("payload", {}).get("model_provider") != source:
                raise RuntimeError("会话文件在扫描后发生变化")
            obj["payload"]["model_provider"] = target
            with tempfile.NamedTemporaryFile("w", encoding="utf-8", newline="", dir=path.parent,
                                             prefix=".crp-repair-", suffix=".tmp", delete=False) as changed:
                temp_name = changed.name
                changed.write(json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n")
                shutil.copyfileobj(original, changed)
                changed.flush()
                os.fsync(changed.fileno())
        os.chmod(temp_name, mode)
        os.replace(temp_name, path)
    finally:
        if temp_name and os.path.exists(temp_name):
            os.unlink(temp_name)


def rewrite_models(path, sources, target):
    """Replace the pinned model in turn_context and thread settings lines; other lines stay byte-identical."""
    mode = stat.S_IMODE(path.stat().st_mode)
    temp_name = None
    changed_lines = 0
    try:
        with path.open("r", encoding="utf-8", newline="") as original:
            with tempfile.NamedTemporaryFile("w", encoding="utf-8", newline="", dir=path.parent,
                                             prefix=".crp-repair-", suffix=".tmp", delete=False) as changed:
                temp_name = changed.name
                for line in original:
                    if ('"turn_context"' in line or '"thread_settings_applied"' in line) and any(s in line for s in sources):
                        obj = json.loads(line)
                        if line_model(obj) in sources:
                            if obj["type"] == "turn_context":
                                obj["payload"]["model"] = target
                                # The old hash belongs to the old model; a mismatch would force
                                # another compaction with the previous model.
                                obj["payload"].pop("comp_hash", None)
                            else:
                                obj["payload"]["thread_settings"]["model"] = target
                            ending = "\r\n" if line.endswith("\r\n") else "\n" if line.endswith("\n") else ""
                            line = json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + ending
                            changed_lines += 1
                    changed.write(line)
                changed.flush()
                os.fsync(changed.fileno())
        if not changed_lines:
            raise RuntimeError("会话文件在扫描后发生变化")
        os.chmod(temp_name, mode)
        os.replace(temp_name, path)
        return changed_lines
    finally:
        if temp_name and os.path.exists(temp_name):
            os.unlink(temp_name)


def make_backup(root, con, files, manifest):
    backup = root / "provider-sync" / "repair-backups" / (
        time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8])
    backup.mkdir(mode=0o700, parents=True)
    saved = sqlite3.connect(backup / db_path(root).name)
    try:
        con.backup(saved)
    finally:
        saved.close()
    for file in files:
        destination = backup / file.relative_to(root)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(file, destination)
    manifest["files"] = [str(file.relative_to(root)) for file in files]
    (backup / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return backup


def repair(root, options):
    source = options.get("source")
    target = options.get("target")
    expected = options.get("expected")
    reset_model = options.get("resetModel", True)
    model = options.get("model")
    if not all(isinstance(value, str) and value.strip() for value in (source, target)):
        raise ValueError("供应商标识不能为空")
    if source == target:
        raise ValueError("原供应商与目标供应商相同")
    if not isinstance(expected, dict) or not isinstance(expected.get("database"), int) or not isinstance(expected.get("files"), int):
        raise ValueError("缺少扫描结果")
    if model is not None and not isinstance(model, str):
        raise ValueError("模型名称格式不正确")
    if snapshot(root)["invalidFiles"]:
        raise RuntimeError("发现无法解析的会话文件，已停止以避免遗漏")
    before = snapshot(root)
    if before["database"].get(source, 0) != expected["database"] or before["files"].get(source, 0) != expected["files"]:
        raise RuntimeError("远端会话数量已变化，请重新扫描")
    if expected["database"] + expected["files"] == 0:
        return {"database": 0, "files": 0, "backup": None}

    stop_app_server()
    before = snapshot(root)
    if before["database"].get(source, 0) != expected["database"] or before["files"].get(source, 0) != expected["files"]:
        raise RuntimeError("远端会话数量已变化，请重新扫描")
    files = matching_files(root, source)
    path = db_path(root)
    con = sqlite3.connect(path, timeout=10)
    changed = []
    try:
        backup = make_backup(root, con, files, {
            "kind": "provider", "source": source, "target": target,
            "model": model if reset_model else None, "resetModel": reset_model,
            "database": expected["database"]})

        con.execute("BEGIN IMMEDIATE")
        for file in files:
            rewrite_metadata(file, source, target)
            changed.append(file)
        if reset_model:
            cur = con.execute("UPDATE threads SET model_provider=?, model=? WHERE model_provider=?",
                              (target, model or None, source))
        else:
            cur = con.execute("UPDATE threads SET model_provider=? WHERE model_provider=?",
                              (target, source))
        if cur.rowcount != expected["database"]:
            raise RuntimeError("数据库记录数量在修复时发生变化")
        con.commit()
        return {"database": cur.rowcount, "files": len(changed), "backup": str(backup)}
    except Exception:
        con.rollback()
        for file in changed:
            shutil.copy2(backup / file.relative_to(root), file)
        raise
    finally:
        con.close()


def repair_model(root, options):
    sources = options.get("sourceModels")
    target = options.get("targetModel")
    expected = options.get("expected")
    if not isinstance(sources, list) or not sources:
        raise ValueError("请选择要替换的旧模型")
    sources = set(sources)
    for value in list(sources) + [target]:
        if not isinstance(value, str) or not MODEL_RE.match(value):
            raise ValueError("模型名称格式不正确")
    if target in sources:
        raise ValueError("旧模型与目标模型相同")
    if not isinstance(expected, dict) or set(expected) != sources or not all(
            isinstance(v, dict) and isinstance(v.get("database"), int) and isinstance(v.get("files"), int)
            for v in expected.values()):
        raise ValueError("缺少扫描结果")

    def check(snap):
        if snap["invalidFiles"]:
            raise RuntimeError("发现无法解析的会话文件，已停止以避免遗漏")
        for source, count in expected.items():
            if snap["dbModels"].get(source, 0) != count["database"] or snap["models"].get(source, 0) != count["files"]:
                raise RuntimeError("会话数量已变化，请重新扫描")

    check(snapshot(root))
    database_total = sum(v["database"] for v in expected.values())
    if database_total + sum(v["files"] for v in expected.values()) == 0:
        return {"database": 0, "files": 0, "lines": 0, "backup": None}
    stop_app_server()
    check(snapshot(root))
    files = [path for path in session_files(root) if sources & file_models(path)]
    con = sqlite3.connect(db_path(root), timeout=10)
    changed = []
    lines = 0
    try:
        backup = make_backup(root, con, files, {
            "kind": "model", "sourceModels": sorted(sources), "targetModel": target,
            "database": database_total})
        con.execute("BEGIN IMMEDIATE")
        for file in files:
            lines += rewrite_models(file, sources, target)
            changed.append(file)
        marks = ",".join("?" for _ in sources)
        cur = con.execute(f"UPDATE threads SET model=? WHERE model IN ({marks})", (target, *sorted(sources)))
        if cur.rowcount != database_total:
            raise RuntimeError("数据库记录数量在修复时发生变化")
        con.commit()
        return {"database": cur.rowcount, "files": len(changed), "lines": lines, "backup": str(backup)}
    except Exception:
        con.rollback()
        for file in changed:
            shutil.copy2(backup / file.relative_to(root), file)
        raise
    finally:
        con.close()


def rewrite_reasoning(path, scope):
    """Neutralise matching reasoning items; the line itself (and its ordinal) is kept so paginated history stays contiguous."""
    mode = stat.S_IMODE(path.stat().st_mode)
    temp_name = None
    removed = 0
    try:
        with path.open("r", encoding="utf-8", newline="") as original:
            with tempfile.NamedTemporaryFile("w", encoding="utf-8", newline="", dir=path.parent,
                                             prefix=".crp-repair-", suffix=".tmp", delete=False) as changed:
                temp_name = changed.name
                for line in original:
                    if '"reasoning"' in line and '"encrypted_content"' in line:
                        obj = json.loads(line)
                        payload = obj.get("payload")
                        hit = 0
                        if obj.get("type") == "response_item" and reasoning_matches(payload, scope):
                            # Unknown item types load as ResponseItem::Other, which is never sent to the model.
                            obj["payload"] = {"type": REMOVED_REASONING}
                            hit = 1
                        elif obj.get("type") == "compacted" and isinstance(payload.get("replacement_history"), list):
                            kept = [item for item in payload["replacement_history"] if not reasoning_matches(item, scope)]
                            hit = len(payload["replacement_history"]) - len(kept)
                            payload["replacement_history"] = kept
                        if hit:
                            ending = "\r\n" if line.endswith("\r\n") else "\n" if line.endswith("\n") else ""
                            line = json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + ending
                            removed += hit
                    changed.write(line)
                changed.flush()
                os.fsync(changed.fileno())
        if not removed:
            raise RuntimeError("会话文件在扫描后发生变化")
        os.chmod(temp_name, mode)
        os.replace(temp_name, path)
        return removed
    finally:
        if temp_name and os.path.exists(temp_name):
            os.unlink(temp_name)


def repair_reasoning(root, options):
    scope = options.get("scope")
    expected = options.get("expected")
    if scope not in ("foreign", "all"):
        raise ValueError("清理范围不正确")
    if not isinstance(expected, dict) or not isinstance(expected.get("files"), int) or not isinstance(expected.get("items"), int):
        raise ValueError("缺少扫描结果")

    def check(snap):
        if snap["invalidFiles"]:
            raise RuntimeError("发现无法解析的会话文件，已停止以避免遗漏")
        if snap["reasoning"][scope] != expected:
            raise RuntimeError("会话内容已变化，请重新扫描")

    check(snapshot(root))
    if expected["files"] == 0:
        return {"files": 0, "items": 0, "backup": None}
    stop_app_server()
    check(snapshot(root))
    files = []
    for path in session_files(root):
        kinds = file_reasoning(path)
        if kinds["foreign"] or (scope == "all" and kinds["openai"]):
            files.append(path)
    con = sqlite3.connect(db_path(root), timeout=10)
    changed = []
    items = 0
    try:
        backup = make_backup(root, con, files, {"kind": "reasoning", "scope": scope, "items": expected["items"]})
        for file in files:
            items += rewrite_reasoning(file, scope)
            changed.append(file)
        if items != expected["items"]:
            raise RuntimeError("清理数量与扫描结果不一致")
        return {"files": len(changed), "items": items, "backup": str(backup)}
    except Exception:
        for file in changed:
            shutil.copy2(backup / file.relative_to(root), file)
        raise
    finally:
        con.close()


def main():
    root = root_dir()
    mode = sys.argv[1] if len(sys.argv) > 1 else "scan"
    options = json.loads(base64.b64decode(sys.argv[2]).decode("utf-8")) if len(sys.argv) > 2 else {}
    if mode == "scan":
        result = snapshot(root)
        result["available"] = available_models(root)
    elif mode == "repair":
        result = repair(root, options)
    elif mode == "repair-model":
        result = repair_model(root, options)
    elif mode == "repair-reasoning":
        result = repair_reasoning(root, options)
    else:
        raise ValueError("未知命令")
    print("@CRP_REPAIR_JSON=" + json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("REPAIR_ERROR=" + str(exc), file=sys.stderr)
        sys.exit(1)
