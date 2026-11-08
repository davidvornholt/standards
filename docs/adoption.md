# Adopt the standards

Run `init` once per repository. Later updates use `bun standards sync` or the weekly sync pull request.

## New repository

```sh
bunx @davidvornholt/standards init
bun install
```

Then [connect CI and GitHub](#connect-ci-and-github).

## Repository outside Bun

A repository that isn't a Bun workspace, such as a Rust, Nix, or Python project, takes the core payload: `AGENTS.md`, the language-neutral skills, and the weekly sync. First move the project-specific content of `AGENTS.md` and `CLAUDE.md` below a `## Project-specific rules` heading at the end of `AGENTS.md`, and delete `CLAUDE.md`. Then run the CLI through Nix:

```sh
echo '{ "payload": "core" }' > sync-standards.local.json
nix run github:davidvornholt/standards -- init
```

Commit `sync-standards.lock` and `sync-standards.local.json`, and check for drift with `nix run github:davidvornholt/standards -- check`. For the weekly sync pull request, do steps 1 and 2 of [Connect CI and GitHub](#connect-ci-and-github), running `nix run github:davidvornholt/standards --` in place of `bun standards`.

## Existing repository

`init` keeps project-owned files, but it replaces synced files and regenerates generated files without asking. Move project-specific content out of synced paths first:

| Existing path | Move its project-specific content to |
| --- | --- |
| `AGENTS.md`, `CLAUDE.md` | Below a `## Project-specific rules` heading at the end of `AGENTS.md`, then delete `CLAUDE.md` |
| `justfile`, `secrets.just` | `local.just` |
| `.github/dependabot.yml` | Below a `# Project-specific updates` line, indented two spaces, at the end of `.github/dependabot.yml`, without the root `bun` and `github-actions` blocks |
| `.claude/skills/<name>` | `.agents/skills/<name>` |

```sh
bun add --dev --exact @davidvornholt/standards
bun standards init
```

Commit `sync-standards.lock`; it is the drift baseline. Then run `bun standards check` and fix what it reports. The files in [`template/`](../template) show the expected project-owned wiring, such as the root scripts and the `turbo.json` lint tasks.

Biome's `noUndeclaredEnvVars` rule requires every environment variable that code reads to be declared in `turbo.json`. Declare it in the `env` of each task whose output depends on it, so Turbo does not reuse a result cached with a different value. Declare the rest, such as settings that only a running server reads, in `passThroughEnv` on `//#lint`, which adds them to no cache key.

## Connect CI and GitHub

1. Create the repository's CI age key and its `SOPS_AGE_KEY` Actions secret as described in [Secrets bootstrap](../.agents/skills/declarative-infra/references/secrets.md).
2. Install the repository owner's broker GitHub App on the repository, then provision it with `bun standards creds add github --dest ci:ci.broker_app`. Automatic sync and Standards auto-merge need it; see [GitHub settings, automatic sync, and auto-merge](../.agents/skills/standards-sync/references/github.md). In a public repository, also allow `pull_request_target` for `.github/workflows/standards-auto-merge.yml` in an Actions event policy, as that page describes.
3. With admin-authenticated `gh`, run `bun standards github --apply`, then `bun standards github --check`.
4. To pin the source or turn off the weekly sync, create `sync-standards.local.json` with `"ref": "<tag, branch, or commit>"` or `"autoSync": false`.
5. Run `bun run check`.

## Windows

`.claude/skills` is a symlink to `../.agents/skills`. Set `core.symlinks=true` before cloning and enable Developer Mode or use an elevated shell, or work in WSL. A checkout that turns the link into a text file fails the drift check.
