# Pull request previews

A same-repository PR labeled `pr-preview` gets `https://<pr>.pr.<domain>` with its own container, database, and virtual host, built from the production flake and modules and destroyed when the PR closes.

## Convergence model

- Previews are the one exception to keeping desired state in git. Their only runtime state is the active preview set in host-local `/var/lib/<repo>/pr-previews/active.json`, a JSON array of `{ number, image, headSha, updatedAt }`. Only the forced SSH command changes it, under an exclusive `flock`, and then runs `nixos-rebuild switch` on the production flake. Each switch replays the whole set, so an interrupted deploy heals on the next one.
- The flake reads the file path from an environment variable with `builtins.getEnv`, defaults to an empty set, and passes the set through `specialArgs`. `nix flake check` therefore sees no previews. The host rebuild sets the variable and runs with `--impure`.

## Workflows

- Build (`pull_request`) runs only for same-repository, non-draft, labeled PRs, with only `contents: read` and no secrets or registry access. It runs the full quality gate on the head, builds the app image and any migration image as archives, and uploads them with metadata JSON (repo, PR number, head SHA, image names and tags).
- Deploy (`workflow_run` on build success) holds secrets, so it checks out the default branch, never the head, and trusts nothing from the build but the artifact. It finds the artifact by head SHA, re-validates the metadata against the expected image names, and re-checks that the PR is still open, non-draft, same-repository, and labeled. Then it pushes the digest-pinned images and calls the forced command.
- `workflow_run.pull_requests` can be empty, so require a PR number instead of assuming `[0]` exists.
- Deploy secrets live in a `pr-preview` GitHub Environment whose SOPS file holds only the preview deploy SSH key, under an age key distinct from production's.
- Preview and production deploy jobs share the concurrency group `<repo>-<host>-deploy` with `cancel-in-progress: false`. The host lock covers only preview calls, so this group is what keeps their switches from interleaving.
- Create each secret file with `mktemp` and each artifact directory with `mktemp -d`, using distinct templates, because a shared fixed basename makes the artifact `mkdir` collide with the SSH key file. Keep a contract test over the SSH helper and deploy workflow that rejects reused temp paths.

## Transfer artifacts

- Preview archives share the Actions artifact quota with production, so stale ones can block production publication. Size the archive limit for the expected concurrent transfers, because a per-archive limit does not bound the total.
- Trusted default-branch control deletes archives of closed PRs and superseded heads, and deletes a consumed archive after public verification succeeds. The PR build never gets deletion rights.
- Unconsumed archives expire after about one day, as a fallback for interrupted cleanup.

## Forced command

The only mutation channel is a key in root's `authorized_keys`:

```
command="/run/current-system/sw/bin/<repo>-pr-preview-deploy",restrict ssh-ed25519 ...
```

- `SSH_ORIGINAL_COMMAND` is exactly `deploy <pr-number> <app-image> <migration-image> <head-sha>` or `destroy <pr-number>`, with PR numbers in `1..999999`, 40-hex SHAs, and images of the form `<allowed-name>@sha256:<64-hex>`. Reject anything else.
- Package it with `pkgs.writeShellApplication` in a module that asserts previews are enabled and at least one key is authorized.
- The rebuild evaluates the flake from the deployed system, so every store path the command reads later, such as the flake source, image manifest, and validator, must be in the command's own closure. Embed paths with their string context through `pkgs.replaceVars`, `pkgs.writeText`, or the package's `text`. Never `toString` a path first, or `nix gc` can delete it. `system.extraDependencies` is no substitute, because it can keep a different realization than the one the command names.
- Add a flake check that every store path the command names, including sourced helper packages, is in its closure.

A deploy runs these steps in order:

1. Take the lock.
2. Verify that production's active slot tag names the exact digest in its [app-release](app-release.md) state, and that the running image is that image or content-equivalent under [app-release's comparison](https://github.com/davidvornholt/standards/blob/main/nix/app-release/src/app_release/podman.py).
3. Upsert the preview.
4. Run `switch`.
5. Run migrations.
6. Restart the preview container.

Release state, not the flake, picks the production digest, so the rebuild never moves production.

Migrations run as a one-shot container under the preview's UID, against its own database over the host PostgreSQL socket, with `--network=none`. On any failure, remove the preview from state, converge again, and drop its database. Destroy is idempotent: an unknown PR number succeeds.

## Isolation

Each preview gets, from the modules:

- A system user and group in a reserved UID/GID range, such as 200000 plus index. The container runs as that identity with all capabilities dropped, `no-new-privileges`, CPU, memory, and pids caps, and a tmpfs `/tmp`.
- Its own database `<app>_pr_<number>`, peer-mapped only to that user through the PostgreSQL module's `databaseSystemUsers`.
- An internal Podman network with a non-overlapping, host-reachable subnet and a fixed container address, so previews reach neither each other nor the internet.
- A Caddy virtual host `<pr>.pr.<domain>` that proxies the container address directly and sends `X-Robots-Tag: noindex, nofollow, noarchive`. Never publish a host port: rootful Podman's internal bridge disables the forwarding it needs. Never restore forwarding or outbound access to make one work.
- A firewall rule, before any host-service allow rule, that rejects connections initiated from the whole reserved preview range, including their later packets. Without it, a preview can reach host listeners on its gateway and use host Caddy to reach another preview. Allow reply packets so host-originated Caddy and readiness traffic returns.

Also:

- The preview UID overrides the image's user, so every non-secret runtime file and its directories must be readable and traversable by any unprivileged UID. In the build workflow, smoke-test the image with `--user=<base-uid>:<base-gid>` and the host's read-only root, tmpfs mounts, capabilities, and security options.
- With Caddy's admin API `off`, set `services.caddy.enableReload = false`, or the reload fails an otherwise healthy activation. Changes then restart Caddy, which is the interruption [Deploy downtime](bootstrap.md#deploy-downtime) accepts.

## Lifecycle

Destroy the preview when:

- The PR is closed or merged, loses the label, or becomes a draft. Use `pull_request_target` with a trusted default-branch checkout and a same-repository guard.
- The build fails, is cancelled, or times out. Not when it is skipped: that means no preview was requested, and a `conclusion != 'success'` guard would fire on every unlabeled PR.
- Post-deploy `curl --retry` against the public URL fails. The deploy then reports failure.

A successful deploy upserts one PR comment with the URL and state. A failed deploy reports its failure and source without a live URL. A destroy updates an existing comment but never creates one, so cleanup for a PR that never requested a preview posts nothing. The workflow run still reports cleanup failures.

## DNS

A wildcard `*.pr.<domain>` record in the tofu stack points at the host. Never proxy it: Caddy must answer ACME challenges for each preview hostname.
