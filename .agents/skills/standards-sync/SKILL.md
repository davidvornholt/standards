---
name: standards-sync
description: Use when editing a file listed in `sync-standards.json`, changing standards sync behavior, propagating standards, or running `bun standards`. Preserves canonical ownership across consumer repositories.
---

# Standards sync

Before editing, classify the path from `sync-standards.json`.

## Ownership

| Class | Contract |
| --- | --- |
| Synced | Listed in `sync-standards.json`, owned upstream, mirrored exactly, read-only in consumers. |
| Project-owned | Seeded once or created at an extension point, then free to diverge. |
| Generated | Rebuilt by the CLI from canonical input and project-owned configuration. |

Make shared changes upstream, consumer-specific changes at an extension point, and generated changes in their inputs. Never patch a canonical file in a consumer or copy its logic into another owner.

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

Extensions are additive. GitHub settings may only add stricter settings, rulesets, and labels.

Use `bun standards help` for commands and options.

Before changing declared repository settings or the automatic sync workflow, read [GitHub settings and automatic sync](references/github.md).
