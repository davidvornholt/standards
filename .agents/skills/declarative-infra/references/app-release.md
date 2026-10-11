# App releases

A first-party app releases from its own repository straight onto its host. The host repository declares the app's runtime definition as an app-release unit. The app repository's main-branch workflow builds the image and calls the vendored action, which asks the host over SSH to run that exact digest. The host verifies the request, starts the new version beside the old one, switches traffic, and records the live digests in `/var/lib/app-release/<unit>/state.json`. A release never changes the host repository and never triggers a NixOS deployment, so never pin a first-party app digest in the host repository.

## Host module

The module and its CLI live in [`nix/app-release`](https://github.com/davidvornholt/standards/tree/main/nix/app-release) in the standards flake. [`module.nix`](https://github.com/davidvornholt/standards/blob/main/nix/app-release/module.nix) describes every option. A host imports it as `inputs.standards.nixosModules.app-release`, with the `standards` input pinned to a commit and its `nixpkgs` following the host's. It is the one shared module a host imports instead of copying, because its tests and VM check live with it.

A unit is the set of apps one repository releases together through one SSH key. The essentials:

```nix
{ config, ... }:
let
  release = config.services.appRelease.units.web;
in {
  services.appRelease = {
    enable = true;
    units.web = {
      repository = "owner/web"; # OIDC repository claim, case-sensitive; ref defaults to refs/heads/main
      sshKeys = [ "ssh-ed25519 AAAA... app-release-web" ];
      migration = { service = "web-migrate"; app = "web"; }; # optional
      apps.web = {
        imageRepository = "ghcr.io/owner/web";
        containerPort = 3000;
        slotPorts = { blue = 3010; green = 3510; }; # host loopback ports
        health.path = "/api/health"; # any 2xx or 3xx counts
        container = {
          environment.PORT = "3000";
          extraOptions = [ "--cap-drop=ALL" "--read-only" ];
        };
      };
    };
  };

  services.caddy.virtualHosts."web.example.com".extraConfig = ''
    reverse_proxy ${release.apps.web.caddyUpstream}
  '';
}
```

- `caddyUpstream` reads the live slot address from a file on every request, so a slot switch needs no Caddy reload. Use it as `reverse_proxy <upstream>` or as `to <upstream>` inside a `reverse_proxy` block. Do not proxy to a slot port directly.
- `strategy` defaults to `blue-green`: two slots on loopback ports, with the idle slot started and health-checked before traffic moves. Use `recreate` only when two versions cannot run side by side, such as a container that other containers address by a stable name; it restarts in place with a short interruption. A worker without ports stays blue-green with `containerPort` and `slotPorts` unset and a `health.command`. Give a worker with long drains `retireWithoutWaiting` and its own unit, so its drain does not hold the lock for other apps.
- `container` passes through to `virtualisation.oci-containers.containers`. The module owns `image`, `autoStart`, and `serviceName`, plus `ports` for blue-green apps. Recreate apps publish ports through `container.ports` and need `health.port` or `health.command`. Container units count exit status 143, which runtimes such as Bun return after the SIGTERM of a normal stop, as success, so a retired slot ends inactive rather than failed. An app that exits with another status after SIGTERM leaves its retired slot failed.
- Every container unit runs `app-release prepare` before it starts, so another unit, such as an ingress proxy, may require an app's container. When the container's image tag is missing, the unit tags the image the release state names for the active slot, or `:production` before the first reconcile.
- `migration.service` is a oneshot without `RemainAfterExit` or `wantedBy` that runs the image `localhost/app-release/<app>:candidate`. It runs before any new version starts, while the old version keeps serving, so migrations must stay compatible with the serving version. The module sets its `restartIfChanged` to false, so a host switch never runs it, and each release restarts it.
- Private images need `registryAuthFile` and `serviceDependencies` set to the private auth file and its login unit; see [Private registry access](bootstrap.md#private-registry-access).
- Put the unit's `refreshUnit` in the `restartUnits` of every SOPS secret its apps read. Restarting it refreshes apps at their current digests, blue-green apps without downtime, subject to the draining-worker exception below.
- One repository that drives several units gives each unit its own key. sshd applies the first matching forced command, so one key reaches exactly one unit.

A host deployment that changes a unit's definition, such as environment or volumes, reconciles that unit during activation: each changed app is refreshed at its current digest, blue-green apps without downtime, subject to the same draining-worker exception. Every unit also reconciles at boot. The reconcile fails the activation, and deploy-rs rolls the host back, only when an app whose definition it changes or first applies does not become healthy. It also starts every other app whose active slot is stopped, and moves every running blue-green app whose active slot fails its health check to its idle slot at its current digest. It probes all these blue-green apps together and waits for their new slots together, so its health waits do not add up across unhealthy apps; an app whose new slot fails keeps its old slot without holding back the others. It does not probe or restart a running recreate app whose definition is unchanged, because that restart runs `preStopCommand`, which has no time limit: `app-release check` reports such an app when it fails its health check, and `app-release refresh <unit>` restarts it. When an app the reconcile starts or moves stays down, the reconcile warns and succeeds: the app was down before the deployment, and failing would also fail the rollback and every later deployment of the host until someone repairs it. Because a switch fails while any unit is failed or restarting after a failure, the reconcile stops each unit it failed to start for such an app, waits for that stop, and resets the unit's failure, so the unit ends inactive.

`app-release check [<unit>]` changes nothing. It waits up to each app's health timeout for its active slot to pass the health check, and exits 1 naming every app that does not. Host deployments run it after activation; see [Install and convergence](bootstrap.md#install-and-convergence).

Both refresh and reconcile skip a portless worker while its idle slot is still active or deactivating, warn, and preserve its old `definitionHash`. Success can therefore leave old configuration or secret values running. After the drain finishes, a later reconcile or release applies a deferred definition change. For a deferred secret-only refresh, explicitly rerun `app-release refresh <unit>` and verify that the worker restarted with the new secret before revoking the old credential: secret contents do not change `definitionHash`.

## Release workflow

The app repository receives the action at [`.github/actions/app-release`](../../../../.github/actions/app-release/action.yml) through standards sync. Its header states the job permissions, the per-unit concurrency group, and the actionlint exception the `queue` key needs. Inputs:

- `unit`, `host`, and `known-host`, a single `known_hosts` line for the host.
- `images`: one `<app>@sha256:<digest>` line for every app of the unit, including apps whose image did not change.
- `age-key` decrypts `secrets/ci.yaml`. `ssh-key-path` names the unit's private key there and defaults to `ci.app_release.ssh_private_key`.
- `command`: `release` (default), `rollback`, or `status`.
- `tag-production` (default `true`), `registry-token` (default `github.token`), and `audience` (default `app-release`, which must match the host's `oidc.audience`).

The action authenticates with the job's GitHub OIDC token. The host accepts a release only from the unit's repository and ref, on `push` or `workflow_dispatch`, and only when each image's `org.opencontainers.image.revision` label equals the token's commit. Outputs are `result`, `apps-json`, and `live-images`.

A push to main runs three jobs in the publish workflow:

1. `gate` polls the standards workflow for the exact `github.sha` with `event=push` and requires its `check` job to succeed.
2. `build` runs in parallel with `gate`. It pushes the image under a commit tag with `provenance: false` and the label `org.opencontainers.image.revision=${{ github.sha }}`, and outputs the digest. Cache layers as the [CI pipelines skill](../../ci-pipelines/SKILL.md#caches) requires.
3. `release` needs both, runs only when `needs.gate.outputs.gated-sha == github.sha`, checks out `github.sha` without persisted credentials, and calls the action.

The host reports `superseded` and changes nothing when a run is older than the newest one it has released, so a late run for an older commit cannot move production back. After `released`, `unchanged`, or `rolled-back`, the action points `<repository>:production` at each live digest; the action can only move tags on `ghcr.io`.

## Rollback and status

A `Roll back` workflow runs on `workflow_dispatch` from main, in the same concurrency group, with `command: rollback`. It switches every app of the unit to its previous digest without migrations or revision checks, and pulls the previous image again if it is gone. Running it again returns to the newer version. The database stays migrated, so the previous version must still work with the current schema; otherwise fix forward. If a rollback succeeds but moving `:production` fails, do not re-run it, because that switches back; point each tag at its `live-images` entry instead. The rollback job and the `release` job also require `github.repository == '<owner>/<repo>' && github.ref == 'refs/heads/main'` in their job-level `if`, so a fork provisioned with the age key never contacts the host.

`command: status` reports the live digests, previous digests, and slots. On the host, `app-release status [<unit>]` prints the same state.

## Exit codes

| Code | Meaning | Response |
| --- | --- | --- |
| 0 | Released, unchanged, superseded, rolled back, or status | None |
| 1 | Failed; the previous version is serving | Fix the cause and release again |
| 2 | Rejected: authorization, validation, or syntax | Check the repository, ref, event, SSH key, and revision label |
| 3 | Failed, and the previous version could not be restored | Production may be down; inspect the host now |
| 4 | Another operation held the unit lock past the 30-minute wait | Nothing changed; re-run once it finishes |
| 255 | SSH connection failed | An operation that already started continues; check status |

The last output line is `APP_RELEASE_RESULT` followed by a JSON report of the live apps.

## First release

A unit, or an app added to an existing unit, has no release state on the host. The first reconcile bootstraps it from `<imageRepository>:production` and fails the activation when that tag is missing. Before merging the host change, point `:production` at the digest that is live today, or for a new app at an image built from a gated main commit. Moving an app that already runs onto app-release restarts it once. The switch also stops container units it removes, such as an app's single unit when the app becomes blue-green, so that app is down until the reconcile has pulled its image and started it. Merge the app repository's release workflow after the host change is deployed.
