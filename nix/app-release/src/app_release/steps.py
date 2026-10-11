"""Building blocks shared by release, rollback, reconcile and refresh."""

from dataclasses import dataclass, field
from pathlib import Path

from app_release.config import AppConfig, Slot, other_slot
from app_release.context import Context
from app_release.errors import AppReleaseError, CriticalError, FailedError
from app_release.fsutil import atomic_write_text
from app_release.podman import Image, PodmanError, digest_of, repository_of
from app_release.systemd import BUSY_STATES, STOPPED_STATES

PULL_BACKOFF_SECONDS = (2, 4, 8)
HEALTH_POLL_SECONDS = 1


class StepError(Exception):
    """A step failed; the caller undoes what the operation changed so far."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


def draining_message(app: AppConfig, slot: Slot) -> str:
    return (
        f"{app.name}: the previous worker in slot {slot} is still draining; nothing changed. "
        "Re-run this release after it stops."
    )


def start_dependencies(ctx: Context) -> None:
    for dependency in ctx.unit.service_dependencies:
        error = ctx.services.start(dependency, timeout=None)
        if error is not None:
            message = f"dependency {dependency} failed to start: {error}"
            raise FailedError(message)


def pull(ctx: Context, reference: str) -> None:
    """Pull `reference`, retrying three times with backoff."""
    attempts = len(PULL_BACKOFF_SECONDS) + 1
    for attempt in range(attempts):
        try:
            ctx.images.pull(reference)
        except PodmanError as error:
            if attempt == attempts - 1:
                message = f"pull of {reference} failed after {attempts} attempts: {error.message}"
                raise FailedError(message) from None
            delay = PULL_BACKOFF_SECONDS[attempt]
            ctx.out.line(f"pull of {reference} failed ({error.message}); retrying in {delay} s")
            ctx.clock.sleep(delay)
        else:
            return


def ensure_image(ctx: Context, app: AppConfig, digest: str) -> Image:
    """The local image for `<imageRepository>@<digest>`, pulled if missing."""
    reference = f"{app.image_repository}@{digest}"
    if not ctx.images.exists(reference):
        ctx.out.line(f"{app.name}: pulling {reference}")
        pull(ctx, reference)
    image = ctx.images.inspect(reference)
    if image is None:
        message = f"{app.name}: {reference} is missing after the pull"
        raise FailedError(message)
    return image


def hook_environment(ctx: Context, app: AppConfig, slot: Slot | None) -> dict[str, str]:
    port = app.health_port(slot)
    return {
        "APP_RELEASE_UNIT": ctx.unit.name,
        "APP_RELEASE_APP": app.name,
        "APP_RELEASE_SLOT": slot or "",
        "APP_RELEASE_CONTAINER": app.container(slot),
        "APP_RELEASE_PORT": str(port) if port is not None else "",
    }


def run_pre_stop(ctx: Context, app: AppConfig) -> str | None:
    """Run the app's preStopCommand; None when it succeeded or there is none."""
    if app.pre_stop_command is None:
        return None
    ctx.out.line(f"{app.name}: running preStopCommand")
    result = ctx.prober.command(
        app.pre_stop_command, hook_environment(ctx, app, None), timeout=None
    )
    for line in result.output.splitlines():
        ctx.out.line(f"{app.name}: preStopCommand: {line}")
    if result.returncode != 0:
        return f"{app.name}: preStopCommand exited with status {result.returncode}"
    return None


@dataclass(frozen=True)
class HealthTarget:
    app: AppConfig
    slot: Slot | None


def _probe(ctx: Context, target: HealthTarget, remaining: float) -> str | None:
    app = target.app
    unit = app.unit(target.slot)
    state = ctx.services.active_state(unit)
    if state != "active":
        return f"{unit} is {state}"
    if app.health.command is not None:
        result = ctx.prober.command(
            app.health.command,
            hook_environment(ctx, app, target.slot),
            timeout=max(remaining, 1),
        )
        if result.returncode == 0:
            return None
        detail = result.output.splitlines()[-1] if result.output else ""
        return f"health command exited with status {result.returncode}" + (
            f": {detail}" if detail else ""
        )
    port = app.health_port(target.slot)
    path = app.health.path
    if port is None or path is None:
        return f"{app.name} has no health probe configured"
    return ctx.prober.http(port, path)


def wait_healthy(ctx: Context, targets: list[HealthTarget]) -> dict[str, str]:
    """Poll every target once a second until healthy; returns the failures by app name."""
    started = ctx.clock.monotonic()
    pending = {target.app.name: target for target in targets}
    failures: dict[str, str] = {}
    while pending:
        for name, target in list(pending.items()):
            elapsed = ctx.clock.monotonic() - started
            timeout = target.app.health.timeout_seconds
            reason = _probe(ctx, target, timeout - elapsed)
            if reason is None:
                where = f" in slot {target.slot}" if target.slot else ""
                ctx.out.line(f"{name}: healthy{where}")
                del pending[name]
                continue
            unit = target.app.unit(target.slot)
            state = ctx.services.active_state(unit)
            if state in STOPPED_STATES:
                failures[name] = f"{name}: {unit} stopped ({state}) before it became healthy"
                del pending[name]
            elif ctx.clock.monotonic() - started >= timeout:
                failures[name] = f"{name}: not healthy within {timeout} s ({reason})"
                del pending[name]
        if pending:
            ctx.clock.sleep(HEALTH_POLL_SECONDS)
    return failures


def upstream_line(port: int) -> str:
    return f"to 127.0.0.1:{port}\n"


def write_upstream(app: AppConfig, slot: Slot) -> bool:
    """Point the app's upstream file at `slot`; True when the content changed."""
    if app.upstream_file is None or app.slot_ports is None:
        return False
    wanted = upstream_line(app.slot_ports.port(slot))
    try:
        if app.upstream_file.read_text() == wanted:
            return False
    except FileNotFoundError:
        pass
    atomic_write_text(app.upstream_file, wanted)
    return True


def stop_slot(ctx: Context, app: AppConfig, slot: Slot) -> str | None:
    """Stop a slot's unit; workers that retire without waiting only get told to stop."""
    unit = app.unit(slot)
    if app.retire_without_waiting:
        if ctx.services.active_state(unit) == "deactivating":
            return None
        return ctx.services.stop(unit, block=False)
    return ctx.services.stop(unit, block=True)


@dataclass
class Transaction:
    """What a release changed so far, in the order it must be undone."""

    ctx: Context
    started: list[tuple[AppConfig, Slot]] = field(default_factory=list)
    recreated: list[tuple[AppConfig, str]] = field(default_factory=list)
    upstreams: list[tuple[Path, str | None]] = field(default_factory=list)
    reloaded: bool = False

    def start_idle_slots(self, targets: list[tuple[AppConfig, Slot, Image]]) -> None:
        """Start each app's idle slot on its target image and wait until all are healthy."""
        ctx = self.ctx
        for app, slot, image in targets:
            unit = app.unit(slot)
            if not app.portless and ctx.services.active_state(unit) not in STOPPED_STATES:
                ctx.out.line(f"{app.name}: stopping the leftover {unit} first")
                error = ctx.services.stop(unit, block=True)
                if error is not None:
                    message = f"{app.name}: cannot stop the leftover {unit}: {error}"
                    raise StepError(message)
            ctx.images.tag(image.id, app.local_tag(slot))
            self.started.append((app, slot))
            ctx.out.line(f"{app.name}: starting {image.digest} in slot {slot}")
            error = ctx.services.restart(unit, timeout=app.health.timeout_seconds)
            if error is not None:
                message = f"{app.name}: {unit} failed to start: {error}"
                raise StepError(message)
        failures = wait_healthy(ctx, [HealthTarget(app, slot) for app, slot, _ in targets])
        if failures:
            raise StepError("; ".join(failures.values()))

    def restart_recreate(self, app: AppConfig, image: Image, old_image_id: str) -> None:
        """Run preStopCommand, then restart a recreate app on `image` and wait until healthy."""
        ctx = self.ctx
        error = run_pre_stop(ctx, app)
        if error is not None:
            raise StepError(error)
        ctx.images.tag(image.id, app.local_tag("current"))
        self.recreated.append((app, old_image_id))
        ctx.out.line(f"{app.name}: restarting on {image.digest}")
        error = ctx.services.restart(app.unit(None), timeout=app.health.timeout_seconds)
        if error is not None:
            message = f"{app.name}: {app.unit(None)} failed to start: {error}"
            raise StepError(message)
        failures = wait_healthy(ctx, [HealthTarget(app, None)])
        if failures:
            raise StepError(failures[app.name])

    def switch(self, targets: list[tuple[AppConfig, Slot]]) -> None:
        """Point the upstream files at the new slots and reload Caddy."""
        ctx = self.ctx
        switching = [(app, slot) for app, slot in targets if app.upstream_file is not None]
        if not switching:
            return
        for app, slot in switching:
            path = app.upstream_file
            if path is None:
                continue
            try:
                previous: str | None = path.read_text()
            except FileNotFoundError:
                previous = None
            self.upstreams.append((path, previous))
            write_upstream(app, slot)
            ctx.out.line(f"{app.name}: switching traffic to slot {slot}")
        self.reloaded = True
        error = ctx.services.reload(ctx.unit.caddy_reload_unit)
        if error is not None:
            message = f"reload of {ctx.unit.caddy_reload_unit} failed: {error}"
            raise StepError(message)

    def _revert_recreate(self, app: AppConfig, old_image_id: str) -> str | None:
        ctx = self.ctx
        ctx.out.line(f"{app.name}: restoring the previous version")
        try:
            ctx.images.tag(old_image_id, app.local_tag("current"))
        except PodmanError as tag_error:
            return f"{app.name}: cannot restore the previous image tag: {tag_error.message}"
        pre_stop_error = run_pre_stop(ctx, app)
        if pre_stop_error is not None:
            ctx.out.warn(f"{pre_stop_error}; restarting anyway to restore the previous version")
        error = ctx.services.restart(app.unit(None), timeout=app.health.timeout_seconds)
        if error is not None:
            return f"{app.name}: the previous version failed to start: {error}"
        failures = wait_healthy(ctx, [HealthTarget(app, None)])
        if failures:
            return f"{app.name}: the previous version is not healthy: {failures[app.name]}"
        return None

    def undo(self) -> list[str]:
        """Undo everything; returns the problems that leave the previous version not serving."""
        ctx = self.ctx
        problems: list[str] = []
        for path, previous in reversed(self.upstreams):
            try:
                if previous is None:
                    path.unlink(missing_ok=True)
                else:
                    atomic_write_text(path, previous)
            except OSError as write_error:
                problems.append(f"cannot restore {path}: {write_error}")
        if self.upstreams and self.reloaded:
            error = ctx.services.reload(ctx.unit.caddy_reload_unit)
            if error is not None:
                problems.append(f"reload of {ctx.unit.caddy_reload_unit} failed again: {error}")
        for app, old_image_id in reversed(self.recreated):
            problem = self._revert_recreate(app, old_image_id)
            if problem is not None:
                problems.append(problem)
        for app, slot in reversed(self.started):
            error = stop_slot(ctx, app, slot)
            if error is not None:
                ctx.out.warn(f"{app.name}: cannot stop slot {slot}: {error}")
        return problems

    def fail(self, reason: str) -> AppReleaseError:
        """Undo and build the error the operation exits with."""
        self.ctx.out.line(f"failed: {reason}; restoring the previous version")
        problems = self.undo()
        if problems:
            return CriticalError(
                f"{reason}; restoring the previous version failed: {'; '.join(problems)}"
            )
        return FailedError(f"{reason}; the previous version is serving")


def retire(ctx: Context, retirements: list[tuple[AppConfig, Slot]]) -> None:
    """Stop the old slots after the drain wait. Failures are only warnings."""
    without_waiting = [(app, slot) for app, slot in retirements if app.retire_without_waiting]
    waiting = [(app, slot) for app, slot in retirements if not app.retire_without_waiting]
    for app, slot in without_waiting:
        error = stop_slot(ctx, app, slot)
        if error is None:
            ctx.out.line(
                f"{app.name}: told the old worker in slot {slot} to stop; it drains on its own"
            )
        else:
            ctx.out.warn(f"{app.name}: cannot stop slot {slot}: {error}")
    if not waiting:
        return
    if ctx.unit.drain_seconds > 0:
        ctx.out.line(f"waiting {ctx.unit.drain_seconds} s for in-flight requests to drain")
        ctx.clock.sleep(ctx.unit.drain_seconds)
    for app, slot in waiting:
        error = stop_slot(ctx, app, slot)
        if error is None:
            ctx.out.line(f"{app.name}: stopped slot {slot}")
        else:
            ctx.out.warn(f"{app.name}: cannot stop slot {slot}: {error}")


def idle_busy(ctx: Context, app: AppConfig, active: Slot) -> Slot | None:
    """For port-less workers: the idle slot when an earlier retire is still running there."""
    if not app.portless:
        return None
    idle = other_slot(active)
    if ctx.services.active_state(app.unit(idle)) in BUSY_STATES:
        return idle
    return None


def collect_garbage(ctx: Context) -> None:
    """Remove local images of the unit's repositories that no app needs. Best effort."""
    try:
        keep: set[str] = set()
        for state in ctx.all_states():
            keep |= state.digests()
        repositories = {app.image_repository for app in ctx.unit.apps.values()}
        for image in ctx.images.images():
            names = (*image.names, *image.repo_digests)
            owned = [name for name in dict.fromkeys(names) if repository_of(name) in repositories]
            if not owned:
                continue
            if {digest_of(name) for name in owned} & keep:
                continue
            if image.containers > 0:
                ctx.out.line(f"gc: keeping {image.id[:12]}, a container still uses it")
                continue
            _remove_image(ctx, image.id, image.names, repositories)
    except (AppReleaseError, OSError) as error:
        ctx.out.warn(f"gc: {error}")


def _remove_image(
    ctx: Context, image_id: str, names: tuple[str, ...], repositories: set[str]
) -> None:
    tags = [name for name in names if "@" not in name and repository_of(name) in repositories]
    for name in tags:
        error = ctx.images.remove(name)
        if error is not None:
            ctx.out.warn(f"gc: cannot remove {name}: {error}")
            return
        ctx.out.line(f"gc: removed {name}")
    if any(repository_of(name) not in repositories for name in names):
        # Another name, such as a slot tag, still refers to the image.
        return
    error = ctx.images.remove(image_id)
    if error is not None:
        ctx.out.warn(f"gc: cannot remove image {image_id[:12]}: {error}")
    else:
        ctx.out.line(f"gc: removed image {image_id[:12]}")
