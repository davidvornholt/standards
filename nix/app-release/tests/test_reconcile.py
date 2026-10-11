import unittest
from dataclasses import replace
from unittest.mock import patch

from app_release.config import Slot, SlotPorts
from app_release.errors import CriticalError, ExitCode, FailedError, RejectedError
from app_release.reconcile import check, prepare, reconcile, refresh
from app_release.release import release
from tests.base import APPS, HostTestCase
from tests.fakes import PRE_STOP, SHA_B, claims


class BootstrapTest(HostTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.world.store.path.unlink()
        self.world.local.clear()
        self.world.names.clear()
        self.world.states.clear()
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
        self.assertEqual(self.upstream.read_text(), "127.0.0.1:8001\n")

    def test_missing_production_tag_names_the_app_and_tag(self) -> None:
        del self.world.registry["ghcr.io/owner/worker:production"]
        with self.assertRaises(FailedError) as raised:
            reconcile(self.world.context())
        self.assertIn("worker", raised.exception.message)
        self.assertIn("ghcr.io/owner/worker:production", raised.exception.message)
        self.assertIsNone(self.world.store.load())


class PrepareTest(HostTestCase):
    JOBS_TAG = "localhost/app-release/jobs:current"

    def forget_state(self) -> None:
        self.world.store.path.unlink()
        self.world.local.clear()
        self.world.names.clear()
        self.world.states.clear()
        self.world.running.clear()

    def test_an_existing_tag_is_left_alone(self) -> None:
        self.world.names[self.JOBS_TAG] = self.v1["web"].id
        prepare(self.world.context(), "jobs", None)
        self.assertEqual(self.world.calls, [])
        self.assertEqual(self.world.names[self.JOBS_TAG], self.v1["web"].id)

    def test_a_missing_tag_names_the_image_of_the_state(self) -> None:
        del self.world.names[self.JOBS_TAG]
        prepare(self.world.context(), "jobs", None)
        self.assertEqual(self.world.names[self.JOBS_TAG], self.v1["jobs"].id)
        self.assertFalse([call for call in self.world.calls if call[0] == "pull"])

    def test_recreate_uses_the_recorded_image_after_a_strategy_change(self) -> None:
        state = self.state()
        self.world.registry["ghcr.io/owner/jobs:production"] = self.v1["web"]
        slots: tuple[Slot, ...] = ("blue", "green")
        for slot in slots:
            with self.subTest(slot=slot):
                stored = state.with_app("jobs", replace(state.apps["jobs"], slot=slot))
                self.world.store.save(stored)
                self.world.names.pop(self.JOBS_TAG, None)
                with patch.object(self.world.store, "save") as save:
                    prepare(self.world.context(), "jobs", None)
                    save.assert_not_called()
                self.assertEqual(self.world.names.get(self.JOBS_TAG), self.v1["jobs"].id)
                self.assertEqual(self.state(), stored)

    def test_before_the_first_reconcile_the_tag_comes_from_production(self) -> None:
        self.forget_state()
        prepare(self.world.context(), "jobs", None)
        self.assertIn(("pull", "ghcr.io/owner/jobs:production"), self.world.calls)
        self.assertIsNone(self.world.start("podman-jobs.service", timeout=None))
        self.assertEqual(self.world.running["podman-jobs.service"], self.v1["jobs"].id)
        self.assertIsNone(self.world.store.load())

    def test_the_first_reconcile_restarts_a_container_started_early_once(self) -> None:
        self.forget_state()
        prepare(self.world.context(), "jobs", None)
        self.world.start("podman-jobs.service", timeout=None)
        reconcile(self.world.context())
        state = self.state()
        self.assertEqual([entry.operation for entry in state.history], ["bootstrap", "refresh"])
        self.assertEqual(self.world.restarts().count("podman-jobs.service"), 1)
        self.assertEqual(state.apps["jobs"].definition_hash, "def-1")
        self.assertEqual(self.world.running["podman-jobs.service"], self.v1["jobs"].id)

    def test_before_the_first_reconcile_only_blue_is_tagged(self) -> None:
        self.forget_state()
        prepare(self.world.context(), "web", "green")
        self.assertNotIn("localhost/app-release/web:green", self.world.names)
        prepare(self.world.context(), "web", "blue")
        self.assertEqual(self.world.names["localhost/app-release/web:blue"], self.v1["web"].id)

    def test_only_the_active_slot_of_the_state_is_tagged(self) -> None:
        state = self.state()
        self.world.store.save(state.with_app("web", replace(state.apps["web"], slot="green")))
        del self.world.names["localhost/app-release/web:blue"]
        prepare(self.world.context(), "web", "blue")
        self.assertNotIn("localhost/app-release/web:blue", self.world.names)
        prepare(self.world.context(), "web", "green")
        self.assertEqual(self.world.names["localhost/app-release/web:green"], self.v1["web"].id)

    def test_rejects_containers_the_unit_does_not_have(self) -> None:
        cases: tuple[tuple[str, Slot | None], ...] = (
            ("missing", None),
            ("web", None),
            ("jobs", "blue"),
        )
        for app, slot in cases:
            with self.subTest(app=app, slot=slot), self.assertRaises(RejectedError):
                prepare(self.world.context(), app, slot)


class ReconcileTest(HostTestCase):
    def test_running_apps_with_unchanged_definitions_stay_untouched(self) -> None:
        reconcile(self.world.context())
        self.assertEqual(self.world.restarts(), [])
        self.assertFalse([call for call in self.world.calls if call[0].startswith("stop")])

    def test_boot_starts_the_active_slots(self) -> None:
        self.world.states.clear()
        self.world.running.clear()
        self.state_with_web_on_green()
        reconcile(self.world.context())
        self.assertEqual(self.world.running["podman-web-green.service"], self.v1["web"].id)
        self.assertEqual(self.world.active_state("podman-web-blue.service"), "inactive")
        self.assertEqual(self.upstream.read_text(), "127.0.0.1:8002\n")

    def test_a_started_slot_gets_traffic_only_once_healthy(self) -> None:
        self.world.states.clear()
        self.world.running.clear()
        self.state_with_web_on_green()
        self.world.unhealthy.add(self.v1["web"].id)
        reconcile(self.world.context())
        self.assertEqual(self.upstream.read_text(), "127.0.0.1:8001\n")
        self.world.unhealthy.clear()
        reconcile(self.world.context())
        self.assertEqual(self.upstream.read_text(), "127.0.0.1:8002\n")

    def test_traffic_moves_to_the_active_slot_before_the_other_slot_drains_and_stops(
        self,
    ) -> None:
        # A release that died between the switch and the state commit leaves the
        # upstream on the slot the state does not record as active.
        self.state_with_web_on_green()
        self.world.run_unit("podman-web-green.service", self.v1["web"])
        stops = self.watch_stops()
        reconcile(self.world.context())
        upstream, sleeps = stops["podman-web-blue.service"]
        self.assertEqual(upstream, "127.0.0.1:8002\n")
        self.assertEqual(sleeps, [10])
        self.assertEqual(self.world.active_state("podman-web-blue.service"), "inactive")

    def test_changed_blue_green_definition_moves_to_the_idle_slot(self) -> None:
        self.change_definition("web")
        reconcile(self.world.context())
        state = self.state()
        self.assertEqual(state.apps["web"].slot, "green")
        self.assertEqual(state.apps["web"].definition_hash, "def-2")
        self.assertEqual(state.apps["web"].current.digest, self.v1["web"].digest)
        self.assertEqual(self.upstream.read_text(), "127.0.0.1:8002\n")
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
        self.world.unhealthy.add(self.v1["web"].id)
        before = self.state()
        with self.assertRaises(FailedError):
            reconcile(self.world.context())
        self.assertEqual(self.state(), before)
        self.assertEqual(self.upstream.read_text(), "127.0.0.1:8001\n")
        self.assertEqual(self.world.running["podman-web-blue.service"], self.v1["web"].id)
        self.world.unhealthy.clear()
        reconcile(self.world.context())
        self.assertEqual(self.upstream.read_text(), "127.0.0.1:8102\n")
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

    def test_failed_recreate_refresh_records_the_definition_it_started(self) -> None:
        for failure in ("health", "restart"):
            with self.subTest(failure=failure):
                self.world.run_unit("podman-jobs.service", self.v1["jobs"])
                self.change_definition("jobs", f"def-{failure}")
                self.world.unhealthy.clear()
                if failure == "health":
                    self.world.unhealthy.add(self.v1["jobs"].id)
                else:
                    self.world.failing_units.add("podman-jobs.service")
                with self.assertRaises(CriticalError) as raised:
                    reconcile(self.world.context())
                self.assertEqual(raised.exception.exit_code, ExitCode.CRITICAL)
                self.assertIn("may be down", raised.exception.message)
                self.assertEqual(self.state().apps["jobs"].definition_hash, f"def-{failure}")
                # The host rollback restores the old definition and starts its stopped unit.
                self.world.stop("podman-jobs.service", block=True)
                self.change_definition("jobs", "def-1")
                with self.assertRaises(FailedError):
                    reconcile(self.world.context())
                self.assertEqual(self.state().apps["jobs"].definition_hash, "def-1")
                # Restoration and later activations retry that attempted definition.
                for _ in range(2):
                    seen = len(self.world.output())
                    reconcile(self.world.context())
                    self.assertIn("jobs stays down", self.world.output()[seen:])

    def test_draining_worker_keeps_its_definition_without_failing(self) -> None:
        self.change_definition("worker")
        self.world.states["podman-worker-green.service"] = "deactivating"
        # Even an unhealthy worker leaves the drain alone.
        self.world.unhealthy.add(self.v1["worker"].id)
        reconcile(self.world.context())
        state = self.state()
        self.assertEqual(state.apps["worker"].definition_hash, "def-1")
        self.assertEqual(state.apps["worker"].slot, "blue")
        self.assertIn("still draining", self.world.output())
        self.assertIn("worker stays down", self.world.output())
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

    def test_refresh_fails_when_an_unchanged_stopped_app_cannot_start(self) -> None:
        for name in ("jobs", "web"):
            unit = self.world.unit.apps[name].unit(self.state().apps[name].slot)
            for failure in ("health", "restart"):
                with self.subTest(app=name, failure=failure):
                    self.world.unhealthy.clear()
                    self.world.failing_units.clear()
                    if failure == "health":
                        self.world.unhealthy.add(self.v1[name].id)
                    else:
                        self.world.failing_units.add(unit)
                    for _ in range(2):
                        self.world.stop(unit, block=True)
                        with self.assertRaises(FailedError) as raised:
                            refresh(self.world.context())
                        self.assertIn(name, raised.exception.message)
                    self.world.run_unit(unit, self.v1[name])

    def test_a_stopped_app_that_fails_on_its_new_definition_fails_the_reconcile(self) -> None:
        self.world.stop("podman-jobs.service", block=True)
        self.change_definition("jobs")
        self.world.unhealthy.add(self.v1["jobs"].id)
        with self.assertRaises(FailedError) as raised:
            reconcile(self.world.context())
        self.assertIn("jobs: not healthy", raised.exception.message)
        self.assertEqual(self.state().apps["jobs"].definition_hash, "def-2")

    def test_an_unhealthy_running_app_is_restarted_at_its_current_digest(self) -> None:
        # The running containers hang; new containers of the same images are healthy.
        for unit in ("podman-web-blue.service", "podman-jobs.service"):
            self.world.running[unit] = "hung"
        self.world.unhealthy.add("hung")
        self.world.pre_stop_exit = 1
        reconcile(self.world.context())
        state = self.state()
        self.assertEqual(state.apps["web"].slot, "green")
        self.assertEqual(self.upstream.read_text(), "127.0.0.1:8002\n")
        self.assertEqual(self.world.active_state("podman-web-blue.service"), "inactive")
        self.assertEqual(self.world.running["podman-jobs.service"], self.v1["jobs"].id)
        self.assertEqual(state.apps["worker"].slot, "blue")
        self.assertEqual(state.history[-1].operation, "recover")
        self.assertEqual(
            state.history[-1].apps, {name: self.v1[name].digest for name in ("jobs", "web")}
        )

    def test_an_unchanged_app_that_stays_down_only_warns_and_settles_its_units(self) -> None:
        # Failing would fail the host activation and its rollback alike; the check reports it.
        # Web is stopped, jobs hangs, and the worker is unhealthy: each start fails.
        web_blue, jobs = "podman-web-blue.service", "podman-jobs.service"
        worker_green = "podman-worker-green.service"
        # The failed refresh tells the worker's new slot to stop without waiting.
        self.world.slow_stop.add(worker_green)
        self.world.stop(web_blue, block=True)
        self.world.unhealthy |= {"hung", self.v1["worker"].id}
        self.world.failing_units |= {web_blue, jobs, worker_green}
        for failing_state in ("failed", "activating"):
            with self.subTest(failing_state=failing_state):
                self.world.failing_state = failing_state
                self.world.states[jobs] = "active"
                self.world.running[jobs] = "hung"
                reconcile(self.world.context())
                output = self.world.output()
                for name in ("jobs", "web", "worker"):
                    self.assertIn(f"{name} stays down", output)
                for unit in (web_blue, jobs, worker_green):
                    self.assertEqual(self.world.active_state(unit), "inactive")
                self.assertEqual(self.state().apps["web"].slot, "blue")
                self.assertEqual(self.upstream.read_text(), "127.0.0.1:8001\n")

    def test_check_names_each_unhealthy_app_without_changing_anything(self) -> None:
        check(self.world.context())
        self.world.running["podman-web-blue.service"] = "hung"
        self.world.unhealthy.add("hung")
        self.world.stop("podman-jobs.service", block=True)
        self.world.calls.clear()
        with self.assertRaises(FailedError) as raised:
            check(self.world.context())
        message = raised.exception.message
        self.assertIn("jobs: podman-jobs.service stopped (inactive)", message)
        self.assertIn("web: not healthy within 5 s", message)
        self.assertNotIn("worker", message)
        self.assertIn("app-release refresh shop", message)
        self.assertEqual({call[0] for call in self.world.calls}, {"command"})

    def state_with_web_on_green(self) -> None:
        state = self.state()
        web = state.apps["web"]
        self.world.store.save(state.with_app("web", replace(web, slot="green")))
        self.world.names["localhost/app-release/web:green"] = self.v1["web"].id


if __name__ == "__main__":
    unittest.main()
