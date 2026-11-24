"""Cross-process helpers for the JSON files under hub_repo/index.

The API container and the retarget scripts on the host both rewrite these
files. Standard library only, so the host scripts can import it without the
web dependencies.
"""

from __future__ import annotations

import fcntl
import os
import uuid
from contextlib import contextmanager
from pathlib import Path


@contextmanager
def locked(target: Path):
    """Hold an exclusive lock for ``target`` across processes and containers.

    The lock lives in a sibling ``.<name>.lock`` file, so replacing ``target``
    does not drop it. Read, change and write the file inside the block.
    """
    target = Path(target)
    lock_path = target.with_name(f".{target.name}.lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o666)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def write_text_atomic(path: Path, text: str) -> None:
    """Replace ``path`` with ``text``. The temp name is unique per writer, so
    two processes writing the same file cannot delete each other's temp file."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        tmp.write_text(text, encoding="utf-8")
        tmp.replace(path)
    finally:
        tmp.unlink(missing_ok=True)


def rotate_if_large(path: Path, *, max_bytes: int, keep: int = 3) -> None:
    """Rename ``path`` to ``path.1`` (shifting older ones) once it passes ``max_bytes``."""
    path = Path(path)
    try:
        if path.stat().st_size < max_bytes:
            return
    except OSError:
        return
    with locked(path):
        try:
            # Another process may have rotated while this one waited.
            if path.stat().st_size < max_bytes:
                return
            for index in range(keep, 0, -1):
                older = path.with_name(f"{path.name}.{index}")
                if index == keep:
                    older.unlink(missing_ok=True)
                    continue
                if older.exists():
                    older.replace(path.with_name(f"{path.name}.{index + 1}"))
            path.replace(path.with_name(f"{path.name}.1"))
        except OSError:
            pass
