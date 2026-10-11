import json
import tempfile
import unittest
from pathlib import Path

from app_release.command import Request, parse_command, parse_request
from app_release.config import ConfigError, configured_units, load_unit, parse_unit
from app_release.errors import RejectedError
from app_release.state import (
    HISTORY_LIMIT,
    AppState,
    HistoryEntry,
    Release,
    State,
    StateError,
    StateStore,
)
from tests.fakes import SHA_A, WORKER_HEALTH, app_json, digest, unit_json


def shop() -> dict[str, object]:
    return unit_json(
        {
            "web": app_json("web", ports=(8001, 8002), upstream_dir=Path("/run/caddy")),
            "worker": app_json("worker", health_command=WORKER_HEALTH, retire_without_waiting=True),
            "jobs": app_json("jobs", strategy="recreate", health_port=9000, priority=10),
        },
        migration={"service": "shop-migrate.service", "app": "web"},
    )


class ConfigTest(unittest.TestCase):
    def test_parses_the_module_output(self) -> None:
        unit = parse_unit(shop())
        self.assertEqual(unit.name, "shop")
        self.assertEqual(sorted(unit.apps), ["jobs", "web", "worker"])
        web = unit.apps["web"]
        self.assertFalse(web.portless)
        self.assertEqual(web.health_port("green"), 8002)
        self.assertEqual(web.upstream_file, Path("/run/caddy/web.upstream"))
        self.assertEqual(web.unit("blue"), "podman-web-blue.service")
        self.assertEqual(web.active_tag("green"), "localhost/app-release/web:green")
        worker = unit.apps["worker"]
        self.assertTrue(worker.portless)
        self.assertTrue(worker.retire_without_waiting)
        self.assertIsNone(worker.health_port("blue"))
        jobs = unit.apps["jobs"]
        self.assertEqual(jobs.active_tag(None), "localhost/app-release/jobs:current")
        self.assertEqual(jobs.health_port(None), 9000)
        self.assertEqual([app.name for app in unit.recreate_order], ["jobs"])

    def test_rejects_an_unknown_strategy(self) -> None:
        data = shop()
        apps = data["apps"]
        assert isinstance(apps, dict)
        apps["web"]["strategy"] = "canary"
        with self.assertRaises(ConfigError):
            parse_unit(data)

    def test_rejects_slot_keys_that_do_not_match_the_strategy(self) -> None:
        data = shop()
        apps = data["apps"]
        assert isinstance(apps, dict)
        apps["jobs"]["units"] = {"blue": "a.service", "green": "b.service"}
        with self.assertRaises(ConfigError):
            parse_unit(data)

    def test_rejects_invalid_app_names(self) -> None:
        data = shop()
        apps = data["apps"]
        assert isinstance(apps, dict)
        apps["Web"] = apps.pop("web")
        data["migration"] = None
        with self.assertRaises(ConfigError):
            parse_unit(data)

    def test_rejects_a_migration_for_an_unknown_app(self) -> None:
        data = shop()
        data["migration"] = {"service": "x.service", "app": "missing"}
        with self.assertRaises(ConfigError):
            parse_unit(data)

    def test_load_unit_checks_the_name(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            (directory / "other.json").write_text(json.dumps(shop()))
            (directory / "shop.json").write_text(json.dumps(shop()))
            (directory / "broken.json").write_text("{")
            self.assertEqual(load_unit(directory, "shop").name, "shop")
            with self.assertRaises(ConfigError):
                load_unit(directory, "other")
            with self.assertRaises(ConfigError):
                load_unit(directory, "broken")
            with self.assertRaises(ConfigError):
                load_unit(directory, "missing")
            with self.assertRaises(ConfigError):
                load_unit(directory, "../shop")
            self.assertEqual(configured_units(directory), ["broken", "other", "shop"])


class CommandTest(unittest.TestCase):
    def setUp(self) -> None:
        self.unit = parse_unit(shop())

    def release_command(self, **digests: str) -> str:
        return " ".join(["release", *(f"{app}@{value}" for app, value in digests.items())])

    def test_release_names_every_app(self) -> None:
        digests = {name: digest(name) for name in ("web", "worker", "jobs")}
        request = parse_command(self.release_command(**digests), self.unit)
        self.assertEqual(request, Request("release", digests))
        self.assertEqual(parse_request(json.loads(json.dumps(request.to_json()))), request)

    def test_rollback_and_status_take_no_arguments(self) -> None:
        self.assertEqual(parse_command("rollback", self.unit), Request("rollback", {}))
        self.assertEqual(parse_command("status", self.unit), Request("status", {}))
        with self.assertRaises(RejectedError):
            parse_command("status now", self.unit)

    def test_rejects_commands_outside_the_grammar(self) -> None:
        full = {name: digest(name) for name in ("web", "worker", "jobs")}
        bad = [
            None,
            "",
            "deploy",
            "status;id",
            self.release_command(web=digest("web")),
            self.release_command(**full, other=digest("x")),
            self.release_command(**full) + f" web@{digest('again')}",
            self.release_command(**full).replace("sha256:", "sha512:"),
            self.release_command(**full).upper(),
            self.release_command(**full) + " ",
            "release  " + self.release_command(**full).removeprefix("release "),
            "x" * 9000,
        ]
        for command in bad:
            with self.subTest(command=command), self.assertRaises(RejectedError):
                parse_command(command, self.unit)


class StateTest(unittest.TestCase):
    def test_round_trips_through_the_file(self) -> None:
        state = State(
            highest_run_id=12,
            apps={
                "web": AppState(
                    slot="green",
                    definition_hash="def-1",
                    current=Release(digest("2"), SHA_A, 12, "2026-10-11T12:00:00Z"),
                    previous=Release(digest("1"), None, 11, "2026-10-10T12:00:00Z"),
                ),
                "jobs": AppState(
                    slot=None,
                    definition_hash=None,
                    current=Release(digest("j"), SHA_A, 12, "2026-10-11T12:00:00Z"),
                    previous=None,
                ),
            },
            history=(HistoryEntry("t", "release", "released", 12, "octocat", {"web": "d"}),),
        )
        with tempfile.TemporaryDirectory() as name:
            store = StateStore(Path(name) / "shop" / "state.json")
            self.assertIsNone(store.load())
            store.save(state)
            self.assertEqual(store.load(), state)
            self.assertEqual(store.path.stat().st_mode & 0o777, 0o644)
            self.assertEqual(
                sorted(path.name for path in store.path.parent.iterdir()), ["state.json"]
            )

    def test_history_keeps_the_last_entries(self) -> None:
        state = State(highest_run_id=0, apps={})
        for run_id in range(HISTORY_LIMIT + 5):
            state = state.with_history(HistoryEntry("t", "release", "released", run_id, None, {}))
        self.assertEqual(len(state.history), HISTORY_LIMIT)
        self.assertEqual(state.history[0].run_id, 5)

    def test_malformed_state_is_an_error(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            store = StateStore(Path(name) / "state.json")
            store.path.write_text('{"highestRunId": "1", "apps": {}}')
            with self.assertRaises(StateError):
                store.load()
            store.path.write_text("not json")
            with self.assertRaises(StateError):
                store.load()


if __name__ == "__main__":
    unittest.main()
