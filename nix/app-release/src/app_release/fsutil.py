"""Atomic file writes and the per-unit operation lock."""

import fcntl
import os
import tempfile
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path

from app_release.errors import LockTimeoutError


def atomic_write(path: Path, data: bytes, mode: int = 0o644) -> None:
    """Replace `path` with `data` so readers see the old or the new content, never a mix."""
    directory = path.parent
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=directory)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fchmod(handle.fileno(), mode)
            os.fsync(handle.fileno())
        Path(temporary).replace(path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise
    directory_descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory_descriptor)
    finally:
        os.close(directory_descriptor)


def atomic_write_text(path: Path, text: str, mode: int = 0o644) -> None:
    atomic_write(path, text.encode(), mode)


@contextmanager
def exclusive_lock(
    path: Path,
    timeout_seconds: float,
    on_wait: Callable[[], None],
    *,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> Iterator[None]:
    """Hold an exclusive flock on `path`, waiting at most `timeout_seconds` for it."""
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC, 0o600)
    try:
        deadline = clock() + timeout_seconds
        announced = False
        while True:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if not announced:
                    on_wait()
                    announced = True
                if clock() >= deadline:
                    message = (
                        f"another operation held {path} for longer than "
                        f"{int(timeout_seconds)} s; nothing changed"
                    )
                    raise LockTimeoutError(message) from None
                sleep(1)
        yield
    finally:
        os.close(descriptor)
