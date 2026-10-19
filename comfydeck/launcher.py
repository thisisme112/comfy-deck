"""Start, stop and monitor the ComfyUI process."""
from __future__ import annotations

import os
import re
import shlex
import socket
import subprocess
import threading
import time
import uuid
import webbrowser
from pathlib import Path
from typing import Any

try:  # psutil ships with the portable build, but stay usable without it
    import psutil
except Exception:  # pragma: no cover
    psutil = None  # type: ignore

from .config import DATA_DIR, LOG_DIR, config
from .util import atomic_write_json, read_json

PROFILES_PATH = DATA_DIR / "profiles.json"
STATE_PATH = DATA_DIR / "launcher.json"
RUN_LOG_DIR = LOG_DIR / "comfyui"
RUN_LOG_DIR.mkdir(parents=True, exist_ok=True)

ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
MAX_RUN_LOGS = 12

DEFAULT_PROFILES: list[dict[str, Any]] = [
    {"id": "default", "name": "标准", "args": "--enable-manager", "env": "", "open_browser": True, "use_proxy": False},
    {"id": "fast", "name": "fp16 累加加速", "args": "--fast fp16_accumulation --enable-manager", "env": "", "open_browser": True, "use_proxy": False},
    {"id": "lowvram", "name": "低显存", "args": "--lowvram --enable-manager", "env": "", "open_browser": True, "use_proxy": False},
    {"id": "safe", "name": "安全模式（不加载插件）", "args": "--disable-all-custom-nodes", "env": "", "open_browser": True, "use_proxy": False},
]


# --------------------------------------------------------------------- helpers
def port_open(port: int, host: str = "127.0.0.1", timeout: float = 0.35) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def parse_args(text: str) -> list[str]:
    try:
        parts = shlex.split(text or "", posix=False)
    except ValueError as exc:
        raise RuntimeError(f"启动参数无法解析：{exc}") from exc
    return [p[1:-1] if len(p) >= 2 and p[0] == p[-1] and p[0] in "\"'" else p for p in parts]


def args_port(args: list[str]) -> int:
    for idx, arg in enumerate(args):
        if arg == "--port" and idx + 1 < len(args) and args[idx + 1].isdigit():
            return int(args[idx + 1])
        if arg.startswith("--port=") and arg[7:].isdigit():
            return int(arg[7:])
    return int(config.get("comfy_port") or 8188)


def _parse_env(text: str) -> dict[str, str]:
    env: dict[str, str] = {}
    for line in (text or "").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if key:
            env[key] = value.strip()
    return env


def _pid_alive(pid: int) -> bool:
    if not pid:
        return False
    if psutil:
        try:
            return psutil.pid_exists(pid) and psutil.Process(pid).status() != psutil.STATUS_ZOMBIE
        except Exception:
            return False
    try:
        out = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
            capture_output=True, text=True, timeout=5,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        ).stdout
        return str(pid) in out
    except Exception:
        return False


def _cmdline(pid: int) -> str:
    if not psutil:
        return ""
    try:
        return " ".join(psutil.Process(pid).cmdline())
    except Exception:
        return ""


def _looks_like_comfy(pid: int) -> bool:
    if not psutil:
        return True
    return "main.py" in _cmdline(pid).replace("\\", "/")


def find_pid_by_port(port: int) -> int:
    if psutil:
        try:
            for conn in psutil.net_connections(kind="tcp"):
                if conn.status == psutil.CONN_LISTEN and conn.laddr and conn.laddr.port == port and conn.pid:
                    return int(conn.pid)
        except Exception:
            pass
    if os.name == "nt":
        try:
            out = subprocess.run(
                ["netstat", "-ano", "-p", "tcp"], capture_output=True, text=True, timeout=8,
                creationflags=subprocess.CREATE_NO_WINDOW,
            ).stdout
            for line in out.splitlines():
                cols = line.split()
                if len(cols) >= 5 and cols[3].upper() == "LISTENING" and cols[1].endswith(f":{port}"):
                    return int(cols[4])
        except Exception:
            pass
    return 0


def _kill_tree(pid: int) -> None:
    if psutil:
        try:
            parent = psutil.Process(pid)
            procs = parent.children(recursive=True) + [parent]
            for p in procs:
                try:
                    p.kill()
                except Exception:
                    pass
            psutil.wait_procs(procs, timeout=6)
            return
        except psutil.NoSuchProcess:
            return
        except Exception:
            pass
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"],
            capture_output=True, timeout=15, creationflags=subprocess.CREATE_NO_WINDOW,
        )
    else:
        os.kill(pid, 9)


def clean_log(text: str) -> str:
    return ANSI.sub("", text).replace("\r\n", "\n")


# -------------------------------------------------------------------- profiles
def _load_profiles() -> dict[str, Any]:
    data = read_json(PROFILES_PATH, None)
    if not isinstance(data, dict) or not isinstance(data.get("profiles"), list) or not data["profiles"]:
        data = {"profiles": [dict(p) for p in DEFAULT_PROFILES], "last": "default"}
        atomic_write_json(PROFILES_PATH, data)
    return data


def list_profiles() -> dict[str, Any]:
    return _load_profiles()


def get_profile(profile_id: str | None = None) -> dict[str, Any]:
    data = _load_profiles()
    wanted = profile_id or data.get("last") or "default"
    for p in data["profiles"]:
        if p["id"] == wanted:
            return p
    return data["profiles"][0]


def save_profile(payload: dict[str, Any]) -> dict[str, Any]:
    name = str(payload.get("name") or "").strip()[:40]
    args = str(payload.get("args") or "").strip()
    if not name:
        raise RuntimeError("请填写方案名称。")
    if len(args) > 2000 or "\n" in args or "\r" in args:
        raise RuntimeError("启动参数必须是单行文本。")
    parse_args(args)
    entry = {
        "id": str(payload.get("id") or "") or uuid.uuid4().hex[:8],
        "name": name,
        "args": args,
        "env": str(payload.get("env") or "")[:4000],
        "open_browser": bool(payload.get("open_browser", True)),
        "use_proxy": bool(payload.get("use_proxy", False)),
    }
    data = _load_profiles()
    for idx, p in enumerate(data["profiles"]):
        if p["id"] == entry["id"]:
            data["profiles"][idx] = entry
            break
    else:
        data["profiles"].append(entry)
    atomic_write_json(PROFILES_PATH, data)
    return entry


def delete_profile(profile_id: str) -> None:
    data = _load_profiles()
    if len(data["profiles"]) <= 1:
        raise RuntimeError("至少保留一个启动方案。")
    data["profiles"] = [p for p in data["profiles"] if p["id"] != profile_id]
    if data.get("last") == profile_id:
        data["last"] = data["profiles"][0]["id"]
    atomic_write_json(PROFILES_PATH, data)


def set_last(profile_id: str) -> None:
    data = _load_profiles()
    if any(p["id"] == profile_id for p in data["profiles"]):
        data["last"] = profile_id
        atomic_write_json(PROFILES_PATH, data)


# -------------------------------------------------------------------- launcher
class Launcher:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self.proc: subprocess.Popen | None = None
        self.pid = 0
        self.profile_id = ""
        self.profile_name = ""
        self.port = 0
        self.started = 0.0
        self.log_path = ""
        self.last_exit: dict[str, Any] | None = None
        self._ext_cache: tuple[float, int, int] = (0.0, 0, 0)
        self._restore()

    # ------------------------------------------------------------------ state
    def _persist(self) -> None:
        atomic_write_json(
            STATE_PATH,
            {
                "pid": self.pid,
                "profile_id": self.profile_id,
                "profile_name": self.profile_name,
                "port": self.port,
                "started": self.started,
                "log_path": self.log_path,
                "last_exit": self.last_exit,
            },
        )

    def _restore(self) -> None:
        data = read_json(STATE_PATH, {}) or {}
        self.last_exit = data.get("last_exit")
        self.log_path = data.get("log_path") or ""
        pid = int(data.get("pid") or 0)
        if pid and _pid_alive(pid) and _looks_like_comfy(pid):
            self.pid = pid
            self.profile_id = data.get("profile_id", "")
            self.profile_name = data.get("profile_name", "")
            self.port = int(data.get("port") or 0)
            self.started = float(data.get("started") or 0)

    def _managed_alive(self) -> bool:
        if self.proc is not None:
            return self.proc.poll() is None
        return bool(self.pid) and _pid_alive(self.pid)

    def _reap(self) -> None:
        """Notice that the managed process has ended and remember how."""
        if not self.pid or self._managed_alive():
            return
        code = self.proc.poll() if self.proc is not None else None
        self.last_exit = {
            "code": code,
            "time": time.time(),
            "profile": self.profile_name,
            "crashed": code not in (None, 0),
        }
        self.proc = None
        self.pid = 0
        self._persist()

    def active_port(self) -> int:
        return self.port or int(config.get("comfy_port") or 8188)

    def status(self) -> dict[str, Any]:
        with self._lock:
            self._reap()
            alive = self._managed_alive()
            port = self.active_port()
            opened = port_open(port)
            external_pid = 0
            external_name = ""
            if opened and not alive:
                now = time.time()
                if self._ext_cache[1] != port or now - self._ext_cache[0] > 6:
                    self._ext_cache = (now, port, find_pid_by_port(port))
                external_pid = self._ext_cache[2]
                if external_pid and psutil:
                    try:
                        external_name = psutil.Process(external_pid).name()
                    except Exception:
                        pass
            if alive and opened:
                state = "running"
            elif alive:
                state = "starting"
            elif opened:
                state = "running"
            else:
                state = "stopped"
            return {
                "state": state,
                "running": state == "running",
                "managed": alive,
                "external": bool(opened and not alive),
                "pid": self.pid if alive else external_pid,
                "external_name": external_name,
                "port": port,
                "url": f"http://127.0.0.1:{port}",
                "profile_id": self.profile_id if alive else "",
                "profile_name": self.profile_name if alive else "",
                "started": self.started if alive else 0,
                "uptime": (time.time() - self.started) if alive and self.started else 0,
                "log_file": Path(self.log_path).name if self.log_path else "",
                "last_exit": self.last_exit if state == "stopped" else None,
            }

    # ------------------------------------------------------------------ start
    def start(self, profile_id: str | None = None, args_override: str | None = None) -> dict[str, Any]:
        with self._lock:
            st = self.status()
            if st["state"] != "stopped":
                raise RuntimeError("ComfyUI 已经在运行，请先停止或使用“重启”。")
            comfy_dir = config.comfy_dir
            main = comfy_dir / "main.py"
            if not main.exists():
                raise RuntimeError(f"找不到 ComfyUI：{main}")
            python = config.python_exe
            if not Path(python).exists():
                raise RuntimeError(f"Python 不存在：{python}，请到设置中修改。")

            profile = dict(get_profile(profile_id))
            if args_override is not None:
                profile["args"] = args_override
            args = parse_args(profile.get("args", ""))
            portable = "python_embeded" in python.lower().replace("\\", "/")
            if portable and "--windows-standalone-build" not in args:
                args.insert(0, "--windows-standalone-build")
            if "--disable-auto-launch" not in args:
                args.append("--disable-auto-launch")
            port = args_port(args)
            if port_open(port):
                raise RuntimeError(f"端口 {port} 已被占用，无法启动。")

            env = os.environ.copy()
            env.update({"PYTHONIOENCODING": "utf-8", "PYTHONUNBUFFERED": "1"})
            env.update(_parse_env(profile.get("env", "")))
            proxy = config.proxy
            if profile.get("use_proxy") and proxy:
                for key in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
                    env.setdefault(key, proxy)

            stamp = time.strftime("%Y%m%d-%H%M%S")
            log_path = RUN_LOG_DIR / f"run-{stamp}.log"
            cmd = [python, "-s", str(main), *args]
            cwd = comfy_dir.parent if (comfy_dir.parent / "python_embeded").exists() else comfy_dir
            flags = 0
            if os.name == "nt":
                flags = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
            with log_path.open("ab") as fh:
                fh.write(f"# ComfyDeck · {time.strftime('%Y-%m-%d %H:%M:%S')} · 方案：{profile['name']}\n".encode("utf-8"))
                fh.write(f"# {' '.join(cmd)}\n\n".encode("utf-8"))
                fh.flush()
                self.proc = subprocess.Popen(
                    cmd, cwd=str(cwd), env=env, stdin=subprocess.DEVNULL,
                    stdout=fh, stderr=subprocess.STDOUT, creationflags=flags,
                )
            self.pid = self.proc.pid
            self.profile_id = profile["id"]
            self.profile_name = profile["name"]
            self.port = port
            self.started = time.time()
            self.log_path = str(log_path)
            self.last_exit = None
            self._persist()
            if args_override is None:
                set_last(profile["id"])
            self._prune_logs()
            if profile.get("open_browser"):
                threading.Thread(target=self._open_when_ready, args=(self.pid, port), daemon=True).start()
        return self.status()

    def _open_when_ready(self, pid: int, port: int) -> None:
        deadline = time.time() + 420
        while time.time() < deadline:
            if self.pid != pid:
                return
            if port_open(port):
                time.sleep(0.6)
                try:
                    webbrowser.open(f"http://127.0.0.1:{port}")
                except Exception:
                    pass
                return
            time.sleep(1.0)

    def _prune_logs(self) -> None:
        files = sorted(RUN_LOG_DIR.glob("run-*.log"), key=lambda p: p.stat().st_mtime, reverse=True)
        for old in files[MAX_RUN_LOGS:]:
            try:
                old.unlink()
            except OSError:
                pass

    # ------------------------------------------------------------------- stop
    def stop(self) -> dict[str, Any]:
        with self._lock:
            st = self.status()
            if st["state"] == "stopped":
                return st
            pid = st["pid"]
            if not pid:
                raise RuntimeError("找不到占用端口的进程，无法停止。请手动关闭 ComfyUI 窗口。")
            if st["external"] and not _looks_like_comfy(pid):
                raise RuntimeError(f"端口被其他程序占用（{st['external_name'] or pid}），不是 ComfyUI。")
            _kill_tree(pid)
            if self.proc is not None:
                try:
                    self.proc.wait(timeout=5)
                except Exception:
                    pass
            deadline = time.time() + 10
            while time.time() < deadline and (port_open(st["port"]) or _pid_alive(pid)):
                time.sleep(0.3)
            if st["managed"]:
                self.last_exit = {"code": 0, "time": time.time(), "profile": self.profile_name, "crashed": False, "stopped": True}
                self.proc = None
                self.pid = 0
                self._persist()
            self._ext_cache = (0.0, 0, 0)
        return self.status()

    def restart(self, profile_id: str | None = None) -> dict[str, Any]:
        with self._lock:
            st = self.status()
            wanted = profile_id or st.get("profile_id") or None
            if st["state"] != "stopped":
                self.stop()
            return self.start(wanted)

    # ------------------------------------------------------------------- logs
    def list_logs(self) -> list[dict[str, Any]]:
        files = sorted(RUN_LOG_DIR.glob("run-*.log"), key=lambda p: p.stat().st_mtime, reverse=True)
        return [{"name": p.name, "size": p.stat().st_size, "mtime": p.stat().st_mtime} for p in files]

    def _log_target(self, file: str = "") -> tuple[Path | None, str]:
        if file:
            cand = RUN_LOG_DIR / Path(file).name
            if cand.is_file():
                return cand, "run"
        if self.log_path and Path(self.log_path).is_file():
            return Path(self.log_path), "run"
        logs = self.list_logs()
        if logs:
            return RUN_LOG_DIR / logs[0]["name"], "run"
        fallback = config.comfy_dir / "user" / "comfyui.log"
        if fallback.is_file():
            return fallback, "comfyui"
        return None, ""

    def log_tail(self, offset: int = -1, file: str = "", limit: int = 256 * 1024) -> dict[str, Any]:
        path, source = self._log_target(file)
        if path is None:
            return {"text": "", "offset": 0, "reset": True, "file": "", "source": ""}
        size = path.stat().st_size
        reset = False
        if offset < 0 or offset > size:
            offset = max(0, size - 96 * 1024)
            reset = True
        with path.open("rb") as fh:
            fh.seek(offset)
            raw = fh.read(min(limit, max(0, size - offset)))
        text = ""
        for cut in range(0, 4):
            try:
                text = raw[: len(raw) - cut].decode("utf-8")
                raw = raw[: len(raw) - cut]
                break
            except UnicodeDecodeError:
                continue
        else:
            text = raw.decode("utf-8", errors="replace")
        return {
            "text": clean_log(text),
            "offset": offset + len(raw),
            "reset": reset,
            "file": path.name,
            "source": source,
            "size": size,
        }


launcher = Launcher()


def maybe_autostart() -> None:
    if not config.get("auto_start_comfy"):
        return
    try:
        if launcher.status()["state"] == "stopped":
            launcher.start()
    except Exception as exc:  # noqa: BLE001
        print(f"自动启动 ComfyUI 失败：{exc}")
