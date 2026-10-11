"""The systemctl operations app-release needs."""

from typing import Protocol

from app_release.runner import Runner

STOPPED_STATES = frozenset({"inactive", "failed"})
BUSY_STATES = frozenset({"active", "activating", "deactivating", "reloading", "refreshing"})


class ServiceManager(Protocol):
    def start(self, unit: str, timeout: float | None) -> str | None: ...
    def restart(self, unit: str, timeout: float | None) -> str | None: ...
    def stop(self, unit: str, *, block: bool) -> str | None: ...
    def reload(self, unit: str) -> str | None: ...
    def active_state(self, unit: str) -> str: ...


class Systemctl:
    """Each command returns None on success or a one-line error."""

    def __init__(self, executable: str, runner: Runner) -> None:
        self.executable = executable
        self.runner = runner

    def _run(self, *args: str, timeout: float | None = None) -> str | None:
        result = self.runner([self.executable, *args], timeout=timeout)
        if result.ok:
            return None
        # systemctl explains a failed job on its first line and points to the logs
        # on the next one, so keep every line.
        lines = [line.strip() for line in result.stderr.splitlines() if line.strip()]
        return " ".join(lines).rstrip(".") if lines else result.summary()

    def start(self, unit: str, timeout: float | None) -> str | None:
        return self._run("start", unit, timeout=timeout)

    def restart(self, unit: str, timeout: float | None) -> str | None:
        return self._run("restart", unit, timeout=timeout)

    def stop(self, unit: str, *, block: bool) -> str | None:
        if block:
            return self._run("stop", unit)
        return self._run("stop", "--no-block", unit)

    def reload(self, unit: str) -> str | None:
        return self._run("reload", unit)

    def active_state(self, unit: str) -> str:
        result = self.runner([self.executable, "show", "--property=ActiveState", "--value", unit])
        state = result.stdout.strip()
        return state if result.ok and state else "unknown"
