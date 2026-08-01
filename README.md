# standards

Reusable engineering standards for TypeScript/Bun monorepos — a shared agent operating contract, agent skills, a maximally strict Biome/TypeScript/a11y configuration, and a small sync engine that keeps every consuming repo aligned with this one.

It is two things at once: the source of truth I sync into my own projects, and a public, opinionated example of how I build.

## Philosophy

Quality gates are deliberately strict so that **agents can verify their work mechanically instead of declaring it done.** Lint, types, tests, and accessibility are all wired into a single `bun run check`. If a change is wrong, the gate fails; nothing relies on an agent's self-report. The standards strengthen gates over time and never weaken one to make a change pass.

## What's inside

- **`AGENTS.md`** — the single source of truth for the agent operating contract. `CLAUDE.md` is only a pointer to it; project-specific rules live in a repo's own `AGENTS.local.md`.
- **`.agents/skills/**`** — dual-target skills that work in both Claude Code (`SKILL.md`) and Codex (`agents/openai.yaml`). `.claude/skills` is a synced symlink to that directory, so Claude Code's native skill discovery finds the same files at the only path it scans, without a second copy of them.
- **`biome.base.jsonc`** — every applicable Biome rule domain and group at `error`, with each opt-out documented inline. Repos extend it from a thin `biome.jsonc` wrapper.
- **`packages/typescript-config`, `packages/a11y-testing`** — the shared TS config and the Playwright + Axe (WCAG 2.2 AA) test harness, under a stable `@davidvornholt` scope.
- **`.github/settings.json`** — the declared GitHub repository state: squash-only merging (merge commits and rebases disabled), auto-merge, delete-branch-on-merge, squash commit shape, and the default-branch ruleset (PR required, `check` status required, linear history, no bypass). `standards github --apply` converges the live repo; `standards check` fails on drift.
- **`@davidvornholt/standards`** — the Bun-executable CLI for bootstrap, sync, drift detection, and consumer integration validation.

## File ownership

Every file is **synced** (upstream-owned, read-only in consumers — the list in `sync-standards.json`, including the root `justfile` and `secrets.just`), **repo-owned** (seeded once by `init` from `template/`, or created at a designated seam, then allowed to diverge: the `biome.jsonc` wrapper, `AGENTS.local.md`, `local.just`, `.github/dependabot.local.yml`, `.gitignore`, `.sops.yaml`, `secrets/*.example.yaml`, root scaffolding, `README.md`), or **generated** (engine-owned output that `sync` recomposes: `.github/dependabot.yml`, built from the canonical `.github/dependabot.base.yml` plus the repo-owned `.github/dependabot.local.yml`). Secret-shape examples are seeded, not synced, so each repo can extend them to mirror its own real secrets without the next sync clobbering them.

Because canonical files are read-only, every point of legitimate per-repo variation goes through a wrapper seam: `biome.jsonc` extends `biome.base.jsonc`, `AGENTS.local.md` extends `AGENTS.md`, the canonical root `justfile` imports the repo-owned `local.just` when present, `.github/dependabot.local.yml` extends `.github/dependabot.base.yml` (additively — it can add ecosystems, private registry definitions/references, and append `ignore` holds to canonical blocks, never override them), and `.github/settings.local.json` extends `.github/settings.json` (additively — it can add repository settings, rulesets, and labels but never override canonical ones; its one subtractive declaration is `"rulesetEnforcement": "unavailable-on-plan"` for repos whose GitHub plan cannot enforce rulesets, which skips the ruleset gate loudly instead of weakening any rule). Cross-repo operator workflows stay in the canonical `justfile` and `secrets.just`; repo-specific recipes and modules belong in `local.just`.

The canonical Dependabot base carries the baseline ecosystems (Bun, GitHub Actions) and the template-wide version holds — dependencies deliberately not bumped, each with the reason and lift condition in a comment (Biome is pinned because `biome.base.jsonc` is authored against an exact version; TypeScript is held while Next.js does not support newer releases). Adding or lifting a hold is one upstream change that reaches every consumer on its next sync.

## Adopt it

### New repo

Bootstrap with the published CLI — it fetches this template, seeds the repo-owned files, mirrors the canonical ones, and writes the lock:

```sh
bunx @davidvornholt/standards init
bun install
```

### Existing repo — first adoption

Install the CLI directly, then run `init` at the repo root:

```sh
bun add --dev --exact @davidvornholt/standards
bun standards init
```

**`init` preserves repo-owned files, not managed files:** any seeded or otherwise repo-owned file that already exists (your `package.json`, `biome.jsonc`, `turbo.json`, `README.md`, …) is *kept*, and only missing files are seeded. Canonical files are always mirrored in, and generated files are always recomposed from their canonical source and repo-owned seam, so both managed classes can be replaced during the intentional hard cutover. `init` is one-time: once `sync-standards.lock` exists it refuses to run again, and all updates go through `sync`. Before running it in an existing repo, move repo-specific recipes and modules out of any hand-maintained root `justfile` or `secrets.just` and into `local.just`, and move supported customizations from any hand-maintained `.github/dependabot.yml` into `.github/dependabot.local.yml`; `init` overwrites all three managed files. One thing `init` will *not* do is delete a directory of your work: if a managed path already exists as a directory holding files this repository does not manage — the `.claude/skills` link is the case you are most likely to hit — `init` and `sync` stop before writing anything and change nothing until you move or delete them. The refusal names every managed path that collides, and for each one the number of unmanaged files beneath it plus up to three of them by name. It covers directories only: a pre-existing canonical file is still overwritten by the cutover above, and it is not a general pre-flight check, so an unrelated conflict — a plain file sitting where a managed path needs a directory, say — still fails partway through a run. Then run `init` and wire the remaining extension **seams** by hand — a one-time cost that is the point of the three-class file-ownership model:

- **`biome.jsonc`** — add `"extends": ["./biome.base.jsonc"]`; move any rules you override into its `overrides` and delete ones now inherited from the base.
- **`CLAUDE.md`** — replace its contents with the single line `@AGENTS.md`. It is canonical and synced, so it must match byte-for-byte.
- **`AGENTS.md`** — now canonical and synced; move anything repo-specific into `AGENTS.local.md`, which `AGENTS.md` includes.
- **`justfile` and `secrets.just`** — now canonical and synced; before `init` overwrites them, move repo-specific recipes and imported modules into `local.just`, which the canonical root `justfile` imports when present. Cross-repo secrets management and derived dev env recipes remain in the canonical files.
- **`package.json`** — declare `@davidvornholt/standards` directly and make `check` and `check:fix` run `standards check` first.
- **`.github/dependabot.yml`** — now generated: `init` and every later `sync` compose it from the canonical `.github/dependabot.base.yml` and your repo-owned `.github/dependabot.local.yml`. Before the first of those commands, move supported customizations from a previously hand-maintained `dependabot.yml` into the local seam — repo-specific ecosystems such as Nix or OpenTofu as new update blocks, private registries as top-level definitions plus per-update references, and repo-local version holds by repeating a canonical block's target with only `ignore` and/or `registries`. The seam deliberately rejects unrelated additions to matching canonical blocks, including labels, groups, cooldowns, and pull-request limits. `bun standards dependabot --write` also overwrites the generated file.
- **`.claude/skills`** — a managed *symlink* to `.agents/skills`, not a directory: keep your own skills at `.agents/skills/<name>/`, where they sit beside the canonical ones, stay out of the lock, and still reach Claude Code through the link. Move any existing `.claude/skills/<name>/` there before `init` or `sync`, either of which otherwise refuses to run rather than deleting it — including on a repo that already has the link. On Windows the checkout must set `core.symlinks=true` (Developer Mode or an elevated shell) or you must work in WSL: git otherwise writes a plain text file where the link belongs, which `check` reports as drift on every run and `sync` cannot repair, leaving the gate permanently red.
- **`.sops.yaml`** — keep your real age recipients; only the `secrets/*.example.yaml` *shapes* are canonical.
- **CI** — the synced `.github/workflows/standards.yml` is your quality gate. If the repo already ran its own gate, drop that duplication and keep only what the canonical gate does not (deploy, infra). If your tests need a specific database, set the repo Actions variables `CI_POSTGRES_USER` / `CI_POSTGRES_PASSWORD` / `CI_POSTGRES_DB`. Across the entire canonical workflow set, `CI_RUNNER` optionally overrides only the unprivileged `standards.yml` quality job; every supporting, secret-bearing, and required-verdict job uses a fresh GitHub-hosted runner so persistence from PR-controlled code cannot cross workflow or job boundaries. To get a phone push when an agent review cycle pauses on a question (the synced `Notify pause` workflow, triggered by the `needs-clarification` label), set `ci.ntfy_topic_url` in your SOPS-encrypted `secrets/ci.yaml` to a full [ntfy](https://ntfy.sh) topic URL with a random unguessable topic name — the topic name is the only access control — and configure the `SOPS_AGE_KEY` Actions secret so CI can decrypt it; that key is the single bootstrap secret for all CI secrets.

- **`sync-standards.lock`** — commit it. It is the baseline `check` compares against in CI; if it is untracked, a fresh CI clone has nothing to check and the drift gate is silently inert.
- **GitHub settings** — create `.github/settings.local.json` (seeded on new repos; `{"repository":{},"rulesets":[]}` when you have nothing to add) and run `bun standards github --apply` once with admin `gh` auth. It converges the live repo onto squash-only merging at both the repository and default-branch ruleset layers, plus the remaining declared settings and labels — including deleting hand-made rulesets that are not declared; extra live labels remain untouched. From then on `check` fails whenever merge commits, rebases, or any other declared live state drifts. If the repo is private on a GitHub plan that cannot enforce rulesets (Free, personal or organization), declare `"rulesetEnforcement": "unavailable-on-plan"` in the seam: the gate then skips rulesets and the plan-gated `allow_auto_merge` setting (GitHub accepts a PATCH for it with HTTP 200 and silently keeps it off), converges the remaining merge settings and labels, and prints an unprotected-branch notice on every run instead of failing forever or trusting state GitHub silently does not honor. CI needs no credential of its own for this: the `check` aggregator job runs the settings comparison with the workflow token, granted read-only "Contents" and "Issues", where Issues permits repository label reads. A probe against a private repository compared that grant set against a broker App installation token across every read the gate performs and the answers were identical, so no durable credential is provisioned, decrypted, or minted for the settings gate. Merge settings and ruleset bypass actors are the two things REST withholds from that token — merge settings from any read-only viewer, bypass actors from any GitHub App installation token at every permission level — so `check` reads both over GraphQL instead. A declared-empty bypass list is verified through the GraphQL bypass-actor count, while naming the actors behind a declared non-empty list needs a local run with admin `gh` auth.

Then run `bun run check` until green. After this one-time wiring every future update is just `bun standards sync`.

### Keep in sync

Once `sync-standards.json` and the CLI dependency are present:

```sh
bun standards sync            # pull latest canonical files (mirror + deletions)
bun standards sync --ref v0.7.0  # pull a pinned tag, branch, or full commit sha
bun standards sync --dry-run  # preview a sync, writing nothing
bun standards check           # verify canonical files, seams, structure, and GitHub settings
bun standards doctor          # validate extension seams without drift checks
bun standards structure       # validate monorepo structure rules only
bun standards dependabot --check  # verify the composed .github/dependabot.yml matches its sources
bun standards dependabot --write  # regenerate it after editing .github/dependabot.local.yml
bun standards github --check  # compare live GitHub settings to the declaration
bun standards github --apply  # converge the live repo (needs admin gh auth)
bun standards help            # list commands and options
```

The `Standards sync` workflow also runs `sync` weekly and opens a PR when upstream has moved, so you never have to remember to pull. It resolves `ci.broker_app.app_id` and `ci.broker_app.private_key` through the trusted pre-sync copy of the canonical SOPS action, mints a short-lived installation token for only the current repository with Contents read and Pull requests write, and never exposes that token to the sync command. External actions use their maintained major-version tags by policy. The PR is validated by the required `Standards` gate like any other change. Create one private broker GitHub App per owning user or organization, install it only on selected repositories, and provision each repository with `bun standards creds add github --dest ci:ci.broker_app`; the command selects the App by origin owner and verifies its installation before writing, while missing credentials or failed token minting stop the workflow without a fallback.

### Local development database

Repos whose primary database package follows the standard `packages/db` shape get a managed local PostgreSQL container from three canonical recipes:

```sh
just dev-db-start    # create on first use, then start; waits until PostgreSQL accepts connections
just dev-db-stop     # stop the container
just dev-db-status   # created/running state and published port
```

`dev-db-start` reads the `DATABASE_URL` from the generated `packages/db/.env.local` (run `just dev-env-generate` first) and deliberately ignores a conflicting shell export. It accepts `postgres:` or `postgresql:` URLs on `localhost` or `127.0.0.1`, publishes the URL's port on IPv4 loopback, and creates the URL's user, password, and database on first start. Query parameters and fragments are rejected because they can override or change those connection semantics. It reports readiness only after that exact user, password, and database complete a real query. The container is named `<repo>-dev-postgres` after the root `package.json` npm scope (or its unscoped name — `@prosabridge/root` and `prosabridge` both yield `prosabridge-dev-postgres`), runs `postgres:17` under Podman, carries a canonical ownership label, and keeps its data in a named volume `<repo>-dev-postgres-data`, so stopping and starting preserves state across reboots. IPv6 loopback and non-local hosts are rejected before Podman is called.

Two sharp edges are surfaced instead of hidden. First, all three recipes refuse to operate on a same-name container unless its ownership label, image, exact IPv4 binding, and data-volume mount match the canonical shape; `dev-db-start` also requires its published port to match `DATABASE_URL`. Remove a mismatched container yourself after checking that it is safe to do so. Second, PostgreSQL fixes credentials in the data volume at first initialization, so rotating the dev database password requires removing both the managed container and its volume before starting again.

These recipe names are part of the canonical root lifecycle contract. A consumer whose `local.just` already declares `dev-db-start`, `dev-db-stop`, or `dev-db-status` must rename or remove that local recipe in the same sync change; Just rejects the collision. The canonical file does not probe for old names or route to repository-specific implementations. Repositories with a different database lifecycle keep their own distinctly named local recipes until that lifecycle is standardized.

### Automate deferred fixes with the poller

Review-fix cycles defer real-but-adjacent findings as `deferred-finding` issues, and those accumulate. The fix poller works that backlog down with your approval as the only per-issue effort: apply `approved-for-fix` to any issue, deferred finding or not (admin/maintain role required — the poller verifies who applied the label, binds approval to that exact issue revision, and revalidates it before publication, so later edits and triage-level drive-bys on a public repo cannot start or redirect jobs) and the next tick verifies the issue's premise, implements it in a throwaway worktree, and opens a draft PR that your required CI checks gate like any other change. Apply `approved-for-review` to that draft PR and the next tick similarly binds approval to the exact PR head, runs a full review-fix cycle on it — lens fan-out, fixes as new commits, and fresh fix-delta verification — then revalidates the binding, posts the report, and flips it ready for review. The poller acknowledges either request with a clear queued comment, even while a long-running job occupies the worker, and posts a second update when work starts; its approval and claim records stay in hidden comment metadata instead of appearing as raw JSON. Merging stays yours, always. When a run needs a decision, it asks in a comment and applies `needs-clarification`, which rings the same ntfy doorbell as review pauses (on issues and PRs alike); your reply resumes the job on a later tick, and comments from anyone without admin/maintain are ignored entirely.

Setup is host-level, not per repo: every repo already carries the protocol (the labels ship in the declared GitHub settings via `github --apply`; the workflow and skills are synced). The polling host's infrastructure repository owns the service identity, writable HOME, PATH, token environment, lingering, and systemd deployment. Authenticate that identity for `codex`, put `gh` on the service PATH, provide a fine-grained PAT with issues/PRs/contents write on the watched repos, write a config file listing the repos plus the Codex model and reasoning effort, and adapt all four units emitted by `standards poller --print-units --config <path>` into the host's declarative configuration: a worker service and timer plus the lightweight acknowledgement service and timer that remain responsive while the worker runs. The approved Codex run inherits that PAT and uses authenticated `gh` for the PR review ledger, authorized PR metadata edits, and deferred issues. The poller still owns approval and claim labels, commit pushes, the final review report, and the ready transition so each publication is revalidated against the approved head. One poller supports at most 12 repositories; split larger fleets across pollers with independent GitHub API budgets. See the CLI README for the full config schema and trust model.

### Package the poller with Nix

Each release exposes `packages.<system>.standards-cli` and `packages.<system>.default` for `x86_64-linux` and `aarch64-linux`. The package derives the CLI version from `packages/standards-cli/package.json`, derives Bun from the root `packageManager` and CLI engine declarations, and creates the complete production dependency closure with a filtered frozen install from `bun.lock`; consumers do not repeat any of those versions or dependencies. Its `bin` directory contains `standards`, `bun`, and `bunx`, and the `standards` wrapper prepends that directory to `PATH` so poller subprocesses inherit the same standards-owned Bun runtime.

Pin a released tag and, when the consumer already owns nixpkgs, make the standards input follow it:

```nix
inputs.standards = {
  url = "github:davidvornholt/standards/v0.22.2";
  inputs.nixpkgs.follows = "nixpkgs";
};

# In the NixOS module receiving `inputs` through specialArgs:
let
  standardsCli = inputs.standards.packages.${pkgs.system}.standards-cli;
  pollerPath = [
    standardsCli
    pkgs.codex
    pkgs.gitMinimal
    pkgs.gh
    pkgs.nix
  ];
in
{
  systemd.user.services.standards-poller.serviceConfig.ExecStart =
    "${standardsCli}/bin/standards poller --config ${pollerConfig}";
  systemd.user.services.standards-poller.path = pollerPath;
  systemd.user.services.standards-poller-acknowledgements.serviceConfig.ExecStart =
    "${standardsCli}/bin/standards poller --acknowledge-only --config ${pollerConfig}";
  systemd.user.services.standards-poller-acknowledgements.path = pollerPath;
}
```

### Migration to 0.22.0

Version 0.22.0 lets a plain dev-env configuration layer reference a brokered R2 S3 credential pair instead of copying its values: an env key whose value is `{ brokeredS3: <secrets-target>, key: <dotted.key>, part: access_key_id | secret_access_key }` resolves at generation time from the pair `creds add cloudflare --s3` minted into that target, so the secret lives only in the broker's ledger and several workspaces can share one credential. Every referenced pair must also be authorized by its exact `<secrets-target>:<dotted.key>` entry under the reserved top-level `brokeredReferences` list in the SOPS-encrypted `secrets/dev.yaml`; add that list before migrating references. Plain `config/dev.yaml` and `config/dev.local.yaml` reject `brokeredReferences`, while the secrets layer rejects reference objects — configuration selects a pair and encrypted policy authorizes its declassification into `.env.local`. An unauthorized reference fails before SOPS decrypts its target, and a referenced destination must contain both string pair parts. A target name must bind exactly one existing flat or host secrets file; duplicate `secrets/<target>.yaml` and `infra/hosts/<target>/secrets.yaml` files now block `just secrets`, dev-env resolution, and broker reconciliation instead of selecting the host file. `creds add` and `creds apply` regenerate the dev env files after a verified write of an exact referenced pair, so a bearer write in the same file cannot release an unsafe pair. When one S3 pair write is unsafe but a sibling pair commits, regeneration preserves the unsafe pair's prior generated values while updating the verified sibling, or fails loudly without changing any env file when it cannot prove those prior values. The feature is opt-in and changes nothing for consumers that declare only literal values; no sync-workflow version-guard bump is required.

### Migration to 0.21.0

Version 0.21.0 makes `standards dev-env` compose each workspace's generated `.env.local` from three workspace-keyed layers instead of one: the tracked plain `config/dev.yaml` for shared non-secret configuration, the SOPS-encrypted `secrets/dev.yaml` for shared secrets (still required), and the gitignored plain `config/dev.local.yaml` for per-developer/per-machine overrides, which wins over both and may override secret values. Later layers override earlier ones per env key; a key declared in both tracked shared layers fails validation, because a value is either configuration or a secret. Plain layers are optional and may be comment-only. Gitignore `config/dev.local.yaml` before running the command — it refuses to run while git would track that file, exactly as it refuses trackable `.env.local` targets. Add `.env.local.standards-*.tmp` and `.env.local.standards-*.bak` to an existing consumer's `.gitignore` too: `.gitignore` is seeded only during `init`, so `sync` cannot add the new plaintext transaction-artifact rules, and generation now fails before staging unless Git proves its actual random artifact paths are ignored. The generated file is now the complete effective dev environment. A successful run also removes a generated `.env.local` when its direct `apps/*` or `packages/*` package workspace no longer appears in any layer. The command treats the file as generator-owned only while its first line remains the exact do-not-edit header; editing values below an unchanged header does not protect the file from removal, while hand-owned files and files with edited headers are left untouched. Repo-local mechanisms that layered extra configuration onto workspace processes at launch time (wrapper recipes, launcher packages, per-workspace tracked env files) should migrate their values into the new layers and be deleted. Upgrade `@davidvornholt/standards` and `bun.lock` to 0.21.0 before or with the sync that delivers the updated `AGENTS.md` and `justfile` text, so the described composition and reconciliation actually run; the weekly `Standards sync` workflow enforces this by raising its version guard to `MINIMUM_STANDARDS_VERSION: "0.21.0"`.

### Breaking migration to 0.17.0

Poller Codex runs now receive the host's GitHub token and use `gh` for repository collaboration instead of converting every GitHub operation into a clarification or a poller-side deferred action. Before upgrading a polling host, add `gh` to the service PATH and confirm the existing fine-grained PAT grants Issues, Pull requests, and Contents write on every watched repository. There is no restricted-token fallback: a host that does not provide authenticated `gh` is misconfigured and review runs fail rather than silently returning to the old question-only behavior. Sealed review plans from the earlier protocol are rejected rather than migrated or partially published; their legacy output branches are ignored, so leave the approval in place and the review reruns on a fresh protocol-versioned branch.

### Breaking migration to credential-free settings verification

The canonical settings gate (now part of the `check` aggregator job) no longer reads a durable fine-grained PAT, and no longer reads any durable credential at all: it verifies with the workflow token, granted read-only Contents and Issues. The PAT it replaces existed because GitHub gives no API to create or revoke one, so it could never be rotated by `bun standards creds` — it had to be minted and retired by hand.

An intermediate design minted a short-lived installation token from `ci.broker_app` instead. A probe retired it: against a private repository, a broker installation token and a token holding exactly this job's grants were compared across every read the gate performs — list rulesets, get each ruleset, list labels, and the GraphQL merge-settings and bypass-actor query — and the answers were identical, including the fields GitHub withholds from both. Minting therefore bought no visibility while decrypting the one durable App key each consumer keeps for the weekly sync, and it introduced a silent-degradation path: a rotated age key or a missing secret dropped the job to the workflow token with only a `::warning::`, leaving the gate green on a credential the workflow itself described as proving less. Deleting the mint removes both.

One capability goes with the PAT. It was user-scoped, so REST served it ruleset `bypass_actors`; no token CI can hold gets that field, so a repo whose `.github/settings.local.json` declares a *non-empty* bypass-actor list now has a settings gate that fails closed until someone re-runs `bun standards github --apply`/`--check` locally with admin `gh` auth. A declared-empty list — what the canonical declaration ships — is still verified exactly, through the GraphQL bypass-actor count. Check your seam for a non-empty list before adopting.

Adopt it in this order: sync the canonical workflow, confirm the `Standards` run's `check` job passes, then delete `ci.github_settings_read_token` from `secrets/ci.yaml` and from the repo-owned `secrets/ci.example.yaml`, and finally revoke the PAT at <https://github.com/settings/personal-access-tokens>. Nothing needs provisioning, and `ci.broker_app` stays exactly as it is — the weekly sync still requires it. The same change raises the weekly `Standards sync` version guard to `MINIMUM_STANDARDS_VERSION: "0.18.0"` and pins the isolated gate to that published CLI, because the settings comparison now depends on the GraphQL bypass-actor fallback that only exists from 0.18.0; an older installation would otherwise run a gate that cannot verify `bypass_actors` at all. Upgrade the exact `@davidvornholt/standards` dependency and `bun.lock` to at least 0.18.0 before accepting the canonical workflows.

### Track main or pin a version

Tracking `main` weekly is the default and the recommended mode for repos whose owner also follows this template. Consumers that want to control *when* standards change instead — typical for repos you adopt these standards into but don't co-evolve with this one — get both levers in a small checked-in policy file, `sync-standards.local.json`, owned by the consumer repo (the canonical workflow file is read-only, but the policy next to it is versioned and reviewable like any other configuration). Both fields are optional:

- **`"autoSync": false`** — skip the weekly scheduled run. Run `bun standards sync` locally when you deliberately want to pull updates; the secret-bearing sync workflow is schedule-only so an arbitrary branch or tag cannot supply the workflow code that receives consumer credentials.
- **`"ref": "v0.7.0"`** — a non-empty single-line tag, branch, or full commit sha to sync from instead of `main`. The workflow and the CLI (`init`/`sync` without an explicit `--ref`) both honor it, so scheduled and local syncs share one policy source.

Every CLI release already creates a `vX.Y.Z` tag and GitHub Release, so released versions are natural pin points — no separate content-release process exists or is needed. A pinned repo updates by moving the pin (or running `sync --ref <newer>`) and reviewing the resulting PR like a dependency upgrade. The lock always records the exact upstream commit synced, so `check` works identically in both modes.

### Breaking migration to 0.13.0

Version 0.13.0 is an intentional hard ownership cutover for infrastructure consumers adopting the standards-owned Nix package for host-side CLI and poller use. In the same migration, delete every locally assembled Bun, standards CLI, and production-dependency derivation used for those standards-owned pieces, pin a released tag, and use only its `packages.<system>.standards-cli` output; do not retain parallel derivations. The release package is the sole owner of the Bun runtime and lock-derived production dependency closure. This breaking change is limited to infrastructure packaging: npm consumers and standards-sync consumers are unchanged.

### Breaking migration to brokered Standards sync credentials

The weekly `Standards sync` workflow now requires `@davidvornholt/standards` 0.14.0 or newer and the broker GitHub App, and fails closed; it no longer accepts a durable repository token or falls back to the workflow token for PR creation. First upgrade the exact CLI dependency and `bun.lock` to at least 0.14.0. Then delete the old scalar sync credential from `secrets/ci.yaml`, install the broker App only on each selected consumer repository, and run `bun standards creds add github --dest ci:ci.broker_app` from that repository. Commit the dependency, lockfile, canonical workflow, and resulting SOPS-encrypted nested `ci.broker_app.app_id` and `ci.broker_app.private_key` values together. At the time this migration landed, `ci.github_settings_read_token` stayed alongside it as the isolated settings-verification credential; credential-free settings verification later retired it without replacement, so a repo migrating today should follow that section instead of provisioning the PAT.

### Breaking migration to squash-only merging

The canonical GitHub settings now own `allow_merge_commit`, `allow_rebase_merge`, and `allow_squash_merge`, and enforce squash as the only merge method in the default-branch ruleset. A consumer whose repo-owned `.github/settings.local.json` previously declared any of those three repository keys must remove only those keys during the hard cutover; preserving them would be an attempted override of newly canonical policy.

After the standards-sync pull request opens, check out its branch, remove those local keys if present, and run `bun standards github --apply` with admin auth from that branch before merging. Commit and push any local-seam cleanup, then wait for or rerun the fixed GitHub-hosted `check` aggregator. Merge the sync pull request only after every required check passes. The live settings must converge before merge because the new declaration deliberately makes its own pull request fail closed on the old merge policy.

### Breaking migration to 0.7.0

Version 0.7.0 is an intentional hard cutover: `sync-standards.local.json` is the only cadence and ref policy source. The canonical workflow and CLI no longer read `STANDARDS_AUTO_SYNC` or `STANDARDS_SYNC_REF`; leaving those Actions variables configured has no effect.

Upgrade `@davidvornholt/standards` and `bun.lock` to 0.7.0 or newer, create `sync-standards.local.json` with any required opt-out or pin, and accept the canonical workflow update in the same consumer PR. The 0.7 workflow fails before syncing with an actionable error if a policy file is present but the installed CLI is older than 0.7.0. The 0.10 workflows superseded that conditional guard with an unconditional minimum so every sync used an artifact compatible with Dependabot composition and the isolated GitHub settings gate. The 0.12 workflow retained that guard and raised its minimum for its earlier ownership and policy cutover; the 0.14 broker-credential cutover raised the minimum again, the credential-free settings-verification cutover raised it to 0.18.0, and the 0.21 dev-env composition cutover raises it to 0.21.0.

### Breaking migration to 0.10.2

Version 0.10.2 isolates the GitHub settings credential from repository-controlled executable code in the canonical Standards workflow. Upgrade `@davidvornholt/standards` and `bun.lock` before accepting or syncing the new workflow: its unprivileged quality job sets the workflow-internal `STANDARDS_SKIP_GITHUB_CHECK=true` seam, which older CLIs ignore and therefore try to repeat the live check without the settings-read token. The stable required check remains `check`; it now fails closed unless both the normal quality job and isolated `github-settings` job succeed.

### Breaking migration to 0.10.1

Version 0.10.1 makes `.github/dependabot.yml` a generated file. It is no longer seeded and repo-owned: `init` and `sync` compose it from the synced `.github/dependabot.base.yml` and the optional repo-owned `.github/dependabot.local.yml`, overwriting whatever is there, and `check` fails while the generated file does not match its sources. CLI 0.10.1 requires the selected content ref to include the canonical `.github/dependabot.base.yml` and rejects older refs before changing any consumer file. Before running `init` or `sync` with 0.10.1, move supported customizations out of your old hand-maintained `dependabot.yml` into `.github/dependabot.local.yml` — new ecosystems as new update blocks, private registries as top-level definitions and per-update references, and extra version holds by repeating the canonical target with only `ignore` and/or `registries`. Matching canonical blocks deliberately reject labels, groups, cooldowns, pull-request limits, and other policy additions. Template-wide holds (Biome, TypeScript) now arrive through the canonical base, so delete local copies of them rather than duplicating the entries.

### Migration to 0.12.0

Version 0.12.0 makes the root `justfile` and the `secrets.just` module canonical synced files, and adds the `standards dev-env` command they drive. This is a hard cutover: the next `init` or `sync` overwrites any repo-owned `justfile` and `secrets.just`. Before accepting it, move repo-specific recipes and modules into a repo-owned `local.just` — the canonical justfile imports it when present, so `just <recipe>` keeps working. Per-repo secrets target maps are gone: flat targets live at `secrets/<target>.yaml`, host targets live at `infra/hosts/<target>/secrets.yaml`, and a name with both files is rejected as ambiguous instead of preferring one. When neither file exists, an existing host directory selects the host file and other names select the flat file, so targets like `pr-preview` or a prod host need no local edits. `just dev-env-generate` (backed by `bun standards dev-env`) derives each workspace's `.env.local` from the workspace-group keyed `secrets/dev.yaml` (`apps.<name>`, `packages.<name>` — the shape in `secrets/dev.example.yaml`); ensure `.env.local` is gitignored, because the command refuses to write env files git would track. Upgrade `@davidvornholt/standards` and `bun.lock` to 0.12.0 before or with the sync that delivers the canonical justfile — older installations lack the `dev-env` command it calls. The sync workflow's unconditional minimum and the pinned isolated settings checker shipped at 0.11.1 with the release and rose to 0.12.0 in the post-publish follow-up, because both must reference an artifact that already exists on npm.

### Migration to 0.11.1

Version 0.11.1 makes `standards check` reject the raw token formed by `biome-` + `ignore` anywhere in lock-backed canonical files. Upgrade `@davidvornholt/standards` and `bun.lock` to 0.11.1 before accepting or running the canonical sync workflow; its unconditional version guard refuses older installations that do not enforce this consumer lint-compatibility contract.

### Breaking migration to 0.11.0

Version 0.11.0 adds canonical and repo-local `labels` declarations to `.github/settings.json` and `.github/settings.local.json`. Older CLIs reject that key, so upgrade `@davidvornholt/standards` and `bun.lock` to 0.11.0 before accepting or running the new canonical sync workflow; its unconditional version guard refuses older installations before sync can mirror settings they cannot parse. Also grant read-only "Issues" access to the fine-grained PAT stored as `ci.github_settings_read_token`; label reads require it in addition to the existing read-only "Administration" access. Update the matching entry in your repo-owned `secrets/ci.example.yaml` as well as the encrypted PAT, because sync does not overwrite seeded secret examples. That PAT step is superseded — credential-free settings verification retired the token entirely, so a repo migrating today skips it and follows that section instead; the Issues read it describes now lives in the fixed GitHub-hosted `check` aggregator's workflow-token permissions. Run `bun standards github --apply` after syncing to create the canonical poller protocol labels. The poller is declarative-only in 0.11: remove any host setup that calls `poller --install`, use `poller --print-units --config <path>` as input to the polling host's infrastructure repository, and let that owner provide the service identity, PATH, token environment, lingering, and deployment.

## Release the CLI

The version in `packages/standards-cli/package.json` is the release declaration, and the merge commit that changes it is the release. Change it to a new stable SemVer in a pull request and update the version seeded by `template/package.json` at the same time. After that exact merge commit passes the `Standards` workflow on `main`, `Publish standards CLI` packs and publishes that version through npm trusted publishing, then creates the matching `vX.Y.Z` Git tag and GitHub Release at that same commit.

A merge that inherits a version an earlier commit declared is a no-op: it reads the parent commit's manifest, finds the version unchanged, and stops without contacting npm. Reverting a release commit withdraws the declaration the same way. Neither path publishes, but both still check a tag: an inherited version requires its own `vX.Y.Z` tag, and a revert additionally requires the tag of the version it withdraws — that version is the one at risk, and no later commit ever mentions it again. A release that never completed therefore turns every later merge red instead of being skipped in silence.

Publishing only ever happens on the declaring commit, and only while that commit is still the tip of `main`. npm builds provenance from `GITHUB_SHA`, which for this `workflow_run` trigger is the tip of the default branch rather than the commit the run checked out; publishing once `main` has advanced would attest a tree the tarball does not contain. The workflow refuses to publish in that case rather than producing an incoherent attestation. A run that publishes nothing because npm already carries the version is unaffected: it produces no attestation of its own, so it verifies the published one instead and reconciles the tag.

**If a release commit's `Standards` run fails**, re-run it promptly — publishing completes only while that commit is still the tip of `main`. Once `main` moves on, or if the gate failure needs a fix-forward commit, an unpublished version is spent: declare a new version on current `main`, and declare it in the fix-forward commit itself. `Verify the inherited release completed` fails any commit that inherits the spent version while it has no tag, so a fix-forward that only repairs the gate reds on that guard, as does every merge after it until a new version is declared. A version that reached npm but never got its tag stays recoverable after `main` moves on: re-run that commit's failed `Publish standards CLI` run, which [keeps the original event's `GITHUB_SHA`](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs), verifies the published package's provenance against the declaring commit, and then reconciles the tag and Release. A declared version that is absent from npm and behind npm latest, unverifiable provenance, a tag pointing at another commit, an inherited version with no tag, or a withdrawn version with no tag all fail closed; a declared version npm already carries is not one of those cases — whatever npm latest is, the run reconciles that release instead of publishing it again.

## How sync works

- **Canonical content tracks `main` by default.** The CLI is a normal package dependency; synced content follows upstream `main` unless a consumer pins a ref (`--ref`, or `"ref"` in `sync-standards.local.json`). Updates arrive the next time a repo runs `sync`; the resulting diff is still reviewed in a pull request.
- **Mirror, including deletions.** A managed path is a file or a symlink; a canonical link is mirrored as the link itself and never followed, so a linked directory stays one copy on disk. `sync` reconciles managed paths against the lock three ways: paths removed upstream are removed locally, so "canonical" never drifts into a pile of stale copies. It refuses before its first write rather than replacing a managed destination that has become a directory of unmanaged work, and on the removal side it leaves such a directory in place — with a printed reason — rather than deleting it, and drops a lock entry that now sits below a link rather than deleting through the link. `--dry-run` previews the plan — create, update, delete, and the lock entries a run drops without deleting anything — and writes nothing.
- **`check` is the CI gate.** It confirms every managed path still matches what `sync` last wrote (offline, hash-based — a link's hash covers its target, so retargeting one or replacing it with a real directory is drift like an edited file), rejects the raw token formed by `biome-` + `ignore` anywhere in canonical files so they remain compatible with consumer lint configurations, fails closed when the lock is absent, runs `doctor` to verify the repo-owned extension seams, and runs `structure` to enforce the monorepo layout contract (workspace and root script shapes, internal versioning, package `exports`, tsconfig inheritance, and a11y wiring for explicit `*.a11y.ts` suites). Once `.github/settings.json` is synced it also compares the live GitHub repository against the declaration via the API and fails closed on drift and on declared state the token cannot see. In the canonical workflow only, the unprivileged quality step sets `STANDARDS_SKIP_GITHUB_CHECK=true` because the `check` aggregator job runs that live comparison with the workflow token, granted read-only "Contents" and "Issues". That job sparse-checks out only the two declarative settings inputs, grants its workflow token only `contents: read` and `issues: read`, and runs a checksum-pinned published CLI outside repository-controlled package configuration; it resolves no secret and mints no token. Local `bun run check` remains fail-closed and performs the live comparison normally.

### Known limitation

`check` detects **local tampering** with canonical files, not that **upstream has moved on**. Nothing local encodes "the template changed"; a repo only learns of upstream changes by running `sync`. The `Standards sync` workflow closes this for repos tracking `main`: it runs `sync` weekly and opens a PR when the mirror changes, so upstream updates surface as reviewable PRs instead of silent drift. Run `bun standards sync` locally for an on-demand update. A repo pinned to a ref has opted out of the weekly signal by design — staying current becomes its own responsibility, like any pinned dependency.

## Non-goals

- **No infrastructure code.** No host provisioning, deployment topology, or server secrets. A single host serves many repos, public and private, so standards never couple to one. Only the repo-scoped secret *shape* (`secrets/*.example.yaml`) and the `declarative-infra` skill ship here. The skill carries the reusable *knowledge* — the opinionated server profile, reference NixOS/OpenTofu snippets, SOPS/age key tooling, and bootstrap/audit procedures — while each consumer repo owns its infrastructure code outright. (The former [davidvornholt/declarative-infra](https://github.com/davidvornholt/declarative-infra) shared-module repo is retired and archived in favor of this skill.)

## License

[MIT](./LICENSE) © David Vornholt
