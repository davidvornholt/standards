# standards

Opinionated engineering standards for TypeScript and Bun monorepos.

This repository is the source of truth for the agent contract, reusable skills, quality configuration, repository policy, and tooling used across my projects. Consumers receive canonical files through `@davidvornholt/standards` and verify them with one fail-closed gate.

> Agents do not declare work complete. `bun run check` proves it.

## What is included

| Area | Baseline |
| --- | --- |
| Agents | One canonical `AGENTS.md`, project-local extensions, and shared Claude Code and Codex skills. |
| Quality | Strict Biome and TypeScript configuration, tests, and Playwright plus Axe accessibility checks. |
| Repository policy | Squash-only merging, declared GitHub settings, composed Dependabot configuration, and fail-closed CI. |
| Operations | SOPS-backed secrets, generated development environments, local PostgreSQL recipes, and optional CodeBuild runners. |
| Synchronization | A lock-backed CLI that initializes repositories, mirrors canonical files, regenerates owned output, and detects drift. |

## Start

### New repository

```sh
bunx @davidvornholt/standards init
bun install
bun run check
```

### Existing repository

`init` replaces synced files and regenerates engine-owned files. Move project-specific content into the supported extension points first, then follow the [adoption guide](docs/adoption.md).

## Ownership

Every managed path has one owner:

| Class | Owner | Sync behavior |
| --- | --- | --- |
| Synced | This repository | Mirrored exactly, including deletions. Consumer edits are drift. |
| Project-owned | The consumer | Seeded once or created at an extension point, then free to diverge. |
| Generated | The sync engine | Rebuilt from canonical input and project-owned configuration. |

Common examples:

- Add project rules to `AGENTS.local.md`, not the synced `AGENTS.md`.
- Add project recipes to `local.just`, not the synced `justfile`.
- Edit `.github/dependabot.local.yml`, then regenerate `.github/dependabot.yml`.
- Keep project configuration, secret examples, and the project README project-owned.

Read [Sync and ownership](docs/sync-and-ownership.md) before changing a path whose owner is unclear.

## Common commands

| Command | Purpose |
| --- | --- |
| `bun standards sync --dry-run` | Preview canonical creates, updates, and deletions. |
| `bun standards sync` | Apply the selected upstream revision and update the lock. |
| `bun standards check` | Verify drift, extension points, structure, generated files, and GitHub settings. |
| `bun standards doctor` | Validate project-owned integration points without checking drift. |
| `bun standards dev-env` | Generate workspace `.env.local` files. |
| `bun standards github --apply` | Converge live GitHub settings from the declaration. |
| `bun standards creds plan` | Preview brokered Cloudflare credential changes. |
| `bun standards screenshots publish <files...>` | Publish review screenshots through the configured repository bucket. |
| `bun standards help` | List commands and options. |

## Documentation

| Guide | Use it for |
| --- | --- |
| [Adoption](docs/adoption.md) | Installing the standards in a new or existing repository. |
| [Sync and ownership](docs/sync-and-ownership.md) | Deciding where changes belong, pinning a source, and testing canonical edits. |
| [Operations](docs/operations.md) | CodeBuild, local PostgreSQL, the poller, Nix packaging, and releases. |
| [CLI reference](packages/standards-cli/README.md) | Commands, configuration, and focused examples. |
| [Agent contract](AGENTS.md) | Rules enforced in every consumer. |
| [Review decisions](.agents/review/decisions.md) | Durable architecture and trust decisions. |
| [Infrastructure skill](.agents/skills/declarative-infra/SKILL.md) | NixOS hosts, OpenTofu, secrets, previews, and image promotion. |

## Packages

- [`@davidvornholt/standards`](packages/standards-cli/README.md) provides initialization, synchronization, validation, GitHub convergence, credential brokering, screenshot publishing, and poller automation.
- [`@davidvornholt/typescript-config`](packages/typescript-config/README.md) provides the shared TypeScript presets.
- [`@davidvornholt/a11y-testing`](packages/a11y-testing/README.md) provides the shared Playwright and Axe accessibility gate.

## Nix

Each release exposes a self-contained CLI package for `x86_64-linux` and `aarch64-linux`:

```nix
inputs.standards = {
  url = "github:davidvornholt/standards/v0.25.0";
  inputs.nixpkgs.follows = "nixpkgs";
};
```

See [Operations](docs/operations.md#nix-package) for the package outputs and service wiring.

## Develop this repository

```sh
bun install
bun run check
```

This source repository uses the local CLI with the `source` structure profile instead of recursively consuming itself. A CLI release is declared by updating `packages/standards-cli/package.json` and `template/package.json` in the same pull request.

## License

[MIT](LICENSE) © David Vornholt
