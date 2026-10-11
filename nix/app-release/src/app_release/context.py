"""Everything an operation needs, bundled so tests can swap in fakes."""

from collections.abc import Callable
from dataclasses import dataclass

from app_release.clock import Clock
from app_release.config import UnitConfig
from app_release.output import Output
from app_release.podman import ImageStore
from app_release.probes import Prober
from app_release.state import State, StateStore
from app_release.systemd import ServiceManager


@dataclass(frozen=True)
class Claims:
    """Verified OIDC claims of the CI run that requested the operation."""

    sha: str
    run_id: int
    run_attempt: int
    workflow_ref: str
    actor: str
    event_name: str

    def to_json(self) -> dict[str, object]:
        return {
            "sha": self.sha,
            "runId": self.run_id,
            "runAttempt": self.run_attempt,
            "workflowRef": self.workflow_ref,
            "actor": self.actor,
            "eventName": self.event_name,
        }


@dataclass(frozen=True)
class Context:
    unit: UnitConfig
    images: ImageStore
    services: ServiceManager
    prober: Prober
    clock: Clock
    out: Output
    store: StateStore
    all_states: Callable[[], list[State]]
    """Every unit's state on the host, so garbage collection keeps what other units need."""
