"""The per-unit release state in /var/lib/app-release/<unit>/state.json."""

import json
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import cast

from app_release.config import SLOTS, Slot
from app_release.errors import FailedError
from app_release.fsutil import atomic_write_text

HISTORY_LIMIT = 50


class StateError(FailedError):
    """The state file is unreadable or malformed."""


@dataclass(frozen=True)
class Release:
    digest: str
    revision: str | None
    run_id: int
    released_at: str

    def to_json(self) -> dict[str, object]:
        return {
            "digest": self.digest,
            "revision": self.revision,
            "runId": self.run_id,
            "releasedAt": self.released_at,
        }


@dataclass(frozen=True)
class AppState:
    slot: Slot | None
    definition_hash: str | None
    current: Release
    previous: Release | None

    def to_json(self) -> dict[str, object]:
        return {
            "slot": self.slot,
            "definitionHash": self.definition_hash,
            "current": self.current.to_json(),
            "previous": self.previous.to_json() if self.previous is not None else None,
        }


@dataclass(frozen=True)
class HistoryEntry:
    at: str
    operation: str
    result: str
    run_id: int | None
    actor: str | None
    apps: dict[str, str]

    def to_json(self) -> dict[str, object]:
        return {
            "at": self.at,
            "operation": self.operation,
            "result": self.result,
            "runId": self.run_id,
            "actor": self.actor,
            "apps": dict(self.apps),
        }


@dataclass(frozen=True)
class State:
    highest_run_id: int
    apps: dict[str, AppState]
    history: tuple[HistoryEntry, ...] = field(default=())

    def with_app(self, name: str, app: AppState) -> "State":
        return replace(self, apps={**self.apps, name: app})

    def with_history(self, entry: HistoryEntry) -> "State":
        return replace(self, history=(*self.history, entry)[-HISTORY_LIMIT:])

    def to_json(self) -> dict[str, object]:
        return {
            "highestRunId": self.highest_run_id,
            "apps": {name: self.apps[name].to_json() for name in sorted(self.apps)},
            "history": [entry.to_json() for entry in self.history],
        }

    def digests(self) -> set[str]:
        """Digests that are current or previous of any app."""
        result = set()
        for app in self.apps.values():
            result.add(app.current.digest)
            if app.previous is not None:
                result.add(app.previous.digest)
        return result


def _object(value: object, where: str) -> dict[str, object]:
    if not isinstance(value, dict):
        message = f"state: {where} must be an object"
        raise StateError(message)
    return cast("dict[str, object]", value)


def _string(data: dict[str, object], key: str, where: str) -> str:
    value = data.get(key)
    if not isinstance(value, str):
        message = f"state: {where}.{key} must be a string"
        raise StateError(message)
    return value


def _optional_string(data: dict[str, object], key: str, where: str) -> str | None:
    value = data.get(key)
    if value is not None and not isinstance(value, str):
        message = f"state: {where}.{key} must be a string or null"
        raise StateError(message)
    return value


def _integer(data: dict[str, object], key: str, where: str) -> int:
    value = data.get(key)
    if not isinstance(value, int) or isinstance(value, bool):
        message = f"state: {where}.{key} must be an integer"
        raise StateError(message)
    return value


def _release(value: object, where: str) -> Release:
    data = _object(value, where)
    return Release(
        digest=_string(data, "digest", where),
        revision=_optional_string(data, "revision", where),
        run_id=_integer(data, "runId", where),
        released_at=_string(data, "releasedAt", where),
    )


def _app(value: object, where: str) -> AppState:
    data = _object(value, where)
    slot = data.get("slot")
    if slot is not None and slot not in SLOTS:
        message = f"state: {where}.slot must be blue, green or null"
        raise StateError(message)
    previous = data.get("previous")
    return AppState(
        slot=slot,
        definition_hash=_optional_string(data, "definitionHash", where),
        current=_release(data.get("current"), f"{where}.current"),
        previous=_release(previous, f"{where}.previous") if previous is not None else None,
    )


def _history(value: object) -> HistoryEntry:
    data = _object(value, "history entry")
    run_id = data.get("runId")
    apps = _object(data.get("apps", {}), "history entry apps")
    return HistoryEntry(
        at=_string(data, "at", "history"),
        operation=_string(data, "operation", "history"),
        result=_string(data, "result", "history"),
        run_id=run_id if isinstance(run_id, int) and not isinstance(run_id, bool) else None,
        actor=_optional_string(data, "actor", "history"),
        apps={name: digest for name, digest in apps.items() if isinstance(digest, str)},
    )


def parse_state(value: object) -> State:
    data = _object(value, "state")
    apps = _object(data.get("apps"), "apps")
    history = data.get("history", [])
    if not isinstance(history, list):
        message = "state: history must be a list"
        raise StateError(message)
    return State(
        highest_run_id=_integer(data, "highestRunId", "state"),
        apps={name: _app(apps[name], f"apps.{name}") for name in apps},
        history=tuple(_history(entry) for entry in history),
    )


class StateStore:
    def __init__(self, path: Path) -> None:
        self.path = path

    def load(self) -> State | None:
        try:
            raw = self.path.read_text()
        except FileNotFoundError:
            return None
        except OSError as error:
            message = f"cannot read {self.path}: {error}"
            raise StateError(message) from None
        try:
            parsed: object = json.loads(raw)
        except json.JSONDecodeError as error:
            message = f"{self.path} is not valid JSON: {error}"
            raise StateError(message) from None
        return parse_state(parsed)

    def save(self, state: State) -> None:
        self.path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
        atomic_write_text(self.path, json.dumps(state.to_json(), indent=2) + "\n")
