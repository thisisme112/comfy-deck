"""Image gallery for ComfyUI outputs: index, search, thumbnails and metadata."""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import threading
import time
from pathlib import Path
from typing import Any

from PIL import Image

from . import trash
from .config import THUMB_DIR, config
from .db import db
from .util import is_subpath, safe_filename

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
VIDEO_EXTS = {".mp4", ".webm", ".mov", ".mkv"}
THUMB_SIZE = 520
SKIP_DIRS = {"__pycache__", "node_modules"}


# ----------------------------------------------------------------------- roots
def roots() -> list[dict[str, str]]:
    base = config.comfy_dir
    out = [
        {"key": "output", "label": "输出", "path": str(base / "output")},
        {"key": "input", "label": "输入", "path": str(base / "input")},
    ]
    for idx, extra in enumerate(config.get("gallery_extra_dirs") or []):
        out.append({"key": f"extra{idx}", "label": Path(extra).name or extra, "path": str(extra)})
    return [r for r in out if Path(r["path"]).is_dir()]


def _id(path: str | Path) -> str:
    return hashlib.sha1(os.path.normcase(str(path)).encode("utf-8", "surrogatepass")).hexdigest()[:20]


# ------------------------------------------------------------ metadata parsing
def _is_link(v: Any) -> bool:
    return isinstance(v, list) and len(v) == 2 and isinstance(v[1], int) and isinstance(v[0], (str, int))


_POS_KEYS = ("positive", "positive_prompt", "pos", "text", "text_g", "prompt", "string", "value")
_NEG_KEYS = ("negative", "negative_prompt", "neg", "text", "text_l", "prompt", "string", "value")
_SKIP_LINK_KEYS = {"model", "clip", "vae", "latent_image", "latent", "image", "images", "samples", "pixels", "mask", "control_net"}


def _resolve_text(g: dict[str, Any], ref: Any, want: str, depth: int = 0) -> str:
    if isinstance(ref, str):
        return ref
    if depth > 8 or not _is_link(ref):
        return ""
    node = g.get(str(ref[0]))
    if not isinstance(node, dict):
        return ""
    inputs = node.get("inputs") or {}
    for key in (_POS_KEYS if want == "positive" else _NEG_KEYS):
        v = inputs.get(key)
        if isinstance(v, str) and v.strip():
            return v
        if _is_link(v):
            text = _resolve_text(g, v, want, depth + 1)
            if text:
                return text
    keys = [k for k, v in inputs.items() if _is_link(v) and k not in _SKIP_LINK_KEYS]
    keys.sort(key=lambda k: 0 if want[:3] in k.lower() else 1)
    for key in keys:
        text = _resolve_text(g, inputs[key], want, depth + 1)
        if text:
            return text
    return ""


_UPSTREAM = ("guider", "sampler", "sigmas", "noise", "scheduler")


def _lookup(g: dict[str, Any], node: dict[str, Any], keys: tuple[str, ...], depth: int = 0) -> Any:
    inputs = node.get("inputs") or {}
    for key in keys:
        if key not in inputs:
            continue
        v = inputs[key]
        if _is_link(v):
            sub = g.get(str(v[0]))
            if isinstance(sub, dict) and depth < 4:
                found = _lookup(g, sub, keys + ("value", "int", "float", "number"), depth + 1)
                if found is not None:
                    return found
        elif v is not None and not isinstance(v, (list, dict)):
            return v
    if depth < 3:
        for key in _UPSTREAM:
            v = inputs.get(key)
            if _is_link(v):
                sub = g.get(str(v[0]))
                if isinstance(sub, dict):
                    found = _lookup(g, sub, keys, depth + 1)
                    if found is not None:
                        return found
    return None


def _num_id(nid: str) -> float:
    try:
        return float(nid)
    except ValueError:
        return 1e18


def _pick_sampler(g: dict[str, Any]) -> tuple[str, dict[str, Any]] | None:
    cands: list[tuple[tuple[float, float], str, dict[str, Any]]] = []
    for nid, node in g.items():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs") or {}
        is_sampler = ("positive" in inputs and "negative" in inputs and ("steps" in inputs or "seed" in inputs or "noise_seed" in inputs)) or (
            "guider" in inputs and "sampler" in inputs
        )
        if not is_sampler:
            continue
        denoise = inputs.get("denoise")
        base_pass = 0.0 if not isinstance(denoise, (int, float)) or denoise >= 0.99 else 1.0
        cands.append(((base_pass, _num_id(nid)), nid, node))
    if not cands:
        return None
    cands.sort(key=lambda c: c[0])
    return cands[0][1], cands[0][2]


_LORA_KEY = re.compile(r"^lora(_name)?(_?\d+)?$", re.I)


def parse_prompt_graph(g: dict[str, Any]) -> dict[str, Any]:
    """Pull the interesting generation parameters out of a ComfyUI API prompt."""
    out: dict[str, Any] = {
        "prompt": "", "negative": "", "model": "", "loras": [], "seed": "", "steps": None,
        "cfg": None, "sampler": "", "scheduler": "",
    }
    picked = _pick_sampler(g)
    if picked:
        _nid, node = picked
        inputs = node.get("inputs") or {}
        pos_ref, neg_ref = inputs.get("positive"), inputs.get("negative")
        if pos_ref is None and _is_link(inputs.get("guider")):
            guider = g.get(str(inputs["guider"][0])) or {}
            gi = guider.get("inputs") or {}
            pos_ref = gi.get("positive") or gi.get("conditioning")
            neg_ref = gi.get("negative")
        out["prompt"] = _resolve_text(g, pos_ref, "positive")[:6000] if pos_ref is not None else ""
        out["negative"] = _resolve_text(g, neg_ref, "negative")[:6000] if neg_ref is not None else ""
        seed = _lookup(g, node, ("seed", "noise_seed"))
        out["seed"] = "" if seed is None else str(seed)
        steps = _lookup(g, node, ("steps",))
        out["steps"] = int(steps) if isinstance(steps, (int, float)) else None
        cfg = _lookup(g, node, ("cfg", "guidance"))
        out["cfg"] = float(cfg) if isinstance(cfg, (int, float)) else None
        sampler = _lookup(g, node, ("sampler_name",))
        out["sampler"] = str(sampler) if sampler else ""
        scheduler = _lookup(g, node, ("scheduler",))
        out["scheduler"] = str(scheduler) if scheduler else ""
    loras: list[str] = []
    for _nid, node in g.items():
        if not isinstance(node, dict):
            continue
        for key, v in (node.get("inputs") or {}).items():
            if not out["model"] and key in ("ckpt_name", "unet_name") and isinstance(v, str):
                out["model"] = v
            if _LORA_KEY.match(key):
                if isinstance(v, str) and v.strip() and v.lower() != "none":
                    loras.append(v)
                elif isinstance(v, dict) and v.get("lora") and v.get("on", True):
                    loras.append(str(v["lora"]))
    seen: set[str] = set()
    out["loras"] = [x for x in loras if not (x in seen or seen.add(x))][:20]
    return out


_A1111_PARAM = re.compile(r"\b(Steps|Sampler|CFG scale|Seed|Model|Scheduler|Schedule type): ([^,]+)")


def parse_a1111(text: str) -> dict[str, Any]:
    out: dict[str, Any] = {"prompt": "", "negative": "", "model": "", "loras": [], "seed": "", "steps": None, "cfg": None, "sampler": "", "scheduler": ""}
    lines = text.strip().split("\n")
    params_line = lines[-1] if lines and "Steps:" in lines[-1] else ""
    body = "\n".join(lines[:-1] if params_line else lines)
    pos, _, neg = body.partition("\nNegative prompt:")
    out["prompt"] = pos.strip()[:6000]
    out["negative"] = neg.strip()[:6000]
    for key, value in _A1111_PARAM.findall(params_line):
        value = value.strip()
        if key == "Steps" and value.isdigit():
            out["steps"] = int(value)
        elif key == "Sampler":
            out["sampler"] = value
        elif key == "CFG scale":
            try:
                out["cfg"] = float(value)
            except ValueError:
                pass
        elif key == "Seed":
            out["seed"] = value
        elif key == "Model":
            out["model"] = value
        elif key in ("Scheduler", "Schedule type"):
            out["scheduler"] = value
    out["loras"] = re.findall(r"<lora:([^:>]+)", out["prompt"])[:20]
    return out


def _load_json(text: Any) -> Any:
    if isinstance(text, (bytes, bytearray)):
        text = text.decode("utf-8", errors="replace")
    if not isinstance(text, str):
        return None
    try:
        return json.loads(text)
    except Exception:
        return None


def read_embedded(path: Path) -> dict[str, Any]:
    """Return width/height plus any ComfyUI/A1111 data stored inside the image."""
    result: dict[str, Any] = {"width": None, "height": None, "prompt": None, "workflow": None, "parameters": ""}
    try:
        with Image.open(path) as im:
            result["width"], result["height"] = im.size
            info = dict(im.info or {})
            result["prompt"] = _load_json(info.get("prompt"))
            result["workflow"] = _load_json(info.get("workflow"))
            params = info.get("parameters")
            if isinstance(params, str):
                result["parameters"] = params
            if result["prompt"] is None and result["workflow"] is None and path.suffix.lower() in (".webp", ".jpg", ".jpeg"):
                try:
                    for value in im.getexif().values():
                        if isinstance(value, str):
                            if value.startswith("prompt:") and result["prompt"] is None:
                                result["prompt"] = _load_json(value[7:])
                            elif value.startswith("workflow:") and result["workflow"] is None:
                                result["workflow"] = _load_json(value[9:])
                except Exception:
                    pass
    except Exception:
        pass
    return result


# --------------------------------------------------------------------- indexer
def _kind(ext: str) -> str:
    return "video" if ext in VIDEO_EXTS else "image"


def _index_file(root_key: str, root_path: Path, path: Path, st: os.stat_result) -> tuple:
    ext = path.suffix.lower()
    kind = _kind(ext)
    rel = path.relative_to(root_path).as_posix()
    folder = rel.rsplit("/", 1)[0] if "/" in rel else ""
    meta: dict[str, Any] = {"prompt": "", "negative": "", "model": "", "loras": [], "seed": "", "steps": None, "cfg": None, "sampler": "", "scheduler": ""}
    width = height = None
    has_workflow = 0
    if kind == "image":
        emb = read_embedded(path)
        width, height = emb["width"], emb["height"]
        if isinstance(emb["prompt"], dict):
            meta = parse_prompt_graph(emb["prompt"])
        elif emb["parameters"]:
            meta = parse_a1111(emb["parameters"])
        has_workflow = 1 if (emb["workflow"] or emb["prompt"]) else 0
    return (
        _id(path), str(path), root_key, rel, folder, path.name, ext, kind, st.st_size, st.st_mtime,
        width, height, meta["prompt"], meta["negative"], meta["model"], "\n".join(meta["loras"]),
        meta["seed"], meta["steps"], meta["cfg"], meta["sampler"], meta["scheduler"], has_workflow, time.time(),
    )


_UPSERT = """
INSERT INTO gallery (id, path, root, rel, folder, name, ext, kind, size, mtime, width, height,
    prompt, negative, model, loras, seed, steps, cfg, sampler, scheduler, has_workflow, indexed_at)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET path=excluded.path, root=excluded.root, rel=excluded.rel,
    folder=excluded.folder, name=excluded.name, ext=excluded.ext, kind=excluded.kind,
    size=excluded.size, mtime=excluded.mtime, width=excluded.width, height=excluded.height,
    prompt=excluded.prompt, negative=excluded.negative, model=excluded.model, loras=excluded.loras,
    seed=excluded.seed, steps=excluded.steps, cfg=excluded.cfg, sampler=excluded.sampler,
    scheduler=excluded.scheduler, has_workflow=excluded.has_workflow, indexed_at=excluded.indexed_at
"""


class Indexer:
    def __init__(self) -> None:
        self.running = False
        self.total = 0
        self.done = 0
        self.finished = 0.0
        self.error = ""
        self._lock = threading.Lock()

    def state(self) -> dict[str, Any]:
        return {"running": self.running, "total": self.total, "done": self.done, "finished": self.finished, "error": self.error}

    def start(self) -> bool:
        with self._lock:
            if self.running:
                return False
            self.running = True
            self.total = self.done = 0
            self.error = ""
        threading.Thread(target=self._run, name="gallery-index", daemon=True).start()
        return True

    def _walk(self, root_path: Path):
        stack = [root_path]
        while stack:
            current = stack.pop()
            try:
                with os.scandir(current) as it:
                    for entry in it:
                        if entry.name.startswith(".") or entry.name in SKIP_DIRS:
                            continue
                        if entry.is_dir(follow_symlinks=False):
                            stack.append(Path(entry.path))
                        elif entry.is_file():
                            ext = os.path.splitext(entry.name)[1].lower()
                            if ext in IMAGE_EXTS or ext in VIDEO_EXTS:
                                yield Path(entry.path), entry.stat()
            except OSError:
                continue

    def _run(self) -> None:
        try:
            known = {r["id"]: (r["mtime"], r["size"]) for r in db.query("SELECT id, mtime, size FROM gallery")}
            seen: set[str] = set()
            todo: list[tuple[str, Path, Path, os.stat_result]] = []
            scanned_roots: list[str] = []
            for root in roots():
                root_path = Path(root["path"])
                scanned_roots.append(root["key"])
                for path, st in self._walk(root_path):
                    fid = _id(path)
                    seen.add(fid)
                    old = known.get(fid)
                    if old and abs(old[0] - st.st_mtime) < 1 and old[1] == st.st_size:
                        continue
                    todo.append((root["key"], root_path, path, st))
            self.total = len(todo)
            batch: list[tuple] = []
            for root_key, root_path, path, st in todo:
                try:
                    batch.append(_index_file(root_key, root_path, path, st))
                except Exception:
                    pass
                self.done += 1
                if len(batch) >= 40:
                    db.executemany(_UPSERT, batch)
                    batch = []
            if batch:
                db.executemany(_UPSERT, batch)
            stale = [i for i in known if i not in seen]
            for chunk_start in range(0, len(stale), 400):
                chunk = stale[chunk_start:chunk_start + 400]
                db.execute(f"DELETE FROM gallery WHERE id IN ({','.join('?' * len(chunk))})", chunk)
        except Exception as exc:  # noqa: BLE001
            self.error = str(exc)
        finally:
            self.running = False
            self.finished = time.time()


indexer = Indexer()


def ensure_fresh(max_age: float = 30.0) -> None:
    if not indexer.running and time.time() - indexer.finished > max_age:
        indexer.start()


# ----------------------------------------------------------------------- query
def _public(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "rel": row["rel"],
        "folder": row["folder"],
        "root": row["root"],
        "kind": row["kind"],
        "ext": row["ext"],
        "size": row["size"],
        "mtime": row["mtime"],
        "width": row["width"],
        "height": row["height"],
        "prompt": row["prompt"] or "",
        "negative": row["negative"] or "",
        "model": row["model"] or "",
        "loras": [x for x in (row["loras"] or "").split("\n") if x],
        "seed": row["seed"] or "",
        "steps": row["steps"],
        "cfg": row["cfg"],
        "sampler": row["sampler"] or "",
        "scheduler": row["scheduler"] or "",
        "has_workflow": bool(row["has_workflow"]),
        "favorite": bool(row["favorite"]),
        "note": row["note"] or "",
        "thumb": f"/api/gallery/{row['id']}/thumb?v={int(row['mtime'])}",
        "url": f"/api/gallery/{row['id']}/file?v={int(row['mtime'])}",
    }


def _esc(text: str) -> str:
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _like(token: str) -> str:
    return "%" + _esc(token) + "%"


def query(
    q: str = "", kind: str = "", root: str = "", folder: str = "", favorite: bool = False,
    model: str = "", sort: str = "new", offset: int = 0, limit: int = 120,
    has_workflow: bool = False,
) -> dict[str, Any]:
    where, params = ["1=1"], []
    if root:
        where.append("root=?")
        params.append(root)
    if folder:
        where.append("(folder=? OR folder LIKE ? ESCAPE '\\')")
        params.extend([folder, _esc(folder) + "/%"])
    if kind in ("image", "video"):
        where.append("kind=?")
        params.append(kind)
    if favorite:
        where.append("favorite=1")
    if has_workflow:
        where.append("has_workflow=1")
    if model:
        where.append("(model=? OR loras LIKE ? ESCAPE '\\')")
        params.extend([model, _like(model)])
    for token in q.split():
        where.append("(name || ' ' || prompt || ' ' || negative || ' ' || model || ' ' || loras || ' ' || seed || ' ' || note) LIKE ? ESCAPE '\\'")
        params.append(_like(token))
    order = {"old": "mtime ASC", "name": "name COLLATE NOCASE ASC", "size": "size DESC"}.get(sort, "mtime DESC")
    clause = " AND ".join(where)
    total = db.query(f"SELECT COUNT(*) AS n FROM gallery WHERE {clause}", params)[0]["n"]
    rows = db.query(
        f"SELECT * FROM gallery WHERE {clause} ORDER BY {order}, id LIMIT ? OFFSET ?",
        [*params, max(1, min(500, limit)), max(0, offset)],
    )
    return {"items": [_public(r) for r in rows], "total": total}


def facets(root: str = "") -> dict[str, Any]:
    where, params = "1=1", []
    if root:
        where, params = "root=?", [root]
    models = db.query(
        f"SELECT model, COUNT(*) AS n FROM gallery WHERE {where} AND model!='' GROUP BY model ORDER BY n DESC LIMIT 40", params
    )
    folders = db.query(
        f"SELECT root, folder, COUNT(*) AS n FROM gallery WHERE {where} GROUP BY root, folder ORDER BY folder", params
    )
    roots_count = db.query("SELECT root, COUNT(*) AS n, COALESCE(SUM(size),0) AS size FROM gallery GROUP BY root")
    totals = db.query("SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS size FROM gallery")[0]
    return {"models": models, "folders": folders, "roots": roots_count, "totals": totals}


def get(image_id: str) -> dict[str, Any]:
    rows = db.query("SELECT * FROM gallery WHERE id=?", (image_id,))
    if not rows:
        raise RuntimeError("图片不存在或尚未建立索引。")
    return rows[0]


def path_of(image_id: str) -> Path:
    row = get(image_id)
    path = Path(row["path"])
    if not path.is_file():
        raise RuntimeError("文件已不存在，请重新扫描。")
    if not any(is_subpath(path, r["path"]) for r in roots()):
        raise RuntimeError("文件不在图库目录内。")
    return path


def detail(image_id: str) -> dict[str, Any]:
    row = get(image_id)
    path = path_of(image_id)
    data = _public(row)
    if row["kind"] == "image":
        emb = read_embedded(path)
        data["parameters"] = emb["parameters"]
        data["has_workflow"] = bool(emb["workflow"] or emb["prompt"])
        data["workflow_kind"] = "graph" if emb["workflow"] else ("api" if emb["prompt"] else "")
    data["path"] = str(path)
    return data


def extract_workflow(image_id: str) -> tuple[Any, str]:
    path = path_of(image_id)
    emb = read_embedded(path)
    if emb["workflow"]:
        return emb["workflow"], "graph"
    if emb["prompt"]:
        return emb["prompt"], "api"
    raise RuntimeError("这张图片没有内嵌工作流（可能经过了压缩或被其他工具另存）。")


def set_flags(ids: list[str], favorite: bool | None = None, note: str | None = None) -> None:
    for image_id in ids:
        if favorite is not None:
            db.execute("UPDATE gallery SET favorite=? WHERE id=?", (1 if favorite else 0, image_id))
        if note is not None:
            db.execute("UPDATE gallery SET note=? WHERE id=?", (note[:2000], image_id))


def delete(ids: list[str]) -> int:
    count = 0
    for image_id in ids:
        try:
            path = path_of(image_id)
        except RuntimeError:
            db.execute("DELETE FROM gallery WHERE id=?", (image_id,))
            continue
        trash.move("image", path)
        db.execute("DELETE FROM gallery WHERE id=?", (image_id,))
        try:
            (THUMB_DIR / f"{image_id}.webp").unlink()
        except OSError:
            pass
        count += 1
    return count


def copy_to_input(image_id: str) -> str:
    path = path_of(image_id)
    dest_dir = config.comfy_dir / "input"
    dest_dir.mkdir(parents=True, exist_ok=True)
    target = dest_dir / safe_filename(path.name)
    for idx in range(2, 1000):
        if not target.exists():
            break
        target = dest_dir / f"{path.stem}_{idx}{path.suffix}"
    shutil.copy2(path, target)
    return target.name


# ------------------------------------------------------------------- thumbnails
_thumb_lock = threading.Semaphore(4)


def thumb_path(image_id: str) -> Path:
    row = get(image_id)
    src = path_of(image_id)
    if row["kind"] != "image":
        raise RuntimeError("视频没有缩略图")
    out = THUMB_DIR / f"{image_id}.webp"
    if out.exists() and out.stat().st_mtime >= row["mtime"]:
        return out
    with _thumb_lock:
        with Image.open(src) as im:
            im.thumbnail((THUMB_SIZE, THUMB_SIZE))
            if im.mode in ("P", "LA", "PA"):
                im = im.convert("RGBA")
            elif im.mode not in ("RGB", "RGBA"):
                im = im.convert("RGB")
            tmp = out.with_suffix(".tmp")
            im.save(tmp, "WEBP", quality=80, method=4)
        tmp.replace(out)
    return out


def clear_thumbs() -> int:
    count = 0
    for f in THUMB_DIR.glob("*.webp"):
        try:
            f.unlink()
            count += 1
        except OSError:
            pass
    return count
