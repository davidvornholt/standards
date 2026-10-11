"""The systemctl operations app-release needs."""

from typing import Protocol

from app_release.runner import Runner

STOPPED_STATES = frozenset({"inactive", "failed"})
BUSY_STATES = frozenset({"active", "activating", "deactivating", "reloading", "refreshing"})


class ServiceManager(Protocol):
    def start(self, unit: str, timeout: float | None) -> str | None: ...
    def restart(self, unit: str, timeout: float | None) -> str | None: ...
    def stop(self, unit: str, *, block: bool) -> str | None: ...
    def reset_failed(self, unit: str) -> None: ...
    def active_state(self, unit: str) -> str: ...
    def sub_state(self, unit: str) -> str: ...


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

    def reset_failed(self, unit: str) -> None:
        # A unit that failed repeatedly, for example while its image was missing, refuses
        # further starts until its start limit resets. A unit that never ran has nothing to
        # reset, so the result does not matter.
        self.runner([self.executable, "reset-failed", unit])

    def start(self, unit: str, timeout: float | None) -> str | None:
        self.reset_failed(unit)
        return self._run("start", unit, timeout=timeout)

    def restart(self, unit: str, timeout: float | None) -> str | None:
        self.reset_failed(unit)
        return self._run("restart", unit, timeout=timeout)

    def stop(self, unit: str, *, block: bool) -> str | None:
        if block:
            return self._run("stop", unit)
        return self._run("stop", "--no-block", unit)

    def active_state(self, unit: str) -> str:
        return self._property(unit, "ActiveState")

    def sub_state(self, unit: str) -> str:
        return self._property(unit, "SubState")

    def _property(self, unit: str, name: str) -> str:
        result = self.runner([self.executable, "show", f"--property={name}", "--value", unit])
        value = result.stdout.strip()
        return value if result.ok and value else "unknown"
