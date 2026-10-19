"""ComfyUI core: version detection, release check, update and rollback."""
from __future__ import annotations

import json
import re
import socket
import time
from pathlib import Path
from typing import Any

import requests

from . import gitutil
from .config import DATA_DIR, config
from .db import db
from .jobs import Job
from .launcher import launcher, port_open
from .util import atomic_write_json, read_json, run_command, version_tuple

HISTORY_PATH = DATA_DIR / "core_history.json"


def read_version() -> str:
    file = config.comfy_dir / "comfyui_version.py"
    try:
        text = file.read_text("utf-8", errors="replace")
        match = re.search(r"__version__\s*=\s*['\"]([^'\"]+)", text)
        return match.group(1) if match else ""
    except Exception:
        return ""


def port() -> int:
    return launcher.active_port()


def base_url() -> str:
    return f"http://127.0.0.1:{port()}"


def is_running() -> bool:
    return port_open(port())


def system_stats() -> dict[str, Any]:
    """Launcher state merged with whatever the running ComfyUI reports."""
    out: dict[str, Any] = launcher.status()
    if not out["running"]:
        return out
    try:
        resp = requests.get(f"{base_url()}/system_stats", timeout=2)
        if resp.status_code == 200:
            data = resp.json()
            system = data.get("system") or {}
            devices = data.get("devices") or []
            out["system"] = {
                "os": system.get("os"),
                "python": system.get("python_version") or system.get("python"),
                "comfyui": system.get("comfyui_version"),
                "pytorch": system.get("pytorch_version"),
                "ram_total": system.get("ram_total"),
                "ram_free": system.get("ram_free"),
                "args": system.get("argv"),
            }
            out["devices"] = [
                {
                    "name": d.get("name"),
                    "type": d.get("type"),
                    "vram_total": d.get("vram_total"),
                    "vram_free": d.get("vram_free"),
                    "torch_vram_total": d.get("torch_vram_total"),
                    "torch_vram_free": d.get("torch_vram_free"),
                }
                for d in devices
            ]
    except Exception as exc:
        out["error"] = str(exc)
    try:
        resp = requests.get(f"{base_url()}/queue", timeout=2)
        if resp.status_code == 200:
            data = resp.json()
            out["queue"] = {
                "running": len(data.get("queue_running") or []),
                "pending": len(data.get("queue_pending") or []),
            }
    except Exception:
        pass
    return out


def _post(path: str, payload: dict[str, Any] | None = None) -> None:
    if not is_running():
        raise RuntimeError("ComfyUI 没有运行。")
    try:
        resp = requests.post(f"{base_url()}{path}", json=payload or {}, timeout=10)
    except requests.RequestException as exc:
        raise RuntimeError(f"请求 ComfyUI 失败：{exc}") from exc
    if resp.status_code >= 400:
        raise RuntimeError(f"ComfyUI 返回 HTTP {resp.status_code}")


def free_memory() -> None:
    _post("/free", {"unload_models": True, "free_memory": True})


def interrupt() -> None:
    _post("/interrupt")


def clear_queue() -> None:
    _post("/queue", {"clear": True})


_object_info: dict[str, Any] = {"time": 0.0, "port": 0, "keys": None}


def node_types() -> set[str] | None:
    """Every node class the running ComfyUI knows, or None if it is offline."""
    if not is_running():
        return None
    now = time.time()
    if _object_info["keys"] is not None and _object_info["port"] == port() and now - _object_info["time"] < 90:
        return _object_info["keys"]
    try:
        resp = requests.get(f"{base_url()}/object_info", timeout=30)
        if resp.status_code != 200:
            return None
        keys = set(resp.json().keys())
    except Exception:
        return None
    _object_info.update({"time": now, "port": port(), "keys": keys})
    return keys

def _github_repo() -> str:
    info = gitutil.repo_info(config.comfy_dir)
    remote = info.get("remote") or ""
    match = re.search(r"github\.com[:/]([^/]+/[^/.]+)", remote)
    return match.group(1) if match else "Comfy-Org/ComfyUI"


def _github_headers() -> dict[str, str]:
    headers = {"User-Agent": "ComfyDeck/1.0", "Accept": "application/vnd.github+json"}
    token = (config.get("github_token") or "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def check_latest(force: bool = False) -> dict[str, Any]:
    if not force:
        cached = db.get_json("core:latest", ttl=900)
        if cached:
            return cached
    repo = _github_repo()
    previous = db.get_json("core:latest") or {}
    out: dict[str, Any] = {
        "repo": repo,
        "tag": "",
        "name": "",
        "body": "",
        "published_at": "",
        "url": f"https://github.com/{repo}/releases",
        "source": "",
        "note": "",
        "checked_at": time.time(),
    }
    try:
        resp = requests.get(
            f"https://api.github.com/repos/{repo}/releases/latest",
            headers=_github_headers(),
            proxies=config.proxies(),
            timeout=15,
        )
        if resp.status_code == 200:
            data = resp.json()
            out.update(
                {
                    "tag": data.get("tag_name") or "",
                    "name": data.get("name") or data.get("tag_name") or "",
                    "body": (data.get("body") or "")[:40000],
                    "published_at": data.get("published_at") or "",
                    "url": data.get("html_url") or out["url"],
                    "source": "github",
                }
            )
        elif resp.status_code in (403, 429):
            out["note"] = "GitHub API 已限流，已改用 git 标签检查。"
        else:
            out["note"] = f"GitHub API 返回 HTTP {resp.status_code}，已改用 git 标签检查。"
    except Exception as exc:
        out["note"] = f"GitHub 访问失败，已改用 git 标签检查：{exc}"
    if not out["tag"]:
        tag, _sha = gitutil.latest_tag(config.comfy_dir)
        if tag:
            out["tag"] = tag
            out["name"] = tag
            out["source"] = "git"
    if out["tag"]:
        # GitHub API may be rate-limited; keep release notes we fetched earlier.
        if previous.get("tag") == out["tag"]:
            for key in ("name", "body", "published_at", "url"):
                if not out.get(key) and previous.get(key):
                    out[key] = previous[key]
        db.set_json("core:latest", out)
    return out


_git_cache: dict[str, Any] = {"time": 0.0, "path": "", "info": None}


def _repo_info_cached(path: Path) -> dict[str, Any]:
    now = time.time()
    if _git_cache["info"] is None or _git_cache["path"] != str(path) or now - _git_cache["time"] > 20:
        _git_cache.update({"time": now, "path": str(path), "info": gitutil.repo_info(path)})
    return _git_cache["info"]


def core_info() -> dict[str, Any]:
    path = config.comfy_dir
    exists = (path / "main.py").exists()
    info: dict[str, Any] = {
        "path": str(path),
        "exists": exists,
        "version": read_version(),
        "running": is_running(),
        "service": system_stats() if exists else {"running": False},
        "python": config.python_exe,
        "history": core_history(),
    }
    if exists:
        git_info = _repo_info_cached(path)
        info["git"] = git_info
        latest = db.get_json("core:latest", ttl=86400) or {}
        current_tag = git_info.get("tag") or ("v" + info["version"] if info["version"] else "")
        latest_tag = latest.get("tag") or ""
        info["latest"] = latest
        info["current_ref"] = current_tag
        info["update_available"] = bool(
            latest_tag and version_tuple(latest_tag) > version_tuple(current_tag)
        )
    else:
        info["git"] = {"git": False}
        info["latest"] = {}
        info["update_available"] = False
    return info


def core_history() -> list[dict[str, Any]]:
    data = read_json(HISTORY_PATH, [])
    return data[-30:][::-1] if isinstance(data, list) else []


def _record_history(entry: dict[str, Any]) -> None:
    _git_cache["info"] = None
    data = read_json(HISTORY_PATH, [])
    if not isinstance(data, list):
        data = []
    data.append(entry)
    atomic_write_json(HISTORY_PATH, data[-100:])


def _pip_install(job: Job, req_file: Path, label: str = "依赖") -> None:
    if not req_file.exists():
        return
    job.log(f"安装 {label}: {req_file.name}")
    code, out = run_command(
        [config.python_exe, "-m", "pip", "install", "-r", str(req_file)],
        cwd=config.comfy_dir,
        timeout=1800,
    )
    for line in out.splitlines()[-200:]:
        job.log("  " + line)
    if code != 0:
        raise RuntimeError(f"{label}安装失败，请查看日志（退出码 {code}）")


def update_core(
    job: Job,
    target: str = "latest",
    force: bool = False,
    install_requirements: bool = True,
) -> dict[str, Any]:
    path = config.comfy_dir
    if not (path / "main.py").exists():
        raise RuntimeError(f"找不到 ComfyUI：{path}")
    if not gitutil.is_repo(path):
        raise RuntimeError("ComfyUI 目录不是 git 仓库，无法自动更新。")
    if is_running() and not force:
        raise RuntimeError("ComfyUI 正在运行。请先关闭 ComfyUI，或勾选“强制更新”。")

    info = gitutil.repo_info(path)
    if info.get("dirty"):
        if not force:
            raise RuntimeError(
                f"ComfyUI 仓库有 {info.get('dirty_count', 0)} 个本地修改，已停止更新。"
                "请先提交/还原，或勾选“强制更新”（会自动 stash）。"
            )
        job.log("检测到本地修改，执行 git stash…")
        code, out = gitutil.git(path, ["stash", "push", "-u", "-m", "ComfyDeck auto-stash"], timeout=120)
        job.log(out.strip())
        if code != 0:
            raise RuntimeError("无法暂存本地修改，更新中止。")

    job.set_progress(8, "拉取 tags…")
    job.log("git fetch --tags")
    code, out = gitutil.git(path, ["fetch", "--tags", "--prune", "origin"], timeout=300)
    if out.strip():
        job.log(out.strip()[-4000:])
    if code != 0:
        job.log("fetch 失败，继续使用本地已有标签。")

    latest = check_latest(force=True)
    if target in ("", "latest"):
        target = latest.get("tag") or ""
    if not target:
        raise RuntimeError("无法确定目标版本（GitHub 和 git 标签都没有返回结果）。")
    if not re.match(r"^[vV]?\d", target):
        raise RuntimeError(f"不支持的版本标签：{target}")

    current = info.get("tag") or info.get("short") or ""
    if version_tuple(target) == version_tuple(info.get("tag") or ""):
        job.log(f"已经是最新版本 {target}")
        return {"from": current, "to": target, "changed": False}

    job.set_progress(25, f"切换到 {target}…")
    job.log(f"git checkout {target}")
    code, out = gitutil.git(path, ["checkout", target], timeout=300)
    job.log(out.strip()[-4000:])
    if code != 0:
        raise RuntimeError(f"切换到 {target} 失败，请查看日志。")

    if install_requirements:
        job.set_progress(55, "安装核心依赖…")
        _pip_install(job, path / "requirements.txt", "ComfyUI 核心依赖")
        if (path / "manager_requirements.txt").exists():
            _pip_install(job, path / "manager_requirements.txt", "Manager 依赖")

    new_info = gitutil.repo_info(path)
    entry = {
        "time": time.strftime("%Y-%m-%d %H:%M:%S"),
        "from": current,
        "to": target,
        "tag": target,
        "commit": new_info.get("head", ""),
    }
    _record_history(entry)
    job.set_progress(100, "更新完成")
    return {"from": current, "to": target, "changed": True, "commit": new_info.get("head", "")}


def rollback_core(job: Job, ref: str, install_requirements: bool = True) -> dict[str, Any]:
    path = config.comfy_dir
    if is_running():
        raise RuntimeError("ComfyUI 正在运行。请先关闭 ComfyUI 再回滚。")
    if not ref or not re.match(r"^[\w.\-/]+$", ref):
        raise RuntimeError("无效的版本引用。")
    before = gitutil.repo_info(path).get("tag") or ""
    job.set_progress(20, f"切换到 {ref}…")
    code, out = gitutil.git(path, ["checkout", ref], timeout=300)
    job.log(out.strip()[-4000:])
    if code != 0:
        raise RuntimeError(f"回滚到 {ref} 失败。")
    if install_requirements:
        _pip_install(job, path / "requirements.txt", "ComfyUI 核心依赖")
    _record_history(
        {
            "time": time.strftime("%Y-%m-%d %H:%M:%S"),
            "from": before,
            "to": ref,
            "rollback": True,
        }
    )
    return {"from": before, "to": ref}
