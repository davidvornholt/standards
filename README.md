# standards

Reusable engineering standards for TypeScript/Bun monorepos — a shared agent operating contract, agent skills, a maximally strict Biome/TypeScript/a11y configuration, and a small sync engine that keeps every consuming repo aligned with this one.

It is two things at once: the source of truth I sync into my own projects, and a public, opinionated example of how I build.

## Philosophy

Quality gates are deliberately strict so that **agents can verify their work mechanically instead of declaring it done.** Lint, types, tests, and accessibility are all wired into a single `bun run check`. If a change is wrong, the gate fails; nothing relies on an agent's self-report. The standards strengthen gates over time and never weaken one to make a change pass.

## What's inside

- **`AGENTS.md`** — the single source of truth for the agent operating contract. `CLAUDE.md` is only a pointer to it; project-specific rules live in a repo's own `AGENTS.local.md`.
- **`.agents/skills/**`** — dual-target skills that work in both Claude Code (`SKILL.md`) and Codex (`agents/openai.yaml`).
- **`biome.base.jsonc`** — every applicable Biome rule domain and group at `error`, with each opt-out documented inline. Repos extend it from a thin `biome.jsonc` wrapper.
- **`packages/typescript-config`, `packages/a11y-testing`** — the shared TS config and the Playwright + Axe (WCAG 2.2 AA) test harness, under a stable `@davidvornholt` scope.
- **`.github/settings.json`** — the declared GitHub repository state: merge settings (auto-merge, delete-branch-on-merge, squash commit shape) and the default-branch ruleset (PR required, `check` status required, linear history, no bypass). `standards github --apply` converges the live repo; `standards check` fails on drift.
- **`@davidvornholt/standards`** — the Bun-executable CLI for bootstrap, sync, drift detection, and consumer integration validation.

## File ownership

Every file is **synced** (upstream-owned, read-only in consumers — the list in `sync-standards.json`), **seeded once** (written by `init` from `template/`, then owned by the repo: the `biome.jsonc` wrapper, `AGENTS.local.md`, `.github/dependabot.local.yml`, `.gitignore`, `.sops.yaml`, `secrets/*.example.yaml`, root scaffolding, `README.md`), or **generated** (engine-owned output that `sync` recomposes: `.github/dependabot.yml`, built from the canonical `.github/dependabot.base.yml` plus the repo-owned `.github/dependabot.local.yml`). Secret-shape examples are seeded, not synced, so each repo can extend them to mirror its own real secrets without the next sync clobbering them.

Because canonical files are read-only, every point of legitimate per-repo variation goes through a wrapper seam: `biome.jsonc` extends `biome.base.jsonc`, `AGENTS.local.md` extends `AGENTS.md`, `.github/dependabot.local.yml` extends `.github/dependabot.base.yml` (additively — it can add ecosystems, private registry definitions/references, and append `ignore` holds to canonical blocks, never override them), and `.github/settings.local.json` extends `.github/settings.json` (additively — it can add repository settings, rulesets, and labels but never override canonical ones; its one subtractive declaration is `"rulesetEnforcement": "unavailable-on-plan"` for repos whose GitHub plan cannot enforce rulesets, which skips the ruleset gate loudly instead of weakening any rule).

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

**`init` preserves repo-owned files, not managed files:** any seeded or otherwise repo-owned file that already exists (your `package.json`, `biome.jsonc`, `turbo.json`, `README.md`, …) is *kept*, and only missing files are seeded. Canonical files are always mirrored in, and generated files are always recomposed from their canonical source and repo-owned seam, so both managed classes can be replaced during the intentional hard cutover. `init` is one-time: once `sync-standards.lock` exists it refuses to run again, and all updates go through `sync`. On a repo with a hand-maintained `.github/dependabot.yml`, first move its supported customizations into `.github/dependabot.local.yml`; then run `init` and wire the remaining extension **seams** by hand — a one-time cost that is the point of the three-class file-ownership model:

- **`biome.jsonc`** — add `"extends": ["./biome.base.jsonc"]`; move any rules you override into its `overrides` and delete ones now inherited from the base.
- **`CLAUDE.md`** — replace its contents with the single line `@AGENTS.md`. It is canonical and synced, so it must match byte-for-byte.
- **`AGENTS.md`** — now canonical and synced; move anything repo-specific into `AGENTS.local.md`, which `AGENTS.md` includes.
- **`package.json`** — declare `@davidvornholt/standards` directly and make `check` and `check:fix` run `standards check` first.
- **`.github/dependabot.yml`** — now generated: `init` and every later `sync` compose it from the canonical `.github/dependabot.base.yml` and your repo-owned `.github/dependabot.local.yml`. Before the first of those commands, move supported customizations from a previously hand-maintained `dependabot.yml` into the local seam — repo-specific ecosystems such as Nix or OpenTofu as new update blocks, private registries as top-level definitions plus per-update references, and repo-local version holds by repeating a canonical block's target with only `ignore` and/or `registries`. The seam deliberately rejects unrelated additions to matching canonical blocks, including labels, groups, cooldowns, and pull-request limits. `bun standards dependabot --write` also overwrites the generated file.
- **`.sops.yaml`** — keep your real age recipients; only the `secrets/*.example.yaml` *shapes* are canonical.
- **CI** — the synced `.github/workflows/standards.yml` is your quality gate. If the repo already ran its own gate, drop that duplication and keep only what the canonical gate does not (deploy, infra). If your tests need a specific database, set the repo Actions variables `CI_POSTGRES_USER` / `CI_POSTGRES_PASSWORD` / `CI_POSTGRES_DB` (and optionally `CI_RUNNER`). To get a phone push when an agent review cycle pauses on a question (the synced `Notify pause` workflow, triggered by the `needs-clarification` label), set `ci.ntfy_topic_url` in your SOPS-encrypted `secrets/ci.yaml` to a full [ntfy](https://ntfy.sh) topic URL with a random unguessable topic name — the topic name is the only access control — and configure the `SOPS_AGE_KEY` Actions secret so CI can decrypt it; that key is the single bootstrap secret for all CI secrets.

- **`sync-standards.lock`** — commit it. It is the baseline `check` compares against in CI; if it is untracked, a fresh CI clone has nothing to check and the drift gate is silently inert.
- **GitHub settings** — create `.github/settings.local.json` (seeded on new repos; `{"repository":{},"rulesets":[]}` when you have nothing to add) and run `bun standards github --apply` once with admin `gh` auth. It converges the live repo onto the declared merge settings, default-branch ruleset, and labels — including deleting hand-made rulesets that are not declared; extra live labels remain untouched. From then on `check` fails whenever declared live state drifts. If the repo is private on a GitHub plan that cannot enforce rulesets (Free, personal or organization), declare `"rulesetEnforcement": "unavailable-on-plan"` in the seam: the gate then skips rulesets and the plan-gated `allow_auto_merge` setting (GitHub accepts a PATCH for it with HTTP 200 and silently keeps it off), converges the remaining merge settings and labels, and prints an unprotected-branch notice on every run instead of failing forever or trusting state GitHub silently does not honor. For CI to verify merge settings at all, set `ci.github_settings_read_token` in your SOPS-encrypted `secrets/ci.yaml` to a fine-grained PAT with read-only "Administration" access — GitHub hides those settings from workflow tokens, and the gate fails closed on state it cannot see.

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

The `Standards sync` workflow also runs `sync` weekly and opens a PR when upstream has moved, so you never have to remember to pull. The PR is validated by the required `Standards` gate like any other change; set `ci.standards_sync_token` in the encrypted `secrets/ci.yaml` (repository-scoped fine-grained PAT with Contents read + Pull requests write) so the opened PR triggers that gate automatically. Without the PAT, the workflow token can create the PR only when repository or organization policy permits GitHub Actions to do so, and a maintainer must approve the queued workflow runs; when policy blocks PR creation, the pushed sync branch remains without a PR.

### Automate deferred fixes with the poller

Review-fix cycles defer real-but-adjacent findings as `deferred-finding` issues, and those accumulate. The fix poller works that backlog down with your approval as the only per-issue effort: apply `approved-for-fix` to any issue, deferred finding or not (admin/maintain role required — the poller verifies who applied the label, binds approval to that exact issue revision, and revalidates it before publication, so later edits and triage-level drive-bys on a public repo cannot start or redirect jobs) and the next tick verifies the issue's premise, implements it in a throwaway worktree, and opens a draft PR that your required CI checks gate like any other change. Apply `approved-for-review` to that draft PR and the next tick similarly binds approval to the exact PR head, runs a full review-fix cycle on it — lens fan-out, adversarial verification, fixes as new commits — then revalidates the binding, posts the report, and flips it ready for review. Merging stays yours, always. When a run needs a decision, it asks in a comment and applies `needs-clarification`, which rings the same ntfy doorbell as review pauses (on issues and PRs alike); your reply resumes the job on a later tick, and comments from anyone without admin/maintain are ignored entirely.

Setup is host-level, not per repo: every repo already carries the protocol (the labels ship in the declared GitHub settings via `github --apply`; the workflow and skills are synced). The polling host's infrastructure repository owns the service identity, writable HOME, PATH, token environment, lingering, and systemd deployment. Authenticate that identity for `codex`, provide a fine-grained PAT with issues/PRs/contents write on the watched repos, write a config file listing the repos plus the Codex model and reasoning effort, and adapt `standards poller --print-units --config <path>` into the host's declarative service and timer. The poller removes its direct GitHub token variables before launching Codex, but the approved run shares the service identity and can read its other ambient credentials and logged-in tool state; that visibility is an accepted risk, not credential isolation. One poller serves all your repos; see the CLI README for the full config schema and trust model.

### Track main or pin a version

Tracking `main` weekly is the default and the recommended mode for repos whose owner also follows this template. Consumers that want to control *when* standards change instead — typical for repos you adopt these standards into but don't co-evolve with this one — get both levers in a small checked-in policy file, `sync-standards.local.json`, owned by the consumer repo (the canonical workflow file is read-only, but the policy next to it is versioned and reviewable like any other configuration). Both fields are optional:

- **`"autoSync": false`** — skip the weekly scheduled run. Manual `workflow_dispatch` (and `bun standards sync` locally) still works and becomes the deliberate way to pull updates.
- **`"ref": "v0.7.0"`** — a non-empty single-line tag, branch, or full commit sha to sync from instead of `main`. The workflow and the CLI (`init`/`sync` without an explicit `--ref`) both honor it, so scheduled and local syncs share one policy source.

Every CLI release already creates a `vX.Y.Z` tag and GitHub Release, so released versions are natural pin points — no separate content-release process exists or is needed. A pinned repo updates by moving the pin (or running `sync --ref <newer>`) and reviewing the resulting PR like a dependency upgrade. The lock always records the exact upstream commit synced, so `check` works identically in both modes.

### Breaking migration to 0.7.0

Version 0.7.0 is an intentional hard cutover: `sync-standards.local.json` is the only cadence and ref policy source. The canonical workflow and CLI no longer read `STANDARDS_AUTO_SYNC` or `STANDARDS_SYNC_REF`; leaving those Actions variables configured has no effect.

Upgrade `@davidvornholt/standards` and `bun.lock` to 0.7.0 or newer, create `sync-standards.local.json` with any required opt-out or pin, and accept the canonical workflow update in the same consumer PR. The 0.7 workflow fails before syncing with an actionable error if a policy file is present but the installed CLI is older than 0.7.0. The 0.10.1 workflow superseded that conditional guard with an unconditional minimum so every sync used the released Dependabot-aware artifact; the current 0.11 workflow retains the unconditional guard and raises the minimum to 0.11.

### Breaking migration to 0.10.1

Version 0.10.1 makes `.github/dependabot.yml` a generated file. It is no longer seeded and repo-owned: `init` and `sync` compose it from the synced `.github/dependabot.base.yml` and the optional repo-owned `.github/dependabot.local.yml`, overwriting whatever is there, and `check` fails while the generated file does not match its sources. CLI 0.10.1 requires the selected content ref to include the canonical `.github/dependabot.base.yml` and rejects older refs before changing any consumer file. Before running `init` or `sync` with 0.10.1, move supported customizations out of your old hand-maintained `dependabot.yml` into `.github/dependabot.local.yml` — new ecosystems as new update blocks, private registries as top-level definitions and per-update references, and extra version holds by repeating the canonical target with only `ignore` and/or `registries`. Matching canonical blocks deliberately reject labels, groups, cooldowns, pull-request limits, and other policy additions. Template-wide holds (Biome, TypeScript) now arrive through the canonical base, so delete local copies of them rather than duplicating the entries.

### Breaking migration to 0.11.0

Version 0.11.0 adds canonical and repo-local `labels` declarations to `.github/settings.json` and `.github/settings.local.json`. Older CLIs reject that key, so upgrade `@davidvornholt/standards` and `bun.lock` to 0.11.0 before accepting or running the new canonical sync workflow; its unconditional version guard refuses older installations before sync can mirror settings they cannot parse. Run `bun standards github --apply` after syncing to create the canonical poller protocol labels. The poller is declarative-only in 0.11: remove any host setup that calls `poller --install`, use `poller --print-units --config <path>` as input to the polling host's infrastructure repository, and let that owner provide the service identity, PATH, token environment, lingering, and deployment.

## Release the CLI

The version in `packages/standards-cli/package.json` is the release declaration. Change it to a new stable SemVer in a pull request and update the version seeded by `template/package.json` at the same time. After the exact merge commit passes the `Standards` workflow on `main`, `Publish standards CLI` packs and publishes that version through npm trusted publishing, then creates the matching `vX.Y.Z` Git tag and GitHub Release. An unchanged version is a no-op; a version behind npm or a conflicting tag fails closed.

## How sync works

- **Canonical content tracks `main` by default.** The CLI is a normal package dependency; synced content follows upstream `main` unless a consumer pins a ref (`--ref`, or `"ref"` in `sync-standards.local.json`). Updates arrive the next time a repo runs `sync`; the resulting diff is still reviewed in a pull request.
- **Mirror, including deletions.** `sync` reconciles managed paths against the lock three ways: files removed upstream are removed locally, so "canonical" never drifts into a pile of stale copies. `--dry-run` previews the plan (create / update / delete) and writes nothing.
- **`check` is the CI gate.** It confirms every synced file still matches what `sync` last wrote (offline, hash-based), fails closed when the lock is absent, runs `doctor` to verify the repo-owned extension seams, and runs `structure` to enforce the monorepo layout contract (workspace and root script shapes, internal versioning, package `exports`, tsconfig inheritance, and a11y wiring for explicit `*.a11y.ts` suites). Once `.github/settings.json` is synced it also compares the live GitHub repository against the declaration via the API and fails closed on drift and on declared state the token cannot see — GitHub reveals repo merge settings only to admin-capable viewers, so CI verifies them through `ci.github_settings_read_token` in the SOPS-encrypted `secrets/ci.yaml` (a fine-grained PAT with read-only "Administration" access, decrypted with the same `SOPS_AGE_KEY` bootstrap secret as every other CI secret). It runs first inside `bun run check`.

### Known limitation

`check` detects **local tampering** with canonical files, not that **upstream has moved on**. Nothing local encodes "the template changed"; a repo only learns of upstream changes by running `sync`. The `Standards sync` workflow closes this for repos tracking `main`: it runs `sync` weekly (and on demand) and opens a PR when the mirror changes, so upstream updates surface as reviewable PRs instead of silent drift. A repo pinned to a ref has opted out of that signal by design — staying current becomes its own responsibility, like any pinned dependency.

## Non-goals

- **No infrastructure code.** No host provisioning, deployment topology, or server secrets. A single host serves many repos, public and private, so standards never couple to one. Only the repo-scoped secret *shape* (`secrets/*.example.yaml`) and the `declarative-infra` skill ship here. The skill carries the reusable *knowledge* — the opinionated server profile, reference NixOS/OpenTofu snippets, SOPS/age key tooling, and bootstrap/audit procedures — while each consumer repo owns its infrastructure code outright. (The former [davidvornholt/declarative-infra](https://github.com/davidvornholt/declarative-infra) shared-module repo is retired and archived in favor of this skill.)

## License

[MIT](./LICENSE) © David Vornholt
