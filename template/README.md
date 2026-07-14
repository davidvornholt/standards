# Project

> Built on [davidvornholt/standards](https://github.com/davidvornholt/standards).

Replace this with your project's README.

## Standards sync policy

`sync-standards.local.json` is checked-in, repository-owned configuration for standards updates. Its `ref` accepts `refs/heads/<branch>`, `refs/tags/<tag>`, or a full commit SHA; `scheduledSync: false` skips scheduled GitHub Actions syncs while default-branch `standards-sync` repository dispatches and local syncs still run. The weekly cadence remains canonical. Existing repositories without the file default to `refs/heads/main` and scheduled sync enabled.

The installed preflight requires `@davidvornholt/standards` >=0.5.0 declared as an exact stable version for every consumer policy, including the default. The standards source workspace is the sole exception: its private root workspace wiring and CLI workspace package are validated together, and it runs that workspace CLI instead of depending on itself. Existing consumers must first land the bucket-2 CLI upgrade—for 0.5.0, run `bun add --dev --exact @davidvornholt/standards@0.5.0`—before syncing current canonical files; standards sync cannot update the consumer-owned `package.json`, and v0.4 cannot parse the declared Actions environments. Then leave policy absent or at its exact default, run a bare `bun standards sync` from the repository's default branch to install the controller and settings, run `bun standards github --apply` with admin auth to converge the declaration, and only then pin a non-default ref. Fetched sources must declare `"syncPolicyContractVersion": 1` in `sync-standards.json`; pre-contract refs are rejected before mirroring so they cannot remove the controller.

The privileged workflow accepts manual requests only through a `standards-sync` repository dispatch, which GitHub binds to the default-branch workflow: `gh api --method POST repos/OWNER/REPO/dispatches -f event_type=standards-sync`. The protected `standards-sync` environment admits protected branches generally. The schedule and repository dispatch bind the workflow to the repository's default branch, and the canonical default-branch ruleset protects that branch. Secret values are separate and are never read or written by `github --check` or `github --apply`. Store the fine-grained PAT as the environment secret `STANDARDS_SYNC_ENVIRONMENT_TOKEN`, then delete the legacy repository-level `STANDARDS_SYNC_TOKEN` secret after migration so it cannot be reused outside the protected environment.
