---
name: standards-sync
description: Use when changing a file the standards sync manages (listed in `sync-standards.json`, such as `AGENTS.md`, `biome.base.jsonc`, `justfile`, canonical skills, or the standards workflows), changing sync behavior, propagating standards, or running `bun standards`. Routes each change to the owner that keeps it.
---

# Standards sync

The canonical files live in davidvornholt/standards and are mirrored into every consumer repository. A consumer's copy of a synced file is read-only: the next sync overwrites any local edit, and `bun standards check` reports it as drift against `sync-standards.lock`. So before editing, find which class the path belongs to.

| Class | How to recognize it | Where a change goes |
| --- | --- | --- |
| Synced | Listed in `sync-standards.json`, or inside a listed directory | The standards repository, which edits canonical files directly |
| Project-owned | Seeded once by `init` from `template/`, or an extension point below | The consumer, freely |
| Generated | Rebuilt by the CLI, such as `.github/dependabot.yml` and `sync-standards.lock` | Its inputs, then regenerate |

A change every consumer should get belongs upstream. A change for one consumer belongs in that consumer's extension point. Don't copy canonical logic into a project-owned file to change it locally.

## Extension points

| Canonical path | Consumer extension |
| --- | --- |
| `biome.base.jsonc` | `biome.jsonc` |
| `AGENTS.md` | `AGENTS.local.md` |
| `justfile` and `secrets.just` | `local.just` |
| `.github/settings.json` | `.github/settings.local.json` |
| `.github/dependabot.base.yml` | `.github/dependabot.local.yml` |
| `.agents/skills/*` | Unmanaged sibling skill directories |
| `.github/workflows/standards-sync.yml` | `sync-standards.local.json` |
| `.mise/config.toml` | `mise.toml` |
| `nix/standards-bun.nix` | `flake.nix` and `dev-shell.local.nix` |

An extension adds to its canonical file and doesn't replace it. GitHub settings can only add stricter settings, rulesets, and labels.

`bun standards help` lists the commands and options.

Before changing declared repository settings or the automatic sync workflow, read [GitHub settings and automatic sync](references/github.md).
