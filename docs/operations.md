# Operations

## Recover an incompatible sync workflow

A canonical sync workflow can require a newer CLI than the repository has installed. When it reports that the installed CLI is too old, first upgrade the exact `@davidvornholt/standards` dependency and `bun.lock` with Bun.

- A consumer tracking `main` can then run `bun standards sync`.
- A pinned consumer first updates `ref` in `sync-standards.local.json` to a release or commit that contains the repair. A plain sync without that policy change follows the old pin and cannot fetch it.
- A consumer with `autoSync: false` does not need to expand or approve its broker App permissions until scheduled sync is re-enabled.

## Test an unpublished canonical change

Sync from a local standards checkout:

```sh
bun standards sync --from ../standards
bun run check
```

The lock then describes content that may not exist upstream, so discard the result with `git restore -- sync-standards.lock <paths-touched-by-sync>`. After the canonical change is published, run a normal sync and commit that lock.

## AWS CodeBuild runners

Setting the Actions variable `CI_CODEBUILD_PROJECT` routes the compatible canonical jobs to that CodeBuild project; the variables are described in `.github/workflows/standards.yml`. Pull-request code runs on these runners, so use CodeBuild only in a repository whose sole maintainer and agents are trusted to edit workflows before merge. The project must:

- use an Ubuntu-based image such as `aws/codebuild/standard:8.0`;
- create a fresh build for each job and support Docker service containers;
- have no useful service-role permissions, project secrets, persistent local cache, or trusted network route;
- have concurrency and budget limits configured in AWS.

## Local PostgreSQL credentials

The PostgreSQL image applies the user, password, and database name only when it initializes the data volume. After changing them in `DATABASE_URL`, confirm that the local data can be discarded, then remove the container `<repo>-dev-postgres` and the volume `<repo>-dev-postgres-data` with Podman and run `just dev-db-start`.

## Nix package

Each release tag's flake exposes `packages.<system>.standards-cli`, which is also `packages.<system>.default`, for `x86_64-linux` and `aarch64-linux`. It bundles `standards`, `bun`, and `bunx`. Install that package directly instead of building another Bun or CLI derivation.
