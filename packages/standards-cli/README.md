# @davidvornholt/standards

CLI for bootstrapping, synchronizing, and validating repositories that consume [davidvornholt/standards](https://github.com/davidvornholt/standards).

```sh
bunx @davidvornholt/standards init
standards sync
standards check
standards doctor
standards github --check
standards github --apply
```

`github --check` compares the live GitHub repository (merge settings, rulesets, and environments) against the merged declaration in `.github/settings.json` + `.github/settings.local.json`; `github --apply` converges the live repository to exactly the declared state. The canonical declaration manages the protected `standards-sync` environment with an exact `main`-only deployment policy. Secret values remain separate and are never read or written by either command. `check` runs the same comparison whenever `.github/settings.json` is present.

## Configuration

- **`sync-standards.local.json`** (optional for existing consumers) — checked-in repository policy with required `ref` and `scheduledSync` fields. Missing files default to `{"ref":"refs/heads/main","scheduledSync":true}`. `ref` accepts only a qualified branch, qualified tag, or full commit SHA. Setting `scheduledSync` to `false` skips scheduled GitHub Actions syncs but not default-branch `standards-sync` repository dispatches or local runs; the weekly workflow cadence remains canonical. Non-default policy requires `@davidvornholt/standards` >=0.5.0 declared as an exact stable version. Existing consumers must upgrade that bucket-2 dependency before using the policy—for 0.5.0, run `bun add --dev --exact @davidvornholt/standards@0.5.0`; sync cannot update the consumer-owned `package.json`. If the shared controller is still missing, leave the policy absent or at its exact default, run a bare `bun standards sync` from main to install the controller, and only then pin a non-default ref. Fetched sources must declare `"syncPolicyContractVersion": 1` in `sync-standards.json`; pre-contract refs are rejected before mirroring.
- **`GH_TOKEN` / `GITHUB_TOKEN`** (optional for CLI commands) — GitHub API token for the `github` command and the GitHub portion of `check`. When neither is set, those CLI paths try the token from the local `gh` CLI; with no token at all, reads still work on public repositories. `--apply` and private-repo reads need an authenticated token, and repo merge settings are only visible (and thus verifiable) to admin tokens — non-admin runs report them as unverifiable.
- **`STANDARDS_SYNC_ENVIRONMENT_TOKEN`** (optional for the canonical workflow) — fine-grained PAT stored separately as a secret on the protected `standards-sync` environment. After migrating, delete the legacy repository-level `STANDARDS_SYNC_TOKEN` secret so the token cannot be reused outside the environment's `main`-only deployment policy. The workflow falls back to `GITHUB_TOKEN`, but pull requests opened with that token need a manual nudge before their workflows run.

See the standards repository README for the ownership model and adoption workflow.
