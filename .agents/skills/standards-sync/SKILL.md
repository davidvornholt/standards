---
name: standards-sync
description: Use when changing a file the standards sync manages (listed in `sync-standards.json`, such as `AGENTS.md`, `biome.base.jsonc`, `justfile`, canonical skills, or the standards workflows), changing sync behavior, propagating standards, or running the standards CLI.
---

# Standards sync

The canonical files live in davidvornholt/standards and are mirrored into every consumer repository. A consumer's copy of a synced file is read-only: the next sync overwrites any local edit, and `standards check` reports it as drift against `sync-standards.lock`. So before editing, find which class the path belongs to.

A consumer receives one of two payloads, chosen by `"payload"` in `sync-standards.local.json`. `core` holds `AGENTS.md`, the language-neutral skills, the weekly sync, the standards CI workflow, and the GitHub settings, for a repository of any language. `bun`, the default, adds the Bun workspace tooling. A Bun consumer runs the CLI as `bun standards <command>`. Any other runs it from the repository root as `bash .agents/skills/standards-sync/scripts/standards.sh <command>`, which needs Bun installed but not a Bun workspace, and runs the CLI from the commit that `sync-standards.lock` records, as the Standards workflow does. `bunx @davidvornholt/standards` runs whatever version Bun resolves, so use it only for `init` in a repository without a lock.

| Class | How to recognize it | Where a change goes |
| --- | --- | --- |
| Synced | `AGENTS.md`, or listed in a payload of `sync-standards.json`, or inside a listed directory | The standards repository, which edits canonical files directly |
| Project-owned | Seeded once by `init` from `template/`, or an extension point below | The consumer, freely |
| Generated | Rebuilt by the CLI, such as `sync-standards.lock` | Its inputs, then regenerate |

A change every consumer should get belongs upstream. A change for one consumer belongs in that consumer's extension point. Don't copy canonical logic into a project-owned file to change it locally.

Sync also raises every Bun pin in a consumer's own files that is below the Bun the standards repository runs: `packageManager`, an exact or `>=` `engines.bun`, `BUN_VERSION` and `bun-version` in YAML and container files, `oven/bun` image tags with their Docker Hub digests, `.bun-version`, and `.tool-versions`. It never lowers a pin, so a consumer can run a newer Bun but not hold an older one.

## Extension points

| Canonical path | Consumer extension |
| --- | --- |
| `biome.base.jsonc` | `biome.jsonc` |
| `AGENTS.md` | Below its `## Project-specific rules` heading |
| `justfile` and `secrets.just` | `local.just` |
| `.github/settings.json` | `.github/settings.local.json` |
| `.github/dependabot.yml` | Below its `# Project-specific updates` line |
| `.agents/skills/*` | Unmanaged sibling skill directories |
| `.github/workflows/standards-sync.yml` | `sync-standards.local.json` |
| `.mise/config.toml` | `mise.toml` |
| `nix/standards-bun.nix` and `nix/bun-archives.json` | `flake.nix` and `dev-shell.local.nix` |
| `nix/package-source.nix`, `nix/package-source-check.nix`, and `nix/bun-lock-deps.nix` | `flake.nix` and `nix/package.nix` |

A core consumer has only the `AGENTS.md`, GitHub settings, skills, and sync workflow rows. An extension adds to its canonical file and doesn't replace it. GitHub settings can only add stricter settings, rulesets, and labels. A repository's own Dependabot blocks can't repeat a shared block's ecosystem, directory, and target branch, so a hold on a shared block goes upstream. Blocks that share an ecosystem and target branch list their directories without globs, because `check` can't tell whether two globs overlap.

`standards help` lists the commands and options.

Before changing declared repository settings, the automatic sync workflow, or Standards auto-merge, read [GitHub settings, automatic sync, and auto-merge](references/github.md).
