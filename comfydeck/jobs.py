"""In-process background jobs with progress + logs, polled by the web UI."""
from __future__ import annotations

import threading
import time
import traceback
from collections import OrderedDict
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from .config import LOG_DIR


class JobCancelled(Exception):
    pass


class Job:
    def __init__(self, job_id: str, kind: str, title: str, meta: dict[str, Any] | None = None):
        self.id = job_id
        self.kind = kind
        self.title = title
        self.meta = meta or {}
        self.status = "queued"
        self.progress = 0.0
        self.message = "等待中…"
        self.result: Any = None
        self.error = ""
        self.created = time.time()
        self.started = 0.0
        self.finished = 0.0
        self.cancel_event = threading.Event()
        self._logs: list[str] = []
        self._lock = threading.RLock()

    def log(self, line: str) -> None:
        line = str(line).rstrip()
        if not line:
            return
        stamp = datetime.now().strftime("%H:%M:%S")
        with self._lock:
            for sub in line.splitlines():
                self._logs.append(f"[{stamp}] {sub}")
            if len(self._logs) > 4000:
                self._logs = self._logs[-4000:]

    def set_progress(self, pct: float, message: str | None = None) -> None:
        with self._lock:
            self.progress = max(0.0, min(100.0, float(pct)))
            if message is not None:
                self.message = message

    def raise_if_cancelled(self) -> None:
        if self.cancel_event.is_set():
            raise JobCancelled("任务已取消")

    def to_dict(self, include_log: bool = False) -> dict[str, Any]:
        with self._lock:
            data = {
                "id": self.id,
                "kind": self.kind,
                "title": self.title,
                "status": self.status,
                "progress": round(self.progress, 1),
                "message": self.message,
                "result": self.result,
                "error": self.error,
                "created": self.created,
                "started": self.started,
                "finished": self.finished,
                "meta": self.meta,
                "cancelled": self.cancel_event.is_set(),
                "log_lines": len(self._logs),
            }
            if include_log:
                data["log"] = "\n".join(self._logs)
        return data

    def save_log(self) -> None:
        try:
            with self._lock:
                text = "\n".join(self._logs)
            path = LOG_DIR / f"{self.id}.log"
            path.write_text(
                f"# {self.title}\n# status={self.status}\n\n{text}\n", "utf-8"
            )
        except Exception:
            pass


class JobManager:
    def __init__(self) -> None:
        self._jobs: "OrderedDict[str, Job]" = OrderedDict()
        self._lock = threading.RLock()
        self._counter = 0

    def _new_id(self) -> str:
        with self._lock:
            self._counter += 1
            return f"j{int(time.time() * 1000):x}{self._counter:02x}"

    def submit(
        self,
        kind: str,
        title: str,
        fn: Callable[[Job], Any],
        meta: dict[str, Any] | None = None,
    ) -> Job:
        job = Job(self._new_id(), kind, title, meta)
        with self._lock:
            self._jobs[job.id] = job
            while len(self._jobs) > 120:
                _, old = self._jobs.popitem(last=False)
                if old.status in ("queued", "running"):
                    self._jobs[old.id] = old
                    break

        def runner() -> None:
            job.status = "running"
            job.started = time.time()
            job.message = "运行中…"
            job.log(f"▶ {title}")
            try:
                result = fn(job)
                if job.cancel_event.is_set():
                    raise JobCancelled("任务已取消")
                job.result = result
                job.status = "done"
                job.progress = 100.0
                job.message = "完成"
                job.log("✓ 完成")
            except JobCancelled as exc:
                job.status = "cancelled"
                job.message = str(exc) or "已取消"
                job.log(f"■ {job.message}")
            except Exception as exc:  # noqa: BLE001
                job.status = "error"
                job.error = str(exc)
                job.message = str(exc) or "失败"
                job.log(f"✗ {exc}")
                job.log(traceback.format_exc())
            finally:
                job.finished = time.time()
                job.save_log()

        thread = threading.Thread(target=runner, name=f"job-{job.id}", daemon=True)
        thread.start()
        return job

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def list(self, active_only: bool = False, kind: str | None = None) -> list[dict[str, Any]]:
        with self._lock:
            jobs = list(self._jobs.values())[::-1]
        if active_only:
            jobs = [j for j in jobs if j.status in ("queued", "running")]
        if kind:
            jobs = [j for j in jobs if j.kind == kind]
        return [j.to_dict() for j in jobs]

    def cancel(self, job_id: str) -> bool:
        job = self.get(job_id)
        if not job or job.status not in ("queued", "running"):
            return False
        job.cancel_event.set()
        job.message = "正在取消…"
        job.log("正在取消…")
        return True


jobs = JobManager()
