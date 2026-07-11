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
- **`standards.just`** — generic `just` recipes (`sync-standards`, age keygen).
- **`@davidvornholt/standards`** — the Bun-executable CLI for bootstrap, sync, drift detection, and consumer integration validation.

## Two buckets

Every file is either **synced** (upstream-owned, read-only in consumers — the list in `sync-standards.json`) or **seeded once** (written by `init` from `template/`, then owned by the repo: the `biome.jsonc` wrapper, `AGENTS.local.md`, `justfile`, `.github/dependabot.yml`, `.sops.yaml`, `secrets/*.example.yaml`, root scaffolding, `README.md`). Secret-shape examples are seeded, not synced, so each repo can extend them to mirror its own real secrets without the next sync clobbering them.

Because canonical files are read-only, every point of legitimate per-repo variation goes through a wrapper seam: `biome.jsonc` extends `biome.base.jsonc`, `justfile` imports `standards.just`, `AGENTS.local.md` extends `AGENTS.md`.

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
bun run standards -- init
```

**`init` never clobbers:** any file that already exists (your `package.json`, `biome.jsonc`, `turbo.json`, `README.md`, …) is *kept*, and only missing files are seeded. The canonical (bucket-1) files are always mirrored in. `init` is one-time: once `sync-standards.lock` exists it refuses to run again, and all updates go through `sync`. So on a repo that is already set up, adoption is: `init`, then wire the extension **seams** by hand — a one-time cost that is the whole point of the two-bucket model:

- **`biome.jsonc`** — add `"extends": ["./biome.base.jsonc"]`; move any rules you override into its `overrides` and delete ones now inherited from the base.
- **`justfile`** — add `import 'standards.just'` at the top.
- **`CLAUDE.md`** — replace its contents with the single line `@AGENTS.md`. It is canonical and synced, so it must match byte-for-byte.
- **`AGENTS.md`** — now canonical and synced; move anything repo-specific into `AGENTS.local.md`, which `AGENTS.md` includes.
- **`package.json`** — declare `@davidvornholt/standards` directly and make `check` and `check:fix` run `standards check` first.
- **`.github/dependabot.yml`** — keep the baseline root entries for the Bun and GitHub Actions ecosystems; add repo-specific ecosystems such as Nix or OpenTofu when the repository uses them.
- **`.sops.yaml`** — keep your real age recipients; only the `secrets/*.example.yaml` *shapes* are canonical.
- **CI** — the synced `.github/workflows/standards.yml` is your quality gate. If the repo already ran its own gate, drop that duplication and keep only what the canonical gate does not (deploy, infra, workflow linting). If your tests need a specific database, set the repo Actions variables `CI_POSTGRES_USER` / `CI_POSTGRES_PASSWORD` / `CI_POSTGRES_DB` (and optionally `CI_RUNNER`).

- **`sync-standards.lock`** — commit it. It is the baseline `check` compares against in CI; if it is untracked, a fresh CI clone has nothing to check and the drift gate is silently inert.

Then run `bun run check` until green. After this one-time wiring every future update is just `just sync-standards`.

### Keep in sync

Once `sync-standards.json` and the CLI dependency are present:

```sh
just sync-standards            # pull latest canonical files (mirror + deletions)
just sync-standards --dry-run  # preview a sync, writing nothing
just sync-standards check      # verify canonical files and extension seams
just sync-standards doctor     # validate extension seams without drift checks
```

The `Standards sync` workflow also runs `sync` weekly and opens a PR when upstream has moved, so you never have to remember to pull.

## Release the CLI

The version in `packages/standards-cli/package.json` is the release declaration. Change it to a new stable SemVer in a pull request and update the version seeded by `template/package.json` at the same time. After the exact merge commit passes the `Standards` workflow on `main`, `Publish standards CLI` packs and publishes that version through npm trusted publishing, then creates the matching `vX.Y.Z` Git tag and GitHub Release. An unchanged version is a no-op; a version behind npm or a conflicting tag fails closed.

## How sync works

- **Canonical content tracks `main`.** The CLI is a normal package dependency, but synced content is not versioned or pinned. Updates arrive the next time a repo runs `sync`; the resulting diff is still reviewed in a pull request.
- **Mirror, including deletions.** `sync` reconciles managed paths against the lock three ways: files removed upstream are removed locally, so "canonical" never drifts into a pile of stale copies. `--dry-run` previews the plan (create / update / delete) and writes nothing.
- **`check` is the CI gate.** It is offline and hash-based: it confirms every synced file still matches what `sync` last wrote, fails closed when the lock is absent, and runs `doctor` to verify the repo-owned extension seams. It runs first inside `bun run check`.

### Known limitation

`check` detects **local tampering** with canonical files, not that **upstream has moved on**. Without a pin, nothing local encodes "the template changed"; a repo only learns of upstream changes by running `sync`. The `Standards sync` workflow closes this: it runs `sync` weekly (and on demand) and opens a PR when the mirror changes, so upstream updates surface as reviewable PRs instead of silent drift.

## Non-goals

- **No infrastructure code.** No host provisioning, deployment topology, or server secrets. A single host serves many repos, public and private, so standards never couple to one. Only the repo-scoped secret *shape* (`secrets/*.example.yaml`), generic SOPS/age tooling, and the `declarative-infra` skill ship here. The skill carries the reusable *knowledge* — the opinionated server profile, reference NixOS/OpenTofu snippets, and bootstrap/audit procedures — while each consumer repo owns its infrastructure code outright. (The former [davidvornholt/declarative-infra](https://github.com/davidvornholt/declarative-infra) shared-module repo is retired and archived in favor of this skill.)

## License

[MIT](./LICENSE) © David Vornholt
