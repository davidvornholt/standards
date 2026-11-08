# Pull request previews

A same-repository PR labeled `pr-preview` gets `https://<pr>.pr.<domain>` with its own container, database, and virtual host, built from the production flake and modules and destroyed when the PR closes.

## Convergence model

- Previews are the one exception to keeping desired state in git. Their only runtime state is the active preview set in host-local `/var/lib/<repo>/pr-previews/active.json`, a JSON array of `{ number, image, headSha, updatedAt }`. Only the forced SSH command changes it, under an exclusive `flock`, and then runs `nixos-rebuild switch` on the production flake. Each switch replays the whole set, so an interrupted deploy heals on the next one.
- The flake reads the file path from an environment variable with `builtins.getEnv`, defaults to an empty set, and passes the set through `specialArgs`. `nix flake check` therefore sees no previews. The host rebuild sets the variable and runs with `--impure`.

## Workflows

- Build (`pull_request`) runs only for same-repository, non-draft, labeled PRs against the default branch, with only `contents: read` and no secrets or registry access. It builds the app image and any migration image as archives, smoke-tests them by running the migrations twice against a scratch database, because every redeploy runs them again, and waiting for the container's health check, and uploads them with metadata JSON (repo, PR number, head SHA, image names and tags). It doesn't run the quality gate, which would delay the preview by minutes. A preview may therefore run code that fails the gate, which is acceptable because it holds only [sample data and its own sign-in](#sign-in-and-sample-data).
- Deploy (`workflow_run` on build success) holds secrets, so it checks out the default branch, never the head, and trusts nothing from the build but the artifact and the success of its smoke-test step. It finds the artifact by head SHA, re-validates the metadata against the expected image names, and re-checks that the PR is still open, non-draft, same-repository, labeled, and against the default branch. It refuses a head whose workflow files differ from the default branch's, because the build ran the head's copy of its workflow and the deploy relies on what that workflow did. Then it pushes the digest-pinned images and calls the forced command.
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
5. Run migrations, then the [sample-data seed](#sign-in-and-sample-data).
6. Restart the preview container.

Release state, not the flake, picks the production digest, so the rebuild never moves production.

Migrations run as a one-shot container under the preview's UID, against its own database over the host PostgreSQL socket, with `--network=none`. On any failure, remove the preview from state, converge again, and drop its database. Destroy is idempotent: an unknown PR number succeeds.

## Isolation

Each preview gets, from the modules:

- A system user and group in a reserved UID/GID range, such as 200000 plus index. The container runs as that identity with all capabilities dropped, `no-new-privileges`, CPU, memory, and pids caps, and a tmpfs `/tmp`.
- Its own database `<app>_pr_<number>`, peer-mapped only to that user through the PostgreSQL module's `databaseSystemUsers`.
- An internal Podman network with a non-overlapping, host-reachable subnet and a fixed container address, so previews reach neither each other nor the internet. The [sign-in proxy](#sign-in-and-sample-data) is their only way out.
- A Caddy virtual host `<pr>.pr.<domain>` that proxies the container address directly and sends `X-Robots-Tag: noindex, nofollow, noarchive`. Never publish a host port: rootful Podman's internal bridge disables the forwarding it needs. Never restore forwarding or outbound access to make one work.
- A firewall rule, before any host-service allow rule, that rejects connections initiated from the whole reserved preview range, including their later packets, except those to the sign-in proxy. Without it, a preview can reach host listeners on its gateway and use host Caddy to reach another preview. Allow reply packets so host-originated Caddy and readiness traffic returns.

Also:

- The preview UID overrides the image's user, so every non-secret runtime file and its directories must be readable and traversable by any unprivileged UID. In the build workflow, smoke-test the image with `--user=<base-uid>:<base-gid>` and the host's read-only root, tmpfs mounts, capabilities, and security options.
- With Caddy's admin API `off`, set `services.caddy.enableReload = false`, or the reload fails an otherwise healthy activation. Changes then restart Caddy, which is the interruption [Deploy downtime](bootstrap.md#deploy-downtime) accepts.

## Sign-in and sample data

A preview of an app with sign-in gets working sign-in and starts with sample data, so a reviewer can see the signed-in app. Don't add a preview-only auth bypass to the app instead.

- Sign-in goes through a preview-only OAuth app that the host's previews share. Register `https://pr.<domain>/<callback path>` for each app and turn on wildcard matching for each of these callback URLs in the OAuth app's settings. Without it, GitHub rejects the callback from `<pr>.pr.<domain>`. Keep the client ID in Nix and the secret in the host's SOPS file, rendered root-only into an env file that Podman reads before it drops to the preview UID. Never give a preview production's OAuth credentials, and assert that the preview client ID matches no production container's. Keep the app's allowed-account restriction.
- The preview's server finishes sign-in by calling the provider, for GitHub at `github.com` and `api.github.com`. Run a forward proxy on the host that accepts connections only from preview networks and allows only `CONNECT` to port 443 of those hosts, and point each preview's `HTTPS_PROXY` at it on the preview's gateway. Check that the server honors `HTTPS_PROXY`: Bun's `fetch` does, and Node's needs `NODE_USE_ENV_PROXY=1`.
- The app ships a `db:seed:preview` package script in its image. It inserts synthetic sample data into a database without app data and changes nothing otherwise, so a redeploy keeps what a reviewer changed. Bun resolves it from the image's working directory, so it belongs in the `package.json` there.
- After migrations succeed, run `bun run --if-present db:seed:preview` with the migration container's identity and constraints. `--if-present` lets a branch that predates the script deploy with an empty database, because the app and infra changes land in either order and a missing preview blocks review more than an empty one. A script that exists and fails still fails the deploy. Never run the seed outside previews.

## Lifecycle

Destroy the preview when:

- The PR is closed or merged, loses the label, or becomes a draft. Use `pull_request_target` with a trusted default-branch checkout and a same-repository guard.
- The build fails, is cancelled, or times out. Not when it is skipped: that means no preview was requested, and a `conclusion != 'success'` guard would fire on every unlabeled PR.
- Post-deploy `curl --retry` against the public URL fails. The deploy then reports failure.

A successful deploy upserts one PR comment with the URL and state. A failed deploy reports its failure and source without a live URL. A destroy updates an existing comment but never creates one, so cleanup for a PR that never requested a preview posts nothing. The workflow run still reports cleanup failures.

## DNS

A wildcard `*.pr.<domain>` record in the tofu stack points at the host. Never proxy it: Caddy must answer ACME challenges for each preview hostname.
