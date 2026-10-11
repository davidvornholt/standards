import unittest
from dataclasses import replace
from unittest.mock import patch

from app_release.config import SlotPorts
from app_release.errors import CriticalError, ExitCode, FailedError
from app_release.reconcile import reconcile, refresh
from app_release.release import release
from tests.base import APPS, HostTestCase
from tests.fakes import PRE_STOP, SHA_B, claims


class BootstrapTest(HostTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.world.store.path.unlink()
        self.world.local.clear()
        self.world.names.clear()
        self.world.states = {"caddy.service": "active"}
        self.world.running.clear()

    def test_bootstrap_from_the_production_tag(self) -> None:
        reconcile(self.world.context())
        state = self.state()
        self.assertEqual(state.highest_run_id, 0)
        self.assertEqual(state.history[-1].operation, "bootstrap")
        for name in APPS:
            app = state.apps[name]
            self.assertEqual(app.current.digest, self.v1[name].digest)
            self.assertEqual(app.current.revision, self.v1[name].revision)
            self.assertIsNone(app.previous)
            self.assertEqual(app.definition_hash, "def-1")
        self.assertEqual(state.apps["web"].slot, "blue")
        self.assertIsNone(state.apps["jobs"].slot)
        self.assertEqual(self.world.running["podman-web-blue.service"], self.v1["web"].id)
        self.assertEqual(self.world.running["podman-worker-blue.service"], self.v1["worker"].id)
        self.assertEqual(self.world.running["podman-jobs.service"], self.v1["jobs"].id)
        self.assertEqual(self.upstream.read_text(), "to 127.0.0.1:8001\n")

    def test_missing_production_tag_names_the_app_and_tag(self) -> None:
        del self.world.registry["ghcr.io/owner/worker:production"]
        with self.assertRaises(FailedError) as raised:
            reconcile(self.world.context())
        self.assertIn("worker", raised.exception.message)
        self.assertIn("ghcr.io/owner/worker:production", raised.exception.message)
        self.assertIsNone(self.world.store.load())


class ReconcileTest(HostTestCase):
    def test_running_apps_with_unchanged_definitions_stay_untouched(self) -> None:
        reconcile(self.world.context())
        self.assertEqual(self.world.restarts(), [])
        self.assertFalse([call for call in self.world.calls if call[0].startswith("stop")])

    def test_boot_starts_the_active_slots(self) -> None:
        self.world.states = {"caddy.service": "active"}
        self.world.running.clear()
        self.state_with_web_on_green()
        reconcile(self.world.context())
        self.assertEqual(self.world.running["podman-web-green.service"], self.v1["web"].id)
        self.assertEqual(self.world.active_state("podman-web-blue.service"), "inactive")
        self.assertEqual(self.upstream.read_text(), "to 127.0.0.1:8002\n")
        self.assertIn(("reload", "caddy.service"), self.world.calls)

    def test_upstream_is_reloaded_before_the_old_slot_stops(self) -> None:
        self.state_with_web_on_green()
        self.world.run_unit("podman-web-green.service", self.v1["web"])
        self.world.reload_errors = ["temporary reload failure"]
        with self.assertRaises(FailedError):
            reconcile(self.world.context())
        self.assertEqual(self.world.active_state("podman-web-blue.service"), "active")
        self.assertEqual(self.upstream.read_text(), "to 127.0.0.1:8002\n")
        self.world.calls.clear()
        reconcile(self.world.context())
        calls = self.world.calls
        self.assertLess(
            calls.index(("reload", "caddy.service")),
            calls.index(("stop", "podman-web-blue.service")),
        )

    def test_changed_blue_green_definition_moves_to_the_idle_slot(self) -> None:
        self.change_definition("web")
        reconcile(self.world.context())
        state = self.state()
        self.assertEqual(state.apps["web"].slot, "green")
        self.assertEqual(state.apps["web"].definition_hash, "def-2")
        self.assertEqual(state.apps["web"].current.digest, self.v1["web"].digest)
        self.assertEqual(self.upstream.read_text(), "to 127.0.0.1:8002\n")
        self.assertEqual(self.world.running["podman-web-green.service"], self.v1["web"].id)
        self.assertIn(("stop", "podman-web-blue.service"), self.world.calls)
        self.assertEqual(state.history[-1].operation, "refresh")

    def test_failed_port_change_refresh_preserves_the_live_upstream(self) -> None:
        app = replace(
            self.world.unit.apps["web"],
            slot_ports=SlotPorts(8101, 8102),
            definition_hash="def-2",
        )
        self.world.unit = replace(self.world.unit, apps={**self.world.unit.apps, "web": app})
        self.world.port_units[8102] = "podman-web-green.service"
        self.world.reload_errors = ["temporary reload failure"]
        before = self.state()
        with self.assertRaises(FailedError):
            reconcile(self.world.context())
        self.assertEqual(self.state(), before)
        self.assertEqual(self.upstream.read_text(), "to 127.0.0.1:8001\n")
        self.assertEqual(self.world.running["podman-web-blue.service"], self.v1["web"].id)
        reconcile(self.world.context())
        self.assertEqual(self.upstream.read_text(), "to 127.0.0.1:8102\n")
        self.assertEqual(self.state().apps["web"].definition_hash, "def-2")

    def test_changed_recreate_definition_runs_pre_stop_then_restarts(self) -> None:
        self.change_definition("jobs")
        reconcile(self.world.context())
        calls = self.world.calls
        self.assertLess(
            calls.index(("command", PRE_STOP, "jobs", "")),
            calls.index(("restart", "podman-jobs.service")),
        )
        self.assertEqual(self.state().apps["jobs"].definition_hash, "def-2")

    def test_failed_pre_stop_keeps_the_old_definition(self) -> None:
        self.change_definition("jobs")
        self.world.pre_stop_exit = 1
        with self.assertRaises(FailedError):
            reconcile(self.world.context())
        self.assertNotIn(("restart", "podman-jobs.service"), self.world.calls)
        self.assertEqual(self.state().apps["jobs"].definition_hash, "def-1")

    def test_failed_recreate_refresh_clears_the_definition_hash(self) -> None:
        self.change_definition("jobs")
        for failure in ("health", "restart"):
            with self.subTest(failure=failure):
                self.world.unhealthy.clear()
                if failure == "health":
                    self.world.unhealthy.add(self.v1["jobs"].id)
                else:
                    self.world.failing_units.add("podman-jobs.service")
                with self.assertRaises(CriticalError) as raised:
                    reconcile(self.world.context())
                self.assertEqual(raised.exception.exit_code, ExitCode.CRITICAL)
                self.assertIn("may be down", raised.exception.message)
                self.assertIsNone(self.state().apps["jobs"].definition_hash)

    def test_draining_worker_keeps_its_definition_without_failing(self) -> None:
        self.change_definition("worker")
        self.world.states["podman-worker-green.service"] = "deactivating"
        reconcile(self.world.context())
        state = self.state()
        self.assertEqual(state.apps["worker"].definition_hash, "def-1")
        self.assertEqual(state.apps["worker"].slot, "blue")
        self.assertIn("still draining", self.world.output())
        self.assertNotIn(("restart", "podman-worker-green.service"), self.world.calls)
        self.assertFalse(
            [call for call in self.world.calls if call[1:] == ("podman-worker-green.service",)]
        )

    def test_clean_up_stops_inactive_slots(self) -> None:
        v2 = self.publish(2, SHA_B)
        self.world.slow_stop.add("podman-worker-blue.service")
        with (
            patch.object(self.world.clock, "sleep", side_effect=KeyboardInterrupt),
            self.assertRaises(KeyboardInterrupt),
        ):
            release(
                self.world.context(), claims(), {name: image.digest for name, image in v2.items()}
            )
        self.assertEqual(self.state().apps["web"].slot, "green")
        self.assertEqual(self.world.active_state("podman-web-blue.service"), "active")
        self.assertEqual(self.world.active_state("podman-worker-blue.service"), "deactivating")
        self.world.calls.clear()
        with patch.object(self.world.clock, "sleep", wraps=self.world.clock.sleep) as sleep:
            reconcile(self.world.context())
        sleep.assert_called_once_with(10)
        self.assertIn(("stop", "podman-web-blue.service"), self.world.calls)
        self.assertNotIn(("stop", "podman-worker-blue.service"), self.world.calls)
        self.assertEqual(self.world.active_state("podman-worker-blue.service"), "deactivating")

    def test_wrong_tag_on_a_running_app_restarts_it(self) -> None:
        stray = self.publish(9, "f" * 40)["jobs"]
        self.world.store_locally("ghcr.io/owner/jobs", stray)
        self.world.run_unit("podman-jobs.service", stray)
        self.world.pre_stop_exit = 1
        with self.assertRaises(FailedError):
            reconcile(self.world.context())
        self.assertIsNone(self.state().apps["jobs"].definition_hash)
        self.assertEqual(self.world.names["localhost/app-release/jobs:current"], self.v1["jobs"].id)
        self.assertEqual(self.world.running["podman-jobs.service"], stray.id)
        self.world.pre_stop_exit = 0
        reconcile(self.world.context())
        self.assertEqual(self.world.running["podman-jobs.service"], self.v1["jobs"].id)
        self.assertEqual(self.state().apps["jobs"].definition_hash, "def-1")

    def test_refresh_restarts_every_app_without_downtime(self) -> None:
        refresh(self.world.context())
        state = self.state()
        self.assertEqual(state.apps["web"].slot, "green")
        self.assertEqual(state.apps["worker"].slot, "green")
        self.assertIn(("restart", "podman-jobs.service"), self.world.calls)
        self.assertEqual(len(self.command_calls(PRE_STOP)), 1)
        self.assertIn(("stop-no-block", "podman-worker-blue.service"), self.world.calls)
        for name in APPS:
            self.assertEqual(state.apps[name].current.digest, self.v1[name].digest)

    def test_unhealthy_app_at_boot_fails_the_reconcile(self) -> None:
        self.world.states = {"caddy.service": "active"}
        self.world.running.clear()
        self.world.unhealthy.add(self.v1["jobs"].id)
        with self.assertRaises(FailedError):
            reconcile(self.world.context())

    def state_with_web_on_green(self) -> None:
        state = self.state()
        web = state.apps["web"]
        self.world.store.save(state.with_app("web", replace(web, slot="green")))
        self.world.names["localhost/app-release/web:green"] = self.v1["web"].id


if __name__ == "__main__":
    unittest.main()
