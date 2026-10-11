"""The resolved unit configuration the NixOS module writes to /etc/app-release/<unit>.json."""

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, cast

from app_release.errors import FailedError

Slot = Literal["blue", "green"]
SLOTS: tuple[Slot, Slot] = ("blue", "green")
NAME_PATTERN = re.compile(r"[a-z0-9][a-z0-9-]*")
LOCAL_IMAGE_PREFIX = "localhost/app-release"


def other_slot(slot: Slot) -> Slot:
    return "green" if slot == "blue" else "blue"


class ConfigError(FailedError):
    """The unit configuration is missing or malformed."""


@dataclass(frozen=True)
class SlotPorts:
    blue: int
    green: int

    def port(self, slot: Slot) -> int:
        return self.blue if slot == "blue" else self.green


@dataclass(frozen=True)
class Health:
    path: str | None
    port: int | None
    command: str | None
    timeout_seconds: int


@dataclass(frozen=True)
class AppConfig:
    name: str
    image_repository: str
    strategy: Literal["blue-green", "recreate"]
    container_port: int | None
    slot_ports: SlotPorts | None
    health: Health
    pre_stop_command: str | None
    retire_without_waiting: bool
    priority: int
    upstream_file: Path | None
    containers: dict[str, str]
    units: dict[str, str]
    definition_hash: str

    @property
    def blue_green(self) -> bool:
        return self.strategy == "blue-green"

    @property
    def portless(self) -> bool:
        return self.blue_green and self.slot_ports is None

    def local_tag(self, tag: str) -> str:
        return f"{LOCAL_IMAGE_PREFIX}/{self.name}:{tag}"

    def active_tag(self, slot: Slot | None) -> str:
        return self.local_tag(slot if slot is not None else "current")

    def unit(self, slot: Slot | None) -> str:
        return self.units[slot if slot is not None else "current"]

    def container(self, slot: Slot | None) -> str:
        return self.containers[slot if slot is not None else "current"]

    def health_port(self, slot: Slot | None) -> int | None:
        if self.slot_ports is not None and slot is not None:
            return self.slot_ports.port(slot)
        return self.health.port


@dataclass(frozen=True)
class Migration:
    service: str
    app: str


@dataclass(frozen=True)
class Oidc:
    issuer: str
    jwks_url: str
    audience: str


@dataclass(frozen=True)
class UnitConfig:
    name: str
    repository: str
    ref: str
    registry_auth_file: str | None
    service_dependencies: tuple[str, ...]
    migration: Migration | None
    drain_seconds: int
    refresh_unit: str
    oidc: Oidc
    caddy_reload_unit: str
    apps: dict[str, AppConfig]

    @property
    def recreate_order(self) -> list[AppConfig]:
        recreate = [app for app in self.apps.values() if not app.blue_green]
        return sorted(recreate, key=lambda app: (app.priority, app.name))


def _object(value: object, where: str) -> dict[str, object]:
    if not isinstance(value, dict):
        message = f"{where} must be an object"
        raise ConfigError(message)
    return cast("dict[str, object]", value)


def _string(data: dict[str, object], key: str, where: str) -> str:
    value = data.get(key)
    if not isinstance(value, str) or value == "":
        message = f"{where}.{key} must be a non-empty string"
        raise ConfigError(message)
    return value


def _optional_string(data: dict[str, object], key: str, where: str) -> str | None:
    value = data.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        message = f"{where}.{key} must be a string or null"
        raise ConfigError(message)
    return value


def _integer(data: dict[str, object], key: str, where: str) -> int:
    value = data.get(key)
    if not isinstance(value, int) or isinstance(value, bool):
        message = f"{where}.{key} must be an integer"
        raise ConfigError(message)
    return value


def _optional_integer(data: dict[str, object], key: str, where: str) -> int | None:
    if data.get(key) is None:
        return None
    return _integer(data, key, where)


def _string_map(data: dict[str, object], key: str, where: str) -> dict[str, str]:
    mapping = _object(data.get(key), f"{where}.{key}")
    return {name: _string(mapping, name, f"{where}.{key}") for name in mapping}


def _name(value: str, where: str) -> str:
    if NAME_PATTERN.fullmatch(value) is None:
        message = f"{where}: {value!r} must match ^{NAME_PATTERN.pattern}$"
        raise ConfigError(message)
    return value


def _parse_app(name: str, value: object, unit: str) -> AppConfig:
    where = f"{unit}.apps.{name}"
    data = _object(value, where)
    strategy = _string(data, "strategy", where)
    if strategy not in ("blue-green", "recreate"):
        message = f"{where}.strategy must be blue-green or recreate"
        raise ConfigError(message)
    slot_ports_data = data.get("slotPorts")
    slot_ports = None
    if slot_ports_data is not None:
        ports = _object(slot_ports_data, f"{where}.slotPorts")
        slot_ports = SlotPorts(
            blue=_integer(ports, "blue", f"{where}.slotPorts"),
            green=_integer(ports, "green", f"{where}.slotPorts"),
        )
    health_data = _object(data.get("health"), f"{where}.health")
    health = Health(
        path=_optional_string(health_data, "path", f"{where}.health"),
        port=_optional_integer(health_data, "port", f"{where}.health"),
        command=_optional_string(health_data, "command", f"{where}.health"),
        timeout_seconds=_integer(health_data, "timeoutSeconds", f"{where}.health"),
    )
    upstream = _optional_string(data, "upstreamFile", where)
    retire_without_waiting = data.get("retireWithoutWaiting", False)
    if not isinstance(retire_without_waiting, bool):
        message = f"{where}.retireWithoutWaiting must be a boolean"
        raise ConfigError(message)
    containers = _string_map(data, "containers", where)
    units = _string_map(data, "units", where)
    expected_keys = {"blue", "green"} if strategy == "blue-green" else {"current"}
    if set(containers) != expected_keys or set(units) != expected_keys:
        message = f"{where}: containers and units must have the keys {sorted(expected_keys)}"
        raise ConfigError(message)
    return AppConfig(
        name=_name(name, where),
        image_repository=_string(data, "imageRepository", where),
        strategy=cast("Literal['blue-green', 'recreate']", strategy),
        container_port=_optional_integer(data, "containerPort", where),
        slot_ports=slot_ports,
        health=health,
        pre_stop_command=_optional_string(data, "preStopCommand", where),
        retire_without_waiting=retire_without_waiting,
        priority=_integer(data, "priority", where),
        upstream_file=Path(upstream) if upstream is not None else None,
        containers=containers,
        units=units,
        definition_hash=_string(data, "definitionHash", where),
    )


def parse_unit(value: object) -> UnitConfig:
    data = _object(value, "unit config")
    name = _name(_string(data, "unit", "unit config"), "unit config")
    oidc = _object(data.get("oidc"), f"{name}.oidc")
    migration_data = data.get("migration")
    migration = None
    if migration_data is not None:
        migration_object = _object(migration_data, f"{name}.migration")
        migration = Migration(
            service=_string(migration_object, "service", f"{name}.migration"),
            app=_string(migration_object, "app", f"{name}.migration"),
        )
    dependencies = data.get("serviceDependencies", [])
    if not isinstance(dependencies, list) or not all(isinstance(d, str) for d in dependencies):
        message = f"{name}.serviceDependencies must be a list of strings"
        raise ConfigError(message)
    apps_data = _object(data.get("apps"), f"{name}.apps")
    apps = {app: _parse_app(app, apps_data[app], name) for app in sorted(apps_data)}
    if not apps:
        message = f"{name}: the unit has no apps"
        raise ConfigError(message)
    if migration is not None and migration.app not in apps:
        message = f"{name}.migration.app {migration.app!r} is not an app of the unit"
        raise ConfigError(message)
    return UnitConfig(
        name=name,
        repository=_string(data, "repository", name),
        ref=_string(data, "ref", name),
        registry_auth_file=_optional_string(data, "registryAuthFile", name),
        service_dependencies=tuple(cast("list[str]", dependencies)),
        migration=migration,
        drain_seconds=_integer(data, "drainSeconds", name),
        refresh_unit=_string(data, "refreshUnit", name),
        oidc=Oidc(
            issuer=_string(oidc, "issuer", f"{name}.oidc"),
            jwks_url=_string(oidc, "jwksUrl", f"{name}.oidc"),
            audience=_string(oidc, "audience", f"{name}.oidc"),
        ),
        caddy_reload_unit=_string(data, "caddyReloadUnit", name),
        apps=apps,
    )


def load_unit(config_dir: Path, unit: str) -> UnitConfig:
    """Load and validate the configuration of `unit`."""
    if NAME_PATTERN.fullmatch(unit) is None:
        message = f"unknown unit {unit!r}"
        raise ConfigError(message)
    path = config_dir / f"{unit}.json"
    try:
        raw = path.read_text()
    except FileNotFoundError:
        message = f"unknown unit {unit!r}: {path} does not exist"
        raise ConfigError(message) from None
    try:
        parsed: object = json.loads(raw)
    except json.JSONDecodeError as error:
        message = f"{path} is not valid JSON: {error}"
        raise ConfigError(message) from None
    config = parse_unit(parsed)
    if config.name != unit:
        message = f"{path} describes unit {config.name!r}, not {unit!r}"
        raise ConfigError(message)
    return config


def configured_units(config_dir: Path) -> list[str]:
    if not config_dir.is_dir():
        return []
    return sorted(
        path.stem
        for path in config_dir.glob("*.json")
        if NAME_PATTERN.fullmatch(path.stem) is not None
    )
