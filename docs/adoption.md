# Adopt the standards

Run `init` once per repository. Later updates use `bun standards sync` or the weekly sync pull request.

## New repository

```sh
bunx @davidvornholt/standards init
bun install
```

Then [connect CI and GitHub](#connect-ci-and-github).

## Existing repository

`init` keeps project-owned files, but it replaces synced files and regenerates generated files without asking. Move project-specific content out of synced paths first:

| Existing path | Move its project-specific content to |
| --- | --- |
| `AGENTS.md`, `CLAUDE.md` | `AGENTS.local.md`, then delete `CLAUDE.md` |
| `justfile`, `secrets.just` | `local.just` |
| `.github/dependabot.yml` | `.github/dependabot.local.yml` |
| `.claude/skills/<name>` | `.agents/skills/<name>` |

```sh
bun add --dev --exact @davidvornholt/standards
bun standards init
```

Commit `sync-standards.lock`; it is the drift baseline. Then run `bun standards check` and fix what it reports. The files in [`template/`](../template) show the expected project-owned wiring, such as the root scripts and the `turbo.json` lint tasks.

Biome's `noUndeclaredEnvVars` rule requires every environment variable that code reads to be declared in `turbo.json`. Declare it in the `env` of each task whose output depends on it, so Turbo does not reuse a result cached with a different value. Declare the rest, such as settings that only a running server reads, in `passThroughEnv` on `//#lint`, which adds them to no cache key.

## Connect CI and GitHub

1. Create the repository's CI age key and its `SOPS_AGE_KEY` Actions secret as described in [Secrets bootstrap](../.agents/skills/declarative-infra/references/secrets.md).
2. Install the repository owner's broker GitHub App on the repository, then provision it with `bun standards creds add github --dest ci:ci.broker_app`. Automatic sync needs it; see [GitHub settings and automatic sync](../.agents/skills/standards-sync/references/github.md).
3. With admin-authenticated `gh`, run `bun standards github --apply`, then `bun standards github --check`.
4. To pin the source or turn off the weekly sync, create `sync-standards.local.json` with `"ref": "<tag, branch, or commit>"` or `"autoSync": false`.
5. Run `bun run check`.

## Windows

`.claude/skills` is a symlink to `../.agents/skills`. Set `core.symlinks=true` before cloning and enable Developer Mode or use an elevated shell, or work in WSL. A checkout that turns the link into a text file fails the drift check.
