# The NixOS test driver prepends REVISIONS (image name -> revision label).
import json
import shlex

RESULT_PREFIX = "APP_RELEASE_RESULT "
APPS = ("web", "worker", "jobs")
SSH = (
    "ssh -i /etc/app-release-test/ssh-key -o BatchMode=yes -o StrictHostKeyChecking=no"
    " -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR root@localhost"
)
STATE = "/var/lib/app-release/shop/state.json"


def state() -> dict:
    return json.loads(machine.succeed(f"cat {STATE}"))


def active_state(unit: str) -> str:
    return machine.succeed(f"systemctl show -p ActiveState --value {unit}").strip()


def invocation(unit: str) -> str:
    return machine.succeed(f"systemctl show -p InvocationID --value {unit}").strip()


def served(port: int = 80) -> str:
    return machine.succeed(f"curl -fsS -m 5 http://localhost:{port}/").strip()


def lines(path: str) -> list[str]:
    return machine.succeed(f"cat {path} 2>/dev/null || true").split()


def digest(app: str, image: str) -> str:
    reference = f"docker://localhost:5000/owner/{app}:{image}"
    return machine.succeed(
        "skopeo inspect --tls-verify=false --format '{{.Digest}}' " + reference
    ).strip()


def call(command: str, expect: int, **claims: str | int) -> tuple[dict, str]:
    options = " ".join(
        f"--{name.replace('_', '-')} {shlex.quote(str(value))}" for name, value in claims.items()
    )
    status, output = machine.execute(f"mint-token {options} | {SSH} {shlex.quote(command)}")
    print(output)
    assert status == expect, f"{command!r} exited {status}, expected {expect}"
    results = [line for line in output.splitlines() if line.startswith(RESULT_PREFIX)]
    assert results, f"{command!r} printed no result line"
    return json.loads(results[-1][len(RESULT_PREFIX) :]), output


def release(images: dict[str, str], run_id: int, sha: str, expect: int = 0) -> tuple[dict, str]:
    command = "release " + " ".join(f"{app}@{DIGESTS[images[app]][app]}" for app in APPS)
    return call(command, expect, sha=sha, run_id=run_id)


def same(image: str) -> dict[str, str]:
    return dict.fromkeys(APPS, image)


def start_load() -> None:
    machine.succeed("rm -rf /run/load && mkdir -p /run/load")
    machine.succeed(
        "systemd-run --unit=load --collect --service-type=exec $(command -v load-generator)"
    )
    machine.wait_until_succeeds("test -s /run/load/served")


def stop_load() -> list[str]:
    machine.succeed("touch /run/load/stop")
    machine.wait_until_fails("systemctl is-active --quiet load.service")
    failed = lines("/run/load/failed")
    assert not failed, f"{len(failed)} requests failed: {machine.succeed('cat /run/load/errors')}"
    responses = lines("/run/load/served")
    print(f"load: {len(responses)} requests, versions {sorted(set(responses))}")
    return responses


def wait_stopped(unit: str) -> None:
    machine.wait_until_succeeds(
        f"systemctl show -p ActiveState --value {unit} | grep -Eqx 'inactive|failed'", timeout=90
    )


def apps_state(data: dict) -> dict:
    return {app: data["apps"][app] for app in APPS}


def current_digests(data: dict) -> dict[str, str]:
    return {app: data["apps"][app]["current"]["digest"] for app in APPS}


def previous_digests(data: dict) -> dict[str, str | None]:
    return {app: (data["apps"][app]["previous"] or {}).get("digest") for app in APPS}


def digests_of(image: str) -> dict[str, str]:
    return DIGESTS[image]


machine.start()

with subtest("bootstrap from :production"):
    machine.wait_for_unit("app-release-shop.service")
    machine.wait_for_unit("caddy.service")
    DIGESTS = {image: {app: digest(app, image) for app in APPS} for image in REVISIONS}
    assert served() == "v1"
    assert served(9000) == "v1"
    data = state()
    assert data["highestRunId"] == 0
    assert data["history"][-1]["operation"] == "bootstrap"
    assert current_digests(data) == digests_of("v1")
    assert previous_digests(data) == dict.fromkeys(APPS)
    assert data["apps"]["web"]["current"]["revision"] == REVISIONS["v1"]
    assert data["apps"]["web"]["slot"] == "blue"
    assert data["apps"]["worker"]["slot"] == "blue"
    assert data["apps"]["jobs"]["slot"] is None
    assert active_state("podman-web-blue.service") == "active"
    assert active_state("podman-web-green.service") == "inactive"
    assert active_state("podman-worker-blue.service") == "active"
    machine.succeed("mint-token --init")

with subtest("requests that fail authorization or validation are rejected"):
    before = state()
    v2 = "release " + " ".join(f"{app}@{DIGESTS['v2'][app]}" for app in APPS)
    good: dict[str, str | int] = {"sha": REVISIONS["v2"], "run_id": 100}
    rejections: list[tuple[dict[str, str | int], str]] = [
        ({"repository": "owner/other"}, "repository"),
        ({"repository": "Owner/Shop"}, "repository"),
        ({"ref": "refs/heads/feature"}, "ref"),
        ({"audience": "sigstore"}, "not valid"),
        ({"expires_in": -600}, "expired"),
        ({"event": "pull_request"}, "pull_request"),
        ({"run_attempt": "0"}, "run_attempt"),
    ]
    for overrides, fragment in rejections:
        result, output = call(v2, 2, **{**good, **overrides})
        assert result["result"] == "failed"
        assert fragment in output, f"{overrides}: {fragment!r} missing"
    call("rm -rf /", 2, **good)
    call("release web@" + DIGESTS["v2"]["web"], 2, **good)
    call("rollback", 2, **good)
    result, output = call(v2, 2, sha=REVISIONS["v1"], run_id=100)
    assert "revision" in output
    result, _ = call("status", 0, jti="replayed")
    assert result["result"] == "status"
    assert result["apps"]["web"]["digest"] == DIGESTS["v1"]["web"]
    _, output = call("status", 2, jti="replayed")
    assert "already used" in output
    assert state() == before
    assert served() == "v1"

with subtest("release v2 blue to green with zero failed requests"):
    start_load()
    result, output = release(same("v2"), 100, REVISIONS["v2"])
    responses = stop_load()
    worker_retiring = active_state("podman-worker-blue.service")
    assert result["result"] == "released"
    assert set(responses) == {"v1", "v2"}, responses
    assert responses[-1] == "v2"
    assert result["apps"]["web"] == {
        "repository": "localhost:5000/owner/web",
        "digest": DIGESTS["v2"]["web"],
        "previousDigest": DIGESTS["v1"]["web"],
        "slot": "green",
    }
    data = state()
    assert data["highestRunId"] == 100
    assert current_digests(data) == digests_of("v2")
    assert previous_digests(data) == digests_of("v1")
    assert data["apps"]["web"]["slot"] == "green"
    assert data["apps"]["worker"]["slot"] == "green"
    assert served(9000) == "v2"
    assert lines("/var/lib/migrations.log") == ["v2"]
    assert lines("/run/pre-stop.log") == ["pre-stop", "jobs", "jobs"]
    assert active_state("podman-web-blue.service") == "inactive"
    assert active_state("podman-worker-green.service") == "active"
    # Revision 2: the old worker was only told to stop and is still draining.
    assert worker_retiring == "deactivating", worker_retiring

with subtest("a release while the old worker drains fails fast and changes nothing"):
    before = state()
    result, output = release(same("v3"), 101, REVISIONS["v3"], expect=1)
    assert result["result"] == "failed"
    assert (
        "worker: the previous worker in slot blue is still draining; nothing changed. "
        "Re-run this release after it stops." in output
    )
    assert state() == before
    assert lines("/var/lib/migrations.log") == ["v2"]
    assert served() == "v2"
    wait_stopped("podman-worker-blue.service")

with subtest("an older run is superseded"):
    before = state()
    result, _ = release(same("v3"), 99, REVISIONS["v3"])
    assert result["result"] == "superseded"
    assert state() == before

with subtest("a failed health check keeps the live version serving"):
    before = state()
    pre_stops = lines("/run/pre-stop.log")
    start_load()
    result, output = release(same("broken"), 102, REVISIONS["broken"], expect=1)
    responses = stop_load()
    assert result["result"] == "failed"
    assert "web: not healthy within 15 s" in output
    assert set(responses) == {"v2"}
    assert state() == before
    assert result["apps"]["web"]["digest"] == DIGESTS["v2"]["web"]
    assert lines("/run/pre-stop.log") == pre_stops
    wait_stopped("podman-web-blue.service")
    wait_stopped("podman-worker-blue.service")

with subtest("a failed migration moves nothing"):
    before = state()
    units = {unit: invocation(unit) for unit in ("podman-web-green.service", "podman-jobs.service")}
    machine.succeed("touch /run/fail-migration")
    result, output = release(same("v3"), 103, REVISIONS["v3"], expect=1)
    machine.succeed("rm /run/fail-migration")
    assert "migration shop-migrate.service failed" in output
    assert state() == before
    assert {unit: invocation(unit) for unit in units} == units
    assert active_state("podman-web-blue.service") == "inactive"

with subtest("a content-identical image is recorded without a restart"):
    units = {
        unit: invocation(unit)
        for unit in (
            "podman-web-green.service",
            "podman-worker-green.service",
            "podman-jobs.service",
        )
    }
    migrations = lines("/var/lib/migrations.log")
    pre_stops = lines("/run/pre-stop.log")
    result, _ = release(same("v2b"), 104, REVISIONS["v2b"])
    assert result["result"] == "unchanged"
    data = state()
    assert data["highestRunId"] == 104
    assert current_digests(data) == digests_of("v2b")
    assert previous_digests(data) == digests_of("v1")
    assert {unit: invocation(unit) for unit in units} == units
    assert lines("/var/lib/migrations.log") == migrations
    assert lines("/run/pre-stop.log") == pre_stops

with subtest("a recreate app that fails its health check is reverted"):
    before = state()
    pre_stops = lines("/run/pre-stop.log")
    start_load()
    images = {"web": "v3", "worker": "v3", "jobs": "v3broken"}
    result, output = release(images, 105, REVISIONS["v3"], expect=1)
    responses = stop_load()
    assert "jobs: not healthy within 15 s" in output
    assert set(responses) == {"v2"}
    assert state() == before
    assert served(9000) == "v2"
    # preStopCommand ran before the restart and again before the revert.
    assert len(lines("/run/pre-stop.log")) == len(pre_stops) + 6
    wait_stopped("podman-web-blue.service")
    wait_stopped("podman-worker-blue.service")

with subtest("release v3"):
    start_load()
    result, _ = release(same("v3"), 106, REVISIONS["v3"])
    responses = stop_load()
    assert result["result"] == "released"
    assert set(responses) == {"v2", "v3"}
    assert responses[-1] == "v3"
    data = state()
    assert current_digests(data) == digests_of("v3")
    assert previous_digests(data) == digests_of("v2b")
    assert data["apps"]["web"]["slot"] == "blue"
    assert served(9000) == "v3"
    wait_stopped("podman-worker-green.service")

with subtest("rollback toggles between the last two versions"):
    for run_id, version, slot, current, previous in (
        (107, "v2", "green", "v2b", "v3"),
        (108, "v3", "blue", "v3", "v2b"),
    ):
        start_load()
        result, _ = call("rollback", 0, event="workflow_dispatch", run_id=run_id)
        responses = stop_load()
        assert result["result"] == "rolled-back"
        assert responses[-1] == version
        data = state()
        assert data["highestRunId"] == 106
        assert data["apps"]["web"]["slot"] == slot
        assert current_digests(data) == digests_of(current)
        assert previous_digests(data) == digests_of(previous)
        assert served(9000) == version
        wait_stopped(f"podman-worker-{'green' if slot == 'blue' else 'blue'}.service")

with subtest("garbage collection keeps only current and previous images"):
    for image in ("v1", "v2", "broken", "v3broken"):
        machine.fail(f"podman image exists localhost:5000/owner/web@{DIGESTS[image]['web']}")
    for image in ("v2b", "v3"):
        machine.succeed(f"podman image exists localhost:5000/owner/web@{DIGESTS[image]['web']}")

with subtest("a reboot restores the released slot and version"):
    before = state()
    machine.shutdown()
    machine.start()
    machine.wait_for_unit("app-release-shop.service")
    assert served() == "v3"
    assert served(9000) == "v3"
    assert active_state("podman-web-blue.service") == "active"
    assert active_state("podman-web-green.service") == "inactive"
    assert active_state("podman-worker-blue.service") == "active"
    assert apps_state(state()) == apps_state(before)

with subtest("a changed container definition is applied without failed requests"):
    before = state()
    units = {
        unit: invocation(unit) for unit in ("podman-worker-blue.service", "podman-jobs.service")
    }
    start_load()
    machine.succeed("/run/current-system/specialisation/changed/bin/switch-to-configuration test")
    responses = stop_load()
    assert set(responses) == {"v3"}
    data = state()
    assert data["apps"]["web"]["slot"] == "green"
    assert data["apps"]["web"]["definitionHash"] != before["apps"]["web"]["definitionHash"]
    assert current_digests(data) == current_digests(before)
    assert data["history"][-1]["operation"] == "refresh"
    assert {unit: invocation(unit) for unit in units} == units
    machine.succeed("podman exec web-green printenv TEST_CHANGED")
    assert active_state("podman-web-blue.service") == "inactive"
