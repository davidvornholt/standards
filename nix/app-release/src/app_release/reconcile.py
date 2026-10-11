"""The local reconcile, refresh, check and gc operations."""

from dataclasses import replace

from app_release.config import AppConfig, Slot, other_slot
from app_release.context import Context
from app_release.errors import AppReleaseError, CriticalError, FailedError, RejectedError
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
    wait_healthy,
    write_upstream,
)
from app_release.systemd import STOPPED_STATES

PRODUCTION_TAG = "production"


def _production_image(ctx: Context, app: AppConfig) -> Image:
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
    return image


def _bootstrap_app(ctx: Context, app: AppConfig) -> AppState:
    image = _production_image(ctx, app)
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


def _enforce(ctx: Context, state: State, *, force: bool) -> tuple[State, set[str], set[str]]:
    """DESIGN reconcile step 2.

    Returns the updated state, apps already running, and running apps whose active tag
    pointed at another image (so they may run something else than the state says). Fails
    only for a forced refresh or apps whose definition changed; see `_give_up` for the others.
    """
    running: set[str] = set()
    stale: set[str] = set()
    started: list[HealthTarget] = []
    failures: dict[str, str] = {}
    changed = {
        name
        for name, app in ctx.unit.apps.items()
        if state.apps[name].definition_hash != app.definition_hash
    }
    for name in sorted(ctx.unit.apps):
        app = ctx.unit.apps[name]
        app_state = state.apps[name]
        image = ensure_image(ctx, app, app_state.current.digest)
        tag = app.active_tag(app_state.slot)
        tagged = ctx.images.inspect(tag)
        unit = app.unit(app_state.slot)
        active = ctx.services.active_state(unit) == "active"
        if active and tagged is not None and tagged.id != image.id and not app.blue_green:
            # Persist restart intent before retagging erases the mismatch, including when
            # preStopCommand fails or the process dies before the recreate restart.
            state = state.with_app(name, replace(app_state, definition_hash=None))
            ctx.store.save(state)
        if tagged is None or tagged.id != image.id:
            ctx.images.tag(image.id, tag)
        if (
            active
            and app_state.slot is not None
            and app_state.definition_hash == app.definition_hash
        ):
            # A running old definition may still bind the previous slot ports. Keep its
            # live upstream until the replacement is healthy and the transaction switches.
            write_upstream(app, app_state.slot)
        if active:
            running.add(name)
            if tagged is not None and tagged.id != image.id:
                ctx.out.warn(f"{name}: {tag} pointed at another image; restarting {name} on it")
                stale.add(name)
            continue
        ctx.out.line(f"{name}: starting {unit}")
        error = ctx.services.restart(unit, timeout=app.health.timeout_seconds)
        # A later activation retries this definition even if its first start failed.
        state = _record_definitions(ctx, state, {name})
        if error is not None:
            failures[name] = f"{name}: {unit} failed to start: {error}"
            continue
        started.append(HealthTarget(app, app_state.slot))
    failures |= wait_healthy(ctx, started)
    fatal = [failures[name] for name in sorted(failures) if force or name in changed]
    if fatal:
        raise FailedError("; ".join(fatal))
    for name in failures:
        _settle(ctx, ctx.unit.apps[name], ctx.unit.apps[name].unit(state.apps[name].slot))
    _give_up(ctx, failures)
    _route_to([target for target in started if target.app.name not in failures])
    return state, running, stale


def _repair_hint(ctx: Context) -> str:
    return (
        "Check the container logs with journalctl, fix the cause, then run "
        f"app-release refresh {ctx.unit.name}, release a fixed version, or roll back."
    )


def _settle(ctx: Context, app: AppConfig, unit: str) -> None:
    """Leave a unit this run failed to start inactive, unless it runs or drains.

    A host switch fails while any unit is failed or restarting after a failure. The unit
    may still restart after its failure, or still stop after this run told it to without
    waiting, and either can fail it again; a blocking stop waits for both. Other units of
    the app stay untouched: an old worker slot may still drain.

    A worker that retires without waiting is not waited for while its container drains,
    because the drain may outlast the host activation. systemd drains a container in the
    `stop` sub-state, where ExecStop runs `podman stop`, and enters it only from a running
    unit. Stopping a unit that is still starting or waiting to restart skips ExecStop, so
    that stop stays blocking. The module keeps these workers on `--sdnotify=conmon`, so a
    unit counts as started as soon as its container runs; no container drains, and the stop
    ends within seconds.

    The drain can end failed before the host switch checks its units, which fails that
    switch. That needs the worker to finish draining within the rest of the switch and to
    exit with a status other than 0 or 143; these workers retire without waiting because
    their drains are long. `retire` leaves every replaced worker in the same position. The
    next switch resets failed units before it starts any, and the next reconcile resets a
    failed idle worker slot first; see `_reset_failed_idle_workers`.
    """
    if (
        app.retire_without_waiting
        and ctx.services.active_state(unit) == "deactivating"
        and ctx.services.sub_state(unit) == "stop"
    ):
        ctx.out.line(f"{app.name}: {unit} drains on its own; not waiting for it")
        return
    if ctx.services.active_state(unit) in ("activating", "deactivating"):
        error = ctx.services.stop(unit, block=True)
        if error is not None:
            ctx.out.warn(f"{app.name}: cannot stop {unit}: {error}")
    if ctx.services.active_state(unit) == "failed":
        ctx.services.reset_failed(unit)


def _failed_idle_workers(ctx: Context, state: State | None) -> list[tuple[AppConfig, str]]:
    """The failed idle slot of each worker that retires without waiting.

    Its drain goes on after the run that told it to stop, and ends failed when the worker
    exits with a status other than 0 or 143 or outlasts its stop timeout.
    """
    failed: list[tuple[AppConfig, str]] = []
    for name in sorted(ctx.unit.apps):
        app = ctx.unit.apps[name]
        app_state = state.apps.get(name) if state is not None else None
        if not app.retire_without_waiting or app_state is None or app_state.slot is None:
            continue
        unit = app.unit(other_slot(app_state.slot))
        if ctx.services.active_state(unit) == "failed":
            failed.append((app, unit))
    return failed


def _reset_failed_idle_workers(ctx: Context) -> None:
    """Reset failed idle worker slots before anything in the run can fail.

    A host switch fails while any unit is failed. It resets failed units before it starts
    any, but a drain can end failed after that, while the switch runs. Only idle slots are
    reset; the run starts a failed active slot again.
    """
    for app, unit in _failed_idle_workers(ctx, ctx.store.load()):
        ctx.out.warn(
            f"{app.name}: the idle worker slot {unit} failed; resetting it. "
            f"journalctl -u {unit} shows why."
        )
        ctx.services.reset_failed(unit)


def _give_up(ctx: Context, failures: dict[str, str]) -> None:
    """Report apps that stay down without failing.

    Apps get here only when this run does not apply a changed definition to them, so they
    were already down or broken. Failing would fail every host activation that reconciles
    the unit, and its rollback, until someone repairs them; `app-release check` fails for
    them instead.
    """
    for name, message in sorted(failures.items()):
        ctx.out.warn(f"{message}; {name} stays down. {_repair_hint(ctx)}")


def _route_to(targets: list[HealthTarget]) -> None:
    """Point the upstreams at healthy slots; Caddy reads the file on every request."""
    for target in targets:
        if target.slot is not None:
            write_upstream(target.app, target.slot)


def _drains(ctx: Context, app: AppConfig, slot: Slot) -> bool:
    """Whether an old port-less worker still runs in `slot`; starting the slot would stop it."""
    return app.portless and ctx.services.active_state(app.unit(slot)) not in STOPPED_STATES


def _move_to_idle_slots(
    ctx: Context,
    state: State,
    targets: list[tuple[AppConfig, Slot, Image]],
    *,
    all_or_nothing: bool,
) -> tuple[State, dict[str, str]]:
    """Start each app's idle slot on its image, then switch to it and retire the old slot.

    With `all_or_nothing`, a failing app undoes every app. Otherwise an app whose new slot
    fails keeps its old slot without holding back the others, and the failures are
    returned. Raises once anything else fails, after undoing every app.
    """
    transaction = Transaction(ctx)
    failures: dict[str, str] = {}
    try:
        if all_or_nothing:
            transaction.start_idle_slots(targets)
        else:
            failures = transaction.start_idle_slots_independently(targets)
        moved = [(app, slot) for app, slot, _ in targets if app.name not in failures]
        if not moved:
            return state, failures
        transaction.switch(moved)
        new_state = state
        for app, slot in moved:
            app_state = replace(
                state.apps[app.name], slot=slot, definition_hash=app.definition_hash
            )
            new_state = new_state.with_app(app.name, app_state)
        transaction.commit(new_state, state)
    except StepError as error:
        raise transaction.fail(error.message) from None
    except AppReleaseError as error:
        raise transaction.fail(error.message) from None
    except Exception as error:
        # After something moved, any error must restore the previous version.
        message = f"unexpected error: {error!r}"
        raise transaction.fail(message) from error
    retire(ctx, [(app, other_slot(slot)) for app, slot in moved])
    return new_state, failures


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
        if _drains(ctx, app, idle):
            ctx.out.warn(
                f"{app.name}: the previous worker in slot {idle} is still draining; "
                "keeping the running definition. The next release applies it."
            )
            continue
        targets.append((app, idle, images[app.name]))
    if not targets:
        return state
    state, _ = _move_to_idle_slots(ctx, state, targets, all_or_nothing=True)
    return state


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
        # Record the configured one, which the container now runs. A later reconcile of the
        # same definition, such as the restore after a failed rollback, then retries an app
        # that stays down without failing its host activation; a cleared hash would fail
        # every activation until someone repairs the app.
        ctx.store.save(
            state.with_app(
                app.name, replace(state.apps[app.name], definition_hash=app.definition_hash)
            )
        )
        message = (
            f"{failures[app.name]}; the previous definition cannot be restored; "
            f"{app.name} may be down"
        )
        raise CriticalError(message)
    new_state = state.with_app(
        app.name, replace(state.apps[app.name], definition_hash=app.definition_hash)
    )
    ctx.store.save(new_state)
    return new_state


def _record_definitions(ctx: Context, state: State, names: set[str]) -> State:
    """Record the configured definitions whose start was attempted."""
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


def _recovery_targets(
    ctx: Context, state: State, apps: list[AppConfig], failures: dict[str, str]
) -> list[tuple[AppConfig, Slot, Image]]:
    """The idle slot and current image of each unhealthy app that can move now."""
    targets: list[tuple[AppConfig, Slot, Image]] = []
    for app in apps:
        slot = state.apps[app.name].slot
        if app.name not in failures or slot is None:
            continue
        idle = other_slot(slot)
        if _drains(ctx, app, idle):
            ctx.out.warn(
                f"{app.name}: the previous worker in slot {idle} is still draining; "
                f"not restarting {app.name} until it stops"
            )
            continue
        try:
            image = ensure_image(ctx, app, state.apps[app.name].current.digest)
        except AppReleaseError as error:
            ctx.out.warn(error.message)
            continue
        ctx.out.warn(f"{failures[app.name]}; restarting {app.name} at its current digest")
        targets.append((app, idle, image))
    return targets


def _recover(ctx: Context, state: State, names: set[str]) -> State:
    """Move running blue-green apps whose active slot is unhealthy to their idle slot.

    It probes every app in one health wait and waits for all new slots in a second one, so
    the waits do not grow with the number of unhealthy apps. A slot that still serves some
    requests keeps serving until its replacement is healthy. Recreate apps are left to
    systemd, `app-release check` and `app-release refresh`: their restarts run
    preStopCommand, which has no time limit, one app at a time.
    """
    apps = [ctx.unit.apps[name] for name in sorted(names) if ctx.unit.apps[name].blue_green]
    failures = wait_healthy(ctx, [HealthTarget(app, state.apps[app.name].slot) for app in apps])
    targets = _recovery_targets(ctx, state, apps, failures)
    try:
        state, problems = _move_to_idle_slots(ctx, state, targets, all_or_nothing=False)
    except AppReleaseError as error:
        problems = {app.name: error.message for app, _, _ in targets}
    for message in dict.fromkeys(problems.values()):
        ctx.out.warn(message)
    recovered: dict[str, str] = {}
    for app, slot, _ in targets:
        if app.name in problems:
            _settle(ctx, app, app.unit(slot))
        else:
            recovered[app.name] = state.apps[app.name].current.digest
            del failures[app.name]
    _give_up(ctx, failures)
    if recovered:
        state = state.with_history(
            HistoryEntry(
                at=ctx.clock.now(),
                operation="recover",
                result="recovered",
                run_id=None,
                actor=None,
                apps=recovered,
            )
        )
        ctx.store.save(state)
    return state


def _clean_up(ctx: Context, state: State) -> None:
    """DESIGN reconcile step 4: stop the slots that are not active, after the drain wait."""
    retirements: list[tuple[AppConfig, Slot]] = []
    for name in sorted(ctx.unit.apps):
        app = ctx.unit.apps[name]
        slot = state.apps[name].slot
        if slot is None:
            continue
        inactive = other_slot(slot)
        if ctx.services.active_state(app.unit(inactive)) in STOPPED_STATES:
            continue
        retirements.append((app, inactive))
    retire(ctx, retirements)


def reconcile(ctx: Context, *, force: bool = False) -> State:
    """Make the host run what the state says, bootstrapping it first if needed."""
    _reset_failed_idle_workers(ctx)
    start_dependencies(ctx)
    state = _load(ctx)
    state, running, stale = _enforce(ctx, state, force=force)
    state = _refresh(ctx, state, running, stale, force=force)
    state = _recover(ctx, state, running)
    _clean_up(ctx, state)
    collect_garbage(ctx)
    return state


def refresh(ctx: Context) -> State:
    """Restart every running app at its current digest, even when the definition is unchanged."""
    return reconcile(ctx, force=True)


def gc(ctx: Context) -> None:
    collect_garbage(ctx)


def check(ctx: Context) -> None:
    """Fail unless the active slot of every app is healthy; changes nothing.

    A failed idle worker slot only warns: the active slot still serves, and the next host
    activation resets the failure.
    """
    state = ctx.store.load()
    for app, unit in _failed_idle_workers(ctx, state):
        ctx.out.warn(
            f"{app.name}: the idle worker slot {unit} failed; the next host activation "
            f"resets it. journalctl -u {unit} shows why."
        )
    problems: list[str] = []
    targets: list[HealthTarget] = []
    for name in sorted(ctx.unit.apps):
        app = ctx.unit.apps[name]
        app_state = state.apps.get(name) if state is not None else None
        if app_state is None or app.blue_green != (app_state.slot is not None):
            problems.append(f"{name}: not reconciled yet")
            continue
        targets.append(HealthTarget(app, app_state.slot))
    failures = wait_healthy(ctx, targets)
    problems.extend(failures[name] for name in sorted(failures))
    if problems:
        message = f"{'; '.join(problems)}. {_repair_hint(ctx)}"
        raise FailedError(message)


def prepare(ctx: Context, app_name: str, slot: Slot | None) -> None:
    """Tag the image a container unit starts from when that tag is missing.

    Every generated container unit runs this before it starts, without the unit lock, so
    another unit that starts it before the reconcile does (on a host's first activation, for
    example) finds its image instead of failing. Releases and the reconcile tag images
    before they start units, so this only fills a missing tag of the active slot: with the
    image the state records, or with `:production` before the first reconcile.
    """
    app = ctx.unit.apps.get(app_name)
    if app is None or app.blue_green != (slot is not None):
        message = f"unit {ctx.unit.name} has no container for app {app_name!r} in slot {slot}"
        raise RejectedError(message)
    tag = app.active_tag(slot)
    if ctx.images.exists(tag):
        return
    stored = ctx.store.load()
    app_state = stored.apps.get(app_name) if stored is not None else None
    active = app_state.slot if app_state is not None else None
    if app.blue_green and active is None:
        active = "blue"
    elif not app.blue_green:
        active = None
    if slot != active:
        return
    start_dependencies(ctx)
    image = (
        _production_image(ctx, app)
        if app_state is None
        else ensure_image(ctx, app, app_state.current.digest)
    )
    ctx.out.line(f"{app.name}: tagging {tag} before its container starts")
    ctx.images.tag(image.id, tag)
