# Project

> Built on [davidvornholt/standards](https://github.com/davidvornholt/standards).

Replace this with your project's README.

## Standards sync policy

`sync-standards.local.json` is checked-in, repository-owned configuration for standards updates. Its `ref` accepts `refs/heads/<branch>`, `refs/tags/<tag>`, or a full commit SHA; `scheduledSync: false` skips scheduled GitHub Actions syncs while default-branch `standards-sync` repository dispatches and local syncs still run. The weekly cadence remains canonical. Existing repositories without the file default to `refs/heads/main` and scheduled sync enabled.

Non-default policy requires `@davidvornholt/standards` >=0.5.0 declared as an exact stable version. Existing consumers must first upgrade the bucket-2 dependency—for 0.5.0, run `bun add --dev --exact @davidvornholt/standards@0.5.0`; standards sync cannot update the consumer-owned `package.json`. If the shared controller is still missing, leave the policy absent or at its exact default, run a bare `bun standards sync` from main to install the controller, and only then pin a non-default ref. Fetched sources must declare `"syncPolicyContractVersion": 1` in `sync-standards.json`; pre-contract refs are rejected before mirroring so they cannot remove the controller.

The privileged workflow accepts manual requests only through a `standards-sync` repository dispatch, which GitHub binds to the default-branch workflow: `gh api --method POST repos/OWNER/REPO/dispatches -f event_type=standards-sync`. Declarative GitHub settings manage the protected `standards-sync` Actions environment and its exact `main`-only deployment policy; secret values are separate and are never read or written by `github --check` or `github --apply`. Store the fine-grained PAT as the environment secret `STANDARDS_SYNC_ENVIRONMENT_TOKEN`, then delete the legacy repository-level `STANDARDS_SYNC_TOKEN` secret after migration so it cannot be reused outside the protected environment.
