# standards

The rules, agent skills, and quality configuration that David Vornholt uses in his own repositories, published under the MIT license, with a CLI that copies them into a repository and keeps them up to date. They are written for repositories where coding agents such as Claude Code do most of the work.

A repository can take one of two sets of files:

- `core`, for a repository in any language: an `AGENTS.md` with rules for agents, the skills `issues`, `prs`, `review`, `review-fix`, and `standards-sync` in `.agents/skills` (linked from `.claude/skills`), and a weekly GitHub Actions workflow that opens a pull request when the standards change.
- `bun`, the default, for a TypeScript monorepo that uses Bun: everything in `core`, plus more skills, a strict Biome and TypeScript configuration, a CI workflow that runs the quality gate, declared GitHub repository settings, a Dependabot configuration, and a `justfile`.

The CLI, [`@davidvornholt/standards`](packages/standards-cli), records what it copied in `sync-standards.lock`, so `check` reports any synced file that was edited by hand. A repository adds its own agent rules below the `## Project-specific rules` heading at the end of `AGENTS.md`, which sync never changes.

## Try it

Install [Bun](https://bun.sh). Then, in a Git repository, take the core files with the weekly sync turned off, which needs no secrets, GitHub repository, or GitHub App:

```sh
echo '{ "payload": "core", "autoSync": false }' > sync-standards.local.json
bunx @davidvornholt/standards init
bunx @davidvornholt/standards check
```

If the repository already has an `AGENTS.md`, `init` stops and asks you to move its content below a `## Project-specific rules` heading at its end. Move the content of a `CLAUDE.md` there too and delete it, because Claude Code by default loads `AGENTS.md` only in a repository without a `CLAUDE.md`. Later, run `bunx @davidvornholt/standards sync` to take the newest standards. To adopt the Bun payload or the automatic sync, follow [Adopt the standards](docs/adoption.md), which also says which parts need your own GitHub App and secrets.

## Maintain this repository

- For sync recovery, testing unpublished canonical changes, CodeBuild runners, and the Nix package, see [Operations](docs/operations.md).
- To decide where a change belongs, use the [standards-sync skill](.agents/skills/standards-sync/SKILL.md).

## Release the CLI

Any agent may cut a release, without asking, whenever merged changes to the CLI are worth publishing to the repositories that use it, such as a fix to `land`. In one pull request, change the version in `packages/standards-cli/package.json` and the pin in `template/package.json`, then run `bun install` to update `bun.lock`. After the pull request merges and the `Standards` push run for its commit passes, the publish workflow publishes the package to npm through trusted publishing and creates the matching tag and GitHub Release. If publication fails, rerun the failed publish run. It verifies an already published version before it creates the missing tag and Release.
