# Pull request previews

Per-PR preview environments are part of the standard adoption, not an optional extra: a host that serves a web app gets them by default, and their absence is a documented decision in the host repo. A same-repository pull request labeled `pr-preview` gets a public environment at `https://<pr>.pr.<domain>` — its own container, database, and virtual host — converged through the same flake and modules as production, and torn down automatically when the PR closes.

Reuse is copying: instantiate this pattern in the host's home repo and adapt names. Improvements to the pattern belong upstream in this skill.

## Convergence model

Previews are the sanctioned exception to "all desired state lives in git." The active preview set is ephemeral and PR-scoped, so it lives in a host-local desired-state file (`/var/lib/<repo>/pr-previews/active.json`), mutated only by a validated forced SSH command that then converges the host by running `nixos-rebuild switch` against the same flake that defines production. Everything about how a preview is *shaped* stays declarative in the modules; only the list of active previews is runtime state. Because convergence replays the whole desired set, an interrupted deploy self-heals on the next invocation.

The state file is a JSON array of `{ number, image, headSha, updatedAt }`. Treat it as untrusted on every read: validate the full schema (positive bounded PR numbers, unique, digest-pinned image refs matching the allowed image name) before use, write it atomically (temp file, validate, rename), and serialize all mutations with an exclusive `flock`.

The active-preview state enters the flake the same way as image digests (see bootstrap: build-time parameters via environment with safe fallbacks), so plain `nix flake check` evaluates with an empty preview set; the host-side rebuild passes the state file path and runs with `--impure`.

## Trust boundaries

Two workflows, split so untrusted PR code never runs with secrets:

- **Build** (`pull_request`): runs only for same-repository, non-draft PRs carrying the `pr-preview` label. Checks out the PR head, runs the full quality gate, builds the app image (and migration image, if the app has one) as archives, and uploads them plus a metadata JSON (repo, PR number, head SHA, image names and tags) as a workflow artifact. No secrets, no registry access, `contents: read` only.
- **Deploy** (`workflow_run` on the build workflow, gated on success): checks out trusted code from the default branch, resolves the artifact by head SHA via the API, re-validates the metadata against expected image names, and re-checks that the PR is still open, non-draft, same-repository, and labeled — the label may have been removed since the build started. Only then does it push the digest-pinned images to the registry and invoke the host's forced command with the digests.

Deploy secrets live in a dedicated GitHub Environment (`pr-preview`) whose SOPS file contains exactly one secret: the preview deploy SSH private key. It never holds production deploy keys or cloud credentials, and its age key is distinct from the production deploy environment's. The preview deploy job and the production deploy job share one Actions concurrency group (`<repo>-<host>-deploy`, `cancel-in-progress: false`) so their `switch` operations never interleave — this serialization is a load-bearing invariant, since the host-side lock only covers preview invocations.

## Host-side forced command

The only mutation channel is an SSH key restricted to a single command in root's `authorized_keys`:

```
command="/run/current-system/sw/bin/<repo>-pr-preview-deploy",restrict ssh-ed25519 ...
```

The command reads `SSH_ORIGINAL_COMMAND` with the contract `deploy <pr-number> <app-image> <migration-image> <head-sha>` or `destroy <pr-number>`, and rejects everything else: multi-line input, extra arguments, PR numbers outside `1..999999`, non-40-hex SHAs, and any image reference that is not `<allowed-name>@sha256:<64-hex>`. Package it with `pkgs.writeShellApplication` in a preview-deploy module that also asserts the previews module is enabled and at least one authorized key is present.

Deploy semantics: take the lock, read the current production image (from the running container, falling back to the recorded deploy state) so the rebuild never moves production, upsert the preview into the state file, `switch`, run migrations, restart the preview container. If any step fails, remove the preview from state, converge again, and drop its database — a failed deploy leaves nothing behind. Destroy is idempotent: a PR number not in state returns success.

Migrations run as a one-shot container as the preview's own UID against the preview's own database over the host Postgres socket, with `--network=none`, dropped capabilities, and resource caps.

## Preview isolation

Each active preview materializes, from the modules, as:

- a dedicated system user and group at a reserved UID/GID range (e.g. base 200000 + index), the container running `--user` as that identity with `--cap-drop=ALL`, `--security-opt=no-new-privileges`, CPU/memory/pids caps, and a tmpfs `/tmp`
- its own Postgres database `<app>_pr_<number>` with peer auth mapped only to that system user (the bootstrap Postgres module's `databaseSystemUsers` seam exists for exactly this)
- its own internal Podman network, so previews cannot reach each other
- a loopback port assigned deterministically (`basePort` + index over the sorted preview set) and a Caddy virtual host `<pr>.pr.<domain>` that reverse-proxies it and sends `X-Robots-Tag: noindex, nofollow, noarchive`

Assert the invariants in the module: unique bounded PR numbers, digest-pinned images matching the allowed name, and enough port room above `basePort`.

## Lifecycle

Teardown is event-complete; every path that ends a preview's usefulness destroys it:

- PR closed or merged, `pr-preview` label removed, or PR converted to draft (`pull_request_target` with a trusted default-branch checkout and a same-repository guard) → destroy.
- Build failed, cancelled, or timed out → destroy, so a stale preview never outlives a broken head. A *skipped* build must not trigger this — skipped means no preview was requested, and destroying on `conclusion != 'success'` would fire on every unlabeled PR.
- Post-deploy verification (`curl --retry` against the public URL) failed → the deploy destroys its own preview and reports failure rather than leaving a half-alive environment behind.

Every deploy and destroy upserts a single PR comment with the preview URL and state. A daily host timer prunes unused preview images (`podman image prune --filter until=168h`).

## DNS

One wildcard record `*.pr.<domain>` pointing at the host, managed in the tofu stack like any other record — but never proxied, because Caddy must answer ACME challenges for concrete preview hostnames to issue their certificates.

## Traps

- The host-side rebuild evaluates the flake from the deployed system, so keep the flake source alive across garbage collection with `system.extraDependencies = [ ../.. ]` in the preview-deploy module; without it, `nix gc` can break the forced command until the next production deploy.
- `workflow_run.pull_requests` can be empty depending on event provenance; guard teardown jobs on the PR number being present instead of assuming `[0]` exists.
- The deploy workflow must check out the *default branch*, never the triggering head — `workflow_run` runs with secrets, and the artifact is the only thing taken from the untrusted build.
