"""Resumable model downloads (CivitAI / Hugging Face / direct URLs)."""
from __future__ import annotations

import hashlib
import re
import threading
import time
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

import requests

from . import civitai, models
from .config import config
from .db import db
from .jobs import Job, JobCancelled
from .util import safe_filename

_sem = None
_sem_lock = threading.Lock()


def _semaphore():
    global _sem
    with _sem_lock:
        if _sem is None:
            _sem = threading.BoundedSemaphore(
                max(1, min(6, int(config.get("max_downloads") or 2)))
            )
        return _sem


def _filename_from_disposition(header: str) -> str:
    if not header:
        return ""
    match = re.search(r"filename\*\s*=\s*UTF-8''([^;]+)", header, re.I)
    if match:
        return unquote(match.group(1).strip().strip('"'))
    match = re.search(r'filename\s*=\s*"?([^";]+)"?', header, re.I)
    return match.group(1).strip() if match else ""


def _unique_path(folder: Path, filename: str) -> Path:
    target = folder / filename
    if not target.exists():
        return target
    stem, suffix = target.stem, target.suffix
    for idx in range(1, 1000):
        candidate = folder / f"{stem} ({idx}){suffix}"
        if not candidate.exists():
            return candidate
    raise RuntimeError("无法生成唯一文件名")


def _human_speed(bps: float) -> str:
    if bps > 1024 * 1024:
        return f"{bps / 1024 / 1024:.1f} MB/s"
    if bps > 1024:
        return f"{bps / 1024:.0f} KB/s"
    return f"{bps:.0f} B/s"


def _civitai_spec(version_id: int, file_index: int = 0) -> dict[str, Any]:
    version = civitai.get_version(version_id)
    files = version.get("files") or []
    if not files:
        raise RuntimeError("该版本没有可下载的文件。")
    if file_index < 0 or file_index >= len(files):
        file_index = 0
    file = files[file_index]
    model = None
    if version.get("modelId"):
        try:
            model = civitai.get_model(version["modelId"])
        except Exception:
            model = None
    return {
        "url": civitai.download_file_url(version, file_index),
        "filename": safe_filename(file.get("name") or f"{version.get('modelName', 'model')}.safetensors"),
        "sha256": file.get("sha256") or "",
        "type": version.get("modelType") or (model or {}).get("type") or "Checkpoint",
        "version": version,
        "model": model,
    }


def download(job: Job, spec: dict[str, Any]) -> dict[str, Any]:
    version = None
    model = None
    if spec.get("version_id"):
        job.set_progress(1, "获取 CivitAI 版本信息…")
        info = _civitai_spec(int(spec["version_id"]), int(spec.get("file_index") or 0))
        version = info["version"]
        model = info["model"]
        for key in ("url", "filename", "sha256"):
            if not spec.get(key):
                spec[key] = info[key]
        if not spec.get("type"):
            spec["type"] = info["type"]
    if not spec.get("url"):
        raise RuntimeError("缺少下载地址。")
    if spec.get("type") and spec["type"] in civitai.TYPE_TO_DIR:
        type_name = spec["type"]
    else:
        type_name = spec.get("type") or "Checkpoint"
    folder = models.target_dir(type_name)
    filename = safe_filename(spec.get("filename") or Path(urlparse(spec["url"]).path).name)
    target = _unique_path(folder, filename)
    part = target.with_suffix(target.suffix + ".part")

    sem = _semaphore()
    if not sem.acquire(timeout=0.2):
        job.message = "等待下载队列…"
        job.log("下载队列已满，等待中…")
        while not sem.acquire(timeout=0.5):
            job.raise_if_cancelled()

    try:
        job.set_progress(5, "连接下载服务器…")
        job.log(f"目标：{target}")
        existing = part.stat().st_size if part.exists() else 0
        if existing:
            job.log(f"发现未完成文件，从 {existing} 字节继续。")
        resp = None
        for attempt in range(2):
            headers = {"User-Agent": "ComfyDeck/1.0"}
            if existing and attempt == 0:
                headers["Range"] = f"bytes={existing}-"
            try:
                resp = requests.get(
                    spec["url"],
                    headers=headers,
                    proxies=config.proxies(),
                    timeout=(30, 180),
                    stream=True,
                    allow_redirects=True,
                )
            except requests.RequestException as exc:
                raise RuntimeError(f"连接失败：{exc}") from exc
            if resp.status_code == 416 and existing:
                resp.close()
                part.unlink(missing_ok=True)
                existing = 0
                job.log("续传位置无效，重新下载。")
                continue
            break
        if resp is None:
            raise RuntimeError("无法建立下载连接。")
        if resp.status_code in (401, 403):
            raise RuntimeError("下载被拒绝（需要登录或 CivitAI API Key）。")
        if resp.status_code == 404:
            raise RuntimeError("下载地址不存在（HTTP 404）。")
        if resp.status_code not in (200, 206):
            raise RuntimeError(f"下载失败（HTTP {resp.status_code}）。")
        if resp.status_code == 200 and existing:
            existing = 0
            job.log("服务器不支持断点续传，重新下载。")
        total_header = resp.headers.get("content-length")
        total = int(total_header) + existing if total_header and total_header.isdigit() else 0
        mode = "ab" if existing and resp.status_code == 206 else "wb"
        done = existing
        last_update = 0.0
        last_time = time.time()
        last_bytes = done
        with part.open(mode) as fh:
            for chunk in resp.iter_content(1024 * 1024):
                job.raise_if_cancelled()
                if not chunk:
                    continue
                fh.write(chunk)
                done += len(chunk)
                now = time.time()
                if now - last_update > 0.4:
                    if total:
                        pct = 5 + done / total * 90
                        speed = (done - last_bytes) / max(0.001, now - last_time)
                        job.set_progress(
                            pct,
                            f"{done / 1024 / 1024:.0f}/{total / 1024 / 1024:.0f} MB · {_human_speed(speed)}",
                        )
                    else:
                        job.set_progress(
                            50, f"{done / 1024 / 1024:.0f} MB 已下载"
                        )
                    last_update = now
                    last_time = now
                    last_bytes = done
        resp.close()
        if total and done < total:
            raise RuntimeError(f"下载不完整（{done}/{total} 字节），已保留 .part 以便续传。")

        expected = (spec.get("sha256") or "").strip().upper()
        if expected:
            job.set_progress(96, "校验 SHA256…")
            actual = hashlib.sha256()
            with part.open("rb") as fh:
                while True:
                    job.raise_if_cancelled()
                    chunk = fh.read(8 * 1024 * 1024)
                    if not chunk:
                        break
                    actual.update(chunk)
            actual_hex = actual.hexdigest().upper()
            if actual_hex != expected:
                bad = part.with_suffix(part.suffix + ".bad")
                part.replace(bad)
                raise RuntimeError(
                    f"SHA256 校验失败，文件已重命名为 {bad.name}（期望 {expected[:12]}…，实际 {actual_hex[:12]}…）"
                )
            job.log("SHA256 校验通过")
        target.parent.mkdir(parents=True, exist_ok=True)
        part.replace(target)
        job.set_progress(98, "写入模型库…")
        if version:
            try:
                models.apply_download_meta(target, version, model, expected)
            except Exception as exc:  # noqa: BLE001
                job.log(f"元数据写入失败（文件已下载）：{exc}")
        db.upsert_model(
            str(target),
            size=target.stat().st_size,
            mtime=target.stat().st_mtime,
            sha256=expected or None,
        )
        job.log(f"✓ 已保存：{target}")
        return {
            "path": str(target),
            "name": target.name,
            "size": target.stat().st_size,
            "type": type_name,
            "sha256": expected,
        }
    except JobCancelled:
        job.log("下载已取消，.part 文件已保留，可稍后续传。")
        raise
    finally:
        sem.release()
