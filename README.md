# standards

Canonical agent instructions, skills, quality configuration, repository policy, and tooling for TypeScript and Bun monorepos. Consumer repositories receive these files through the [`@davidvornholt/standards`](packages/standards-cli) CLI, which also detects drift.

- To adopt the standards in a repository, follow [Adopt the standards](docs/adoption.md).
- For sync recovery, testing unpublished canonical changes, CodeBuild runners, and the Nix package, see [Operations](docs/operations.md).
- To decide where a change belongs, use the [standards-sync skill](.agents/skills/standards-sync/SKILL.md).

## Release the CLI

In one pull request, change the version in `packages/standards-cli/package.json` and the pin in `template/package.json`, then run `bun install` to update `bun.lock`. After the pull request merges and the `Standards` push run for its commit passes, the publish workflow publishes the package to npm through trusted publishing and creates the matching tag and GitHub Release. If publication fails, rerun the failed publish run. It verifies an already published version before it creates the missing tag and Release.
