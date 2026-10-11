import contextlib
import http.server
import io
import json
import os
import tempfile
import threading
import unittest
from collections.abc import Iterator, Mapping, Sequence
from pathlib import Path
from unittest import mock

from app_release.cli import run_cli
from app_release.environment import Environment
from app_release.errors import ExitCode, LockTimeoutError
from app_release.fsutil import atomic_write_text, exclusive_lock
from app_release.podman import Podman, content_key, digest_of, repository_of
from app_release.probes import SystemProber
from app_release.runner import Completed, run
from app_release.systemd import Systemctl


class Recorder:
    """A runner that records argv and answers from a table keyed by the first arguments."""

    def __init__(self, answers: Mapping[tuple[str, ...], Completed] | None = None) -> None:
        self.answers = dict(answers or {})
        self.calls: list[tuple[str, ...]] = []

    def __call__(
        self,
        argv: Sequence[str],
        *,
        timeout: float | None = None,
        env: Mapping[str, str] | None = None,
    ) -> Completed:
        del timeout, env
        call = tuple(argv)
        self.calls.append(call)
        for length in range(len(call), 0, -1):
            answer = self.answers.get(call[:length])
            if answer is not None:
                return answer
        return Completed(0, "", "")


class FsutilTest(unittest.TestCase):
    def test_atomic_write_sets_the_mode_and_leaves_no_temporary_files(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            path = Path(name) / "file"
            atomic_write_text(path, "one", mode=0o600)
            atomic_write_text(path, "two", mode=0o600)
            self.assertEqual(path.read_text(), "two")
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual([entry.name for entry in Path(name).iterdir()], ["file"])

    def test_lock_times_out_while_another_holder_has_it(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            path = Path(name) / "run" / "shop.lock"
            waits: list[str] = []
            now = [0.0]

            def sleep(seconds: float) -> None:
                now[0] += seconds

            with exclusive_lock(path, 1800, lambda: None):
                with (
                    self.assertRaises(LockTimeoutError) as raised,
                    exclusive_lock(
                        path,
                        1800,
                        lambda: waits.append("waiting"),
                        clock=lambda: now[0],
                        sleep=sleep,
                    ),
                ):
                    self.fail("the lock must not be granted twice")
                self.assertEqual(raised.exception.exit_code, ExitCode.LOCK_TIMEOUT)
                self.assertEqual(waits, ["waiting"])
                self.assertGreaterEqual(now[0], 1800)
            with exclusive_lock(path, 0, lambda: None):
                pass


class PodmanTest(unittest.TestCase):
    def test_inspect_reads_digest_revision_and_content(self) -> None:
        data: dict[str, object] = {
            "Id": "abc",
            "Digest": "sha256:" + "1" * 64,
            "RootFS": {"Layers": ["sha256:l1"]},
            "Config": {
                "Cmd": ["serve"],
                "Labels": {"org.opencontainers.image.revision": "a" * 40},
            },
        }
        runner = Recorder({("podman", "image", "inspect"): Completed(0, json.dumps([data]), "")})
        image = Podman("podman", runner, None).inspect("ghcr.io/o/web@sha256:" + "1" * 64)
        assert image is not None
        self.assertEqual(image.id, "abc")
        self.assertEqual(image.revision, "a" * 40)
        self.assertEqual(image.content, content_key(data))

    def test_inspect_of_a_missing_image_is_none(self) -> None:
        runner = Recorder({("podman", "image", "exists"): Completed(1, "", "")})
        self.assertIsNone(Podman("podman", runner, None).inspect("x"))

    def test_content_key_ignores_labels_and_history(self) -> None:
        base: dict[str, object] = {
            "RootFS": {"Layers": ["l1"]},
            "Config": {"Cmd": ["serve"], "Labels": {"a": "1"}},
        }
        relabelled: dict[str, object] = {
            "RootFS": {"Layers": ["l1"]},
            "Config": {"Cmd": ["serve"], "Labels": {"a": "2"}},
            "Created": "later",
        }
        changed: dict[str, object] = {"RootFS": {"Layers": ["l2"]}, "Config": {"Cmd": ["serve"]}}
        self.assertEqual(content_key(base), content_key(relabelled))
        self.assertNotEqual(content_key(base), content_key(changed))

    def test_images_are_listed_once_per_id(self) -> None:
        listing = [
            {"Id": "a", "Names": ["ghcr.io/o/web:x"], "RepoDigests": [], "Containers": 1},
            {"Id": "a", "Names": ["ghcr.io/o/web:x"], "RepoDigests": [], "Containers": 1},
            {"Id": "b", "Names": None, "RepoDigests": ["ghcr.io/o/web@sha256:1"]},
        ]
        runner = Recorder({("podman", "images"): Completed(0, json.dumps(listing), "")})
        summaries = Podman("podman", runner, None).images()
        self.assertEqual([summary.id for summary in summaries], ["a", "b"])
        self.assertEqual(summaries[0].containers, 1)
        self.assertEqual(summaries[1].names, ())

    def test_pull_uses_the_auth_file_and_remove_never_forces(self) -> None:
        runner = Recorder()
        podman = Podman("podman", runner, "/run/secrets/auth.json")
        podman.pull("ghcr.io/o/web@sha256:1")
        podman.remove("ghcr.io/o/web:x")
        self.assertEqual(
            runner.calls,
            [
                (
                    "podman",
                    "pull",
                    "--quiet",
                    "--authfile",
                    "/run/secrets/auth.json",
                    "ghcr.io/o/web@sha256:1",
                ),
                ("podman", "rmi", "ghcr.io/o/web:x"),
            ],
        )

    def test_reference_helpers(self) -> None:
        self.assertEqual(repository_of("ghcr.io/o/web:production"), "ghcr.io/o/web")
        self.assertEqual(repository_of("localhost:5000/web@sha256:1"), "localhost:5000/web")
        self.assertEqual(repository_of("localhost:5000/web"), "localhost:5000/web")
        self.assertEqual(digest_of("ghcr.io/o/web@sha256:1"), "sha256:1")
        self.assertIsNone(digest_of("ghcr.io/o/web:x"))


class SystemctlTest(unittest.TestCase):
    def test_commands(self) -> None:
        runner = Recorder(
            {
                ("systemctl", "show"): Completed(0, "deactivating\n", ""),
                ("systemctl", "restart"): Completed(
                    1,
                    "",
                    "Job for a.service failed because the control process exited with error code.\n"
                    'See "systemctl status a.service" for details.\n',
                ),
                ("systemctl", "reload"): Completed(5, "", ""),
            }
        )
        systemctl = Systemctl("systemctl", runner)
        self.assertIsNone(systemctl.stop("a.service", block=False))
        self.assertEqual(
            systemctl.restart("a.service", 10),
            "Job for a.service failed because the control process exited with error code. "
            'See "systemctl status a.service" for details',
        )
        self.assertEqual(systemctl.reload("a.service"), "exit status 5")
        self.assertEqual(systemctl.active_state("a.service"), "deactivating")
        self.assertEqual(runner.calls[0], ("systemctl", "stop", "--no-block", "a.service"))


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        status = {"/ok": 200, "/moved": 302, "/broken": 503}.get(self.path, 404)
        self.send_response(status)
        if status == 302:
            self.send_header("Location", "http://127.0.0.1:1/elsewhere")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002 - overrides the base signature
        del format, args


@contextlib.contextmanager
def http_server() -> Iterator[int]:
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever)
    thread.start()
    try:
        yield server.server_address[1]
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


class ProbeTest(unittest.TestCase):
    def test_http_accepts_2xx_and_3xx_without_following_redirects(self) -> None:
        prober = SystemProber("bash", Recorder())
        with http_server() as port:
            self.assertIsNone(prober.http(port, "/ok"))
            self.assertIsNone(prober.http(port, "/moved"))
            self.assertIn("HTTP 503", prober.http(port, "/broken") or "")

    def test_command_passes_the_hook_environment(self) -> None:
        prober = SystemProber("bash", run)
        result = prober.command('test "$APP_RELEASE_APP" = web', {"APP_RELEASE_APP": "web"}, 10)
        self.assertEqual(result.returncode, 0)
        result = prober.command("echo nope; exit 3", {}, 10)
        self.assertEqual((result.returncode, result.output), (3, "nope"))

    def test_runner_reports_timeouts_and_missing_programs(self) -> None:
        self.assertEqual(run(["sleep", "5"], timeout=0.1).returncode, 124)
        self.assertEqual(run(["/nonexistent/program"]).returncode, 127)


class CliTest(unittest.TestCase):
    def environment(self, root: Path) -> Environment:
        return Environment(
            podman="podman",
            systemctl="systemctl",
            systemd_run="systemd-run",
            bash="bash",
            executable="app-release",
            ca_file=None,
            config_dir=root / "etc",
            state_dir=root / "lib",
            run_dir=root / "run",
            cache_dir=root / "cache",
            runner=Recorder(),
        )

    def run_cli(self, arguments: list[str], root: Path) -> tuple[int, str]:
        out = io.StringIO()
        with mock.patch("sys.stdout", out), mock.patch("sys.stderr", out):
            code = run_cli(arguments, lambda: self.environment(root))
        return code, out.getvalue()

    def test_help_needs_no_environment(self) -> None:
        def unavailable() -> Environment:
            raise AssertionError

        out = io.StringIO()
        with mock.patch("sys.stdout", out):
            self.assertEqual(run_cli(["--help"], unavailable), ExitCode.OK)
        self.assertIn("usage: app-release", out.getvalue())

    def test_unknown_unit_and_usage_errors(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            code, output = self.run_cli(["reconcile", "shop"], root)
            self.assertEqual(code, ExitCode.FAILED)
            self.assertIn("unknown unit 'shop'", output)
            self.assertEqual(self.run_cli(["reconcile"], root)[0], ExitCode.REJECTED)
            self.assertEqual(self.run_cli(["deploy", "shop"], root)[0], ExitCode.REJECTED)
            self.assertEqual(self.run_cli(["status"], root), (ExitCode.OK, ""))

    def test_environment_comes_from_the_wrapper(self) -> None:
        environ = {
            name: f"/bin/{name.lower()}"
            for name in ("PODMAN", "SYSTEMCTL", "SYSTEMD_RUN", "BASH", "EXECUTABLE")
        }
        environment = Environment.from_environ(
            {f"APP_RELEASE_{name}": value for name, value in environ.items()}
        )
        self.assertEqual(environment.podman, "/bin/podman")
        self.assertEqual(environment.state_dir, Path("/var/lib/app-release"))
        self.assertIsNone(environment.ca_file)
        self.assertEqual(os.fspath(environment.lock_path("shop")), "/run/app-release/shop.lock")


if __name__ == "__main__":
    unittest.main()
