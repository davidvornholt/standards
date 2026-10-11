"""Runs an authorized SSH request inside its transient systemd unit."""

import json
import signal
import sys
from pathlib import Path
from types import FrameType
from typing import TextIO, cast

from app_release.command import parse_request
from app_release.config import ConfigError
from app_release.context import Claims, Context
from app_release.environment import LOCK_TIMEOUT_SECONDS, Environment
from app_release.errors import AppReleaseError, ExitCode
from app_release.fsutil import atomic_write_text, exclusive_lock
from app_release.output import Output
from app_release.release import release, rollback
from app_release.report import payload, status
from app_release.state import State

REQUEST_FILE = "request.json"
OUTPUT_FILE = "output.log"
EXIT_FILE = "exit"


class TerminatedError(Exception):
    """systemd stopped the operation's unit."""


def _terminate(signum: int, frame: FrameType | None) -> None:
    del frame
    message = f"stopped by signal {signum}"
    raise TerminatedError(message)


def _claims(value: object) -> Claims:
    if not isinstance(value, dict):
        message = "the request has no claims"
        raise ConfigError(message)
    data = cast("dict[str, object]", value)
    run_id = data.get("runId")
    run_attempt = data.get("runAttempt")
    if not isinstance(run_id, int) or not isinstance(run_attempt, int):
        message = "the request's claims are malformed"
        raise ConfigError(message)
    return Claims(
        sha=str(data.get("sha")),
        run_id=run_id,
        run_attempt=run_attempt,
        workflow_ref=str(data.get("workflowRef")),
        actor=str(data.get("actor")),
        event_name=str(data.get("eventName")),
    )


def _safe_state(ctx: Context) -> State | None:
    try:
        return ctx.store.load()
    except AppReleaseError:
        return None


def _run(ctx: Context, operation: str, claims: Claims, digests: dict[str, str]) -> int:
    out = ctx.out
    try:
        if operation == "release":
            outcome = release(ctx, claims, digests)
        elif operation == "rollback":
            outcome = rollback(ctx, claims)
        else:
            state = status(ctx)
            out.result(payload(ctx.unit, "status", state, ""))
            return ExitCode.OK
    except AppReleaseError as error:
        out.line(f"error: {error.message}")
        out.result(payload(ctx.unit, "failed", _safe_state(ctx), error.message))
        return error.exit_code
    except Exception as error:  # noqa: BLE001 - every failure must end with a result line
        # Steps that move traffic restore the previous version themselves, so an error that
        # reaches this point happened before anything moved.
        message = f"unexpected error: {error!r}"
        out.line(f"error: {message}")
        out.result(payload(ctx.unit, "failed", _safe_state(ctx), message))
        return ExitCode.FAILED
    out.line(outcome.message)
    out.result(payload(ctx.unit, outcome.result, outcome.state, outcome.message))
    return ExitCode.OK


def execute_request(environment: Environment, directory: Path, stdout: TextIO) -> int:
    """Run the request in `directory`, writing output and exit code back for the SSH session."""
    with (directory / OUTPUT_FILE).open("a", encoding="utf-8") as log:
        out = Output(stdout, log)
        code = _execute(environment, directory, out)
        atomic_write_text(directory / EXIT_FILE, f"{code}\n", mode=0o600)
        return code


def _execute(environment: Environment, directory: Path, out: Output) -> int:
    try:
        raw: object = json.loads((directory / REQUEST_FILE).read_text())
        if not isinstance(raw, dict):
            message = "the request is not an object"
            raise ConfigError(message)
        data = cast("dict[str, object]", raw)
        unit = environment.load_unit(str(data.get("unit")))
        request = parse_request(data.get("request"))
        claims = _claims(data.get("claims"))
    except (AppReleaseError, OSError, ValueError) as error:
        out.line(f"error: cannot read the request: {error}")
        return ExitCode.FAILED
    ctx = environment.context(unit, out)
    out.line(
        f"{request.operation} on unit {unit.name} for run {claims.run_id} "
        f"attempt {claims.run_attempt} by {claims.actor} ({claims.sha[:12]})"
    )
    try:
        with exclusive_lock(
            environment.lock_path(unit.name),
            LOCK_TIMEOUT_SECONDS,
            lambda: out.line(f"waiting for another operation on unit {unit.name} to finish"),
        ):
            return _run(ctx, request.operation, claims, request.digests)
    except AppReleaseError as error:
        out.line(f"error: {error.message}")
        out.result(payload(unit, "failed", _safe_state(ctx), error.message))
        return error.exit_code


def main(environment: Environment, directory: str) -> int:
    # Stopping the unit raises inside the operation, so a release restores the previous version.
    signal.signal(signal.SIGTERM, _terminate)
    return execute_request(environment, Path(directory), sys.stdout)
