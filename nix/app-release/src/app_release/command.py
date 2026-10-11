"""The SSH command grammar."""

import re
from dataclasses import dataclass

from app_release.config import UnitConfig
from app_release.errors import RejectedError

RELEASE_ITEM = re.compile(r"([a-z0-9][a-z0-9-]*)@(sha256:[0-9a-f]{64})")
MAX_COMMAND_LENGTH = 8192


@dataclass(frozen=True)
class Request:
    operation: str
    digests: dict[str, str]

    def to_json(self) -> dict[str, object]:
        return {"operation": self.operation, "digests": dict(self.digests)}


def parse_command(command: str | None, unit: UnitConfig) -> Request:
    """Parse SSH_ORIGINAL_COMMAND; anything outside the grammar is rejected."""
    if command is None or command == "":
        message = "no command given; expected release, rollback or status"
        raise RejectedError(message)
    if len(command) > MAX_COMMAND_LENGTH:
        message = "the command is too long"
        raise RejectedError(message)
    words = command.split(" ")
    operation = words[0]
    if operation in ("rollback", "status"):
        if len(words) != 1:
            message = f"{operation} takes no arguments"
            raise RejectedError(message)
        return Request(operation, {})
    if operation != "release":
        message = f"unknown command {operation[:40]!r}; expected release, rollback or status"
        raise RejectedError(message)
    return Request("release", _release_digests(words[1:], unit))


def _release_digests(items: list[str], unit: UnitConfig) -> dict[str, str]:
    digests: dict[str, str] = {}
    for item in items:
        match = RELEASE_ITEM.fullmatch(item)
        if match is None:
            message = f"invalid release item {item[:120]!r}; expected <app>@sha256:<64 hex>"
            raise RejectedError(message)
        app, digest = match.groups()
        if app not in unit.apps:
            message = f"{app} is not an app of unit {unit.name}"
            raise RejectedError(message)
        if app in digests:
            message = f"{app} appears more than once"
            raise RejectedError(message)
        digests[app] = digest
    missing = sorted(set(unit.apps) - set(digests))
    if missing:
        message = f"release must name every app of unit {unit.name}; missing {', '.join(missing)}"
        raise RejectedError(message)
    return digests


def parse_request(value: object) -> Request:
    """Read back a request that `Request.to_json` wrote."""
    if not isinstance(value, dict):
        message = "the request is not an object"
        raise RejectedError(message)
    operation = value.get("operation")
    digests = value.get("digests")
    if operation not in ("release", "rollback", "status") or not isinstance(digests, dict):
        message = "the request is malformed"
        raise RejectedError(message)
    return Request(str(operation), {str(app): str(digest) for app, digest in digests.items()})
