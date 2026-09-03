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

Give every temporary resource in the trusted deploy job its own path. Create secret files with `mktemp` and artifact extraction directories with `mktemp -d`, using distinct templates for each resource. A fixed basename shared by an SSH key and an artifact directory turns the key file into a guaranteed deployment failure when the artifact step calls `mkdir`. Keep a contract test that reads the SSH helper and deploy workflow together and rejects reused temp paths.

## Host-side forced command

The only mutation channel is an SSH key restricted to a single command in root's `authorized_keys`:

```
command="/run/current-system/sw/bin/<repo>-pr-preview-deploy",restrict ssh-ed25519 ...
```

The command reads `SSH_ORIGINAL_COMMAND` with the contract `deploy <pr-number> <app-image> <migration-image> <head-sha>` or `destroy <pr-number>`, and rejects everything else: multi-line input, extra arguments, PR numbers outside `1..999999`, non-40-hex SHAs, and any image reference that is not `<allowed-name>@sha256:<64-hex>`. Package it with `pkgs.writeShellApplication` in a preview-deploy module that also asserts the previews module is enabled and at least one authorized key is present.

The command's package is also its retention boundary. Every store path that the generated command reads after deployment, including the flake source, image manifest, validator, and any other runtime file, must be in that command's own closure. Preserve Nix string context when embedding paths: pass interpolated paths to `pkgs.replaceVars`, `pkgs.writeText`, or the package's `text`, and never convert a path with `toString` before embedding it. `system.extraDependencies` is not a substitute; it can retain a different realization from the path named inside the command. Add a flake check that extracts the store paths named by the generated command, including sourced helper packages, and asserts that each path appears in its closure.

Deploy semantics: take the lock, read the current production image (from the running container, falling back to the recorded deploy state) so the rebuild never moves production, upsert the preview into the state file, `switch`, run migrations, restart the preview container. If any step fails, remove the preview from state, converge again, and drop its database — a failed deploy leaves nothing behind. Destroy is idempotent: a PR number not in state returns success.

Migrations run as a one-shot container as the preview's own UID against the preview's own database over the host Postgres socket, with `--network=none`, dropped capabilities, and resource caps.

## Preview isolation

Each active preview materializes, from the modules, as:

- a dedicated system user and group at a reserved UID/GID range (e.g. base 200000 + index), the container running `--user` as that identity with `--cap-drop=ALL`, `--security-opt=no-new-privileges`, CPU/memory/pids caps, and a tmpfs `/tmp`
- its own Postgres database `<app>_pr_<number>` with peer auth mapped only to that system user (the bootstrap Postgres module's `databaseSystemUsers` seam exists for exactly this)
- its own internal Podman network with a non-overlapping host-reachable subnet and deterministic container address, so previews cannot reach each other or the internet
- a Caddy virtual host `<pr>.pr.<domain>` that reverse-proxies the container address directly and sends `X-Robots-Tag: noindex, nofollow, noarchive`; do not publish a host port because rootful Podman's internal bridge disables the forwarding that published ports require
- a host firewall rule that rejects connections initiated from the reserved preview subnet range, including their later packets, before any host-service allow rule; this closes the bridge-gateway path to Caddy and other host listeners while allowing replies to host-originated Caddy and readiness traffic

Assert the invariants in the module: unique bounded PR numbers, digest-pinned images matching the allowed name, and enough addresses in the host-reserved subnet range.

The image is part of the isolation contract. The dedicated preview UID overrides the image's declared user, so every non-secret runtime file and parent directory must be readable and traversable by an arbitrary unprivileged identity. Run the preview image's smoke test with `--user=<base-uid>:<base-gid>` and the same read-only root, tmpfs mounts, capabilities, and security options used by the host. A smoke test that runs as the image's default user does not validate the deployed shape.

If Caddy's admin API is disabled with `admin off`, also set NixOS `services.caddy.enableReload = false`. The generated reload command calls that API and makes an otherwise healthy host activation fail. Configuration changes then restart Caddy, so record the brief interruption in the host profile.

## Lifecycle

Teardown is event-complete; every path that ends a preview's usefulness destroys it:

- PR closed or merged, `pr-preview` label removed, or PR converted to draft (`pull_request_target` with a trusted default-branch checkout and a same-repository guard) → destroy.
- Build failed, cancelled, or timed out → destroy, so a stale preview never outlives a broken head. A *skipped* build must not trigger this — skipped means no preview was requested, and destroying on `conclusion != 'success'` would fire on every unlabeled PR.
- Post-deploy verification (`curl --retry` against the public URL) failed → the deploy destroys its own preview and reports failure rather than leaving a half-alive environment behind.

Every successful deploy upserts a single PR comment with the preview URL and state. A failed deploy reports its failure state and source without claiming a live URL. A destroy updates that comment when it exists but does not create one. Idempotent cleanup for a PR that never requested a preview is not preview activity and stays silent; the workflow run still reports cleanup failures. A daily host timer prunes unused preview images (`podman image prune --filter until=168h`).

## DNS

One wildcard record `*.pr.<domain>` pointing at the host, managed in the tofu stack like any other record — but never proxied, because Caddy must answer ACME challenges for concrete preview hostnames to issue their certificates.

## Traps

- The host-side rebuild evaluates the flake from the deployed system. A path converted with `toString` can disappear after `nix gc` even when `system.extraDependencies` retains a different source path; keep the command's own closure complete instead.
- An image that starts as its declared user can still fail immediately under the host's dedicated preview UID. Exercise the exact UID override in the build workflow.
- A port published from a rootful Podman `--internal` bridge is not a host ingress path. Give each preview a deterministic address on its internal bridge and route host Caddy and readiness probes to that address directly; do not restore forwarding or outbound access to make port publication work.
- Separate internal bridges do not stop a preview from reaching services bound to its host-side gateway. Reject connections initiated from the whole reserved preview source range before host-service allow rules, or a preview can send another preview's hostname to host Caddy and use it as a cross-network proxy. Keep reply-direction packets allowed so host-originated readiness and proxy traffic can return.
- Caddy cannot reload through an admin API configured as `off`; disable reload-on-change or keep the API available.
- `workflow_run.pull_requests` can be empty depending on event provenance; guard teardown jobs on the PR number being present instead of assuming `[0]` exists.
- The deploy workflow must check out the *default branch*, never the triggering head — `workflow_run` runs with secrets, and the artifact is the only thing taken from the untrusted build.
