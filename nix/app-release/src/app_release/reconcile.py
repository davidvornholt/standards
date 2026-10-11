"""The local reconcile, refresh and gc operations."""

from dataclasses import replace

from app_release.config import AppConfig, Slot, other_slot
from app_release.context import Context
from app_release.errors import AppReleaseError, FailedError
from app_release.podman import Image
from app_release.state import AppState, HistoryEntry, Release, State
from app_release.steps import (
    HealthTarget,
    StepError,
    Transaction,
    collect_garbage,
    ensure_image,
    pull,
    retire,
    run_pre_stop,
    start_dependencies,
    stop_slot,
    wait_healthy,
    write_upstream,
)
from app_release.systemd import STOPPED_STATES

PRODUCTION_TAG = "production"


def _bootstrap_app(ctx: Context, app: AppConfig) -> AppState:
    reference = f"{app.image_repository}:{PRODUCTION_TAG}"
    ctx.out.line(f"{app.name}: bootstrapping from {reference}")
    try:
        pull(ctx, reference)
    except FailedError as error:
        message = f"{app.name}: cannot bootstrap from the tag {reference}: {error.message}"
        raise FailedError(message) from None
    image = ctx.images.inspect(reference)
    if image is None:
        message = f"{app.name}: the tag {reference} is missing after the pull"
        raise FailedError(message)
    return AppState(
        slot="blue" if app.blue_green else None,
        definition_hash=None,
        current=Release(image.digest, image.revision, 0, ctx.clock.now()),
        previous=None,
    )


def _load(ctx: Context) -> State:
    """The stored state, bootstrapped and aligned with the configured apps."""
    stored = ctx.store.load()
    state = stored if stored is not None else State(highest_run_id=0, apps={})
    bootstrapped = {}
    for name in sorted(set(ctx.unit.apps) - set(state.apps)):
        bootstrapped[name] = _bootstrap_app(ctx, ctx.unit.apps[name])
    apps: dict[str, AppState] = {}
    for name, app in ctx.unit.apps.items():
        app_state = bootstrapped.get(name) or state.apps[name]
        if app.blue_green and app_state.slot is None:
            app_state = replace(app_state, slot="blue")
        elif not app.blue_green and app_state.slot is not None:
            app_state = replace(app_state, slot=None)
        apps[name] = app_state
    for name in sorted(set(state.apps) - set(ctx.unit.apps)):
        ctx.out.line(f"{name}: no longer configured; dropping it from the state")
    new_state = replace(state, apps=apps)
    if bootstrapped:
        new_state = new_state.with_history(
            HistoryEntry(
                at=ctx.clock.now(),
                operation="bootstrap",
                result="bootstrapped",
                run_id=None,
                actor=None,
                apps={name: app.current.digest for name, app in bootstrapped.items()},
            )
        )
    if new_state != stored:
        ctx.store.save(new_state)
    return new_state


def _enforce(ctx: Context, state: State) -> tuple[set[str], set[str], bool]:
    """DESIGN reconcile step 2.

    Returns the apps that were already running, the running apps whose active tag pointed at
    another image (so they may run something else than the state says), and whether an upstream
    file changed.
    """
    running: set[str] = set()
    stale: set[str] = set()
    upstream_changed = False
    started: list[HealthTarget] = []
    for name in sorted(ctx.unit.apps):
        app = ctx.unit.apps[name]
        app_state = state.apps[name]
        image = ensure_image(ctx, app, app_state.current.digest)
        tag = app.active_tag(app_state.slot)
        tagged = ctx.images.inspect(tag)
        if tagged is None or tagged.id != image.id:
            ctx.images.tag(image.id, tag)
        if app_state.slot is not None:
            upstream_changed |= write_upstream(app, app_state.slot)
        unit = app.unit(app_state.slot)
        if ctx.services.active_state(unit) == "active":
            running.add(name)
            if tagged is not None and tagged.id != image.id:
                ctx.out.warn(f"{name}: {tag} pointed at another image; restarting {name} on it")
                stale.add(name)
            continue
        ctx.out.line(f"{name}: starting {unit}")
        error = ctx.services.restart(unit, timeout=app.health.timeout_seconds)
        if error is not None:
            message = f"{name}: {unit} failed to start: {error}"
            raise FailedError(message)
        started.append(HealthTarget(app, app_state.slot))
    failures = wait_healthy(ctx, started)
    if failures:
        raise FailedError("; ".join(failures.values()))
    return running, stale, upstream_changed


def _refresh_blue_green(
    ctx: Context, state: State, apps: list[AppConfig], images: dict[str, Image]
) -> State:
    """Move each app to its idle slot on the same image, then switch and retire the old slot."""
    targets: list[tuple[AppConfig, Slot, Image]] = []
    for app in apps:
        slot = state.apps[app.name].slot
        if slot is None:
            continue
        idle = other_slot(slot)
        if app.portless and ctx.services.active_state(app.unit(idle)) not in STOPPED_STATES:
            ctx.out.warn(
                f"{app.name}: the previous worker in slot {idle} is still draining; "
                "keeping the running definition. The next release applies it."
            )
            continue
        targets.append((app, idle, images[app.name]))
    if not targets:
        return state
    transaction = Transaction(ctx)
    try:
        transaction.start_idle_slots(targets)
        transaction.switch([(app, slot) for app, slot, _ in targets])
        new_state = state
        for app, slot, _ in targets:
            app_state = replace(
                state.apps[app.name], slot=slot, definition_hash=app.definition_hash
            )
            new_state = new_state.with_app(app.name, app_state)
        ctx.store.save(new_state)
    except StepError as error:
        raise transaction.fail(error.message) from None
    except AppReleaseError as error:
        raise transaction.fail(error.message) from None
    except Exception as error:
        # After something moved, any error must restore the previous version.
        message = f"unexpected error: {error!r}"
        raise transaction.fail(message) from error
    retire(ctx, [(app, other_slot(slot)) for app, slot, _ in targets])
    return new_state


def _refresh_recreate(ctx: Context, state: State, app: AppConfig) -> State:
    """Restart a recreate app on its current image with the configured definition."""
    error = run_pre_stop(ctx, app)
    if error is not None:
        message = f"{error}; {app.name} keeps running on its previous definition"
        raise FailedError(message)
    ctx.out.line(f"{app.name}: restarting with the configured definition")
    unit = app.unit(None)
    error = ctx.services.restart(unit, timeout=app.health.timeout_seconds)
    failures = (
        {app.name: f"{app.name}: {unit} failed to start: {error}"}
        if error is not None
        else wait_healthy(ctx, [HealthTarget(app, None)])
    )
    if failures:
        # The previous definition is gone from the host, so there is nothing to restore.
        # Clearing the hash makes the next reconcile or release restart the app again.
        ctx.store.save(
            state.with_app(app.name, replace(state.apps[app.name], definition_hash=None))
        )
        raise FailedError(failures[app.name])
    new_state = state.with_app(
        app.name, replace(state.apps[app.name], definition_hash=app.definition_hash)
    )
    ctx.store.save(new_state)
    return new_state


def _record_definitions(ctx: Context, state: State, names: set[str]) -> State:
    """Apps that were started now run the configured definition."""
    new_state = state
    for name in sorted(names):
        app = ctx.unit.apps[name]
        if state.apps[name].definition_hash != app.definition_hash:
            new_state = new_state.with_app(
                name, replace(state.apps[name], definition_hash=app.definition_hash)
            )
    if new_state != state:
        ctx.store.save(new_state)
    return new_state


def _refresh(
    ctx: Context, state: State, running: set[str], stale: set[str], *, force: bool
) -> State:
    """DESIGN reconcile step 3: restart running apps whose definition changed."""
    state = _record_definitions(ctx, state, set(ctx.unit.apps) - running)
    due = [
        ctx.unit.apps[name]
        for name in sorted(running)
        if force
        or name in stale
        or state.apps[name].definition_hash != ctx.unit.apps[name].definition_hash
    ]
    if not due:
        return state
    images = {app.name: ensure_image(ctx, app, state.apps[app.name].current.digest) for app in due}
    before = state
    state = _refresh_blue_green(ctx, state, [app for app in due if app.blue_green], images)
    for app in sorted(
        (app for app in due if not app.blue_green), key=lambda a: (a.priority, a.name)
    ):
        state = _refresh_recreate(ctx, state, app)
    if state != before:
        state = state.with_history(
            HistoryEntry(
                at=ctx.clock.now(),
                operation="refresh",
                result="refreshed",
                run_id=None,
                actor=None,
                apps={app.name: state.apps[app.name].current.digest for app in due},
            )
        )
        ctx.store.save(state)
    return state


def _clean_up(ctx: Context, state: State, *, upstream_changed: bool) -> None:
    """DESIGN reconcile step 4, reloading Caddy first so no request reaches a stopped slot."""
    if upstream_changed:
        caddy = ctx.unit.caddy_reload_unit
        if ctx.services.active_state(caddy) == "active":
            error = ctx.services.reload(caddy)
            if error is not None:
                message = f"reload of {caddy} failed: {error}"
                raise FailedError(message)
    for name in sorted(ctx.unit.apps):
        app = ctx.unit.apps[name]
        slot = state.apps[name].slot
        if slot is None:
            continue
        inactive = other_slot(slot)
        if ctx.services.active_state(app.unit(inactive)) in STOPPED_STATES:
            continue
        ctx.out.line(f"{name}: stopping the inactive slot {inactive}")
        error = stop_slot(ctx, app, inactive)
        if error is not None:
            ctx.out.warn(f"{name}: cannot stop slot {inactive}: {error}")


def reconcile(ctx: Context, *, force: bool = False) -> State:
    """Make the host run what the state says, bootstrapping it first if needed."""
    start_dependencies(ctx)
    state = _load(ctx)
    running, stale, upstream_changed = _enforce(ctx, state)
    state = _refresh(ctx, state, running, stale, force=force)
    _clean_up(ctx, state, upstream_changed=upstream_changed)
    collect_garbage(ctx)
    return state


def refresh(ctx: Context) -> State:
    """Restart every running app at its current digest, even when the definition is unchanged."""
    return reconcile(ctx, force=True)


def gc(ctx: Context) -> None:
    collect_garbage(ctx)
