"""CivitAI API client: search, model details, prompts and files."""
from __future__ import annotations

import json
import re
import threading
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import requests

from .config import config
from .db import db
from .util import html_to_text, trim_text

API = "https://civitai.com/api/v1"
SORTS = {"Highest Rated", "Most Downloaded", "Newest", "Most Liked"}
PERIODS = {"AllTime", "Year", "Month", "Week", "Day"}
TYPES = {
    "Checkpoint", "TextualInversion", "Hypernetwork", "AestheticGradient",
    "LORA", "LoCon", "DoRA", "Controlnet", "Poses", "Motion", "Upscaler",
    "VAE", "CLIPVision", "TextEncoder", "UNet", "DiffusionModel", "Other",
}

TYPE_TO_DIR = {
    "Checkpoint": "checkpoints",
    "TextualInversion": "embeddings",
    "Hypernetwork": "hypernetworks",
    "AestheticGradient": "embeddings",
    "LORA": "loras",
    "LoCon": "loras",
    "DoRA": "loras",
    "Controlnet": "controlnet",
    "Poses": "controlnet",
    "Motion": "loras",
    "Upscaler": "upscale_models",
    "VAE": "vae",
    "CLIPVision": "clip_vision",
    "TextEncoder": "text_encoders",
    "UNet": "diffusion_models",
    "DiffusionModel": "diffusion_models",
    "Other": "checkpoints",
}

DIR_TO_TYPE = {v: k for k, v in TYPE_TO_DIR.items()}
DIR_TO_TYPE.update(
    {
        "loras": "LORA",
        "checkpoints": "Checkpoint",
        "embeddings": "TextualInversion",
        "vae": "VAE",
        "controlnet": "Controlnet",
        "upscale_models": "Upscaler",
        "clip_vision": "CLIPVision",
    }
)


class CivitAIError(RuntimeError):
    pass


_rate_lock = threading.Lock()
_last_request = 0.0


def _auth_headers() -> dict[str, str]:
    headers = {
        "User-Agent": "ComfyDeck/1.0 (+local ComfyUI manager)",
        "Accept": "application/json",
    }
    key = (config.get("civitai_api_key") or "").strip()
    if key:
        headers["Authorization"] = f"Bearer {key}"
    return headers


def _request(path: str, params: dict[str, Any] | None = None, timeout: int = 30) -> Any:
    global _last_request
    params = {k: v for k, v in (params or {}).items() if v not in (None, "", [])}
    if "types" in params and isinstance(params["types"], (list, tuple)):
        params["types"] = ",".join(params["types"])
    if "baseModels" in params and isinstance(params["baseModels"], (list, tuple)):
        params["baseModels"] = ",".join(params["baseModels"])
    url = f"{API}{path}"
    last_error = ""
    for attempt in range(3):
        with _rate_lock:
            wait = 0.38 - (time.time() - _last_request)
            if wait > 0:
                time.sleep(wait)
            _last_request = time.time()
        try:
            resp = requests.get(
                url,
                params=params,
                headers=_auth_headers(),
                proxies=config.proxies(),
                timeout=timeout,
            )
        except requests.RequestException as exc:
            last_error = f"网络错误：{exc}"
            time.sleep(0.8 * (attempt + 1))
            continue
        if resp.status_code == 200:
            try:
                return resp.json()
            except ValueError as exc:
                raise CivitAIError(f"CivitAI 返回了无效数据：{exc}") from exc
        if resp.status_code == 401:
            raise CivitAIError("CivitAI 需要 API Key，或当前 Key 无效。请在设置中填写。")
        if resp.status_code == 404:
            raise CivitAIError("CivitAI 上找不到该资源。")
        if resp.status_code == 429:
            last_error = "CivitAI 请求过于频繁，请稍后再试。"
            time.sleep(2.5 * (attempt + 1))
            continue
        if resp.status_code >= 500:
            last_error = f"CivitAI 服务暂时不可用（HTTP {resp.status_code}）。"
            time.sleep(1.2 * (attempt + 1))
            continue
        raise CivitAIError(f"CivitAI 请求失败（HTTP {resp.status_code}）")
    raise CivitAIError(last_error or "CivitAI 请求失败")


def _cache_get(key: str, ttl: float) -> Any:
    return db.get_json(key, ttl=ttl)


def _cache_set(key: str, value: Any) -> None:
    try:
        db.set_json(key, value)
    except Exception:
        pass


_CDN = re.compile(r"^(https?://image\.civitai\.com/[^/]+/[^/]+)/([^/]+)/(.+)$")
_VIDEO_EXT = (".mp4", ".webm", ".mov", ".m4v")


def is_video(url: str, kind: str = "") -> bool:
    return kind == "video" or (url or "").lower().split("?")[0].endswith(_VIDEO_EXT)


def cdn_url(url: str, spec: str) -> str:
    """Swap the transform segment of an image.civitai.com URL."""
    if not url:
        return ""
    match = _CDN.match(url)
    if not match:
        return url
    return f"{match.group(1)}/{spec}/{match.group(3)}"


def thumb_url(url: str, width: int = 450, kind: str = "") -> str:
    """Still image URL. Videos need ``anim=false`` or <img> cannot show them."""
    if not url:
        return ""
    spec = f"anim=false,width={width}" if is_video(url, kind) else f"width={width}"
    return cdn_url(url, spec)


def page_url(model_id: int | str, version_id: int | str | None = None) -> str:
    url = f"https://civitai.com/models/{model_id}"
    if version_id:
        url += f"?modelVersionId={version_id}"
    return url


def normalize_image(img: dict[str, Any]) -> dict[str, Any]:
    meta = img.get("meta") or img.get("metadata") or None
    if isinstance(meta, str):
        try:
            meta = json.loads(meta)
        except Exception:
            meta = None
    if isinstance(meta, dict):
        resources = meta.get("resources")
        if isinstance(resources, list):
            meta["resources"] = [
                {
                    "name": r.get("name", ""),
                    "type": r.get("type", ""),
                    "hash": r.get("hash", ""),
                    "weight": r.get("weight"),
                }
                for r in resources[:30]
                if isinstance(r, dict)
            ]
        meta = {k: v for k, v in list(meta.items())[:60]}
    url = img.get("url", "")
    video = is_video(url, img.get("type", ""))
    return {
        "id": img.get("id"),
        "url": url,
        "thumb": thumb_url(url, 450, "video" if video else ""),
        "full": cdn_url(url, "transcode=true,width=720") if video else cdn_url(url, "width=1280"),
        "isVideo": video,
        "width": img.get("width"),
        "height": img.get("height"),
        "nsfwLevel": img.get("nsfwLevel"),
        "type": "video" if video else img.get("type", "image"),
        "hasMeta": bool(img.get("hasMeta")),
        "meta": meta,
        "username": img.get("username", ""),
    }


def refresh_image(img: dict[str, Any]) -> dict[str, Any]:
    """Recompute URLs of an image stored by an older version."""
    url = img.get("url", "")
    video = is_video(url, img.get("type", ""))
    return {
        **img,
        "thumb": thumb_url(url, 450, "video" if video else ""),
        "full": cdn_url(url, "transcode=true,width=720") if video else cdn_url(url, "width=1280"),
        "isVideo": video,
    }


def normalize_file(file: dict[str, Any]) -> dict[str, Any]:
    metadata = file.get("metadata") or {}
    hashes = file.get("hashes") or {}
    return {
        "name": file.get("name", ""),
        "sizeKB": file.get("sizeKB"),
        "type": file.get("type", ""),
        "primary": bool(file.get("primary")),
        "sha256": hashes.get("SHA256") or hashes.get("sha256") or "",
        "downloadUrl": file.get("downloadUrl", ""),
        "format": metadata.get("format", ""),
        "fp": metadata.get("fp", ""),
        "size": metadata.get("size", ""),
    }


def normalize_version(version: dict[str, Any], model: dict[str, Any] | None = None) -> dict[str, Any]:
    model = model or (version.get("model") or {})
    files = [normalize_file(f) for f in (version.get("files") or []) if isinstance(f, dict)]
    files.sort(key=lambda f: (not f["primary"], f["type"] != "Model"))
    images = [normalize_image(i) for i in (version.get("images") or []) if isinstance(i, dict)]
    stats = version.get("stats") or {}
    return {
        "id": version.get("id"),
        "name": version.get("name", ""),
        "baseModel": version.get("baseModel", ""),
        "baseModelType": version.get("baseModelType", ""),
        "publishedAt": version.get("publishedAt") or version.get("createdAt") or "",
        "stats": {
            "downloadCount": stats.get("downloadCount", 0),
            "thumbsUpCount": stats.get("thumbsUpCount", 0),
            "rating": stats.get("rating"),
            "ratingCount": stats.get("ratingCount", 0),
        },
        "trainedWords": version.get("trainedWords") or [],
        "description": html_to_text(version.get("description"), 8000),
        "files": files,
        "images": images[:24],
        "downloadUrl": version.get("downloadUrl") or (files[0]["downloadUrl"] if files else ""),
        "pageUrl": page_url(model.get("id", ""), version.get("id")),
        "modelId": model.get("id"),
        "modelName": model.get("name", ""),
        "modelType": model.get("type", ""),
        "nsfw": bool(model.get("nsfw")),
        "creator": (model.get("creator") or {}).get("username", ""),
    }


def pick_cover(versions: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Prefer a safe still image from the newest versions that have pictures."""
    candidates: list[dict[str, Any]] = []
    for version in versions[:4]:
        candidates.extend(version.get("images") or [])
    if not candidates:
        return None
    nsfw_ok = bool(config.get("nsfw"))
    for img in candidates:
        if img.get("thumb") and (nsfw_ok or (img.get("nsfwLevel") or 1) <= 1):
            return img
    return next((img for img in candidates if img.get("thumb")), None)


def normalize_model(model: dict[str, Any]) -> dict[str, Any]:
    versions = [
        normalize_version(v, model)
        for v in (model.get("modelVersions") or [])
        if isinstance(v, dict)
    ]
    stats = model.get("stats") or {}
    creator = model.get("creator") or {}
    cover = pick_cover(versions)
    return {
        "id": model.get("id"),
        "name": model.get("name", ""),
        "type": model.get("type", ""),
        "nsfw": bool(model.get("nsfw")),
        "nsfwLevel": model.get("nsfwLevel"),
        "sfwOnly": bool(model.get("sfwOnly")),
        "baseModels": model.get("baseModels") or [],
        "tags": (model.get("tags") or [])[:20],
        "creator": {
            "username": creator.get("username", ""),
            "image": creator.get("image", ""),
        },
        "stats": {
            "downloadCount": stats.get("downloadCount", 0),
            "thumbsUpCount": stats.get("thumbsUpCount", 0),
            "rating": stats.get("rating"),
            "ratingCount": stats.get("ratingCount", 0),
            "commentCount": stats.get("commentCount", 0),
            "tippedAmountCount": stats.get("tippedAmountCount", 0),
        },
        "description": html_to_text(model.get("description"), 30000),
        "allowCommercialUse": model.get("allowCommercialUse"),
        "versions": versions,
        "pageUrl": page_url(model.get("id")),
        "cover": cover["thumb"] if cover else "",
        "coverNsfw": (cover.get("nsfwLevel") or 1) if cover else 1,
        "updatedAt": model.get("lastVersionAt") or (versions[0]["publishedAt"] if versions else ""),
    }


def search_models(
    query: str = "",
    types: list[str] | None = None,
    sort: str = "Most Downloaded",
    period: str = "AllTime",
    base_models: list[str] | None = None,
    cursor: str | None = None,
    limit: int = 24,
    nsfw: bool | None = None,
    tag: str = "",
    username: str = "",
) -> dict[str, Any]:
    if sort not in SORTS:
        sort = "Most Downloaded"
    if period not in PERIODS:
        period = "AllTime"
    nsfw = bool(config.get("nsfw")) if nsfw is None else nsfw
    params = {
        "query": query.strip() or None,
        "types": [t for t in (types or []) if t in TYPES] or None,
        "sort": sort,
        "period": period,
        "baseModels": base_models or None,
        "limit": max(1, min(100, int(limit))),
        "cursor": cursor or None,
        "tag": tag or None,
        "username": username.strip() or None,
        "nsfw": "true" if nsfw else None,
    }
    cache_key = "civitai:search:v2:" + json.dumps(
        {k: v for k, v in params.items()}, sort_keys=True
    )
    cached = _cache_get(cache_key, 600)
    if cached:
        return cached
    raw = _request("/models", params)
    items = [normalize_model(m) for m in (raw.get("items") or []) if isinstance(m, dict)]
    meta = raw.get("metadata") or {}
    out = {
        "items": items,
        "nextCursor": meta.get("nextCursor"),
        "totalItems": meta.get("totalItems"),
        "cached": False,
    }
    _cache_set(cache_key, out)
    return out


def get_model(model_id: int | str, force: bool = False) -> dict[str, Any]:
    key = f"civitai:model:v2:{model_id}"
    cached = None if force else _cache_get(key, 3600)
    if cached:
        return cached
    raw = _request(f"/models/{model_id}")
    out = normalize_model(raw)
    _cache_set(key, out)
    return out


def get_version(version_id: int | str) -> dict[str, Any]:
    key = f"civitai:version:v2:{version_id}"
    cached = _cache_get(key, 3600)
    if cached:
        return cached
    raw = _request(f"/model-versions/{version_id}")
    out = normalize_version(raw)
    _cache_set(key, out)
    return out


def get_version_by_hash(sha256: str) -> dict[str, Any]:
    sha256 = (sha256 or "").strip().upper()
    if not re.fullmatch(r"[A-F0-9]{64}", sha256):
        raise CivitAIError("SHA256 格式不正确")
    key = f"civitai:hash:v2:{sha256}"
    cached = _cache_get(key, 86400)
    if cached:
        return cached
    raw = _request(f"/model-versions/by-hash/{sha256}")
    out = normalize_version(raw)
    _cache_set(key, out)
    return out


def get_images(
    model_version_id: int | str,
    limit: int = 16,
    with_meta: bool = True,
) -> list[dict[str, Any]]:
    key = f"civitai:images:v2:{model_version_id}:{limit}:{int(with_meta)}"
    cached = _cache_get(key, 3600)
    if cached:
        return cached
    params = {
        "modelVersionId": model_version_id,
        "limit": max(1, min(100, limit)),
        "withMeta": "true" if with_meta else None,
        "sort": "Most Reactions",
    }
    raw = _request("/images", params)
    out = [normalize_image(i) for i in (raw.get("items") or []) if isinstance(i, dict)]
    _cache_set(key, out)
    return out


def get_image_meta(image_id: int | str) -> dict[str, Any]:
    key = f"civitai:image-meta:v2:{image_id}"
    cached = _cache_get(key, 86400)
    if cached:
        return cached
    raw = _request("/images", {"imageId": image_id, "withMeta": "true"})
    items = raw.get("items") or []
    if not items:
        raise CivitAIError("找不到图片")
    out = normalize_image(items[0])
    _cache_set(key, out)
    return out


def download_file_url(version: dict[str, Any], file_index: int = 0) -> str:
    files = version.get("files") or []
    if not files:
        raise CivitAIError("该版本没有可下载文件")
    idx = file_index if 0 <= file_index < len(files) else 0
    url = files[idx].get("downloadUrl") or ""
    if not url:
        url = f"https://civitai.com/api/download/models/{version['id']}"
    key = (config.get("civitai_api_key") or "").strip()
    if key and "token=" not in url:
        url += ("&" if "?" in url else "?") + "token=" + key
    return url


def download_preview(url: str, dest: Path, width: int = 900) -> bool:
    """Download one CivitAI image as a local preview (best effort)."""
    if not url:
        return False
    url = thumb_url(url, width)
    try:
        resp = requests.get(
            url,
            headers={"User-Agent": "ComfyDeck/1.0"},
            proxies=config.proxies(),
            timeout=60,
            stream=True,
        )
        if resp.status_code != 200:
            return False
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(dest.suffix + ".part")
        with tmp.open("wb") as fh:
            for chunk in resp.iter_content(256 * 1024):
                if chunk:
                    fh.write(chunk)
        tmp.replace(dest)
        return True
    except Exception:
        return False


def local_metadata(version: dict[str, Any], model: dict[str, Any] | None = None) -> dict[str, Any]:
    """Compact metadata persisted for a local model file."""
    model = model or {}
    return {
        "modelId": version.get("modelId") or model.get("id"),
        "versionId": version.get("id"),
        "modelName": version.get("modelName") or model.get("name", ""),
        "versionName": version.get("name", ""),
        "type": version.get("modelType") or model.get("type", ""),
        "baseModel": version.get("baseModel", ""),
        "trainedWords": version.get("trainedWords") or [],
        "description": version.get("description", ""),
        "modelDescription": model.get("description", ""),
        "stats": model.get("stats") or version.get("stats") or {},
        "creator": version.get("creator") or (model.get("creator") or {}).get("username", ""),
        "pageUrl": version.get("pageUrl") or page_url(
            version.get("modelId"), version.get("id")
        ),
        "publishedAt": version.get("publishedAt", ""),
        "images": version.get("images", [])[:16],
        "files": version.get("files", [])[:6],
        "nsfw": version.get("nsfw", False),
    }


def is_civitai_host(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return host.endswith("civitai.com") or host.endswith("civitai.work")
