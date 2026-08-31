---
name: standards-sync
description: Understand and operate the standards sync system. Use this skill before editing any file that might be canonical (synced from davidvornholt/standards), when a change needs to reach every consumer repo, when running or reasoning about `bun standards`, or when testing a canonical change before publishing it upstream.
---

# Standards sync

Before editing, classify the path from `sync-standards.json` and the rules below.

## Ownership

| Class | Contract |
| --- | --- |
| Synced | Listed in `sync-standards.json`, owned upstream, mirrored exactly, read-only in consumers. |
| Project-owned | Seeded once or created at an extension point, then free to diverge. |
| Generated | Rebuilt by the CLI from canonical input and project-owned configuration. |

If a change should reach every consumer, make it upstream. If it belongs to one consumer, use its extension point. For generated output, edit its inputs. Never patch a canonical file locally or copy its logic into a second owner.

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

Extensions are additive. GitHub settings may add stricter settings, rulesets, and labels, but cannot override canonical values. `{"rulesetEnforcement":"unavailable-on-plan"}` is allowed only when the repository plan cannot enforce rulesets.

The Dependabot overlay may add repository-specific update blocks, registries, and `ignore` or `registries` entries for canonical targets; it cannot replace canonical policy. `.github/dependabot.yml` is generated:

```sh
bun standards dependabot --write
```

## Symlinks

Canonical symlinks are managed paths. The CLI mirrors the link itself and hashes its target without following it.

`.claude/skills -> ../.agents/skills` exposes one skill tree to Claude Code and Codex. Consumer skills belong at `.agents/skills/<name>`, never below `.claude/skills`. A directory of consumer work at a managed destination blocks `init` and `sync` before their first write.

Windows checkouts need `core.symlinks=true` with Developer Mode or elevation, or WSL.

## Commands

Use `bun standards help` as the authoritative reference for commands and options. Read it before using an unfamiliar command instead of relying on a list embedded in this skill.

`init` performs the one-time ownership cutover and refuses once a lock exists. Move project-owned work to extension points first.

`sync` mirrors the selected source, including deletions, regenerates owned output, and rewrites `sync-standards.lock`. Preview risky changes with `--dry-run` and commit the lock.

`check` verifies lock-backed paths, extension points, generated output, structure, CI secret shape, and declared GitHub settings. It proves consistency with the selected revision, not whether upstream has advanced.

## Source and recovery

The default remote source is upstream `main`. `--ref` overrides `sync-standards.local.json.ref`; a remote ref must already exist. `{"autoSync":false}` disables only the weekly run.

If the canonical workflow reports an incompatible CLI, first upgrade the exact `@davidvornholt/standards` dependency and `bun.lock` with Bun. A consumer tracking `main` can then sync; a pinned consumer must first move its `ref` to a revision containing the repair. Do not add compatibility shims.

Test an unpublished canonical change through a local checkout:

```sh
bun standards sync --from ../standards --dry-run
bun standards sync --from ../standards
bun run check
git restore -- sync-standards.lock <paths-touched-by-sync>
```

Discard the local-sourced result. After publishing, run a normal sync and commit the real upstream state.

## GitHub settings

Change the declarations, never the GitHub UI:

```sh
bun standards github --apply
bun standards github --check
```

`--apply` needs admin authentication. Run it from a declaration-changing branch before merge. CI uses a restricted workflow token and fails when declared state cannot be verified; a declared non-empty ruleset bypass list therefore requires a local admin-authenticated check.

## Automatic sync

Repositories tracking `main` receive weekly pull requests when canonical content changes. The workflow reads `ci.broker_app` from SOPS. Provision it after installing the repository owner's private broker App only on the selected repository:

```sh
bun standards creds add github --dest ci:ci.broker_app
```

The workflow mints two short-lived current-repository tokens: one branch writer for contents and workflows, and one pull-request opener. Neither token enters the sync process, and there is no credential fallback. A repository with `autoSync: false` does not need these permissions until automatic sync is re-enabled.
