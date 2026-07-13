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

`github --check` compares the live GitHub repository (merge settings and rulesets) against the merged declaration in `.github/settings.json` + `.github/settings.local.json`; `github --apply` converges the live repository to exactly the declared state. `check` runs the same comparison whenever `.github/settings.json` is present.

## Configuration

- **`sync-standards.local.json`** (optional for existing consumers) — checked-in repository policy with required `ref` and `scheduledSync` fields. Missing files default to `{"ref":"refs/heads/main","scheduledSync":true}`. `ref` accepts only a qualified branch, qualified tag, or full commit SHA. Setting `scheduledSync` to `false` skips scheduled GitHub Actions syncs but not default-branch `standards-sync` repository dispatches or local runs; the weekly workflow cadence remains canonical. Non-default policy requires `@davidvornholt/standards` >=0.5.0 declared as an exact stable version. Existing consumers must upgrade that bucket-2 dependency before using the policy—for 0.5.0, run `bun add --dev --exact @davidvornholt/standards@0.5.0`; sync cannot update the consumer-owned `package.json`. Fetched sources must declare `"syncPolicyContractVersion": 1` in `sync-standards.json`; pre-contract refs are rejected before mirroring.
- **`GH_TOKEN` / `GITHUB_TOKEN`** (optional for CLI commands) — GitHub API token for the `github` command and the GitHub portion of `check`. When neither is set, those CLI paths try the token from the local `gh` CLI; with no token at all, reads still work on public repositories. `--apply` and private-repo reads need an authenticated token, and repo merge settings are only visible (and thus verifiable) to admin tokens — non-admin runs report them as unverifiable.
- **Release workflow environment** — the repository's private release tooling requires `GITHUB_REPOSITORY` and either `GH_TOKEN` or `GITHUB_TOKEN`. GitHub Actions supplies `GITHUB_REPOSITORY` and exposes its GitHub-provided token as `GH_TOKEN`; the tooling has no `gh` authentication fallback. Published CLI commands do not consume `GITHUB_REPOSITORY`.

See the standards repository README for the ownership model and adoption workflow.
