---
name: standards-sync
description: Understand and operate the standards sync system. Use this skill before editing any file that might be canonical (synced from davidvornholt/standards), when a change needs to reach every consumer repo, when running or reasoning about `bun standards`, or when testing a canonical change before publishing it upstream.
---

# Standards sync

Before editing a managed path, identify its owner. The complete human guide is [`docs/sync-and-ownership.md`](../../../docs/sync-and-ownership.md); CLI details are in [`packages/standards-cli/README.md`](../../../packages/standards-cli/README.md).

## Ownership

| Class | Contract |
| --- | --- |
| Synced | Listed in `sync-standards.json`, owned upstream, mirrored exactly, read-only in consumers. |
| Project-owned | Seeded once or created at an extension point, then free to diverge. |
| Generated | Rebuilt by the CLI from canonical input and project-owned configuration. |

If a change should reach every consumer, make it in this repository. If it belongs to one consumer, use its project-owned extension point. Never patch a canonical file locally or copy its logic into a second owner.

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

`.github/dependabot.yml` is generated. Edit its two declared inputs and run `bun standards dependabot --write`.

## Symlinks

Canonical symlinks are managed paths. The CLI mirrors the link itself and hashes its target without following it.

`.claude/skills -> ../.agents/skills` exposes one skill tree to Claude Code and Codex. Consumer skills belong at `.agents/skills/<name>`. A directory of consumer work at a managed destination blocks `init` and `sync` before their first write.

Windows checkouts need `core.symlinks=true` with Developer Mode or elevation, or WSL.

## Commands

```sh
bun standards init
bun standards sync --dry-run
bun standards sync
bun standards check
bun standards doctor
bun standards dependabot --check
bun standards github --check
```

`init` is the one-time ownership cutover. `sync` mirrors the selected source, including deletions, regenerates owned output, and rewrites `sync-standards.lock`. Commit the lock.

`check` verifies the lock-backed paths, extension points, generated output, structure, CI secret shape, and declared GitHub settings. It detects local drift from the selected revision, not whether upstream has advanced.

## GitHub settings

Change the declarations, never the GitHub UI:

```sh
bun standards github --apply
bun standards github --check
```

`--apply` needs admin authentication. The CI check uses a restricted workflow token and fails when declared state cannot be verified. A declared non-empty ruleset bypass list therefore requires a local admin-authenticated check.

## Test a canonical change

A remote ref must exist. Test an unpushed source through a local checkout:

```sh
bun standards sync --from ../standards --dry-run
bun standards sync --from ../standards
bun run check
```

Discard the resulting files and lock afterward. They may describe content that does not exist upstream. After publishing, run a normal sync and commit that result.

## Automatic sync

Repositories tracking `main` receive weekly pull requests when canonical content changes. `sync-standards.local.json` may pin `ref` or set `autoSync` to `false`.

The workflow mints short-lived current-repository tokens from `ci.broker_app`: one writer for contents and workflows, and one pull-request opener. Neither token enters the sync process, and there is no credential fallback.
