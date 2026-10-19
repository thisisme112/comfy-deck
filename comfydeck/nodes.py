"""Custom node (plugin) inventory, update checks, install and enable/disable."""
from __future__ import annotations

import shutil
import threading
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse

import requests

from . import gitutil, trash
from .config import DATA_DIR, config
from .db import db
from .jobs import Job
from .util import (
    atomic_write_json,
    is_subpath,
    read_json,
    read_pyproject,
    run_command,
    safe_filename,
    version_tuple,
)

CACHE_PATH = DATA_DIR / "nodes_cache.json"
REGISTRY = "https://api.comfy.org"
ALLOWED_HOSTS = {
    "github.com", "gitlab.com", "gitee.com", "gitcode.com", "bitbucket.org",
    "huggingface.co", "comfy.org", "registry.comfy.org",
}
_lock = threading.RLock()


def _read_cache() -> dict[str, Any]:
    data = read_json(CACHE_PATH, {})
    return data if isinstance(data, dict) else {}


def _write_cache(data: dict[str, Any]) -> None:
    atomic_write_json(CACHE_PATH, data)


def _node_id_from_name(name: str) -> str:
    return name.split("@", 1)[0]


def _local_version(path: Path, git_info: dict[str, Any], project: dict[str, Any], dir_name: str) -> str:
    if project.get("version"):
        return project["version"]
    if git_info.get("tag"):
        return git_info["tag"]
    if git_info.get("short"):
        return git_info["short"]
    if "@" in dir_name:
        return dir_name.rsplit("@", 1)[-1].replace("_", ".")
    return ""


_scan_cache: dict[str, Any] = {"time": 0.0, "items": None, "dir": ""}


def invalidate() -> None:
    _scan_cache["items"] = None


def _invalidates(fn):
    import functools

    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        finally:
            invalidate()

    return wrapper


def scan_nodes() -> list[dict[str, Any]]:
    """Scanning runs git for every plugin, so reuse the result for a short while."""
    now = time.time()
    c = _scan_cache
    if c["items"] is None or now - c["time"] > 20 or c["dir"] != str(config.custom_nodes):
        c["items"] = _scan_nodes_uncached()
        c["time"] = now
        c["dir"] = str(config.custom_nodes)
    return [dict(n) for n in c["items"]]


def _scan_nodes_uncached() -> list[dict[str, Any]]:
    root = config.custom_nodes
    root.mkdir(parents=True, exist_ok=True)
    cache = _read_cache().get("nodes", {})
    nodes: list[dict[str, Any]] = []

    def add(path: Path, enabled: bool) -> None:
        dir_name = path.name
        if not path.is_dir() or dir_name == "__pycache__" or dir_name.startswith("."):
            if not (path.is_dir() and "@" in dir_name):
                return
        project = read_pyproject(path)
        git_info = gitutil.repo_info(path) if gitutil.is_repo(path) else {"git": False}
        tracking = (path / ".tracking").exists()
        if git_info.get("git"):
            kind = "git"
        elif tracking:
            kind = "cnr"
        else:
            kind = "folder"
        display = project.get("display_name") or dir_name
        if not enabled:
            display = _node_id_from_name(display)
            dir_name_display = _node_id_from_name(dir_name)
        else:
            dir_name_display = dir_name
        node = {
            "dir_name": dir_name,
            "name": display,
            "enabled": enabled,
            "kind": kind,
            "path": str(path),
            "version": _local_version(path, git_info, project, dir_name),
            "project": project,
            "git": git_info,
            "remote": gitutil.sanitize_remote(git_info.get("remote", "")),
            "requirements": (path / "requirements.txt").exists(),
            "install_py": (path / "install.py").exists(),
            "update": cache.get(dir_name),
        }
        nodes.append(node)

    for entry in root.iterdir():
        if entry.is_dir() and entry.name not in ("__pycache__",):
            if entry.name == ".disabled":
                for sub in entry.iterdir():
                    if sub.is_dir():
                        add(sub, False)
            elif not entry.name.startswith("."):
                add(entry, True)
    nodes.sort(key=lambda n: (not n["enabled"], n["name"].lower()))
    return nodes


def _find_node(dir_name: str) -> dict[str, Any]:
    for node in scan_nodes():
        if node["dir_name"] == dir_name:
            return node
    raise RuntimeError(f"插件不存在：{dir_name}")


def _registry_info(node_id: str) -> dict[str, Any] | None:
    key = f"registry:node:{node_id}"
    cached = db.get_json(key, ttl=3600)
    if cached:
        return cached
    try:
        resp = requests.get(
            f"{REGISTRY}/nodes/{quote(node_id)}",
            headers={"User-Agent": "ComfyDeck/1.0"},
            proxies=config.proxies(),
            timeout=15,
        )
        if resp.status_code != 200:
            return None
        data = resp.json()
        db.set_json(key, data)
        return data
    except Exception:
        return None


def check_node(node: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {
        "checked_at": time.time(),
        "behind": 0,
        "ahead": 0,
        "latest_version": "",
        "latest_sha": "",
        "latest_subject": "",
        "latest_date": "",
        "error": "",
    }
    if not node["enabled"]:
        result["error"] = "插件已禁用"
        return result
    if node["kind"] == "git":
        path = Path(node["path"])
        ok, out = gitutil.fetch(path, timeout=180)
        if not ok:
            result["error"] = (out or "git fetch 失败")[-400:]
            return result
        ref = gitutil.upstream_ref(path)
        if not ref:
            result["error"] = "没有配置上游分支"
            return result
        ahead, behind = gitutil.ahead_behind(path, ref)
        result["behind"] = behind
        result["ahead"] = ahead
        remote = gitutil.remote_commit(path, ref)
        result["latest_sha"] = remote.get("sha", "")
        result["latest_subject"] = remote.get("subject", "")
        result["latest_date"] = remote.get("date", "")
        return result
    if node["kind"] == "cnr":
        node_id = (node.get("project") or {}).get("name") or _node_id_from_name(node["dir_name"])
        data = _registry_info(node_id)
        if not data:
            result["error"] = "Comfy Registry 中没有找到该节点"
            return result
        latest = (data.get("latest_version") or {}).get("version") or ""
        result["latest_version"] = latest
        local = node.get("version") or ""
        if latest and version_tuple(latest) > version_tuple(local):
            result["behind"] = 1
        if latest and local and version_tuple(latest) < version_tuple(local):
            result["ahead"] = 1
        result["latest_subject"] = (data.get("description") or "")[:200]
        return result
    result["error"] = "不是 git 仓库，无法检查更新"
    return result


@_invalidates
def check_all(job: Job, names: list[str] | None = None) -> dict[str, Any]:
    nodes = [n for n in scan_nodes() if n["enabled"]]
    if names:
        wanted = set(names)
        nodes = [n for n in nodes if n["dir_name"] in wanted]
    job.log(f"检查 {len(nodes)} 个插件…")
    results: dict[str, Any] = {}
    done = 0
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(check_node, n): n for n in nodes}
        for fut in as_completed(futures):
            node = futures[fut]
            job.raise_if_cancelled()
            try:
                result = fut.result()
            except Exception as exc:  # noqa: BLE001
                result = {"checked_at": time.time(), "behind": 0, "error": str(exc)}
            results[node["dir_name"]] = result
            done += 1
            label = f"{node['name']}: "
            if result.get("error"):
                label += result["error"][:120]
            elif result.get("behind"):
                label += f"有 {result['behind']} 个新提交"
            else:
                label += "已是最新"
            job.log(label)
            job.set_progress(done / max(1, len(nodes)) * 100, f"检查插件 {done}/{len(nodes)}")
    cache = _read_cache()
    cache["checked_at"] = time.time()
    cache_nodes = cache.get("nodes", {})
    cache_nodes.update(results)
    cache["nodes"] = cache_nodes
    _write_cache(cache)
    updates = sum(1 for r in results.values() if r.get("behind"))
    return {"checked": len(results), "updates": updates}


def _pip_requirements(job: Job, node_dir: Path) -> None:
    req = node_dir / "requirements.txt"
    if not req.exists():
        return
    job.log(f"安装依赖：{req.name}")
    code, out = run_command(
        [config.python_exe, "-m", "pip", "install", "-r", str(req)],
        cwd=node_dir,
        timeout=1800,
    )
    for line in out.splitlines()[-120:]:
        job.log("  " + line)
    if code != 0:
        raise RuntimeError("依赖安装失败，请查看日志（可稍后手动运行 pip）。")


def _run_install_py(job: Job, node_dir: Path) -> None:
    script = node_dir / "install.py"
    if not script.exists():
        return
    job.log("运行 install.py…")
    code, out = run_command(
        [config.python_exe, "install.py"], cwd=node_dir, timeout=1800
    )
    for line in out.splitlines()[-160:]:
        job.log("  " + line)
    if code != 0:
        raise RuntimeError("install.py 执行失败，请查看日志。")


def _trash_dir(prefix: str, path: Path) -> Path:
    return trash.move("node", path, {"reason": prefix})


def _update_git(job: Job, node: dict[str, Any], run_install: bool) -> dict[str, Any]:
    path = Path(node["path"])
    info = gitutil.repo_info(path)
    if info.get("dirty"):
        raise RuntimeError(
            f"{node['name']} 有本地修改（{info.get('dirty_count', 0)} 个文件），已跳过。"
        )
    ok, out = gitutil.fetch(path, timeout=180)
    job.log(out[-4000:])
    if not ok:
        raise RuntimeError("git fetch 失败")
    ref = gitutil.upstream_ref(path)
    ahead, behind = gitutil.ahead_behind(path, ref)
    if behind == 0:
        job.log(f"{node['name']} 已是最新")
        return {"updated": False, "version": node.get("version", "")}
    job.log(f"拉取 {behind} 个提交…")
    ok, out = gitutil.pull_ff(path)
    job.log(out[-6000:])
    if not ok:
        raise RuntimeError("git pull 失败（可能有冲突或历史分叉），请手动处理。")
    _pip_requirements(job, path)
    if run_install:
        _run_install_py(job, path)
    fresh = gitutil.repo_info(path)
    return {
        "updated": True,
        "version": fresh.get("tag") or fresh.get("short") or "",
        "commit": fresh.get("head", ""),
        "behind": behind,
    }


def _update_cnr(job: Job, node: dict[str, Any], run_install: bool) -> dict[str, Any]:
    node_id = (node.get("project") or {}).get("name") or _node_id_from_name(node["dir_name"])
    data = _registry_info(node_id)
    if not data:
        raise RuntimeError("Comfy Registry 中没有找到该节点，无法自动更新。")
    latest = data.get("latest_version") or {}
    latest_version = latest.get("version", "")
    if not latest_version:
        raise RuntimeError("该节点没有可用版本。")
    if version_tuple(latest_version) <= version_tuple(node.get("version", "")):
        job.log(f"{node['name']} 已是最新（{node.get('version')}）")
        return {"updated": False, "version": node.get("version", "")}
    url = latest.get("downloadUrl") or ""
    if not url:
        raise RuntimeError("Registry 没有返回下载地址。")
    job.log(f"下载 {node['name']} {latest_version}…")
    tmp_zip = DATA_DIR / f"cnr-{safe_filename(node_id)}-{int(time.time())}.zip"
    tmp_dir = DATA_DIR / f"cnr-{safe_filename(node_id)}-{int(time.time())}"
    try:
        resp = requests.get(
            url, headers={"User-Agent": "ComfyDeck/1.0"}, proxies=config.proxies(), timeout=300
        )
        if resp.status_code != 200:
            raise RuntimeError(f"下载失败（HTTP {resp.status_code}）")
        tmp_zip.write_bytes(resp.content)
        tmp_dir.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(tmp_zip) as zf:
            for info in zf.infolist():
                target = tmp_dir / info.filename
                if not is_subpath(target, tmp_dir):
                    raise RuntimeError("压缩包包含不安全的路径，已中止。")
            zf.extractall(tmp_dir)
        dest = Path(node["path"])
        old = _trash_dir("node-old", dest)
        try:
            shutil.move(str(tmp_dir), str(dest))
        except Exception:
            shutil.move(str(old), str(dest))
            raise
        _pip_requirements(job, dest)
        if run_install:
            _run_install_py(job, dest)
        return {"updated": True, "version": latest_version, "commit": ""}
    finally:
        for p in (tmp_zip, tmp_dir):
            try:
                if p.is_file():
                    p.unlink()
                elif p.is_dir():
                    shutil.rmtree(p)
            except Exception:
                pass


@_invalidates
def update_node(job: Job, dir_name: str, run_install: bool = False) -> dict[str, Any]:
    node = _find_node(dir_name)
    job.log(
        f"更新 {node['name']}（{node['kind']}，当前 {node.get('version') or '未知'}）"
    )
    if node["kind"] == "git":
        result = _update_git(job, node, run_install)
    elif node["kind"] == "cnr":
        result = _update_cnr(job, node, run_install)
    else:
        raise RuntimeError("该插件不是 git/CNR 安装，无法自动更新。")
    # Refresh cached check result.
    cache = _read_cache()
    cache_nodes = cache.get("nodes", {})
    cache_nodes[dir_name] = {
        "checked_at": time.time(),
        "behind": 0,
        "error": "",
        "latest_subject": "刚刚更新",
    }
    cache["nodes"] = cache_nodes
    cache["checked_at"] = time.time()
    _write_cache(cache)
    return {"node": dir_name, **result}


@_invalidates
def update_all(job: Job, names: list[str] | None = None, run_install: bool = False) -> dict[str, Any]:
    nodes = scan_nodes()
    cache = _read_cache().get("nodes", {})
    if names:
        wanted = set(names)
        targets = [n for n in nodes if n["dir_name"] in wanted and n["enabled"]]
    else:
        targets = [
            n for n in nodes
            if n["enabled"] and (cache.get(n["dir_name"]) or {}).get("behind", 0) > 0
        ]
    if not targets:
        job.log("没有可更新的插件。请先检查更新。")
        return {"updated": 0, "failed": [], "total": 0}
    job.log(f"准备更新 {len(targets)} 个插件")
    updated = 0
    failed: list[dict[str, str]] = []
    for idx, node in enumerate(targets, 1):
        job.raise_if_cancelled()
        job.set_progress((idx - 1) / len(targets) * 100, f"更新 {node['name']} ({idx}/{len(targets)})")
        try:
            res = update_node(job, node["dir_name"], run_install=run_install)
            if res.get("updated"):
                updated += 1
        except Exception as exc:  # noqa: BLE001
            failed.append({"name": node["name"], "error": str(exc)})
            job.log(f"✗ {node['name']}: {exc}")
    job.set_progress(100, "批量更新完成")
    return {"updated": updated, "failed": failed, "total": len(targets)}


@_invalidates
def toggle_node(dir_name: str) -> dict[str, Any]:
    node = _find_node(dir_name)
    path = Path(node["path"])
    if not is_subpath(path, config.custom_nodes):
        raise RuntimeError("插件路径不在 custom_nodes 内。")
    disabled_root = config.custom_nodes / ".disabled"
    disabled_root.mkdir(parents=True, exist_ok=True)
    if node["enabled"]:
        target = disabled_root / dir_name
        if target.exists():
            target = disabled_root / f"{dir_name}@{time.strftime('%Y%m%d_%H%M%S')}"
        shutil.move(str(path), str(target))
        return {"enabled": False, "path": str(target)}
    target_name = _node_id_from_name(dir_name)
    target = config.custom_nodes / target_name
    if target.exists():
        raise RuntimeError(f"无法启用：custom_nodes/{target_name} 已存在。")
    shutil.move(str(path), str(target))
    return {"enabled": True, "path": str(target), "dir_name": target_name}


@_invalidates
def install_node(job: Job, url: str, run_install: bool = False, name: str = "") -> dict[str, Any]:
    url = (url or "").strip()
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise RuntimeError("请输入 http(s) 的 Git 仓库地址。")
    host = (parsed.hostname or "").lower()
    if host not in ALLOWED_HOSTS and not any(host.endswith("." + h) for h in ALLOWED_HOSTS):
        raise RuntimeError(f"暂不支持从 {host} 安装。")
    folder = name.strip() or Path(parsed.path.rstrip("/")).name
    if folder.endswith(".git"):
        folder = folder[:-4]
    folder = safe_filename(folder, "custom-node")
    dest = config.custom_nodes / folder
    if dest.exists():
        raise RuntimeError(f"目录已存在：{dest.name}")
    job.set_progress(10, "克隆仓库…")
    job.log(f"git clone {url}")
    ok, out = gitutil.clone(url, dest, timeout=1200)
    for line in out.splitlines()[-80:]:
        job.log("  " + line)
    if not ok:
        raise RuntimeError("git clone 失败，请检查地址或网络。")
    _pip_requirements(job, dest)
    if run_install:
        _run_install_py(job, dest)
    info = gitutil.repo_info(dest)
    return {"dir_name": folder, "commit": info.get("head", ""), "version": info.get("tag", "")}


@_invalidates
def remove_node(dir_name: str) -> dict[str, Any]:
    node = _find_node(dir_name)
    path = Path(node["path"])
    if not is_subpath(path, config.custom_nodes):
        raise RuntimeError("插件路径不在 custom_nodes 内。")
    dest = _trash_dir("node", path)
    db.delete_kv("")
    return {"removed": True, "trash": str(dest)}
