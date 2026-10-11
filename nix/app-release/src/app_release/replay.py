"""Replay protection: every token's jti is accepted once."""

import contextlib
import hashlib
import os
from pathlib import Path

from app_release.errors import RejectedError
from app_release.oidc import LEEWAY_SECONDS


def _prune(directory: Path, now: float) -> None:
    for entry in directory.iterdir():
        try:
            expires_at = int(entry.read_text().strip())
        except (OSError, ValueError):
            expires_at = 0
        if expires_at + LEEWAY_SECONDS < now:
            with contextlib.suppress(FileNotFoundError):
                entry.unlink()


def remember(directory: Path, jti: str, expires_at: int, now: float) -> None:
    """Record `jti` until its token expires; reject it when it was seen before."""
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    _prune(directory, now)
    name = hashlib.sha256(jti.encode()).hexdigest()
    try:
        descriptor = os.open(directory / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        message = "the token was already used; request a new one"
        raise RejectedError(message) from None
    with os.fdopen(descriptor, "w") as file:
        file.write(f"{expires_at}\n")
        file.flush()
        os.fsync(file.fileno())
