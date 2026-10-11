import io
import json
import os
import tempfile
import threading
import time
import unittest
from collections.abc import Mapping, Sequence
from pathlib import Path

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa

from app_release.config import parse_unit
from app_release.environment import Environment
from app_release.errors import ExitCode, RejectedError
from app_release.executor import EXIT_FILE, OUTPUT_FILE, execute_request
from app_release.output import RESULT_PREFIX
from app_release.runner import Completed
from app_release.ssh import read_token, ssh_main, stream
from app_release.state import AppState, Release, State
from tests.fakes import SHA_A, SHA_B, app_json, digest, unit_json
from tests.test_oidc import ISSUER, jwk


def pipe_with(data: bytes, *, close: bool = True) -> int:
    read_end, write_end = os.pipe()
    os.write(write_end, data)
    if close:
        os.close(write_end)
    return read_end


class ReadTokenTest(unittest.TestCase):
    def test_reads_one_line(self) -> None:
        fd = pipe_with(b"aaa.bbb.ccc\n")
        self.addCleanup(os.close, fd)
        self.assertEqual(read_token(fd), "aaa.bbb.ccc")

    def test_accepts_a_token_without_newline(self) -> None:
        fd = pipe_with(b"aaa.bbb.ccc")
        self.addCleanup(os.close, fd)
        self.assertEqual(read_token(fd), "aaa.bbb.ccc")

    def test_rejects_garbage(self) -> None:
        fd = pipe_with(b"not a token\n")
        self.addCleanup(os.close, fd)
        with self.assertRaises(RejectedError):
            read_token(fd)

    def test_rejects_oversized_input(self) -> None:
        fd = pipe_with(b"a" * 20000 + b".b.c\n")
        self.addCleanup(os.close, fd)
        with self.assertRaises(RejectedError):
            read_token(fd)

    def test_times_out_without_input(self) -> None:
        read_end, write_end = os.pipe()
        self.addCleanup(os.close, read_end)
        self.addCleanup(os.close, write_end)
        with self.assertRaises(RejectedError):
            read_token(read_end, timeout=0.1)


class StreamTest(unittest.TestCase):
    def test_copies_output_until_the_exit_code(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            (directory / OUTPUT_FILE).write_text("line 1\n")
            out = io.StringIO()
            rounds = 0

            def sleep(_: float) -> None:
                nonlocal rounds
                rounds += 1
                if rounds == 2:
                    with (directory / OUTPUT_FILE).open("a") as log:
                        log.write("line 2\n")
                    (directory / EXIT_FILE).write_text("3\n")

            code = stream(directory, out, lambda: True, sleep=sleep)
            self.assertEqual(code, 3)
            self.assertEqual(out.getvalue(), "line 1\nline 2\n")

    def test_a_unit_that_vanishes_without_a_result_is_critical(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            (directory / OUTPUT_FILE).write_text("")
            now = [0.0]

            def sleep(seconds: float) -> None:
                now[0] += seconds * 20

            out = io.StringIO()
            code = stream(directory, out, lambda: False, sleep=sleep, clock=lambda: now[0])
            self.assertEqual(code, ExitCode.CRITICAL)
            self.assertIn("stopped without a result", out.getvalue())


class FakeSystem:
    """systemd-run starts the executor in a thread; systemctl reports units as active."""

    def __init__(self) -> None:
        self.environment: Environment | None = None
        self.threads: dict[str, threading.Thread] = {}
        self.argv: list[Sequence[str]] = []

    def __call__(
        self,
        argv: Sequence[str],
        *,
        timeout: float | None = None,
        env: Mapping[str, str] | None = None,
    ) -> Completed:
        del timeout, env
        self.argv.append(argv)
        if argv[0] == "systemd-run":
            unit = argv[1].removeprefix("--unit=")
            directory = Path(argv[-1])
            environment = self.environment
            assert environment is not None
            thread = threading.Thread(
                target=execute_request, args=(environment, directory, io.StringIO())
            )
            self.threads[unit] = thread
            thread.start()
            return Completed(0, "", "")
        if argv[0] == "systemctl" and argv[1] == "show":
            unit = argv[-1].removesuffix(".service")
            running = self.threads.get(unit)
            alive = running is None or running.is_alive()
            return Completed(0, "active\n" if alive else "inactive\n", "")
        return Completed(1, "", f"unexpected command {argv[0]}")


class SshTest(unittest.TestCase):
    key: rsa.RSAPrivateKey

    @classmethod
    def setUpClass(cls) -> None:
        cls.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        jwks = root / "jwks.json"
        jwks.write_text(json.dumps({"keys": [jwk(self.key, "k1")]}))
        data = unit_json({"web": app_json("web", ports=(8001, 8002))})
        oidc = data["oidc"]
        assert isinstance(oidc, dict)
        oidc["jwksUrl"] = jwks.as_uri()
        (root / "etc").mkdir()
        (root / "etc" / "shop.json").write_text(json.dumps(data))
        self.unit = parse_unit(data)
        self.system = FakeSystem()
        self.environment = Environment(
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
            runner=self.system,
        )
        self.system.environment = self.environment
        self.environment.state_store("shop").save(
            State(
                highest_run_id=7,
                apps={
                    "web": AppState(
                        slot="blue",
                        definition_hash="def-1",
                        current=Release(digest("web-1"), SHA_A, 7, "t"),
                        previous=None,
                    )
                },
            )
        )

    def token(self, **overrides: object) -> str:
        now = int(time.time())
        claims: dict[str, object] = {
            "iss": ISSUER,
            "aud": "app-release",
            "exp": now + 300,
            "nbf": now,
            "iat": now,
            "jti": "jti-1",
            "repository": "owner/shop",
            "ref": "refs/heads/main",
            "event_name": "push",
            "run_id": "88",
            "run_attempt": "2",
            "sha": SHA_B,
            "workflow_ref": "owner/shop/.github/workflows/publish.yml@refs/heads/main",
            "actor": "octocat",
            **overrides,
        }
        return jwt.encode(claims, self.key, algorithm="RS256", headers={"kid": "k1"})

    def call(self, command: str, token: str) -> tuple[int, str]:
        fd = pipe_with(token.encode() + b"\n")
        self.addCleanup(os.close, fd)
        out = io.StringIO()
        code = ssh_main(self.environment, "shop", {"SSH_ORIGINAL_COMMAND": command}, fd, out)
        for thread in self.system.threads.values():
            thread.join()
        return code, out.getvalue()

    def result(self, output: str) -> dict[str, object]:
        line = output.strip().splitlines()[-1]
        self.assertTrue(line.startswith(RESULT_PREFIX), output)
        parsed: dict[str, object] = json.loads(line.removeprefix(RESULT_PREFIX))
        return parsed

    def test_status_runs_in_a_transient_unit_and_streams_its_output(self) -> None:
        token = self.token()
        code, output = self.call("status", token)
        self.assertEqual(code, ExitCode.OK, output)
        result = self.result(output)
        self.assertEqual(result["result"], "status")
        self.assertEqual(
            result["apps"],
            {
                "web": {
                    "repository": "ghcr.io/owner/web",
                    "digest": digest("web-1"),
                    "previousDigest": None,
                    "slot": "blue",
                }
            },
        )
        systemd_run = next(argv for argv in self.system.argv if argv[0] == "systemd-run")
        self.assertTrue(systemd_run[1].startswith("--unit=app-release-shop-88-2-"))
        self.assertIn("--collect", systemd_run)
        self.assertIn("--service-type=exec", systemd_run)
        for argv in self.system.argv:
            self.assertNotIn(token, " ".join(argv))
        self.assertEqual(list((self.environment.run_dir / "requests").iterdir()), [])

    def test_replayed_token_is_rejected(self) -> None:
        token = self.token()
        self.assertEqual(self.call("status", token)[0], ExitCode.OK)
        code, output = self.call("status", token)
        self.assertEqual(code, ExitCode.REJECTED)
        self.assertIn("already used", output)
        self.assertEqual(self.result(output)["result"], "failed")

    def test_unknown_command_is_rejected(self) -> None:
        code, output = self.call("rm -rf /", self.token())
        self.assertEqual(code, ExitCode.REJECTED)
        self.assertEqual(self.result(output)["result"], "failed")
        self.assertFalse(any(argv[0] == "systemd-run" for argv in self.system.argv))

    def test_wrong_repository_is_rejected(self) -> None:
        code, output = self.call("status", self.token(repository="owner/other"))
        self.assertEqual(code, ExitCode.REJECTED)
        self.assertIn("repository", output)

    def test_unknown_unit_is_rejected(self) -> None:
        fd = pipe_with(self.token().encode() + b"\n")
        self.addCleanup(os.close, fd)
        out = io.StringIO()
        code = ssh_main(self.environment, "other", {"SSH_ORIGINAL_COMMAND": "status"}, fd, out)
        self.assertEqual(code, ExitCode.REJECTED)

    def test_release_must_name_every_app(self) -> None:
        code, output = self.call("release", self.token())
        self.assertEqual(code, ExitCode.REJECTED)
        self.assertIn("missing web", output)


if __name__ == "__main__":
    unittest.main()
