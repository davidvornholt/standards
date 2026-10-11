"""Command-line entry points: `app-release` and the SSH forced command `app-release-ssh`."""

import os
import sys
from collections.abc import Callable
from contextlib import ExitStack

from app_release import executor, ssh
from app_release.config import NAME_PATTERN, UnitConfig, configured_units
from app_release.context import Context
from app_release.environment import LOCK_TIMEOUT_SECONDS, Environment, current_environment
from app_release.errors import AppReleaseError, ExitCode, RejectedError
from app_release.fsutil import exclusive_lock
from app_release.output import Output
from app_release.reconcile import gc, reconcile, refresh
from app_release.report import safe_payload, status

USAGE = """usage: app-release <command> [<unit>]

Host commands for zero-downtime app releases (see services.appRelease).

commands:
  reconcile <unit>   bootstrap or restore the unit's apps from the release state and
                     apply changed host definitions
  refresh <unit>     restart every app of the unit at its current digest without downtime
  status [<unit>]    print the release state and the live units (all units by default)
  gc [<unit>]        remove local images no app needs (all units by default)

CI calls the host through the SSH forced command app-release-ssh <unit>.

exit codes: 0 ok, 1 failed (previous version serving), 2 rejected,
3 failed and the previous version could not be restored, 4 lock wait timed out
"""

LOCAL_OPERATIONS: dict[str, Callable[[Context], object]] = {
    "reconcile": reconcile,
    "refresh": refresh,
    "gc": gc,
}


def _units(environment: Environment, arguments: list[str], *, all_by_default: bool) -> list[str]:
    if arguments:
        return arguments
    if all_by_default:
        return configured_units(environment.config_dir)
    message = "a unit name is required"
    raise RejectedError(message)


def _local(environment: Environment, operation: str, unit_name: str, out: Output) -> int:
    unit: UnitConfig | None = None
    # Keep the lock through the final state read and result line, including handled failures.
    with ExitStack() as stack:
        try:
            unit = environment.load_unit(unit_name)
            ctx = environment.context(unit, out)
            stack.enter_context(
                exclusive_lock(
                    environment.lock_path(unit.name),
                    LOCK_TIMEOUT_SECONDS,
                    lambda: out.line(
                        f"waiting for another operation on unit {unit.name} to finish"
                    ),
                )
            )
            if operation == "status":
                status(ctx)
            else:
                LOCAL_OPERATIONS[operation](ctx)
        except AppReleaseError as error:
            out.line(f"error: {error.message}")
            store = environment.state_store(unit.name) if unit is not None else None
            out.result(safe_payload(unit, store, "failed", error.message))
            return error.exit_code
        else:
            message = f"{operation} of unit {unit.name} finished"
            out.line(message)
            out.result(safe_payload(unit, ctx.store, "status", message))
            return ExitCode.OK


def run_cli(arguments: list[str], environment_factory: Callable[[], Environment]) -> int:
    out = Output(sys.stdout)
    if not arguments or arguments[0] in ("-h", "--help", "help"):
        sys.stdout.write(USAGE)
        return ExitCode.OK if arguments else ExitCode.REJECTED
    command, rest = arguments[0], arguments[1:]
    try:
        environment = environment_factory()
        if command == "execute-request" and len(rest) == 1:
            return executor.main(environment, rest[0])
        if command not in ("reconcile", "refresh", "status", "gc") or len(rest) > 1:
            sys.stderr.write(USAGE)
            return ExitCode.REJECTED
        units = _units(environment, rest, all_by_default=command in ("status", "gc"))
        code: int = ExitCode.OK
        for unit in units:
            code = _local(environment, command, unit, out)
            if code != ExitCode.OK:
                return code
    except AppReleaseError as error:
        out.line(f"error: {error.message}")
        out.result(safe_payload(None, None, "failed", error.message))
        return error.exit_code
    return code


def main() -> int:
    return run_cli(sys.argv[1:], current_environment)


def ssh_main() -> int:
    arguments = sys.argv[1:]
    out = Output(sys.stdout)
    if len(arguments) != 1 or NAME_PATTERN.fullmatch(arguments[0]) is None:
        out.line("error: usage: app-release-ssh <unit>")
        return ExitCode.REJECTED
    try:
        environment = current_environment()
    except AppReleaseError as error:
        out.line(f"error: {error.message}")
        return ExitCode.FAILED
    return ssh.ssh_main(environment, arguments[0], os.environ, sys.stdin.fileno(), sys.stdout)
