"""Running external programs with pinned paths."""

import subprocess
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Protocol

TIMEOUT_EXIT = 124
NOT_FOUND_EXIT = 127


@dataclass(frozen=True)
class Completed:
    returncode: int
    stdout: str
    stderr: str

    @property
    def ok(self) -> bool:
        return self.returncode == 0

    def summary(self) -> str:
        """The last non-empty output line, for error messages."""
        for stream in (self.stderr, self.stdout):
            lines = [line.strip() for line in stream.splitlines() if line.strip()]
            if lines:
                return lines[-1]
        return f"exit status {self.returncode}"


class Runner(Protocol):
    def __call__(
        self,
        argv: Sequence[str],
        *,
        timeout: float | None = None,
        env: Mapping[str, str] | None = None,
    ) -> Completed: ...


def run(
    argv: Sequence[str],
    *,
    timeout: float | None = None,
    env: Mapping[str, str] | None = None,
) -> Completed:
    """Run `argv` without a shell, capturing its output."""
    try:
        process = subprocess.run(
            list(argv),
            capture_output=True,
            text=True,
            errors="replace",
            timeout=timeout,
            env=dict(env) if env is not None else None,
            stdin=subprocess.DEVNULL,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        stdout = error.stdout.decode(errors="replace") if isinstance(error.stdout, bytes) else ""
        return Completed(TIMEOUT_EXIT, stdout, f"timed out after {timeout} s")
    except OSError as error:
        return Completed(NOT_FOUND_EXIT, "", f"cannot run {argv[0]}: {error}")
    return Completed(process.returncode, process.stdout, process.stderr)
