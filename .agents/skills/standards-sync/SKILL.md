---
name: standards-sync
description: Understand and operate the standards sync system. Use this skill before editing any file that might be canonical (synced from davidvornholt/standards), when a change needs to reach every consumer repo, when running or reasoning about `bun standards`, or when testing a canonical change before publishing it upstream.
---

# Standards sync

## Overview

Reusable engineering standards live in one upstream repo, `davidvornholt/standards`, and are mirrored into each consumer by the published `@davidvornholt/standards` CLI. Every file the system owns is in one of two buckets, and the bucket decides who may edit it.

## The two buckets

- **Bucket 1 — synced (upstream-owned, read-only).** Mirrored on every `sync`, including deletions. Listed in `sync-standards.json` under `paths`.
- **Bucket 2 — repo-owned (seeded once, then diverges).** Written from the template's seed dir during `init`, then owned by the consumer. `sync` never touches them. Examples: `biome.jsonc`, `AGENTS.local.md`, `.github/dependabot.yml`, `.sops.yaml`, `secrets/*`, root `package.json`, `turbo.json`, `README.md`.

## Per-repo variation goes through a seam, never a local edit

Because bucket-1 files are byte-identical everywhere, every legitimate per-repo customization uses a designated extension seam — extend, never patch:

| Synced (bucket 1)      | Consumer seam (bucket 2)                                     |
| ---------------------- | ------------------------------------------------------------ |
| `biome.base.jsonc`     | `biome.jsonc` extends it                                     |
| `AGENTS.md`            | `AGENTS.local.md` extends it; `CLAUDE.md` points to it       |
| `.github/settings.json` | `.github/settings.local.json` extends it (additive only: it may add repository settings and rulesets but never override canonical ones — GitHub layers rulesets strictest-wins, so additions can only tighten) |
| `.github/workflows/standards-sync.yml` | `sync-standards.local.json` configures it (the only policy source since CLI 0.7.0; optional `autoSync` opt-out for the weekly run, optional `ref` pin honored by the workflow and by CLI `init`/`sync`) |

If a task seems to require editing a canonical file for one repo's needs, stop — the change either belongs upstream (it's a real standard) or in the seam (it's repo-specific).

## Commands

Run commands as `bun standards <command>`; `help` lists them.

## GitHub settings

`github --check` verifies the live GitHub repository (merge settings and rulesets) against the merged declaration and fails closed on drift or API errors; `github --apply` converges the live repository — creating, updating, and deleting rulesets to exactly the declared set. Apply needs admin auth (the local `gh` CLI or `GH_TOKEN`), which CI's token cannot hold, so drift found in CI is fixed by a human or local agent running `bun standards github --apply`. Never hand-edit rulesets or merge settings in the GitHub UI; change the declaration instead.

A PR that changes the declaration fails its own gate until the change is applied: run `github --apply` from that branch before merging. Live state converging ahead of the merge is fine — the declaration is authoritative, not the merge order.

## Testing a canonical change before publishing

github/URL sources clone `main` unless `--ref` pins a tag, branch, or full commit sha — but any ref must exist on the remote, so the only way to try an *unpushed* change is a **local-path `--from`**: point a consumer at your local standards clone with uncommitted edits.

```sh
# In the CONSUMER, sourcing from a local standards clone with uncommitted edits:
bun standards sync --from ../standards --dry-run   # preview
bun standards sync --from ../standards             # apply
bun run check                                      # see the effect
```

**Critical caveat — throw the result away afterward.** `sync` rewrites the lock from whatever source you pointed at, so a local-path sync records the hash of your *uncommitted* change and a `sha` that is your local HEAD (or the literal `local` if the source is not a git checkout) — a state that does not exist upstream. `check` then passes locally against that lock, which is false comfort. So: test, then discard.

```sh
git restore -- sync-standards.lock <files-the-sync-touched>   # discard the local-sourced state
# then publish for real: push the change upstream, and in the consumer run
bun standards sync                                            # real sync from main → commit files + lock
```
