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

## Two buckets

Every file is either **synced** (upstream-owned, read-only in consumers — the list in `sync-standards.json`) or **seeded once** (written by `init` from `template/`, then owned by the repo: the `biome.jsonc` wrapper, `AGENTS.local.md`, `.github/dependabot.yml`, `.sops.yaml`, `secrets/*.example.yaml`, root scaffolding, `README.md`). Secret-shape examples are seeded, not synced, so each repo can extend them to mirror its own real secrets without the next sync clobbering them.

Because canonical files are read-only, every point of legitimate per-repo variation goes through a wrapper seam: `biome.jsonc` extends `biome.base.jsonc`, `AGENTS.local.md` extends `AGENTS.md`, and `.github/settings.local.json` extends `.github/settings.json` (additively — it can add repository settings and rulesets but never override canonical ones).

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

**`init` never clobbers:** any file that already exists (your `package.json`, `biome.jsonc`, `turbo.json`, `README.md`, …) is *kept*, and only missing files are seeded. The canonical (bucket-1) files are always mirrored in. `init` is one-time: once `sync-standards.lock` exists it refuses to run again, and all updates go through `sync`. So on a repo that is already set up, adoption is: `init`, then wire the extension **seams** by hand — a one-time cost that is the whole point of the two-bucket model:

- **`biome.jsonc`** — add `"extends": ["./biome.base.jsonc"]`; move any rules you override into its `overrides` and delete ones now inherited from the base.
- **`CLAUDE.md`** — replace its contents with the single line `@AGENTS.md`. It is canonical and synced, so it must match byte-for-byte.
- **`AGENTS.md`** — now canonical and synced; move anything repo-specific into `AGENTS.local.md`, which `AGENTS.md` includes.
- **`package.json`** — declare `@davidvornholt/standards` directly and make `check` and `check:fix` run `standards check` first.
- **`.github/dependabot.yml`** — keep the baseline root entries for the Bun and GitHub Actions ecosystems; add repo-specific ecosystems such as Nix or OpenTofu when the repository uses them.
- **`.sops.yaml`** — keep your real age recipients; only the `secrets/*.example.yaml` *shapes* are canonical.
- **CI** — the synced `.github/workflows/standards.yml` is your quality gate. If the repo already ran its own gate, drop that duplication and keep only what the canonical gate does not (deploy, infra). If your tests need a specific database, set the repo Actions variables `CI_POSTGRES_USER` / `CI_POSTGRES_PASSWORD` / `CI_POSTGRES_DB` (and optionally `CI_RUNNER`).

- **`sync-standards.lock`** — commit it. It is the baseline `check` compares against in CI; if it is untracked, a fresh CI clone has nothing to check and the drift gate is silently inert.
- **GitHub settings** — create `.github/settings.local.json` (seeded on new repos; `{"repository":{},"rulesets":[]}` when you have nothing to add) and run `bun standards github --apply` once with admin `gh` auth. It converges the live repo onto the declared merge settings and default-branch ruleset — including deleting hand-made rulesets that are not declared. From then on `check` fails whenever live settings drift from the declaration.

Then run `bun run check` until green. After this one-time wiring every future update is just `bun standards sync`.

### Keep in sync

Once `sync-standards.json` and the CLI dependency are present:

```sh
bun standards sync            # pull the configured canonical snapshot
bun standards sync --ref refs/tags/v0.5.0  # pull a pin and save it as repo policy
bun standards sync --dry-run  # preview a sync, writing nothing
bun standards check           # verify canonical files, seams, and GitHub settings
bun standards doctor          # validate extension seams without drift checks
bun standards github --check  # compare live GitHub settings to the declaration
bun standards github --apply  # converge the live repo (needs admin gh auth)
bun standards help            # list commands and options
```

The `Standards sync` workflow also runs `sync` weekly and opens a PR when upstream has moved, so you never have to remember to pull. The PR is validated by the required `Standards` gate like any other change; configure a `STANDARDS_SYNC_TOKEN` Actions secret (fine-grained PAT with contents and pull-requests write) so the opened PR triggers that gate automatically — with the default `GITHUB_TOKEN` it needs a manual nudge.

### Track main or pin a version

Tracking `main` weekly is the default and the recommended mode for repos whose owner also follows this template. Consumers that want to control *when* standards change instead — typical for repos you adopt these standards into but don't co-evolve with this one — declare both levers in the checked-in, consumer-owned `sync-standards.local.json`:

Non-default policy requires `@davidvornholt/standards` >=0.5.0 declared as an exact stable version. Existing consumers must upgrade that bucket-2 dependency before adding or changing this file—for 0.5.0, run `bun add --dev --exact @davidvornholt/standards@0.5.0`; sync cannot update a consumer-owned `package.json`. The weekly workflow cadence remains canonical; consumer policy controls only the ref and whether scheduled runs are enabled.

```json
{
  "ref": "refs/heads/main",
  "scheduledSync": true
}
```

- **`ref`** — `refs/heads/<branch>`, `refs/tags/<tag>`, or a full commit SHA. Qualified names prevent a branch and tag with the same name from resolving ambiguously. A successful non-dry `sync --ref <ref>` updates this field; a dry run never does.
- **`scheduledSync`** — set to `false` to skip only scheduled GitHub Actions runs. Manual `workflow_dispatch` and local sync still run.

Missing policy files default to `refs/heads/main` with scheduled sync enabled, so existing consumers migrate without a flag day. Every CLI release already creates a `vX.Y.Z` tag and GitHub Release, so `refs/tags/vX.Y.Z` values are natural pin points — no separate content-release process exists or is needed. A pinned repo updates by running `sync --ref <newer-qualified-ref>` (or editing the policy and then running bare `sync`) and reviewing the resulting PR like a dependency upgrade. The lock records both the requested ref and exact resolved commit; `check` rejects policy/lock disagreement.

## Release the CLI

The version in `packages/standards-cli/package.json` is the release declaration. Change it to a new stable SemVer in a pull request and update the version seeded by `template/package.json` at the same time. After the exact merge commit passes the `Standards` workflow on `main`, `Publish standards CLI` packs and publishes that version through npm trusted publishing, then creates the matching `vX.Y.Z` Git tag and GitHub Release. An unchanged version is a no-op; a version behind npm or a conflicting tag fails closed.

## How sync works

- **Canonical content tracks `main` by default.** The CLI is a normal package dependency; synced content follows `sync-standards.local.json`, defaulting to upstream `refs/heads/main`. Updates arrive the next time a repo runs `sync`; the resulting diff is still reviewed in a pull request.
- **Mirror, including deletions.** `sync` reconciles managed paths against the lock three ways: files removed upstream are removed locally, so "canonical" never drifts into a pile of stale copies. `--dry-run` previews the plan (create / update / delete) and writes nothing.
- **`check` is the CI gate.** It confirms every synced file still matches what `sync` last wrote (offline, hash-based), fails closed when the lock is absent, and runs `doctor` to verify the repo-owned extension seams. Once `.github/settings.json` is synced it also compares the live GitHub repository against the declaration via the API and fails on drift — repo merge settings that the CI token cannot see are reported as unverifiable instead of failing, since only admin tokens can read them. It runs first inside `bun run check`.

### Known limitation

`check` detects **local tampering** with canonical files, not that **upstream has moved on**. Nothing local encodes "the template changed"; a repo only learns of upstream changes by running `sync`. The `Standards sync` workflow closes this for repos tracking `main`: it runs `sync` weekly (and on demand) and opens a PR when the mirror changes, so upstream updates surface as reviewable PRs instead of silent drift. A repo pinned to a ref has opted out of that signal by design — staying current becomes its own responsibility, like any pinned dependency.

## Non-goals

- **No infrastructure code.** No host provisioning, deployment topology, or server secrets. A single host serves many repos, public and private, so standards never couple to one. Only the repo-scoped secret *shape* (`secrets/*.example.yaml`) and the `declarative-infra` skill ship here. The skill carries the reusable *knowledge* — the opinionated server profile, reference NixOS/OpenTofu snippets, SOPS/age key tooling, and bootstrap/audit procedures — while each consumer repo owns its infrastructure code outright. (The former [davidvornholt/declarative-infra](https://github.com/davidvornholt/declarative-infra) shared-module repo is retired and archived in favor of this skill.)

## License

[MIT](./LICENSE) © David Vornholt
