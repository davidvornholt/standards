# standards

Reusable engineering standards for TypeScript/Bun monorepos — a shared agent
operating contract, agent skills, a maximally strict Biome/TypeScript/a11y
configuration, and a small sync engine that keeps every consuming repo aligned
with this one.

It is two things at once: the source of truth I sync into my own projects, and a
public, opinionated example of how I build.

## Philosophy

Quality gates are deliberately strict so that **agents can verify their work
mechanically instead of declaring it done.** Lint, types, tests, and
accessibility are all wired into a single `bun run check`. If a change is wrong,
the gate fails; nothing relies on an agent's self-report. The standards
strengthen gates over time and never weaken one to make a change pass.

## What's inside

- **`AGENTS.md`** — the single source of truth for the agent operating contract.
  `CLAUDE.md` is only a pointer to it; project-specific rules live in a repo's
  own `AGENTS.local.md`.
- **`.agents/skills/**`** — dual-target skills that work in both Claude Code
  (`SKILL.md`) and Codex (`agents/openai.yaml`).
- **`biome.base.jsonc`** — every applicable Biome rule domain and group at
  `error`, with each opt-out documented inline. Repos extend it from a thin
  `biome.jsonc` wrapper.
- **`packages/typescript-config`, `packages/a11y-testing`** — the shared TS
  config and the Playwright + Axe (WCAG 2.2 AA) test harness, under a stable
  `@davidvornholt` scope.
- **`standards.just`** — generic `just` recipes (`sync-standards`, age keygen).
- **`scripts/sync-standards.ts`** — the sync engine (below).

## Two buckets

Every file is either **synced** (upstream-owned, read-only in consumers — the
list in `sync-standards.json`) or **seeded once** (written by `init` from
`template/`, then owned by the repo: the `biome.jsonc` wrapper, `CLAUDE.md`,
`AGENTS.local.md`, `justfile`, `.sops.yaml`, root scaffolding, `README.md`).

Because canonical files are read-only, every point of legitimate per-repo
variation goes through a wrapper seam: `biome.jsonc` extends `biome.base.jsonc`,
`justfile` imports `standards.just`, `AGENTS.local.md` extends `AGENTS.md`.

## Adopt it

**New repo** — bootstrap with the engine (it fetches this template, seeds the
repo-owned files, mirrors the canonical ones, and writes the lock):

```sh
curl -fsSL https://raw.githubusercontent.com/davidvornholt/standards/main/scripts/sync-standards.ts -o /tmp/sync-standards.ts
bun /tmp/sync-standards.ts init
```

**Existing repo** — once `sync-standards.json` and the engine are present:

```sh
just sync-standards          # pull the latest canonical files
just sync-standards --check  # verify nothing canonical was edited locally
```

## How sync works

- **No pinning, no versions.** Consumers track this repo's `main`. Updates arrive
  the next time a repo runs `sync`; there is no staging step. (With more than one
  consumer you would reintroduce a pin — for a solo owner this is deliberate.)
- **Mirror, including deletions.** `sync` reconciles managed paths against the
  lock three ways: files removed upstream are removed locally, so "canonical"
  never drifts into a pile of stale copies.
- **`--check` is the CI gate.** It is offline and hash-based: it confirms every
  synced file still matches what `sync` last wrote, and fails the build if a
  canonical file was edited locally. It runs first inside `bun run check`.

### Known limitation

`--check` detects **local tampering** with canonical files, not that **upstream
has moved on**. Without a pin, nothing local encodes "the template changed"; a
repo only learns of upstream changes by running `sync`. This is accepted for a
solo consumer. The planned fix is a scheduled Action that runs `sync` and opens
a PR when the mirror changes.

## Non-goals

- **No infrastructure.** No host provisioning, deployment topology, or server
  secrets. A single host serves many repos, public and private, so standards
  never couple to one. Only the repo-scoped secret *shape*
  (`secrets/*.example.yaml`) and generic SOPS/age tooling ship here.

## License

[MIT](./LICENSE) © David Vornholt
