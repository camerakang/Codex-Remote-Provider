"""Remote Codex conversation provider repair. Runs on the SSH host with Python 3."""
import base64
import json
import os
import pathlib
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
import uuid


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


def snapshot(root):
    path = db_path(root)
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
    try:
        columns = {row[1] for row in con.execute("PRAGMA table_info(threads)")}
        if not {"id", "model_provider", "model"}.issubset(columns):
            raise RuntimeError("threads 表结构不受支持")
        db_counts = {str(provider): count for provider, count in
                     con.execute("SELECT model_provider, count(*) FROM threads GROUP BY model_provider")}
    finally:
        con.close()
    files = {}
    errors = []
    for path in session_files(root):
        try:
            provider = file_provider(path)
            files[str(provider)] = files.get(str(provider), 0) + 1
        except (OSError, ValueError, UnicodeError):
            errors.append(str(path.relative_to(root)))
    return {"database": db_counts, "files": files, "invalidFiles": errors}


def matching_files(root, source):
    return [path for path in session_files(root) if file_provider(path) == source]


def stop_app_server():
    if os.environ.get("CRP_CODEX_HOME"):
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
    backup = root / "provider-sync" / "repair-backups" / (
        time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8])
    backup.mkdir(mode=0o700, parents=True)
    path = db_path(root)
    con = sqlite3.connect(path, timeout=10)
    changed = []
    try:
        saved = sqlite3.connect(backup / path.name)
        try:
            con.backup(saved)
        finally:
            saved.close()
        for file in files:
            destination = backup / file.relative_to(root)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(file, destination)
        (backup / "manifest.json").write_text(json.dumps({
            "source": source, "target": target, "model": model if reset_model else None,
            "resetModel": reset_model, "database": expected["database"],
            "files": [str(file.relative_to(root)) for file in files],
        }, ensure_ascii=False, indent=2), encoding="utf-8")

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


def main():
    root = root_dir()
    mode = sys.argv[1] if len(sys.argv) > 1 else "scan"
    if mode == "scan":
        result = snapshot(root)
    elif mode == "repair":
        options = json.loads(base64.b64decode(sys.argv[2]).decode("utf-8")) if len(sys.argv) > 2 else {}
        result = repair(root, options)
    else:
        raise ValueError("未知命令")
    print("@CRP_REPAIR_JSON=" + json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("REPAIR_ERROR=" + str(exc), file=sys.stderr)
        sys.exit(1)
