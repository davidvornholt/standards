# Operations

This guide covers repository-wide features that do not belong in first-run adoption.

## AWS CodeBuild runners

Canonical workflows use GitHub-hosted runners by default. A sole-maintainer repository may route compatible jobs through an ephemeral CodeBuild project:

```text
CI_CODEBUILD_PROJECT=<project name>
```

The quality gate requests a `medium` instance. Smaller canonical jobs request `small`. Set `CI_CODEBUILD_QUALITY_SIZE` only when measured failures show that the complete gate needs a larger instance.

CodeBuild is supported only when the maintainer and their agents are trusted to edit workflows before merge. The project must be ephemeral, support Docker service containers, hold no useful service-role permissions or project secrets, use no persistent local cache or trusted network route, and have external concurrency and budget limits.

Use `CI_RUNNER` instead when only the unprivileged quality job needs another runner. `CI_CODEBUILD_PROJECT` takes precedence.

## Local PostgreSQL

Repositories using the standard `packages/db` shape get:

```sh
just dev-db-start
just dev-db-stop
just dev-db-status
```

Run `just dev-env-generate` first. The recipes read `packages/db/.env.local`, accept only a local `postgres:` or `postgresql:` URL without query parameters or fragments, and ignore a conflicting shell `DATABASE_URL`.

The container is named `<repo>-dev-postgres`, publishes only to IPv4 loopback, and stores data in `<repo>-dev-postgres-data`. Before acting, every recipe verifies the canonical ownership label, image, port binding, and volume mount.

Declare the PostgreSQL major version in the root manifest:

```json
{
  "devDatabase": {
    "postgresVersion": "18"
  }
}
```

PostgreSQL fixes credentials and its data format when the volume is initialized. Changing the password or major version requires intentionally removing the managed container and volume after confirming the data may be discarded.

Project-specific database lifecycles use distinct names in `local.just`.

## Deferred-fix poller

The poller turns maintainer approval into bounded Codex work while GitHub remains the state store.

For an issue, an `admin` or `maintain` user applies `approved-for-fix`. The worker binds approval to the exact issue revision, runs Codex in a disposable worktree, verifies the result, and opens a draft pull request.

For a draft pull request, an `admin` or `maintain` user applies `approved-for-review`. The worker binds approval to the exact head, runs one review-fix cycle, pushes verified commits, posts the report, and marks the pull request ready. Merge remains a human decision.

When a durable decision is required, the worker comments and applies `needs-clarification`. Only an authorized reply resumes the job.

The host infrastructure repository owns the service identity, writable home, authenticated `codex` and `gh`, GitHub token, configuration, and systemd deployment. Render the worker and acknowledgement units with:

```sh
standards poller --print-units --config <path>
```

One poller supports at most 12 repositories. See the [CLI reference](../packages/standards-cli/README.md#poller) for the configuration schema.

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
  url = "github:davidvornholt/standards/v0.26.0";
  inputs.nixpkgs.follows = "nixpkgs";
};
```

Use the package directly in the host service:

```nix
let
  standardsCli = inputs.standards.packages.${pkgs.system}.standards-cli;
in {
  systemd.user.services.standards-poller.serviceConfig.ExecStart =
    "${standardsCli}/bin/standards poller --config ${pollerConfig}";
}
```

Do not assemble a second Bun or CLI derivation in the consumer.

## Release the CLI

The version in `packages/standards-cli/package.json` is the release declaration. Update `template/package.json` in the same pull request.

After the exact declaring commit passes the `Standards` workflow on `main`, the release workflow publishes through npm trusted publishing, verifies provenance, and creates the matching tag and GitHub Release at that commit.

Publishing runs only while the declaring commit is the tip of `main`. If an unpublished release cannot complete before `main` advances, declare a new version in the fix-forward commit. A version already published to npm can still have its missing tag reconciled by rerunning the original workflow after provenance verification.

## Infrastructure

NixOS hosts, OpenTofu stacks, host secrets, pull request previews, and cross-repository image promotion follow the [declarative infrastructure skill](../.agents/skills/declarative-infra/SKILL.md). Make those changes in the infrastructure home repository.
