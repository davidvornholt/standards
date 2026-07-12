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

`github --check` compares the live GitHub repository (merge settings and rulesets) against the merged declaration in `github-settings.json` + `github-settings.local.json`; `github --apply` converges the live repository to exactly the declared state. `check` runs the same comparison whenever `github-settings.json` is present.

## Configuration

- **`GH_TOKEN` / `GITHUB_TOKEN`** (optional) — GitHub API token for the `github` command and the GitHub portion of `check`. When neither is set, the token from the local `gh` CLI is used; with no token at all, reads still work on public repositories. `--apply` and private-repo reads need an authenticated token, and repo merge settings are only visible (and thus verifiable) to admin tokens — non-admin runs report them as unverifiable.

See the standards repository README for the ownership model and adoption workflow.
