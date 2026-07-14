# Project

> Built on [davidvornholt/standards](https://github.com/davidvornholt/standards).

Replace this with your project's README.

## Standards sync policy

`sync-standards.local.json` is checked-in, repository-owned configuration for standards updates. Its `ref` accepts `refs/heads/<branch>`, `refs/tags/<tag>`, or a full commit SHA; `scheduledSync: false` skips scheduled GitHub Actions syncs while default-branch `standards-sync` repository dispatches and local syncs still run. The weekly cadence remains canonical. Existing repositories without the file default to `refs/heads/main` and scheduled sync enabled.

The installed preflight requires `@davidvornholt/standards` >=0.5.0 declared as an exact direct development dependency for every policy, including the default. The checked-in explicit-ESM preflight bundle validates that declaration before dependency setup. Fetched sources must declare `"syncPolicyContractVersion": 1` in `sync-standards.json`; pre-contract refs are rejected before mirroring so they cannot remove the controller. Contract-v1 sources must not manage the repository-owned control seams `sync-standards.local.json`, `AGENTS.local.md`, `biome.jsonc`, or `.github/settings.local.json`.

The privileged workflow accepts manual requests only through a `standards-sync` repository dispatch, which GitHub binds to the default-branch workflow: `gh api --method POST repos/OWNER/REPO/dispatches -f event_type=standards-sync`. Environment declarations support protected-branch mode only; custom branch or tag policy declarations are rejected, and a live custom mode is replaced with one environment update without branch-policy requests. The protected `standards-sync` environment admits branches covered by classic branch protection; ruleset-only enforcement does not qualify. The schedule and repository dispatch bind the workflow to the repository's default branch, canonical classic protection follows that branch when it is renamed, and required-check producers use the live default-branch identity. Custom GitHub App deployment protection gates are intentionally unsupported declaration state: check reports every enabled gate as undeclared drift and apply disables it only after the environment protection update succeeds. Secret values are separate and are never listed, read, or written by `github --check` or `github --apply`. Store the fine-grained PAT as the environment secret `STANDARDS_SYNC_ENVIRONMENT_TOKEN`.
