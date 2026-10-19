"""Model inventory, hashing, previews, CivitAI matching and file operations."""
from __future__ import annotations

import json
import os
import shutil
import struct
import subprocess
import threading
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote

import yaml

from . import civitai, trash
from .config import DATA_DIR, PREVIEW_DIR, config
from .db import db
from .jobs import Job
from .util import (
    is_subpath,
    model_id,
    safe_filename,
    sha256_file,
)

MODEL_EXTS = {".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf", ".onnx"}
LOCAL_PREVIEW_EXTS = (".png", ".jpg", ".jpeg", ".webp")

MODEL_DIR_ALIASES = {
    "checkpoints": "checkpoints",
    "loras": "loras",
    "vae": "vae",
    "controlnet": "controlnet",
    "embeddings": "embeddings",
    "upscale_models": "upscale_models",
    "clip_vision": "clip_vision",
    "text_encoders": "text_encoders",
    "clip": "text_encoders",
    "diffusion_models": "diffusion_models",
    "unet": "diffusion_models",
    "hypernetworks": "hypernetworks",
    "style_models": "style_models",
    "photomaker": "photomaker",
    "gligen": "gligen",
    "model_patches": "model_patches",
}


def _norm(path: str | Path) -> str:
    return str(Path(path).resolve())


def model_roots() -> list[dict[str, Any]]:
    roots: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add(path: Path, type_name: str) -> None:
        try:
            p = Path(path).resolve()
        except Exception:
            return
        if not p.is_dir():
            return
        key = os.path.normcase(str(p))
        if key in seen:
            return
        seen.add(key)
        roots.append({"path": str(p), "type": type_name or p.name})

    models_dir = config.models_dir
    if models_dir.is_dir():
        for child in models_dir.iterdir():
            if not child.is_dir() or child.name.startswith("."):
                continue
            if child.name == "split_files":
                for sub in child.iterdir():
                    if sub.is_dir():
                        add(sub, sub.name)
            elif child.name not in ("configs",):
                add(child, child.name)

    # extra_model_paths.yaml (native ComfyUI mechanism)
    yaml_file = config.comfy_dir / "extra_model_paths.yaml"
    if yaml_file.exists():
        try:
            data = yaml.safe_load(yaml_file.read_text("utf-8", errors="replace")) or {}
            for section in data.values():
                if not isinstance(section, dict):
                    continue
                base = Path(section.get("base_path") or config.comfy_dir)
                for type_name, value in section.items():
                    if type_name in ("base_path", "is_default", "custom_nodes", "download_model_base"):
                        continue
                    if not isinstance(value, (str, list)):
                        continue
                    values = value if isinstance(value, list) else str(value).splitlines()
                    for line in values:
                        line = str(line).strip()
                        if not line or line.startswith("#"):
                            continue
                        p = Path(line)
                        if not p.is_absolute():
                            p = base / p
                        add(p, type_name)
        except Exception:
            pass

    # User configured extra folders: "type|path" strings or {path,type}
    for item in config.get("extra_model_paths") or []:
        if isinstance(item, dict):
            p = item.get("path", "")
            t = item.get("type", "")
        else:
            raw = str(item)
            if "|" in raw:
                left, _, right = raw.partition("|")
                if left.strip() and right.strip() and ":" not in left:
                    t, p = left.strip(), right.strip()
                else:
                    t, p = "", raw.strip()
            else:
                t, p = "", raw
        if not p:
            continue
        path = Path(p)
        if not t:
            t = path.name
        add(path, t)
    return roots


_scan_cache: dict[str, Any] = {"rev": -1, "time": 0.0, "items": None, "dir": ""}
_scan_lock = threading.Lock()


def _scan_files() -> list[dict[str, Any]]:
    """Cached for a few seconds: many pages ask for the model list at once."""
    with _scan_lock:
        c = _scan_cache
        fresh = (
            c["items"] is not None
            and c["rev"] == db.model_rev
            and c["dir"] == str(config.comfy_dir)
            and time.time() - c["time"] < 6
        )
        if not fresh:
            c["rev"] = db.model_rev
            c["items"] = _scan_files_uncached()
            c["time"] = time.time()
            c["dir"] = str(config.comfy_dir)
        return [dict(m) for m in c["items"]]


def invalidate_scan() -> None:
    _scan_cache["items"] = None


def _scan_files_uncached() -> list[dict[str, Any]]:
    meta_all = db.all_model_meta()
    out: list[dict[str, Any]] = []
    for root in model_roots():
        root_path = Path(root["path"])
        type_name = root["type"]
        try:
            files = list(root_path.rglob("*"))
        except Exception:
            continue
        for path in files:
            try:
                if not path.is_file():
                    continue
                if path.suffix.lower() not in MODEL_EXTS:
                    continue
                if path.name.startswith("put_") or path.name.endswith((".part", ".tmp")):
                    continue
                size = path.stat().st_size
                if size < 1024:
                    continue
            except OSError:
                continue
            try:
                resolved = path.resolve()
            except Exception:
                resolved = path
            key = str(resolved)
            mtime = resolved.stat().st_mtime
            meta = meta_all.get(key)
            if meta and (
                meta.get("size") != size
                or abs(float(meta.get("mtime") or 0) - mtime) > 1
            ):
                meta = None
            used_type = type_name
            if type_name in ("split_files", "__auto__", ""):
                used_type = resolved.parent.name
            preview_exists = _local_preview(resolved) is not None
            civ = (meta or {}).get("civitai")
            if (meta or {}).get("preview"):
                preview_exists = True
            out.append(
                {
                    "id": model_id(resolved),
                    "name": resolved.name,
                    "path": key,
                    "folder": str(resolved.parent),
                    "root": str(root_path),
                    "type": used_type,
                    "size": size,
                    "mtime": mtime,
                    "sha256": (meta or {}).get("sha256") or "",
                    "local_meta": (meta or {}).get("local_meta") or {},
                    "civitai": civ or None,
                    "has_preview": preview_exists,
                    "favorite": bool((meta or {}).get("favorite")),
                    "note": (meta or {}).get("note") or "",
                    "stale": bool(meta is None and key in meta_all),
                }
            )
    out.sort(key=lambda m: (m["type"].lower(), m["name"].lower()))
    return out


def scan_models() -> list[dict[str, Any]]:
    models = _scan_files()
    for m in models:
        m["preview_url"] = (
            f"/api/models/preview?path={quote(m['path'])}&v={int(m['mtime'])}"
            if m["has_preview"]
            else ""
        )
        m["detail_url"] = f"/api/models/detail?path={quote(m['path'])}"
    return models


def summary(models: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    models = models if models is not None else scan_models()
    types: dict[str, dict[str, Any]] = {}
    total = 0
    matched = 0
    for m in models:
        total += m["size"]
        if m["civitai"]:
            matched += 1
        t = types.setdefault(m["type"], {"type": m["type"], "count": 0, "size": 0})
        t["count"] += 1
        t["size"] += m["size"]
    type_list = sorted(types.values(), key=lambda x: -x["size"])
    return {
        "count": len(models),
        "size": total,
        "civitai_matched": matched,
        "types": type_list,
    }


def _validate_model_path(path: str) -> Path:
    p = Path(path)
    try:
        resolved = p.resolve()
    except Exception as exc:
        raise RuntimeError("无效的模型路径") from exc
    if not resolved.is_file():
        raise RuntimeError(f"模型文件不存在：{resolved}")
    for root in model_roots():
        if is_subpath(resolved, root["path"]):
            return resolved
    raise RuntimeError("该文件不在已配置的模型目录中。")
    return resolved


def _local_preview(path: Path) -> Path | None:
    try:
        files = list(path.parent.iterdir())
    except Exception:
        return None
    stem = path.stem.lower()
    ranked: list[tuple[int, Path]] = []
    for file in files:
        if not file.is_file() or file.suffix.lower() not in LOCAL_PREVIEW_EXTS:
            continue
        lower = file.name.lower()
        if lower == f"{stem}.preview{file.suffix.lower()}":
            ranked.append((0, file))
        elif lower == f"{stem}{file.suffix.lower()}":
            ranked.append((1, file))
        elif lower.startswith(stem + ".") and lower.rsplit(".", 2)[-2] in ("preview", "preview2"):
            ranked.append((2, file))
    if not ranked:
        return None
    ranked.sort(key=lambda x: (x[0], str(x[1]).lower()))
    return ranked[0][1]


def preview_file(path: str) -> Path | None:
    try:
        model_path = Path(path).resolve()
    except Exception:
        return None
    allowed = False
    for root in model_roots():
        if is_subpath(model_path, root["path"]):
            allowed = True
            break
    if not allowed:
        return None
    local = _local_preview(model_path)
    if local:
        return local
    meta = db.model_meta(str(model_path))
    if meta and meta.get("preview"):
        candidate = PREVIEW_DIR / str(meta["preview"])
        if candidate.is_file():
            return candidate
    return None


def read_safetensors_meta(path: Path) -> dict[str, Any]:
    if path.suffix.lower() != ".safetensors":
        return {}
    try:
        with path.open("rb") as fh:
            head = fh.read(8)
            if len(head) < 8:
                return {}
            length = struct.unpack("<Q", head)[0]
            if length <= 0 or length > 50 * 1024 * 1024:
                return {}
            raw = fh.read(length)
        data = json.loads(raw.decode("utf-8", errors="replace"))
        meta = data.get("__metadata__") or {}
        if not isinstance(meta, dict):
            return {}
        out: dict[str, Any] = {}
        base = meta.get("ss_base_model_version") or meta.get("modelspec.architecture") or ""
        if base:
            out["base_model"] = str(base)
        for key in ("ss_network_module", "ss_network_dim", "ss_network_alpha", "ss_clip_skip"):
            if meta.get(key) not in (None, ""):
                out[key] = str(meta[key])
        title = meta.get("modelspec.title") or meta.get("ss_output_name")
        if title:
            out["title"] = str(title)
        tags: list[str] = []
        freq = meta.get("ss_tag_frequency")
        if freq:
            try:
                parsed = json.loads(freq) if isinstance(freq, str) else freq
                counts: dict[str, float] = {}
                if isinstance(parsed, dict):
                    for value in parsed.values():
                        source = value if isinstance(value, dict) else parsed
                        if isinstance(source, dict):
                            for tag, count in source.items():
                                if isinstance(count, (int, float)):
                                    counts[str(tag)] = max(counts.get(str(tag), 0), float(count))
                tags = [t for t, _ in sorted(counts.items(), key=lambda kv: -kv[1])[:30]]
            except Exception:
                pass
        if tags:
            out["tags"] = tags
        return out
    except Exception:
        return {}


def model_detail(path: str) -> dict[str, Any]:
    resolved = _validate_model_path(path)
    models = _scan_files()
    target = None
    for m in models:
        if os.path.normcase(m["path"]) == os.path.normcase(str(resolved)):
            target = m
            break
    if not target:
        raise RuntimeError("模型不在扫描结果中。")
    meta = db.model_meta(str(resolved))
    if meta and not (meta.get("local_meta") or {}).get("base_model"):
        extra = read_safetensors_meta(resolved)
        if extra:
            merged = dict(meta.get("local_meta") or {})
            merged.update(extra)
            db.upsert_model(str(resolved), local_meta=merged)
            target["local_meta"] = merged
    elif not meta:
        extra = read_safetensors_meta(resolved)
        if extra:
            db.upsert_model(
                str(resolved),
                size=target["size"],
                mtime=target["mtime"],
                local_meta=extra,
            )
            target["local_meta"] = extra
    duplicates = []
    if target["sha256"]:
        duplicates = [
            m
            for m in models
            if m["sha256"]
            and m["sha256"] == target["sha256"]
            and os.path.normcase(m["path"]) != os.path.normcase(target["path"])
        ]
    target["preview_url"] = (
        f"/api/models/preview?path={quote(target['path'])}&v={int(target['mtime'])}"
        if preview_file(target["path"])
        else ""
    )
    target["duplicates"] = duplicates
    civ = target.get("civitai")
    if civ and civ.get("images"):
        target["civitai"] = {**civ, "images": [civitai.refresh_image(i) for i in civ["images"]]}
    target["civitai_page"] = (
        (target.get("civitai") or {}).get("pageUrl") or ""
    )
    return target


def hash_model(job: Job, path: str) -> dict[str, Any]:
    resolved = _validate_model_path(path)
    size = resolved.stat().st_size
    job.log(f"计算 SHA256：{resolved.name}（{size / 1024 / 1024 / 1024:.2f} GB）")

    def progress(done: int, total: int) -> None:
        pct = done / max(1, total) * 100
        job.set_progress(pct, f"计算哈希 {pct:.1f}%")

    sha = sha256_file(resolved, progress=progress, cancel=job.cancel_event)
    db.upsert_model(
        str(resolved),
        sha256=sha,
        size=size,
        mtime=resolved.stat().st_mtime,
    )
    job.log(f"SHA256 = {sha}")
    return {"path": str(resolved), "sha256": sha, "size": size}


def _apply_civitai(
    path: Path,
    version: dict[str, Any],
    model: dict[str, Any] | None,
    sha: str,
) -> dict[str, Any]:
    meta = civitai.local_metadata(version, model)
    key = sha or f"v{version.get('id')}"
    preview_name = f"{key}.jpg"
    preview_path = PREVIEW_DIR / preview_name
    if not preview_path.exists():
        images = sorted(
            version.get("images") or [],
            key=lambda i: (bool(i.get("isVideo")), (i.get("nsfwLevel") or 1) > 1),
        )
        for image in images[:4]:
            url = image.get("url") or image.get("thumb")
            if url and civitai.download_preview(url, preview_path):
                break
    db.upsert_model(
        str(path),
        sha256=sha or None,
        civitai=meta,
        preview=preview_name if preview_path.exists() else None,
    )
    return meta


def match_model(job: Job, path: str, force: bool = False) -> dict[str, Any]:
    resolved = _validate_model_path(path)
    meta = db.model_meta(str(resolved)) or {}
    if meta.get("civitai") and not force:
        return meta["civitai"]
    sha = meta.get("sha256") or ""
    if not sha:
        job.set_progress(2, "计算 SHA256…")
        sha = sha256_file(resolved, cancel=job.cancel_event)
        db.upsert_model(
            str(resolved),
            sha256=sha,
            size=resolved.stat().st_size,
            mtime=resolved.stat().st_mtime,
        )
    job.set_progress(50, "查询 CivitAI…")
    try:
        version = civitai.get_version_by_hash(sha)
    except civitai.CivitAIError as exc:
        if "找不到" in str(exc) or "404" in str(exc):
            db.upsert_model(
                str(resolved),
                civitai={"notFound": True, "checkedAt": time.time()},
            )
            job.log("CivitAI 未收录该文件。")
            return {"notFound": True}
        raise
    model = None
    if version.get("modelId"):
        try:
            model = civitai.get_model(version["modelId"])
        except Exception:
            model = None
    job.set_progress(75, "保存元数据与预览图…")
    data = _apply_civitai(resolved, version, model, sha)
    job.log(f"已匹配：{data.get('modelName')} / {data.get('versionName')}")
    return data


def match_all(job: Job, force: bool = False) -> dict[str, Any]:
    models = _scan_files()
    if not force:
        models = [
            m
            for m in models
            if not m.get("civitai")
        ]
    job.log(f"待匹配 {len(models)} 个模型")
    matched = 0
    failed: list[dict[str, str]] = []
    for idx, m in enumerate(models, 1):
        job.raise_if_cancelled()
        job.set_progress((idx - 1) / max(1, len(models)) * 100, f"匹配 {m['name']}")
        try:
            result = match_model(job, m["path"], force=force)
            if result and not result.get("notFound"):
                matched += 1
        except Exception as exc:  # noqa: BLE001
            failed.append({"name": m["name"], "error": str(exc)})
            job.log(f"✗ {m['name']}: {exc}")
    return {"matched": matched, "failed": failed, "total": len(models)}


def rename_model(path: str, new_name: str) -> dict[str, Any]:
    resolved = _validate_model_path(path)
    new_name = safe_filename(new_name, resolved.name)
    if not Path(new_name).suffix:
        new_name += resolved.suffix
    target = resolved.parent / new_name
    if target.exists() and os.path.normcase(str(target)) != os.path.normcase(str(resolved)):
        raise RuntimeError(f"目标文件已存在：{new_name}")
    old_meta = db.model_meta(str(resolved))
    old_preview = _local_preview(resolved)
    resolved.rename(target)
    if old_preview and old_preview.exists():
        try:
            old_preview.rename(target.with_name(target.stem + old_preview.suffix))
        except Exception:
            pass
    if old_meta:
        db.delete_model(str(resolved))
        db.upsert_model(
            str(target),
            sha256=old_meta.get("sha256"),
            size=target.stat().st_size,
            mtime=target.stat().st_mtime,
            local_meta=old_meta.get("local_meta"),
            civitai=old_meta.get("civitai"),
            preview=old_meta.get("preview"),
            favorite=old_meta.get("favorite"),
            note=old_meta.get("note"),
        )
    return {"path": str(target), "name": target.name}


def delete_model(path: str) -> dict[str, Any]:
    resolved = _validate_model_path(path)
    dest = trash.move("model", resolved, {"type": resolved.parent.name})
    db.delete_model(str(resolved))
    return {"trash": str(dest)}


def duplicates() -> list[dict[str, Any]]:
    models = _scan_files()
    groups: dict[str, list[dict[str, Any]]] = {}
    for m in models:
        if m["sha256"]:
            groups.setdefault(m["sha256"], []).append(m)
    out = []
    for sha, items in groups.items():
        if len(items) > 1:
            out.append(
                {
                    "sha256": sha,
                    "size": items[0]["size"],
                    "count": len(items),
                    "models": [
                        {"name": i["name"], "path": i["path"], "type": i["type"]}
                        for i in items
                    ],
                }
            )
    out.sort(key=lambda g: -g["size"])
    return out


def target_dir(type_name: str) -> Path:
    folder = civitai.TYPE_TO_DIR.get(type_name, "")
    if not folder:
        folder = MODEL_DIR_ALIASES.get((type_name or "").lower(), "checkpoints")
    path = config.models_dir / folder
    path.mkdir(parents=True, exist_ok=True)
    return path


def reveal(path: str) -> None:
    p = Path(path)
    if not p.exists():
        raise RuntimeError("路径不存在")
    if os.name == "nt":
        if p.is_file():
            subprocess.Popen(["explorer", "/select,", str(p)])
        else:
            os.startfile(str(p))  # type: ignore[attr-defined]
    else:
        subprocess.Popen(["xdg-open", str(p.parent if p.is_file() else p)])


def set_flags(path: str, favorite: bool | None = None, note: str | None = None) -> None:
    resolved = _validate_model_path(path)
    fields: dict[str, Any] = {}
    if favorite is not None:
        fields["favorite"] = 1 if favorite else 0
    if note is not None:
        fields["note"] = note[:4000]
    if fields:
        db.upsert_model(str(resolved), **fields)


def installed_versions() -> dict[int, set[int]]:
    """CivitAI model id -> version ids that exist on disk."""
    out: dict[int, set[int]] = {}
    for m in _scan_files():
        civ = m.get("civitai") or {}
        if civ.get("modelId") and civ.get("versionId"):
            out.setdefault(int(civ["modelId"]), set()).add(int(civ["versionId"]))
    return out


UPDATES_KEY = "models:updates"


def update_map() -> dict[str, dict[str, Any]]:
    return db.get_json(UPDATES_KEY) or {}


def check_updates(job: Job) -> dict[str, Any]:
    """Compare matched local models with the newest version on CivitAI."""
    models = [m for m in _scan_files() if m.get("civitai") and not m["civitai"].get("notFound")]
    by_model: dict[int, dict[str, Any]] = {}
    for m in models:
        civ = m["civitai"]
        if civ.get("modelId") and civ.get("versionId"):
            by_model.setdefault(int(civ["modelId"]), civ)
    result: dict[str, dict[str, Any]] = {}
    ids = list(by_model)
    job.log(f"检查 {len(ids)} 个已匹配的模型")
    for idx, model_id in enumerate(ids, 1):
        job.raise_if_cancelled()
        job.set_progress((idx - 1) / max(1, len(ids)) * 100, f"检查 {idx}/{len(ids)}")
        local = by_model[model_id]
        try:
            remote = civitai.get_model(model_id, force=True)
        except Exception as exc:  # noqa: BLE001
            job.log(f"✗ #{model_id}: {exc}")
            continue
        same_base = [
            v for v in remote.get("versions", [])
            if v.get("baseModel") == local.get("baseModel")
        ] or remote.get("versions", [])
        if not same_base:
            continue
        newest = max(same_base, key=lambda v: v.get("id") or 0)
        if (newest.get("id") or 0) > int(local["versionId"]):
            result[str(model_id)] = {
                "versionId": newest["id"],
                "versionName": newest.get("name", ""),
                "modelName": remote.get("name", ""),
                "publishedAt": newest.get("publishedAt", ""),
            }
            job.log(f"↑ {remote.get('name')}：{local.get('versionName')} → {newest.get('name')}")
    db.set_json(UPDATES_KEY, result)
    return {"checked": len(ids), "updates": len(result)}


def apply_download_meta(
    path: Path, version: dict[str, Any], model: dict[str, Any] | None, sha: str = ""
) -> None:
    _apply_civitai(path, version, model, sha)
