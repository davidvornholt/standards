"""The release and rollback operations."""

from dataclasses import dataclass, replace

from app_release.config import AppConfig, Slot, other_slot
from app_release.context import Claims, Context
from app_release.errors import AppReleaseError, FailedError, RejectedError
from app_release.podman import Image, PodmanError
from app_release.state import AppState, HistoryEntry, Release, State
from app_release.steps import (
    StepError,
    Transaction,
    collect_garbage,
    draining_message,
    ensure_image,
    idle_busy,
    retire,
    start_dependencies,
)


@dataclass(frozen=True)
class Target:
    """What one app becomes after the operation."""

    app: AppConfig
    image: Image
    current: Release
    previous: Release | None
    restart: bool
    """Start the app again: its image or its configured definition changed."""
    old_image_id: str | None
    """The image the app runs now, for recreate apps that may have to be restored."""


@dataclass(frozen=True)
class Outcome:
    result: str
    message: str
    state: State


def require_state(ctx: Context) -> State:
    state = ctx.store.load()
    if state is None:
        message = (
            f"unit {ctx.unit.name} has no release state yet; "
            f"start app-release-{ctx.unit.name}.service on the host first"
        )
        raise FailedError(message)
    missing = sorted(set(ctx.unit.apps) - set(state.apps))
    if missing:
        message = (
            f"{', '.join(missing)} not bootstrapped yet; "
            f"start app-release-{ctx.unit.name}.service on the host first"
        )
        raise FailedError(message)
    return state


def _running_image(ctx: Context, app: AppConfig, app_state: AppState) -> Image | None:
    image = ctx.images.inspect(app.active_tag(app_state.slot))
    if image is None:
        image = ctx.images.inspect(f"{app.image_repository}@{app_state.current.digest}")
    return image


def _target(
    ctx: Context,
    app: AppConfig,
    app_state: AppState,
    image: Image,
    current: Release,
) -> Target:
    """Classify one app: unchanged, content-identical or changed (DESIGN release step 4)."""
    definition_changed = app.definition_hash != app_state.definition_hash
    running = None if app.blue_green else _running_image(ctx, app, app_state)
    if image.digest == app_state.current.digest:
        if definition_changed:
            ctx.out.line(f"{app.name}: same image, changed host definition; restarting it")
        return Target(
            app=app,
            image=image,
            current=current,
            previous=app_state.previous,
            restart=definition_changed,
            old_image_id=running.id if running is not None else None,
        )
    if running is None and app.blue_green:
        running = _running_image(ctx, app, app_state)
    if running is not None and running.content == image.content:
        if definition_changed:
            ctx.out.line(
                f"{app.name}: content-identical image, changed host definition; restarting it"
            )
        else:
            ctx.out.line(f"{app.name}: content-identical to the running image; no restart")
        return Target(
            app=app,
            image=image,
            current=current,
            previous=app_state.previous,
            restart=definition_changed,
            old_image_id=running.id,
        )
    return Target(
        app=app,
        image=image,
        current=current,
        previous=app_state.current,
        restart=True,
        old_image_id=running.id if running is not None else None,
    )


def _check_draining(ctx: Context, state: State, targets: list[Target]) -> None:
    for target in targets:
        app = target.app
        slot = state.apps[app.name].slot
        if target.restart and app.blue_green and slot is not None:
            busy = idle_busy(ctx, app, slot)
            if busy is not None:
                raise FailedError(draining_message(app, busy))


def _ensure_old_images(ctx: Context, state: State, targets: list[Target]) -> list[Target]:
    """Recreate apps that restart need their running image to fall back to."""
    resolved = []
    for target in targets:
        if target.restart and not target.app.blue_green and target.old_image_id is None:
            digest = state.apps[target.app.name].current.digest
            old = ensure_image(ctx, target.app, digest)
            resolved.append(replace(target, old_image_id=old.id))
        else:
            resolved.append(target)
    return resolved


def _migrate(ctx: Context, targets: dict[str, Target]) -> None:
    migration = ctx.unit.migration
    if migration is None:
        return
    target = targets[migration.app]
    tag = target.app.local_tag("candidate")
    ctx.out.line(f"running migration {migration.service} with {target.image.digest}")
    ctx.images.tag(target.image.id, tag)
    try:
        # Restart rather than start: a migration unit that an earlier host configuration kept
        # active stays active after the switch, and starting it again would do nothing.
        error = ctx.services.restart(migration.service, timeout=None)
    finally:
        try:
            ctx.images.untag(target.image.id, tag)
        except PodmanError as untag_error:
            ctx.out.warn(untag_error.message)
    if error is not None:
        message = f"migration {migration.service} failed: {error}; nothing changed"
        raise FailedError(message)
    ctx.out.line(f"migration {migration.service} finished")


def _retag(ctx: Context, state: State, targets: list[Target]) -> None:
    """Point the active tag of apps that did not restart at their new current image."""
    for target in targets:
        if target.restart:
            continue
        tag = target.app.active_tag(state.apps[target.app.name].slot)
        try:
            ctx.images.tag(target.image.id, tag)
        except PodmanError as error:
            ctx.out.warn(f"{target.app.name}: {error.message}; the next reconcile fixes the tag")


def _next_state(
    state: State,
    targets: list[Target],
    *,
    highest_run_id: int,
    entry: HistoryEntry,
) -> State:
    apps = dict(state.apps)
    for target in targets:
        old = state.apps[target.app.name]
        slot: Slot | None = old.slot
        definition_hash = old.definition_hash
        if target.restart:
            definition_hash = target.app.definition_hash
            if target.app.blue_green and old.slot is not None:
                slot = other_slot(old.slot)
        apps[target.app.name] = AppState(
            slot=slot,
            definition_hash=definition_hash,
            current=target.current,
            previous=target.previous,
        )
    return State(highest_run_id=highest_run_id, apps=apps, history=state.history).with_history(
        entry
    )


def _history(
    ctx: Context, operation: str, result: str, claims: Claims, targets: list[Target]
) -> HistoryEntry:
    return HistoryEntry(
        at=ctx.clock.now(),
        operation=operation,
        result=result,
        run_id=claims.run_id,
        actor=claims.actor,
        apps={target.app.name: target.current.digest for target in targets},
    )


def _apply(  # noqa: PLR0913 - the operation's inputs, passed by keyword
    ctx: Context,
    state: State,
    targets: list[Target],
    *,
    claims: Claims,
    operation: str,
    result: str,
    highest_run_id: int,
    migrate: bool,
) -> State:
    """DESIGN release steps 5 to 10 for the classified targets."""
    _check_draining(ctx, state, targets)
    targets = _ensure_old_images(ctx, state, targets)
    restarting = [target for target in targets if target.restart]
    if migrate and restarting:
        _migrate(ctx, {target.app.name: target for target in targets})
    entry = _history(ctx, operation, result, claims, targets)
    blue_green: list[tuple[AppConfig, Slot, Image]] = []
    for target in restarting:
        slot = state.apps[target.app.name].slot
        if target.app.blue_green and slot is not None:
            blue_green.append((target.app, other_slot(slot), target.image))
    recreate = sorted(
        (target for target in restarting if not target.app.blue_green),
        key=lambda target: (target.app.priority, target.app.name),
    )
    transaction = Transaction(ctx)
    try:
        if blue_green:
            transaction.start_idle_slots(blue_green)
        for target in recreate:
            transaction.restart_recreate(target.app, target.image, target.old_image_id or "")
        transaction.switch([(app, slot) for app, slot, _ in blue_green])
        new_state = _next_state(state, targets, highest_run_id=highest_run_id, entry=entry)
        transaction.commit(new_state, state)
    except StepError as error:
        raise transaction.fail(error.message) from None
    except AppReleaseError as error:
        raise transaction.fail(error.message) from None
    except Exception as error:
        # After something moved, any error must restore the previous version.
        message = f"unexpected error: {error!r}"
        raise transaction.fail(message) from error
    _finish(ctx, state, targets, [(app, other_slot(slot)) for app, slot, _ in blue_green])
    return new_state


def _finish(
    ctx: Context, state: State, targets: list[Target], retirements: list[tuple[AppConfig, Slot]]
) -> None:
    """Steps after the commit. The operation has succeeded, so failures are only warnings."""
    try:
        _retag(ctx, state, targets)
        retire(ctx, retirements)
        collect_garbage(ctx)
    except Exception as error:  # noqa: BLE001 - the release is committed; report and carry on
        ctx.out.warn(f"after the switch: unexpected error: {error!r}")


def _summary(targets: list[Target]) -> str:
    return ", ".join(f"{target.app.name}@{target.current.digest}" for target in targets)


def release(ctx: Context, claims: Claims, digests: dict[str, str]) -> Outcome:
    state = require_state(ctx)
    if claims.run_id < state.highest_run_id:
        message = (
            f"run {claims.run_id} is older than run {state.highest_run_id}, "
            "which already released a newer commit; nothing changed"
        )
        ctx.out.line(message)
        return Outcome("superseded", message, state)
    start_dependencies(ctx)
    images = {
        name: ensure_image(ctx, ctx.unit.apps[name], digest) for name, digest in digests.items()
    }
    for name, image in images.items():
        if image.revision != claims.sha:
            message = (
                f"{name}: image {image.digest} has revision {image.revision or 'none'}, "
                f"but the release is for commit {claims.sha}"
            )
            raise RejectedError(message)
    now = ctx.clock.now()
    targets = []
    for name in sorted(digests):
        app = ctx.unit.apps[name]
        app_state = state.apps[name]
        image = images[name]
        same = image.digest == app_state.current.digest
        record = (
            app_state.current if same else Release(image.digest, image.revision, claims.run_id, now)
        )
        targets.append(_target(ctx, app, app_state, image, current=record))
    highest = max(state.highest_run_id, claims.run_id)
    if not any(target.restart for target in targets):
        entry = _history(ctx, "release", "unchanged", claims, targets)
        new_state = _next_state(state, targets, highest_run_id=highest, entry=entry)
        ctx.store.save(new_state)
        _finish(ctx, state, targets, [])
        return Outcome("unchanged", f"nothing to restart; recorded {_summary(targets)}", new_state)
    new_state = _apply(
        ctx,
        state,
        targets,
        claims=claims,
        operation="release",
        result="released",
        highest_run_id=highest,
        migrate=True,
    )
    return Outcome("released", f"released {_summary(targets)}", new_state)


def rollback(ctx: Context, claims: Claims) -> Outcome:
    state = require_state(ctx)
    missing = sorted(name for name in ctx.unit.apps if state.apps[name].previous is None)
    if missing:
        message = f"nothing to roll back: {', '.join(missing)} has no previous version"
        raise FailedError(message)
    start_dependencies(ctx)
    targets = []
    for name in sorted(ctx.unit.apps):
        app = ctx.unit.apps[name]
        app_state = state.apps[name]
        previous = app_state.previous
        if previous is None:
            continue
        image = ensure_image(ctx, app, previous.digest)
        target = _target(ctx, app, app_state, image, current=previous)
        # A rollback always swaps current and previous, also when nothing restarts.
        targets.append(replace(target, previous=app_state.current))
    if not any(target.restart for target in targets):
        entry = _history(ctx, "rollback", "rolled-back", claims, targets)
        new_state = _next_state(state, targets, highest_run_id=state.highest_run_id, entry=entry)
        ctx.store.save(new_state)
        _finish(ctx, state, targets, [])
        return Outcome("rolled-back", f"rolled back to {_summary(targets)}", new_state)
    new_state = _apply(
        ctx,
        state,
        targets,
        claims=claims,
        operation="rollback",
        result="rolled-back",
        highest_run_id=state.highest_run_id,
        migrate=False,
    )
    return Outcome("rolled-back", f"rolled back to {_summary(targets)}", new_state)
