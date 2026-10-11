"""The APP_RELEASE_RESULT payload and the status operation."""

from app_release.config import UnitConfig
from app_release.context import Context
from app_release.state import Release, State

STATUS_HISTORY = 10


def payload(unit: UnitConfig, result: str, state: State | None, message: str) -> dict[str, object]:
    """The result line's payload; `apps` describes what is live."""
    apps: dict[str, object] = {}
    for name in sorted(unit.apps):
        app_state = state.apps.get(name) if state is not None else None
        if app_state is None:
            continue
        apps[name] = {
            "repository": unit.apps[name].image_repository,
            "digest": app_state.current.digest,
            "previousDigest": app_state.previous.digest if app_state.previous else None,
            "slot": app_state.slot,
        }
    return {"unit": unit.name, "result": result, "apps": apps, "message": message}


def _describe(release: Release | None) -> str:
    if release is None:
        return "none"
    revision = release.revision[:12] if release.revision else "unknown revision"
    return f"{release.digest} ({revision}, run {release.run_id}, {release.released_at})"


def status(ctx: Context) -> State | None:
    """Print the state with the live state of every unit."""
    state = ctx.store.load()
    if state is None:
        ctx.out.line(f"unit {ctx.unit.name} has no release state yet")
        return None
    ctx.out.line(f"unit {ctx.unit.name}, highest run {state.highest_run_id}")
    for name in sorted(ctx.unit.apps):
        app = ctx.unit.apps[name]
        app_state = state.apps.get(name)
        if app_state is None:
            ctx.out.line(f"{name}: not bootstrapped")
            continue
        units = ", ".join(
            f"{unit} {ctx.services.active_state(unit)}" for unit in app.units.values()
        )
        slot = f"slot {app_state.slot}, " if app_state.slot else ""
        drift = "" if app_state.definition_hash == app.definition_hash else ", definition pending"
        ctx.out.line(f"{name}: {slot}{units}{drift}")
        ctx.out.line(f"{name}: current {_describe(app_state.current)}")
        ctx.out.line(f"{name}: previous {_describe(app_state.previous)}")
    for entry in state.history[-STATUS_HISTORY:]:
        actor = f" by {entry.actor}" if entry.actor else ""
        run = f" run {entry.run_id}" if entry.run_id is not None else ""
        ctx.out.line(f"history: {entry.at} {entry.operation} {entry.result}{run}{actor}")
    return state
