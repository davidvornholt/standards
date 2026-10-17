# Operations

This guide covers repository-wide features that do not belong in first-run adoption.

## AWS CodeBuild runners

Canonical workflows use GitHub-hosted runners by default. A sole-maintainer repository may route compatible jobs through an ephemeral CodeBuild project:

```text
CI_CODEBUILD_PROJECT=<project name>
```

The quality gate requests a `medium` instance. Smaller canonical jobs request `small`. Set `CI_CODEBUILD_QUALITY_SIZE` only when measured failures show that the complete gate needs a larger instance.

CodeBuild is supported only when the maintainer and their agents are trusted to edit workflows before merge. The project must be ephemeral, support Docker service containers, hold no useful service-role permissions or project secrets, use no persistent local cache or trusted network route, and have external concurrency and budget limits.

Use an Ubuntu-based image such as `aws/codebuild/standard:8.0`. CodeBuild's standard images lack `zstd`, so on CodeBuild the quality gate extracts a pinned Ubuntu `zstd` package before its first cache step; without it, `actions/cache` falls back to gzip, which is much slower to save and restore.

Quality jobs require an ephemeral runner: leave `CI_CODEBUILD_PROJECT` unset for GitHub-hosted Ubuntu, or configure a fresh CodeBuild runner for each run. Arbitrary `CI_RUNNER` labels are unsupported because persistent Bun and browser stores let one pull-request revision alter executable inputs for a later one. Remove an old `CI_RUNNER` variable before adopting this workflow; configure CodeBuild if GitHub-hosted resources are insufficient.

## Quality gate runs

Draft pull requests skip the `Standards` gates; marking a pull request ready for review runs them on its current head. A draft run skips its aggregator under a name other than `check`, so a required `check` stays missing, and merge stays blocked, until the ready run finishes.

A push to `main` reuses the pull request's result instead of repeating the gate when a successful same-repository pull-request run recorded the pushed tree, which is the usual outcome of squash-merging an up-to-date branch. Cache freshness does not affect reuse. When a reused push finds no trusted Bun or Playwright snapshot for the current lock, or no Turbo snapshot younger than a day, it dispatches a full `Standards` run on `main` that publishes them. Nothing waits for that run, and release pollers select only `push` runs. One dispatched run executes at a time; the newest request waits behind it. Maintainers can also dispatch the workflow on `main` manually to refresh the caches.

## Local PostgreSQL

Repositories with a local PostgreSQL database get:

```sh
just dev-db-start
just dev-db-stop
just dev-db-status
```

Run `just dev-env-generate` first. The recipes read `<devDatabase.workspace>/.env.local` (default: `packages/db/.env.local`), accept only a local `postgres:` or `postgresql:` URL without query parameters or fragments, and ignore a conflicting shell `DATABASE_URL`.

The container is named `<repo>-dev-postgres`, publishes only to IPv4 loopback, and stores data in `<repo>-dev-postgres-data`. Before acting, every recipe verifies the canonical ownership label, image, port binding, and volume mount.

Declare the PostgreSQL major version in the root manifest. For an app-private database or another database package, also set `workspace` to its `apps/<name>` or `packages/<name>` path:

```json
{
  "devDatabase": {
    "postgresVersion": "18",
    "workspace": "apps/web"
  }
}
```

PostgreSQL fixes credentials and its data format when the volume is initialized. Changing the password or major version requires intentionally removing the managed container and volume after confirming the data may be discarded.

Project-specific database lifecycles use distinct names in `local.just`.

## Screenshot publishing

A repository can publish stable review screenshots through its configured public object-storage bucket:

```sh
bun standards screenshots publish docs/pr/settings-page.png
```

Enable the command with `config/screenshots.yaml` and keep the S3 credential pair in its SOPS target. Published URLs are public and permanent, so use demo data and exclude secrets and personal data. The [`screenshots-in-prs` skill](../.agents/skills/screenshots-in-prs/SKILL.md) defines capture and pull-request conventions.

## Nix package

Each release exposes:

```text
packages.x86_64-linux.standards-cli
packages.aarch64-linux.standards-cli
packages.<system>.default
```

The package includes `standards`, `bun`, and `bunx`, with the CLI wrapper placing the packaged Bun first on `PATH` for subprocesses.

```nix
inputs.standards = {
  url = "github:davidvornholt/standards/v0.26.2";
  inputs.nixpkgs.follows = "nixpkgs";
};
```

Install the package directly in the host configuration:

```nix
let
  standardsCli = inputs.standards.packages.${pkgs.system}.standards-cli;
in {
  environment.systemPackages = [ standardsCli ];
}
```

Do not assemble a second Bun or CLI derivation in the consumer.

## Release the CLI

The version in `packages/standards-cli/package.json` is the release declaration. Update `template/package.json` in the same pull request.

After the exact declaring commit passes the `Standards` workflow on `main`, the release workflow publishes through npm trusted publishing, verifies provenance, and creates the matching tag and GitHub Release at that commit.

Publication starts from the declaring push, preserving its exact provenance commit while a read-only gate waits for that commit’s successful `Standards` push run. Later merges do not change the checked-out or attested commit. Pending publication runs queue, and each pushed commit has its own quality-gate concurrency group. Rerun the original failed publication to recover its release; an already published npm version is verified before its tag and GitHub Release are reconciled. Inherited and withdrawn versions must have both a tag and a published GitHub Release; those completeness checks query GitHub without looking up npm.

## Infrastructure

NixOS hosts, OpenTofu stacks, host secrets, pull request previews, and first-party app releases follow the [declarative infrastructure skill](../.agents/skills/declarative-infra/SKILL.md). Make host and stack changes in the infrastructure home repository; an app's release workflow lives in the app's own repository.
