"""ComfyDeck configuration.

All state lives next to the app in ./data so the folder is fully portable.
"""
from __future__ import annotations

import json
import os
import sys
import threading
from pathlib import Path
from typing import Any

from . import paths as pathutil

FROZEN = pathutil.is_frozen()

# Directory containing bundled resources (web assets, Python bytecode).
RESOURCE_DIR = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))

# Directory of the executable in a frozen build, or the project root from
# source.  A portable build keeps its data next to the executable; an
# installation under Program Files falls back to %LOCALAPPDATA%.
BASE_DIR = pathutil.app_dir()


def _pick_data_dir() -> Path:
    override = os.environ.get("COMFYDECK_DATA_DIR")
    if override:
        target = Path(override).expanduser()
        target.mkdir(parents=True, exist_ok=True)
        return target
    candidate = BASE_DIR / "data"
    try:
        candidate.mkdir(parents=True, exist_ok=True)
        probe = candidate / ".write-test"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        return candidate
    except OSError:
        fallback = Path(os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local")) / "ComfyDeck" / "data"
        fallback.mkdir(parents=True, exist_ok=True)
        return fallback


DATA_DIR = _pick_data_dir()
PREVIEW_DIR = DATA_DIR / "previews"
LOG_DIR = DATA_DIR / "logs"
TRASH_DIR = DATA_DIR / "trash"
THUMB_DIR = DATA_DIR / "thumbs"
WEB_DIR = RESOURCE_DIR / "web"
DB_PATH = DATA_DIR / "comfydeck.db"
CONFIG_PATH = DATA_DIR / "config.json"


for _p in (DATA_DIR, PREVIEW_DIR, LOG_DIR, TRASH_DIR, THUMB_DIR):
    _p.mkdir(parents=True, exist_ok=True)

DEFAULTS: dict[str, Any] = {
    "comfy_dir": "",
    "python_exe": "",
    "extra_model_paths": [],
    "gallery_extra_dirs": [],
    "civitai_api_key": "",
    "github_token": "",
    "hf_token": "",
    "proxy": "",
    "nsfw": False,
    "max_downloads": 2,
    "hash_workers": 1,
    "host": "127.0.0.1",
    "port": 8288,
    "open_browser": True,
    "comfy_port": 8188,
    "auto_start_comfy": False,
    "theme": "auto",
}


def _detect_comfy() -> str:
    """Find a ComfyUI install using the shared detection module."""
    known = [str(DEFAULTS.get("comfy_dir") or "")]
    for item in pathutil.detect_installations(deep=False, known=known):
        if item.get("comfy_dir"):
            return str(item["comfy_dir"])
    return ""


def _detect_python(comfy_dir: str | None = None) -> str:
    found = pathutil.find_python(comfy_dir)
    if found:
        return found
    if not FROZEN:
        return str(Path(sys.executable).resolve())
    return ""


def _usable_python(value: str | None) -> bool:
    if not value:
        return False
    try:
        path = Path(value).expanduser()
    except (OSError, ValueError):
        return False
    if not path.is_file():
        return False
    # A frozen build's own executable is not a Python interpreter.
    if FROZEN:
        try:
            if path.resolve() == Path(sys.executable).resolve():
                return False
        except OSError:
            pass
    return True



class Config:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._data: dict[str, Any] = dict(DEFAULTS)
        self.load()

    def load(self) -> None:
        with self._lock:
            if CONFIG_PATH.exists():
                try:
                    raw = json.loads(CONFIG_PATH.read_text("utf-8"))
                    if isinstance(raw, dict):
                        for key, val in raw.items():
                            if key in DEFAULTS:
                                self._data[key] = val
                except Exception:
                    pass
            if not self._data.get("comfy_dir"):
                self._data["comfy_dir"] = _detect_comfy()
            if not _usable_python(self._data.get("python_exe")):
                self._data["python_exe"] = _detect_python(self._data.get("comfy_dir"))
            self._save_locked()

    def _save_locked(self) -> None:
        tmp = CONFIG_PATH.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(self._data, ensure_ascii=False, indent=2), "utf-8")
        tmp.replace(CONFIG_PATH)

    def save(self) -> None:
        with self._lock:
            self._save_locked()

    def get(self, key: str, default: Any = None) -> Any:
        with self._lock:
            return self._data.get(key, DEFAULTS.get(key, default))

    def update(self, patch: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            for key, val in patch.items():
                if key in DEFAULTS:
                    if key in ("nsfw", "auto_start_comfy", "open_browser"):
                        val = bool(val)
                    elif key in ("port", "comfy_port", "max_downloads", "hash_workers"):
                        try:
                            val = int(val)
                        except (TypeError, ValueError):
                            continue
                    elif key == "theme":
                        val = val if val in ("auto", "dark", "light") else "auto"
                    elif key == "gallery_extra_dirs":
                        if not isinstance(val, list):
                            continue
                        val = [str(v).strip() for v in val if str(v).strip()]
                    elif key == "extra_model_paths":
                        if not isinstance(val, list):
                            continue
                        cleaned = []
                        for item in val:
                            if isinstance(item, str) and item.strip():
                                cleaned.append(item.strip())
                            elif isinstance(item, dict) and item.get("path"):
                                cleaned.append(
                                    {
                                        "path": str(item["path"]).strip(),
                                        "type": str(item.get("type", "")).strip(),
                                    }
                                )
                        val = cleaned
                    self._data[key] = val
            self._save_locked()
            return dict(self._data)

    def public(self) -> dict[str, Any]:
        with self._lock:
            data = dict(self._data)
            for key in ("civitai_api_key", "github_token", "hf_token"):
                val = data.get(key) or ""
                data[key + "_set"] = bool(val)
                data[key] = ("•" * 8 + val[-4:]) if len(val) > 8 else ("•" * 8 if val else "")
            return data

    @property
    def comfy_dir(self) -> Path:
        return Path(self.get("comfy_dir") or ".")

    @property
    def custom_nodes(self) -> Path:
        return self.comfy_dir / "custom_nodes"

    @property
    def models_dir(self) -> Path:
        return self.comfy_dir / "models"

    @property
    def python_exe(self) -> str:
        return str(self.get("python_exe") or sys.executable)

    @property
    def proxy(self) -> str | None:
        return (self.get("proxy") or "").strip() or None

    def proxies(self) -> dict[str, str] | None:
        proxy = self.proxy
        if not proxy:
            return None
        return {"http": proxy, "https": proxy}


config = Config()
