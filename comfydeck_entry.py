"""Entry point used by the packaged (PyInstaller) build.

The source checkout is normally started with ``python server.py``.  The frozen
build starts here so that multiprocessing, log redirection and the bundled
resource directory are handled before the web app is imported.
"""
from __future__ import annotations

import multiprocessing
import sys
from pathlib import Path


def _redirect_streams() -> None:
    """A windowed executable has no console; keep uvicorn output in a log."""
    if not getattr(sys, "frozen", False):
        return
    try:
        from comfydeck.config import LOG_DIR

        LOG_DIR.mkdir(parents=True, exist_ok=True)
        log_path = LOG_DIR / "comfydeck.log"
        if log_path.exists() and log_path.stat().st_size > 5 * 1024 * 1024:
            try:
                log_path.replace(LOG_DIR / "comfydeck.log.1")
            except OSError:
                pass
        stream = open(log_path, "a", encoding="utf-8", buffering=1)
        sys.stdout = stream
        sys.stderr = stream
    except Exception:
        # Never block startup because logging could not be set up.
        pass


def main() -> None:
    multiprocessing.freeze_support()
    base = Path(__file__).resolve().parent
    if str(base) not in sys.path:
        sys.path.insert(0, str(base))
    _redirect_streams()
    from server import main as run_server

    run_server()


if __name__ == "__main__":
    main()
