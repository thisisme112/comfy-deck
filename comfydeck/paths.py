"""Locate ComfyUI installations and matching Python interpreters.

This module deliberately depends only on the standard library (psutil is
optional) so :mod:`comfydeck.config` can import it while it is still being
loaded.
"""
from __future__ import annotations

import os
import shutil
import sys
import time
from pathlib import Path
from typing import Any, Iterable

# Folder names that never contain a ComfyUI checkout and would only slow a
# deep scan down (or make it recurse into model/output trees).
SKIP_DIRS = {
    "$recycle.bin", "system volume information", "windows", "program files",
    "program files (x86)", "programdata", "appdata", "node_modules", ".git",
    ".svn", ".hg", ".venv", "venv", "env", "__pycache__", "site-packages",
    "models", "output", "input", "custom_nodes", "temp", "tmp", "cache",
    "caches", "logs", "log", "trash", "dist", "build", ".cache",
}

# Common install layouts checked on every drive.  Cheap enough to run on
# every start, including network-free machines with a few drives.
COMMON_LAYOUTS = (
    "ComfyUI",
    "comfyui",
    "ComfyUI_windows_portable/ComfyUI",
    "comfyui_windows_portable/ComfyUI",
    "AI/ComfyUI",
    "AI/ComfyUI_windows_portable/ComfyUI",
    "AI/comfyui/ComfyUI",
    "StableDiffusion/ComfyUI",
    "SD/ComfyUI",
    "Programs/ComfyUI",
    "ComfyUI/ComfyUI",
)

SOURCE_ENV = "环境变量"
SOURCE_RUNNING = "正在运行"
SOURCE_RELATIVE = "当前目录"
SOURCE_COMMON = "常见路径"
SOURCE_DEEP = "深度扫描"
SOURCE_KNOWN = "已保存"

_PRIORITY = {
    SOURCE_ENV: 0,
    SOURCE_RUNNING: 1,
    SOURCE_KNOWN: 2,
    SOURCE_RELATIVE: 3,
    SOURCE_COMMON: 4,
    SOURCE_DEEP: 5,
}


def _norm(path: Path | str) -> str:
    try:
        return os.path.normcase(os.path.abspath(str(path)))
    except (OSError, ValueError):
        return str(path)


def is_comfy_dir(value: Path | str | None) -> bool:
    """True when *value* looks like a ComfyUI checkout."""
    if not value:
        return False
    try:
        path = Path(value).expanduser()
    except (OSError, ValueError):
        return False
    try:
        if not (path / "main.py").is_file():
            return False
    except OSError:
        return False
    for marker in ("folder_paths.py", "nodes.py", "comfy", "comfy_extras"):
        try:
            if (path / marker).exists():
                return True
        except OSError:
            continue
    return False


def python_for(comfy_dir: Path | str | None) -> str:
    """Return the most plausible Python interpreter for an install."""
    if not comfy_dir:
        return ""
    try:
        comfy = Path(comfy_dir).expanduser()
    except (OSError, ValueError):
        return ""
    candidates = [
        comfy.parent / "python_embeded" / "python.exe",
        comfy / "python_embeded" / "python.exe",
        comfy / "python.exe",
        comfy / ".venv" / "Scripts" / "python.exe",
        comfy / "venv" / "Scripts" / "python.exe",
        comfy.parent / ".venv" / "Scripts" / "python.exe",
        comfy.parent / "venv" / "Scripts" / "python.exe",
    ]
    for candidate in candidates:
        try:
            if candidate.is_file():
                return str(candidate.resolve())
        except OSError:
            continue
    return ""


def system_python() -> str:
    """A Python on PATH that is safe to launch (not the Store alias)."""
    for name in ("python.exe", "python3.exe", "python", "python3"):
        found = shutil.which(name)
        if not found:
            continue
        try:
            if os.name == "nt" and Path(found).stat().st_size < 4096:
                # Microsoft Store app execution alias, not a real interpreter.
                continue
        except OSError:
            continue
        return found
    return ""


def find_python(comfy_dir: Path | str | None = None) -> str:
    found = python_for(comfy_dir)
    if found:
        return found
    if not is_frozen():
        exe = Path(sys.executable)
        try:
            if exe.is_file() and exe.name.lower().startswith("python"):
                return str(exe.resolve())
        except OSError:
            pass
    return system_python()


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def _windows_drives() -> list[Path]:
    """Fixed and removable drive roots, skipping network/cd drives."""
    if os.name != "nt":
        return [Path("/")]
    try:
        import ctypes

        mask = ctypes.windll.kernel32.GetLogicalDrives()
        drives: list[Path] = []
        for index in range(26):
            if not mask & (1 << index):
                continue
            root = f"{chr(65 + index)}:\\"
            kind = ctypes.windll.kernel32.GetDriveTypeW(root)
            # 2 = removable, 3 = fixed; skip remote (4) and cdrom (5) so a
            # disconnected network share cannot stall the scan.
            if kind in (2, 3):
                drives.append(Path(root))
        return drives
    except Exception:
        return [Path(f"{chr(65 + i)}:\\") for i in range(26) if Path(f"{chr(65 + i)}:\\").exists()]


def app_dir() -> Path:
    """Directory holding the executable (frozen) or the project root."""
    if is_frozen():
        try:
            return Path(sys.executable).resolve().parent
        except OSError:
            return Path(sys.executable).parent
    return Path(__file__).resolve().parent.parent


def _relative_candidates() -> list[Path]:
    base = app_dir()
    return [
        base.parent / "ComfyUI",
        base / "ComfyUI",
        base.parent / "comfyui",
        base.parent / "ComfyUI_windows_portable" / "ComfyUI",
    ]


def _env_candidates() -> list[Path]:
    out: list[Path] = []
    for key in ("COMFYUI_DIR", "COMFYUI_PATH", "COMFY_DIR"):
        value = os.environ.get(key)
        if value:
            out.append(Path(value))
    return out


def _home_candidates() -> list[Path]:
    home = Path.home()
    return [
        home / "ComfyUI",
        home / "Desktop" / "ComfyUI",
        home / "Downloads" / "ComfyUI",
        home / "Downloads" / "ComfyUI_windows_portable" / "ComfyUI",
        home / "Documents" / "ComfyUI",
    ]


def _from_processes() -> list[Path]:
    """Find a running ComfyUI from its command line (best effort)."""
    try:
        import psutil
    except Exception:
        return []
    found: list[Path] = []
    try:
        iterator = psutil.process_iter(["pid", "cmdline", "cwd"])
    except Exception:
        return []
    for proc in iterator:
        try:
            info = proc.info or {}
            cmdline = info.get("cmdline") or []
            cwd = info.get("cwd") or ""
        except Exception:
            continue
        for arg in cmdline:
            text = str(arg)
            if not text.lower().endswith(("main.py", "main.pyw")):
                continue
            candidate = Path(text)
            if not candidate.is_absolute():
                candidate = Path(cwd) / candidate if cwd else candidate
            parent = candidate.parent
            if is_comfy_dir(parent):
                found.append(parent)
            break
    return found


def _drive_candidates() -> list[Path]:
    out: list[Path] = []
    for drive in _windows_drives():
        for layout in COMMON_LAYOUTS:
            out.append(drive / Path(layout))
    return out


def _deep_scan(deadline: float = 12.0, max_dirs: int = 50000) -> list[Path]:
    """Breadth-first scan of drive roots up to three levels deep."""
    found: list[Path] = []
    seen = 0
    start = time.monotonic()
    queue: list[tuple[Path, int]] = [(drive, 0) for drive in _windows_drives()]
    while queue and time.monotonic() - start < deadline and seen < max_dirs:
        current, depth = queue.pop(0)
        seen += 1
        if is_comfy_dir(current):
            found.append(current)
            continue
        if depth >= 3:
            continue
        try:
            children = list(current.iterdir())
        except (OSError, PermissionError):
            continue
        for child in children:
            try:
                if not child.is_dir() or child.is_symlink():
                    continue
            except OSError:
                continue
            name = child.name.lower()
            if name in SKIP_DIRS or name.startswith("."):
                continue
            queue.append((child, depth + 1))
    return found


def _entry(path: Path, source: str) -> dict[str, Any]:
    resolved = path
    try:
        resolved = path.resolve()
    except OSError:
        pass
    python = find_python(resolved)
    return {
        "comfy_dir": str(resolved),
        "python_exe": python,
        "source": source,
        "valid": True,
        "has_python": bool(python),
        "has_models": (resolved / "models").is_dir(),
        "has_custom_nodes": (resolved / "custom_nodes").is_dir(),
    }


def detect_installations(
    deep: bool = False,
    known: Iterable[str] | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Return deduplicated ComfyUI installs ordered by relevance."""
    buckets: list[tuple[str, list[Path]]] = [
        (SOURCE_ENV, _env_candidates()),
        (SOURCE_RUNNING, _from_processes()),
    ]
    if known:
        buckets.append((SOURCE_KNOWN, [Path(item) for item in known if item]))
    buckets.extend(
        [
            (SOURCE_RELATIVE, _relative_candidates()),
            (SOURCE_COMMON, _home_candidates() + _drive_candidates()),
        ]
    )
    if deep:
        buckets.append((SOURCE_DEEP, _deep_scan()))

    entries: list[dict[str, Any]] = []
    seen: set[str] = set()
    for source, paths in buckets:
        for path in paths:
            try:
                if not is_comfy_dir(path):
                    continue
            except (OSError, ValueError):
                continue
            key = _norm(path)
            if key in seen:
                continue
            seen.add(key)
            entries.append(_entry(path, source))
            if len(entries) >= limit:
                break
        if len(entries) >= limit:
            break

    entries.sort(
        key=lambda item: (
            _PRIORITY.get(item["source"], 9),
            0 if item["has_python"] else 1,
            item["comfy_dir"].lower(),
        )
    )
    return entries
