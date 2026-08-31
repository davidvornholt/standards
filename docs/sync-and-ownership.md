# Sync and ownership

The sync engine keeps shared standards identical without taking ownership of project-specific configuration. Every path has one owner.

## Path classes

### Synced

Paths listed in `sync-standards.json` are owned by this repository. `sync` mirrors their content and path type, including deletions, and records the result in `sync-standards.lock`.

A consumer edit is drift. Change the canonical source or use a project-owned extension point.

Examples include `AGENTS.md`, `CLAUDE.md`, `biome.base.jsonc`, canonical workflows and skills, `justfile`, and `secrets.just`.

### Project-owned

Project-owned files are seeded once or created by the consumer. Later syncs leave them alone.

Examples include `README.md`, `AGENTS.local.md`, `biome.jsonc`, `local.just`, `.sops.yaml`, `.github/settings.local.json`, `.github/dependabot.local.yml`, `sync-standards.local.json`, and secret examples.

### Generated

Generated files are engine output. Change their inputs, then regenerate them.

`.github/dependabot.yml` is composed from the synced `.github/dependabot.base.yml` and project-owned `.github/dependabot.local.yml`. Hand edits are overwritten and reported as drift.

## Decide where a change belongs

1. If every consumer should receive it, change the canonical source here.
2. If it belongs to one repository, use a project-owned extension point.
3. If the path is generated, change a declared input.
4. If no extension point fits, surface the ownership problem instead of copying canonical logic locally.

## Extension points

| Canonical owner | Project-owned extension |
| --- | --- |
| `biome.base.jsonc` | `biome.jsonc` |
| `AGENTS.md` | `AGENTS.local.md` |
| `justfile` and `secrets.just` | `local.just` |
| `.github/settings.json` | `.github/settings.local.json` |
| `.github/dependabot.base.yml` | `.github/dependabot.local.yml` |
| `.agents/skills/*` | Unmanaged sibling skill directories |
| `.github/workflows/standards-sync.yml` | `sync-standards.local.json` |

Extensions are additive unless their contract says otherwise. Do not restate a canonical file merely to change one value.

## Initialize and sync

`init` performs the one-time ownership cutover and refuses after a lock exists:

```sh
bun standards init
```

Prepare an existing repository with the [adoption guide](adoption.md) first.

For later updates:

```sh
bun standards sync --dry-run
bun standards sync
```

The dry run reports creates, updates, deletions, generated-file changes, and lock changes without writing.

## Deletions and collision guards

When upstream removes a managed path, sync removes it locally. It does not keep stale canonical copies.

Sync refuses before writing when a managed destination is a directory containing unowned work. During removal, it also leaves such a directory intact and never deletes through a symlink. These guards protect consumer files, not conflicting ordinary files.

## Symlinks

Canonical symlinks are mirrored as links and never followed. Their lock digest covers the target, so retargeting a link or replacing it with a directory is drift.

`.claude/skills -> ../.agents/skills` exposes the same skill directories to Claude Code and Codex. Project skills live at `.agents/skills/<name>` beside the canonical ones and remain outside the lock.

On Windows, clone with `core.symlinks=true` under Developer Mode or elevation, or use WSL.

## Lock and drift

`sync-standards.lock` records the exact upstream commit and each managed digest. Commit it.

`bun standards check` compares the checkout with that lock, validates extension points and repository structure, verifies generated output, and checks declared GitHub state. It fails when the lock is missing.

The check is local to the selected revision. It does not ask whether upstream has advanced. The weekly sync workflow opens a normal pull request when a repository tracking `main` needs an update.

## Select a source

The default is upstream `main`. Pin a tag, branch, or full commit SHA with either command-line policy:

```sh
bun standards sync --ref v0.25.0
```

or repository policy:

```json
{
  "ref": "v0.25.0"
}
```

An explicit `--ref` wins. To disable only the weekly schedule, set `"autoSync": false`.

## Recover an incompatible sync workflow

A canonical workflow can arrive before the repository-owned CLI dependency. When it reports that the installed CLI is too old, first upgrade the exact `@davidvornholt/standards` dependency and `bun.lock` with Bun.

- A consumer tracking `main` can then run `bun standards sync`.
- A pinned consumer first updates `sync-standards.local.json.ref` to a release or commit containing the repair. A plain sync without that policy change follows the old pin and cannot fetch it.
- A consumer with `autoSync: false` does not need to expand or approve its broker App permissions until scheduled sync is re-enabled.

## Test an unpublished canonical change

Use a local standards checkout because an unpushed ref does not exist remotely:

```sh
bun standards sync --from ../standards --dry-run
bun standards sync --from ../standards
bun run check
```

Discard the result afterward. The lock now describes local content that may not exist upstream:

```sh
git restore -- sync-standards.lock <paths-touched-by-sync>
```

After publishing the canonical change, run a normal sync and commit the real upstream lock.

## Dependabot composition

The local overlay may add update blocks, top-level registries, and `ignore` or `registries` entries on matching canonical targets. It cannot replace canonical policy.

```sh
bun standards dependabot --write
bun standards dependabot --check
```

## Source repository

This repository is the source, not a recursive consumer. Its root scripts run the local CLI with `structure --profile source`, verify generated Dependabot output and live GitHub settings, then run the workspace gate.
