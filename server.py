from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import subprocess
import time
from typing import Any
from urllib.parse import urlparse

from contextlib import asynccontextmanager

from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from comfydeck import __version__
from comfydeck import civitai, comfy, downloader, gallery, launcher as launch, models, nodes, trash, workflows
from comfydeck import paths as pathutil
from comfydeck.config import BASE_DIR, DATA_DIR, FROZEN, LOG_DIR, PREVIEW_DIR, THUMB_DIR, WEB_DIR, config
from comfydeck.db import db
from comfydeck.jobs import jobs

LOCAL_HOSTS = ("127.0.0.1", "localhost", "::1", "[::1]")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    launch.maybe_autostart()
    gallery.ensure_fresh(0)
    yield


app = FastAPI(title="ComfyDeck", version="2.1.0", docs_url=None, redoc_url=None, lifespan=lifespan)

# Set by main() so the packaged build can shut down cleanly.
_UVICORN_SERVER: Any = None


@app.middleware("http")
async def local_only(request: Request, call_next):
    host = (request.headers.get("host") or "").rsplit(":", 1)[0].lower().strip("[]")
    if host and host not in ("127.0.0.1", "localhost", "::1"):
        return JSONResponse({"detail": "只允许通过 localhost 访问。"}, status_code=403)
    if request.method in ("POST", "PUT", "PATCH", "DELETE"):
        origin = request.headers.get("origin")
        if origin:
            host = (urlparse(origin).hostname or "").lower()
            if host not in ("127.0.0.1", "localhost", "::1"):
                return JSONResponse({"detail": "只允许本机页面调用该接口。"}, status_code=403)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


@app.exception_handler(civitai.CivitAIError)
async def _civitai_error(_request: Request, exc: civitai.CivitAIError):
    return JSONResponse({"detail": str(exc)}, status_code=502)


@app.exception_handler(RuntimeError)
async def _runtime_error(_request: Request, exc: RuntimeError):
    return JSONResponse({"detail": str(exc)}, status_code=400)


app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")


@app.get("/")
def index():
    return FileResponse(
        WEB_DIR / "index.html",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )


@app.get("/favicon.ico")
def favicon():
    icon = WEB_DIR / "favicon.svg"
    if icon.exists():
        return FileResponse(icon, media_type="image/svg+xml")
    raise HTTPException(404)


def _job_payload(job) -> dict[str, Any]:
    return {"job": job.to_dict(), "id": job.id}


# --------------------------------------------------------------------- overview
@app.get("/api/overview")
def overview():
    model_list = models.scan_models()
    model_summary = models.summary(model_list)
    node_list = nodes.scan_nodes()
    node_cache = nodes._read_cache() if hasattr(nodes, "_read_cache") else {}
    updates = sum(
        1
        for n in node_list
        if (n.get("update") or {}).get("behind", 0) > 0
    )
    core = comfy.core_info()
    gallery.ensure_fresh()
    recent_images = gallery.query(limit=10)
    wf = workflows.list_workflows()
    return {
        "core": core,
        "comfy": core.get("service") or {},
        "models": {**model_summary, "updates": len(models.update_map())},
        "nodes": {
            "total": len(node_list),
            "enabled": sum(1 for n in node_list if n["enabled"]),
            "updates": updates,
            "checked_at": node_cache.get("checked_at"),
        },
        "gallery": {"recent": recent_images["items"], "total": gallery.facets()["totals"]},
        "workflows": {"total": len(wf), "recent": wf[:6]},
        "trash": trash.summary(),
        "profiles": launch.list_profiles(),
        "jobs": {
            "active": jobs.list(active_only=True),
            "recent": jobs.list()[:6],
        },
        "paths": {
            "comfy": str(config.comfy_dir),
            "models": str(config.models_dir),
            "custom_nodes": str(config.custom_nodes),
            "data": str(DATA_DIR),
        },
        "server_time": time.time(),
    }


# ------------------------------------------------------------------------- core
@app.get("/api/core")
def core_get():
    return comfy.core_info()


@app.post("/api/core/check")
def core_check():
    latest = comfy.check_latest(force=True)
    info = comfy.core_info()
    return {"latest": latest, "core": info}


@app.post("/api/core/update")
def core_update(payload: dict[str, Any] | None = Body(default=None)):
    data = payload or {}
    target = str(data.get("target") or "latest")
    force = bool(data.get("force"))
    install_requirements = data.get("install_requirements", True) is not False
    label = "最新稳定版" if target in ("", "latest") else target
    job = jobs.submit(
        "core",
        f"更新 ComfyUI（{label}）",
        lambda j: comfy.update_core(j, target, force, install_requirements),
        meta={"target": target},
    )
    return _job_payload(job)


@app.post("/api/core/rollback")
def core_rollback(payload: dict[str, Any] | None = Body(default=None)):
    data = payload or {}
    ref = str(data.get("ref") or "").strip()
    if not ref:
        raise HTTPException(400, "缺少要回滚的版本。")
    job = jobs.submit(
        "core",
        f"回滚 ComfyUI 到 {ref}",
        lambda j: comfy.rollback_core(j, ref, data.get("install_requirements", True) is not False),
        meta={"ref": ref},
    )
    return _job_payload(job)


@app.post("/api/core/open")
def core_open():
    import webbrowser

    webbrowser.open(comfy.base_url())
    return {"ok": True}


@app.get("/api/comfy/status")
def comfy_status():
    return comfy.system_stats()


# --------------------------------------------------------------------- launcher
@app.get("/api/launcher/profiles")
def launcher_profiles():
    return launch.list_profiles()


@app.post("/api/launcher/profiles")
def launcher_profile_save(payload: dict[str, Any] | None = Body(default=None)):
    return {"profile": launch.save_profile(payload or {}), **launch.list_profiles()}


@app.post("/api/launcher/profiles/delete")
def launcher_profile_delete(payload: dict[str, Any] | None = Body(default=None)):
    launch.delete_profile(str((payload or {}).get("id") or ""))
    return launch.list_profiles()


@app.post("/api/launcher/start")
def launcher_start(payload: dict[str, Any] | None = Body(default=None)):
    data = payload or {}
    return launch.launcher.start(data.get("profile_id") or None, data.get("args"))


@app.post("/api/launcher/stop")
def launcher_stop():
    return launch.launcher.stop()


@app.post("/api/launcher/restart")
def launcher_restart(payload: dict[str, Any] | None = Body(default=None)):
    return launch.launcher.restart((payload or {}).get("profile_id") or None)


@app.get("/api/launcher/logs")
def launcher_logs():
    return {"items": launch.launcher.list_logs()}


@app.get("/api/launcher/log")
def launcher_log(offset: int = -1, file: str = ""):
    return launch.launcher.log_tail(offset, file)


@app.post("/api/comfy/free")
def comfy_free():
    comfy.free_memory()
    return {"ok": True}


@app.post("/api/comfy/interrupt")
def comfy_interrupt():
    comfy.interrupt()
    return {"ok": True}


@app.post("/api/comfy/clear-queue")
def comfy_clear_queue():
    comfy.clear_queue()
    return {"ok": True}


# ------------------------------------------------------------------------ nodes
@app.get("/api/nodes")
def nodes_list():
    items = nodes.scan_nodes()
    cache = nodes._read_cache()
    return {
        "items": items,
        "checked_at": cache.get("checked_at"),
        "summary": {
            "total": len(items),
            "enabled": sum(1 for n in items if n["enabled"]),
            "updates": sum(1 for n in items if (n.get("update") or {}).get("behind", 0) > 0),
            "git": sum(1 for n in items if n["kind"] == "git"),
            "cnr": sum(1 for n in items if n["kind"] == "cnr"),
        },
    }


@app.post("/api/nodes/check")
def nodes_check(payload: dict[str, Any] | None = Body(default=None)):
    data = payload or {}
    names = data.get("names") or None
    job = jobs.submit(
        "nodes",
        "检查插件更新",
        lambda j: nodes.check_all(j, names),
    )
    return _job_payload(job)


@app.post("/api/nodes/update")
def nodes_update(payload: dict[str, Any] | None = Body(default=None)):
    data = payload or {}
    dir_name = str(data.get("dir_name") or "").strip()
    if not dir_name:
        raise HTTPException(400, "缺少插件目录名。")
    node = next((n for n in nodes.scan_nodes() if n["dir_name"] == dir_name), None)
    title = f"更新插件：{node['name'] if node else dir_name}"
    job = jobs.submit(
        "nodes",
        title,
        lambda j: nodes.update_node(j, dir_name, bool(data.get("run_install"))),
        meta={"dir_name": dir_name},
    )
    return _job_payload(job)


@app.post("/api/nodes/update-all")
def nodes_update_all(payload: dict[str, Any] | None = Body(default=None)):
    data = payload or {}
    job = jobs.submit(
        "nodes",
        "批量更新插件",
        lambda j: nodes.update_all(j, data.get("names") or None, bool(data.get("run_install"))),
    )
    return _job_payload(job)


@app.post("/api/nodes/toggle")
def nodes_toggle(payload: dict[str, Any] | None = Body(default=None)):
    data = payload or {}
    return nodes.toggle_node(str(data.get("dir_name") or ""))


@app.post("/api/nodes/install")
def nodes_install(payload: dict[str, Any] | None = Body(default=None)):
    data = payload or {}
    url = str(data.get("url") or "").strip()
    if not url:
        raise HTTPException(400, "缺少仓库地址。")
    job = jobs.submit(
        "nodes",
        "安装插件",
        lambda j: nodes.install_node(j, url, bool(data.get("run_install")), str(data.get("name") or "")),
        meta={"url": url},
    )
    return _job_payload(job)


@app.post("/api/nodes/remove")
def nodes_remove(payload: dict[str, Any] | None = Body(default=None)):
    data = payload or {}
    return nodes.remove_node(str(data.get("dir_name") or ""))


# ----------------------------------------------------------------------- models
def _sort_models(items: list[dict[str, Any]], sort: str) -> list[dict[str, Any]]:
    if sort == "size_desc":
        return sorted(items, key=lambda m: -m["size"])
    if sort == "size_asc":
        return sorted(items, key=lambda m: m["size"])
    if sort == "date_desc":
        return sorted(items, key=lambda m: -m["mtime"])
    if sort == "type":
        return sorted(items, key=lambda m: (m["type"].lower(), m["name"].lower()))
    if sort == "downloads":
        return sorted(
            items,
            key=lambda m: -(((m.get("civitai") or {}).get("stats") or {}).get("downloadCount") or 0),
        )
    return sorted(items, key=lambda m: m["name"].lower())


def _slim_model(m: dict[str, Any]) -> dict[str, Any]:
    civ = m.get("civitai")
    if civ and not civ.get("notFound"):
        civ = {
            "modelId": civ.get("modelId"),
            "versionId": civ.get("versionId"),
            "modelName": civ.get("modelName"),
            "versionName": civ.get("versionName"),
            "baseModel": civ.get("baseModel"),
            "type": civ.get("type"),
            "trainedWords": civ.get("trainedWords") or [],
            "stats": civ.get("stats") or {},
            "pageUrl": civ.get("pageUrl"),
            "creator": civ.get("creator"),
        }
    return {**m, "civitai": civ}


@app.get("/api/models")
def models_list(
    q: str = "",
    type: str = "",
    sort: str = "name",
    matched: str = "",
    favorite: str = "",
    usage: str = "",
    limit: int = 1000,
):
    items = models.scan_models()
    all_summary = models.summary(items)
    used = workflows.model_usage()
    updates = models.update_map()
    for m in items:
        m["used_by"] = len(used.get(m["name"].lower(), []))
        civ = m.get("civitai") or {}
        upd = updates.get(str(civ.get("modelId"))) if civ.get("modelId") else None
        m["update"] = upd if upd and upd.get("versionId") != civ.get("versionId") else None
    if usage == "unused":
        items = [m for m in items if not m["used_by"]]
    elif usage == "used":
        items = [m for m in items if m["used_by"]]
    elif usage == "update":
        items = [m for m in items if m["update"]]
    if type:
        items = [m for m in items if m["type"] == type]
    if matched == "yes":
        items = [m for m in items if m.get("civitai") and not m["civitai"].get("notFound")]
    elif matched == "no":
        items = [m for m in items if not m.get("civitai") or m["civitai"].get("notFound")]
    if favorite == "yes":
        items = [m for m in items if m.get("favorite")]
    if q:
        needle = q.lower()
        def hit(m):
            civ = m.get("civitai") or {}
            local = m.get("local_meta") or {}
            haystack = " ".join(
                str(x)
                for x in (
                    m["name"],
                    m["type"],
                    civ.get("modelName"),
                    civ.get("versionName"),
                    civ.get("baseModel"),
                    local.get("base_model"),
                    " ".join(civ.get("trainedWords") or []),
                    " ".join(local.get("tags") or []),
                )
                if x
            ).lower()
            return needle in haystack
        items = [m for m in items if hit(m)]
    items = _sort_models(items, sort)
    return {
        "items": [_slim_model(m) for m in items[: max(1, min(5000, limit))]],
        "total": len(items),
        "summary": models.summary(items),
        "all_summary": all_summary,
        "roots": models.model_roots(),
    }


@app.get("/api/models/detail")
def models_detail(path: str = Query(...)):
    detail = models.model_detail(path)
    detail["used_in"] = workflows.model_usage().get(detail["name"].lower(), [])
    civ = detail.get("civitai") or {}
    upd = models.update_map().get(str(civ.get("modelId"))) if civ.get("modelId") else None
    detail["update"] = upd if upd and upd.get("versionId") != civ.get("versionId") else None
    return detail


@app.post("/api/models/check-updates")
def models_check_updates():
    job = jobs.submit("models", "检查模型更新", lambda j: models.check_updates(j))
    return _job_payload(job)


@app.get("/api/models/preview")
def models_preview(path: str = Query(...)):
    file = models.preview_file(path)
    if not file:
        raise HTTPException(404, "没有预览图")
    media = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
    }.get(file.suffix.lower(), "application/octet-stream")
    return FileResponse(file, media_type=media, headers={"Cache-Control": "public, max-age=3600"})


@app.get("/api/models/duplicates")
def models_duplicates():
    return {"groups": models.duplicates()}


@app.get("/api/models/roots")
def models_roots():
    return {"roots": models.model_roots()}


@app.post("/api/models/scan")
def models_scan():
    items = models.scan_models()
    return {"items": models.summary(items), "total": len(items)}


@app.post("/api/models/hash")
def models_hash(payload: dict[str, Any] | None = Body(default=None)):
    data = payload or {}
    path = str(data.get("path") or "")
    resolved = Path(path)
    job = jobs.submit(
        "models",
        f"计算哈希：{resolved.name or path}",
        lambda j: models.hash_model(j, path),
        meta={"path": path},
    )
    return _job_payload(job)


@app.post("/api/models/match")
def models_match(payload: dict[str, Any] | None = Body(default=None)):
    data = payload or {}
    path = str(data.get("path") or "")
    resolved = Path(path)
    job = jobs.submit(
        "models",
        f"匹配 CivitAI：{resolved.name or path}",
        lambda j: models.match_model(j, path, bool(data.get("force"))),
        meta={"path": path},
    )
    return _job_payload(job)


@app.post("/api/models/match-all")
def models_match_all(payload: dict[str, Any] | None = Body(default=None)):
    data = payload or {}
    job = jobs.submit(
        "models",
        "批量匹配 CivitAI",
        lambda j: models.match_all(j, bool(data.get("force"))),
    )
    return _job_payload(job)


@app.post("/api/models/rename")
def models_rename(payload: dict[str, Any] | None = Body(default=None)):
    data = payload or {}
    return models.rename_model(str(data.get("path") or ""), str(data.get("new_name") or ""))


@app.post("/api/models/delete")
def models_delete(payload: dict[str, Any] | None = Body(default=None)):
    data = payload or {}
    return models.delete_model(str(data.get("path") or ""))


@app.post("/api/models/reveal")
def models_reveal(payload: dict[str, Any] | None = Body(default=None)):
    data = payload or {}
    models.reveal(str(data.get("path") or ""))
    return {"ok": True}


@app.post("/api/models/flags")
def models_flags(payload: dict[str, Any] | None = Body(default=None)):
    data = payload or {}
    models.set_flags(
        str(data.get("path") or ""),
        favorite=data.get("favorite") if "favorite" in data else None,
        note=data.get("note") if "note" in data else None,
    )
    return {"ok": True}


# ---------------------------------------------------------------------- civitai
@app.get("/api/civitai/search")
def civitai_search(
    query: str = "",
    types: str = "",
    sort: str = "Most Downloaded",
    period: str = "AllTime",
    baseModels: str = "",
    tag: str = "",
    username: str = "",
    cursor: str = "",
    limit: int = 24,
):
    result = civitai.search_models(
        query=query,
        types=[t for t in types.split(",") if t],
        sort=sort,
        period=period,
        base_models=[b for b in baseModels.split(",") if b],
        cursor=cursor or None,
        limit=limit,
        tag=tag,
        username=username,
    )
    installed = models.installed_versions()
    items = []
    for m in result.get("items", []):
        have = installed.get(int(m["id"])) if m.get("id") else None
        slim_versions = [
            {"id": v.get("id"), "name": v.get("name"), "baseModel": v.get("baseModel")}
            for v in (m.get("versions") or [])[:2]
        ]
        items.append({**m, "description": "", "versions": slim_versions, "installed": bool(have)})
    return {**result, "items": items}


@app.get("/api/civitai/models/{model_id}")
def civitai_model(model_id: int):
    model = civitai.get_model(model_id)
    have = models.installed_versions().get(model_id, set())
    return {**model, "installed_versions": sorted(have)}


@app.get("/api/civitai/versions/{version_id}")
def civitai_version(version_id: int):
    return civitai.get_version(version_id)


@app.get("/api/civitai/versions/{version_id}/images")
def civitai_version_images(version_id: int, limit: int = 16):
    return {"items": civitai.get_images(version_id, limit=limit)}


@app.get("/api/civitai/hash/{sha256}")
def civitai_hash(sha256: str):
    return civitai.get_version_by_hash(sha256)


# --------------------------------------------------------------------- downloads
@app.post("/api/downloads")
def downloads_create(payload: dict[str, Any] | None = Body(default=None)):
    data = payload or {}
    if not data.get("version_id") and not data.get("url"):
        raise HTTPException(400, "缺少下载地址。")
    version_id = data.get("version_id")
    title = "下载模型"
    if version_id:
        title = f"下载 CivitAI 版本 #{version_id}"
    elif data.get("filename"):
        title = f"下载 {data['filename']}"
    job = jobs.submit(
        "download",
        title,
        lambda j: downloader.download(
            j,
            {
                "url": data.get("url"),
                "version_id": version_id,
                "file_index": data.get("file_index") or 0,
                "type": data.get("type") or "",
                "filename": data.get("filename") or "",
                "sha256": data.get("sha256") or "",
            },
        ),
        meta={"version_id": version_id},
    )
    return _job_payload(job)


@app.get("/api/jobs")
def jobs_list(active: int = 0, kind: str = ""):
    return {"items": jobs.list(active_only=bool(active), kind=kind or None)}


@app.get("/api/jobs/{job_id}")
def jobs_get(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "任务不存在")
    return job.to_dict(include_log=True)


@app.post("/api/jobs/{job_id}/cancel")
def jobs_cancel(job_id: str):
    if not jobs.cancel(job_id):
        raise HTTPException(400, "任务无法取消")
    return {"ok": True}


# -------------------------------------------------------------------- workflows
@app.get("/api/workflows")
def workflows_list():
    items = workflows.list_workflows()
    return {"items": items, "folders": workflows.folders(), "users": [u for u, _ in workflows.roots()]}


@app.get("/api/workflows/detail")
def workflows_detail(id: str = Query(...)):
    return workflows.read_raw(id)


@app.get("/api/workflows/check")
def workflows_check(id: str = Query(...)):
    return workflows.check(id)


@app.get("/api/workflows/download")
def workflows_download(id: str = Query(...)):
    path = workflows.resolve(id)
    return FileResponse(path, media_type="application/json", filename=path.name)


@app.post("/api/workflows/import")
def workflows_import(payload: dict[str, Any] | None = Body(default=None)):
    data = payload or {}
    try:
        return workflows.import_json(
            str(data.get("content") or ""),
            str(data.get("name") or "workflow"),
            str(data.get("folder") or ""),
            overwrite=bool(data.get("overwrite")),
        )
    except ValueError as exc:
        raise HTTPException(400, f"JSON 解析失败：{exc}") from exc


@app.post("/api/workflows/rename")
def workflows_rename(payload: dict[str, Any] | None = Body(default=None)):
    data = payload or {}
    return workflows.rename(str(data.get("id") or ""), str(data.get("name") or ""))


@app.post("/api/workflows/move")
def workflows_move(payload: dict[str, Any] | None = Body(default=None)):
    data = payload or {}
    return workflows.move(str(data.get("id") or ""), str(data.get("folder") or ""))


@app.post("/api/workflows/duplicate")
def workflows_duplicate(payload: dict[str, Any] | None = Body(default=None)):
    return workflows.duplicate(str((payload or {}).get("id") or ""))


@app.post("/api/workflows/delete")
def workflows_delete(payload: dict[str, Any] | None = Body(default=None)):
    for key in (payload or {}).get("ids") or []:
        workflows.delete(str(key))
    return {"ok": True}


@app.post("/api/workflows/meta")
def workflows_meta(payload: dict[str, Any] | None = Body(default=None)):
    data = payload or {}
    workflows.set_meta(
        str(data.get("id") or ""),
        favorite=data.get("favorite") if "favorite" in data else None,
        tags=data.get("tags") if "tags" in data else None,
        note=data.get("note") if "note" in data else None,
    )
    return {"ok": True}


@app.post("/api/workflows/reveal")
def workflows_reveal(payload: dict[str, Any] | None = Body(default=None)):
    models.reveal(str(workflows.resolve(str((payload or {}).get("id") or ""))))
    return {"ok": True}


# ---------------------------------------------------------------------- gallery
@app.get("/api/gallery")
def gallery_list(
    q: str = "",
    kind: str = "",
    root: str = "",
    folder: str = "",
    favorite: int = 0,
    workflow: int = 0,
    model: str = "",
    sort: str = "new",
    offset: int = 0,
    limit: int = 120,
):
    gallery.ensure_fresh()
    result = gallery.query(q, kind, root, folder, bool(favorite), model, sort, offset, limit, bool(workflow))
    return {**result, "indexer": gallery.indexer.state()}


@app.get("/api/gallery/facets")
def gallery_facets(root: str = ""):
    return {**gallery.facets(root), "roots_info": gallery.roots(), "indexer": gallery.indexer.state()}


@app.post("/api/gallery/scan")
def gallery_scan():
    return {"started": gallery.indexer.start(), "indexer": gallery.indexer.state()}


@app.get("/api/gallery/{image_id}/thumb")
def gallery_thumb(image_id: str):
    try:
        path = gallery.thumb_path(image_id)
    except RuntimeError as exc:
        raise HTTPException(404, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(404, "无法生成缩略图") from exc
    return FileResponse(path, media_type="image/webp", headers={"Cache-Control": "public, max-age=31536000, immutable"})


@app.get("/api/gallery/{image_id}/file")
def gallery_file(image_id: str):
    try:
        path = gallery.path_of(image_id)
    except RuntimeError as exc:
        raise HTTPException(404, str(exc)) from exc
    return FileResponse(path, headers={"Cache-Control": "public, max-age=3600"})


@app.get("/api/gallery/{image_id}/detail")
def gallery_detail(image_id: str):
    return gallery.detail(image_id)


@app.get("/api/gallery/{image_id}/workflow")
def gallery_workflow(image_id: str):
    data, _kind = gallery.extract_workflow(image_id)
    name = Path(gallery.get(image_id)["name"]).stem
    return Response(
        json.dumps(data, ensure_ascii=False, indent=2),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{name}.json"'},
    )


@app.post("/api/gallery/save-workflow")
def gallery_save_workflow(payload: dict[str, Any] | None = Body(default=None)):
    data = payload or {}
    image_id = str(data.get("id") or "")
    wf, kind = gallery.extract_workflow(image_id)
    name = str(data.get("name") or Path(gallery.get(image_id)["name"]).stem)
    out = workflows.import_json(wf, name, str(data.get("folder") or "from-gallery"))
    return {**out, "kind": kind}


@app.post("/api/gallery/flags")
def gallery_flags(payload: dict[str, Any] | None = Body(default=None)):
    data = payload or {}
    gallery.set_flags(
        [str(i) for i in data.get("ids") or []],
        favorite=data.get("favorite") if "favorite" in data else None,
        note=data.get("note") if "note" in data else None,
    )
    return {"ok": True}


@app.post("/api/gallery/delete")
def gallery_delete(payload: dict[str, Any] | None = Body(default=None)):
    return {"deleted": gallery.delete([str(i) for i in (payload or {}).get("ids") or []])}


@app.post("/api/gallery/to-input")
def gallery_to_input(payload: dict[str, Any] | None = Body(default=None)):
    return {"name": gallery.copy_to_input(str((payload or {}).get("id") or ""))}


@app.post("/api/gallery/reveal")
def gallery_reveal(payload: dict[str, Any] | None = Body(default=None)):
    models.reveal(str(gallery.path_of(str((payload or {}).get("id") or ""))))
    return {"ok": True}


# ------------------------------------------------------------------------ trash
@app.get("/api/trash")
def trash_list():
    return {"items": trash.list_items(), "summary": trash.summary()}


@app.post("/api/trash/restore")
def trash_restore(payload: dict[str, Any] | None = Body(default=None)):
    out = trash.restore(str((payload or {}).get("id") or ""))
    models.invalidate_scan()
    if out["kind"] == "image":
        gallery.indexer.start()
    return out


@app.post("/api/trash/purge")
def trash_purge(payload: dict[str, Any] | None = Body(default=None)):
    data = payload or {}
    if data.get("all"):
        return {"purged": trash.empty(str(data.get("kind") or ""))}
    trash.purge(str(data.get("id") or ""))
    return {"purged": 1}


# --------------------------------------------------------------------- paths
_BROWSE_PS = r"""
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'
$kind = $env:CD_BROWSE_KIND
$initial = $env:CD_BROWSE_INITIAL
$title = $env:CD_BROWSE_TITLE
$out = $env:CD_BROWSE_OUT
$owner = New-Object System.Windows.Forms.Form
$owner.Text = $title
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = 'None'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.StartPosition = 'CenterScreen'
$owner.Opacity = 0
try {
    $owner.Show()
    if ($kind -eq 'file') {
        $dlg = New-Object System.Windows.Forms.OpenFileDialog
        $dlg.Title = $title
        $dlg.Filter = 'Python (python.exe)|python.exe|可执行文件 (*.exe)|*.exe|所有文件 (*.*)|*.*'
        $dlg.CheckFileExists = $true
        if ($initial -and (Test-Path -LiteralPath $initial)) {
            if (Test-Path -LiteralPath $initial -PathType Container) {
                $dlg.InitialDirectory = $initial
            } else {
                $dlg.InitialDirectory = Split-Path -LiteralPath $initial -Parent
                $dlg.FileName = $initial
            }
        }
        if ($dlg.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
            [System.IO.File]::WriteAllText($out, $dlg.FileName, [System.Text.Encoding]::UTF8)
        }
    } else {
        $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
        $dlg.Description = $title
        $dlg.ShowNewFolderButton = $false
        if ($initial -and (Test-Path -LiteralPath $initial -PathType Container)) {
            $dlg.SelectedPath = $initial
        }
        if ($dlg.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
            [System.IO.File]::WriteAllText($out, $dlg.SelectedPath, [System.Text.Encoding]::UTF8)
        }
    }
} finally {
    $owner.Close()
    $owner.Dispose()
}
"""


def _known_comfy_dirs() -> list[str]:
    current = str(config.get("comfy_dir") or "")
    return [current] if current else []


def _browse_initial(kind: str) -> str:
    comfy = str(config.get("comfy_dir") or "")
    if kind == "python":
        python = str(config.get("python_exe") or "")
        if python and Path(python).is_file():
            return python
    if comfy:
        path = Path(comfy)
        if path.is_dir():
            return str(path)
        if path.parent.is_dir():
            return str(path.parent)
    return str(Path.home())


@app.get("/api/paths/detect")
def paths_detect(deep: bool = False):
    items = pathutil.detect_installations(deep=deep, known=_known_comfy_dirs())
    return {"items": items, "count": len(items), "deep": deep}


@app.get("/api/paths/validate")
def paths_validate(path: str = ""):
    target = Path(path).expanduser() if path.strip() else None
    exists = bool(target and target.is_dir())
    is_comfy = bool(target and pathutil.is_comfy_dir(target))
    return {
        "path": str(target) if target else "",
        "exists": exists,
        "is_comfy": is_comfy,
        "python_exe": pathutil.python_for(target) if target else "",
    }


@app.post("/api/paths/browse")
def paths_browse(payload: dict[str, Any] | None = Body(default=None)):
    """Open the native Windows folder / file picker on the server machine."""
    if os.name != "nt":
        raise HTTPException(501, "原生选择器仅支持 Windows，请直接填写路径。")
    data = payload or {}
    kind = "file" if str(data.get("kind") or "") == "python" else "dir"
    title = str(data.get("title") or ("选择 python.exe" if kind == "file" else "选择 ComfyUI 目录"))
    initial = str(data.get("initial") or _browse_initial("python" if kind == "file" else "comfy"))
    tmp_dir = DATA_DIR / "tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    fd, out_path = tempfile.mkstemp(prefix="browse-", suffix=".txt", dir=str(tmp_dir))
    os.close(fd)
    try:
        env = os.environ.copy()
        env.update(
            CD_BROWSE_KIND=kind,
            CD_BROWSE_INITIAL=initial,
            CD_BROWSE_TITLE=title,
            CD_BROWSE_OUT=out_path,
        )
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        try:
            proc = subprocess.run(
                [
                    "powershell.exe", "-NoProfile", "-NonInteractive", "-STA",
                    "-ExecutionPolicy", "Bypass", "-Command", "-",
                ],
                input=_BROWSE_PS,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=600,
                env=env,
                creationflags=flags,
            )
        except subprocess.TimeoutExpired as exc:
            raise HTTPException(504, "选择窗口超时，已取消。") from exc
        if proc.returncode != 0:
            detail = (proc.stderr or proc.stdout or "").strip() or f"退出码 {proc.returncode}"
            raise HTTPException(500, f"无法打开系统选择窗口：{detail}")
        try:
            selected = Path(out_path).read_text(encoding="utf-8").strip()
        except OSError:
            selected = ""
        result: dict[str, Any] = {"path": selected, "cancelled": not selected}
        if selected and kind == "dir":
            result["is_comfy"] = pathutil.is_comfy_dir(selected)
            result["python_exe"] = pathutil.python_for(selected)
        return result
    finally:
        try:
            os.unlink(out_path)
        except OSError:
            pass


# ---------------------------------------------------------------------- settings
@app.get("/api/settings")
def settings_get():
    comfy_path = Path(config.get("comfy_dir") or ".")
    comfy_exists = (comfy_path / "main.py").is_file()
    suggestions = [] if comfy_exists else pathutil.detect_installations(known=_known_comfy_dirs())[:6]
    return {
        "settings": config.public(),
        "paths": {
            "comfy": str(config.comfy_dir),
            "models": str(config.models_dir),
            "custom_nodes": str(config.custom_nodes),
            "data": str(DATA_DIR),
            "logs": str(LOG_DIR),
            "previews": str(PREVIEW_DIR),
            "manager": str(BASE_DIR),
        },
        "roots": models.model_roots(),
        "comfy_exists": comfy_exists,
        "python_exists": Path(config.python_exe).is_file(),
        "suggestions": suggestions,
        "version": __version__,
        "frozen": FROZEN,
    }



@app.post("/api/settings")
def settings_save(payload: dict[str, Any] | None = Body(default=None)):
    data = payload or {}
    patch: dict[str, Any] = {}
    python_auto = False
    for key in (
        "comfy_dir", "python_exe", "extra_model_paths", "civitai_api_key",
        "github_token", "hf_token", "proxy", "nsfw", "max_downloads",
        "hash_workers", "open_browser", "comfy_port", "auto_start_comfy",
        "theme", "gallery_extra_dirs",
    ):
        if key not in data:
            continue
        value = data[key]
        if key in ("civitai_api_key", "github_token", "hf_token"):
            if isinstance(value, str) and value.startswith("•"):
                continue
        if key == "comfy_dir":
            text = str(value or "").strip()
            if not text:
                value = ""
            else:
                path = Path(text).expanduser()
                if not pathutil.is_comfy_dir(path):
                    raise HTTPException(400, f"该目录不是 ComfyUI（缺少 main.py）：{path}")
                value = str(path)
        if key == "python_exe":
            text = str(value or "").strip()
            if not text:
                value = ""
            else:
                path = Path(text).expanduser()
                if not path.exists():
                    raise HTTPException(400, f"Python 不存在：{path}")
                value = str(path)
        patch[key] = value
    if "comfy_dir" in patch and not patch.get("python_exe"):
        detected = pathutil.python_for(patch["comfy_dir"]) if patch["comfy_dir"] else ""
        if detected:
            patch["python_exe"] = detected
            python_auto = True
    before = {
        "comfy_dir": config.get("comfy_dir"),
        "civitai_api_key": config.get("civitai_api_key"),
        "nsfw": config.get("nsfw"),
    }
    config.update(patch)
    if (
        before["comfy_dir"] != config.get("comfy_dir")
        or before["civitai_api_key"] != config.get("civitai_api_key")
        or before["nsfw"] != config.get("nsfw")
    ):
        db.delete_kv("civitai:")
        db.delete_kv("core:")
    return {
        "settings": config.public(),
        "roots": models.model_roots(),
        "python_auto": python_auto,
        "python_exists": Path(config.python_exe).is_file(),
        "comfy_exists": pathutil.is_comfy_dir(config.get("comfy_dir")),
    }


@app.post("/api/settings/test-civitai")
def settings_test_civitai():
    try:
        result = civitai.search_models(query="", limit=1)
        return {"ok": True, "items": len(result.get("items") or [])}
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"ok": False, "detail": str(exc)}, status_code=502)


@app.post("/api/cache/clear")
def cache_clear(payload: dict[str, Any] | None = Body(default=None)):
    data = payload or {}
    prefix = str(data.get("prefix") or "")
    if prefix == "thumbs":
        return {"cleared": gallery.clear_thumbs()}
    if prefix and prefix not in ("civitai:", "core:", "registry:", "nodes:"):
        raise HTTPException(400, "不支持的缓存前缀")
    count = db.delete_kv(prefix)
    return {"cleared": count}


@app.post("/api/open-folder")
def open_folder(payload: dict[str, Any] | None = Body(default=None)):
    data = payload or {}
    kind = str(data.get("kind") or "")
    mapping = {
        "comfy": config.comfy_dir,
        "models": config.models_dir,
        "custom_nodes": config.custom_nodes,
        "data": DATA_DIR,
        "logs": LOG_DIR,
        "previews": PREVIEW_DIR,
        "output": config.comfy_dir / "output",
        "input": config.comfy_dir / "input",
        "workflows": config.comfy_dir / "user" / "default" / "workflows",
        "trash": DATA_DIR / "trash",
    }
    path = mapping.get(kind)
    if not path:
        raise HTTPException(400, "未知目录")
    if not path.exists():
        raise HTTPException(404, "目录不存在")
    if os.name == "nt":
        os.startfile(str(path))  # type: ignore[attr-defined]
    else:
        subprocess.Popen(["xdg-open", str(path)])
    return {"ok": True}


@app.post("/api/quit")
def quit_app():
    """Stop the local server (used by the packaged build's 退出 button)."""
    global _UVICORN_SERVER
    server = _UVICORN_SERVER

    def stop() -> None:
        time.sleep(0.2)
        if server is not None:
            server.should_exit = True
        time.sleep(5)
        os._exit(0)

    threading.Thread(target=stop, daemon=True).start()
    return {"ok": True}


def main() -> None:
    import argparse
    import webbrowser

    global _UVICORN_SERVER

    parser = argparse.ArgumentParser(description="ComfyDeck - local ComfyUI manager")
    parser.add_argument("--host", default=config.get("host") or "127.0.0.1")
    parser.add_argument("--port", type=int, default=int(config.get("port") or 8288))
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    url = f"http://{args.host}:{args.port}"
    print("=" * 62)
    print(f"  ComfyDeck · ComfyUI 管理器  v{__version__}")
    print(f"  {url}")
    print(f"  ComfyUI: {config.comfy_dir}")
    print(f"  数据目录: {DATA_DIR}")
    print("  按 Ctrl+C 停止")
    print("=" * 62)
    if not args.no_browser and config.get("open_browser") is not False:
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()

    import uvicorn

    _UVICORN_SERVER = uvicorn.Server(
        uvicorn.Config(app, host=args.host, port=args.port, log_level="info")
    )
    _UVICORN_SERVER.run()


if __name__ == "__main__":
    main()
