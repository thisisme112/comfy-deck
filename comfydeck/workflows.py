"""Workflow library: browse ComfyUI's saved workflows, inspect and organise them."""
from __future__ import annotations

import json
import os
import re
import shutil
import threading
import time
from pathlib import Path
from typing import Any

from . import comfy, models, trash
from .config import config
from .db import db
from .util import is_subpath, safe_filename

MODEL_EXTS = (".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf", ".onnx", ".sft")
VIRTUAL_NODES = {
    "Note", "MarkdownNote", "Reroute", "PrimitiveNode", "GetNode", "SetNode",
    "Label (rgthree)", "Fast Groups Muter (rgthree)", "Fast Groups Bypasser (rgthree)",
}
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
MAX_BYTES = 40 * 1024 * 1024

LOADER_HINTS = [
    ("checkpoint", "checkpoints"), ("lora", "loras"), ("vae", "vae"), ("controlnet", "controlnet"),
    ("upscale", "upscale_models"), ("clipvision", "clip_vision"), ("clip_vision", "clip_vision"),
    ("unet", "diffusion_models"), ("diffusion", "diffusion_models"), ("clip", "text_encoders"),
    ("style", "style_models"), ("ipadapter", "ipadapter"), ("sam", "sams"),
]


# ----------------------------------------------------------------------- roots
def _users_dir() -> Path:
    return config.comfy_dir / "user"


def roots() -> list[tuple[str, Path]]:
    base = _users_dir()
    out: list[tuple[str, Path]] = []
    default = base / "default" / "workflows"
    if base.is_dir():
        default.mkdir(parents=True, exist_ok=True)
        for user in sorted(p for p in base.iterdir() if p.is_dir() and not p.name.startswith(("__", "."))):
            wf = user / "workflows"
            if wf.is_dir():
                out.append((user.name, wf))
    return out


def _key(user: str, rel: str) -> str:
    return f"{user}/{rel}".replace("\\", "/")


def resolve(key: str) -> Path:
    user, _, rel = (key or "").partition("/")
    if not rel or not rel.lower().endswith(".json"):
        raise RuntimeError("无效的工作流路径。")
    for name, root in roots():
        if name == user:
            path = (root / rel).resolve()
            if not is_subpath(path, root):
                raise RuntimeError("工作流路径越界。")
            if not path.is_file():
                raise RuntimeError("工作流文件不存在。")
            return path
    raise RuntimeError("找不到该用户的工作流目录。")


def _root_of(key: str) -> Path:
    user = key.partition("/")[0]
    for name, root in roots():
        if name == user:
            return root
    raise RuntimeError("找不到工作流目录。")


# -------------------------------------------------------------------- analysis
def _guess_type(node_type: str) -> str:
    low = (node_type or "").lower()
    for hint, folder in LOADER_HINTS:
        if hint in low:
            return folder
    return ""


def _collect_models(value: Any, out: list[str], depth: int = 0) -> None:
    if depth > 4:
        return
    if isinstance(value, str):
        if value.lower().endswith(MODEL_EXTS) and len(value) < 300:
            out.append(value)
    elif isinstance(value, list):
        for v in value[:60]:
            _collect_models(v, out, depth + 1)
    elif isinstance(value, dict):
        for v in list(value.values())[:60]:
            _collect_models(v, out, depth + 1)


def analyze(data: Any) -> dict[str, Any]:
    result: dict[str, Any] = {
        "format": "unknown", "node_count": 0, "link_count": 0,
        "node_types": {}, "models": [], "packages": {},
    }
    nodes: list[dict[str, Any]] = []
    subgraph_ids: set[str] = set()
    if isinstance(data, dict) and isinstance(data.get("nodes"), list):
        result["format"] = "graph"
        nodes = [n for n in data["nodes"] if isinstance(n, dict)]
        result["link_count"] = len(data.get("links") or [])
        for sg in ((data.get("definitions") or {}).get("subgraphs") or []):
            if isinstance(sg, dict):
                if sg.get("id"):
                    subgraph_ids.add(str(sg["id"]))
                nodes.extend(n for n in (sg.get("nodes") or []) if isinstance(n, dict))
    elif isinstance(data, dict) and data and all(isinstance(v, dict) and "class_type" in v for v in data.values()):
        result["format"] = "api"
        for nid, node in data.items():
            result["link_count"] += sum(1 for v in (node.get("inputs") or {}).values() if isinstance(v, list))
            nodes.append({"id": nid, "type": node["class_type"], "inputs_api": node.get("inputs") or {}})
    else:
        return result

    result["node_count"] = len(nodes)
    types: dict[str, int] = {}
    seen_models: dict[tuple[str, str], dict[str, Any]] = {}
    packages: dict[str, int] = {}
    for node in nodes:
        ntype = str(node.get("type") or "")
        if not ntype or ntype in subgraph_ids or UUID.match(ntype):
            continue
        types[ntype] = types.get(ntype, 0) + 1
        props = node.get("properties") or {}
        pkg = props.get("cnr_id") or props.get("aux_id") or ""
        if pkg and pkg != "comfy-core":
            packages[str(pkg)] = packages.get(str(pkg), 0) + 1
        found: list[str] = []
        if "inputs_api" in node:
            _collect_models(list(node["inputs_api"].values()), found)
        else:
            _collect_models(node.get("widgets_values"), found)
            if not found:
                for slot in node.get("inputs") or []:
                    if isinstance(slot, dict):
                        _collect_models(slot.get("value"), found)
        inactive = node.get("mode") in (2, 4)
        for name in found:
            k = (name.replace("\\", "/").lower(), ntype)
            if k not in seen_models:
                seen_models[k] = {
                    "name": name.replace("\\", "/"),
                    "node": ntype,
                    "type": _guess_type(ntype),
                    "inactive": inactive,
                }
            elif not inactive:
                seen_models[k]["inactive"] = False
    result["node_types"] = dict(sorted(types.items(), key=lambda kv: -kv[1]))
    result["models"] = list(seen_models.values())
    result["packages"] = packages
    return result


# ----------------------------------------------------------------------- cache
_parse_cache: dict[str, tuple[float, int, dict[str, Any]]] = {}
_parse_lock = threading.Lock()


def _info_for(path: Path) -> dict[str, Any]:
    st = path.stat()
    k = str(path)
    with _parse_lock:
        hit = _parse_cache.get(k)
        if hit and hit[0] == st.st_mtime and hit[1] == st.st_size:
            return hit[2]
    info: dict[str, Any]
    if st.st_size > MAX_BYTES:
        info = {"format": "unknown", "node_count": 0, "link_count": 0, "node_types": {}, "models": [], "packages": {}, "error": "文件过大"}
    else:
        try:
            info = analyze(json.loads(path.read_text("utf-8", errors="replace")))
        except Exception as exc:  # noqa: BLE001
            info = {"format": "invalid", "node_count": 0, "link_count": 0, "node_types": {}, "models": [], "packages": {}, "error": f"JSON 解析失败：{exc}"}
    with _parse_lock:
        _parse_cache[k] = (st.st_mtime, st.st_size, info)
    return info


# --------------------------------------------------------------------- listing
def _meta_map() -> dict[str, dict[str, Any]]:
    return {r["rel"]: r for r in db.query("SELECT * FROM workflow_meta")}


def list_workflows() -> list[dict[str, Any]]:
    meta = _meta_map()
    local_names = {m["name"].lower() for m in models._scan_files()}
    out: list[dict[str, Any]] = []
    for user, root in roots():
        for path in root.rglob("*.json"):
            try:
                if not path.is_file() or any(part.startswith(".") for part in path.relative_to(root).parts):
                    continue
                st = path.stat()
            except OSError:
                continue
            rel = path.relative_to(root).as_posix()
            key = _key(user, rel)
            info = _info_for(path)
            m = meta.get(key) or {}
            folder = rel.rsplit("/", 1)[0] if "/" in rel else ""
            out.append(
                {
                    "id": key,
                    "name": path.stem,
                    "rel": rel,
                    "folder": folder,
                    "user": user,
                    "size": st.st_size,
                    "mtime": st.st_mtime,
                    "format": info.get("format"),
                    "error": info.get("error", ""),
                    "node_count": info.get("node_count", 0),
                    "node_types": list(info.get("node_types", {}).keys())[:60],
                    "models": [mm["name"] for mm in info.get("models", [])],
                    "missing_models": sum(
                        1
                        for mm in info.get("models", [])
                        if not mm.get("inactive")
                        and mm["name"].replace("\\", "/").rsplit("/", 1)[-1].lower() not in local_names
                    ),
                    "favorite": bool(m.get("favorite")),
                    "tags": [t for t in (m.get("tags") or "").split(",") if t],
                    "note": m.get("note") or "",
                }
            )
    out.sort(key=lambda w: -w["mtime"])
    return out


def _model_keys(name: str) -> list[str]:
    norm = name.replace("\\", "/").lower()
    base = norm.rsplit("/", 1)[-1]
    return [norm, base] if norm != base else [norm]


def model_usage() -> dict[str, list[dict[str, str]]]:
    """lower-case model file name -> workflows that reference it."""
    usage: dict[str, list[dict[str, str]]] = {}
    for wf in list_workflows():
        for name in set(wf["models"]):
            base = name.replace("\\", "/").lower().rsplit("/", 1)[-1]
            usage.setdefault(base, []).append({"id": wf["id"], "name": wf["name"]})
    return usage


# ------------------------------------------------------------------ detail/check
def read_raw(key: str) -> dict[str, Any]:
    path = resolve(key)
    if path.stat().st_size > MAX_BYTES:
        raise RuntimeError("工作流文件过大，无法预览。")
    data = json.loads(path.read_text("utf-8", errors="replace"))
    return {"data": data, "info": _info_for(path)}


def check(key: str) -> dict[str, Any]:
    path = resolve(key)
    info = _info_for(path)
    local = models.scan_models()
    by_base: dict[str, list[dict[str, Any]]] = {}
    for m in local:
        by_base.setdefault(m["name"].lower(), []).append(m)
    model_rows = []
    for ref in info.get("models", []):
        norm = ref["name"].replace("\\", "/").lower()
        base = norm.rsplit("/", 1)[-1]
        matches = by_base.get(base, [])
        exact = [m for m in matches if m["path"].replace("\\", "/").lower().endswith(norm)]
        civ = next((m.get("civitai") for m in matches if m.get("civitai") and not m["civitai"].get("notFound")), None)
        model_rows.append(
            {
                **ref,
                "found": bool(matches),
                "exact": bool(exact),
                "path": (exact or matches or [{}])[0].get("path", ""),
                "civitai": {"modelId": civ.get("modelId"), "modelName": civ.get("modelName")} if civ else None,
            }
        )
    known = comfy.node_types()
    missing: list[dict[str, Any]] = []
    if known is not None:
        for ntype, count in info.get("node_types", {}).items():
            if ntype in VIRTUAL_NODES or ntype in known:
                continue
            missing.append({"type": ntype, "count": count})
    return {
        "models": model_rows,
        "missing_nodes": missing,
        "nodes_checked": known is not None,
        "packages": info.get("packages", {}),
    }


# ----------------------------------------------------------------------- writes
def _clean_rel(rel: str) -> str:
    rel = rel.replace("\\", "/").strip("/ ")
    parts = [safe_filename(p, "_") for p in rel.split("/") if p and p not in (".", "..")]
    return "/".join(parts)


def _unique(path: Path) -> Path:
    if not path.exists():
        return path
    for idx in range(2, 1000):
        cand = path.with_name(f"{path.stem} ({idx}){path.suffix}")
        if not cand.exists():
            return cand
    raise RuntimeError("无法生成唯一文件名。")


def import_json(content: str | dict[str, Any], name: str, folder: str = "", user: str = "default", overwrite: bool = False) -> dict[str, Any]:
    data = json.loads(content) if isinstance(content, str) else content
    if analyze(data)["format"] == "unknown":
        raise RuntimeError("这不是有效的 ComfyUI 工作流 JSON。")
    base = next((r for u, r in roots() if u == user), None)
    if base is None:
        base = _users_dir() / user / "workflows"
        base.mkdir(parents=True, exist_ok=True)
    stem = safe_filename(Path(name).stem, "workflow")
    rel_folder = _clean_rel(folder)
    target = (base / rel_folder / f"{stem}.json") if rel_folder else (base / f"{stem}.json")
    if not is_subpath(target, base):
        raise RuntimeError("目标路径越界。")
    if target.exists() and not overwrite:
        target = _unique(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(data, ensure_ascii=False, indent=2), "utf-8")
    return {"id": _key(user, target.relative_to(base).as_posix()), "path": str(target)}


def _move_meta(old: str, new: str) -> None:
    db.execute("UPDATE workflow_meta SET rel=? WHERE rel=?", (new, old))


def rename(key: str, new_name: str) -> dict[str, Any]:
    path = resolve(key)
    stem = safe_filename(Path(new_name).stem, "workflow")
    target = path.with_name(f"{stem}.json")
    if target.exists() and target != path:
        raise RuntimeError("已存在同名工作流。")
    path.rename(target)
    root = _root_of(key)
    new_key = _key(key.partition("/")[0], target.relative_to(root).as_posix())
    _move_meta(key, new_key)
    return {"id": new_key}


def move(key: str, folder: str) -> dict[str, Any]:
    path = resolve(key)
    root = _root_of(key)
    rel_folder = _clean_rel(folder)
    target = (root / rel_folder / path.name) if rel_folder else (root / path.name)
    if not is_subpath(target, root):
        raise RuntimeError("目标路径越界。")
    if target.exists() and target != path:
        raise RuntimeError("目标文件夹里已有同名工作流。")
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(path), str(target))
    new_key = _key(key.partition("/")[0], target.relative_to(root).as_posix())
    _move_meta(key, new_key)
    return {"id": new_key}


def duplicate(key: str) -> dict[str, Any]:
    path = resolve(key)
    target = _unique(path.with_name(f"{path.stem} 副本.json"))
    shutil.copy2(path, target)
    root = _root_of(key)
    return {"id": _key(key.partition("/")[0], target.relative_to(root).as_posix())}


def delete(key: str) -> None:
    path = resolve(key)
    trash.move("workflow", path)
    db.execute("DELETE FROM workflow_meta WHERE rel=?", (key,))


def set_meta(key: str, favorite: bool | None = None, tags: list[str] | None = None, note: str | None = None) -> None:
    resolve(key)
    row = db.query("SELECT * FROM workflow_meta WHERE rel=?", (key,))
    cur = row[0] if row else {"favorite": 0, "tags": "", "note": ""}
    fav = int(cur["favorite"]) if favorite is None else int(bool(favorite))
    tag_text = cur["tags"] if tags is None else ",".join(t.strip()[:24] for t in tags if t.strip())[:300]
    note_text = cur["note"] if note is None else note[:4000]
    db.execute(
        "INSERT INTO workflow_meta (rel, favorite, tags, note, updated_at) VALUES (?,?,?,?,?) "
        "ON CONFLICT(rel) DO UPDATE SET favorite=excluded.favorite, tags=excluded.tags, "
        "note=excluded.note, updated_at=excluded.updated_at",
        (key, fav, tag_text, note_text, time.time()),
    )


def folders() -> list[str]:
    seen: set[str] = set()
    for _user, root in roots():
        for p in root.rglob("*"):
            try:
                if p.is_dir() and not p.name.startswith("."):
                    seen.add(p.relative_to(root).as_posix())
            except OSError:
                continue
    return sorted(seen)


def reveal_path(key: str) -> Path:
    return resolve(key)
