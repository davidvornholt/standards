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

- **`sync-standards.local.json`** (optional for existing consumers) — checked-in repository policy with required `ref` and `scheduledSync` fields. Missing files default to `{"ref":"refs/heads/main","scheduledSync":true}`. `ref` accepts only a qualified branch, qualified tag, or full commit SHA. Setting `scheduledSync` to `false` skips scheduled GitHub Actions syncs but not manual or local runs; the weekly workflow cadence remains canonical. Non-default policy requires `@davidvornholt/standards` >=0.5.0. Existing consumers must upgrade that bucket-2 dependency before using the policy—for 0.5.0, run `bun add --dev --exact @davidvornholt/standards@0.5.0`; sync cannot update the consumer-owned `package.json`.
- **`GH_TOKEN` / `GITHUB_TOKEN`** (optional) — GitHub API token for the `github` command and the GitHub portion of `check`. When neither is set, the token from the local `gh` CLI is used; with no token at all, reads still work on public repositories. `--apply` and private-repo reads need an authenticated token, and repo merge settings are only visible (and thus verifiable) to admin tokens — non-admin runs report them as unverifiable.

See the standards repository README for the ownership model and adoption workflow.
