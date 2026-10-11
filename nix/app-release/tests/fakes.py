"""In-memory podman, systemd, probes and clock that share one model of a host."""

import hashlib
import io
import tempfile
from collections.abc import Mapping
from pathlib import Path

from app_release.config import UnitConfig, parse_unit
from app_release.context import Claims, Context
from app_release.output import Output
from app_release.podman import Image, ImageSummary, PodmanError
from app_release.probes import CommandResult
from app_release.state import State, StateStore

SHA_A = "a" * 40
SHA_B = "b" * 40
SHA_C = "c" * 40
PRE_STOP = "drain-jobs"
WORKER_HEALTH = "check-worker"


def digest(label: str) -> str:
    return "sha256:" + hashlib.sha256(label.encode()).hexdigest()


def make_image(label: str, revision: str | None, content: str | None = None) -> Image:
    return Image(
        id=hashlib.sha256(f"id-{label}".encode()).hexdigest(),
        digest=digest(label),
        revision=revision,
        content=content if content is not None else f"content-{label}",
    )


def app_json(  # noqa: PLR0913 - one keyword per field a test varies
    name: str,
    *,
    strategy: str = "blue-green",
    ports: tuple[int, int] | None = None,
    health_port: int | None = None,
    health_command: str | None = None,
    pre_stop: str | None = None,
    retire_without_waiting: bool = False,
    priority: int = 100,
    upstream_dir: Path | None = None,
    definition_hash: str = "def-1",
) -> dict[str, object]:
    blue_green = strategy == "blue-green"
    containers = (
        {"blue": f"{name}-blue", "green": f"{name}-green"} if blue_green else {"current": name}
    )
    return {
        "imageRepository": f"ghcr.io/owner/{name}",
        "strategy": strategy,
        "containerPort": 3000 if ports is not None else None,
        "preStopCommand": pre_stop,
        "retireWithoutWaiting": retire_without_waiting,
        "priority": priority,
        "upstreamFile": (
            str(upstream_dir / f"{name}.upstream")
            if ports is not None and upstream_dir is not None
            else None
        ),
        "slotPorts": {"blue": ports[0], "green": ports[1]} if ports is not None else None,
        "health": {
            "path": None if health_command is not None else "/health",
            "port": health_port,
            "command": health_command,
            "timeoutSeconds": 5,
        },
        "containers": containers,
        "units": {slot: f"podman-{container}.service" for slot, container in containers.items()},
        "definitionHash": definition_hash,
    }


def unit_json(
    apps: dict[str, dict[str, object]],
    *,
    migration: dict[str, str] | None = None,
    drain_seconds: int = 10,
) -> dict[str, object]:
    return {
        "version": 1,
        "unit": "shop",
        "repository": "owner/shop",
        "ref": "refs/heads/main",
        "registryAuthFile": None,
        "serviceDependencies": [],
        "migration": migration,
        "drainSeconds": drain_seconds,
        "refreshUnit": "app-release-shop-refresh.service",
        "oidc": {
            "issuer": "https://token.actions.githubusercontent.com",
            "jwksUrl": "file:///nonexistent",
            "audience": "app-release",
        },
        "caddyReloadUnit": "caddy.service",
        "apps": apps,
    }


def claims(run_id: int = 100, sha: str = SHA_B, event_name: str = "push") -> Claims:
    return Claims(
        sha=sha,
        run_id=run_id,
        run_attempt=1,
        workflow_ref="owner/shop/.github/workflows/publish.yml@refs/heads/main",
        actor="octocat",
        event_name=event_name,
    )


class FakeClock:
    def __init__(self) -> None:
        self.time = 1000.0
        self.sleeps: list[float] = []

    def monotonic(self) -> float:
        return self.time

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.time += seconds

    def now(self) -> str:
        return "2026-10-11T12:00:00Z"

    def epoch(self) -> float:
        return 1_800_000_000 + self.time


class World:
    """Fake image store, service manager and prober for one unit."""

    def __init__(self, unit: UnitConfig, directory: Path) -> None:
        self.unit = unit
        self.directory = directory
        self.registry: dict[str, Image] = {}
        self.local: dict[str, Image] = {}
        self.names: dict[str, str] = {}
        self.extra_containers: dict[str, int] = {}
        self.states: dict[str, str] = {}
        self.running: dict[str, str] = {}
        self.unhealthy: set[str] = set()
        self.failing_units: set[str] = set()
        self.slow_stop: set[str] = set()
        self.pull_failures: dict[str, int] = {}
        self.reload_errors: list[str | None] = []
        self.migration_error: str | None = None
        self.pre_stop_exit = 0
        self.calls: list[tuple[str, ...]] = []
        self.migration_saw: str | None = None
        self.unit_tags: dict[str, str] = {}
        self.port_units: dict[int, str] = {}
        for app in unit.apps.values():
            for slot, unit_name in app.units.items():
                self.unit_tags[unit_name] = app.local_tag(slot)
            if app.slot_ports is not None:
                self.port_units[app.slot_ports.blue] = app.units["blue"]
                self.port_units[app.slot_ports.green] = app.units["green"]
            elif app.health.port is not None and not app.blue_green:
                self.port_units[app.health.port] = app.units["current"]
        self.clock = FakeClock()
        self.stream = io.StringIO()
        self.store = StateStore(directory / "state" / "state.json")
        self.other_states: list[State] = []

    # Test setup

    def publish(self, repository: str, image: Image, *tags: str) -> None:
        self.registry[f"{repository}@{image.digest}"] = image
        for tag in tags:
            self.registry[f"{repository}:{tag}"] = image

    def store_locally(self, repository: str, image: Image) -> None:
        self.local[image.id] = image
        self.names[f"{repository}@{image.digest}"] = image.id

    def run_unit(self, unit: str, image: Image) -> None:
        self.local[image.id] = image
        self.names[self.unit_tags[unit]] = image.id
        self.states[unit] = "active"
        self.running[unit] = image.id

    def context(self) -> Context:
        return Context(
            unit=self.unit,
            images=self,
            services=self,
            prober=self,
            clock=self.clock,
            out=Output(self.stream),
            store=self.store,
            all_states=self.all_states,
        )

    def all_states(self) -> list[State]:
        own = self.store.load()
        return [*([own] if own is not None else []), *self.other_states]

    def output(self) -> str:
        return self.stream.getvalue()

    def restarts(self) -> list[str]:
        return [call[1] for call in self.calls if call[0] == "restart"]

    # ImageStore

    def exists(self, reference: str) -> bool:
        return reference in self.names

    def inspect(self, reference: str) -> Image | None:
        image_id = self.names.get(reference)
        return self.local[image_id] if image_id is not None else None

    def pull(self, reference: str) -> None:
        self.calls.append(("pull", reference))
        if self.pull_failures.get(reference, 0) > 0:
            self.pull_failures[reference] -= 1
            message = f"{reference}: connection reset"
            raise PodmanError(message)
        image = self.registry.get(reference)
        if image is None:
            message = f"{reference}: manifest unknown"
            raise PodmanError(message)
        self.local[image.id] = image
        self.names[reference] = image.id
        if "@" not in reference:
            repository = reference.rsplit(":", 1)[0]
            self.names[f"{repository}@{image.digest}"] = image.id

    def tag(self, image_id: str, name: str) -> None:
        if image_id not in self.local:
            message = f"{image_id}: image not known"
            raise PodmanError(message)
        self.calls.append(("tag", name, image_id))
        self.names[name] = image_id

    def untag(self, image_id: str, name: str) -> None:
        if self.names.get(name) != image_id:
            message = f"{name}: tag not known"
            raise PodmanError(message)
        self.calls.append(("untag", name))
        del self.names[name]

    def images(self) -> list[ImageSummary]:
        summaries = []
        for image_id in self.local:
            names = [name for name, target in self.names.items() if target == image_id]
            in_use = sum(1 for running in self.running.values() if running == image_id)
            summaries.append(
                ImageSummary(
                    id=image_id,
                    names=tuple(name for name in names if "@" not in name),
                    repo_digests=tuple(name for name in names if "@" in name),
                    containers=in_use + self.extra_containers.get(image_id, 0),
                )
            )
        return summaries

    def remove(self, name: str) -> str | None:
        self.calls.append(("rmi", name))
        if name in self.local:
            tags = [n for n, target in self.names.items() if target == name and "@" not in n]
            if len(tags) > 1:
                return "image is referenced in multiple tags"
            for alias in [n for n, target in self.names.items() if target == name]:
                del self.names[alias]
            del self.local[name]
            return None
        if name not in self.names:
            return "tag not known"
        image_id = self.names.pop(name)
        if image_id not in self.names.values():
            del self.local[image_id]
        return None

    # ServiceManager

    def start(self, unit: str, timeout: float | None) -> str | None:
        del timeout
        self.calls.append(("start", unit))
        if self.unit.migration is not None and unit == self.unit.migration.service:
            tag = self.unit.apps[self.unit.migration.app].local_tag("candidate")
            self.migration_saw = self.names.get(tag)
            return self.migration_error
        if self.states.get(unit) == "active":
            return None
        return self._launch(unit)

    def restart(self, unit: str, timeout: float | None) -> str | None:
        del timeout
        self.calls.append(("restart", unit))
        return self._launch(unit)

    def _launch(self, unit: str) -> str | None:
        image_id = self.names.get(self.unit_tags.get(unit, ""))
        if unit in self.failing_units or image_id is None:
            self.states[unit] = "failed"
            self.running.pop(unit, None)
            return f"Job for {unit} failed"
        self.states[unit] = "active"
        self.running[unit] = image_id
        return None

    def stop(self, unit: str, *, block: bool) -> str | None:
        self.calls.append(("stop" if block else "stop-no-block", unit))
        self.states[unit] = "deactivating" if not block and unit in self.slow_stop else "inactive"
        self.running.pop(unit, None)
        return None

    def reload(self, unit: str) -> str | None:
        self.calls.append(("reload", unit))
        return self.reload_errors.pop(0) if self.reload_errors else None

    def active_state(self, unit: str) -> str:
        return self.states.get(unit, "inactive")

    # Prober

    def _healthy(self, unit: str) -> bool:
        return self.states.get(unit) == "active" and self.running.get(unit) not in self.unhealthy

    def http(self, port: int, path: str) -> str | None:
        del path
        unit = self.port_units.get(port)
        if unit is not None and self._healthy(unit):
            return None
        return f"GET http://127.0.0.1:{port}: connection refused"

    def command(self, command: str, env: Mapping[str, str], timeout: float | None) -> CommandResult:
        del timeout
        container = env["APP_RELEASE_CONTAINER"]
        self.calls.append(("command", command, container, env["APP_RELEASE_SLOT"]))
        if command == PRE_STOP:
            return CommandResult(self.pre_stop_exit, "drained")
        healthy = self._healthy(f"podman-{container}.service")
        return CommandResult(0 if healthy else 1, "" if healthy else "not ready")


def new_world(unit: dict[str, object]) -> tuple[World, tempfile.TemporaryDirectory[str]]:
    directory = tempfile.TemporaryDirectory()
    return World(parse_unit(unit), Path(directory.name)), directory
