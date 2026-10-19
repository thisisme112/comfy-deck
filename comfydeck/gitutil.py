"""Thin, safe wrapper around the git CLI."""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .util import run_command, version_tuple

GIT = "git"


def _cmd(cwd: str | Path, args: list[str]) -> list[str]:
    # The portable folder can be owned by another Windows account, which makes
    # git refuse to operate ("dubious ownership"). Allow just this repository.
    safe = Path(cwd).resolve().as_posix()
    return [
        GIT,
        "-c",
        f"safe.directory={safe}",
        "-c",
        "core.quotepath=false",
        "-C",
        str(Path(cwd)),
        *args,
    ]


def git(
    cwd: str | Path,
    args: list[str],
    timeout: int = 120,
    env: dict[str, str] | None = None,
) -> tuple[int, str]:
    return run_command(_cmd(cwd, args), timeout=timeout, env=env)


def is_repo(path: str | Path) -> bool:
    return (Path(path) / ".git").exists()


def repo_info(path: str | Path) -> dict[str, Any]:
    path = Path(path)
    if not is_repo(path):
        return {"git": False}
    code, head = git(path, ["rev-parse", "HEAD"], timeout=30)
    if code != 0:
        return {"git": True, "error": head.strip()[:300]}
    head = head.strip()
    info: dict[str, Any] = {"git": True, "head": head, "short": head[:7]}
    code, branch = git(path, ["rev-parse", "--abbrev-ref", "HEAD"], timeout=30)
    info["branch"] = branch.strip() if code == 0 else ""
    code, tag = git(path, ["describe", "--tags", "--exact-match", "HEAD"], timeout=30)
    info["tag"] = tag.strip() if code == 0 else ""
    code, tags = git(path, ["describe", "--tags", "--always", "HEAD"], timeout=30)
    info["describe"] = tags.strip() if code == 0 else ""
    code, remote = git(path, ["config", "--get", "remote.origin.url"], timeout=30)
    info["remote"] = remote.strip() if code == 0 else ""
    code, status = git(path, ["status", "--porcelain", "--untracked-files=no"], timeout=30)
    info["dirty"] = bool(status.strip()) if code == 0 else False
    info["dirty_count"] = len(status.strip().splitlines()) if code == 0 and status.strip() else 0
    code, date = git(path, ["log", "-1", "--format=%cI"], timeout=30)
    info["head_date"] = date.strip() if code == 0 else ""
    code, subject = git(path, ["log", "-1", "--format=%s"], timeout=30)
    info["subject"] = subject.strip() if code == 0 else ""
    upstream = upstream_ref(path)
    info["upstream"] = upstream or ""
    ahead, behind = ahead_behind(path, upstream)
    info["ahead"] = ahead
    info["behind"] = behind
    return info


def upstream_ref(path: str | Path) -> str | None:
    code, ref = git(path, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], timeout=20)
    if code == 0 and ref.strip():
        return ref.strip()
    for candidate in ("origin/HEAD", "origin/main", "origin/master"):
        code, _ = git(path, ["rev-parse", "--verify", candidate], timeout=20)
        if code == 0:
            return candidate
    return None


def ahead_behind(path: str | Path, ref: str | None = None) -> tuple[int, int]:
    ref = ref or upstream_ref(path)
    if not ref:
        return 0, 0
    code, out = git(path, ["rev-list", "--left-right", "--count", f"HEAD...{ref}"], timeout=30)
    if code != 0:
        return 0, 0
    parts = out.split()
    if len(parts) < 2:
        return 0, 0
    try:
        return int(parts[0]), int(parts[1])
    except ValueError:
        return 0, 0


def fetch(path: str | Path, tags: bool = False, timeout: int = 180) -> tuple[bool, str]:
    args = ["fetch", "--prune", "origin"]
    if tags:
        args.insert(1, "--tags")
    code, out = git(path, args, timeout=timeout)
    return code == 0, out.strip()


def pull_ff(path: str | Path, timeout: int = 300) -> tuple[bool, str]:
    code, out = git(path, ["pull", "--ff-only", "--no-edit", "--autostash"], timeout=timeout)
    return code == 0, out.strip()


def checkout(path: str | Path, ref: str, timeout: int = 300) -> tuple[bool, str]:
    code, out = git(path, ["checkout", ref], timeout=timeout)
    return code == 0, out.strip()


def clone(url: str, dest: str | Path, timeout: int = 900) -> tuple[bool, str]:
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    env = {"GIT_TERMINAL_PROMPT": "0"}
    code, out = run_command(
        [GIT, "clone", "--recurse-submodules", url, str(dest)], timeout=timeout, env=env
    )
    return code == 0, out.strip()


def latest_tag(path: str | Path, pattern: str = "v*") -> tuple[str, str]:
    """Return (tag, sha) of the highest semver tag known to the local remote."""
    code, out = git(path, ["ls-remote", "--tags", "--refs", "origin", pattern], timeout=120)
    if code != 0:
        return "", ""
    tags: list[tuple[tuple[int, ...], str, str]] = []
    for line in out.splitlines():
        parts = line.split()
        if len(parts) != 2:
            continue
        sha, ref = parts
        tag = ref.rsplit("/", 1)[-1]
        vt = version_tuple(tag)
        if vt:
            tags.append((vt, tag, sha))
    if not tags:
        return "", ""
    tags.sort(reverse=True)
    return tags[0][1], tags[0][2]


def remote_commit(path: str | Path, ref: str) -> dict[str, str]:
    code, out = git(path, ["log", "-1", "--format=%H%n%s%n%cI", ref], timeout=30)
    if code != 0:
        return {}
    lines = out.strip().splitlines()
    if len(lines) < 1:
        return {}
    return {
        "sha": lines[0],
        "subject": lines[1] if len(lines) > 1 else "",
        "date": lines[2] if len(lines) > 2 else "",
    }


def sanitize_remote(url: str) -> str:
    """Drop embedded credentials from a remote URL before showing it."""
    return re.sub(r"//[^/@]+@", "//", url or "")
