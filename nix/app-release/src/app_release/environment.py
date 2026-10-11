"""Paths and tools from the package wrapper, and the real context built from them."""

import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

from app_release.clock import SystemClock
from app_release.config import ConfigError, UnitConfig, configured_units, load_unit
from app_release.context import Context
from app_release.output import Output
from app_release.podman import Podman
from app_release.probes import SystemProber
from app_release.runner import Runner, run
from app_release.state import State, StateStore
from app_release.systemd import Systemctl

LOCK_TIMEOUT_SECONDS = 30 * 60


@dataclass(frozen=True)
class Environment:
    podman: str
    systemctl: str
    systemd_run: str
    bash: str
    executable: str
    ca_file: str | None
    config_dir: Path
    state_dir: Path
    run_dir: Path
    cache_dir: Path
    runner: Runner = field(default=run, compare=False)

    @classmethod
    def from_environ(cls, environ: Mapping[str, str]) -> "Environment":
        def tool(name: str) -> str:
            value = environ.get(f"APP_RELEASE_{name}")
            if not value:
                message = f"APP_RELEASE_{name} is not set; run app-release through its package"
                raise ConfigError(message)
            return value

        return cls(
            podman=tool("PODMAN"),
            systemctl=tool("SYSTEMCTL"),
            systemd_run=tool("SYSTEMD_RUN"),
            bash=tool("BASH"),
            executable=tool("EXECUTABLE"),
            ca_file=environ.get("APP_RELEASE_CA_FILE") or None,
            config_dir=Path(environ.get("APP_RELEASE_CONFIG_DIR", "/etc/app-release")),
            state_dir=Path(environ.get("APP_RELEASE_STATE_DIR", "/var/lib/app-release")),
            run_dir=Path(environ.get("APP_RELEASE_RUN_DIR", "/run/app-release")),
            cache_dir=Path(environ.get("APP_RELEASE_CACHE_DIR", "/var/cache/app-release")),
        )

    def state_store(self, unit: str) -> StateStore:
        return StateStore(self.state_dir / unit / "state.json")

    def lock_path(self, unit: str) -> Path:
        return self.run_dir / f"{unit}.lock"

    def seen_jti_dir(self, unit: str) -> Path:
        return self.state_dir / unit / "seen-jti"

    def requests_dir(self) -> Path:
        return self.run_dir / "requests"

    def jwks_cache(self) -> Path:
        return self.cache_dir / "jwks.json"

    def all_states(self) -> list[State]:
        """Every unit's state; raises when one is unreadable so GC keeps everything."""
        states = []
        for unit in configured_units(self.config_dir):
            state = self.state_store(unit).load()
            if state is not None:
                states.append(state)
        return states

    def load_unit(self, unit: str) -> UnitConfig:
        return load_unit(self.config_dir, unit)

    def context(self, unit: UnitConfig, out: Output) -> Context:
        return Context(
            unit=unit,
            images=Podman(self.podman, self.runner, unit.registry_auth_file),
            services=Systemctl(self.systemctl, self.runner),
            prober=SystemProber(self.bash, self.runner),
            clock=SystemClock(),
            out=out,
            store=self.state_store(unit.name),
            all_states=self.all_states,
        )


def current_environment() -> Environment:
    return Environment.from_environ(os.environ)
