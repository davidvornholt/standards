"""The SSH forced command: authorize the request, then run it in a transient systemd unit."""

import contextlib
import json
import os
import re
import secrets
import select
import shutil
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import TextIO

from app_release.command import Request, parse_command
from app_release.config import UnitConfig
from app_release.context import Claims
from app_release.environment import Environment
from app_release.errors import AppReleaseError, ExitCode, FailedError, RejectedError
from app_release.executor import EXIT_FILE, OUTPUT_FILE, REQUEST_FILE
from app_release.oidc import JwksCache, Verified, fetch_url, verify
from app_release.output import Output
from app_release.replay import remember
from app_release.report import payload
from app_release.systemd import STOPPED_STATES

TOKEN_LIMIT_BYTES = 16 * 1024
TOKEN_TIMEOUT_SECONDS = 30
JWT_PATTERN = re.compile(r"[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+")
POLL_SECONDS = 0.2
UNIT_CHECK_SECONDS = 2.0
REQUEST_MAX_AGE_SECONDS = 24 * 3600


def read_token(fd: int, *, timeout: float = TOKEN_TIMEOUT_SECONDS) -> str:
    """Read the token: one line on stdin, at most 16 KiB."""
    deadline = time.monotonic() + timeout
    data = bytearray()
    while b"\n" not in data:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            message = "timed out waiting for the token on stdin"
            raise RejectedError(message)
        ready, _, _ = select.select([fd], [], [], remaining)
        if not ready:
            continue
        chunk = os.read(fd, 4096)
        if not chunk:
            break
        data += chunk
        if len(data) > TOKEN_LIMIT_BYTES + 2:
            message = "the token on stdin is larger than 16 KiB"
            raise RejectedError(message)
    line = bytes(data).split(b"\n", 1)[0].rstrip(b"\r")
    token = line.decode("ascii", errors="replace")
    if len(line) > TOKEN_LIMIT_BYTES or JWT_PATTERN.fullmatch(token) is None:
        message = "stdin must hold one OIDC token on a single line"
        raise RejectedError(message)
    return token


@dataclass(frozen=True)
class Launcher:
    """Starts the request in a transient unit and reports whether that unit still runs."""

    environment: Environment

    def start(self, name: str, directory: Path) -> str | None:
        result = self.environment.runner(
            [
                self.environment.systemd_run,
                f"--unit={name}",
                "--collect",
                "--service-type=exec",
                "--quiet",
                "--description=app-release request",
                "--property=StandardOutput=journal",
                "--property=StandardError=journal",
                "--",
                self.environment.executable,
                "execute-request",
                str(directory),
            ]
        )
        return None if result.ok else result.summary()

    def running(self, name: str) -> bool:
        result = self.environment.runner(
            [
                self.environment.systemctl,
                "show",
                "--property=ActiveState",
                "--value",
                f"{name}.service",
            ]
        )
        state = result.stdout.strip()
        return result.ok and state not in STOPPED_STATES and state not in ("", "unknown")


def _prune_requests(directory: Path, now: float) -> None:
    if not directory.is_dir():
        return
    for entry in directory.iterdir():
        with contextlib.suppress(OSError):
            if now - entry.stat().st_mtime > REQUEST_MAX_AGE_SECONDS:
                shutil.rmtree(entry, ignore_errors=True)


def _prepare(
    environment: Environment, unit: UnitConfig, request: Request, claims: Claims
) -> tuple[str, Path]:
    requests = environment.requests_dir()
    requests.mkdir(mode=0o700, parents=True, exist_ok=True)
    _prune_requests(requests, time.time())
    name = f"app-release-{unit.name}-{claims.run_id}-{claims.run_attempt}-{secrets.token_hex(4)}"
    directory = requests / name
    directory.mkdir(mode=0o700)
    (directory / OUTPUT_FILE).touch(mode=0o600)
    body = {"unit": unit.name, "request": request.to_json(), "claims": claims.to_json()}
    (directory / REQUEST_FILE).write_text(json.dumps(body) + "\n")
    return name, directory


def stream(
    directory: Path,
    out: TextIO,
    running: Callable[[], bool],
    *,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> int:
    """Copy the request's output to `out` until it wrote its exit code."""
    position = 0
    last_check = clock()
    exit_file = directory / EXIT_FILE
    gone_checks = 0
    while True:
        finished = exit_file.exists()
        with (directory / OUTPUT_FILE).open("rb") as log:
            log.seek(position)
            chunk = log.read()
        if chunk:
            position += len(chunk)
            with contextlib.suppress(OSError, ValueError):
                out.write(chunk.decode("utf-8", errors="replace"))
                out.flush()
        if finished:
            try:
                return int(exit_file.read_text().strip())
            except ValueError:
                return ExitCode.CRITICAL
        if clock() - last_check >= UNIT_CHECK_SECONDS:
            last_check = clock()
            if running():
                gone_checks = 0
            else:
                gone_checks += 1
                # The unit may have just written its exit file; give it one more round.
                if gone_checks > 1 and not exit_file.exists():
                    message = (
                        "error: the operation stopped without a result; "
                        "check its unit in the journal\n"
                    )
                    with contextlib.suppress(OSError, ValueError):
                        out.write(message)
                        out.flush()
                    return ExitCode.CRITICAL
        sleep(POLL_SECONDS)


def _reject(
    out: Output, unit: UnitConfig | None, environment: Environment, error: AppReleaseError
) -> int:
    out.line(f"error: {error.message}")
    if unit is not None:
        try:
            state = environment.state_store(unit.name).load()
        except AppReleaseError:
            state = None
        out.result(payload(unit, "failed", state, error.message))
    else:
        out.result({"unit": None, "result": "failed", "apps": {}, "message": error.message})
    return error.exit_code


def authorize(
    environment: Environment, unit: UnitConfig, command: str | None, token: str, now: float
) -> tuple[Request, Verified]:
    request = parse_command(command, unit)
    jwks = JwksCache(
        path=environment.jwks_cache(),
        url=unit.oidc.jwks_url,
        fetch=fetch_url(environment.ca_file),
        epoch=time.time,
    )
    verified = verify(token, unit, request.operation, jwks)
    remember(environment.seen_jti_dir(unit.name), verified.jti, verified.expires_at, now)
    return request, verified


def ssh_main(
    environment: Environment,
    unit_name: str,
    environ: Mapping[str, str],
    stdin_fd: int,
    stdout: TextIO,
) -> int:
    out = Output(stdout)
    unit: UnitConfig | None = None
    try:
        unit = environment.load_unit(unit_name)
        command = environ.get("SSH_ORIGINAL_COMMAND")
        token = read_token(stdin_fd)
        request, verified = authorize(environment, unit, command, token, time.time())
        del token
    except RejectedError as error:
        return _reject(out, unit, environment, error)
    except AppReleaseError as error:
        if unit is None:
            return _reject(out, unit, environment, RejectedError(error.message))
        return _reject(out, unit, environment, error)
    name, directory = _prepare(environment, unit, request, verified.claims)
    launcher = Launcher(environment)
    error_message = launcher.start(name, directory)
    if error_message is not None:
        shutil.rmtree(directory, ignore_errors=True)
        message = f"cannot start the operation: {error_message}"
        return _reject(out, unit, environment, FailedError(message))
    out.line(f"started {name}")
    code = stream(directory, stdout, lambda: launcher.running(name))
    shutil.rmtree(directory, ignore_errors=True)
    return code
