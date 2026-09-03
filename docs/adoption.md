# Adopt the standards

Use `init` once. After `sync-standards.lock` exists, use `sync` for every update.

> [!WARNING]
> `init` keeps existing project-owned files, but it replaces synced files and regenerates engine-owned files. Prepare an existing repository before running it.

## New repository

```sh
bunx @davidvornholt/standards init
bun install
bun run check
```

Then configure CI secrets and apply the declared GitHub settings.

## Existing repository

### 1. Install the CLI

```sh
bun add --dev --exact @davidvornholt/standards
```

### 2. Move project-specific content

| Managed path | Project-owned destination |
| --- | --- |
| `AGENTS.md` | `AGENTS.local.md` |
| `CLAUDE.md` | No local content. The canonical file contains only `@AGENTS.md`. |
| `justfile` and `secrets.just` | `local.just` |
| `.github/dependabot.yml` | `.github/dependabot.local.yml` for supported additions |
| `.claude/skills/<name>` | `.agents/skills/<name>` |

Keep `.sops.yaml`, root project configuration, secret examples, and the project README in place. They are project-owned.

`init` refuses before writing when a managed destination is a directory containing unowned files. This protects local work such as an existing `.claude/skills` directory. Ordinary file conflicts are intentionally replaced, so finish the moves above first.

### 3. Initialize

```sh
bun standards init
```

The command seeds missing project-owned files, mirrors every canonical path, regenerates composed files, and writes `sync-standards.lock`. Commit the lock so CI has a drift baseline.

## Connect the extension points

| Canonical owner | Project-owned extension |
| --- | --- |
| `biome.base.jsonc` | `biome.jsonc` extends it. |
| `AGENTS.md` | `AGENTS.local.md` adds project rules. |
| `justfile` and `secrets.just` | `local.just` adds project recipes and modules. |
| `.github/settings.json` | `.github/settings.local.json` adds settings, rulesets, and labels. |
| `.github/dependabot.base.yml` | `.github/dependabot.local.yml` adds ecosystems, registries, and repository-specific holds. |
| `.agents/skills` | Unmanaged sibling directories contain project skills. |
| `.github/workflows/standards-sync.yml` | `sync-standards.local.json` selects the source and automatic-sync policy. |
| `.mise/config.toml` | `mise.toml` adds project tools. |
| `nix/standards-bun.nix` | `flake.nix` and `dev-shell.local.nix` define the project shell. |

A minimal Biome wrapper is:

```jsonc
{
  "extends": ["./biome.base.jsonc"]
}
```

The root package must declare the CLI directly and run `standards check` before the repository gate:

```json
{
  "scripts": {
    "check": "standards check && turbo run lint check-types test build test:a11y --output-logs=errors-only",
    "check:fix": "standards check && turbo run lint:fix check-types test build test:a11y --output-logs=errors-only"
  }
}
```

Use the repository's actual tasks. The invariant is that a failed standards check remains fatal.

The root `packageManager` is the Bun version contract. The synced mise config reads it directly. Add project tools to the project-owned `mise.toml`.

New repositories also receive a project-owned Nix flake and `.envrc`. The flake builds Bun through the synced `nix/standards-bun.nix` helper. Add project packages or shell settings in `dev-shell.local.nix`:

```nix
{ pkgs }:
{
  packages = [ pkgs.postgresql_18 ];
}
```

Nix, direnv, and mise are optional. Repositories may change or remove their project-owned integration files.

## Generate development environments

The effective workspace environment is composed in this order:

1. tracked configuration in `config/dev.yaml`;
2. encrypted shared secrets in `secrets/dev.yaml`;
3. gitignored machine-specific overrides in `config/dev.local.yaml`.

A key cannot appear in both tracked layers. Ensure these paths are ignored before generation:

```gitignore
.env.local
.env.local.standards-*.tmp
.env.local.standards-*.bak
config/dev.local.yaml
```

```sh
just dev-env-generate
```

See [`dev-env`](../packages/standards-cli/README.md#dev-env) for brokered S3 references.

## Configure CI secrets

The workflows use one native Actions secret, `SOPS_AGE_KEY`. Every other CI secret stays in the project-owned `secrets/ci.yaml`.

Create a repository-specific age identity, add its recipient to the applicable `.sops.yaml` rule, and store only the private key in GitHub Actions:

```sh
d=$(mktemp -d)
just secrets age-create "$d/key"
grep AGE-SECRET-KEY "$d/key" | gh secret set SOPS_AGE_KEY
rm -rf "$d"
```

The structure gate requires `secrets/ci.yaml` and `secrets/ci.example.yaml` to have the same business-key shape. It also requires `ci.ntfy_topic_url`, plus `ci.broker_app.app_id` and `ci.broker_app.private_key` while automatic sync is enabled.

After installing the repository owner's private broker App on this repository, provision its SOPS values:

```sh
bun standards creds add github --dest ci:ci.broker_app
```

## Apply GitHub settings

```sh
bun standards github --apply
bun standards github --check
```

Run `--apply` with admin-authenticated `gh`. A pull request that changes the declaration may fail until live state is applied from that branch.

Private repositories on a plan that cannot enforce rulesets may declare:

```json
{
  "repository": {},
  "rulesets": [],
  "rulesetEnforcement": "unavailable-on-plan"
}
```

The checker then skips plan-gated protection, verifies the remaining settings, and prints an explicit warning. Remove the declaration after upgrading the plan.

## Choose the sync policy

The default is weekly synchronization from `main`. To pin a source or disable the schedule, create `sync-standards.local.json`:

```json
{
  "autoSync": false,
  "ref": "v0.26.0"
}
```

Both fields are optional. Local `init` and `sync` honor `ref`; the scheduled workflow honors both.

## Verify the adoption

```sh
bun standards doctor
bun standards github --check
bun run check
```

Fix the reported cause instead of weakening a gate.

## Windows symlinks

`.claude/skills` is a real symlink to `../.agents/skills`. On Windows, set `core.symlinks=true` before cloning and enable Developer Mode, use an elevated shell, or work in WSL. A checkout that materializes the link as plain text cannot pass the drift gate.

After adoption, use `bun standards sync --dry-run` to preview updates and `bun standards sync` to apply them.
