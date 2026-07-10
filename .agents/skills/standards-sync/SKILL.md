---
name: standards-sync
description: Understand and operate the standards sync system. Use this skill before editing any file that might be canonical (synced from davidvornholt/standards), when a change needs to reach every consumer repo, when running or reasoning about `sync-standards` / `just sync-standards` / `--check`, when a repo reports canonical drift, or when testing a change to a canonical file before publishing it upstream.
---

# Standards sync

## Overview

Reusable engineering standards live in one upstream repo, `davidvornholt/standards`, and are mirrored into each consumer repo by `scripts/sync-standards.ts`. Every file the system owns is in one of two buckets, and the bucket decides who may edit it.

**Golden rule: canonical (bucket-1) files are read-only in a consumer.** Never edit one locally to change its behavior. A local edit is a defect that `--check` catches; the next `sync` overwrites it. To change a canonical file, change it upstream and sync.

## The two buckets

- **Bucket 1 — synced (upstream-owned, read-only).** Mirrored on every `sync`, including deletions. Listed in `sync-standards.json` under `paths`.
- **Bucket 2 — repo-owned (seeded once, then diverges).** Written from the template's seed dir during `init`, then owned by the consumer. `sync` never touches them. Examples: `biome.jsonc`, `AGENTS.local.md`, `justfile`, `.sops.yaml`, `secrets/*`, root `package.json`, `turbo.json`, `README.md`.

## Per-repo variation goes through a seam, never a local edit

Because bucket-1 files are byte-identical everywhere, every legitimate per-repo customization uses a designated extension seam — extend, never patch:

| Synced (bucket 1) | Consumer seam (bucket 2)                                 |
| ----------------- | -------------------------------------------------------- |
| `biome.base.jsonc`| `biome.jsonc` extends it                                 |
| `AGENTS.md`       | `AGENTS.local.md` extends it; `CLAUDE.md` points to it   |
| `standards.just`  | `justfile` imports it                                    |

If a task seems to require editing a canonical file for one repo's needs, stop — the change either belongs upstream (it's a real standard) or in the seam (it's repo-specific).

## Commands

`init` bootstraps (one-time: it refuses to run once `sync-standards.lock` exists — use `sync` from then on), `sync` mirrors bucket-1 and rewrites the lock, `sync --dry-run` previews, `--check` verifies drift offline (wired into the `check` gate); flags `--from <src>` and `--dir <consumer>`. Run through `just sync-standards <args>`. The engine `scripts/sync-standards.ts` ships in every consumer and is the source of truth for exact behavior — read it rather than restating it here.

## The normal change loop

To change a canonical file so it reaches every repo:

1. Edit the file in the `davidvornholt/standards` repo.
2. Commit and push it there.
3. In each consumer, run `just sync-standards`, then commit the resulting file changes **and** the updated `sync-standards.lock`.

## Testing a canonical change before publishing

github/URL sources always clone `main`, so the only way to try an unpushed change is a **local-path `--from`**: point a consumer at your local standards clone with uncommitted edits.

```sh
# In the CONSUMER, sourcing from a local standards clone with uncommitted edits:
bun run scripts/sync-standards.ts sync --from ../standards --dry-run   # preview
bun run scripts/sync-standards.ts sync --from ../standards            # apply
bun run check                                                          # see the effect
```

**Critical caveat — throw the result away afterward.** `sync` rewrites the lock from whatever source you pointed at, so a local-path sync records the hash of your *uncommitted* change and a `sha` that is your local HEAD (or the literal `local` if the source is not a git checkout) — a state that does not exist upstream. `--check` then passes locally against that lock, which is false comfort. So: test, then discard.

```sh
git restore -- sync-standards.lock <files-the-sync-touched>   # discard the local-sourced state
# then publish for real: push the change upstream, and in the consumer run
just sync-standards                                           # real sync from main → commit files + lock
```
