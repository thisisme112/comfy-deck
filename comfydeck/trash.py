"""Recycle bin: everything ComfyDeck removes goes here and can be restored."""
from __future__ import annotations

import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from .config import TRASH_DIR
from .util import atomic_write_json, read_json

MANIFEST = TRASH_DIR / "manifest.json"
KINDS = {"model", "node", "workflow", "image"}
_lock = threading.RLock()


def _load() -> list[dict[str, Any]]:
    data = read_json(MANIFEST, [])
    return data if isinstance(data, list) else []


def _save(items: list[dict[str, Any]]) -> None:
    atomic_write_json(MANIFEST, items)


def _size_of(path: Path) -> int:
    try:
        if path.is_file():
            return path.stat().st_size
        return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())
    except OSError:
        return 0


def move(kind: str, src: str | Path, extra: dict[str, Any] | None = None) -> Path:
    """Move ``src`` into the recycle bin and remember where it came from."""
    src = Path(src)
    if not src.exists():
        raise RuntimeError(f"路径不存在：{src}")
    item_id = f"{int(time.time())}-{uuid.uuid4().hex[:6]}"
    dest = TRASH_DIR / kind / item_id / src.name
    dest.parent.mkdir(parents=True, exist_ok=True)
    size = _size_of(src)
    shutil.move(str(src), str(dest))
    entry = {
        "id": item_id,
        "kind": kind,
        "name": src.name,
        "original": str(src),
        "stored": str(dest),
        "size": size,
        "time": time.time(),
        "extra": extra or {},
    }
    with _lock:
        items = _load()
        items.append(entry)
        _save(items)
    return dest


def list_items() -> list[dict[str, Any]]:
    with _lock:
        items = _load()
        alive = [i for i in items if Path(i.get("stored", "")).exists()]
        if len(alive) != len(items):
            _save(alive)
    alive.sort(key=lambda i: -i.get("time", 0))
    return alive


def summary() -> dict[str, Any]:
    items = list_items()
    return {"count": len(items), "size": sum(i.get("size", 0) for i in items)}


def _find(item_id: str) -> dict[str, Any]:
    for item in _load():
        if item.get("id") == item_id:
            return item
    raise RuntimeError("回收站中没有这个项目")


def restore(item_id: str) -> dict[str, Any]:
    with _lock:
        item = _find(item_id)
        stored = Path(item["stored"])
        target = Path(item["original"])
        if not stored.exists():
            raise RuntimeError("回收站中的文件已不存在")
        if target.exists():
            stem, suffix = target.stem, target.suffix
            for idx in range(1, 100):
                cand = target.with_name(f"{stem} (restored {idx}){suffix}")
                if not cand.exists():
                    target = cand
                    break
            else:
                raise RuntimeError("原位置已有同名文件，无法恢复")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(stored), str(target))
        _drop(item_id)
    return {"path": str(target), "kind": item["kind"]}


def _drop(item_id: str) -> None:
    items = [i for i in _load() if i.get("id") != item_id]
    _save(items)
    folder = None
    for kind in KINDS:
        cand = TRASH_DIR / kind / item_id
        if cand.exists():
            folder = cand
    if folder:
        shutil.rmtree(folder, ignore_errors=True)


def purge(item_id: str) -> None:
    with _lock:
        _find(item_id)
        _drop(item_id)


def empty(kind: str = "") -> int:
    with _lock:
        count = 0
        for item in list(_load()):
            if kind and item.get("kind") != kind:
                continue
            _drop(item["id"])
            count += 1
        return count
