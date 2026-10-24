# App releases

A first-party app releases from its own repository straight onto its host. The host repo declares the app as an app-release unit. The app repo's main-branch workflow builds the image and calls the synced action, which asks the host over SSH to run that digest. The host verifies the request, starts the new version beside the old one, switches traffic, and records the live digests in `/var/lib/app-release/<unit>/state.json`. A release never changes the host repo or triggers a NixOS deployment, so never pin a first-party app digest in the host repo.

## Host module

[`module.nix`](https://github.com/davidvornholt/standards/blob/main/nix/app-release/module.nix) documents every option and asserts valid combinations. The host CLI lives beside it in [`nix/app-release`](https://github.com/davidvornholt/standards/tree/main/nix/app-release), and `app-release help` lists its commands and exit codes.

- Import it as `inputs.standards.nixosModules.app-release`, with `standards` pinned to a commit and its `nixpkgs` following the host's. It is the one module hosts import instead of copying, because its tests and VM check live with it.
- A unit is the set of apps one repository releases together through one SSH key. A repository with several units gives each its own key, because sshd applies the first matching forced command.
- Route Caddy through the app's `caddyUpstream`, never to a slot port.
- Keep the default `blue-green` strategy. Use `recreate` only when two versions cannot run side by side, such as a container that other containers address by a stable name.
- A worker without ports stays blue-green, with a `health.command`. Give a worker with long drains `retireWithoutWaiting` and its own unit, so its drain does not hold the lock for other apps.
- An app must exit 0 or 143 after SIGTERM. Any other status leaves its retired slot failed.
- The migration runs before any new version starts, while the old one keeps serving, so migrations must stay compatible with the serving version. Each release runs it, and a host switch never does.
- For private images, wire the unit as [Private registry access](bootstrap.md#private-registry-access) describes.
- Add the unit's `refreshUnit` to the `restartUnits` of every SOPS secret its apps read, so a rotation restarts them at their current digests.

### Host deployments

- A host deployment that changes a unit's definition, such as environment or volumes, reconciles that unit during activation, and every unit reconciles at boot. Changed apps refresh at their current digests, blue-green apps without downtime.
- The reconcile fails the activation, and deploy-rs rolls the host back, only when an app whose definition it changes or first applies does not become healthy.
- It also starts apps whose active slot is stopped and moves running blue-green apps whose active slot is unhealthy to their idle slot. If such an app stays down, it warns and succeeds: the app was down before the deployment, and failing would also fail the rollback and every later deployment of the host.
- It does not probe or restart a running recreate app whose definition is unchanged, because that restart runs `preStopCommand`, which has no time limit. `app-release check` reports such an app, and `app-release refresh <unit>` restarts it. Host deployments run `check` after activation, as [Install and convergence](bootstrap.md#install-and-convergence) describes.
- A switch fails when a `retireWithoutWaiting` worker's drain ends failed before the switch checks its units. The next switch resets the failed unit.
- Refresh and reconcile skip a portless worker whose idle slot is still active or deactivating, warn, and keep its old definition running. A later reconcile or release applies a deferred definition change, but secret contents do not change the definition: after the drain, rerun `app-release refresh <unit>` and verify the worker restarted with the new secret before revoking the old credential.

## Release workflow

The synced [action](../../../../.github/actions/app-release/action.yml) describes its inputs and outputs. Its header states the job permissions, the per-unit concurrency group, and the actionlint exception the `queue` key needs.

- The host accepts a release only from the unit's repository and ref, on `push` or `workflow_dispatch`, and only when each image's `org.opencontainers.image.revision` label equals the OIDC token's commit.
- A push to main runs three jobs in the publish workflow:
  1. `gate` polls the standards workflow for the exact `github.sha` with `event=push` and requires its `check` job to succeed.
  2. `build` runs in parallel with `gate`. It pushes the image under a commit tag with `provenance: false` and the label `org.opencontainers.image.revision=${{ github.sha }}`, and outputs the digest. Cache layers as the [CI pipelines skill](../../ci-pipelines/SKILL.md#caches) requires.
  3. `release` needs both, runs only when `needs.gate.outputs.gated-sha == github.sha`, checks out `github.sha` without persisted credentials, and calls the action with every app of the unit in `images`, including unchanged ones.
- The host reports `superseded` and changes nothing for a run older than the newest one it released, so a late run cannot move production back.
- After `released`, `unchanged`, or `rolled-back`, the action points `<repository>:production` at each live digest. It can move tags only on `ghcr.io`.
- The `release` and rollback jobs both require `github.repository == '<owner>/<repo>' && github.ref == 'refs/heads/main'` in their job-level `if`, so a fork provisioned with the age key never contacts the host.

## Rollback

- A `Roll back` workflow runs on `workflow_dispatch` from main, in the same concurrency group, with `command: rollback`. It switches every app of the unit to its previous digest without migrations or revision checks, pulling the previous image again if it is gone. Running it again returns to the newer version.
- The database stays migrated, so the previous version must still work with the current schema. Otherwise fix forward.
- If a rollback succeeds but moving `:production` fails, do not re-run it, because that switches back. Point each tag at its `live-images` entry instead.

## Failures

- Exit code 3 means the previous version could not be restored, so production may be down. Inspect the host at once.
- Exit code 255 is an SSH failure. An operation that already started continues on the host, so check `command: status` before retrying.

## First release

- A new unit, or an app added to a unit, has no release state. The first reconcile bootstraps it from `<imageRepository>:production` and fails the activation when that tag is missing.
- Before merging the host change, point `:production` at the digest that is live today, or for a new app at an image built from a gated main commit.
- Moving a running app onto app-release restarts it once. The switch stops container units it removes, such as the app's single unit when it becomes blue-green, so the app is down until the reconcile has pulled its image and started it.
- Merge the app repo's release workflow after the host change is deployed.
