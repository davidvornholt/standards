"""A unit with a web app, a port-less worker and a recreate app, live at version 1."""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app_release.config import parse_unit
from app_release.podman import Image
from app_release.state import AppState, Release, State
from tests.fakes import PRE_STOP, SHA_A, WORKER_HEALTH, World, app_json, make_image, unit_json

APPS = ("jobs", "web", "worker")
MIGRATION = "shop-migrate.service"


class HostTestCase(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name)
        self.hashes = dict.fromkeys(APPS, "def-1")
        self.world = World(parse_unit(self.unit_data()), self.path)
        self.v1 = {name: make_image(f"{name}-1", SHA_A) for name in APPS}
        for name, image in self.v1.items():
            repository = self.repository(name)
            self.world.publish(repository, image, "production")
            self.world.store_locally(repository, image)
        self.world.run_unit("podman-web-blue.service", self.v1["web"])
        self.world.run_unit("podman-worker-blue.service", self.v1["worker"])
        self.world.run_unit("podman-jobs.service", self.v1["jobs"])
        self.upstream.write_text("127.0.0.1:8001\n")
        self.world.store.save(
            State(
                highest_run_id=50,
                apps={
                    name: AppState(
                        slot=None if name == "jobs" else "blue",
                        definition_hash="def-1",
                        current=Release(image.digest, SHA_A, 50, "2026-10-01T00:00:00Z"),
                        previous=None,
                    )
                    for name, image in self.v1.items()
                },
            )
        )

    @property
    def upstream(self) -> Path:
        return self.path / "web.upstream"

    def watch_stops(self) -> dict[str, tuple[str, list[float]]]:
        """Record the web upstream and the sleeps so far each time a unit stops."""
        seen: dict[str, tuple[str, list[float]]] = {}
        stop = self.world.stop

        def watched(unit: str, *, block: bool) -> str | None:
            seen[unit] = (self.upstream.read_text(), list(self.world.clock.sleeps))
            return stop(unit, block=block)

        patcher = patch.object(self.world, "stop", side_effect=watched)
        patcher.start()
        self.addCleanup(patcher.stop)
        return seen

    def unit_data(self) -> dict[str, object]:
        return unit_json(
            {
                "web": app_json(
                    "web",
                    ports=(8001, 8002),
                    upstream_dir=self.path,
                    definition_hash=self.hashes["web"],
                ),
                "worker": app_json(
                    "worker",
                    health_command=WORKER_HEALTH,
                    retire_without_waiting=True,
                    definition_hash=self.hashes["worker"],
                ),
                "jobs": app_json(
                    "jobs",
                    strategy="recreate",
                    health_port=9000,
                    pre_stop=PRE_STOP,
                    priority=10,
                    definition_hash=self.hashes["jobs"],
                ),
            },
            migration={"service": MIGRATION, "app": "web"},
        )

    def change_definition(self, name: str, definition_hash: str = "def-2") -> None:
        self.hashes[name] = definition_hash
        self.world.unit = parse_unit(self.unit_data())

    @staticmethod
    def repository(name: str) -> str:
        return f"ghcr.io/owner/{name}"

    def publish(self, version: int, revision: str, **content: str) -> dict[str, Image]:
        images = {
            name: make_image(f"{name}-{version}", revision, content.get(name)) for name in APPS
        }
        for name, image in images.items():
            self.world.publish(self.repository(name), image)
        return images

    def state(self) -> State:
        state = self.world.store.load()
        assert state is not None
        return state

    def command_calls(self, command: str) -> list[tuple[str, ...]]:
        return [call for call in self.world.calls if call[0] == "command" and call[1] == command]
