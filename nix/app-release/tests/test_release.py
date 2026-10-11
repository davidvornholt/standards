import os
import stat
import unittest
from functools import partial
from pathlib import Path
from typing import TYPE_CHECKING
from unittest.mock import patch

from app_release.errors import CriticalError, ExitCode, FailedError, RejectedError
from app_release.fsutil import atomic_write_text
from app_release.reconcile import refresh
from app_release.release import release, rollback
from app_release.state import AppState, Release, State
from tests.base import MIGRATION, HostTestCase
from tests.fakes import PRE_STOP, SHA_A, SHA_B, SHA_C, claims, make_image

if TYPE_CHECKING:
    from collections.abc import Callable

DRAINING = (
    "worker: the previous worker in slot green is still draining; nothing changed. "
    "Re-run this release after it stops."
)


class ReleaseTest(HostTestCase):
    def release_v2(self, **content: str) -> None:
        self.v2 = self.publish(2, SHA_B, **content)
        self.outcome = release(
            self.world.context(),
            claims(100),
            {name: image.digest for name, image in self.v2.items()},
        )

    def test_release_moves_every_app_to_the_new_version(self) -> None:
        self.release_v2()
        self.assertEqual(self.outcome.result, "released")
        state = self.state()
        self.assertEqual(state.highest_run_id, 100)
        for name in ("web", "worker"):
            self.assertEqual(state.apps[name].slot, "green")
        self.assertIsNone(state.apps["jobs"].slot)
        for name, image in self.v2.items():
            self.assertEqual(state.apps[name].current.digest, image.digest)
            self.assertEqual(state.apps[name].current.revision, SHA_B)
            self.assertEqual(state.apps[name].current.run_id, 100)
            previous = state.apps[name].previous
            self.assertIsNotNone(previous)
            self.assertEqual(previous.digest if previous else None, self.v1[name].digest)
        self.assertEqual(self.upstream.read_text(), "to 127.0.0.1:8002\n")
        self.assertEqual(self.world.running["podman-web-green.service"], self.v2["web"].id)
        self.assertEqual(self.world.running["podman-worker-green.service"], self.v2["worker"].id)
        self.assertEqual(self.world.running["podman-jobs.service"], self.v2["jobs"].id)
        self.assertEqual(state.history[-1].operation, "release")
        self.assertEqual(state.history[-1].actor, "octocat")

    def test_migration_runs_first_with_the_candidate_image(self) -> None:
        self.release_v2()
        calls = self.world.calls
        migration = calls.index(("start", MIGRATION))
        first_restart = next(i for i, call in enumerate(calls) if call[0] == "restart")
        self.assertLess(migration, first_restart)
        self.assertEqual(self.world.migration_saw, self.v2["web"].id)
        self.assertNotIn("localhost/app-release/web:candidate", self.world.names)

    def test_pre_stop_runs_before_the_recreate_restart(self) -> None:
        self.release_v2()
        calls = self.world.calls
        pre_stop = calls.index(("command", PRE_STOP, "jobs", ""))
        self.assertLess(pre_stop, calls.index(("restart", "podman-jobs.service")))

    def test_old_slots_retire_after_the_drain(self) -> None:
        self.release_v2()
        self.assertIn(10, self.world.clock.sleeps)
        self.assertIn(("stop", "podman-web-blue.service"), self.world.calls)
        self.assertIn(("stop-no-block", "podman-worker-blue.service"), self.world.calls)
        self.assertEqual(self.world.calls.count(("reload", "caddy.service")), 1)

    def test_newer_release_supersedes_an_older_run(self) -> None:
        v2 = self.publish(2, SHA_B)
        outcome = release(
            self.world.context(), claims(40), {name: image.digest for name, image in v2.items()}
        )
        self.assertEqual(outcome.result, "superseded")
        self.assertEqual(self.world.calls, [])
        self.assertEqual(self.state().highest_run_id, 50)

    def test_revision_mismatch_is_rejected_before_anything_moves(self) -> None:
        v2 = self.publish(2, SHA_C)
        before = self.state()
        with self.assertRaises(RejectedError) as raised:
            release(
                self.world.context(),
                claims(100),
                {name: image.digest for name, image in v2.items()},
            )
        self.assertEqual(raised.exception.exit_code, ExitCode.REJECTED)
        self.assertEqual(self.world.restarts(), [])
        self.assertEqual(self.state(), before)

    def test_failed_health_check_keeps_the_previous_version(self) -> None:
        v2 = self.publish(2, SHA_B)
        self.world.unhealthy.add(v2["web"].id)
        before = self.state()
        with self.assertRaises(FailedError) as raised:
            release(
                self.world.context(),
                claims(100),
                {name: image.digest for name, image in v2.items()},
            )
        self.assertIn("web: not healthy within 5 s", raised.exception.message)
        self.assertEqual(self.state(), before)
        self.assertEqual(self.upstream.read_text(), "to 127.0.0.1:8001\n")
        self.assertEqual(self.world.states["podman-web-green.service"], "inactive")
        self.assertEqual(self.world.states["podman-worker-green.service"], "inactive")
        self.assertNotIn(("restart", "podman-jobs.service"), self.world.calls)
        self.assertEqual(self.world.running["podman-web-blue.service"], self.v1["web"].id)

    def test_failed_recreate_restores_the_previous_image(self) -> None:
        v2 = self.publish(2, SHA_B)
        for name in list(self.world.names):
            if self.world.names[name] == self.v1["jobs"].id:
                del self.world.names[name]
        self.world.unhealthy.add(v2["jobs"].id)
        before = self.state()
        with self.assertRaises(FailedError) as raised:
            release(
                self.world.context(),
                claims(100),
                {name: image.digest for name, image in v2.items()},
            )
        self.assertEqual(self.state(), before)
        self.assertEqual(raised.exception.exit_code, ExitCode.FAILED)
        self.assertIn(("pull", f"ghcr.io/owner/jobs@{self.v1['jobs'].digest}"), self.world.calls)
        self.assertEqual(self.world.running["podman-jobs.service"], self.v1["jobs"].id)
        self.assertEqual(self.world.names["localhost/app-release/jobs:current"], self.v1["jobs"].id)
        self.assertEqual(self.world.states["podman-web-green.service"], "inactive")
        self.assertEqual(len(self.command_calls(PRE_STOP)), 2)

    def test_failed_restore_is_critical(self) -> None:
        v2 = self.publish(2, SHA_B)
        self.world.unhealthy |= {v2["jobs"].id, self.v1["jobs"].id}
        with self.assertRaises(CriticalError) as raised:
            release(
                self.world.context(),
                claims(100),
                {name: image.digest for name, image in v2.items()},
            )
        self.assertEqual(raised.exception.exit_code, ExitCode.CRITICAL)
        self.assertEqual(self.state().apps["jobs"].current.digest, self.v1["jobs"].digest)

    def test_failed_migration_changes_nothing(self) -> None:
        v2 = self.publish(2, SHA_B)
        self.world.migration_error = "exit status 1"
        with self.assertRaises(FailedError) as raised:
            release(
                self.world.context(),
                claims(100),
                {name: image.digest for name, image in v2.items()},
            )
        self.assertIn(f"migration {MIGRATION} failed", raised.exception.message)
        self.assertEqual(self.world.restarts(), [])
        self.assertNotIn("localhost/app-release/web:candidate", self.world.names)

    def test_failed_reload_switches_back(self) -> None:
        v2 = self.publish(2, SHA_B)
        self.world.reload_errors = ["caddy reload failed"]
        before = self.state()
        with self.assertRaises(FailedError):
            release(
                self.world.context(),
                claims(100),
                {name: image.digest for name, image in v2.items()},
            )
        self.assertEqual(self.state(), before)
        self.assertEqual(self.upstream.read_text(), "to 127.0.0.1:8001\n")
        self.assertEqual(self.world.calls.count(("reload", "caddy.service")), 2)
        self.assertEqual(self.world.running["podman-jobs.service"], self.v1["jobs"].id)

    def test_failed_reload_twice_is_critical(self) -> None:
        v2 = self.publish(2, SHA_B)
        self.world.reload_errors = ["caddy reload failed", "caddy reload failed"]
        with self.assertRaises(CriticalError):
            release(
                self.world.context(),
                claims(100),
                {name: image.digest for name, image in v2.items()},
            )

    def test_failed_pre_stop_aborts_before_the_switch(self) -> None:
        v2 = self.publish(2, SHA_B)
        self.world.pre_stop_exit = 1
        before = self.state()
        with self.assertRaises(FailedError) as raised:
            release(
                self.world.context(),
                claims(100),
                {name: image.digest for name, image in v2.items()},
            )
        self.assertIn("preStopCommand exited with status 1", raised.exception.message)
        self.assertEqual(self.state(), before)
        self.assertNotIn(("restart", "podman-jobs.service"), self.world.calls)
        self.assertIn(("stop", "podman-web-green.service"), self.world.calls)
        self.assertIn(("stop-no-block", "podman-worker-green.service"), self.world.calls)

    def test_content_identical_image_is_recorded_without_a_restart(self) -> None:
        self.release_v2(web="content-web-1")
        state = self.state()
        self.assertEqual(state.apps["web"].current.digest, self.v2["web"].digest)
        self.assertIsNone(state.apps["web"].previous)
        self.assertEqual(state.apps["web"].slot, "blue")
        self.assertNotIn(("restart", "podman-web-green.service"), self.world.calls)
        self.assertEqual(self.world.names["localhost/app-release/web:blue"], self.v2["web"].id)
        self.assertEqual(self.upstream.read_text(), "to 127.0.0.1:8001\n")

    def test_nothing_changed_reports_unchanged(self) -> None:
        outcome = release(
            self.world.context(),
            claims(60, sha=SHA_A),
            {name: image.digest for name, image in self.v1.items()},
        )
        self.assertEqual(outcome.result, "unchanged")
        self.assertEqual(self.world.restarts(), [])
        self.assertEqual(self.state().highest_run_id, 60)

    def test_same_digest_with_a_changed_definition_restarts(self) -> None:
        self.change_definition("web")
        self.change_definition("jobs")
        outcome = release(
            self.world.context(),
            claims(60, sha=SHA_A),
            {name: image.digest for name, image in self.v1.items()},
        )
        self.assertEqual(outcome.result, "released")
        state = self.state()
        self.assertEqual(state.apps["web"].slot, "green")
        self.assertEqual(state.apps["web"].definition_hash, "def-2")
        self.assertEqual(state.apps["web"].current.digest, self.v1["web"].digest)
        self.assertIsNone(state.apps["web"].previous)
        self.assertEqual(self.world.running["podman-web-green.service"], self.v1["web"].id)
        self.assertEqual(state.apps["jobs"].definition_hash, "def-2")
        self.assertIn(("restart", "podman-jobs.service"), self.world.calls)
        self.assertEqual(len(self.command_calls(PRE_STOP)), 1)
        self.assertEqual(state.apps["worker"].slot, "blue")
        self.assertNotIn(("restart", "podman-worker-green.service"), self.world.calls)

    def test_content_identical_with_a_changed_definition_restarts(self) -> None:
        self.change_definition("web")
        self.release_v2(web="content-web-1")
        state = self.state()
        self.assertEqual(state.apps["web"].slot, "green")
        self.assertEqual(state.apps["web"].current.digest, self.v2["web"].digest)
        self.assertIsNone(state.apps["web"].previous)
        self.assertEqual(state.apps["web"].definition_hash, "def-2")

    def test_draining_worker_fails_before_migrations(self) -> None:
        self.world.states["podman-worker-green.service"] = "deactivating"
        v2 = self.publish(2, SHA_B)
        before = self.state()
        with self.assertRaises(FailedError) as raised:
            release(
                self.world.context(),
                claims(100),
                {name: image.digest for name, image in v2.items()},
            )
        self.assertEqual(raised.exception.message, DRAINING)
        self.assertNotIn(("start", MIGRATION), self.world.calls)
        self.assertEqual(self.world.restarts(), [])
        self.assertEqual(self.state(), before)

    def test_release_returns_while_the_old_worker_drains(self) -> None:
        self.world.slow_stop.add("podman-worker-blue.service")
        self.release_v2()
        self.assertEqual(self.world.states["podman-worker-blue.service"], "deactivating")
        self.assertEqual(self.state().apps["worker"].slot, "green")
        v3 = self.publish(3, SHA_C)
        self.world.calls.clear()
        with self.assertRaises(FailedError) as raised:
            release(
                self.world.context(),
                claims(101, sha=SHA_C),
                {name: image.digest for name, image in v3.items()},
            )
        self.assertEqual(
            raised.exception.message,
            DRAINING.replace("slot green", "slot blue"),
        )
        self.assertEqual(self.world.restarts(), [])

    def test_pull_retries_with_backoff(self) -> None:
        v2 = self.publish(2, SHA_B)
        reference = f"ghcr.io/owner/web@{v2['web'].digest}"
        self.world.pull_failures[reference] = 2
        release(
            self.world.context(), claims(100), {name: image.digest for name, image in v2.items()}
        )
        self.assertEqual(self.world.clock.sleeps[:2], [2, 4])
        self.assertEqual(self.world.calls.count(("pull", reference)), 3)

    def test_pull_gives_up_after_four_attempts(self) -> None:
        v2 = self.publish(2, SHA_B)
        reference = f"ghcr.io/owner/web@{v2['web'].digest}"
        self.world.pull_failures[reference] = 4
        with self.assertRaises(FailedError) as raised:
            release(
                self.world.context(),
                claims(100),
                {name: image.digest for name, image in v2.items()},
            )
        self.assertIn("after 4 attempts", raised.exception.message)
        self.assertEqual(self.world.restarts(), [])

    def test_garbage_collection_keeps_current_and_previous(self) -> None:
        self.release_v2()
        v3 = self.publish(3, SHA_C)
        release(
            self.world.context(),
            claims(101, sha=SHA_C),
            {name: image.digest for name, image in v3.items()},
        )
        for name in ("web", "jobs", "worker"):
            self.assertNotIn(self.v1[name].id, self.world.local, name)
            self.assertIn(self.v2[name].id, self.world.local, name)
            self.assertIn(v3[name].id, self.world.local, name)

    def test_garbage_collection_removes_an_image_that_several_apps_share(self) -> None:
        # Podman refuses to delete an image by ID while it has several names.
        shared = make_image("shared", SHA_A)
        for name in ("web", "jobs"):
            self.world.store_locally(self.repository(name), shared)
        self.release_v2()
        self.assertNotIn(shared.id, self.world.local)
        self.assertIn(("rmi", f"ghcr.io/owner/web@{shared.digest}"), self.world.calls)
        self.assertIn(("rmi", f"ghcr.io/owner/jobs@{shared.digest}"), self.world.calls)
        self.assertNotIn(("rmi", shared.id), self.world.calls)

    def test_garbage_collection_leaves_names_of_other_repositories(self) -> None:
        shared = make_image("shared", SHA_A)
        self.world.store_locally(self.repository("web"), shared)
        self.world.names["docker.io/library/other:latest"] = shared.id
        self.release_v2()
        self.assertIn(shared.id, self.world.local)
        names = [name for name, target in self.world.names.items() if target == shared.id]
        self.assertEqual(names, ["docker.io/library/other:latest"])

    def test_garbage_collection_keeps_images_other_units_need(self) -> None:
        self.world.other_states = [
            State(
                highest_run_id=1,
                apps={
                    "web": AppState(
                        slot="blue",
                        definition_hash=None,
                        current=Release(self.v1["web"].digest, SHA_A, 1, "t"),
                        previous=None,
                    )
                },
            )
        ]
        self.release_v2()
        v3 = self.publish(3, SHA_C)
        release(
            self.world.context(),
            claims(101, sha=SHA_C),
            {name: image.digest for name, image in v3.items()},
        )
        self.assertIn(self.v1["web"].id, self.world.local)
        self.assertNotIn(self.v1["jobs"].id, self.world.local)


class StateCommitTest(unittest.TestCase):
    def test_failed_state_commit_restores_state_and_runtime_before_retry(self) -> None:
        for operation in ("release", "rollback", "refresh"):
            for failure in ("file-fsync", "directory-fsync", "restore"):
                with self.subTest(operation=operation, failure=failure):
                    self.check_failed_commit(operation, failure)

    def check_failed_commit(self, operation: str, failure: str) -> None:
        host = HostTestCase()
        host.setUp()
        self.addCleanup(host.doCleanups)
        world = host.world
        v2 = host.publish(2, SHA_B)
        digests = {name: image.digest for name, image in v2.items()}
        if operation == "rollback":
            release(world.context(), claims(), digests)
        before = host.state()
        previous_upstream = host.upstream.read_text()
        failed = False
        real_fsync = os.fsync
        directory_fsync = failure != "file-fsync"

        def fail_fsync(descriptor: int) -> None:
            nonlocal failed
            info = os.fstat(descriptor)
            if not failed and stat.S_ISDIR(info.st_mode) == directory_fsync:
                failed = True
                message = "simulated state fsync failure"
                raise OSError(message)
            real_fsync(descriptor)

        def write_state(path: Path, text: str) -> None:
            if failed and failure == "restore":
                message = "simulated state restoration failure"
                raise OSError(message)
            with patch("app_release.fsutil.os.fsync", side_effect=fail_fsync):
                atomic_write_text(path, text)

        operations: dict[str, Callable[[], object]] = {
            "release": partial(release, world.context(), claims(), digests),
            "rollback": partial(rollback, world.context(), claims(event_name="workflow_dispatch")),
            "refresh": partial(refresh, world.context()),
        }
        invoke = operations[operation]

        with (
            patch("app_release.state.atomic_write_text", side_effect=write_state),
            self.assertRaises(CriticalError if failure == "restore" else FailedError) as raised,
        ):
            invoke()
        self.assertTrue(failed)
        if failure == "restore":
            self.assertEqual(raised.exception.exit_code, ExitCode.CRITICAL)
            self.assertIn("cannot restore the previous state", raised.exception.message)
            return
        self.assertEqual(raised.exception.exit_code, ExitCode.FAILED)
        self.assertEqual(host.state(), before)
        self.assertEqual(host.upstream.read_text(), previous_upstream)
        for name, app_state in before.apps.items():
            image = world.registry[f"{host.repository(name)}@{app_state.current.digest}"]
            unit = world.unit.apps[name].unit(app_state.slot)
            self.assertEqual(world.running[unit], image.id)
        invoke()
        for name, app_state in host.state().apps.items():
            image = world.registry[f"{host.repository(name)}@{app_state.current.digest}"]
            unit = world.unit.apps[name].unit(app_state.slot)
            self.assertEqual(world.running[unit], image.id)


class RollbackTest(HostTestCase):
    def release_v2(self) -> None:
        self.v2 = self.publish(2, SHA_B)
        release(
            self.world.context(),
            claims(100),
            {name: image.digest for name, image in self.v2.items()},
        )

    def test_rollback_toggles_between_two_versions(self) -> None:
        self.release_v2()
        outcome = rollback(self.world.context(), claims(120, event_name="workflow_dispatch"))
        self.assertEqual(outcome.result, "rolled-back")
        state = self.state()
        self.assertEqual(state.highest_run_id, 100)
        for name in ("web", "worker", "jobs"):
            self.assertEqual(state.apps[name].current.digest, self.v1[name].digest)
            previous = state.apps[name].previous
            self.assertEqual(previous.digest if previous else None, self.v2[name].digest)
        self.assertEqual(state.apps["web"].slot, "blue")
        self.assertEqual(self.upstream.read_text(), "to 127.0.0.1:8001\n")
        self.assertEqual(self.world.running["podman-jobs.service"], self.v1["jobs"].id)
        self.assertEqual(len(self.command_calls(PRE_STOP)), 2)
        rollback(self.world.context(), claims(121, event_name="workflow_dispatch"))
        state = self.state()
        for name in ("web", "worker", "jobs"):
            self.assertEqual(state.apps[name].current.digest, self.v2[name].digest)
        self.assertEqual(state.apps["web"].slot, "green")
        self.assertEqual(self.upstream.read_text(), "to 127.0.0.1:8002\n")

    def test_rollback_pulls_a_missing_previous_image(self) -> None:
        self.release_v2()
        del self.world.local[self.v1["jobs"].id]
        for name in [n for n, target in self.world.names.items() if target == self.v1["jobs"].id]:
            del self.world.names[name]
        rollback(self.world.context(), claims(120, event_name="workflow_dispatch"))
        self.assertIn(("pull", f"ghcr.io/owner/jobs@{self.v1['jobs'].digest}"), self.world.calls)
        self.assertEqual(self.world.running["podman-jobs.service"], self.v1["jobs"].id)

    def test_rollback_needs_a_previous_version(self) -> None:
        with self.assertRaises(FailedError) as raised:
            rollback(self.world.context(), claims(120, event_name="workflow_dispatch"))
        self.assertIn("nothing to roll back", raised.exception.message)

    def test_rollback_runs_no_migration(self) -> None:
        self.release_v2()
        self.world.calls.clear()
        rollback(self.world.context(), claims(120, event_name="workflow_dispatch"))
        self.assertNotIn(("start", MIGRATION), self.world.calls)


if __name__ == "__main__":
    unittest.main()
