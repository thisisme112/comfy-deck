"""Small SQLite layer for metadata / API caches."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from typing import Any

from .config import DB_PATH

_SCHEMA = """
CREATE TABLE IF NOT EXISTS model_meta (
    path TEXT PRIMARY KEY,
    sha256 TEXT,
    size INTEGER,
    mtime REAL,
    local_meta TEXT,
    civitai TEXT,
    preview TEXT,
    favorite INTEGER DEFAULT 0,
    note TEXT DEFAULT '',
    updated_at REAL
);
CREATE INDEX IF NOT EXISTS idx_model_sha ON model_meta(sha256);
CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at REAL
);
CREATE TABLE IF NOT EXISTS workflow_meta (
    rel TEXT PRIMARY KEY,
    favorite INTEGER DEFAULT 0,
    tags TEXT DEFAULT '',
    note TEXT DEFAULT '',
    updated_at REAL
);
CREATE TABLE IF NOT EXISTS gallery (
    id TEXT PRIMARY KEY,
    path TEXT UNIQUE,
    root TEXT,
    rel TEXT,
    folder TEXT DEFAULT '',
    name TEXT,
    ext TEXT,
    kind TEXT,
    size INTEGER,
    mtime REAL,
    width INTEGER,
    height INTEGER,
    prompt TEXT DEFAULT '',
    negative TEXT DEFAULT '',
    model TEXT DEFAULT '',
    loras TEXT DEFAULT '',
    seed TEXT DEFAULT '',
    steps INTEGER,
    cfg REAL,
    sampler TEXT DEFAULT '',
    scheduler TEXT DEFAULT '',
    has_workflow INTEGER DEFAULT 0,
    favorite INTEGER DEFAULT 0,
    note TEXT DEFAULT '',
    indexed_at REAL
);
CREATE INDEX IF NOT EXISTS idx_gallery_mtime ON gallery(mtime);
CREATE INDEX IF NOT EXISTS idx_gallery_root ON gallery(root, folder);
"""


class Database:
    def __init__(self, path=DB_PATH) -> None:
        self.path = str(path)
        self._lock = threading.RLock()
        self.model_rev = 0
        self._conn = sqlite3.connect(self.path, check_same_thread=False, timeout=30)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.executescript(_SCHEMA)
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA synchronous=NORMAL")
            self._conn.commit()

    # ----------------------------------------------------------------- generic
    def query(self, sql: str, params: tuple | list = ()) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]

    def execute(self, sql: str, params: tuple | list = ()) -> int:
        with self._lock:
            cur = self._conn.execute(sql, params)
            self._conn.commit()
            return cur.rowcount

    def executemany(self, sql: str, seq: list[tuple]) -> None:
        with self._lock:
            self._conn.executemany(sql, seq)
            self._conn.commit()

    # ------------------------------------------------------------------ models
    def model_meta(self, path: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM model_meta WHERE path=?", (str(path),)
            ).fetchone()
        if not row:
            return None
        data = dict(row)
        for key in ("local_meta", "civitai"):
            if data.get(key):
                try:
                    data[key] = json.loads(data[key])
                except Exception:
                    data[key] = None
        return data

    def all_model_meta(self) -> dict[str, dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute("SELECT * FROM model_meta").fetchall()
        out: dict[str, dict[str, Any]] = {}
        for row in rows:
            data = dict(row)
            for key in ("local_meta", "civitai"):
                if data.get(key):
                    try:
                        data[key] = json.loads(data[key])
                    except Exception:
                        data[key] = None
            out[data["path"]] = data
        return out

    def upsert_model(self, path: str, **fields: Any) -> None:
        path = str(path)
        allowed = {"sha256", "size", "mtime", "local_meta", "civitai", "preview", "favorite", "note"}
        fields = {k: v for k, v in fields.items() if k in allowed}
        for key in ("local_meta", "civitai"):
            if key in fields and fields[key] is not None and not isinstance(fields[key], str):
                fields[key] = json.dumps(fields[key], ensure_ascii=False)
        fields["updated_at"] = time.time()
        with self._lock:
            exists = self._conn.execute(
                "SELECT 1 FROM model_meta WHERE path=?", (path,)
            ).fetchone()
            if exists:
                cols = ", ".join(f"{k}=?" for k in fields)
                self._conn.execute(
                    f"UPDATE model_meta SET {cols} WHERE path=?",
                    (*fields.values(), path),
                )
            else:
                cols = ", ".join(["path", *fields.keys()])
                marks = ", ".join(["?"] * (len(fields) + 1))
                self._conn.execute(
                    f"INSERT INTO model_meta ({cols}) VALUES ({marks})",
                    (path, *fields.values()),
                )
            self._conn.commit()
            self.model_rev += 1

    def delete_model(self, path: str) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM model_meta WHERE path=?", (str(path),))
            self._conn.commit()
            self.model_rev += 1

    def models_by_sha(self, sha: str) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM model_meta WHERE sha256=?", (sha.upper(),)
            ).fetchall()
        out = []
        for row in rows:
            data = dict(row)
            if data.get("civitai"):
                try:
                    data["civitai"] = json.loads(data["civitai"])
                except Exception:
                    pass
            out.append(data)
        return out

    # ---------------------------------------------------------------------- kv
    def get_json(self, key: str, ttl: float | None = None) -> Any:
        with self._lock:
            row = self._conn.execute("SELECT value, updated_at FROM kv WHERE key=?", (key,)).fetchone()
        if not row:
            return None
        if ttl is not None and time.time() - (row["updated_at"] or 0) > ttl:
            return None
        try:
            return json.loads(row["value"])
        except Exception:
            return None

    def set_json(self, key: str, value: Any) -> None:
        payload = json.dumps(value, ensure_ascii=False)
        with self._lock:
            self._conn.execute(
                "INSERT INTO kv (key, value, updated_at) VALUES (?,?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
                (key, payload, time.time()),
            )
            self._conn.commit()

    def delete_kv(self, prefix: str = "") -> int:
        with self._lock:
            if prefix:
                cur = self._conn.execute("DELETE FROM kv WHERE key LIKE ?", (prefix + "%",))
            else:
                cur = self._conn.execute("DELETE FROM kv")
            self._conn.commit()
            return cur.rowcount


db = Database()
