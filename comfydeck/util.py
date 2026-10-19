"""Shared helpers."""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import time
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Callable, Iterable

try:
    import tomllib
except Exception:  # pragma: no cover
    tomllib = None  # type: ignore


def now() -> float:
    return time.time()


def human_size(num: float | int | None) -> str:
    if not num:
        return "0 B"
    num = float(num)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if num < 1024 or unit == "TB":
            return f"{num:.0f} {unit}" if unit == "B" else f"{num:.2f} {unit}"
        num /= 1024
    return f"{num:.2f} TB"


def model_id(path: str | Path) -> str:
    return hashlib.sha1(str(path).lower().encode("utf-8", "surrogatepass")).hexdigest()[:20]


def sha256_file(
    path: str | Path,
    progress: Callable[[int, int], None] | None = None,
    cancel=None,
) -> str:
    p = Path(path)
    total = p.stat().st_size
    digest = hashlib.sha256()
    done = 0
    with p.open("rb") as fh:
        while True:
            if cancel is not None and cancel.is_set():
                raise RuntimeError("已取消")
            chunk = fh.read(4 * 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            done += len(chunk)
            if progress:
                progress(done, total)
    return digest.hexdigest().upper()


class _TextExtractor(HTMLParser):
    _BLOCK = {
        "p", "div", "br", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5",
        "h6", "tr", "table", "section", "article", "blockquote", "pre", "hr",
        "summary", "details",
    }

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self._skip += 1
        elif tag in self._BLOCK:
            self.parts.append("\n")
        elif tag == "img":
            alt = dict(attrs).get("alt")
            if alt:
                self.parts.append(alt)

    def handle_endtag(self, tag):
        if tag in ("script", "style") and self._skip:
            self._skip -= 1
        elif tag in self._BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self._skip:
            self.parts.append(data)


def html_to_text(html: str | None, limit: int = 30000) -> str:
    if not html:
        return ""
    parser = _TextExtractor()
    try:
        parser.feed(html)
    except Exception:
        text = re.sub(r"<[^>]+>", " ", html)
    else:
        text = "".join(parser.parts)
    text = text.replace("\r", "")
    text = re.sub(r"[ \t\f\v]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    lines = [line.strip() for line in text.split("\n")]
    text = "\n".join(lines)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()[:limit]


def read_pyproject(path: Path) -> dict[str, Any]:
    file = path / "pyproject.toml"
    if not file.exists() or tomllib is None:
        return {}
    try:
        data = tomllib.loads(file.read_text("utf-8", errors="replace"))
    except Exception:
        return {}
    project = data.get("project") or {}
    urls = project.get("urls") or {}
    comfy = (data.get("tool") or {}).get("comfy") or {}
    repo = None
    for key in ("Repository", "repository", "Homepage", "homepage", "Source", "source"):
        if urls.get(key):
            repo = urls[key]
            break
    return {
        "name": project.get("name") or comfy.get("DisplayName") or "",
        "version": str(project.get("version") or ""),
        "description": project.get("description") or "",
        "repo": repo,
        "display_name": comfy.get("DisplayName") or "",
        "publisher": comfy.get("PublisherId") or "",
    }


def safe_filename(name: str, fallback: str = "model.safetensors") -> str:
    name = (name or "").strip().replace("\\", "_").replace("/", "_")
    name = re.sub(r'[<>:"|?*\x00-\x1f]', "_", name)
    name = name.strip(" .")
    if not name:
        name = fallback
    if len(name) > 180:
        stem, dot, ext = name.rpartition(".")
        if dot and len(ext) <= 10:
            name = stem[: 180 - len(ext) - 1] + "." + ext
        else:
            name = name[:180]
    return name


def is_subpath(path: str | Path, root: str | Path) -> bool:
    try:
        p = Path(path).resolve()
        r = Path(root).resolve()
        return p == r or r in p.parents
    except Exception:
        return False


def run_command(
    cmd: Iterable[str],
    cwd: str | Path | None = None,
    timeout: int = 300,
    env: dict[str, str] | None = None,
) -> tuple[int, str]:
    cmd = [str(c) for c in cmd]
    run_env = os.environ.copy()
    run_env.update(
        {
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_ASKPASS": "echo",
            "GCM_INTERACTIVE": "never",
            "PYTHONIOENCODING": "utf-8",
            "PIP_DISABLE_PIP_VERSION_CHECK": "1",
        }
    )
    if env:
        run_env.update(env)
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(cwd) if cwd else None,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout,
            env=run_env,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        out = proc.stdout.decode("utf-8", errors="replace")
        if len(out) > 200_000:
            out = out[:80_000] + "\n... (输出过长已截断) ...\n" + out[-80_000:]
        return proc.returncode, out
    except subprocess.TimeoutExpired as exc:
        out = (exc.stdout or b"").decode("utf-8", errors="replace") if isinstance(exc.stdout, bytes) else ""
        return -1, out + f"\n命令超时（{timeout}s）"
    except FileNotFoundError:
        return -1, f"找不到命令: {cmd[0]}"


def atomic_write_json(path: str | Path, data: Any) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), "utf-8")
    tmp.replace(p)


def read_json(path: str | Path, default: Any = None) -> Any:
    try:
        return json.loads(Path(path).read_text("utf-8"))
    except Exception:
        return default


def version_tuple(text: str) -> tuple[int, ...]:
    nums = re.findall(r"\d+", text or "")
    return tuple(int(n) for n in nums[:4]) if nums else ()


def trim_text(text: str | None, limit: int = 500) -> str:
    text = (text or "").strip().replace("\n", " ")
    return text if len(text) <= limit else text[: limit - 1] + "…"
